import { describe, expect, it } from 'vitest'
import { ROW_MINUTES, choosePrintRange, layoutPrintWeek } from '@/lib/print/layout'
import { atDay, span } from '@/lib/domain/time'
import type { PlanBlock } from '@/lib/domain/types'

function block(id: string, start: number, end: number, kind: PlanBlock['kind'] = 'class'): PlanBlock {
  return { id, span: span(start, end), title: id, kind, locked: false }
}

const WAKE = 6 * 60
const SLEEP = 23 * 60

describe('the printed grid range', () => {
  it('covers the waking day, snapped to rows', () => {
    const range = choosePrintRange([block('c', atDay(0, 8 * 60), atDay(0, 9 * 60))], WAKE, SLEEP)
    expect(range.from % ROW_MINUTES).toBe(0)
    expect(range.from).toBe(5 * 60 + 30)
    expect(range.to).toBe(23 * 60)
  })

  it('is not dragged to midnight by an all-day marker', () => {
    const notice = block('holiday', atDay(5, 0), atDay(5, 0), 'personal')
    expect(choosePrintRange([notice], WAKE, SLEEP).from).toBe(5 * 60 + 30)
  })
})

describe('block placement on paper', () => {
  const range = { from: 6 * 60, to: 23 * 60 }

  it('spans the rows a block actually covers', () => {
    const layout = layoutPrintWeek([block('lab', atDay(2, 14 * 60), atDay(2, 16 * 60 + 50))], range)
    const cell = [...layout.starts.values()][0]
    expect(cell?.span).toBe(6) // 14:00 to 16:50 rounds up across six 30-minute rows
  })

  /**
   * The silent failure this exists to prevent.
   *
   * Rows are 30 minutes, so a 07:40 formation is floored into the 07:30 row.
   * If the label does not carry the real time, the printed sheet tells the
   * reader 07:30 — and a plan that makes a cadet ten minutes late is worse
   * than one that admits it rounds.
   */
  it('flags a start that does not sit on a row boundary', () => {
    const layout = layoutPrintWeek([block('study', atDay(0, 7 * 60 + 40), atDay(0, 9 * 60))], range)
    const cell = [...layout.starts.values()][0]
    expect(cell?.offGrid).toBe(true)
    expect(cell?.startMinute).toBe(7 * 60 + 40)
  })

  it('does not flag a start that does sit on a boundary', () => {
    const layout = layoutPrintWeek([block('formation', atDay(0, 7 * 60), atDay(0, 7 * 60 + 30))], range)
    expect([...layout.starts.values()][0]?.offGrid).toBe(false)
  })

  it('gives one cell to one block, so a collision cannot become two slivers', () => {
    const layout = layoutPrintWeek(
      [
        block('lab', atDay(2, 14 * 60), atDay(2, 16 * 60 + 50), 'lab'),
        block('training', atDay(2, 14 * 60), atDay(2, 15 * 60)),
      ],
      range,
    )
    const wednesdayCells = [...layout.starts.keys()].filter((k) => k.startsWith('2:'))
    expect(wednesdayCells).toHaveLength(1)
  })

  it('never marks a cell occupied by two different blocks', () => {
    const layout = layoutPrintWeek(
      [
        block('a', atDay(1, 8 * 60), atDay(1, 10 * 60)),
        block('b', atDay(1, 10 * 60), atDay(1, 11 * 60)),
        block('c', atDay(1, 13 * 60), atDay(1, 14 * 60)),
      ],
      range,
    )
    // Each start row is distinct and no start lands inside another's span.
    for (const [key, cell] of layout.starts) {
      const [day, row] = key.split(':').map(Number)
      for (let r = (row ?? 0) + 1; r < (row ?? 0) + cell.span; r++) {
        expect(layout.starts.has(`${day}:${r}`)).toBe(false)
      }
    }
  })
})

describe('obligations carried in from the previous day', () => {
  const range = { from: 6 * 60, to: 24 * 60 }

  /**
   * Guard runs 23:00 Friday to 01:00 Saturday. Its Saturday portion is
   * entirely below the drawn window, so it gets no row — and without this the
   * printed grid shows Saturday as clear. An obligation missing from the sheet
   * is the worst thing the sheet can do.
   */
  it('reports an overnight duty on the day it ends', () => {
    const guard = block('guard', atDay(4, 23 * 60), atDay(5, 60), 'duty')
    const layout = layoutPrintWeek([guard], range)

    // Friday keeps its visible 23:00-24:00 portion as a real cell...
    expect([...layout.starts.keys()].some((k) => k.startsWith('4:'))).toBe(true)
    // ...and Saturday reports the carried-in tail instead of showing nothing.
    expect(layout.carriedIn.get(5)?.map((b) => b.id)).toEqual(['guard'])
  })

  it('does not report a block that is fully visible', () => {
    const layout = layoutPrintWeek([block('c', atDay(0, 8 * 60), atDay(0, 9 * 60))], range)
    expect(layout.carriedIn.size).toBe(0)
  })

  it('does not report a day the block never touches', () => {
    const guard = block('guard', atDay(4, 23 * 60), atDay(5, 60), 'duty')
    const layout = layoutPrintWeek([guard], range)
    expect(layout.carriedIn.has(2)).toBe(false)
    expect(layout.carriedIn.has(6)).toBe(false)
  })

  it('places a substantial overnight run as real rows, not a header note', () => {
    // A duty until 04:00 is inside a window that starts at 06:00? No — so it
    // is still carried. But with a midnight window it occupies real rows.
    const guard = block('guard', atDay(4, 22 * 60), atDay(5, 4 * 60), 'duty')
    const wide = layoutPrintWeek([guard], { from: 0, to: 24 * 60 })
    expect([...wide.starts.keys()].some((k) => k.startsWith('5:'))).toBe(true)
    expect(wide.carriedIn.size).toBe(0)
  })
})

describe('layout is deterministic', () => {
  it('does not depend on the order blocks arrive in', () => {
    const range = { from: 6 * 60, to: 23 * 60 }
    const blocks = [
      block('a', atDay(0, 8 * 60), atDay(0, 9 * 60)),
      block('b', atDay(0, 10 * 60), atDay(0, 11 * 60)),
      block('c', atDay(3, 14 * 60), atDay(3, 15 * 60)),
    ]
    const forward = layoutPrintWeek(blocks, range)
    const reversed = layoutPrintWeek([...blocks].reverse(), range)
    expect([...reversed.starts.keys()].sort()).toEqual([...forward.starts.keys()].sort())
  })
})
