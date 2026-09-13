import { describe, expect, it } from 'vitest'
import { assignLanes, chooseHourRange, clippedForDay, isAllDayNotice } from '@/components/WeekGrid'
import { atDay, span } from '@/lib/domain/time'
import type { PlanBlock } from '@/lib/domain/types'

function block(id: string, start: number, end: number, kind: PlanBlock['kind'] = 'class'): PlanBlock {
  return { id, span: span(start, end), title: id, kind, locked: false }
}

describe('overlap lanes', () => {
  it('gives a lone block the full column', () => {
    const laned = assignLanes([block('a', 100, 200)])
    expect(laned[0]?.laneCount).toBe(1)
    expect(laned[0]?.lane).toBe(0)
  })

  it('splits two overlapping blocks into two lanes', () => {
    const laned = assignLanes([block('a', 100, 300), block('b', 200, 400)])
    expect(laned.map((l) => l.lane).sort()).toEqual([0, 1])
    expect(laned.every((l) => l.laneCount === 2)).toBe(true)
  })

  /**
   * The property that matters: a block with no collisions must not be narrowed
   * just because something else on the same day collides. The mock drew
   * colliding blocks on top of each other, which hides an obligation outright;
   * narrowing everything instead would make a clean day unreadable.
   */
  it('does not narrow a non-overlapping block because of a distant collision', () => {
    const laned = assignLanes([
      block('morning', 100, 200),
      block('clash-a', 500, 700),
      block('clash-b', 600, 800),
    ])
    expect(laned.find((l) => l.block.id === 'morning')?.laneCount).toBe(1)
    expect(laned.find((l) => l.block.id === 'clash-a')?.laneCount).toBe(2)
  })

  it('reuses a lane once it is free', () => {
    const laned = assignLanes([
      block('a', 0, 100),
      block('b', 50, 150),
      block('c', 120, 200),
    ])
    // a|b overlap, b|c overlap, a|c do not: c can sit back in a's lane.
    expect(laned.find((l) => l.block.id === 'c')?.lane).toBe(0)
  })

  it('never assigns two overlapping blocks the same lane', () => {
    const blocks = [
      block('a', 0, 300),
      block('b', 60, 400),
      block('c', 100, 200),
      block('d', 350, 500),
    ]
    const laned = assignLanes(blocks)
    for (const x of laned) {
      for (const y of laned) {
        if (x.block.id === y.block.id) continue
        const overlap = x.block.span.start < y.block.span.end && y.block.span.start < x.block.span.end
        if (overlap) expect(x.lane, `${x.block.id} vs ${y.block.id}`).not.toBe(y.lane)
      }
    }
  })
})

describe('the drawn hour range', () => {
  const wake = 6 * 60
  const sleep = 23 * 60

  it('fits the waking day when there is nothing unusual', () => {
    const range = chooseHourRange([block('c', atDay(0, 8 * 60), atDay(0, 9 * 60))], wake, sleep)
    expect(range.dayStartHour).toBe(5)
    expect(range.dayEndHour).toBe(24)
  })

  /**
   * An all-day notice sits at 00:00 by ICS convention. Letting it set the
   * scale adds six empty rows to every day and shrinks every real block —
   * which is the exact defect that made the reference mock unreadable.
   */
  it('is not dragged to midnight by an all-day marker', () => {
    const notice = block('holiday', atDay(5, 0), atDay(5, 0), 'personal')
    const range = chooseHourRange([notice, block('c', atDay(0, 8 * 60), atDay(0, 9 * 60))], wake, sleep)
    expect(range.dayStartHour).toBe(5)
  })

  it('is not dragged to midnight by a one-hour overnight tail', () => {
    const guard = block('guard', atDay(4, 23 * 60), atDay(5, 60), 'duty')
    const range = chooseHourRange([guard], wake, sleep)
    expect(range.dayStartHour).toBe(5)
    expect(range.dayEndHour).toBe(24)
  })

  it('does open to midnight for a substantial overnight run', () => {
    // A duty that runs until 04:00 is four hours of real obligation after
    // midnight and has earned the space.
    const guard = block('guard', atDay(4, 22 * 60), atDay(5, 4 * 60), 'duty')
    expect(chooseHourRange([guard], wake, sleep).dayStartHour).toBe(0)
  })

  it('opens earlier for a genuinely early obligation', () => {
    const early = block('early', atDay(0, 4 * 60), atDay(0, 6 * 60), 'formation')
    expect(chooseHourRange([early], wake, sleep).dayStartHour).toBe(3)
  })

  it('always draws at least six hours', () => {
    const range = chooseHourRange([], 12 * 60, 13 * 60)
    expect(range.dayEndHour - range.dayStartHour).toBeGreaterThanOrEqual(6)
  })
})

describe('content clipped out of the drawn window', () => {
  /**
   * The failure this exists to prevent: guard runs 23:00 Friday to 01:00
   * Saturday. It is drawn on Friday and, with a 06:00 axis, is simply absent
   * from Saturday. An obligation disappearing off the page is the worst thing
   * this app can do, so the clipped portion is reported instead.
   */
  it('reports an overnight obligation on the day it ends', () => {
    const guard = block('guard', atDay(4, 23 * 60), atDay(5, 60), 'duty')
    const saturday = clippedForDay([guard], 5, 6 * 60, 24 * 60)
    expect(saturday.before.map((b) => b.id)).toEqual(['guard'])
    expect(saturday.after).toHaveLength(0)
  })

  it('does not report a block that is visible', () => {
    const lecture = block('c', atDay(0, 8 * 60), atDay(0, 9 * 60))
    const monday = clippedForDay([lecture], 0, 6 * 60, 24 * 60)
    expect(monday.before).toHaveLength(0)
    expect(monday.after).toHaveLength(0)
  })

  it('reports a block that starts after the window closes', () => {
    const late = block('late', atDay(0, 22 * 60), atDay(0, 23 * 60))
    const monday = clippedForDay([late], 0, 6 * 60, 20 * 60)
    expect(monday.after.map((b) => b.id)).toEqual(['late'])
  })

  it('ignores days the block does not touch', () => {
    const guard = block('guard', atDay(4, 23 * 60), atDay(5, 60), 'duty')
    expect(clippedForDay([guard], 2, 6 * 60, 24 * 60).before).toHaveLength(0)
  })
})

describe('all-day notices', () => {
  it('recognises a zero-length block pinned to midnight', () => {
    expect(isAllDayNotice(block('holiday', atDay(3, 0), atDay(3, 0), 'personal'))).toBe(true)
  })

  it('does not treat a timed deadline as all-day', () => {
    const due = block('due', atDay(3, 23 * 60 + 59), atDay(3, 23 * 60 + 59), 'assignment_due')
    expect(isAllDayNotice(due)).toBe(false)
  })

  it('does not treat a real block as all-day', () => {
    expect(isAllDayNotice(block('c', atDay(0, 0), atDay(0, 60)))).toBe(false)
  })
})
