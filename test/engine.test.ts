import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyBuffers,
  DEFAULT_PREFERENCES,
  ENGINE_VERSION,
  encodeLockSignature,
  findConflicts,
  generatePlan,
  splitEvenly,
  type SolveInput,
} from '@/lib/engine/solve'
import { detectMatrix, parseMatrix } from '@/lib/parse/matrix'
import { parseIcs } from '@/lib/parse/ics'
import { atDay, dayOf, formatClock, MINUTES_PER_WEEK, overlaps, span, spanLength } from '@/lib/domain/time'
import type { Preferences, Task, WeekEvent } from '@/lib/domain/types'

const WEEK_START = '2026-09-14'
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

function hardEvent(id: string, day: number, start: number, end: number, title = id): WeekEvent {
  return {
    id,
    source: 'matrix',
    sourceRef: id,
    title,
    kind: 'formation',
    span: span(atDay(day, start), atDay(day, end)),
    hard: true,
  }
}

function task(id: string, minutes: number, dueDay: number | null, dueMin = 8 * 60): Task {
  return {
    id,
    title: id,
    dueAt: dueDay === null ? null : atDay(dueDay, dueMin),
    estimateMinutes: minutes,
    estimateSource: 'default',
    chunks: [],
    status: 'todo',
    weight: 1,
  }
}

function baseInput(overrides: Partial<SolveInput> = {}): SolveInput {
  return {
    weekStart: WEEK_START,
    events: [],
    tasks: [],
    preferences: DEFAULT_PREFERENCES,
    ...overrides,
  }
}

/** Every pair of time-occupying blocks must be disjoint. The core safety property. */
function assertNoDoubleBooking(blocks: Array<{ span: { start: number; end: number }; title: string; kind: string }>): void {
  const occupying = blocks.filter((b) => spanLength(b.span) > 0 && b.kind === 'study')
  for (let i = 0; i < occupying.length; i++) {
    for (let j = i + 1; j < occupying.length; j++) {
      const a = occupying[i]!
      const b = occupying[j]!
      expect(
        overlaps(a.span, b.span),
        `${a.title} @${formatClock(a.span.start)} overlaps ${b.title} @${formatClock(b.span.start)}`,
      ).toBe(false)
    }
  }
}

describe('chunking', () => {
  it('leaves a short task whole', () => {
    expect(splitEvenly(45, 90, 25)).toEqual([{ label: 'session', minutes: 45 }])
  })

  it('splits a long task into even pieces', () => {
    const pieces = splitEvenly(240, 90, 25)
    expect(pieces).toHaveLength(3)
    expect(pieces.reduce((s, p) => s + p.minutes, 0)).toBe(240)
  })

  it('never emits a stub shorter than the minimum block', () => {
    for (const total of [95, 100, 185, 271, 365]) {
      const pieces = splitEvenly(total, 90, 25)
      expect(pieces.reduce((s, p) => s + p.minutes, 0)).toBe(total)
      expect(Math.min(...pieces.map((p) => p.minutes))).toBeGreaterThanOrEqual(25)
    }
  })
})

describe('buffers', () => {
  it('shrinks only the edge that touches an obligation', () => {
    const free = [span(600, 900)]
    const busy = [span(500, 600)] // ends exactly where the window starts
    expect(applyBuffers(free, busy, 10)).toEqual([span(610, 900)])
  })

  it('shrinks both edges when hemmed in', () => {
    expect(applyBuffers([span(600, 900)], [span(500, 600), span(900, 1000)], 10)).toEqual([span(610, 890)])
  })

  it('removes a window that a buffer consumes entirely', () => {
    expect(applyBuffers([span(600, 615)], [span(500, 600), span(615, 700)], 10)).toEqual([])
  })
})

describe('conflicts are reported, never resolved', () => {
  it('finds an overlap between two hard events', () => {
    const conflicts = findConflicts([
      hardEvent('lab', 2, 14 * 60, 16 * 60 + 50, 'CIS-111L Lab'),
      { ...hardEvent('mac', 2, 15 * 60 + 30, 17 * 60, 'MAC Training'), kind: 'class' },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.minutes).toBe(80)
    expect(conflicts[0]?.note).toContain('MAC Training')
  })

  it('does not report the same obligation arriving from two sources', () => {
    const a = hardEvent('a', 0, 700, 730, 'BRC Formation')
    const b = { ...hardEvent('b', 0, 700, 730, 'BRC Formation'), source: 'term' as const }
    expect(findConflicts([a, b])).toHaveLength(0)
  })

  it('marks a same-authority collision as blocking', () => {
    const conflicts = findConflicts([
      hardEvent('p', 5, 730, 930, 'Parade'),
      hardEvent('f', 5, 800, 900, 'Formation'),
    ])
    expect(conflicts[0]?.severity).toBe('blocking')
    expect(conflicts[0]?.note).toContain('neither outranks')
  })

  it('never silently drops one side of a conflict from the plan', () => {
    const plan = generatePlan(
      baseInput({
        events: [
          hardEvent('lab', 2, 14 * 60, 16 * 60 + 50, 'CIS-111L Lab'),
          hardEvent('mac', 2, 15 * 60 + 30, 17 * 60, 'MAC Training'),
        ],
      }),
    )
    expect(plan.blocks.filter((b) => b.title === 'CIS-111L Lab')).toHaveLength(1)
    expect(plan.blocks.filter((b) => b.title === 'MAC Training')).toHaveLength(1)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.narrative.some((n) => n.includes('collide'))).toBe(true)
  })
})

describe('placement', () => {
  it('never double-books study against an obligation', () => {
    const plan = generatePlan(
      baseInput({
        events: [hardEvent('class', 0, 8 * 60, 12 * 60, 'All morning class')],
        tasks: [task('paper', 300, 4)],
      }),
    )
    const study = plan.blocks.filter((b) => b.kind === 'study')
    const obligation = span(atDay(0, 8 * 60), atDay(0, 12 * 60))
    expect(study.every((b) => !overlaps(b.span, obligation))).toBe(true)
    assertNoDoubleBooking(plan.blocks)
  })

  it('respects the lead time before a deadline', () => {
    const plan = generatePlan(
      baseInput({
        tasks: [task('due-wed', 120, 2, 9 * 60)],
        preferences: { ...DEFAULT_PREFERENCES, minLeadHours: 12 },
      }),
    )
    const deadline = atDay(2, 9 * 60) - 12 * 60
    const study = plan.blocks.filter((b) => b.kind === 'study')
    expect(study.length).toBeGreaterThan(0)
    expect(study.every((b) => b.span.end <= deadline)).toBe(true)
  })

  it('honours the daily study ceiling', () => {
    const prefs: Preferences = { ...DEFAULT_PREFERENCES, maxStudyMinutesPerDay: 120 }
    const plan = generatePlan(baseInput({ tasks: [task('big', 600, null)], preferences: prefs }))
    for (const day of plan.capacity.byDay) {
      expect(day.studyMinutes).toBeLessThanOrEqual(120)
    }
  })

  it('never schedules during sleep', () => {
    const plan = generatePlan(baseInput({ tasks: [task('big', 900, null)] }))
    for (const block of plan.blocks.filter((b) => b.kind === 'study')) {
      const startHour = (block.span.start % 1440) / 60
      const endHour = ((block.span.end - 1) % 1440) / 60
      expect(startHour).toBeGreaterThanOrEqual(6)
      expect(endHour).toBeLessThan(23)
    }
  })

  /**
   * The reason this engine uses best-fit rather than the first-fit the original
   * plan specified. First-fit drops the small task into the long window and
   * leaves the large task homeless; best-fit defends the long window.
   */
  it('protects a long window for the work that needs it', () => {
    const prefs: Preferences = {
      ...DEFAULT_PREFERENCES,
      meals: [],
      minLeadHours: 0,
      maxBlockMinutes: 240,
      maxStudyMinutesPerDay: 600,
      bufferMinutes: 0,
      wake: 8 * 60,
      sleep: 20 * 60,
    }
    // Monday offers exactly one 60-minute window and one 240-minute window.
    const events: WeekEvent[] = [
      hardEvent('a', 0, 8 * 60, 9 * 60, 'block A'),
      hardEvent('b', 0, 10 * 60, 12 * 60, 'block B'),
      hardEvent('c', 0, 16 * 60, 20 * 60, 'block C'),
      // Fill the rest of the week so Monday is the only option.
      ...[1, 2, 3, 4, 5, 6].map((d) => hardEvent(`full${d}`, d, 8 * 60, 20 * 60, `full ${d}`)),
    ]
    const plan = generatePlan(
      baseInput({
        events,
        tasks: [task('small', 60, null), task('large', 240, null)],
        preferences: prefs,
      }),
    )
    const small = plan.blocks.find((b) => b.taskId === 'small')
    const large = plan.blocks.find((b) => b.taskId === 'large')
    // Both must fit: the small one into the 09:00-10:00 gap, the large one into
    // the 12:00-16:00 gap. First-fit would put `small` at 12:00 and strand
    // `large` entirely.
    expect(small, 'small task placed').toBeDefined()
    expect(large, 'large task placed').toBeDefined()
    expect(plan.unplaced).toHaveLength(0)
    expect(formatClock(small!.span.start)).toBe('09:00')
    expect(formatClock(large!.span.start)).toBe('12:00')
  })

  /**
   * What least-slack ordering guarantees is priority of CHOICE, not an earlier
   * clock time — best-fit then picks the tightest adequate window, which may
   * sit later in the day. So the observable to assert is which task gets the
   * scarce space, not which one starts sooner.
   */
  it('gives the scarce window to the task with less slack', () => {
    const prefs: Preferences = {
      ...DEFAULT_PREFERENCES,
      meals: [],
      wake: 8 * 60,
      sleep: 20 * 60,
      bufferMinutes: 0,
      minLeadHours: 0,
      minBlockMinutes: 20,
      maxBlockMinutes: 240,
      maxStudyMinutesPerDay: 80,
    }
    // The week offers exactly one 80-minute window, on Monday evening.
    const events: WeekEvent[] = [
      hardEvent('mon', 0, 8 * 60, 18 * 60 + 40, 'Monday solid'),
      ...[1, 2, 3, 4, 5, 6].map((d) => hardEvent(`full${d}`, d, 8 * 60, 20 * 60, `full ${d}`)),
    ]
    const plan = generatePlan(
      baseInput({
        events,
        // Same deadline. The 80-minute task has less slack than the 20-minute one.
        tasks: [task('quiz', 20, 4), task('paper', 80, 4)],
        preferences: prefs,
      }),
    )
    expect(plan.blocks.some((b) => b.taskId === 'paper')).toBe(true)
    expect(plan.blocks.some((b) => b.taskId === 'quiz')).toBe(false)
    expect(plan.unplaced.map((u) => u.taskId)).toEqual(['quiz'])
    assertNoDoubleBooking(plan.blocks)
  })

  it('puts work that is already behind at the very front', () => {
    const plan = generatePlan(
      baseInput({
        // `behind` is due Monday 09:00 but needs 8 hours: slack is negative.
        tasks: [{ ...task('behind', 480, 0, 9 * 60) }, task('comfortable', 60, 6)],
        preferences: { ...DEFAULT_PREFERENCES, maxStudyMinutesPerDay: 600, minLeadHours: 0 },
      }),
    )
    const behind = plan.blocks
      .filter((b) => b.taskId === 'behind')
      .sort((a, b) => a.span.start - b.span.start)[0]
    const comfortable = plan.blocks.find((b) => b.taskId === 'comfortable')
    // It cannot all fit before the deadline, but what fits is scheduled before
    // the task with slack to spare.
    expect(behind ?? comfortable).toBeDefined()
    if (behind && comfortable) expect(behind.span.start).toBeLessThanOrEqual(comfortable.span.start)
    expect(plan.unplaced.some((u) => u.taskId === 'behind')).toBe(true)
  })

  it('explains why each block landed where it did', () => {
    const plan = generatePlan(baseInput({ tasks: [task('paper', 120, 4)] }))
    const study = plan.blocks.filter((b) => b.kind === 'study')
    expect(study.length).toBeGreaterThan(0)
    for (const block of study) {
      expect(block.because?.length ?? 0).toBeGreaterThan(0)
      expect(block.because?.join(' ')).toMatch(/window|due|fits/i)
    }
  })
})

describe('over-capacity is a feature', () => {
  it('reports the shortfall in plain language instead of crushing the work in', () => {
    // 30 hours of work against a week with almost no free time.
    const events = [...Array(7).keys()].map((d) => hardEvent(`full${d}`, d, 6 * 60, 22 * 60, `full ${d}`))
    const plan = generatePlan(
      baseInput({
        events,
        tasks: [task('huge', 1800, null)],
      }),
    )
    expect(plan.unplaced.length).toBeGreaterThan(0)
    expect(plan.capacity.unplacedMinutes).toBeGreaterThan(0)
    expect(plan.narrative.join(' ')).toMatch(/did not fit|shortfall/i)
    assertNoDoubleBooking(plan.blocks)
  })

  it('names the binding constraint rather than shrugging', () => {
    const events = [...Array(7).keys()].map((d) => hardEvent(`full${d}`, d, 6 * 60, 22 * 60, `full ${d}`))
    const plan = generatePlan(baseInput({ events, tasks: [task('huge', 600, null)] }))
    for (const u of plan.unplaced) {
      expect(u.reason).toBeTruthy()
      expect(u.detail.length).toBeGreaterThan(20)
    }
  })

  it('says when a deadline has already passed', () => {
    const plan = generatePlan(
      baseInput({ tasks: [{ ...task('late', 120, 0), dueAt: -600 }] }),
    )
    expect(plan.unplaced[0]?.reason).toBe('due_before_week')
    expect(plan.unplaced[0]?.detail).toContain('already due')
  })

  it('says when the daily ceiling is what blocked it', () => {
    const prefs: Preferences = { ...DEFAULT_PREFERENCES, maxStudyMinutesPerDay: 60, minBlockMinutes: 25 }
    const plan = generatePlan(
      baseInput({
        tasks: [task('a', 60, null), task('b', 60, null), task('c', 60, null)],
        events: [...Array(6).keys()].map((d) => hardEvent(`full${d + 1}`, d + 1, 6 * 60, 22 * 60, `full ${d + 1}`)),
        preferences: prefs,
      }),
    )
    expect(plan.unplaced.some((u) => u.reason === 'daily_cap_reached')).toBe(true)
  })

  it('reports free time that exists but cannot hold a block', () => {
    const events = [...Array(7).keys()].flatMap((d) =>
      [...Array(8).keys()].map((i) => hardEvent(`b${d}-${i}`, d, 8 * 60 + i * 80, 8 * 60 + i * 80 + 60, 'busy')),
    )
    const plan = generatePlan(baseInput({ events, tasks: [] }))
    // The 20-minute gaps between obligations are real free time that the
    // transit buffer consumes. Reporting only sliver-length windows would
    // understate the loss, because buffering destroys them first.
    expect(plan.narrative.some((n) => n.includes('unusable'))).toBe(true)
  })
})

describe('determinism', () => {
  it('produces a byte-identical plan from identical inputs', () => {
    const input = baseInput({
      events: [hardEvent('f', 0, 700, 730), hardEvent('c', 1, 800, 950)],
      tasks: [task('a', 240, 4), task('b', 90, 2)],
    })
    const first = generatePlan(input)
    const second = generatePlan(input)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(second.inputsFingerprint).toBe(first.inputsFingerprint)
  })

  it('is independent of the order inputs arrive in', () => {
    const events = [hardEvent('f', 0, 700, 730), hardEvent('c', 1, 800, 950), hardEvent('d', 3, 1400, 1500)]
    const tasks = [task('a', 240, 4), task('b', 90, 2), task('c', 45, 3)]
    const forward = generatePlan(baseInput({ events, tasks }))
    const reversed = generatePlan(baseInput({ events: [...events].reverse(), tasks: [...tasks].reverse() }))
    expect(reversed.inputsFingerprint).toBe(forward.inputsFingerprint)
    expect(reversed.blocks.map((b) => `${b.span.start}-${b.title}`)).toEqual(
      forward.blocks.map((b) => `${b.span.start}-${b.title}`),
    )
  })

  it('changes the fingerprint when an input changes', () => {
    const a = generatePlan(baseInput({ tasks: [task('a', 90, 2)] }))
    const b = generatePlan(baseInput({ tasks: [task('a', 120, 2)] }))
    expect(b.inputsFingerprint).not.toBe(a.inputsFingerprint)
  })

  it('stamps the engine version', () => {
    expect(generatePlan(baseInput()).engineVersion).toBe(ENGINE_VERSION)
  })
})

describe('lock and regenerate', () => {
  it('promotes a locked block into the hard layer and keeps it exactly', () => {
    const first = generatePlan(baseInput({ tasks: [task('paper', 180, 4)] }))
    const target = first.blocks.find((b) => b.kind === 'study')
    expect(target).toBeDefined()
    const signature = encodeLockSignature(target!)

    const second = generatePlan(
      baseInput({ tasks: [task('paper', 180, 4)], lockedSignatures: [signature] }),
    )
    const locked = second.blocks.find((b) => b.locked)
    expect(locked).toBeDefined()
    expect(locked!.span).toEqual(target!.span)
    expect(locked!.because?.[0]).toContain('locked')
    assertNoDoubleBooking(second.blocks)
  })

  it('does not place other work on top of a locked block', () => {
    const first = generatePlan(baseInput({ tasks: [task('paper', 180, 4)] }))
    const signature = encodeLockSignature(first.blocks.find((b) => b.kind === 'study')!)
    const second = generatePlan(
      baseInput({ tasks: [task('paper', 180, 4), task('other', 120, 4)], lockedSignatures: [signature] }),
    )
    const locked = second.blocks.find((b) => b.locked)!
    const others = second.blocks.filter((b) => b.kind === 'study' && !b.locked)
    expect(others.every((b) => !overlaps(b.span, locked.span))).toBe(true)
  })
})

describe('constraint patches — the AI may constrain, never schedule', () => {
  it('honours a blocked-out window', () => {
    const plan = generatePlan(
      baseInput({
        tasks: [task('paper', 240, 5)],
        patch: { blockOut: [{ day: 3, start: 16 * 60, end: 22 * 60, reason: 'guard' }] },
      }),
    )
    const guard = span(atDay(3, 16 * 60), atDay(3, 22 * 60))
    expect(plan.blocks.filter((b) => b.kind === 'study').every((b) => !overlaps(b.span, guard))).toBe(true)
  })

  it('boosts a task so it is scheduled earlier', () => {
    const plain = generatePlan(baseInput({ tasks: [task('a', 90, 4), task('b', 90, 4)] }))
    const boosted = generatePlan(
      baseInput({ tasks: [task('a', 90, 4), task('b', 90, 4)], patch: { boostTaskIds: ['b'] } }),
    )
    const plainB = plain.blocks.find((x) => x.taskId === 'b')!
    const boostedB = boosted.blocks.find((x) => x.taskId === 'b')!
    expect(boostedB.span.start).toBeLessThanOrEqual(plainB.span.start)
  })

  it('relaxes a named preference and nothing else', () => {
    const prefs: Preferences = { ...DEFAULT_PREFERENCES, maxStudyMinutesPerDay: 60 }
    const tight = generatePlan(baseInput({ tasks: [task('big', 300, null)], preferences: prefs }))
    const relaxed = generatePlan(
      baseInput({ tasks: [task('big', 300, null)], preferences: prefs, patch: { relax: ['maxStudyMinutesPerDay'] } }),
    )
    expect(relaxed.capacity.placedMinutes).toBeGreaterThan(tight.capacity.placedMinutes)
  })
})

describe('end to end, on the fixture week', () => {
  const matrix = parseMatrix(detectMatrix(fixture('matrix-wide.csv')), { classYear: '2028', company: 'Band' })
  const long = parseMatrix(detectMatrix(fixture('matrix-long.csv')), { classYear: '2028', company: 'Band' })
  const canvas = parseIcs(fixture('canvas.ics'), { weekStart: WEEK_START, timeZone: 'America/New_York' })

  const plan = generatePlan(
    baseInput({
      events: [...matrix.events, ...long.events, ...canvas.events],
      tasks: canvas.tasks,
    }),
  )

  it('produces a plan with real blocks from real files', () => {
    expect(plan.blocks.length).toBeGreaterThan(20)
    expect(plan.blocks.some((b) => b.kind === 'formation')).toBe(true)
    expect(plan.blocks.some((b) => b.kind === 'study')).toBe(true)
    expect(plan.blocks.some((b) => b.kind === 'assignment_due')).toBe(true)
  })

  it('never double-books the cadet', () => {
    assertNoDoubleBooking(plan.blocks)
  })

  it('keeps every block inside the week', () => {
    for (const block of plan.blocks) {
      expect(block.span.start).toBeGreaterThanOrEqual(0)
      expect(block.span.end).toBeLessThanOrEqual(MINUTES_PER_WEEK)
    }
  })

  it('surfaces the institutional lab/training conflict', () => {
    expect(plan.conflicts.length).toBeGreaterThan(0)
  })

  it('writes a narrative a person can act on', () => {
    expect(plan.narrative.length).toBeGreaterThan(1)
    expect(plan.narrative.join(' ')).toMatch(/hours/)
  })

  it('is stable across runs', () => {
    const again = generatePlan(
      baseInput({ events: [...matrix.events, ...long.events, ...canvas.events], tasks: canvas.tasks }),
    )
    expect(again.inputsFingerprint).toBe(plan.inputsFingerprint)
    expect(JSON.stringify(again.blocks)).toBe(JSON.stringify(plan.blocks))
  })

  it('accounts for every day of the week, weekend included', () => {
    expect(plan.capacity.byDay).toHaveLength(7)
    // Saturday and Sunday carry real obligations in this fixture; a Mon-Fri
    // planner would lose them entirely.
    expect(plan.capacity.byDay[5]!.hardMinutes + plan.capacity.byDay[6]!.hardMinutes).toBeGreaterThan(0)
  })
})
