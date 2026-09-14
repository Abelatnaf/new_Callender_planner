/**
 * Print-grid layout.
 *
 * Pure, so it can be tested without a browser. The printed sheet is the
 * product, and two of its failure modes are silent — a rounded start time and
 * a missing overnight obligation — so they need assertions rather than a
 * careful reading.
 *
 * The grid is a real HTML table rather than a positioned layer: print engines
 * paginate and scale tables predictably, whereas an absolutely positioned grid
 * depends on a viewport height that does not exist on paper. A block is
 * emitted once at its starting row with a `rowSpan`, and the cells it covers
 * are omitted.
 */

import { kindSpec } from '../domain/kinds'
import type { PlanBlock } from '../domain/types'

/** Row resolution on paper. 30 minutes keeps a Letter landscape page to ~36 rows. */
export const ROW_MINUTES = 30

export interface PrintRange {
  from: number
  to: number
}

export interface PrintCell {
  block: PlanBlock
  /** Rows covered, for `rowSpan`. */
  span: number
  /** The block's true start, in minutes past midnight, clipped to the window. */
  startMinute: number
  /**
   * True when the start does not coincide with its row boundary.
   *
   * Rows are 30 minutes, so a block beginning 07:40 is floored into the 07:30
   * row. Left alone the grid TELLS THE READER 07:30, and a plan that makes a
   * cadet ten minutes late is worse than one that admits it rounds. When this
   * is set, the exact time is printed inside the block.
   */
  offGrid: boolean
}

export interface PrintLayout {
  rows: number[]
  starts: Map<string, PrintCell>
  occupied: Set<string>
  /**
   * Obligations carried in from the previous day whose visible portion falls
   * entirely below the drawn window — an overnight duty on the day it ends.
   * They have no row to occupy, so they are reported in the column header.
   */
  carriedIn: Map<number, PlanBlock[]>
}

/**
 * Choose the drawn window from the content.
 *
 * Zero-length markers are excluded: an all-day notice sits at 00:00 by
 * convention and would open the window to midnight, spending a third of the
 * page on empty rows and shrinking every real block.
 */
export function choosePrintRange(blocks: readonly PlanBlock[], wake: number, sleep: number): PrintRange {
  let earliest = wake
  let latest = sleep

  for (const block of blocks) {
    if (block.span.end <= block.span.start) continue
    const startOfDay = block.span.start % 1440
    const crossesMidnight = Math.floor(block.span.end / 1440) > Math.floor(block.span.start / 1440)
    const endOfDay = crossesMidnight ? 1440 : block.span.end % 1440 === 0 ? 1440 : block.span.end % 1440
    earliest = Math.min(earliest, startOfDay)
    latest = Math.max(latest, endOfDay)
  }

  return {
    from: Math.max(0, Math.floor(earliest / ROW_MINUTES) * ROW_MINUTES - ROW_MINUTES),
    to: Math.min(1440, Math.ceil(latest / ROW_MINUTES) * ROW_MINUTES),
  }
}

export function layoutPrintWeek(blocks: readonly PlanBlock[], range: PrintRange): PrintLayout {
  const rows: number[] = []
  for (let m = range.from; m < range.to; m += ROW_MINUTES) rows.push(m)

  const occupied = new Set<string>()
  const starts = new Map<string, PrintCell>()
  const carriedIn = new Map<number, PlanBlock[]>()

  const timed = [...blocks]
    .filter((b) => b.span.end > b.span.start && kindSpec(b.kind).occupiesTime)
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end || a.title.localeCompare(b.title))

  for (const block of timed) {
    for (let day = 0; day < 7; day++) {
      const dayFrom = day * 1440
      const dayTo = (day + 1) * 1440
      if (block.span.start >= dayTo || block.span.end <= dayFrom) continue

      const localStart = Math.max(block.span.start - dayFrom, range.from)
      const localEnd = Math.min(block.span.end - dayFrom, range.to)

      if (localEnd <= localStart) {
        // Visible portion is outside the window entirely. If it was carried in
        // from the previous day it is still an obligation today, and must not
        // vanish from the sheet.
        if (block.span.start < dayFrom && block.span.end > dayFrom) {
          carriedIn.set(day, [...(carriedIn.get(day) ?? []), block])
        }
        continue
      }

      const startRow = Math.floor((localStart - range.from) / ROW_MINUTES)
      const endRow = Math.ceil((localEnd - range.from) / ROW_MINUTES)
      const key = `${day}:${startRow}`

      // One block per cell on paper: with no lanes to divide, a collision goes
      // in the conflict table rather than becoming two unreadable slivers.
      if (occupied.has(key)) continue

      starts.set(key, {
        block,
        span: Math.max(1, endRow - startRow),
        startMinute: localStart,
        offGrid: (localStart - range.from) % ROW_MINUTES !== 0,
      })
      for (let r = startRow; r < endRow; r++) occupied.add(`${day}:${r}`)
    }
  }

  return { rows, starts, occupied, carriedIn }
}
