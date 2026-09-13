'use client'

import { useMemo } from 'react'
import { kindSpec } from '@/lib/domain/kinds'
import {
  DAY_ABBR,
  DAY_NAMES,
  addDays,
  atDay,
  daysBetween,
  formatClock,
  formatDuration,
  parseLocalDate,
  type LocalDate,
  type Span,
} from '@/lib/domain/time'
import type { PlanBlock } from '@/lib/domain/types'

export interface WeekGridProps {
  weekStart: LocalDate
  blocks: PlanBlock[]
  openWindows: Span[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  today: LocalDate
  /** Minutes past midnight, for the now-line. Null hides it. */
  nowMinutes: number | null
  /** First and last hour drawn. Computed from content, not hardcoded. */
  dayStartHour: number
  dayEndHour: number
}

interface Positioned {
  block: PlanBlock
  /** Percent from the top of the drawn day. */
  top: number
  height: number
  lane: number
  laneCount: number
}

/**
 * Assign overlapping blocks to side-by-side lanes.
 *
 * The Stitch mock drew colliding blocks on top of one another, which hides an
 * obligation — the single worst failure this app can have. Blocks are grouped
 * into clusters of mutual overlap so that a block with no collisions still
 * spans the full column width, and only genuinely conflicting blocks divide it.
 */
export function assignLanes(blocks: readonly PlanBlock[]): Array<{ block: PlanBlock; lane: number; laneCount: number }> {
  const sorted = [...blocks].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)
  const out: Array<{ block: PlanBlock; lane: number; laneCount: number }> = []

  let cluster: PlanBlock[] = []
  let clusterEnd = -Infinity

  const flush = (): void => {
    if (cluster.length === 0) return
    const laneEnds: number[] = []
    const assigned = cluster.map((block) => {
      let lane = laneEnds.findIndex((end) => end <= block.span.start)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(block.span.end)
      } else {
        laneEnds[lane] = block.span.end
      }
      return { block, lane }
    })
    for (const entry of assigned) {
      out.push({ ...entry, laneCount: laneEnds.length })
    }
    cluster = []
    clusterEnd = -Infinity
  }

  for (const block of sorted) {
    if (block.span.start >= clusterEnd) flush()
    cluster.push(block)
    clusterEnd = Math.max(clusterEnd, block.span.end)
  }
  flush()

  return out
}

export function WeekGrid({
  weekStart,
  blocks,
  openWindows,
  selectedId,
  onSelect,
  today,
  nowMinutes,
  dayStartHour,
  dayEndHour,
}: WeekGridProps): React.ReactNode {
  const windowStart = dayStartHour * 60
  const windowEnd = dayEndHour * 60
  const windowLength = Math.max(60, windowEnd - windowStart)

  const todayOffset = useMemo(() => {
    try {
      const offset = daysBetween(weekStart, today)
      return offset >= 0 && offset < 7 ? offset : null
    } catch {
      return null
    }
  }, [weekStart, today])

  const days = useMemo(() => {
    // Three populations, laid out differently:
    //   timed     — occupies height in the grid
    //   markers   — a deadline at a real time: a rule across the column
    //   allDay    — a notice with no time: its own row, never the grid
    // A source-provided study period (SST, Call to Quarters) is a CONTAINER
    // for the work the solver places, not a rival for the same column. Laning
    // it against the block inside it halves both widths and truncates both
    // labels, for no information gain.
    const studyWindows = blocks.filter((b) => isDesignatedStudyWindow(b))
    const timed = blocks.filter(
      (b) => b.span.end > b.span.start && kindSpec(b.kind).occupiesTime && !isDesignatedStudyWindow(b),
    )
    const allDay = blocks.filter((b) => isAllDayNotice(b))
    const markers = blocks.filter(
      (b) =>
        !isAllDayNotice(b) &&
        !isDesignatedStudyWindow(b) &&
        (b.span.end <= b.span.start || !kindSpec(b.kind).occupiesTime),
    )

    return [0, 1, 2, 3, 4, 5, 6].map((day) => {
      const dayFrom = atDay(day, 0)
      const dayTo = atDay(day + 1, 0)

      const inDay = timed.filter((b) => b.span.start < dayTo && b.span.end > dayFrom)
      const laned = assignLanes(inDay)

      const positioned: Positioned[] = laned.map(({ block, lane, laneCount }) => {
        // Clip to the drawn window so an overnight duty renders as the part of
        // it that falls inside this day, not as an overflow.
        const start = Math.max(block.span.start - dayFrom, windowStart)
        const end = Math.min(block.span.end - dayFrom, windowEnd)
        return {
          block,
          top: ((start - windowStart) / windowLength) * 100,
          height: Math.max(1.1, ((end - start) / windowLength) * 100),
          lane,
          laneCount,
        }
      })

      return {
        day,
        date: addDays(weekStart, day),
        blocks: positioned,
        allDay: allDay.filter((b) => b.span.start >= dayFrom && b.span.start < dayTo),
        studyWindows: studyWindows
          .filter((b) => b.span.start < dayTo && b.span.end > dayFrom)
          .map((block) => {
            const start = Math.max(block.span.start - dayFrom, windowStart)
            const end = Math.min(block.span.end - dayFrom, windowEnd)
            return {
              block,
              top: ((start - windowStart) / windowLength) * 100,
              height: Math.max(0, ((end - start) / windowLength) * 100),
            }
          })
          .filter((entry) => entry.height > 0.4),
        clipped: clippedForDay(blocks, day, windowStart, windowEnd),
        markers: markers
          .filter((b) => b.span.start >= dayFrom && b.span.start < dayTo)
          .map((block) => ({
            block,
            top: ((Math.min(Math.max(block.span.start - dayFrom, windowStart), windowEnd) - windowStart) / windowLength) * 100,
          })),
        open: openWindows
          .filter((s) => s.start < dayTo && s.end > dayFrom)
          .map((s) => {
            const start = Math.max(s.start - dayFrom, windowStart)
            const end = Math.min(s.end - dayFrom, windowEnd)
            return {
              top: ((start - windowStart) / windowLength) * 100,
              height: Math.max(0, ((end - start) / windowLength) * 100),
            }
          })
          .filter((s) => s.height > 0.4),
      }
    })
  }, [blocks, openWindows, weekStart, windowStart, windowEnd, windowLength])

  const hourMarks = useMemo(() => {
    const out: Array<{ hour: number; top: number }> = []
    for (let hour = dayStartHour; hour <= dayEndHour; hour++) {
      out.push({ hour, top: (((hour * 60) - windowStart) / windowLength) * 100 })
    }
    return out
  }, [dayStartHour, dayEndHour, windowStart, windowLength])

  const gridHeight = (dayEndHour - dayStartHour) * 54

  return (
    <div className="grid-scroll">
      <div
        className="grid"
        role="grid"
        aria-label={`Week of ${weekStart}`}
        style={{ ['--hour-height' as string]: '54px' }}
      >
        <div className="grid-corner" role="presentation" />
        {days.map(({ day, date }) => {
          const { d } = parseLocalDate(date)
          return (
            <div
              key={day}
              className="grid-dayhead"
              role="columnheader"
              data-today={todayOffset === day}
              data-weekend={day >= 5}
            >
              <div className="dow">{DAY_ABBR[day]}</div>
              <div className="dom tnum">{d}</div>
            </div>
          )
        })}

        <div className="grid-gutter" style={{ height: gridHeight }} role="presentation">
          {hourMarks.map(({ hour, top }) => (
            <span key={hour} className="grid-time" style={{ top: `${top}%` }}>
              {String(hour).padStart(2, '0')}:00
            </span>
          ))}
        </div>

        {days.map(({ day, date, blocks: dayBlocks, markers, open, allDay, clipped, studyWindows }) => (
          <div
            key={day}
            className="grid-day"
            role="gridcell"
            aria-label={`${DAY_NAMES[day]} ${date}`}
            data-weekend={day >= 5}
            style={{ height: gridHeight }}
          >
            {studyWindows.map(({ block, top, height }) => (
              <div
                key={`sw-${block.id}`}
                className="study-window"
                style={{ top: `${top}%`, height: `${height}%` }}
                title={`${block.title} — a study period you are required to attend`}
              >
                <span className="study-window-label">{block.title}</span>
              </div>
            ))}

            {(allDay.length > 0 || clipped.before.length > 0) && (
              <div className="day-top-stack">
                {allDay.map((block) => (
                  <button
                    type="button"
                    key={block.id}
                    className="allday-chip"
                    data-accent={kindSpec(block.kind).accent}
                    aria-pressed={selectedId === block.id}
                    onClick={() => onSelect(selectedId === block.id ? null : block.id)}
                    title={`All day — ${block.title}`}
                  >
                    {block.title}
                    <span className="sr-only"> — all day, no set time</span>
                  </button>
                ))}
                {clipped.before.map((block) => (
                  <span key={block.id} className="edge-note tnum">
                    ▲ {block.title} until {formatClock(block.span.end)}
                  </span>
                ))}
              </div>
            )}

            {clipped.after.length > 0 && (
              <div className="edge-chip" data-edge="bottom">
                {clipped.after.map((block) => (
                  <span key={block.id} className="tnum">
                    ▼ {block.title} from {formatClock(block.span.start)}
                  </span>
                ))}
              </div>
            )}

            {open.map((window, index) => (
              <div
                key={`open-${index}`}
                className="open-window"
                style={{ top: `${window.top}%`, height: `${window.height}%` }}
                aria-hidden="true"
              />
            ))}

            {dayBlocks.map(({ block, top, height, lane, laneCount }) => {
              const spec = kindSpec(block.kind)
              const pixelHeight = (height / 100) * gridHeight
              // Label tiers. The mock truncated nearly every label; degrading
              // by available height keeps something legible at every size.
              const tier = pixelHeight >= 36 ? 'full' : pixelHeight >= 19 ? 'title' : 'glyph'
              const laneWidth = 100 / laneCount
              const duration = block.span.end - block.span.start

              return (
                <button
                  type="button"
                  key={block.id}
                  className="block"
                  data-accent={spec.accent}
                  data-texture={spec.texture}
                  data-hard={block.locked ? true : spec.hard && block.kind !== 'study'}
                  data-locked={block.locked}
                  aria-pressed={selectedId === block.id}
                  onClick={() => onSelect(selectedId === block.id ? null : block.id)}
                  style={{
                    top: `${top}%`,
                    height: `${height}%`,
                    left: `calc(${lane * laneWidth}% + 2px)`,
                    width: `calc(${laneWidth}% - 4px)`,
                  }}
                  title={`${block.title} · ${formatClock(block.span.start)}–${formatClock(block.span.end)} · ${formatDuration(duration)}${block.location ? ` · ${block.location}` : ''}`}
                >
                  {tier === 'glyph' ? (
                    <span className="block-glyph" aria-hidden="true">
                      {spec.glyph}
                    </span>
                  ) : (
                    <>
                      <span className="block-title">
                        <span className="block-glyph" aria-hidden="true">
                          {spec.glyph}
                        </span>
                        {block.title}
                      </span>
                      {tier === 'full' && (
                        <span className="block-meta tnum">
                          {formatClock(block.span.start)}–{formatClock(block.span.end)}
                          {block.location ? ` · ${block.location}` : ''}
                        </span>
                      )}
                    </>
                  )}
                  <span className="sr-only">
                    {spec.label}, {formatClock(block.span.start)} to {formatClock(block.span.end)},{' '}
                    {spec.hard ? 'required' : 'planned by the app'}
                    {block.locked ? ', locked' : ''}
                  </span>
                </button>
              )
            })}

            {markers.map(({ block, top }) => (
              <button
                type="button"
                key={block.id}
                className="marker"
                style={{ top: `${top}%` }}
                aria-pressed={selectedId === block.id}
                onClick={() => onSelect(selectedId === block.id ? null : block.id)}
                title={`Due ${formatClock(block.span.start)} — ${block.title}`}
              >
                <span className="marker-label tnum">
                  {formatClock(block.span.start)} {block.title}
                </span>
                <span className="sr-only">
                  Deadline: {block.title} due at {formatClock(block.span.start)}
                </span>
              </button>
            ))}

            {todayOffset === day && nowMinutes !== null && nowMinutes >= windowStart && nowMinutes <= windowEnd && (
              <div
                className="now-line"
                style={{ top: `${((nowMinutes - windowStart) / windowLength) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Choose the drawn hour range from the content.
 *
 * A grid hardcoded to 05:00-23:30 spends a third of its height on empty rows
 * in a normal week, and that wasted height is exactly what makes the remaining
 * blocks too short to label. So the range is fitted to the content.
 *
 * Two things must NOT be allowed to drag the axis open, because each costs
 * every other block on the page:
 *
 *   - ZERO-LENGTH MARKERS. An all-day notice sits at 00:00 by convention. One
 *     of them would pull the axis down to midnight and add six dead rows.
 *     Markers are excluded; all-day notices get their own row entirely.
 *   - OVERNIGHT TAILS. Guard from 23:00 to 01:00 contributes one hour after
 *     midnight on the following day. Honouring it would open the axis to
 *     midnight for the sake of a single block. Tails shorter than
 *     `TAIL_THRESHOLD` are excluded here and surfaced by `clippedForDay`
 *     instead, so the obligation is still reported — just not by reshaping the
 *     whole week around it.
 */
const TAIL_THRESHOLD = 90

export function chooseHourRange(
  blocks: readonly PlanBlock[],
  wake: number,
  sleep: number,
): { dayStartHour: number; dayEndHour: number } {
  let earliest = wake
  let latest = sleep

  for (const block of blocks) {
    // Markers occupy no height and must not set the scale.
    if (block.span.end <= block.span.start) continue

    const startOfDay = block.span.start % 1440
    const crossesMidnight = Math.floor(block.span.end / 1440) > Math.floor(block.span.start / 1440)
    const endOfDay = crossesMidnight ? 1440 : block.span.end % 1440 === 0 ? 1440 : block.span.end % 1440

    if (endOfDay - startOfDay >= TAIL_THRESHOLD || startOfDay >= wake) {
      earliest = Math.min(earliest, startOfDay)
    }
    latest = Math.max(latest, endOfDay)

    if (crossesMidnight) {
      const tail = block.span.end % 1440
      // Only a substantial post-midnight run earns space on the axis.
      if (tail >= TAIL_THRESHOLD) earliest = 0
    }
  }

  const dayStartHour = Math.max(0, Math.floor(earliest / 60) - 1)
  const dayEndHour = Math.min(24, Math.ceil(latest / 60) + 1)
  return {
    dayStartHour,
    dayEndHour: Math.max(dayStartHour + 6, dayEndHour),
  }
}

/**
 * Blocks that overlap a day but fall outside the drawn window.
 *
 * Without this, an overnight duty is drawn on the day it starts and is simply
 * absent from the day it ends. Reporting it as an edge chip keeps the axis
 * compact AND keeps the obligation on the page, which is the pair of
 * properties that actually matter.
 */
export function clippedForDay(
  blocks: readonly PlanBlock[],
  day: number,
  windowStart: number,
  windowEnd: number,
): { before: PlanBlock[]; after: PlanBlock[] } {
  const dayFrom = day * 1440
  const dayTo = (day + 1) * 1440
  const before: PlanBlock[] = []
  const after: PlanBlock[] = []

  for (const block of blocks) {
    if (block.span.end <= block.span.start) continue
    if (block.span.start >= dayTo || block.span.end <= dayFrom) continue

    const localStart = Math.max(block.span.start - dayFrom, 0)
    const localEnd = Math.min(block.span.end - dayFrom, 1440)
    if (localEnd <= windowStart) before.push(block)
    else if (localStart >= windowEnd) after.push(block)
  }
  return { before, after }
}

/**
 * A study period the Corps put on the schedule, as opposed to a block this app
 * generated. Both carry `kind: 'study'`; what separates them is provenance —
 * a source event has an `eventId`, a generated one has a `taskId`.
 */
export function isDesignatedStudyWindow(block: PlanBlock): boolean {
  return (
    block.kind === 'study' &&
    block.eventId !== undefined &&
    block.taskId === undefined &&
    block.span.end > block.span.start
  )
}

/** All-day notices: zero length, pinned to midnight by convention. */
export function isAllDayNotice(block: PlanBlock): boolean {
  return block.span.end <= block.span.start && block.span.start % 1440 === 0
}
