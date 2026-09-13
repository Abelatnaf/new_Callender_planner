import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expandRecurrence,
  maskFeedUrl,
  parseDuration,
  parseIcs,
  splitCourseSuffix,
  unescapeText,
  unfold,
} from '@/lib/parse/ics'
import { atDay, dayOf, formatClock, spanLength } from '@/lib/domain/time'

const ics = readFileSync(join(__dirname, 'fixtures', 'canvas.ics'), 'utf8')
const options = { weekStart: '2026-09-14', timeZone: 'America/New_York' }

describe('ICS lexing', () => {
  it('unfolds continuation lines', () => {
    const lines = unfold('SUMMARY:A long title that was folded acr\n oss two lines\nUID:x')
    expect(lines[0]).toBe('SUMMARY:A long title that was folded across two lines')
    expect(lines).toHaveLength(2)
  })

  it('handles CRLF and lone CR', () => {
    expect(unfold('A:1\r\nB:2\rC:3')).toEqual(['A:1', 'B:2', 'C:3'])
  })

  it('unescapes TEXT values', () => {
    expect(unescapeText('Line one\\nLine two\\, with a comma')).toBe('Line one\nLine two, with a comma')
  })

  it('parses ISO durations', () => {
    expect(parseDuration('PT1H30M')).toBe(90)
    expect(parseDuration('PT45M')).toBe(45)
    expect(parseDuration('P1D')).toBe(1440)
  })
})

describe('course suffix', () => {
  it('lifts the bracketed course out of the title', () => {
    expect(splitCourseSuffix('Reading Response 2 [ERH-101-04]')).toEqual({
      title: 'Reading Response 2',
      course: 'ERH-101-04',
    })
  })

  it('leaves a title alone when there is no suffix', () => {
    expect(splitCourseSuffix('Study Group')).toEqual({ title: 'Study Group' })
  })
})

describe('recurrence, expanded only inside the week', () => {
  it('expands a weekly BYDAY rule', () => {
    const { spans, supported } = expandRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR', atDay(0, 600), 50)
    expect(supported).toBe(true)
    expect(spans.map((s) => dayOf(s.start))).toEqual([0, 2, 4])
    expect(spans.every((s) => s.end - s.start === 50)).toBe(true)
  })

  it('honours COUNT', () => {
    const { spans } = expandRecurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=2', atDay(0, 600), 50)
    expect(spans).toHaveLength(2)
  })

  it('refuses to guess at a rule it does not understand', () => {
    const { spans, supported } = expandRecurrence('FREQ=MONTHLY;BYMONTHDAY=15', atDay(0, 600), 50)
    expect(supported).toBe(false)
    expect(spans).toHaveLength(1)
  })
})

describe('the Canvas feed', () => {
  const result = parseIcs(ics, options)

  it('skips a cancelled event', () => {
    expect(result.stats.cancelled).toBe(1)
    expect(result.events.some((e) => e.title.includes('Cancelled'))).toBe(false)
  })

  it('counts an entry with no DTSTART as broken rather than crashing', () => {
    expect(result.stats.noDtstart).toBe(1)
    expect(result.warnings.some((w) => w.includes('no readable start time'))).toBe(true)
  })

  /**
   * The most important assertion in this file.
   *
   * Canvas emits an assignment as a VEVENT with DTSTART (the due moment) and no
   * DTEND. Reading that as a one-hour meeting would invent occupied time the
   * cadet does not actually owe, and every downstream free-window calculation
   * would then be wrong in the direction that hurts most.
   */
  it('treats a due date as a zero-length marker, never an occupied block', () => {
    const due = result.events.filter((e) => e.kind === 'assignment_due')
    expect(due.length).toBeGreaterThan(0)
    expect(due.every((e) => spanLength(e.span) === 0)).toBe(true)
    expect(due.every((e) => e.hard === false)).toBe(true)
  })

  it('spawns a task per assignment, keyed on the Canvas UID', () => {
    const task = result.tasks.find((t) => t.title === 'Reading Response 2')
    expect(task).toBeDefined()
    expect(task?.course).toBe('ERH-101-04')
    expect(task?.canvasUid).toContain('event-assignment-1234567')
    expect(task?.estimateSource).toBe('default')
  })

  it('sizes a research paper larger than a reading response', () => {
    const paper = result.tasks.find((t) => t.title === 'Research Paper Draft')
    const response = result.tasks.find((t) => t.title === 'Reading Response 2')
    expect(paper!.estimateMinutes).toBeGreaterThan(response!.estimateMinutes)
  })

  it('resolves a TZID event to the right wall-clock hour', () => {
    const conference = result.events.find((e) => e.title === 'ERH-101 Conference')
    expect(conference).toBeDefined()
    expect(dayOf(conference!.span.start)).toBe(1) // Tuesday 15 Sep
    expect(formatClock(conference!.span.start)).toBe('14:00')
    expect(spanLength(conference!.span)).toBe(80)
  })

  it('reads a floating time as local wall clock', () => {
    const group = result.events.find((e) => e.title === 'Study Group')
    expect(formatClock(group!.span.start)).toBe('19:00')
    expect(spanLength(group!.span)).toBe(90)
  })

  it('gives an all-day notice zero length so it cannot eat the day', () => {
    const holiday = result.events.find((e) => e.title === 'Institute Holiday')
    expect(holiday).toBeDefined()
    expect(spanLength(holiday!.span)).toBe(0)
  })

  it('expands a recurring class across the week', () => {
    const recitation = result.events.filter((e) => e.title === 'MATH-121 Recitation')
    expect(recitation.map((e) => dayOf(e.span.start)).sort()).toEqual([0, 2, 4])
    expect(recitation.every((e) => e.kind === 'class' && e.hard)).toBe(true)
  })

  it('classifies a midterm as an exam that occupies real time', () => {
    const midterm = result.events.find((e) => e.title.includes('Midterm'))
    expect(midterm?.kind).toBe('exam')
    expect(midterm?.hard).toBe(true)
    expect(spanLength(midterm!.span)).toBe(110)
  })

  it('reads a folded assignment title', () => {
    const folded = result.tasks.find((t) => t.title.includes('folded across two physical lines'))
    expect(folded).toBeDefined()
    expect(folded?.course).toBe('HI-104-02')
  })

  it('converts a UTC due time to the correct Eastern day', () => {
    // 20260917T035900Z is 23:59 EDT on Wednesday 16 Sep, not Thursday.
    const task = result.tasks.find((t) => t.title === 'Reading Response 2')
    expect(dayOf(task!.dueAt!)).toBe(2)
    expect(formatClock(task!.dueAt!)).toBe('23:59')
  })

  it('is idempotent — re-parsing the same feed yields the same set', () => {
    const again = parseIcs(ics, options)
    expect(again.events.map((e) => e.id)).toEqual(result.events.map((e) => e.id))
    expect(again.tasks.map((t) => t.id)).toEqual(result.tasks.map((t) => t.id))
  })
})

describe('an empty feed', () => {
  it('says so plainly instead of pretending to work', () => {
    const empty = parseIcs('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR', options)
    expect(empty.events).toHaveLength(0)
    expect(empty.warnings.some((w) => w.includes('no events at all'))).toBe(true)
  })

  it('tells you to add work by hand when a feed has events but no deadlines', () => {
    const noDue = parseIcs(
      `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:x@y
DTSTART;TZID=America/New_York:20260915T100000
DTEND;TZID=America/New_York:20260915T105000
SUMMARY:Lecture [CS-101-01]
END:VEVENT
END:VCALENDAR`,
      options,
    )
    expect(noDue.warnings.some((w) => w.includes('add your work by hand'))).toBe(true)
  })
})

describe('the feed URL is a credential', () => {
  it('never renders more than the last six characters', () => {
    const masked = maskFeedUrl('https://vmi.instructure.com/feeds/calendars/user_abcdef123456.ics')
    expect(masked).toBe('…56.ics'.slice(-7))
    expect(masked.length).toBeLessThanOrEqual(7)
    expect(masked).not.toContain('abcdef')
  })
})
