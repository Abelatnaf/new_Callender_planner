/**
 * Time parsing, tolerant by design.
 *
 * Every pattern here corresponds to a real way a schedule gets typed or pasted.
 * The parser accepts all of them and reports what it did rather than guessing
 * silently, because a misread time is worse than a rejected file.
 */

export interface TimeRange {
  start: number
  end: number
  /** True when the range wrapped past midnight (`2300-0100`). */
  crossesMidnight: boolean
}

const MERIDIEM = /\b([ap])\.?m\.?\b/i

/**
 * Parse a single clock reading to minutes past midnight.
 *
 * Accepts `0700`, `07:00`, `7:00`, `7`, `7:00 PM`, `7 pm`, `0700hrs`, `2400`.
 * Returns `null` on anything else — callers decide whether that is fatal.
 */
export function parseClock(input: string): number | null {
  const raw = input.trim().toLowerCase().replace(/h(ou)?rs?\.?$/, '').replace(/\./g, ':').trim()
  if (raw === '') return null

  const meridiem = MERIDIEM.exec(raw)
  const body = raw.replace(MERIDIEM, '').replace(/\s+/g, '')

  let hours: number
  let minutes: number

  if (/^\d{3,4}$/.test(body)) {
    // Military: 700, 0700, 1430, 2400
    const padded = body.padStart(4, '0')
    hours = Number(padded.slice(0, 2))
    minutes = Number(padded.slice(2))
  } else if (/^\d{1,2}:\d{2}$/.test(body)) {
    const [h, m] = body.split(':')
    hours = Number(h)
    minutes = Number(m)
  } else if (/^\d{1,2}$/.test(body)) {
    hours = Number(body)
    minutes = 0
  } else {
    return null
  }

  if (meridiem) {
    const isPm = meridiem[1]?.toLowerCase() === 'p'
    if (hours === 12) hours = isPm ? 12 : 0
    else if (isPm) hours += 12
  }

  // `2400` means end-of-day, which is minute 1440, not hour 24 of a real clock.
  if (hours === 24 && minutes === 0) return 1440
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

const RANGE_SPLIT = /\s*(?:-|–|—|to|until|thru|through|\/)\s*/i

/**
 * Parse a range like `0600-0630`, `06:00 - 06:30`, `6:00 AM to 6:30 AM`,
 * `2300-0100` (wraps), `1900-` (open-ended, caller supplies a default length).
 *
 * The `/` separator is ambiguous — it is also the uniform separator inside a
 * matrix cell — so it is only honoured when both sides parse as clock times.
 */
export function parseTimeRange(input: string, defaultMinutes = 60): TimeRange | null {
  const text = input.trim()
  if (text === '') return null

  const parts = text.split(RANGE_SPLIT).map((p) => p.trim()).filter((p) => p !== '')
  if (parts.length === 0) return null

  const first = parts[0]
  if (first === undefined) return null
  const start = parseClock(first)
  if (start === null) return null

  if (parts.length === 1) {
    return { start, end: Math.min(start + defaultMinutes, 1440), crossesMidnight: false }
  }

  const second = parts[1]
  if (second === undefined) return null
  let end = parseClock(second)
  if (end === null) return { start, end: Math.min(start + defaultMinutes, 1440), crossesMidnight: false }

  // A bare `0630` after a `6:00 PM` inherits the meridiem of the start.
  if (MERIDIEM.test(first) && !MERIDIEM.test(second) && end < start) {
    const bumped = end + 720
    if (bumped <= 1440) end = bumped
  }

  if (end === start) end = Math.min(start + defaultMinutes, 1440)

  if (end < start) {
    // Wraps midnight: taps 2300-0100. Represent as an end beyond 1440 so the
    // caller can decide whether to split it across the day boundary.
    return { start, end: end + 1440, crossesMidnight: true }
  }
  return { start, end, crossesMidnight: false }
}

/** Does this cell look like a time range at all? Used by shape detection. */
export function looksLikeTimeRange(input: string): boolean {
  const r = parseTimeRange(input)
  return r !== null && RANGE_SPLIT.test(input)
}

const WEEKDAY_TOKENS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(mon|monday|m|mo)$/i, 0],
  [/^(tue|tues|tuesday|t|tu)$/i, 1],
  [/^(wed|weds|wednesday|w|we)$/i, 2],
  [/^(thu|thur|thurs|thursday|r|th)$/i, 3],
  [/^(fri|friday|f|fr)$/i, 4],
  [/^(sat|saturday|s|sa)$/i, 5],
  [/^(sun|sunday|u|su)$/i, 6],
]

/** Day index for a header token, or `null`. 0 = Monday. */
export function parseWeekday(token: string): number | null {
  const clean = token.trim().replace(/[^a-z]/gi, '')
  for (const [pattern, index] of WEEKDAY_TOKENS) {
    if (pattern.test(clean)) return index
  }
  return null
}

/**
 * Expand a compact day code like `MWF`, `TR`, `MO,WE,FR`, `M/W/F`.
 *
 * Single-letter codes are ambiguous (`T` = Tuesday or Thursday, `S` = Saturday
 * or Sunday) so the registrar convention is used: T = Tuesday, R = Thursday,
 * S = Saturday, U = Sunday.
 */
export function parseDayCodes(input: string): number[] {
  const text = input.trim()
  if (text === '') return []

  // Delimited form first — unambiguous.
  if (/[,;/|\s]/.test(text)) {
    const days = text
      .split(/[,;/|\s]+/)
      .map((t) => parseWeekday(t))
      .filter((d): d is number => d !== null)
    if (days.length > 0) return dedupeSorted(days)
  }

  const single = parseWeekday(text)
  if (single !== null && text.length > 2) return [single]

  // Compact registrar form: MWF, TR, MTWRF
  const map: Record<string, number> = { m: 0, t: 1, w: 2, r: 3, f: 4, s: 5, u: 6 }
  const letters = text.toLowerCase().replace(/[^mtwrfsu]/g, '')
  if (letters.length > 0 && letters.length === text.replace(/[^a-z]/gi, '').length) {
    const days = [...letters].map((ch) => map[ch]).filter((d): d is number => d !== undefined)
    if (days.length > 0) return dedupeSorted(days)
  }

  return single !== null ? [single] : []
}

function dedupeSorted(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b)
}
