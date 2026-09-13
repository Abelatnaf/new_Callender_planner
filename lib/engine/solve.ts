/**
 * The planning engine.
 *
 * Contract: pure function, integer arithmetic, no clock reads, no randomness.
 * Same inputs and same `ENGINE_VERSION` produce a byte-identical plan. That is
 * enforced by `inputsFingerprint` and asserted by the golden-file tests, and it
 * is the property that makes a wrong plan debuggable instead of mysterious.
 *
 * Where this departs from a textbook earliest-deadline-first placer, and why:
 *
 *   1. BEST-FIT, NOT FIRST-FIT. First-fit drops each chunk into the earliest
 *      window that holds it, which shreds the few long windows a cadet week
 *      contains. A 45-minute reading lands in the one free 3-hour Saturday
 *      block and the research paper then has nowhere to go. Best-fit spends the
 *      tightest adequate window first and defends the long ones.
 *
 *   2. LARGEST-FIRST WITHIN A DEADLINE TIER. Chunks that share a deadline tier
 *      are placed big-to-small, so the hard-to-place work claims space while
 *      space still exists.
 *
 *   3. LEAST SLACK, NOT RAW DEADLINE. Ordering is by slack — runway to the
 *      deadline minus the work still owed — so between two things due at the
 *      same hour the heavier one is placed first, and anything already behind
 *      (negative slack) sorts to the very front. Raw EDF cannot see the second
 *      case at all. Note what this deliberately does NOT claim: a small task
 *      with an earlier deadline still outranks a large one due later, which is
 *      correct, because best-fit stops that small task from spending a long
 *      window it does not need.
 *
 *   4. EVERY DECISION IS EXPLAINED. Each placed block carries a `because`
 *      trace, and every unplaced chunk names the ONE binding constraint rather
 *      than shrugging. A planner you cannot interrogate is a planner you stop
 *      believing.
 */

import { kindSpec } from '../domain/kinds'
import {
  atDay,
  clipToWeek,
  dailyWindow,
  DAYS_PER_WEEK,
  dayOf,
  formatClock,
  formatDuration,
  formatHours,
  MINUTES_PER_DAY,
  MINUTES_PER_WEEK,
  normalize,
  overlapMinutes,
  span,
  spanLength,
  subtract,
  totalMinutes,
  type Span,
  type WeekMinute,
} from '../domain/time'
import type {
  Capacity,
  Conflict,
  Plan,
  PlanBlock,
  Preferences,
  Task,
  Unplaced,
  UnplacedReason,
  WeekEvent,
} from '../domain/types'
import { simpleHash } from '../parse/matrix'

export const ENGINE_VERSION = '2.0.0'

export interface SolveInput {
  weekStart: string
  events: WeekEvent[]
  tasks: Task[]
  preferences: Preferences
  /** Signatures of blocks the user locked. Promoted into the hard layer. */
  lockedSignatures?: string[]
  /** Applied on top of preferences for one run. Never persisted. */
  patch?: ConstraintPatch
}

/**
 * What a conversational replan is allowed to produce.
 *
 * Note what is absent: any field naming a time at which to study. The model may
 * block time out, boost a task, or relax a preference. It may not schedule.
 */
export interface ConstraintPatch {
  boostTaskIds?: string[]
  /** Extra busy windows, expressed as day + clock so the model cannot invent a date. */
  blockOut?: Array<{ day: number; start: number; end: number; reason: string }>
  relax?: Array<'maxStudyMinutesPerDay' | 'minLeadHours' | 'bufferMinutes' | 'minBlockMinutes'>
  /** Per-task estimate overrides, in minutes. */
  reestimate?: Array<{ taskId: string; minutes: number }>
}

interface Chunk {
  taskId: string
  title: string
  course?: string
  label: string
  minutes: number
  dueAt: number | null
  /** Lower is more urgent. */
  criticality: number
  weight: number
  index: number
}

// ---------------------------------------------------------------------------

export function generatePlan(input: SolveInput): Plan {
  const prefs = applyPatchToPreferences(input.preferences, input.patch)
  const narrative: string[] = []

  // --- 1. HARD LAYER ---------------------------------------------------------
  const occupying = input.events.filter((e) => kindSpec(e.kind).occupiesTime && spanLength(e.span) > 0)
  const hardEvents = occupying.filter((e) => e.hard)
  const softEvents = occupying.filter((e) => !e.hard)
  const markers = input.events.filter((e) => !kindSpec(e.kind).occupiesTime || spanLength(e.span) === 0)

  const conflicts = findConflicts(hardEvents)

  const lockedBlocks = (input.lockedSignatures ?? [])
    .map((sig) => decodeLockSignature(sig))
    .filter((b): b is PlanBlock => b !== null)

  const protectedSpans = expandProtectedWindows(prefs)
  const patchBlocks = (input.patch?.blockOut ?? []).map((b) =>
    span(atDay(b.day, b.start), atDay(b.day, b.end)),
  )

  const hardSpans = normalize([
    ...hardEvents.map((e) => e.span),
    ...protectedSpans,
    ...patchBlocks,
    ...lockedBlocks.map((b) => b.span),
  ])

  // --- 2. FREE WINDOWS -------------------------------------------------------
  const sleepSpans = dailyWindow(prefs.sleep, prefs.wake)
  const mealSpans = prefs.meals.flatMap((m) => dailyWindow(m.start, m.end))
  const week = [span(0, MINUTES_PER_WEEK)]

  const freeRaw = subtract(week, normalize([...hardSpans, ...sleepSpans, ...mealSpans]))

  // --- 3. BUFFERS -----------------------------------------------------------
  // Shrink each free window that abuts an obligation. Barracks to academic
  // building is a real walk, and a plan that ignores it makes you late.
  let free = applyBuffers(freeRaw, hardSpans, prefs.bufferMinutes)
  const bufferLossMinutes = totalMinutes(freeRaw) - totalMinutes(free)

  // --- 4. FILTER ------------------------------------------------------------
  const tooShort = free.filter((s) => spanLength(s) < prefs.minBlockMinutes)
  free = free.filter((s) => spanLength(s) >= prefs.minBlockMinutes)
  // Free time that exists on paper but cannot hold a block: eaten by transit
  // buffers, or arriving in slivers below the minimum. Counted together because
  // from the cadet's side they are the same loss, and reporting only the second
  // understates it — a 20-minute gap between two obligations is usually
  // consumed by buffering before it is ever measured as "too short".
  const unusableMinutes = bufferLossMinutes + totalMinutes(tooShort)

  const freeBeforePlacement = free.map((s) => ({ ...s }))

  /**
   * Designated study windows.
   *
   * A matrix that lists SST or Call to Quarters is naming time you are
   * *required to be at your desk* — an institutional container for exactly the
   * work this engine places. It is soft rather than hard, because the point is
   * to be able to schedule inside it, but it is not merely neutral free time:
   * work placed here costs nothing, and work placed elsewhere spends a window
   * that could have been yours. So placement prefers it, strongly.
   *
   * Without this the solver treats SST as ordinary free time and will happily
   * schedule a reading at 16:00 while leaving two hours of mandatory study
   * period empty — which is backwards, and a cadet would notice immediately.
   */
  const designatedStudy = normalize(softEvents.filter((e) => e.kind === 'study').map((e) => e.span))

  // --- 5. DEMAND ------------------------------------------------------------
  const chunks = buildChunks(input.tasks, prefs, input.patch)
  const demandMinutes = chunks.reduce((sum, c) => sum + c.minutes, 0)

  // --- 6. PLACE -------------------------------------------------------------
  const placement = place(chunks, free, prefs, designatedStudy)

  // --- 7. BACKFILL ----------------------------------------------------------
  const openWindows = placement.remaining

  // --- 8. ASSEMBLE ----------------------------------------------------------
  const blocks: PlanBlock[] = [
    ...hardEvents.map(eventToBlock),
    ...softEvents.map(eventToBlock),
    ...markers.map(eventToBlock),
    ...lockedBlocks,
    ...placement.blocks,
  ].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.title.localeCompare(b.title))

  const capacity = measureCapacity({
    freeBeforePlacement,
    placed: placement.blocks,
    hardSpans,
    demandMinutes,
    unplaced: placement.unplaced,
    openWindows,
  })

  narrative.push(...writeNarrative({ capacity, conflicts, unplaced: placement.unplaced, unusableMinutes, prefs }))

  return {
    weekStart: input.weekStart,
    engineVersion: ENGINE_VERSION,
    inputsFingerprint: fingerprintInputs(input),
    blocks,
    conflicts,
    unplaced: placement.unplaced,
    capacity,
    openWindows,
    narrative,
  }
}

// ---------------------------------------------------------------------------
// 1. Conflicts — reported, never resolved.
// ---------------------------------------------------------------------------

/**
 * Pairwise overlap of the hard layer.
 *
 * The engine does NOT pick a winner. An institutional double-booking — the
 * lab that meets during mandatory training — is a fact about your week that you
 * must go resolve with a human, and a tool that quietly hides one of them is
 * worse than no tool.
 */
export function findConflicts(hardEvents: readonly WeekEvent[]): Conflict[] {
  const sorted = [...hardEvents].sort((a, b) => a.span.start - b.span.start)
  const out: Conflict[] = []

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (!a || !b) continue
      if (b.span.start >= a.span.end) break
      const minutes = overlapMinutes(a.span, b.span)
      if (minutes <= 0) continue

      // Identical spans from different sources are the same obligation counted
      // twice, not a conflict. Different times are a real collision.
      const identical = a.span.start === b.span.start && a.span.end === b.span.end
      const sameTitle = a.title.toLowerCase() === b.title.toLowerCase()
      if (identical && sameTitle) continue

      const authorityGap = Math.abs(kindSpec(a.kind).authority - kindSpec(b.kind).authority)
      out.push({
        a: { id: a.id, title: a.title, kind: a.kind },
        b: { id: b.id, title: b.title, kind: b.kind },
        span: span(Math.max(a.span.start, b.span.start), Math.min(a.span.end, b.span.end)),
        minutes,
        severity: authorityGap < 20 ? 'blocking' : 'overlap',
        note:
          authorityGap < 20
            ? `${a.title} and ${b.title} both claim ${formatDuration(minutes)} and neither outranks the other. Someone has to tell you which one to attend.`
            : `${a.title} overlaps ${b.title} by ${formatDuration(minutes)}. ${kindSpec(a.kind).authority > kindSpec(b.kind).authority ? a.title : b.title} normally takes precedence, but the app will not decide for you.`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 2–4. Free windows
// ---------------------------------------------------------------------------

function expandProtectedWindows(prefs: Preferences): Span[] {
  const out: Span[] = []
  for (const w of prefs.protectedWindows) {
    const days = w.days.length > 0 ? w.days : [...Array(DAYS_PER_WEEK).keys()]
    for (const d of days) {
      if (w.end > w.start) {
        out.push(span(atDay(d, w.start), atDay(d, w.end)))
      } else {
        out.push(span(atDay(d, w.start), atDay(d + 1, w.end)))
      }
    }
  }
  return clipToWeek(normalize(out))
}

/**
 * Shrink free windows that touch an obligation.
 *
 * Only the touching edges shrink. A window bounded by sleep on one side and a
 * formation on the other loses the formation edge and keeps the sleep edge,
 * because you do not need transit time from your own bed.
 */
export function applyBuffers(free: readonly Span[], obligations: readonly Span[], buffer: number): Span[] {
  if (buffer <= 0) return normalize(free)
  const busy = normalize(obligations)
  const out: Span[] = []

  for (const window of normalize(free)) {
    let { start, end } = window
    if (busy.some((b) => b.end === window.start)) start += buffer
    if (busy.some((b) => b.start === window.end)) end -= buffer
    if (end > start) out.push(span(start, end))
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. Demand
// ---------------------------------------------------------------------------

/**
 * Turn tasks into placeable chunks.
 *
 * Decomposition matters more in a cadet week than anywhere else: free time
 * arrives in 40-minute slivers between obligations, so a 4-hour paper that
 * cannot be split is a 4-hour paper that never gets scheduled.
 */
export function buildChunks(tasks: readonly Task[], prefs: Preferences, patch?: ConstraintPatch): Chunk[] {
  const boosted = new Set(patch?.boostTaskIds ?? [])
  const reestimates = new Map((patch?.reestimate ?? []).map((r) => [r.taskId, r.minutes]))
  const out: Chunk[] = []

  for (const task of tasks) {
    if (task.status === 'done') continue
    const estimate = reestimates.get(task.id) ?? task.estimateMinutes
    if (estimate <= 0) continue

    const pieces =
      task.chunks.length > 0
        ? task.chunks.map((c) => ({ label: c.label, minutes: c.minutes }))
        : splitEvenly(estimate, prefs.maxBlockMinutes, prefs.minBlockMinutes)

    const weight = task.weight * (boosted.has(task.id) ? 4 : 1)
    // Slack: runway to the deadline minus the work still owed. Negative slack
    // means already behind, and sorts to the front.
    const slack = task.dueAt === null ? MINUTES_PER_WEEK : task.dueAt - estimate
    const criticality = Math.round(slack / Math.max(1, weight))

    pieces.forEach((piece, index) => {
      out.push({
        taskId: task.id,
        title: task.title,
        ...(task.course ? { course: task.course } : {}),
        label: piece.label,
        minutes: piece.minutes,
        dueAt: task.dueAt,
        criticality,
        weight,
        index,
      })
    })
  }
  return out
}

/**
 * Split an estimate into placeable pieces.
 *
 * The remainder is absorbed into the preceding piece rather than emitted as a
 * stub, because a 7-minute chunk is noise on a page and a nuisance to place.
 */
export function splitEvenly(total: number, maxBlock: number, minBlock: number): Array<{ label: string; minutes: number }> {
  if (total <= maxBlock) return [{ label: 'session', minutes: total }]

  const count = Math.ceil(total / maxBlock)
  const base = Math.floor(total / count)
  const pieces: Array<{ label: string; minutes: number }> = []

  for (let i = 0; i < count; i++) {
    const minutes = i === count - 1 ? total - base * (count - 1) : base
    pieces.push({ label: `part ${i + 1} of ${count}`, minutes })
  }

  // Fold away a final stub.
  const last = pieces[pieces.length - 1]
  const secondLast = pieces[pieces.length - 2]
  if (last && secondLast && last.minutes < minBlock) {
    secondLast.minutes += last.minutes
    pieces.pop()
    return pieces.map((p, i) => ({ label: `part ${i + 1} of ${pieces.length}`, minutes: p.minutes }))
  }
  return pieces
}

// ---------------------------------------------------------------------------
// 6. Placement
// ---------------------------------------------------------------------------

interface PlacementResult {
  blocks: PlanBlock[]
  unplaced: Unplaced[]
  remaining: Span[]
}

function place(
  chunks: readonly Chunk[],
  free: readonly Span[],
  prefs: Preferences,
  designatedStudy: readonly Span[] = [],
): PlacementResult {
  // Deterministic order: criticality, then largest first within a tier, then a
  // stable key so the sort can never depend on input order.
  const queue = [...chunks].sort(
    (a, b) =>
      a.criticality - b.criticality ||
      b.minutes - a.minutes ||
      a.taskId.localeCompare(b.taskId) ||
      a.index - b.index,
  )

  let windows = normalize(free)
  const dayLoad = new Array<number>(DAYS_PER_WEEK).fill(0)
  const blocks: PlanBlock[] = []
  const unplaced: Unplaced[] = []
  // Breathing room between consecutive study blocks. Enforced by shrinking the
  // free windows around each placed block rather than by tracking "the last
  // block on this day": placement order is by criticality, not chronology, so a
  // floor derived from the previous placement would reject a chunk that belongs
  // EARLIER in the same day. Subtracting the placed block padded by the gap is
  // symmetric and independent of the order chunks are considered in.
  const studyGap = Math.min(prefs.bufferMinutes, 15)

  for (const chunk of queue) {
    const deadline = chunk.dueAt === null ? MINUTES_PER_WEEK : chunk.dueAt - prefs.minLeadHours * 60

    const candidates: Array<{ window: Span; start: number; score: number }> = []

    for (const window of windows) {
      // The chunk must finish by the lead-time-adjusted deadline.
      const latestFinish = Math.min(window.end, deadline)
      if (latestFinish - window.start < chunk.minutes) continue

      const day = dayOf(window.start)
      if (dayLoad[day] === undefined) continue
      if ((dayLoad[day] ?? 0) + chunk.minutes > prefs.maxStudyMinutesPerDay) continue

      /**
       * Candidate start offsets within this window.
       *
       * The window start alone is not enough. A free evening that runs
       * 18:45-23:00 CONTAINS the 19:00-21:00 study period, so starting at the
       * window edge lands fifteen minutes outside it and forfeits the
       * preference entirely. Offering each designated window's own start as a
       * candidate is what lets the solver step into the period rather than
       * straddle its edge.
       */
      const starts = new Set<number>([window.start])
      for (const designated of designatedStudy) {
        if (designated.start > window.start && designated.start < latestFinish) {
          starts.add(designated.start)
        }
      }

      for (const start of starts) {
        if (latestFinish - start < chunk.minutes) continue
        candidates.push({
          window,
          start,
          score: scoreSlot(window, start, chunk, prefs, designatedStudy),
        })
      }
    }

    if (candidates.length === 0) {
      unplaced.push(diagnoseUnplaced(chunk, windows, dayLoad, prefs))
      continue
    }

    candidates.sort((a, b) => a.score - b.score || a.start - b.start)
    const chosen = candidates[0]
    if (!chosen) continue

    const blockSpan = span(chosen.start, chosen.start + chunk.minutes)
    const day = dayOf(blockSpan.start)
    dayLoad[day] = (dayLoad[day] ?? 0) + chunk.minutes

    blocks.push({
      id: `study:${simpleHash(`${chunk.taskId}|${chunk.index}|${blockSpan.start}`)}`,
      span: blockSpan,
      title: chunk.title,
      kind: 'study',
      taskId: chunk.taskId,
      chunkLabel: chunk.label,
      locked: false,
      ...(chunk.course ? { course: chunk.course } : {}),
      because: explainPlacement(
        chunk,
        chosen.window,
        blockSpan,
        prefs,
        candidates.length,
        inDesignatedStudy(blockSpan, designatedStudy),
      ),
    })

    windows = subtract(windows, [span(blockSpan.start - studyGap, blockSpan.end + studyGap)]).filter(
      (s) => spanLength(s) >= prefs.minBlockMinutes,
    )
  }

  return { blocks, unplaced, remaining: windows }
}

/**
 * Lower score wins.
 *
 * Best-fit dominates: the tightest window that still holds the chunk is spent
 * first, which preserves long windows for work that needs them. Earliness is a
 * weak secondary term, and `dayPhaseBias` lets a night owl pull work later
 * without overriding the fit logic.
 */
function scoreSlot(
  window: Span,
  start: number,
  chunk: Chunk,
  prefs: Preferences,
  designatedStudy: readonly Span[],
): number {
  const waste = spanLength(window) - chunk.minutes
  const earliness = start / MINUTES_PER_WEEK
  const phase = (start % MINUTES_PER_DAY) / MINUTES_PER_DAY
  const phasePenalty = Math.abs(phase - prefs.dayPhaseBias)
  // Large enough to beat the best-fit and phase terms outright: being at your
  // desk during the study period you are required to attend is worth more than
  // a tidier window elsewhere.
  const designatedBonus = inDesignatedStudy(span(start, start + chunk.minutes), designatedStudy) ? 600 : 0
  return waste * 1.0 + earliness * 30 + phasePenalty * 60 - designatedBonus
}

/** Is this placement wholly inside a designated study window? */
function inDesignatedStudy(placed: Span, windows: readonly Span[]): boolean {
  return windows.some((w) => placed.start >= w.start && placed.end <= w.end)
}

function explainPlacement(
  chunk: Chunk,
  window: Span,
  placed: Span,
  prefs: Preferences,
  candidateCount: number,
  designated: boolean,
): string[] {
  const out: string[] = []
  const waste = spanLength(window) - chunk.minutes
  out.push(
    `${formatDuration(chunk.minutes)} of ${chunk.title}${chunk.label === 'session' ? '' : ` (${chunk.label})`}.`,
  )
  if (designated) {
    out.push('Placed inside a study period you are already required to attend, so it costs you no free time at all.')
  }
  if (waste === 0) out.push('This window fits it exactly.')
  else out.push(`Chosen as the tightest of ${candidateCount} workable window${candidateCount === 1 ? '' : 's'}, leaving ${formatDuration(waste)} spare — the longer windows are held back for longer work.`)

  if (chunk.dueAt !== null) {
    const slack = chunk.dueAt - placed.end
    out.push(
      slack >= 0
        ? `Finishes ${formatDuration(slack)} before it is due, which honours your ${prefs.minLeadHours}h lead.`
        : `Runs past the deadline — the lead-time rule was relaxed to fit it at all.`,
    )
  }
  return out
}

/**
 * Name the ONE binding constraint.
 *
 * This is done by re-testing the chunk against progressively relaxed
 * conditions, so the answer is the actual reason rather than a guess. "Didn't
 * fit" tells you nothing; "no window longer than 45m before Thursday 09:00"
 * tells you what to go change.
 */
function diagnoseUnplaced(
  chunk: Chunk,
  windows: readonly Span[],
  dayLoad: readonly number[],
  prefs: Preferences,
): Unplaced {
  const deadline = chunk.dueAt === null ? MINUTES_PER_WEEK : chunk.dueAt - prefs.minLeadHours * 60
  const base = {
    taskId: chunk.taskId,
    title: chunk.title,
    chunkLabel: chunk.label,
    minutes: chunk.minutes,
  }

  if (chunk.dueAt !== null && chunk.dueAt <= 0) {
    return {
      ...base,
      reason: 'due_before_week' satisfies UnplacedReason,
      detail: 'This was already due before the week started. It needs a conversation, not a slot.',
      minutesShort: chunk.minutes,
    }
  }

  const beforeDeadline = windows.filter((w) => w.start < deadline)
  if (beforeDeadline.length === 0) {
    return {
      ...base,
      reason: 'no_window_before_due',
      detail:
        chunk.dueAt === null
          ? 'No free time is left anywhere in the week.'
          : `Every remaining window starts after ${formatClock(deadline)} on ${dayLabel(deadline)}, which is the latest this could still finish ${prefs.minLeadHours}h before it is due.`,
      minutesShort: chunk.minutes,
    }
  }

  const longEnough = beforeDeadline.filter((w) => Math.min(w.end, deadline) - w.start >= chunk.minutes)
  if (longEnough.length === 0) {
    const longest = Math.max(...beforeDeadline.map((w) => Math.min(w.end, deadline) - w.start))
    return {
      ...base,
      reason: 'no_window_long_enough',
      detail: `The longest free window before the deadline is ${formatDuration(longest)}, and this piece needs ${formatDuration(chunk.minutes)}. Split the task further or lower the estimate.`,
      minutesShort: chunk.minutes - longest,
    }
  }

  const withCapacity = longEnough.filter((w) => {
    const day = dayOf(w.start)
    return (dayLoad[day] ?? 0) + chunk.minutes <= prefs.maxStudyMinutesPerDay
  })
  if (withCapacity.length === 0) {
    const day = dayOf(longEnough[0]?.start ?? 0)
    return {
      ...base,
      reason: 'daily_cap_reached',
      detail: `Windows exist, but every one is on a day already carrying ${formatDuration(dayLoad[day] ?? 0)} of study against your ${formatDuration(prefs.maxStudyMinutesPerDay)} daily ceiling. Raise the ceiling or move work earlier in the week.`,
      minutesShort: 0,
    }
  }

  return {
    ...base,
    reason: 'week_exhausted',
    detail: 'Blocked by the minimum gap between consecutive study blocks. Shorten the buffer to fit it.',
    minutesShort: 0,
  }
}

function dayLabel(m: WeekMinute): string {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dayOf(m)] ?? 'that day'
}

// ---------------------------------------------------------------------------
// Capacity and narrative — the truthful part.
// ---------------------------------------------------------------------------

function measureCapacity(input: {
  freeBeforePlacement: Span[]
  placed: PlanBlock[]
  hardSpans: Span[]
  demandMinutes: number
  unplaced: Unplaced[]
  openWindows: Span[]
}): Capacity {
  const freeMinutes = totalMinutes(input.freeBeforePlacement)
  const placedMinutes = input.placed.reduce((sum, b) => sum + spanLength(b.span), 0)
  const unplacedMinutes = input.unplaced.reduce((sum, u) => sum + u.minutes, 0)

  const byDay = [...Array(DAYS_PER_WEEK).keys()].map((day) => {
    const dayRange = [span(atDay(day, 0), atDay(day + 1, 0))]
    return {
      day,
      freeMinutes: totalMinutes(intersectSpans(input.freeBeforePlacement, dayRange)),
      studyMinutes: input.placed
        .filter((b) => dayOf(b.span.start) === day)
        .reduce((sum, b) => sum + spanLength(b.span), 0),
      hardMinutes: totalMinutes(intersectSpans(input.hardSpans, dayRange)),
    }
  })

  return {
    freeMinutes,
    demandMinutes: input.demandMinutes,
    placedMinutes,
    unplacedMinutes,
    slackMinutes: totalMinutes(input.openWindows),
    byDay,
  }
}

function intersectSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start)
      const end = Math.min(x.end, y.end)
      if (end > start) out.push(span(start, end))
    }
  }
  return normalize(out)
}

/**
 * Plain language, deterministically generated — no model involved.
 *
 * Over-capacity is a feature, not an error state. A planner that crushes 14
 * hours of work into 9 hours of free time and shows you a tidy grid is lying;
 * saying so in one sentence is the single most useful thing this app does.
 */
function writeNarrative(input: {
  capacity: Capacity
  conflicts: Conflict[]
  unplaced: Unplaced[]
  unusableMinutes: number
  prefs: Preferences
}): string[] {
  const { capacity, conflicts, unplaced, unusableMinutes } = input
  const out: string[] = []

  if (capacity.demandMinutes === 0) {
    out.push('No open work this week. Every hour outside your obligations is yours.')
  } else if (unplaced.length === 0) {
    out.push(
      `All ${formatHours(capacity.demandMinutes)} hours of work fit, with ${formatHours(capacity.slackMinutes)} hours of free time still unclaimed.`,
    )
  } else if (capacity.freeMinutes < capacity.demandMinutes) {
    // Genuine capacity shortage: there is less free time than work.
    out.push(
      `You have ${formatHours(capacity.demandMinutes)} hours of work and ${formatHours(capacity.freeMinutes)} hours of free time. ${unplaced.length} block${unplaced.length === 1 ? '' : 's'} did not fit.`,
    )
    out.push(
      `That is a ${formatHours(capacity.unplacedMinutes)}-hour shortfall. It will not resolve itself — cut scope, lower an estimate, or accept that something slips.`,
    )
  } else {
    /**
     * Work did not fit, but not for want of hours.
     *
     * Saying "you have 15 hours of work and 72 hours free, 1 block did not
     * fit" invites the reader to conclude the app is broken — the numbers
     * plainly contradict the conclusion. The binding constraint here is
     * WHEN, not HOW MUCH: a deadline, a daily ceiling, or a window too short
     * to hold the piece. Naming that is the difference between a report a
     * cadet trusts and one they stop reading.
     */
    const reasons = [...new Set(unplaced.map((u) => u.reason))]
    const because =
      reasons.length === 1 && reasons[0] === 'daily_cap_reached'
        ? 'your daily study ceiling'
        : reasons.length === 1 && reasons[0] === 'no_window_long_enough'
          ? 'no single free window being long enough'
          : reasons.length === 1 && reasons[0] === 'due_before_week'
            ? 'a deadline that has already passed'
            : 'when the work is due, not how much of it there is'
    out.push(
      `${unplaced.length} block${unplaced.length === 1 ? '' : 's'} did not fit — and the week is not full: ${formatHours(capacity.slackMinutes)} hours are still free.`,
    )
    out.push(
      `What blocked it was ${because}. Each piece below names the constraint that stopped it, so you can see whether it is worth moving something.`,
    )
  }

  const heaviest = [...capacity.byDay].sort((a, b) => b.hardMinutes - a.hardMinutes)[0]
  if (heaviest && heaviest.hardMinutes > 0) {
    const name = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][heaviest.day]
    out.push(
      `${name} is the tightest day: ${formatHours(heaviest.hardMinutes)} hours already committed, ${formatHours(heaviest.freeMinutes)} free.`,
    )
  }

  if (unusableMinutes >= 60) {
    out.push(
      `${formatHours(unusableMinutes)} hours of your free time is unusable — it arrives in slivers shorter than ${formatDuration(input.prefs.minBlockMinutes)}, or goes to the ${formatDuration(input.prefs.bufferMinutes)} of transit time around each obligation. Lower the minimum block or the buffer to reclaim some of it.`,
    )
  }

  if (conflicts.length > 0) {
    const blocking = conflicts.filter((c) => c.severity === 'blocking').length
    out.push(
      `${conflicts.length} obligation${conflicts.length === 1 ? '' : 's'} collide${conflicts.length === 1 ? 's' : ''} this week${blocking > 0 ? `, ${blocking} of them with no clear precedence` : ''}. The app will not choose for you.`,
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function eventToBlock(event: WeekEvent): PlanBlock {
  return {
    id: `event:${event.id}`,
    span: event.span,
    title: event.title,
    kind: event.kind,
    eventId: event.id,
    locked: false,
    ...(event.course ? { course: event.course } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.uniform ? { uniform: event.uniform } : {}),
  }
}

/** A locked block round-trips through a signature so it survives regeneration. */
export function encodeLockSignature(block: PlanBlock): string {
  return [block.span.start, block.span.end, block.kind, block.title, block.taskId ?? '', block.chunkLabel ?? ''].join('¦')
}

export function decodeLockSignature(signature: string): PlanBlock | null {
  const parts = signature.split('¦')
  const [start, end, kind, title, taskId, chunkLabel] = parts
  if (start === undefined || end === undefined || kind === undefined || title === undefined) return null
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null
  return {
    id: `locked:${simpleHash(signature)}`,
    span: span(s, e),
    title,
    kind: kind as PlanBlock['kind'],
    locked: true,
    ...(taskId ? { taskId } : {}),
    ...(chunkLabel ? { chunkLabel } : {}),
    because: ['You locked this block, so the solver treated it as an obligation.'],
  }
}

/**
 * Hash of everything that can change the output.
 *
 * Two runs with the same fingerprint and engine version MUST produce identical
 * plans. That is asserted in the tests, and it is what makes a bad plan
 * reproducible rather than a ghost story.
 */
export function fingerprintInputs(input: SolveInput): string {
  const events = [...input.events]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `${e.id}|${e.span.start}|${e.span.end}|${e.kind}|${e.hard ? 1 : 0}|${e.title}`)
  const tasks = [...input.tasks]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => `${t.id}|${t.dueAt ?? 'x'}|${t.estimateMinutes}|${t.status}|${t.weight}|${t.chunks.map((c) => c.minutes).join('.')}`)
  const prefs = JSON.stringify(input.preferences, Object.keys(input.preferences).sort())
  const locks = [...(input.lockedSignatures ?? [])].sort()
  const patch = input.patch ? JSON.stringify(input.patch) : ''
  return simpleHash([ENGINE_VERSION, input.weekStart, ...events, ...tasks, prefs, ...locks, patch].join('\n'))
}

/** Relaxations from a constraint patch, applied to a copy. */
export function applyPatchToPreferences(prefs: Preferences, patch?: ConstraintPatch): Preferences {
  if (!patch?.relax || patch.relax.length === 0) return prefs
  const next: Preferences = { ...prefs }
  for (const key of patch.relax) {
    if (key === 'maxStudyMinutesPerDay') next.maxStudyMinutesPerDay = Math.round(prefs.maxStudyMinutesPerDay * 1.5)
    if (key === 'minLeadHours') next.minLeadHours = Math.max(0, Math.floor(prefs.minLeadHours / 2))
    if (key === 'bufferMinutes') next.bufferMinutes = Math.max(0, Math.floor(prefs.bufferMinutes / 2))
    if (key === 'minBlockMinutes') next.minBlockMinutes = Math.max(10, Math.floor(prefs.minBlockMinutes / 2))
  }
  return next
}

export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: 'America/New_York',
  wake: 6 * 60,
  sleep: 23 * 60,
  meals: [
    { label: 'Breakfast', start: 6 * 60 + 45, end: 7 * 60 + 15 },
    { label: 'Lunch', start: 12 * 60, end: 12 * 60 + 45 },
    { label: 'Dinner', start: 18 * 60, end: 18 * 60 + 45 },
  ],
  minBlockMinutes: 25,
  maxBlockMinutes: 90,
  maxStudyMinutesPerDay: 240,
  bufferMinutes: 10,
  minLeadHours: 12,
  protectedWindows: [],
  dayPhaseBias: 0.45,
}
