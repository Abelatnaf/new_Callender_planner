/**
 * Time model
 * ==========
 * Everything inside the engine is an integer: minutes from the start of the
 * planning week, in LOCAL WALL-CLOCK time. `0` is Monday 00:00, `10080` is the
 * following Monday 00:00.
 *
 * Why wall-clock integers and not `timestamptz`:
 *
 * The Institute schedules in wall clock. A 0700 formation is at 0700 on the
 * Sunday the clocks change, and on every other day of the year. If you model
 * the week as absolute instants you have to re-derive that invariant on every
 * read, and a 23- or 25-hour day silently shifts every block after 02:00.
 * Modelling the week as wall-clock minutes makes the invariant structural: DST
 * cannot move a formation because a formation is not stored as an instant.
 *
 * Absolute instants do exist at exactly one boundary — Canvas hands us UTC
 * timestamps — so `instantToWeekMinutes` converts once, at ingest, using the
 * IANA database via `Intl`. After that boundary there are no naive datetimes
 * because there are no datetimes.
 */

export const MINUTES_PER_DAY = 1440
export const DAYS_PER_WEEK = 7
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * DAYS_PER_WEEK

/** Minutes from the start of the planning week. */
export type WeekMinute = number

/** A half-open interval `[start, end)` in week-minutes. */
export interface Span {
  start: WeekMinute
  end: WeekMinute
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export const DAY_ABBR = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

export function span(start: WeekMinute, end: WeekMinute): Span {
  return { start, end }
}

export function spanLength(s: Span): number {
  return Math.max(0, s.end - s.start)
}

export function isEmpty(s: Span): boolean {
  return s.end <= s.start
}

/** Day index (0 = Monday) containing this minute. Clamped to the week. */
export function dayOf(m: WeekMinute): DayIndex {
  const d = Math.floor(m / MINUTES_PER_DAY)
  return Math.min(6, Math.max(0, d)) as DayIndex
}

/** Minutes past local midnight. */
export function timeOfDay(m: WeekMinute): number {
  return ((m % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

export function atDay(day: number, minutesPastMidnight: number): WeekMinute {
  return day * MINUTES_PER_DAY + minutesPastMidnight
}

/** `0700` / `07:00` style label. Always zero-padded so it sets in tabular figures. */
export function formatClock(m: WeekMinute, opts: { colon?: boolean } = {}): string {
  const t = timeOfDay(m)
  const h = Math.floor(t / 60)
  const min = t % 60
  const hh = String(h).padStart(2, '0')
  const mm = String(min).padStart(2, '0')
  return opts.colon === false ? `${hh}${mm}` : `${hh}:${mm}`
}

/** `1h 45m`, `45m`, `2h`. For durations, never for clock times. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h === 0) return `${rem}m`
  if (rem === 0) return `${h}h`
  return `${h}h ${rem}m`
}

/** Decimal hours, one place — for capacity prose ("14.5 hours of work"). */
export function formatHours(minutes: number): string {
  return (Math.round((minutes / 60) * 10) / 10).toFixed(1)
}

// ---------------------------------------------------------------------------
// Interval algebra. All functions are pure, total, and return normalized
// output: sorted, non-overlapping, non-empty, non-adjacent-touching.
// ---------------------------------------------------------------------------

/** Sort, drop empties, merge overlapping and touching spans. */
export function normalize(spans: readonly Span[]): Span[] {
  const live = spans.filter((s) => !isEmpty(s)).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Span[] = []
  for (const s of live) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end
    } else {
      out.push({ start: s.start, end: s.end })
    }
  }
  return out
}

/** Union of two span sets. */
export function union(a: readonly Span[], b: readonly Span[]): Span[] {
  return normalize([...a, ...b])
}

/** `a` minus `b` — the core of free-window computation. */
export function subtract(a: readonly Span[], b: readonly Span[]): Span[] {
  const cuts = normalize(b)
  const out: Span[] = []
  for (const base of normalize(a)) {
    let cursor = base.start
    for (const cut of cuts) {
      if (cut.end <= cursor) continue
      if (cut.start >= base.end) break
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, base.end) })
      cursor = Math.max(cursor, cut.end)
      if (cursor >= base.end) break
    }
    if (cursor < base.end) out.push({ start: cursor, end: base.end })
  }
  return out.filter((s) => !isEmpty(s))
}

/** Intersection of two span sets. */
export function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = []
  for (const x of normalize(a)) {
    for (const y of normalize(b)) {
      const start = Math.max(x.start, y.start)
      const end = Math.min(x.end, y.end)
      if (end > start) out.push({ start, end })
    }
  }
  return normalize(out)
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end
}

export function overlapMinutes(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

export function totalMinutes(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + spanLength(s), 0)
}

/** Clip a set to the planning week. Cross-midnight tails on Sunday are dropped. */
export function clipToWeek(spans: readonly Span[]): Span[] {
  return intersect(spans, [{ start: 0, end: MINUTES_PER_WEEK }])
}

/**
 * Repeat a daily window (e.g. sleep 23:00–06:00) across every day of the week.
 * Handles windows that cross midnight by emitting the wrap as a second span,
 * which is why sleep is expressed as two spans per day and not one.
 */
export function dailyWindow(startMin: number, endMin: number): Span[] {
  const out: Span[] = []
  for (let d = 0; d < DAYS_PER_WEEK; d++) {
    if (endMin > startMin) {
      out.push({ start: atDay(d, startMin), end: atDay(d, endMin) })
    } else {
      // crosses midnight: tail of this day + head of the next
      out.push({ start: atDay(d, startMin), end: atDay(d + 1, 0) })
      out.push({ start: atDay(d, 0), end: atDay(d, endMin) })
    }
  }
  return clipToWeek(normalize(out))
}

// ---------------------------------------------------------------------------
// The one boundary where absolute time exists.
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`. */
export type LocalDate = string

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseLocalDate(d: LocalDate): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(d)
  if (!match) throw new Error(`Not an ISO date: ${d}`)
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

/** Days between two ISO dates, using UTC arithmetic so DST cannot perturb the count. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from)
  const b = parseLocalDate(to)
  const ms = Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)
  return Math.round(ms / 86_400_000)
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { y, m, d } = parseLocalDate(date)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** ISO weekday, 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const { y, m, d } = parseLocalDate(date)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return day === 0 ? 7 : day
}

/** The Monday of the week containing `date`. */
export function weekStartOf(date: LocalDate): LocalDate {
  return addDays(date, -(isoWeekday(date) - 1))
}

/** ISO week label, e.g. `2026-W38`. */
export function isoWeekLabel(weekStart: LocalDate): string {
  const { y, m, d } = parseLocalDate(weekStart)
  const thursday = new Date(Date.UTC(y, m - 1, d + 3))
  const year = thursday.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const week = Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * Convert an absolute instant to week-minutes in a named zone.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` consults the IANA database,
 * so this is correct across DST transitions without shipping a tz library.
 * Returns `null` when the instant falls outside the planning week.
 */
export function instantToWeekMinutes(
  instant: Date,
  weekStart: LocalDate,
  timeZone: string,
): WeekMinute | null {
  const wall = wallClockInZone(instant, timeZone)
  const dayOffset = daysBetween(weekStart, wall.date)
  if (dayOffset < 0 || dayOffset >= DAYS_PER_WEEK) return null
  return atDay(dayOffset, wall.minutes)
}

/** The wall-clock reading of an instant in a named zone. */
export function wallClockInZone(instant: Date, timeZone: string): { date: LocalDate; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`Missing ${type} while formatting in ${timeZone}`)
    return found.value
  }

  // `hour12: false` can render midnight as "24" in some ICU versions.
  const hour = Number(get('hour')) % 24
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  }
}
