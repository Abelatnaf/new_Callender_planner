import type { Kind } from './kinds'
import type { LocalDate, Span, WeekMinute } from './time'

/** Where a block came from. The solver never reads this; only the UI does. */
export type Source = 'matrix' | 'term' | 'canvas' | 'manual'

/**
 * The normalized layer everything collapses into.
 *
 * One table, not five, for the reason the build plan gave and got right: the
 * solver asks two questions — is it hard, and when is it — and every
 * source-specific quirk must die inside its parser.
 */
export interface WeekEvent {
  id: string
  source: Source
  /** Stable upstream key: ICS UID, section id, or matrix row hash. */
  sourceRef: string
  title: string
  kind: Kind
  span: Span
  /** Immovable. Defaults from `kindSpec` but a parser or the user may override. */
  hard: boolean
  location?: string
  uniform?: string
  course?: string
  /** Populated only for `assignment_due`: the deadline this marker represents. */
  dueAt?: WeekMinute
  /** Class years / companies this applies to. Absent means everyone. */
  appliesTo?: { classYears?: string[]; companies?: string[] }
  notes?: string
  /** Never destroy the raw. Kept so a parser fix can be replayed. */
  raw?: Record<string, string>
}

export interface Task {
  id: string
  title: string
  course?: string
  /** Week-minute of the deadline. May exceed the week (work ahead). */
  dueAt: WeekMinute | null
  estimateMinutes: number
  estimateSource: 'ai' | 'user' | 'default'
  /** Decomposition. Empty means treat as one indivisible chunk. */
  chunks: Array<{ label: string; minutes: number }>
  status: 'todo' | 'doing' | 'done'
  /** User-declared importance, folded into criticality. */
  weight: number
  canvasUid?: string
}

export interface Preferences {
  timeZone: string
  wake: number
  sleep: number
  meals: Array<{ label: string; start: number; end: number }>
  minBlockMinutes: number
  maxBlockMinutes: number
  maxStudyMinutesPerDay: number
  /** Transit padding around hard events — barracks to academic building. */
  bufferMinutes: number
  /** Finish work this many hours before it is due. */
  minLeadHours: number
  /** User-declared no-touch windows, as daily recurring clock windows. */
  protectedWindows: Array<{ label: string; days: number[]; start: number; end: number }>
  /** Bias placement earlier (0) or later (1) in the day. 0.5 is neutral. */
  dayPhaseBias: number
}

export interface Profile {
  name: string
  classYear: string
  company: string
}

/** A block on the finished plan. */
export interface PlanBlock {
  id: string
  span: Span
  title: string
  kind: Kind
  /** Set for blocks derived from an event. */
  eventId?: string
  /** Set for blocks the solver generated for a task chunk. */
  taskId?: string
  chunkLabel?: string
  locked: boolean
  course?: string
  location?: string
  uniform?: string
  /** Why the solver put this here. Empty for hard blocks — they had no choice. */
  because?: string[]
}

export interface Conflict {
  a: { id: string; title: string; kind: Kind }
  b: { id: string; title: string; kind: Kind }
  span: Span
  minutes: number
  severity: 'blocking' | 'overlap'
  note: string
}

export interface Unplaced {
  taskId: string
  title: string
  chunkLabel: string
  minutes: number
  /** The single binding constraint, named. Not "didn't fit". */
  reason: UnplacedReason
  detail: string
  /** How much more free time would have been needed. */
  minutesShort: number
}

export type UnplacedReason =
  | 'no_window_before_due'
  | 'daily_cap_reached'
  | 'no_window_long_enough'
  | 'week_exhausted'
  | 'due_before_week'

export interface Capacity {
  freeMinutes: number
  demandMinutes: number
  placedMinutes: number
  unplacedMinutes: number
  /** Free minutes that remained unused after placement. */
  slackMinutes: number
  byDay: Array<{ day: number; freeMinutes: number; studyMinutes: number; hardMinutes: number }>
}

export interface Plan {
  weekStart: LocalDate
  engineVersion: string
  /** Hash of every input that contributed. Same fingerprint ⇒ same plan. */
  inputsFingerprint: string
  blocks: PlanBlock[]
  conflicts: Conflict[]
  unplaced: Unplaced[]
  capacity: Capacity
  /** Free windows left over, for the UI to paint as available. */
  openWindows: Span[]
  /** Plain-language read on the week. Deterministic; not AI-written. */
  narrative: string[]
}

export interface PlannerState {
  profile: Profile
  preferences: Preferences
  events: WeekEvent[]
  tasks: Task[]
  /** Locked blocks survive regeneration, keyed by a stable signature. */
  lockedSignatures: string[]
}
