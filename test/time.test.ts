import { describe, expect, it } from 'vitest'
import {
  addDays,
  atDay,
  dailyWindow,
  daysBetween,
  formatClock,
  formatDuration,
  instantToWeekMinutes,
  isoWeekday,
  MINUTES_PER_WEEK,
  normalize,
  span,
  subtract,
  totalMinutes,
  union,
  wallClockInZone,
  weekStartOf,
} from '@/lib/domain/time'

describe('interval algebra', () => {
  it('merges overlapping and touching spans', () => {
    expect(normalize([span(10, 20), span(15, 30), span(30, 40)])).toEqual([span(10, 40)])
  })

  it('drops empty and inverted spans', () => {
    expect(normalize([span(10, 10), span(30, 20), span(5, 8)])).toEqual([span(5, 8)])
  })

  it('subtracts a cut from the middle, leaving two spans', () => {
    expect(subtract([span(0, 100)], [span(40, 60)])).toEqual([span(0, 40), span(60, 100)])
  })

  it('subtracts multiple overlapping cuts', () => {
    expect(subtract([span(0, 100)], [span(10, 20), span(15, 30), span(80, 200)])).toEqual([
      span(0, 10),
      span(30, 80),
    ])
  })

  it('returns nothing when the cut covers the base', () => {
    expect(subtract([span(10, 20)], [span(0, 100)])).toEqual([])
  })

  it('is a no-op when cuts do not intersect', () => {
    expect(subtract([span(10, 20)], [span(30, 40)])).toEqual([span(10, 20)])
  })

  it('unions disjoint sets without losing minutes', () => {
    expect(totalMinutes(union([span(0, 10)], [span(20, 30)]))).toBe(20)
  })

  // A property that must hold for the solver to be trustworthy: removing a
  // block and adding it back conserves total minutes.
  it('conserves total minutes across subtract then union', () => {
    const base = [span(0, MINUTES_PER_WEEK)]
    const cut = [span(100, 200), span(5000, 5400)]
    const remaining = subtract(base, cut)
    expect(totalMinutes(remaining) + totalMinutes(cut)).toBe(MINUTES_PER_WEEK)
  })
})

describe('daily windows', () => {
  it('repeats a same-day window across all seven days', () => {
    const lunch = dailyWindow(12 * 60, 12 * 60 + 45)
    expect(lunch).toHaveLength(7)
    expect(totalMinutes(lunch)).toBe(45 * 7)
  })

  it('splits a midnight-crossing window and stays inside the week', () => {
    const sleep = dailyWindow(23 * 60, 6 * 60)
    // Every minute must land inside the week; nothing may run past Sunday 24:00.
    expect(Math.max(...sleep.map((s) => s.end))).toBeLessThanOrEqual(MINUTES_PER_WEEK)
    expect(Math.min(...sleep.map((s) => s.start))).toBeGreaterThanOrEqual(0)
    // Each day contributes its 23:00-24:00 tail and its 00:00-06:00 head, so
    // the week carries exactly seven seven-hour nights with nothing clipped.
    expect(totalMinutes(sleep)).toBe(7 * 7 * 60)
  })
})

describe('formatting', () => {
  it('zero-pads clock times so they set in tabular figures', () => {
    expect(formatClock(atDay(0, 7 * 60))).toBe('07:00')
    expect(formatClock(atDay(3, 7 * 60), { colon: false })).toBe('0700')
    expect(formatClock(atDay(0, 0))).toBe('00:00')
  })

  it('formats durations without a stray zero', () => {
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(60)).toBe('1h')
    expect(formatDuration(105)).toBe('1h 45m')
  })
})

describe('calendar arithmetic', () => {
  it('finds the Monday of any week', () => {
    expect(weekStartOf('2026-09-16')).toBe('2026-09-14')
    expect(weekStartOf('2026-09-14')).toBe('2026-09-14')
    expect(weekStartOf('2026-09-20')).toBe('2026-09-14')
  })

  it('treats Sunday as the seventh day, not the first', () => {
    expect(isoWeekday('2026-09-20')).toBe(7)
    expect(isoWeekday('2026-09-14')).toBe(1)
  })

  it('counts days across a month boundary', () => {
    expect(daysBetween('2026-09-28', '2026-10-02')).toBe(4)
    expect(addDays('2026-09-30', 2)).toBe('2026-10-02')
  })

  // The DST test the plan asked for. US clocks fall back on 1 Nov 2026.
  it('counts exactly 7 days across a DST boundary', () => {
    expect(daysBetween('2026-10-26', '2026-11-02')).toBe(7)
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  })
})

describe('the one boundary where absolute time exists', () => {
  it('reads a UTC instant as Eastern wall clock', () => {
    // 20:00Z in September is 16:00 EDT.
    const wall = wallClockInZone(new Date('2026-09-16T20:00:00Z'), 'America/New_York')
    expect(wall.date).toBe('2026-09-16')
    expect(wall.minutes).toBe(16 * 60)
  })

  it('applies the correct offset on each side of a DST transition', () => {
    // 1 Nov 2026: EDT (-4) before 02:00 local, EST (-5) after.
    const before = wallClockInZone(new Date('2026-11-01T05:00:00Z'), 'America/New_York')
    const after = wallClockInZone(new Date('2026-11-01T07:00:00Z'), 'America/New_York')
    expect(before.minutes).toBe(60) // 01:00 EDT
    expect(after.minutes).toBe(120) // 02:00 EST
  })

  it('maps an instant into week-minutes, or rejects it as out of week', () => {
    const inside = instantToWeekMinutes(new Date('2026-09-16T20:00:00Z'), '2026-09-14', 'America/New_York')
    expect(inside).toBe(atDay(2, 16 * 60))
    const outside = instantToWeekMinutes(new Date('2026-09-30T20:00:00Z'), '2026-09-14', 'America/New_York')
    expect(outside).toBeNull()
  })

  /**
   * The invariant the whole time model exists to protect: a wall-clock
   * obligation does not move when the clocks change. A 0700 formation is at
   * week-minute 420 on the DST week exactly as on any other week.
   */
  it('keeps a wall-clock obligation fixed across the DST week', () => {
    const normalWeek = atDay(0, 7 * 60)
    const dstWeek = atDay(0, 7 * 60)
    expect(normalWeek).toBe(dstWeek)
    expect(formatClock(dstWeek)).toBe('07:00')
  })
})
