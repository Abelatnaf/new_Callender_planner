/**
 * The cadetship matrix parser.
 *
 * This is the riskiest component in the whole app, for the reason the build
 * plan named: a matrix is called a matrix because it usually *is* one — a grid
 * meant for human eyes, not a tidy table meant for a program.
 *
 * Three shapes are supported and detected automatically:
 *
 *   Shape A (wide/grid)      rows are time periods, columns are days
 *   Shape B (long/tidy)      one row per event, one column names the day
 *   Shape C (daily sections) one repeated block per day: an announcement row
 *                            ("Monday, September 14, 2026"), a local header,
 *                            then that day's events, then a blank separator —
 *                            repeated once per day, seven times, with no
 *                            single "day" column anywhere in the file. This is
 *                            what a real published Corps master schedule
 *                            turned out to actually look like: the two-shape
 *                            model built against synthetic fixtures had never
 *                            seen it, and returned zero events on first
 *                            contact with a real file.
 *
 * Design rule that everything else follows from: never destroy the raw. Every
 * emitted event keeps the cells it came from, so a parser fix can be replayed
 * against the original upload instead of asking for it again.
 */

import { classifyActivity, isKind, kindSpec, type Kind } from '../domain/kinds'
import { atDay, clipToWeek, DAYS_PER_WEEK, MINUTES_PER_DAY, type Span } from '../domain/time'
import type { WeekEvent } from '../domain/types'
import { normalizeHeader, parseCsv, type CsvTable } from './csv'
import { parseDayCodes, parseTimeRange, parseWeekday } from './timeRange'

export type MatrixShape = 'wide' | 'long' | 'sectioned' | 'unknown'

/** Canonical fields a Shape B column can be mapped onto. */
export const LONG_FIELDS = [
  'day',
  'start',
  'end',
  'time_range',
  'activity',
  'location',
  'uniform',
  'applies_to',
  'kind',
  'notes',
  'ignore',
] as const
export type LongField = (typeof LONG_FIELDS)[number]

export interface MatrixDetection {
  shape: MatrixShape
  table: CsvTable
  /** For Shape A: which column index holds the time, and which columns are days. */
  wide?: { timeColumn: number; dayColumns: Array<{ index: number; day: number }> }
  /** For Shape B: the mapping we propose. Always shown for confirmation. */
  suggestedMapping?: Record<string, LongField>
  /** Hash of the normalized header set — the key for remembering a mapping. */
  headerFingerprint: string
  sampleRows: string[][]
  warnings: string[]
}

export interface MatrixParseResult {
  events: WeekEvent[]
  warnings: string[]
  /** Cells that looked like content but could not be understood. */
  rejected: Array<{ row: number; column: number; value: string; why: string }>
}

export interface MatrixParseOptions {
  /** Which class year the cadet is, for the applicability filter. */
  classYear?: string
  company?: string
  /** Shape B only. Confirmed mapping from header name to canonical field. */
  mapping?: Record<string, LongField>
  /** Default block length when a cell gives a start but no end. */
  defaultMinutes?: number
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const TIME_HEADER = /^(time|period|hour|hours|block|slot|when)$/i

export function detectMatrix(input: string, forcedDelimiter?: string): MatrixDetection {
  const table = parseCsv(input, forcedDelimiter)
  const warnings = [...table.warnings]
  const headerFingerprint = fingerprintHeader(table.header)

  const dayColumns: Array<{ index: number; day: number }> = []
  table.header.forEach((h, index) => {
    const day = parseWeekday(h)
    if (day !== null) dayColumns.push({ index, day })
  })

  // Three or more weekday columns is a grid. Two could be a tidy table with a
  // "Monday" value in a Day column, so the threshold stays at three.
  if (dayColumns.length >= 3) {
    let timeColumn = table.header.findIndex((h) => TIME_HEADER.test(h.trim()))
    if (timeColumn === -1) {
      // The time column is whichever non-day column has the most time ranges.
      let bestScore = 0
      table.header.forEach((_, index) => {
        if (dayColumns.some((d) => d.index === index)) return
        const score = table.rows.filter((r) => parseTimeRange(r[index] ?? '') !== null).length
        if (score > bestScore) {
          bestScore = score
          timeColumn = index
        }
      })
    }
    if (timeColumn === -1) {
      warnings.push('Found day columns but no column of times. Every row will need a time.')
      timeColumn = 0
    }
    if (dayColumns.length < DAYS_PER_WEEK) {
      const missing = [...Array(DAYS_PER_WEEK).keys()].filter((d) => !dayColumns.some((c) => c.day === d))
      warnings.push(
        `Only ${dayColumns.length} of 7 days have a column. Missing: ${missing
          .map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d])
          .join(', ')}. Those days will come through empty — if the Corps schedules on them, the source file is incomplete.`,
      )
    }
    return {
      shape: 'wide',
      table,
      wide: { timeColumn, dayColumns },
      headerFingerprint,
      sampleRows: table.rows.slice(0, 5),
      warnings,
    }
  }

  const suggestedMapping = suggestLongMapping(table.header)
  const mapped = new Set(Object.values(suggestedMapping))
  const hasDay = mapped.has('day')
  const hasTime = mapped.has('start') || mapped.has('time_range')
  const hasActivity = mapped.has('activity')

  if (hasDay && hasTime && hasActivity) {
    return { shape: 'long', table, suggestedMapping, headerFingerprint, sampleRows: table.rows.slice(0, 5), warnings }
  }

  // Shape C: no "day" column exists anywhere, because the day is announced
  // once per block ("Monday, September 14, 2026") rather than repeated on
  // every row. Detected by counting how many rows open with a weekday name —
  // three or more, and a local header naming Time/Event nearby, is this shape
  // rather than an ordinary file that happens to mention a weekday in prose.
  const sectionHeader = findFirstSectionHeader(table.rows)
  if (sectionHeader && countDayAnnouncements(table.rows) >= 3) {
    return {
      shape: 'sectioned',
      table,
      suggestedMapping: suggestLongMapping(sectionHeader),
      headerFingerprint,
      sampleRows: table.rows.slice(0, 5),
      warnings,
    }
  }

  warnings.push(
    'Could not tell whether this is a grid or a row-per-event table. Confirm the column mapping by hand.',
  )
  return { shape: 'unknown', table, suggestedMapping, headerFingerprint, sampleRows: table.rows.slice(0, 5), warnings }
}

/**
 * The weekday a day-announcement cell opens with — "Monday, September 14,
 * 2026" — or `null`. Checked against the leading run of letters only, since
 * `parseWeekday` expects a clean token and the rest of the cell is prose.
 * Column 0 in a data row is always a clock time, which this never matches, so
 * the two row kinds cannot be confused for one another.
 */
export function dayAnnouncementIndex(cell: string): number | null {
  const leading = /^[A-Za-z]+/.exec(cell.trim())?.[0]
  return leading ? parseWeekday(leading) : null
}

function countDayAnnouncements(rows: readonly string[][]): number {
  let count = 0
  for (const row of rows) {
    if (dayAnnouncementIndex(row[0] ?? '') !== null) count++
  }
  return count
}

/**
 * The first row that reads as a local section header: not a day-announcement
 * itself, and its own header-guessing turns up both an activity column and a
 * time column. That is enough to distinguish "Time, PAX, Event, Location,
 * Uniform, Instructor" from an ordinary data or blank row without requiring
 * an exact header match, since nothing here promises the header is spelled
 * the same way from one school's export to another's.
 */
function findFirstSectionHeader(rows: readonly string[][]): string[] | null {
  for (const row of rows) {
    if (dayAnnouncementIndex(row[0] ?? '') !== null) continue
    if (isSectionHeaderRow(row)) return row
  }
  return null
}

function isSectionHeaderRow(row: readonly string[]): boolean {
  const mapped = new Set(Object.values(suggestLongMapping(row)))
  return mapped.has('activity') && (mapped.has('time_range') || mapped.has('start'))
}

/** Stable hash of the normalized, sorted header set. */
export function fingerprintHeader(header: readonly string[]): string {
  const normalized = header.map(normalizeHeader).filter((h) => h !== '').sort()
  return simpleHash(normalized.join('|'))
}

const FIELD_HINTS: ReadonlyArray<readonly [RegExp, LongField]> = [
  [/^(day|days|weekday|dow|day_of_week)$/, 'day'],
  [/^(start|start_time|from|begin|begins|begin_time)$/, 'start'],
  [/^(end|end_time|to|finish|until|stop)$/, 'end'],
  [/^(time|time_range|period|hours|when|block|slot)$/, 'time_range'],
  [/^(activity|event|title|description|detail|details|task|duty|name|subject)$/, 'activity'],
  [/^(location|place|where|room|venue|building)$/, 'location'],
  [/^(uniform|dress|uotd|uniform_of_the_day|attire)$/, 'uniform'],
  // "PAX" is military-standard shorthand for "personnel" — precisely the
  // who-does-this-apply-to column a real published schedule actually uses.
  [/^(applies_to|who|audience|class|classes|applicability|for|company|companies|pax|attendees)$/, 'applies_to'],
  [/^(kind|type|category|class_type)$/, 'kind'],
  // "Instructor" (who runs the event) has no dedicated field of its own; it
  // rides along as a note, the same way the course-schedule parser folds an
  // instructor name into `notes` rather than inventing a field for it.
  [/^(notes|note|remarks|comment|comments|instructor|responsible|poc|point_of_contact)$/, 'notes'],
]

export function suggestLongMapping(header: readonly string[]): Record<string, LongField> {
  const out: Record<string, LongField> = {}
  header.forEach((h) => {
    const key = normalizeHeader(h)
    const hit = FIELD_HINTS.find(([pattern]) => pattern.test(key))
    out[h] = hit ? hit[1] : 'ignore'
  })
  return out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseMatrix(detection: MatrixDetection, options: MatrixParseOptions = {}): MatrixParseResult {
  if (detection.shape === 'wide' && detection.wide) return parseWide(detection, options)
  if (detection.shape === 'sectioned') return parseSectioned(detection, options)
  return parseLong(detection, options)
}

/** Shape A: melt the day columns into one row per cell. */
function parseWide(detection: MatrixDetection, options: MatrixParseOptions): MatrixParseResult {
  const wide = detection.wide
  if (!wide) throw new Error('parseWide called without wide detection')

  const events: WeekEvent[] = []
  const warnings: string[] = []
  const rejected: MatrixParseResult['rejected'] = []
  const defaultMinutes = options.defaultMinutes ?? 30

  // Merged time cells export as blanks: carry the last seen range downward.
  let carried: { start: number; end: number } | null = null
  let carriedFromRow = -1

  detection.table.rows.forEach((row, rowIndex) => {
    const timeCell = (row[wide.timeColumn] ?? '').trim()
    let range = parseTimeRange(timeCell, defaultMinutes)

    if (range === null && timeCell === '' && carried && rowIndex === carriedFromRow + 1) {
      range = { ...carried, crossesMidnight: false }
      carriedFromRow = rowIndex
    } else if (range !== null) {
      carried = { start: range.start, end: range.end }
      carriedFromRow = rowIndex
    }

    if (range === null) {
      const hasContent = wide.dayColumns.some((d) => !isBlankCell(row[d.index] ?? ''))
      if (hasContent) {
        rejected.push({
          row: rowIndex,
          column: wide.timeColumn,
          value: timeCell,
          why: 'Row has activities but no readable time.',
        })
      }
      return
    }

    for (const dayCol of wide.dayColumns) {
      const cell = (row[dayCol.index] ?? '').trim()
      if (isBlankCell(cell)) continue

      for (const piece of splitStackedCell(cell)) {
        const parsed = parseCell(piece)
        if (parsed.title === '') continue

        // A cell may carry its own time, overriding the row's period.
        const cellRange = parsed.timeOverride ?? range
        const spans = spansFor(dayCol.day, cellRange.start, cellRange.end)
        if (spans.length === 0) continue

        for (const s of spans) {
          events.push(
            buildEvent({
              title: parsed.title,
              kind: parsed.kind ?? classifyActivity(parsed.title),
              span: s,
              uniform: parsed.uniform,
              location: parsed.location,
              appliesTo: parsed.appliesTo,
              notes: parsed.notesSink,
              raw: { row: String(rowIndex), time: timeCell, cell, day: String(dayCol.day) },
            }),
          )
        }
      }
    }
  })

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) had activities but no readable time and were skipped.`)
  }
  return finish(events, warnings, rejected, options)
}

/** Shape B: one row per event, driven by a confirmed column mapping. */
function parseLong(detection: MatrixDetection, options: MatrixParseOptions): MatrixParseResult {
  const mapping = options.mapping ?? detection.suggestedMapping ?? {}
  const events: WeekEvent[] = []
  const warnings: string[] = []
  const rejected: MatrixParseResult['rejected'] = []
  const defaultMinutes = options.defaultMinutes ?? 60

  const columnFor = (field: LongField): number =>
    detection.table.header.findIndex((h) => mapping[h] === field)

  const col = {
    day: columnFor('day'),
    start: columnFor('start'),
    end: columnFor('end'),
    timeRange: columnFor('time_range'),
    activity: columnFor('activity'),
    location: columnFor('location'),
    uniform: columnFor('uniform'),
    appliesTo: columnFor('applies_to'),
    kind: columnFor('kind'),
    notes: columnFor('notes'),
  }

  if (col.activity === -1) {
    warnings.push('No column is mapped to the activity name; nothing can be read from this file.')
    return { events: [], warnings, rejected }
  }
  if (col.day === -1) {
    warnings.push('No column is mapped to the day; nothing can be read from this file.')
    return { events: [], warnings, rejected }
  }

  detection.table.rows.forEach((row, rowIndex) => {
    const rawTitle = (row[col.activity] ?? '').trim()
    if (isBlankCell(rawTitle)) return

    const days = parseDayCodes(row[col.day] ?? '')
    if (days.length === 0) {
      rejected.push({ row: rowIndex, column: col.day, value: row[col.day] ?? '', why: 'Unreadable day.' })
      return
    }

    let start: number | null = null
    let end: number | null = null

    if (col.timeRange !== -1) {
      const r = parseTimeRange(row[col.timeRange] ?? '', defaultMinutes)
      if (r) {
        start = r.start
        end = r.end
      }
    }
    if (start === null && col.start !== -1) {
      const r = parseTimeRange(row[col.start] ?? '', defaultMinutes)
      if (r) {
        start = r.start
        end = r.end
      }
    }
    if (col.end !== -1) {
      const e = parseTimeRange(row[col.end] ?? '', 0)
      if (e && start !== null) {
        end = e.start <= start ? e.start + MINUTES_PER_DAY : e.start
      }
    }

    if (start === null || end === null) {
      rejected.push({ row: rowIndex, column: Math.max(col.start, col.timeRange), value: rawTitle, why: 'Unreadable time.' })
      return
    }

    const parsed = parseCell(rawTitle)
    const declaredKind = col.kind === -1 ? undefined : normalizeKind(row[col.kind] ?? '')
    const appliesToCell = col.appliesTo === -1 ? undefined : parseAppliesTo(row[col.appliesTo] ?? '')

    for (const day of days) {
      for (const s of spansFor(day, start, end)) {
        events.push(
          buildEvent({
            title: parsed.title || rawTitle,
            kind: declaredKind ?? parsed.kind ?? classifyActivity(parsed.title || rawTitle),
            span: s,
            uniform: parsed.uniform ?? cellOrUndefined(row[col.uniform] ?? ''),
            location: parsed.location ?? cellOrUndefined(row[col.location] ?? ''),
            appliesTo: appliesToCell ?? parsed.appliesTo,
            notes: joinNotes(cellOrUndefined(row[col.notes] ?? ''), parsed.notesSink),
            raw: { row: String(rowIndex), activity: rawTitle, day: String(day) },
          }),
        )
      }
    }
  })

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) could not be read and were skipped. They are listed so you can fix the source.`)
  }
  return finish(events, warnings, rejected, options)
}

/**
 * Shape C: repeated per-day blocks, with the day established once per block
 * rather than once per row.
 *
 * A single forward pass over the rows, carrying three pieces of state: which
 * day we are currently inside, and the column mapping for that section's
 * local header (rebuilt each time a header row is seen — in every real file
 * observed so far it repeats verbatim day to day, but nothing requires that).
 * Once both are known, a row is read exactly the way Shape B reads one row —
 * same time parsing, same applies_to/kind/location/uniform extraction — the
 * only structural difference is that a row here belongs to ONE day rather
 * than a set of days parsed from its own cell.
 */
function parseSectioned(detection: MatrixDetection, options: MatrixParseOptions): MatrixParseResult {
  const events: WeekEvent[] = []
  const warnings: string[] = []
  const rejected: MatrixParseResult['rejected'] = []
  const defaultMinutes = options.defaultMinutes ?? 60

  let currentDay: number | null = null
  let col: {
    activity: number
    timeRange: number
    start: number
    end: number
    location: number
    uniform: number
    appliesTo: number
    kind: number
    notes: number
  } | null = null
  const daysSeen = new Set<number>()

  const buildCol = (header: readonly string[]): typeof col => {
    const mapping = options.mapping ?? suggestLongMapping(header)
    const columnFor = (field: LongField): number => header.findIndex((h) => mapping[h] === field)
    return {
      activity: columnFor('activity'),
      timeRange: columnFor('time_range'),
      start: columnFor('start'),
      end: columnFor('end'),
      location: columnFor('location'),
      uniform: columnFor('uniform'),
      appliesTo: columnFor('applies_to'),
      kind: columnFor('kind'),
      notes: columnFor('notes'),
    }
  }

  detection.table.rows.forEach((row, rowIndex) => {
    const dayFromAnnouncement = dayAnnouncementIndex(row[0] ?? '')
    if (dayFromAnnouncement !== null) {
      currentDay = dayFromAnnouncement
      daysSeen.add(dayFromAnnouncement)
      return
    }

    if (isSectionHeaderRow(row)) {
      col = buildCol(row)
      return
    }

    if (currentDay === null || col === null || col.activity === -1) return

    const rawTitle = (row[col.activity] ?? '').trim()
    if (isBlankCell(rawTitle)) return

    let start: number | null = null
    let end: number | null = null

    if (col.timeRange !== -1) {
      const r = parseTimeRange(row[col.timeRange] ?? '', defaultMinutes)
      if (r) {
        start = r.start
        end = r.end
      }
    }
    if (start === null && col.start !== -1) {
      const r = parseTimeRange(row[col.start] ?? '', defaultMinutes)
      if (r) {
        start = r.start
        end = r.end
      }
    }
    if (col.end !== -1) {
      const e = parseTimeRange(row[col.end] ?? '', 0)
      if (e && start !== null) {
        end = e.start <= start ? e.start + MINUTES_PER_DAY : e.start
      }
    }

    if (start === null || end === null) {
      rejected.push({
        row: rowIndex,
        column: Math.max(col.start, col.timeRange),
        value: rawTitle,
        why: 'Unreadable time.',
      })
      return
    }

    const parsed = parseCell(rawTitle)
    const declaredKind = col.kind === -1 ? undefined : normalizeKind(row[col.kind] ?? '')
    const appliesToCell = col.appliesTo === -1 ? undefined : parseAppliesTo(row[col.appliesTo] ?? '')

    for (const s of spansFor(currentDay, start, end)) {
      events.push(
        buildEvent({
          title: parsed.title || rawTitle,
          kind: declaredKind ?? parsed.kind ?? classifyActivity(parsed.title || rawTitle),
          span: s,
          uniform: parsed.uniform ?? cellOrUndefined(row[col.uniform] ?? ''),
          location: parsed.location ?? cellOrUndefined(row[col.location] ?? ''),
          appliesTo: appliesToCell ?? parsed.appliesTo,
          notes: joinNotes(cellOrUndefined(row[col.notes] ?? ''), parsed.notesSink),
          raw: { row: String(rowIndex), activity: rawTitle, day: String(currentDay) },
        }),
      )
    }
  })

  if (daysSeen.size > 0 && daysSeen.size < DAYS_PER_WEEK) {
    const missing = [...Array(DAYS_PER_WEEK).keys()].filter((d) => !daysSeen.has(d))
    warnings.push(
      `Only ${daysSeen.size} of 7 days had a section in this file. Missing: ${missing
        .map((d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d])
        .join(', ')}.`,
    )
  }
  if (rejected.length > 0) {
    warnings.push(`${rejected.length} row(s) could not be read and were skipped. They are listed so you can fix the source.`)
  }
  return finish(events, warnings, rejected, options)
}

// ---------------------------------------------------------------------------
// Cell content
// ---------------------------------------------------------------------------

export interface ParsedCell {
  title: string
  uniform?: string
  location?: string
  kind?: Kind
  appliesTo?: { classYears?: string[]; companies?: string[] }
  timeOverride?: { start: number; end: number }
  /** Segments we could not classify. Folded into the event's notes. */
  notesSink?: string
}

const BLANK_CELL = /^(|-|--|---|n\/?a|none|nil|x|—|·|\.)$/i

export function isBlankCell(cell: string): boolean {
  return BLANK_CELL.test(cell.trim())
}

/** A trimmed cell, or `undefined` when it carries nothing. */
function cellOrUndefined(cell: string): string | undefined {
  const t = cell.trim()
  return t === '' || isBlankCell(t) ? undefined : t
}

/** A cell holding two activities on separate lines becomes two events. */
function splitStackedCell(cell: string): string[] {
  return cell
    .split(/\n|\s{3,}|(?:\s+\/\/\s+)/)
    .map((p) => p.trim())
    .filter((p) => !isBlankCell(p))
}

/**
 * A matrix cell is rarely just a title.
 *
 *   `SRC / Class B`                  → title + uniform
 *   `Parade (Class of '27 only)`     → title + applies_to.classYears
 *   `MAC Training - Band Co`         → title + applies_to.companies
 *   `Guard Mount @ Jackson Arch`     → title + location
 *   `Drill 1500-1600`                → title + an explicit time override
 */
export function parseCell(cell: string): ParsedCell {
  let text = cell.trim()
  const out: ParsedCell = { title: '' }

  // Guard first. `N/A` would otherwise be split on the `/` used for uniforms
  // and yield an event titled "N", and `-` would yield an event titled "-".
  // A placeholder means no event, not an event with a placeholder name.
  if (isBlankCell(text)) return out

  // Parenthetical and bracketed qualifiers.
  const qualifiers: string[] = []
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => {
    qualifiers.push(inner.trim())
    return ' '
  })

  // An explicit time inside the cell wins over the row's period.
  const inlineTime = /(\d{1,2}[:.]?\d{2}\s*(?:-|–|to)\s*\d{1,2}[:.]?\d{2})/i.exec(text)
  if (inlineTime?.[1]) {
    const r = parseTimeRange(inlineTime[1])
    if (r) {
      out.timeOverride = { start: r.start, end: r.end }
      text = text.replace(inlineTime[1], ' ')
    }
  }

  // Location after `@` or `at ` — checked before the separator split so a
  // location containing a slash survives.
  const atLocation = /\s+(?:@|at)\s+([^/|;]+)$/i.exec(text)
  if (atLocation?.[1]) {
    out.location = atLocation[1].trim()
    text = text.slice(0, atLocation.index)
  }

  const segments = text.split(/\s*[/|;]\s*|\s+-\s+/).map((s) => s.trim()).filter((s) => s !== '')
  const title = segments.shift() ?? ''

  for (const segment of [...segments, ...qualifiers]) {
    const applies = parseAppliesTo(segment)
    if (applies) {
      out.appliesTo = mergeApplies(out.appliesTo, applies)
      continue
    }
    if (looksLikeUniform(segment)) {
      out.uniform = segment
      continue
    }
    const kind = normalizeKind(segment)
    if (kind) {
      out.kind = kind
      continue
    }
    if (!out.location && /\b(hall|barracks|arch|field|gym|room|center|centre|house|library|post)\b/i.test(segment)) {
      out.location = segment
      continue
    }
    out.notesSink = out.notesSink ? `${out.notesSink}; ${segment}` : segment
  }

  out.title = tidyTitle(title)
  return out
}

const UNIFORM = /^(class\s*[abc1-5]|duty\s*uniform|gym\s*(dyke|alpha)|coveralls|whites?|blouse|parade\s*dress|civilian|civvies|acu|ocp|pt\s*(gear|uniform))/i

function looksLikeUniform(segment: string): boolean {
  return UNIFORM.test(segment.trim())
}

function tidyTitle(title: string): string {
  return title.replace(/\s+/g, ' ').replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim()
}

function normalizeKind(value: string): Kind | undefined {
  const key = value.trim().toLowerCase().replace(/\s+/g, '_')
  if (isKind(key)) return key
  return undefined
}

const CLASS_YEAR = /\b(?:class\s*of\s*)?'?((?:19|20)?\d{2})\b/
const COMPANY = /\b([A-Z]|alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|band)\s*(?:co|company|btry|battery)\b/i

/**
 * `1/C`, `2/C`, `3/C`, `4/C` — the Corps-of-Cadets ordinal class-rank
 * notation (first class down to fourth), which is what a real published
 * schedule actually uses for who-does-this-apply-to. It is distinct from
 * `CLASS_YEAR` above, which reads a graduation year like "Class of '27" —
 * a rank does not say when someone graduates, only their standing this year.
 * The two are never merged: a cadet's profile has to be told in whichever
 * vocabulary their own schedule uses.
 */
const CLASS_RANK = /\b([1-4])\s*\/\s*c\b/i

/** `Class of '27 only`, `Rats only`, `Band Co`, `All`, `1st Class`, `2/C`. */
export function parseAppliesTo(segment: string): { classYears?: string[]; companies?: string[] } | undefined {
  const text = segment.trim()
  if (text === '' || /^(all|everyone|corps|corps\s*\(-\)|all\s*cadets)$/i.test(text)) return undefined

  const out: { classYears?: string[]; companies?: string[] } = {}

  const company = COMPANY.exec(text)
  if (company?.[1]) {
    out.companies = [normalizeCompany(company[1])]
  }

  // Ordinal class rank is unambiguous notation — "1/C" is not going to turn up
  // as noise in an ordinary title the way a bare two-digit number might, so
  // this is read unconditionally, with no "only"-style trigger word required.
  // "4/C" is the same population the RAT sentinel already names, so it folds
  // into that rather than creating a second token for one group of cadets.
  const rank = CLASS_RANK.exec(text)
  if (rank?.[1]) {
    out.classYears = [...(out.classYears ?? []), rank[1] === '4' ? 'RAT' : `${rank[1]}C`]
  }

  // Only treat a year as applicability when the cell says so — `Class of '27`,
  // `27 only`, `Rats`. A bare `2027` in a title is not applicability.
  if (/\b(only|class\s*of|rats?|first\s*class|1st\s*class|third\s*class|3rd\s*class)\b/i.test(text)) {
    const year = CLASS_YEAR.exec(text)
    if (year?.[1]) out.classYears = [...(out.classYears ?? []), expandYear(year[1])]
    // "Rats" alone means rats only. "Rats AND CADRE" means rats plus the
    // upperclass cadre running them — restricting that to rats-only would
    // silently hide it from every cadre member reading their own plan, which
    // is the opposite of what the phrase says.
    if (/\brats?\b/i.test(text) && !/\bcadre\b/i.test(text)) {
      out.classYears = out.classYears ?? ['RAT']
    }
  }

  return out.classYears || out.companies ? out : undefined
}

function normalizeCompany(token: string): string {
  const t = token.trim()
  if (t.length === 1) return t.toUpperCase()
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

function expandYear(value: string): string {
  if (value.length === 4) return value
  const n = Number(value)
  return String(n < 50 ? 2000 + n : 1900 + n)
}

function mergeApplies(
  a: { classYears?: string[]; companies?: string[] } | undefined,
  b: { classYears?: string[]; companies?: string[] },
): { classYears?: string[]; companies?: string[] } {
  if (!a) return b
  return {
    classYears: [...new Set([...(a.classYears ?? []), ...(b.classYears ?? [])])].filter((x) => x.length > 0),
    companies: [...new Set([...(a.companies ?? []), ...(b.companies ?? [])])].filter((x) => x.length > 0),
  }
}

// ---------------------------------------------------------------------------
// Shared tail
// ---------------------------------------------------------------------------

function joinNotes(...parts: Array<string | undefined>): string | undefined {
  const live = parts.filter((p): p is string => p !== undefined && p !== '')
  return live.length === 0 ? undefined : live.join('; ')
}

/** Split a possibly-midnight-crossing local range into week spans. */
function spansFor(day: number, startMin: number, endMin: number): Span[] {
  if (endMin <= startMin) return []
  return clipToWeek([{ start: atDay(day, startMin), end: atDay(day, endMin) }])
}

function buildEvent(input: {
  title: string
  kind: Kind
  span: Span
  uniform?: string
  location?: string
  appliesTo?: { classYears?: string[]; companies?: string[] }
  notes?: string
  raw: Record<string, string>
}): WeekEvent {
  const sourceRef = simpleHash(`${input.title}|${input.span.start}|${input.span.end}`)
  return {
    id: `matrix:${sourceRef}`,
    source: 'matrix',
    sourceRef,
    title: input.title,
    kind: input.kind,
    span: input.span,
    hard: kindSpec(input.kind).hard,
    ...(input.uniform ? { uniform: input.uniform } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    raw: input.raw,
  }
}

/**
 * Applicability filter and duplicate collapse.
 *
 * Dropping events that do not apply to this cadet is why class year and company
 * are required at setup rather than optional: a matrix that lists every
 * company's duty roster is mostly noise to any one cadet.
 */
function finish(
  events: WeekEvent[],
  warnings: string[],
  rejected: MatrixParseResult['rejected'],
  options: MatrixParseOptions,
): MatrixParseResult {
  const before = events.length
  const applicable = events.filter((e) => appliesToCadet(e, options))
  const dropped = before - applicable.length
  if (dropped > 0) {
    warnings.push(
      `${dropped} event(s) applied to another class year or company and were left out. Change your profile if that is wrong.`,
    )
  }

  const seen = new Map<string, WeekEvent>()
  for (const e of applicable) {
    const key = `${e.title.toLowerCase()}|${e.span.start}|${e.span.end}`
    if (!seen.has(key)) seen.set(key, e)
  }
  const deduped = [...seen.values()].sort((a, b) => a.span.start - b.span.start)
  if (deduped.length < applicable.length) {
    warnings.push(`Collapsed ${applicable.length - deduped.length} duplicate row(s) — usually a merged-cell artefact.`)
  }

  return { events: deduped, warnings, rejected }
}

export function appliesToCadet(event: WeekEvent, options: MatrixParseOptions): boolean {
  const applies = event.appliesTo
  if (!applies) return true

  const years = applies.classYears ?? []
  const companies = applies.companies ?? []

  if (years.length > 0 && options.classYear) {
    if (!years.includes(options.classYear)) return false
  }
  if (companies.length > 0 && options.company) {
    if (!companies.some((c) => c.toLowerCase() === options.company?.toLowerCase())) return false
  }
  return true
}

/** FNV-1a. Short, stable, and dependency-free — used for ids and fingerprints. */
export function simpleHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
