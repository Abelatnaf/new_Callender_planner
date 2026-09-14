/**
 * A real published VMI master training schedule, unedited except for the
 * filename. This is the file that exposed Shape C (repeated daily sections),
 * the silent "2400" data-loss bug, and the "Rats and Cadre" applicability
 * regression — none of which the synthetic fixtures ever would have caught,
 * because they were built without ever having seen a real one.
 *
 * These assertions exist to keep that first real contact from silently
 * regressing later. If one of them starts failing, something upstream
 * changed the parser's behavior on the one file this project was actually
 * built to read.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectMatrix, parseMatrix } from '@/lib/parse/matrix'
import { dayOf, formatClock, spanLength } from '@/lib/domain/time'

const raw = readFileSync(join(__dirname, 'fixtures', 'real-master-schedule.csv'), 'utf-8')

describe('a real published master schedule', () => {
  const detection = detectMatrix(raw)

  it('is recognized as Shape C — repeated daily sections, no Day column', () => {
    expect(detection.shape).toBe('sectioned')
  })

  it('auto-detects the local header without a manual mapping', () => {
    expect(detection.suggestedMapping?.['Time']).toBe('time_range')
    expect(detection.suggestedMapping?.['PAX']).toBe('applies_to')
    expect(detection.suggestedMapping?.['Event']).toBe('activity')
    expect(detection.suggestedMapping?.['Instructor']).toBe('notes')
  })

  it('reads events for every day of the week, not just the days that fit a template', () => {
    const { events } = parseMatrix(detection, {})
    const days = new Set(events.map((e) => dayOf(e.span.start)))
    expect(days.size).toBe(7)
    expect(events.length).toBeGreaterThan(100)
  })

  it('drops the 16,373 padding columns without losing the 8 real ones', () => {
    expect(detection.table.rows[0]?.length).toBe(8)
  })

  /**
   * Guard duty rotates a different company through the same 1730-ish slot
   * every day (B, C, D, E, F, G, H — Monday through Sunday). This is the
   * applicability filter's sternest real test: getting it wrong either shows
   * every cadet six companies' worth of guard duty that isn't theirs, or
   * silently drops the one day that is.
   */
  it('rotates Guard Mount through a different company each day', () => {
    const { events } = parseMatrix(detection, {})
    const guard = events
      .filter((e) => e.title === 'Guard Mount')
      .sort((a, b) => a.span.start - b.span.start)
    expect(guard.map((e) => e.appliesTo?.companies?.[0])).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H'])
  })

  it('keeps only the cadet\'s own company\'s Guard Mount after filtering', () => {
    const { events } = parseMatrix(detection, { company: 'B' })
    const guard = events.filter((e) => e.title === 'Guard Mount')
    expect(guard).toHaveLength(1)
    expect(dayOf(guard[0]!.span.start)).toBe(0) // Monday
  })

  /**
   * The file uses ordinal class rank (1/C .. 4/C), never a graduation year —
   * exactly the vocabulary gap a synthetic "class of 2028" fixture would
   * never have surfaced.
   */
  it('reads ordinal class rank out of the PAX column', () => {
    const { events } = parseMatrix(detection, {})
    const ranked = events.filter((e) => e.appliesTo?.classYears)
    const byTitle = Object.fromEntries(ranked.map((e) => [e.title, e.appliesTo?.classYears]))
    expect(byTitle['BIT']).toEqual(['3C'])
    expect(byTitle['Admissions Open House Brief']).toEqual(['RAT'])
  })

  it('does not narrow "Rats and Cadre" to rats alone', () => {
    const { events } = parseMatrix(detection, {})
    const src = events.find((e) => e.title === 'SRC')
    expect(src?.appliesTo).toBeUndefined()
  })

  /**
   * "1320/CMD-1845", "1700-UTC", and a bare "2400" are three different ways
   * this one file breaks a naive time parser. None may reject the row or
   * collapse it to a zero-length span.
   */
  it('gives every hostile time token a real, non-zero duration', () => {
    const { events, rejected } = parseMatrix(detection, {})
    expect(rejected).toHaveLength(0)

    const permit = events.find((e) => e.title === 'General Permit')
    expect(permit).toBeDefined()
    expect(spanLength(permit!.span)).toBeGreaterThan(0)

    const fridayTaps = events.find((e) => e.title === 'Taps' && dayOf(e.span.start) === 4)
    expect(fridayTaps).toBeDefined()
    expect(spanLength(fridayTaps!.span)).toBeGreaterThan(0)
    expect(formatClock(fridayTaps!.span.end)).toBe('00:00')
  })

  /**
   * "Inspection Platoon" is a real, plainly-named event that fell through
   * every classifier rule to the 'personal' default, because the existing
   * inspection rule only recognized jargon (SRB/SRI/room inspection/in-ranks/
   * rack inspection) and missed the bare word "inspection" entirely. That
   * meant a real inspection lost every conflict-authority contest it was in —
   * including, absurdly, against "Crozet morning and afternoon hours".
   */
  it('classifies a plainly-named "Inspection Platoon" as an inspection, not personal time', () => {
    const { events } = parseMatrix(detection, {})
    const inspection = events.find((e) => e.title === 'Inspection Platoon')
    expect(inspection?.kind).toBe('inspection')
  })

  it('is deterministic — the same file parses to the same events twice', () => {
    const a = parseMatrix(detectMatrix(raw), { classYear: '2C', company: 'B' })
    const b = parseMatrix(detectMatrix(raw), { classYear: '2C', company: 'B' })
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id))
  })
})
