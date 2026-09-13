/**
 * Raw sources → the week.
 *
 * Parsing runs on every render of a week rather than once at upload. That is a
 * deliberate trade: it costs a few milliseconds of pure computation and buys
 * three things that matter more.
 *
 *   - Any week can be viewed, past or future, because events are resolved
 *     against the week being asked about rather than frozen at upload time.
 *   - A parser fix applies retroactively to files already in hand.
 *   - There is no derived state to keep in sync with its source, which is the
 *     usual home of the bugs that make a planner untrustworthy.
 */

import { generatePlan, type ConstraintPatch } from '../engine/solve'
import type { LocalDate } from '../domain/time'
import type { Plan, Task, WeekEvent } from '../domain/types'
import { detectMatrix, parseMatrix, type LongField } from '../parse/matrix'
import { parseIcs } from '../parse/ics'
import { parseTermSchedule } from '../parse/term'
import { manualEventsToWeek, type AppState } from './state'

export interface SourceReport {
  label: string
  detail: string
  warnings: string[]
  eventCount: number
  ok: boolean
}

export interface DerivedWeek {
  events: WeekEvent[]
  tasks: Task[]
  plan: Plan
  reports: SourceReport[]
  /** Deadlines just past the week end, so work-ahead is visible. */
  upcoming: Array<{ title: string; course?: string; dueDate: LocalDate; minutesPastWeek: number }>
  hasAnySource: boolean
}

export function deriveWeek(state: AppState, weekStart: LocalDate, patch?: ConstraintPatch): DerivedWeek {
  const events: WeekEvent[] = []
  const tasks: Task[] = []
  const reports: SourceReport[] = []
  let upcoming: DerivedWeek['upcoming'] = []

  // ---- The cadetship matrix --------------------------------------------
  if (state.matrix) {
    try {
      const detection = detectMatrix(state.matrix.text)
      const fingerprint = detection.headerFingerprint
      const remembered = state.matrix.mappings?.[fingerprint]
      const mapping = (remembered ?? detection.suggestedMapping ?? {}) as Record<string, LongField>

      const result = parseMatrix(detection, {
        ...(state.profile.classYear ? { classYear: state.profile.classYear } : {}),
        ...(state.profile.company ? { company: state.profile.company } : {}),
        mapping,
      })
      events.push(...result.events)
      reports.push({
        label: 'Cadetship matrix',
        detail: `${state.matrix.filename} — read as a ${detection.shape === 'wide' ? 'weekly grid' : 'row-per-event table'}`,
        warnings: [...detection.warnings, ...result.warnings, ...result.rejected.map((r) => `Row ${r.row + 1}: ${r.why}`)],
        eventCount: result.events.length,
        ok: result.events.length > 0,
      })
    } catch (error) {
      reports.push({
        label: 'Cadetship matrix',
        detail: state.matrix.filename,
        warnings: [`Could not read this file: ${error instanceof Error ? error.message : 'unknown error'}`],
        eventCount: 0,
        ok: false,
      })
    }
  }

  // ---- Course schedule --------------------------------------------------
  if (state.term) {
    try {
      const result = parseTermSchedule(state.term.text)
      events.push(...result.events)
      reports.push({
        label: 'Course schedule',
        detail: `${state.term.filename} — ${result.sections.length} section${result.sections.length === 1 ? '' : 's'}`,
        warnings: result.warnings,
        eventCount: result.events.length,
        ok: result.events.length > 0,
      })
    } catch (error) {
      reports.push({
        label: 'Course schedule',
        detail: state.term.filename,
        warnings: [`Could not read this file: ${error instanceof Error ? error.message : 'unknown error'}`],
        eventCount: 0,
        ok: false,
      })
    }
  }

  // ---- Canvas -----------------------------------------------------------
  if (state.canvas) {
    try {
      const result = parseIcs(state.canvas.text, {
        weekStart,
        timeZone: state.preferences.timeZone,
      })
      events.push(...result.events)
      tasks.push(...result.tasks)
      upcoming = result.upcoming
      reports.push({
        label: 'Canvas calendar',
        detail: `${state.canvas.label} — ${result.stats.vevents} calendar entries, ${result.tasks.length} with deadlines`,
        warnings: result.warnings,
        eventCount: result.events.length,
        ok: result.stats.vevents > 0,
      })
    } catch (error) {
      reports.push({
        label: 'Canvas calendar',
        detail: state.canvas.label,
        warnings: [`Could not read this feed: ${error instanceof Error ? error.message : 'unknown error'}`],
        eventCount: 0,
        ok: false,
      })
    }
  }

  // ---- Typed in by hand -------------------------------------------------
  const manual = manualEventsToWeek(state.manualEvents)
  events.push(...manual)
  if (state.manualEvents.length > 0) {
    reports.push({
      label: 'Added by hand',
      detail: `${state.manualEvents.length} recurring obligation${state.manualEvents.length === 1 ? '' : 's'}`,
      warnings: [],
      eventCount: manual.length,
      ok: true,
    })
  }

  // ---- Tasks: derived Canvas work plus hand-entered work ----------------
  const merged = applyOverrides(tasks, state).concat(state.manualTasks)

  const plan = generatePlan({
    weekStart,
    events,
    tasks: merged,
    preferences: state.preferences,
    lockedSignatures: state.locks[weekStart] ?? [],
    ...(patch ? { patch } : {}),
  })

  return {
    events,
    tasks: merged,
    plan,
    reports,
    upcoming,
    hasAnySource: Boolean(state.matrix || state.term || state.canvas) || state.manualEvents.length > 0 || state.manualTasks.length > 0,
  }
}

/**
 * Apply the cadet's edits over derived Canvas tasks.
 *
 * An estimate the cadet set is permanent: `estimateSource` flips to `'user'`
 * and no estimator — keyword default or model — may overwrite it. Getting this
 * wrong is how a planner loses trust for good.
 */
function applyOverrides(tasks: readonly Task[], state: AppState): Task[] {
  return tasks.map((task) => {
    const key = task.canvasUid ?? task.id
    const override = state.taskOverrides[key]
    if (!override) return task
    return {
      ...task,
      ...(override.estimateMinutes !== undefined
        ? { estimateMinutes: override.estimateMinutes, estimateSource: 'user' as const }
        : {}),
      ...(override.status ? { status: override.status } : {}),
      ...(override.weight !== undefined ? { weight: override.weight } : {}),
      ...(override.chunks ? { chunks: override.chunks } : {}),
    }
  })
}
