import { describe, expect, it } from 'vitest'
import { buildSampleIcs, buildSampleState } from '@/lib/demo/sample'
import { deriveWeek } from '@/lib/store/derive'
import { parseIcs } from '@/lib/parse/ics'
import { spanLength } from '@/lib/domain/time'

const WEEK = '2026-09-14'

describe('the sample week', () => {
  /**
   * The sample exists to make a first impression, so it has to actually
   * produce a usable plan — not merely parse. If any of these break, someone
   * opening the app for the first time sees a broken week.
   */
  const state = buildSampleState(WEEK)
  const derived = deriveWeek(state, WEEK)

  it('registers as having sources', () => {
    expect(derived.hasAnySource).toBe(true)
  })

  it('produces a week full of real blocks', () => {
    expect(derived.plan.blocks.length).toBeGreaterThan(30)
    expect(derived.plan.blocks.some((b) => b.kind === 'formation')).toBe(true)
    expect(derived.plan.blocks.some((b) => b.kind === 'class')).toBe(true)
    expect(derived.plan.blocks.some((b) => b.kind === 'study')).toBe(true)
    expect(derived.plan.blocks.some((b) => b.kind === 'assignment_due')).toBe(true)
    expect(derived.plan.blocks.some((b) => b.kind === 'exam')).toBe(true)
  })

  it('schedules work rather than leaving it all unplaced', () => {
    expect(derived.plan.capacity.placedMinutes).toBeGreaterThan(240)
  })

  it('shows an AUTHENTIC institutional conflict, which is half the point', () => {
    // The enrolled CIS-111L lab meets 14:00-16:50 Wednesday while Band Co MAC
    // Training runs 15:30-17:00. That is a genuine double-booking needing a
    // human. An exam sitting in its own course's lecture slot is NOT one, and
    // must not be what the banner demonstrates.
    expect(derived.plan.conflicts.length).toBeGreaterThan(0)
    const titles = derived.plan.conflicts.flatMap((c) => [c.a.title, c.b.title]).join(' ')
    expect(titles).toContain('MAC Training')
    expect(titles).toContain('CIS-111L')
    expect(titles).not.toContain('Midterm')
  })

  it('writes a narrative', () => {
    expect(derived.plan.narrative.length).toBeGreaterThan(1)
  })

  it('parses every source without an error report', () => {
    for (const report of derived.reports) {
      expect(report.ok, `${report.label}: ${report.warnings.join(' | ')}`).toBe(true)
    }
  })

  it('demonstrates the applicability filter', () => {
    // The Saturday parade is restricted to the class of '27; the sample cadet
    // is '28, so it must be filtered out.
    expect(derived.plan.blocks.some((b) => b.title === 'Parade')).toBe(false)
    const senior = deriveWeek(
      { ...state, profile: { ...state.profile, classYear: '2027' } },
      WEEK,
    )
    expect(senior.plan.blocks.some((b) => b.title === 'Parade')).toBe(true)
  })

  it('dates the feed onto whichever week is asked for', () => {
    // A demo whose deadlines sit in a fixed past week shows empty columns.
    for (const week of ['2026-09-14', '2027-01-04', '2026-11-02']) {
      const onWeek = deriveWeek(buildSampleState(week), week)
      expect(onWeek.tasks.length, week).toBeGreaterThan(3)
      expect(onWeek.plan.capacity.placedMinutes, week).toBeGreaterThan(0)
    }
  })

  it('keeps due dates as zero-length markers', () => {
    const parsed = parseIcs(buildSampleIcs(WEEK), { weekStart: WEEK, timeZone: 'America/New_York' })
    const due = parsed.events.filter((e) => e.kind === 'assignment_due')
    expect(due.length).toBeGreaterThan(2)
    expect(due.every((e) => spanLength(e.span) === 0)).toBe(true)
  })

  it('survives the DST week without misplacing anything', () => {
    // 1 Nov 2026 is the US fall-back. Blocks must stay inside the week.
    const dst = deriveWeek(buildSampleState('2026-10-26'), '2026-10-26')
    expect(dst.plan.blocks.every((b) => b.span.start >= 0 && b.span.end <= 10080)).toBe(true)
    expect(dst.plan.blocks.some((b) => b.kind === 'formation')).toBe(true)
  })
})
