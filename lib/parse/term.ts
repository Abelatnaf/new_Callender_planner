/**
 * Course schedule ingest.
 *
 * The build plan made the term schedule an admin-owned global catalog with a
 * per-user enrollment join table, because it assumed many cadets sharing one
 * canonical timetable. For a single cadet that machinery is pure cost: it needs
 * an admin role, a role-gated route, a section picker, and an archive step
 * every term, to arrive at the same seven rows the registrar already printed
 * on one page.
 *
 * So this reads the cadet's OWN course list. Strict format, no mapping UI —
 * the columns are documented and the file is small enough to fix by hand.
 */

import { kindSpec, type Kind } from '../domain/kinds'
import { atDay, clipToWeek, MINUTES_PER_DAY, type Span } from '../domain/time'
import type { WeekEvent } from '../domain/types'
import { normalizeHeader, parseCsv } from './csv'
import { simpleHash } from './matrix'
import { parseDayCodes, parseTimeRange } from './timeRange'

export interface TermParseResult {
  events: WeekEvent[]
  sections: Array<{ code: string; title: string; days: number[]; start: number; end: number; location?: string }>
  warnings: string[]
}

const LAB_TITLE = /\b(lab|laboratory|studio|practicum)\b/i

/**
 * Expected columns (order does not matter, names are matched loosely):
 *
 *   course_code, title, days, start_time, end_time, location, instructor
 *
 * `days` accepts `MWF`, `TR`, `MO,WE,FR` or `Monday`.
 */
export function parseTermSchedule(input: string): TermParseResult {
  const table = parseCsv(input)
  const warnings = [...table.warnings]
  const events: WeekEvent[] = []
  const sections: TermParseResult['sections'] = []

  const find = (...candidates: string[]): number =>
    table.header.findIndex((h) => candidates.includes(normalizeHeader(h)))

  const col = {
    code: find('course_code', 'course', 'code', 'subject'),
    section: find('section', 'sec', 'crn'),
    title: find('title', 'course_title', 'name', 'description'),
    days: find('days', 'day', 'meeting_days', 'dow'),
    start: find('start_time', 'start', 'begin', 'from'),
    end: find('end_time', 'end', 'finish', 'to'),
    location: find('location', 'room', 'building', 'where'),
    instructor: find('instructor', 'teacher', 'professor', 'faculty'),
    kind: find('kind', 'type'),
  }

  if (col.days === -1 || col.start === -1) {
    warnings.push(
      'A course schedule needs at least a days column and a start time column. Expected headers: course_code, title, days, start_time, end_time, location.',
    )
    return { events, sections, warnings }
  }

  table.rows.forEach((row, index) => {
    const code = (row[col.code] ?? '').trim()
    const rawTitle = (row[col.title] ?? '').trim()
    if (code === '' && rawTitle === '') return

    const days = parseDayCodes(row[col.days] ?? '')
    if (days.length === 0) {
      warnings.push(`Row ${index + 1}: could not read the meeting days ("${row[col.days] ?? ''}").`)
      return
    }

    const startRange = parseTimeRange(row[col.start] ?? '', 50)
    if (!startRange) {
      warnings.push(`Row ${index + 1}: could not read the start time ("${row[col.start] ?? ''}").`)
      return
    }

    let end = startRange.end
    if (col.end !== -1) {
      const endRange = parseTimeRange(row[col.end] ?? '', 0)
      if (endRange) {
        end = endRange.start <= startRange.start ? endRange.start + MINUTES_PER_DAY : endRange.start
      }
    }

    const label = [code, rawTitle].filter((p) => p !== '').join(' — ') || 'Class'
    const declared = (row[col.kind] ?? '').trim().toLowerCase()
    const kind: Kind =
      declared === 'lab' || LAB_TITLE.test(rawTitle) || LAB_TITLE.test(code) ? 'lab' : 'class'
    const location = (row[col.location] ?? '').trim() || undefined
    const instructor = (row[col.instructor] ?? '').trim() || undefined
    const section = (row[col.section] ?? '').trim()

    sections.push({
      code: code || rawTitle,
      title: rawTitle,
      days,
      start: startRange.start,
      end,
      ...(location ? { location } : {}),
    })

    for (const day of days) {
      for (const s of spansFor(day, startRange.start, end)) {
        const ref = simpleHash(`${code}|${section}|${day}|${startRange.start}`)
        events.push({
          id: `term:${ref}`,
          source: 'term',
          sourceRef: ref,
          title: label,
          kind,
          span: s,
          hard: kindSpec(kind).hard,
          ...(code ? { course: code } : {}),
          ...(location ? { location } : {}),
          ...(instructor ? { notes: `Instructor: ${instructor}` } : {}),
          raw: Object.fromEntries(table.header.map((h, i) => [h, row[i] ?? ''])),
        })
      }
    }
  })

  if (events.length === 0 && table.rows.length > 0) {
    warnings.push('No course meetings could be read from this file.')
  }

  return { events, sections, warnings }
}

function spansFor(day: number, start: number, end: number): Span[] {
  if (end <= start) return []
  return clipToWeek([{ start: atDay(day, start), end: atDay(day, end) }])
}

/** A starter file, offered in the UI so the format is never a guess. */
export const TERM_TEMPLATE = `course_code,section,title,days,start_time,end_time,location,instructor
CIS-111,01,Intro to Programming,MWF,08:00,08:50,Nichols 210,Ghani
CIS-111L,04,Intro to Programming Lab,W,14:00,16:50,Nichols 210,Ghani
ERH-101,04,Writing and Rhetoric,TR,14:00,15:20,Scott Shipp 300,Ramsey
MATH-121,02,Calculus I,MWF,10:00,10:50,Mallory 201,Hughes
HI-104,02,Modern World History,TR,09:30,10:50,Scott Shipp 212,Brodie
`
