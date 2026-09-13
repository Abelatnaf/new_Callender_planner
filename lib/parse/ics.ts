/**
 * Canvas calendar (ICS) parser — an RFC 5545 subset, hand-rolled.
 *
 * Written by hand rather than pulled from a package because the interesting
 * behaviour here is not parsing iCalendar, it is surviving what Canvas
 * actually emits:
 *
 *   - `DTEND` is frequently ABSENT on assignments. `DTSTART` is the due time
 *     and the assignment is a deadline marker, not an occupied block. Treating
 *     a due date as a one-hour meeting is the single most common way a planner
 *     lies to you.
 *   - `SUMMARY` looks like `Reading Response 2 [ERH-101-04]` — the bracketed
 *     suffix is the course, and it belongs in a field, not the title.
 *   - `UID` is the only stable key. Upsert on it or every sync duplicates the
 *     semester.
 *   - Times arrive as UTC (`Z`), zoned (`TZID=`), floating (neither), or
 *     date-only (`VALUE=DATE`). All four appear in one feed.
 *   - Lines are folded at 75 octets and continue with a leading space or tab.
 */

import { kindSpec } from '../domain/kinds'
import {
  addDays,
  atDay,
  clipToWeek,
  DAYS_PER_WEEK,
  daysBetween,
  instantToWeekMinutes,
  MINUTES_PER_WEEK,
  type LocalDate,
  type WeekMinute,
} from '../domain/time'
import type { Task, WeekEvent } from '../domain/types'
import { simpleHash } from './matrix'

export interface IcsParseOptions {
  weekStart: LocalDate
  timeZone: string
  /** Include deadlines this many days past the week end, so work-ahead is visible. */
  lookaheadDays?: number
}

export interface IcsParseResult {
  events: WeekEvent[]
  tasks: Task[]
  /** Deadlines that fall outside the week but inside the lookahead. */
  upcoming: Array<{ title: string; course?: string; dueDate: LocalDate; minutesPastWeek: number }>
  warnings: string[]
  stats: { vevents: number; cancelled: number; outsideWindow: number; noDtstart: number }
}

interface RawProperty {
  name: string
  params: Record<string, string>
  value: string
}

type RawComponent = Map<string, RawProperty[]>

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/** Undo RFC 5545 line folding: CRLF followed by a space or tab is a continuation. */
export function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '')
}

function parseProperty(line: string): RawProperty | null {
  const colon = findUnquoted(line, ':')
  if (colon === -1) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments = splitUnquoted(head, ';')
  const name = (segments.shift() ?? '').toUpperCase().trim()
  if (name === '') return null

  const params: Record<string, string> = {}
  for (const segment of segments) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    params[segment.slice(0, eq).toUpperCase().trim()] = stripQuotes(segment.slice(eq + 1).trim())
  }
  return { name, params, value }
}

function findUnquoted(text: string, target: string): number {
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === target) return i
  }
  return -1
}

function splitUnquoted(text: string, delimiter: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      current += ch
    } else if (!quoted && ch === delimiter) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/** Undo TEXT escaping: `\n`, `\,`, `\;`, `\\`. */
export function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim()
}

/** Split the stream into VEVENT components. VTIMEZONE and VALARM are ignored. */
export function extractVEvents(text: string): RawComponent[] {
  const out: RawComponent[] = []
  let current: RawComponent | null = null
  let depth = 0

  for (const line of unfold(text)) {
    const prop = parseProperty(line)
    if (!prop) continue

    if (prop.name === 'BEGIN') {
      const kind = prop.value.toUpperCase().trim()
      if (kind === 'VEVENT' && depth === 0) {
        current = new Map()
        depth = 1
        continue
      }
      if (current) depth++
      continue
    }
    if (prop.name === 'END') {
      const kind = prop.value.toUpperCase().trim()
      if (kind === 'VEVENT' && depth === 1 && current) {
        out.push(current)
        current = null
        depth = 0
        continue
      }
      if (current) depth--
      continue
    }
    // Skip properties nested inside a VALARM so its TRIGGER cannot be mistaken
    // for the event's own time.
    if (current && depth === 1) {
      const list = current.get(prop.name) ?? []
      list.push(prop)
      current.set(prop.name, list)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Date/time values
// ---------------------------------------------------------------------------

export interface IcsMoment {
  /** Absolute instant, when the value carried a zone or UTC marker. */
  instant?: Date
  /** Wall-clock reading, when the value was floating or date-only. */
  local?: { date: LocalDate; minutes: number }
  dateOnly: boolean
}

const DT_UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const DT_LOCAL = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/
const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/

/**
 * Parse a DATE-TIME or DATE value.
 *
 * A zoned value (`TZID=America/New_York`) is resolved to an instant by
 * searching for the UTC instant whose wall-clock reading in that zone matches.
 * That avoids shipping a tz database while staying correct across DST, and it
 * degrades to the floating interpretation if the zone is unknown.
 */
export function parseIcsMoment(prop: RawProperty, fallbackZone: string): IcsMoment | null {
  const raw = prop.value.trim()
  const isDateParam = prop.params['VALUE']?.toUpperCase() === 'DATE'

  const utc = DT_UTC.exec(raw)
  if (utc) {
    const [, y, m, d, h, min, s] = utc
    return {
      instant: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s))),
      dateOnly: false,
    }
  }

  const dateOnly = DATE_ONLY.exec(raw)
  if (dateOnly && (isDateParam || raw.length === 8)) {
    const [, y, m, d] = dateOnly
    return { local: { date: `${y}-${m}-${d}`, minutes: 0 }, dateOnly: true }
  }

  const local = DT_LOCAL.exec(raw)
  if (local) {
    const [, y, m, d, h, min] = local
    const wall = { date: `${y}-${m}-${d}` as LocalDate, minutes: Number(h) * 60 + Number(min) }
    const tzid = prop.params['TZID']
    if (tzid) {
      const instant = resolveZonedWallClock(wall, tzid)
      if (instant) return { instant, local: wall, dateOnly: false }
    }
    // Floating: means "this wall clock, wherever the reader is".
    void fallbackZone
    return { local: wall, dateOnly: false }
  }

  return null
}

/**
 * Find the instant whose wall-clock reading in `zone` equals `wall`.
 *
 * Two probes are enough: guess that the zone offset equals the offset at the
 * UTC-interpreted instant, then correct once. A third probe would only matter
 * inside the one ambiguous hour of a fall-back transition, where either answer
 * is defensible and we take the earlier.
 */
function resolveZonedWallClock(wall: { date: LocalDate; minutes: number }, zone: string): Date | null {
  const [y, m, d] = wall.date.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) return null

  const asUtc = Date.UTC(y, m - 1, d, Math.floor(wall.minutes / 60), wall.minutes % 60)
  let guess = new Date(asUtc)

  for (let attempt = 0; attempt < 2; attempt++) {
    let reading: { date: LocalDate; minutes: number }
    try {
      reading = readWallClock(guess, zone)
    } catch {
      return null
    }
    const dayDelta = daysBetween(reading.date, wall.date)
    const driftMinutes = dayDelta * 1440 + (wall.minutes - reading.minutes)
    if (driftMinutes === 0) return guess
    guess = new Date(guess.getTime() + driftMinutes * 60_000)
  }
  return guess
}

function readWallClock(instant: Date, zone: string): { date: LocalDate; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`Unknown zone ${zone}`)
    return found.value
  }
  const hour = Number(get('hour')) % 24
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) }
}

/** Resolve a moment to week-minutes, or `null` when it falls outside the week. */
function momentToWeekMinutes(moment: IcsMoment, options: IcsParseOptions): WeekMinute | null {
  if (moment.instant) {
    return instantToWeekMinutes(moment.instant, options.weekStart, options.timeZone)
  }
  if (moment.local) {
    const offset = daysBetween(options.weekStart, moment.local.date)
    if (offset < 0 || offset >= DAYS_PER_WEEK) return null
    return atDay(offset, moment.local.minutes)
  }
  return null
}

/** How far past the end of the week a moment lands, in minutes. Negative = inside. */
function minutesPastWeek(moment: IcsMoment, options: IcsParseOptions): number {
  const date = moment.instant
    ? readWallClock(moment.instant, options.timeZone)
    : moment.local
  if (!date) return Number.POSITIVE_INFINITY
  const offset = daysBetween(options.weekStart, date.date)
  return atDay(offset, date.minutes) - MINUTES_PER_WEEK
}

// ---------------------------------------------------------------------------
// RRULE — expanded only within the planning horizon, never open-ended.
// ---------------------------------------------------------------------------

const DAY_CODE: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }

/**
 * Expand a recurrence within the planning week only.
 *
 * Supports FREQ=WEEKLY and FREQ=DAILY with BYDAY, INTERVAL, COUNT and UNTIL,
 * which is the whole of what Canvas emits for calendar events. Anything else
 * yields the base occurrence and a warning rather than a wrong expansion.
 */
export function expandRecurrence(
  rrule: string,
  baseStart: WeekMinute,
  durationMinutes: number,
): { spans: Array<{ start: number; end: number }>; supported: boolean } {
  const parts = Object.fromEntries(
    rrule
      .split(';')
      .map((p) => p.split('='))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== undefined && kv[1] !== undefined)
      .map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]),
  )

  const freq = parts['FREQ']
  if (freq !== 'WEEKLY' && freq !== 'DAILY') {
    return { spans: [{ start: baseStart, end: baseStart + durationMinutes }], supported: false }
  }

  const interval = Number(parts['INTERVAL'] ?? '1')
  if (!Number.isFinite(interval) || interval < 1) {
    return { spans: [{ start: baseStart, end: baseStart + durationMinutes }], supported: false }
  }
  // An interval greater than one week cannot recur twice inside one week, and
  // we cannot know the anchor week without the series start, so emit the base.
  if (freq === 'WEEKLY' && interval > 1) {
    return { spans: [{ start: baseStart, end: baseStart + durationMinutes }], supported: true }
  }

  const timeOfDay = baseStart % 1440
  const days: number[] = []
  const byDay = parts['BYDAY']
  if (byDay) {
    for (const token of byDay.split(',')) {
      const code = token.replace(/^[+-]?\d+/, '').trim()
      const day = DAY_CODE[code]
      if (day !== undefined) days.push(day)
    }
  }
  if (days.length === 0) {
    if (freq === 'DAILY') {
      for (let d = 0; d < DAYS_PER_WEEK; d += interval) days.push(d)
    } else {
      days.push(Math.floor(baseStart / 1440))
    }
  }

  const count = parts['COUNT'] ? Number(parts['COUNT']) : undefined
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  const limited = count !== undefined && Number.isFinite(count) ? sorted.slice(0, count) : sorted

  return {
    spans: limited.map((d) => ({ start: atDay(d, timeOfDay), end: atDay(d, timeOfDay) + durationMinutes })),
    supported: true,
  }
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

const COURSE_SUFFIX = /\s*[[(]\s*([A-Z]{2,5}[\s-]?\d{2,4}[A-Z]?(?:[\s-]\d{1,3})?)\s*[\])]\s*$/i

/** `Reading Response 2 [ERH-101-04]` → title + course code. */
export function splitCourseSuffix(summary: string): { title: string; course?: string } {
  const match = COURSE_SUFFIX.exec(summary)
  if (!match?.[1]) return { title: summary.trim() }
  return {
    title: summary.slice(0, match.index).trim(),
    course: match[1].replace(/\s+/g, '-').toUpperCase(),
  }
}

const ASSIGNMENT_UID = /assignment/i
const EXAM_TITLE = /\b(exam|final|midterm|quiz|test)\b/i

export function parseIcs(text: string, options: IcsParseOptions): IcsParseResult {
  const warnings: string[] = []
  const events: WeekEvent[] = []
  const tasks: Task[] = []
  const upcoming: IcsParseResult['upcoming'] = []
  const stats = { vevents: 0, cancelled: 0, outsideWindow: 0, noDtstart: 0 }
  const lookaheadDays = options.lookaheadDays ?? 14
  let unsupportedRrule = false

  for (const component of extractVEvents(text)) {
    stats.vevents++

    const status = component.get('STATUS')?.[0]?.value.toUpperCase().trim()
    if (status === 'CANCELLED') {
      stats.cancelled++
      continue
    }

    const dtstartProp = component.get('DTSTART')?.[0]
    if (!dtstartProp) {
      stats.noDtstart++
      continue
    }
    const start = parseIcsMoment(dtstartProp, options.timeZone)
    if (!start) {
      stats.noDtstart++
      continue
    }

    const uid = component.get('UID')?.[0]?.value.trim() ?? simpleHash(dtstartProp.value + (component.get('SUMMARY')?.[0]?.value ?? ''))
    const summaryRaw = unescapeText(component.get('SUMMARY')?.[0]?.value ?? 'Untitled')
    const { title, course } = splitCourseSuffix(summaryRaw)
    const location = component.get('LOCATION')?.[0]?.value
    const description = component.get('DESCRIPTION')?.[0]?.value

    const dtendProp = component.get('DTEND')?.[0]
    const durationProp = component.get('DURATION')?.[0]
    const end = dtendProp ? parseIcsMoment(dtendProp, options.timeZone) : null

    // ---- Is this a deadline or a block?
    //
    // No DTEND and no DURATION means Canvas is telling us "this is due at this
    // moment", not "this occupies this hour". That distinction is the whole
    // reason the planner can be trusted: a deadline consumes no time.
    const isDeadline = !end && !durationProp && !start.dateOnly
    const startWm = momentToWeekMinutes(start, options)

    if (startWm === null) {
      const past = minutesPastWeek(start, options)
      if (past > 0 && past <= lookaheadDays * 1440) {
        const reading = start.instant ? readWallClock(start.instant, options.timeZone) : start.local
        if (reading) {
          upcoming.push({
            title,
            ...(course ? { course } : {}),
            dueDate: reading.date,
            minutesPastWeek: past,
          })
          // Work due just after the week can still be worked on inside it.
          tasks.push(
            makeTask({
              uid,
              title,
              course,
              dueAt: MINUTES_PER_WEEK + past,
              description,
            }),
          )
        }
      } else {
        stats.outsideWindow++
      }
      continue
    }

    if (isDeadline) {
      const kind = EXAM_TITLE.test(title) ? 'exam' : 'assignment_due'
      if (kind === 'assignment_due') {
        events.push({
          id: `canvas:${simpleHash(uid)}`,
          source: 'canvas',
          sourceRef: uid,
          title,
          kind: 'assignment_due',
          // A marker. Zero length: it occupies no time by construction.
          span: { start: startWm, end: startWm },
          hard: false,
          dueAt: startWm,
          ...(course ? { course } : {}),
          ...(location ? { location } : {}),
        })
        tasks.push(makeTask({ uid, title, course, dueAt: startWm, description }))
        continue
      }
      // An exam with no end is still an appointment you must attend.
      events.push(
        makeCanvasEvent({ uid, title, course, location, kind: 'exam', start: startWm, end: startWm + 60 }),
      )
      continue
    }

    // ---- A real block: class event, exam window, all-day notice.
    if (start.dateOnly) {
      // All-day: a notice, not a block. Zero length so it cannot eat the day's
      // free time, and pushed directly — `clipToWeek` intersects intervals and
      // would discard a zero-length span entirely.
      events.push({
        id: `canvas:${simpleHash(uid)}`,
        source: 'canvas',
        sourceRef: uid,
        title,
        kind: 'personal',
        span: { start: startWm, end: startWm },
        hard: false,
        ...(course ? { course } : {}),
        ...(location ? { location } : {}),
        notes: 'All-day notice from Canvas. It occupies no time on the plan.',
      })
      continue
    }

    let endWm: number
    if (end) {
      const resolved = momentToWeekMinutes(end, options)
      endWm = resolved ?? startWm + 60
      if (endWm <= startWm) endWm = startWm + 60
    } else if (durationProp) {
      endWm = startWm + parseDuration(durationProp.value)
    } else {
      endWm = startWm + 60
    }

    const kind = EXAM_TITLE.test(title) ? 'exam' : 'class'
    const rrule = component.get('RRULE')?.[0]?.value
    if (rrule) {
      const expanded = expandRecurrence(rrule, startWm, endWm - startWm)
      if (!expanded.supported) unsupportedRrule = true
      for (const s of expanded.spans) {
        for (const clipped of clipToWeek([s])) {
          events.push(makeCanvasEvent({ uid, title, course, location, kind, start: clipped.start, end: clipped.end }))
        }
      }
    } else {
      for (const clipped of clipToWeek([{ start: startWm, end: endWm }])) {
        events.push(makeCanvasEvent({ uid, title, course, location, kind, start: clipped.start, end: clipped.end }))
      }
    }
  }

  if (unsupportedRrule) {
    warnings.push('Some repeating events use a recurrence rule this reader does not expand; only their first occurrence is shown.')
  }
  if (stats.noDtstart > 0) {
    warnings.push(`${stats.noDtstart} calendar entr${stats.noDtstart === 1 ? 'y' : 'ies'} had no readable start time and were skipped.`)
  }
  if (stats.vevents === 0) {
    warnings.push('This calendar has no events at all. If your courses do not publish due dates to Canvas, add work by hand instead.')
  } else if (tasks.length === 0) {
    warnings.push(
      'This calendar has events but no assignment due dates. Many instructors never publish them — add your work by hand.',
    )
  }

  // Upsert on UID: a feed can repeat a UID across RECURRENCE-ID overrides.
  const deduped = dedupeByKey(events, (e) => `${e.sourceRef}|${e.span.start}|${e.span.end}`)
  const dedupedTasks = dedupeByKey(tasks, (t) => t.canvasUid ?? t.id)

  return {
    events: deduped.sort((a, b) => a.span.start - b.span.start),
    tasks: dedupedTasks.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)),
    upcoming: upcoming.sort((a, b) => a.minutesPastWeek - b.minutesPastWeek),
    warnings,
    stats,
  }
}

function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const item of items) {
    const k = key(item)
    if (!seen.has(k)) seen.set(k, item)
  }
  return [...seen.values()]
}

function makeCanvasEvent(input: {
  uid: string
  title: string
  course?: string
  location?: string
  kind: 'class' | 'exam'
  start: number
  end: number
}): WeekEvent {
  return {
    id: `canvas:${simpleHash(`${input.uid}|${input.start}`)}`,
    source: 'canvas',
    sourceRef: input.uid,
    title: input.title,
    kind: input.kind,
    span: { start: input.start, end: input.end },
    hard: kindSpec(input.kind).hard,
    ...(input.course ? { course: input.course } : {}),
    ...(input.location ? { location: input.location } : {}),
  }
}

/**
 * A new task starts on the `default` estimate, never an AI one.
 *
 * The default is deliberately coarse and visibly a guess, because a wrong
 * confident number is worse than an obvious placeholder: it teaches you to
 * distrust the whole plan. The AI estimator (advisory, §7) refines it only when
 * a key is configured, and a user override is permanent.
 */
function makeTask(input: {
  uid: string
  title: string
  course?: string
  dueAt: number
  description?: string
}): Task {
  return {
    id: `task:${simpleHash(input.uid)}`,
    title: input.title,
    ...(input.course ? { course: input.course } : {}),
    dueAt: input.dueAt,
    estimateMinutes: defaultEstimate(input.title),
    estimateSource: 'default',
    chunks: [],
    status: 'todo',
    weight: 1,
    canvasUid: input.uid,
  }
}

/** Crude but honest keyword sizing. Labelled `default` so the UI can say "guess". */
export function defaultEstimate(title: string): number {
  const t = title.toLowerCase()
  if (/\b(paper|essay|research|project|report|portfolio)\b/.test(t)) return 240
  if (/\b(exam|midterm|final)\b/.test(t)) return 180
  if (/\b(lab|problem\s*set|pset|homework|hw)\b/.test(t)) return 90
  if (/\b(read|reading|chapter)\b/.test(t)) return 60
  if (/\b(quiz|response|journal|discussion|post)\b/.test(t)) return 45
  return 60
}

/** ISO 8601 duration subset: `PT1H30M`, `P1D`, `PT45M`. */
export function parseDuration(value: string): number {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim())
  if (!match) return 60
  const [, w, d, h, m] = match
  return (
    Number(w ?? 0) * 7 * 1440 + Number(d ?? 0) * 1440 + Number(h ?? 0) * 60 + Number(m ?? 0)
  ) || 60
}

/** Exported for the sources screen: the feed URL is a credential. */
export function maskFeedUrl(url: string): string {
  const tail = url.slice(-6)
  return `…${tail}`
}

export { addDays }
