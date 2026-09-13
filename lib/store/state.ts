/**
 * Client-side state.
 *
 * There is no database. The whole planner state lives in the browser and is
 * persisted to `localStorage`, which has three consequences worth being
 * explicit about:
 *
 *   1. Schedule data never leaves the device. A cadetship matrix carries
 *      unit-level movement detail; the strongest privacy guarantee available
 *      is for the file to never be uploaded anywhere, and that is what this
 *      architecture provides for free. It is a better answer than the private
 *      bucket and signed URLs the original plan specified.
 *
 *   2. RAW UPLOADS ARE KEPT, not just the parsed output. Re-parsing has to be
 *      possible without asking for the file again: parsers are wrong in ways
 *      you cannot predict from one sample, and the ability to fix the parser
 *      and replay is what saves you. It is also what makes viewing a different
 *      week possible at all, since events are resolved per week.
 *
 *   3. It can be lost. Clearing site data clears the plan. The export button
 *      exists for that reason and the UI says so rather than pretending
 *      otherwise.
 */

import { DEFAULT_PREFERENCES } from '../engine/solve'
import { weekStartOf, type LocalDate } from '../domain/time'
import type { Preferences, Profile, Task, WeekEvent } from '../domain/types'

export const STORAGE_KEY = 'order.state.v1'
export const STATE_VERSION = 1

/** A file the cadet handed us, kept verbatim. */
export interface RawSource {
  filename: string
  text: string
  receivedAt: string
  /** Confirmed column mapping, keyed by header fingerprint. */
  mappings?: Record<string, Record<string, string>>
}

export interface CanvasSource {
  /**
   * The feed URL is a CREDENTIAL — it grants read access to this cadet's
   * calendar to anyone holding it. It is stored here because resyncing needs
   * it, and it is never rendered beyond its last characters, never logged, and
   * never sent anywhere except through this app's own fetch proxy.
   */
  feedUrl?: string
  text: string
  fetchedAt: string
  label: string
}

/** A recurring obligation the cadet typed in by hand. */
export interface ManualEvent {
  id: string
  title: string
  kind: string
  days: number[]
  start: number
  end: number
  location?: string
  hard: boolean
}

export interface AppState {
  version: number
  profile: Profile
  preferences: Preferences
  matrix: RawSource | null
  term: RawSource | null
  canvas: CanvasSource | null
  manualEvents: ManualEvent[]
  /** Tasks typed in by hand. Canvas tasks are derived, not stored. */
  manualTasks: Task[]
  /**
   * Edits applied on top of derived Canvas tasks, keyed by Canvas UID. Once a
   * cadet sets an estimate it is permanent and no estimator touches it again.
   */
  taskOverrides: Record<
    string,
    { estimateMinutes?: number; status?: Task['status']; weight?: number; chunks?: Task['chunks'] }
  >
  /** Locked block signatures, keyed by week start. */
  locks: Record<string, string[]>
  selectedWeek: LocalDate
  theme: 'system' | 'light' | 'dark'
}

export function defaultState(today: LocalDate): AppState {
  return {
    version: STATE_VERSION,
    profile: { name: '', classYear: '', company: '' },
    preferences: DEFAULT_PREFERENCES,
    matrix: null,
    term: null,
    canvas: null,
    manualEvents: [],
    manualTasks: [],
    taskOverrides: {},
    locks: {},
    selectedWeek: weekStartOf(today),
    theme: 'system',
  }
}

// ---------------------------------------------------------------------------
// Persistence. Every access is guarded: a private window, blocked site data,
// or a quota failure must degrade to an in-memory session, never to a crash.
// ---------------------------------------------------------------------------

export function loadState(today: LocalDate): AppState {
  const fallback = defaultState(today)
  if (typeof window === 'undefined') return fallback

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    return migrate(parsed, fallback)
  } catch {
    return fallback
  }
}

export function saveState(state: AppState): { ok: boolean; error?: string } {
  if (typeof window === 'undefined') return { ok: false, error: 'no window' }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    return { ok: true }
  } catch (error) {
    // The realistic failure is a quota overrun from a large ICS feed.
    return {
      ok: false,
      error:
        error instanceof Error && /quota/i.test(error.message)
          ? 'Browser storage is full. Export your plan, then clear a source you no longer need.'
          : 'This browser will not save data, so your plan will be lost when you close the tab.',
    }
  }
}

/**
 * Accept any shape and return a valid state.
 *
 * A stored blob is untrusted input: it may come from an older version, a
 * partially-written record, or a hand-edited export. Every field is checked
 * individually so one bad key cannot discard an otherwise good plan.
 */
export function migrate(input: unknown, fallback: AppState): AppState {
  if (typeof input !== 'object' || input === null) return fallback
  const raw = input as Record<string, unknown>

  const profile = isRecord(raw['profile'])
    ? {
        name: asString(raw['profile']['name'], ''),
        classYear: asString(raw['profile']['classYear'], ''),
        company: asString(raw['profile']['company'], ''),
      }
    : fallback.profile

  const preferences = isRecord(raw['preferences'])
    ? mergePreferences(raw['preferences'], fallback.preferences)
    : fallback.preferences

  return {
    version: STATE_VERSION,
    profile,
    preferences,
    matrix: asRawSource(raw['matrix']),
    term: asRawSource(raw['term']),
    canvas: asCanvasSource(raw['canvas']),
    manualEvents: Array.isArray(raw['manualEvents']) ? (raw['manualEvents'] as ManualEvent[]) : [],
    manualTasks: Array.isArray(raw['manualTasks']) ? (raw['manualTasks'] as Task[]) : [],
    taskOverrides: isRecord(raw['taskOverrides']) ? (raw['taskOverrides'] as AppState['taskOverrides']) : {},
    locks: isRecord(raw['locks']) ? (raw['locks'] as Record<string, string[]>) : {},
    selectedWeek: asString(raw['selectedWeek'], fallback.selectedWeek),
    theme: asTheme(raw['theme']),
  }
}

function mergePreferences(raw: Record<string, unknown>, fallback: Preferences): Preferences {
  return {
    timeZone: asString(raw['timeZone'], fallback.timeZone),
    wake: asNumber(raw['wake'], fallback.wake, 0, 1440),
    sleep: asNumber(raw['sleep'], fallback.sleep, 0, 1440),
    meals: Array.isArray(raw['meals']) ? (raw['meals'] as Preferences['meals']) : fallback.meals,
    minBlockMinutes: asNumber(raw['minBlockMinutes'], fallback.minBlockMinutes, 5, 240),
    maxBlockMinutes: asNumber(raw['maxBlockMinutes'], fallback.maxBlockMinutes, 15, 480),
    maxStudyMinutesPerDay: asNumber(raw['maxStudyMinutesPerDay'], fallback.maxStudyMinutesPerDay, 0, 1440),
    bufferMinutes: asNumber(raw['bufferMinutes'], fallback.bufferMinutes, 0, 60),
    minLeadHours: asNumber(raw['minLeadHours'], fallback.minLeadHours, 0, 168),
    protectedWindows: Array.isArray(raw['protectedWindows'])
      ? (raw['protectedWindows'] as Preferences['protectedWindows'])
      : fallback.protectedWindows,
    dayPhaseBias: asNumber(raw['dayPhaseBias'], fallback.dayPhaseBias, 0, 1),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function asTheme(value: unknown): AppState['theme'] {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

function asRawSource(value: unknown): RawSource | null {
  if (!isRecord(value)) return null
  const text = asString(value['text'], '')
  if (text === '') return null
  return {
    filename: asString(value['filename'], 'upload.csv'),
    text,
    receivedAt: asString(value['receivedAt'], ''),
    ...(isRecord(value['mappings']) ? { mappings: value['mappings'] as RawSource['mappings'] } : {}),
  }
}

function asCanvasSource(value: unknown): CanvasSource | null {
  if (!isRecord(value)) return null
  const text = asString(value['text'], '')
  if (text === '') return null
  const feedUrl = asString(value['feedUrl'], '')
  return {
    text,
    fetchedAt: asString(value['fetchedAt'], ''),
    label: asString(value['label'], 'Canvas'),
    ...(feedUrl ? { feedUrl } : {}),
  }
}

// ---------------------------------------------------------------------------
// Export / import. The answer to "localStorage can be cleared".
// ---------------------------------------------------------------------------

export function exportState(state: AppState): string {
  return JSON.stringify(state, null, 2)
}

export function importState(json: string, today: LocalDate): { state: AppState } | { error: string } {
  try {
    const parsed: unknown = JSON.parse(json)
    return { state: migrate(parsed, defaultState(today)) }
  } catch {
    return { error: 'That file is not a readable ORDER export.' }
  }
}

/** Events contributed by hand-entered obligations, expanded for a week. */
export function manualEventsToWeek(manual: readonly ManualEvent[]): WeekEvent[] {
  const out: WeekEvent[] = []
  for (const entry of manual) {
    for (const day of entry.days) {
      const start = day * 1440 + entry.start
      const end = day * 1440 + (entry.end > entry.start ? entry.end : entry.end + 1440)
      out.push({
        id: `manual:${entry.id}:${day}`,
        source: 'manual',
        sourceRef: entry.id,
        title: entry.title,
        kind: entry.kind as WeekEvent['kind'],
        span: { start, end },
        hard: entry.hard,
        ...(entry.location ? { location: entry.location } : {}),
      })
    }
  }
  return out
}
