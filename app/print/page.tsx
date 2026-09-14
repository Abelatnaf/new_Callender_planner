'use client'

import { useMemo } from 'react'
import { usePlanner } from '@/components/PlannerProvider'
import { kindSpec } from '@/lib/domain/kinds'
import {
  DAY_ABBR,
  DAY_NAMES,
  addDays,
  atDay,
  formatClock,
  formatDuration,
  formatHours,
  isoWeekLabel,
  parseLocalDate,
} from '@/lib/domain/time'
import { choosePrintRange, layoutPrintWeek } from '@/lib/print/layout'
import { clusterConflicts, describeCluster } from '@/lib/engine/conflicts'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * The printed sheet, as a weekly operations order.
 *
 * The form is not decoration. A cadet already knows how to read an operations
 * order — a designation block that says whose it is and which period it
 * covers, numbered paragraphs you can be told to go look at, and a sources
 * line that says what it was built from. Borrowing that structure makes the
 * document legible at a glance to the one person who has to use it, which a
 * generic grid-and-two-lists layout does not.
 *
 * Three decisions that changed from the earlier version, each for a reason:
 *
 *   1. THE SUMMARY LEADS. The capacity read and the shortfall were on page
 *      three, behind the grid and the agenda. They are the only part that
 *      changes a decision, so they go at the top of page one.
 *   2. PARAGRAPHS ARE NUMBERED. Numbering is only honest when order carries
 *      information; here it does, because it makes the document referenceable
 *      — "para 5" is the friction list, on this sheet and every other week's.
 *   3. THE DOCUMENT NAMES ITS SOURCES. Which matrix file, which course file,
 *      when Canvas was last fetched, which engine version and input
 *      fingerprint. A plan you cannot trace back to its inputs is a plan you
 *      cannot check when it turns out to be wrong.
 */
export default function PrintPage(): React.ReactNode {
  const { state, week, hydrating } = usePlanner()
  const plan = week.plan

  const range = useMemo(
    () => choosePrintRange(plan.blocks, state.preferences.wake, state.preferences.sleep),
    [plan.blocks, state.preferences.wake, state.preferences.sleep],
  )
  const cells = useMemo(() => layoutPrintWeek(plan.blocks, range), [plan.blocks, range])
  const rows = cells.rows
  const conflictClusters = useMemo(() => clusterConflicts(plan.conflicts), [plan.conflicts])

  if (hydrating) return <p className="muted">Preparing the sheet…</p>

  const from = parseLocalDate(state.selectedWeek)
  const to = parseLocalDate(addDays(state.selectedWeek, 6))
  const period =
    from.m === to.m
      ? `${from.d}–${to.d} ${MONTHS[to.m - 1]} ${to.y}`
      : `${from.d} ${MONTHS[from.m - 1]} – ${to.d} ${MONTHS[to.m - 1]} ${to.y}`

  const capacity = plan.capacity
  const committed = capacity.byDay.reduce((sum, d) => sum + d.hardMinutes, 0)
  const deadlines = [...week.tasks].filter((t) => t.dueAt !== null).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
  const short = capacity.unplacedMinutes > 0

  const designation = [
    state.profile.name.trim() || 'Cadet',
    state.profile.company.trim() ? `${state.profile.company.trim()} Co` : null,
    state.profile.classYear.trim() ? `Class of ${state.profile.classYear.trim()}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  /** Repeated at the foot of every page, so a dropped page is noticed. */
  const Foot = ({ page }: { page: number }): React.ReactNode => (
    <div className="ord-foot">
      <span>
        ORDER · <span className="tnum">{isoWeekLabel(state.selectedWeek)}</span> · {designation}
      </span>
      <span className="tnum">
        engine {plan.engineVersion} · {plan.inputsFingerprint} · page {page} of 3
      </span>
    </div>
  )

  const Masthead = ({ para, title }: { para: string; title: string }): React.ReactNode => (
    <header className="ord-head">
      <div className="ord-mark">
        <span className="ord-wordmark">ORDER</span>
        <span className="ord-rule" aria-hidden="true" />
        <span className="ord-kind">Weekly operations order</span>
      </div>
      <div className="ord-para-label">
        <span className="ord-para-no tnum">{para}</span>
        {title}
      </div>
      <dl className="ord-designation">
        <div>
          <dt>Period</dt>
          <dd className="tnum">{period}</dd>
        </div>
        <div>
          <dt>Week</dt>
          <dd className="tnum">{isoWeekLabel(state.selectedWeek)}</dd>
        </div>
        <div>
          <dt>For</dt>
          <dd>{designation}</dd>
        </div>
      </dl>
    </header>
  )

  return (
    <>
      <header className="page-head no-print">
        <div>
          <h1>The order</h1>
          <p>
            Three pages, exactly as they will print. There is no separate renderer and no export
            step — this page is the artifact, so what you approve here is what you carry.
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={() => window.print()}>
            Print · save as PDF
          </button>
        </div>
      </header>

      <div className="sheet-preview">
        {/* ============ PAGE 1 — situation and time ============ */}
        <section className="sheet-page">
          <Masthead para="1" title="Situation" />

          {/*
            The read leads. These are the only figures on the sheet that change
            what a cadet does next, so they are not buried behind the grid.
          */}
          <div className="ord-situation">
            <div className="ord-figures">
              <div className="ord-figure">
                <span className="ord-figure-label">Committed</span>
                <span className="ord-figure-value tnum">{formatHours(committed)}<i>h</i></span>
                <span className="ord-figure-note">by the Institute</span>
              </div>
              <div className="ord-figure">
                <span className="ord-figure-label">Yours</span>
                <span className="ord-figure-value tnum">{formatHours(capacity.freeMinutes)}<i>h</i></span>
                <span className="ord-figure-note">usable free time</span>
              </div>
              <div className="ord-figure">
                <span className="ord-figure-label">Tasked</span>
                <span className="ord-figure-value tnum">{formatHours(capacity.placedMinutes)}<i>h</i></span>
                <span className="ord-figure-note">work scheduled</span>
              </div>
              <div className="ord-figure" data-alert={short}>
                <span className="ord-figure-label">Shortfall</span>
                <span className="ord-figure-value tnum">{formatHours(capacity.unplacedMinutes)}<i>h</i></span>
                <span className="ord-figure-note">{short ? 'did not fit — see para 5' : 'all work fits'}</span>
              </div>
            </div>

            <div className="ord-read">
              {plan.narrative.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </div>

          <div className="ord-para-label ord-para-inline">
            <span className="ord-para-no tnum">2</span>
            Time
          </div>

          <table className="print-week">
            <thead>
              <tr>
                <th className="print-time" scope="col">
                  Hr
                </th>
                {DAY_ABBR.map((abbr, day) => {
                  const date = parseLocalDate(addDays(state.selectedWeek, day))
                  const carried = cells.carriedIn.get(day) ?? []
                  return (
                    <th key={abbr} scope="col" data-weekend={day >= 5}>
                      {abbr} <span className="tnum">{date.d}</span>
                      {carried.map((block) => (
                        <span className="print-carried tnum" key={block.id}>
                          {kindSpec(block.kind).glyph} {block.title} until {formatClock(block.span.end)}
                        </span>
                      ))}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((minute, rowIndex) => (
                <tr key={minute} data-hour={minute % 60 === 0}>
                  <th className="print-time" scope="row">
                    {minute % 60 === 0 ? formatClock(minute, { colon: false }) : ''}
                  </th>
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                    const key = `${day}:${rowIndex}`
                    const entry = cells.starts.get(key)
                    if (entry) {
                      const spec = kindSpec(entry.block.kind)
                      const hard = entry.block.locked || (spec.hard && entry.block.kind !== 'study')
                      return (
                        <td key={day} className="print-slot" rowSpan={entry.span} data-weekend={day >= 5}>
                          <span className="print-block" data-hard={hard}>
                            <span className="print-glyph">{spec.glyph}</span>
                            {entry.offGrid && (
                              <span className="print-exact tnum">
                                {formatClock(entry.startMinute, { colon: false })}{' '}
                              </span>
                            )}
                            <span className="print-title">{entry.block.title}</span>
                            {entry.span > 1 && entry.block.location ? ` · ${entry.block.location}` : ''}
                          </span>
                        </td>
                      )
                    }
                    if (cells.occupied.has(key)) return null
                    return <td key={day} className="print-slot" data-weekend={day >= 5} />
                  })}
                </tr>
              ))}
            </tbody>
            {/* The arithmetic belongs beside the grid it describes. */}
            <tfoot>
              <tr>
                <th className="print-time" scope="row">
                  Free
                </th>
                {capacity.byDay.map((day) => (
                  <td key={day.day} className="ord-daytotal tnum" data-weekend={day.day >= 5}>
                    {formatHours(day.freeMinutes)}h
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>

          <div className="print-legend">
            <span>
              <strong>Solid edge</strong> — the Institute decided
            </span>
            <span>
              <strong>Dashed edge</strong> — the app decided; move it freely
            </span>
            {(['formation', 'class', 'lab', 'study', 'duty', 'meal', 'exam'] as const).map((kind) => (
              <span key={kind}>
                <strong>{kindSpec(kind).glyph}</strong> {kindSpec(kind).label}
              </span>
            ))}
          </div>

          <Foot page={1} />
        </section>

        {/* ============ PAGE 2 — execution ============ */}
        <section className="sheet-page">
          <Masthead para="3" title="Execution" />
          <p className="ord-instruction">
            One column per day, in order. Tick as you go. A shaded box is an obligation; an open box
            is work this plan placed and you may move.
          </p>

          <div className="print-agenda">
            {[0, 1, 2, 3, 4, 5, 6].map((day) => {
              const dayFrom = atDay(day, 0)
              const dayTo = atDay(day + 1, 0)
              const items = plan.blocks
                .filter((b) => b.kind !== 'open')
                .filter((b) =>
                  b.span.end > b.span.start
                    ? b.span.start < dayTo && b.span.end > dayFrom
                    : b.span.start >= dayFrom && b.span.start < dayTo,
                )
                .sort((a, b) => Math.max(a.span.start, dayFrom) - Math.max(b.span.start, dayFrom))
              const dayCapacity = capacity.byDay[day]
              const date = parseLocalDate(addDays(state.selectedWeek, day))

              return (
                <div className="print-day" key={day} data-weekend={day >= 5}>
                  <h3>
                    <span>
                      {DAY_NAMES[day]} <span className="tnum">{date.d}</span>
                    </span>
                    <span className="tnum print-day-free">
                      {dayCapacity ? `${formatHours(dayCapacity.freeMinutes)}h free` : ''}
                    </span>
                  </h3>
                  {items.length === 0 ? (
                    <p className="ord-empty-day">No obligations. The whole day is yours.</p>
                  ) : (
                    <ul>
                      {items.map((block) => {
                        const spec = kindSpec(block.kind)
                        const hard = spec.hard && block.kind !== 'study'
                        const zero = block.span.end <= block.span.start
                        const allDay = zero && block.span.start % 1440 === 0
                        const continues = block.span.start < dayFrom
                        const when = allDay
                          ? 'all day'
                          : zero
                            ? `due ${formatClock(block.span.start)}`
                            : continues
                              ? `until ${formatClock(block.span.end)}`
                              : formatClock(block.span.start)
                        return (
                          <li key={`${day}-${block.id}`}>
                            <span className="print-tick" data-hard={hard} aria-hidden="true" />
                            <span className="print-when">{when}</span>
                            <span className="print-what">
                              {spec.glyph} {block.title}
                              {block.location || block.uniform ? (
                                <span className="print-where">
                                  {' '}
                                  {[block.location, block.uniform].filter(Boolean).join(' · ')}
                                </span>
                              ) : null}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>

          <Foot page={2} />
        </section>

        {/* ============ PAGE 3 — deadlines, friction, sources ============ */}
        <section className="sheet-page">
          <Masthead para="4" title="Deadlines" />

          {deadlines.length === 0 ? (
            <p className="ord-instruction">No deadlines fall in this period.</p>
          ) : (
            <table className="print-table">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Course</th>
                  <th>Due</th>
                  <th>Effort</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>
                {deadlines.map((task) => {
                  const blocks = plan.blocks.filter((b) => b.taskId === task.id)
                  const missing = plan.unplaced.filter((u) => u.taskId === task.id)
                  const due = task.dueAt ?? 0
                  return (
                    <tr key={task.id} data-alert={missing.length > 0}>
                      <td>{task.title}</td>
                      <td className="tnum">{task.course ?? '—'}</td>
                      <td className="tnum">
                        {due >= 10080 ? 'next period' : `${DAY_ABBR[Math.floor(due / 1440)]} ${formatClock(due)}`}
                      </td>
                      <td className="tnum">{formatDuration(task.estimateMinutes)}</td>
                      <td className="tnum">
                        {missing.length > 0
                          ? `✗ ${missing.length} short`
                          : blocks.length > 0
                            ? `✓ ${blocks.length}`
                            : task.status === 'done'
                              ? '✓ done'
                              : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="ord-para-label ord-para-inline">
            <span className="ord-para-no tnum">5</span>
            Friction
          </div>

          {conflictClusters.length === 0 && plan.unplaced.length === 0 ? (
            <p className="ord-instruction">
              No collisions and no unplaced work. Everything the Institute requires and everything
              you owe both fit inside this period.
            </p>
          ) : (
            <>
              {conflictClusters.map((cluster, index) => (
                <div className="print-notice" key={index}>
                  <strong>
                    Collision · {DAY_NAMES[Math.floor(cluster.span.start / 1440)]}{' '}
                    <span className="tnum">
                      {formatClock(cluster.span.start)}–{formatClock(cluster.span.end)}
                    </span>
                  </strong>
                  {cluster.items.length} thing{cluster.items.length === 1 ? '' : 's'} compete for this window:{' '}
                  {describeCluster(cluster)}.
                  {cluster.severity === 'overlap' ? ' One normally takes precedence, but this sheet does not decide.' : ''}
                </div>
              ))}

              {plan.unplaced.length > 0 && (
                <table className="print-table ord-unplaced">
                  <thead>
                    <tr>
                      <th>Work that did not fit</th>
                      <th>Needs</th>
                      <th>Binding constraint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.unplaced.map((item, index) => (
                      <tr key={`${item.taskId}-${index}`} data-alert>
                        <td>
                          {item.title}
                          {item.chunkLabel !== 'session' ? ` · ${item.chunkLabel}` : ''}
                        </td>
                        <td className="tnum">{formatDuration(item.minutes)}</td>
                        <td>{item.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          <div className="ord-para-label ord-para-inline">
            <span className="ord-para-no tnum">6</span>
            Sources
          </div>

          {/*
            Provenance. A plan you cannot trace back to its inputs is a plan you
            cannot check when it turns out to be wrong — and the first real
            matrix will make something wrong.
          */}
          <table className="print-table ord-sources">
            <tbody>
              <tr>
                <th scope="row">Cadetship matrix</th>
                <td>{state.matrix ? state.matrix.filename : 'not provided'}</td>
                <td className="tnum">
                  {week.reports.find((r) => r.label === 'Cadetship matrix')?.eventCount ?? 0} events
                </td>
              </tr>
              <tr>
                <th scope="row">Course schedule</th>
                <td>{state.term ? state.term.filename : 'not provided'}</td>
                <td className="tnum">
                  {week.reports.find((r) => r.label === 'Course schedule')?.eventCount ?? 0} meetings
                </td>
              </tr>
              <tr>
                <th scope="row">Canvas calendar</th>
                <td>
                  {state.canvas
                    ? `${state.canvas.label} · fetched ${state.canvas.fetchedAt.slice(0, 16).replace('T', ' ')}`
                    : 'not connected'}
                </td>
                <td className="tnum">{week.tasks.filter((t) => t.canvasUid).length} deadlines</td>
              </tr>
              <tr>
                <th scope="row">Added by hand</th>
                <td>
                  {state.manualEvents.length} recurring obligation
                  {state.manualEvents.length === 1 ? '' : 's'}, {state.manualTasks.length} task
                  {state.manualTasks.length === 1 ? '' : 's'}
                </td>
                <td className="tnum">—</td>
              </tr>
              <tr>
                <th scope="row">Engine</th>
                <td className="tnum">
                  version {plan.engineVersion} · inputs {plan.inputsFingerprint}
                </td>
                <td className="tnum">deterministic</td>
              </tr>
            </tbody>
          </table>

          <p className="ord-colophon">
            Ink is obligation. White space is freedom. Same inputs and same engine version reproduce
            this sheet exactly — quote the fingerprint if it is ever wrong.
          </p>

          <Foot page={3} />
        </section>
      </div>
    </>
  )
}
