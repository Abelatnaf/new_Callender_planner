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
  parseLocalDate,
} from '@/lib/domain/time'
import { choosePrintRange, layoutPrintWeek } from '@/lib/print/layout'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Row resolution on paper. 30 minutes keeps a Letter page to ~36 rows. */
const ROW_MINUTES = 30

export default function PrintPage(): React.ReactNode {
  const { state, week, hydrating } = usePlanner()
  const plan = week.plan

  const range = useMemo(
    () => choosePrintRange(plan.blocks, state.preferences.wake, state.preferences.sleep),
    [plan.blocks, state.preferences.wake, state.preferences.sleep],
  )

  const cells = useMemo(() => layoutPrintWeek(plan.blocks, range), [plan.blocks, range])
  const rows = cells.rows

  if (hydrating) return <p className="muted">Preparing the sheet…</p>

  const start = parseLocalDate(state.selectedWeek)
  const end = parseLocalDate(addDays(state.selectedWeek, 6))
  const title = `${MONTHS[start.m - 1]} ${start.d} – ${start.m === end.m ? end.d : `${MONTHS[end.m - 1]} ${end.d}`}, ${end.y}`

  const deadlines = [...week.tasks]
    .filter((t) => t.dueAt !== null)
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))

  return (
    <>
      <header className="page-head no-print">
        <div>
          <h1>Print sheet</h1>
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
        {/* ---- Page 1: the week ------------------------------------------ */}
        <section className="sheet-page">
          <div className="sheet-head">
            <h1>ORDER</h1>
            <div>
              <div className="sheet-sub">{title}</div>
              <div className="item-note tnum">
                {state.profile.name || 'Cadet'}
                {state.profile.company ? ` · ${state.profile.company} Co` : ''}
                {state.profile.classYear ? ` · ${state.profile.classYear}` : ''}
              </div>
            </div>
          </div>

          <table className="print-week">
            <thead>
              <tr>
                <th className="print-time" scope="col">
                  Time
                </th>
                {DAY_ABBR.map((abbr, day) => {
                  const date = parseLocalDate(addDays(state.selectedWeek, day))
                  const carried = cells.carriedIn.get(day) ?? []
                  return (
                    <th key={abbr} scope="col">
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
                        <td key={day} className="print-slot" rowSpan={entry.span}>
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
                    return <td key={day} className="print-slot" />
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="print-legend">
            <span>
              <strong>Solid edge</strong> — the Institute decided
            </span>
            <span>
              <strong>Dashed edge</strong> — the app decided; move it freely
            </span>
            {(['formation', 'class', 'study', 'duty', 'meal', 'exam'] as const).map((kind) => (
              <span key={kind}>
                <strong>{kindSpec(kind).glyph}</strong> {kindSpec(kind).label}
              </span>
            ))}
          </div>
        </section>

        {/* ---- Page 2: the day agenda ----------------------------------- */}
        <section className="sheet-page">
          <div className="sheet-head">
            <h1>The days</h1>
            <div className="sheet-sub">Tick as you go</div>
          </div>

          <div className="print-agenda">
            {[0, 1, 2, 3, 4, 5, 6].map((day) => {
              const dayFrom = atDay(day, 0)
              const dayTo = atDay(day + 1, 0)
              /**
               * Overlap, not start-of-day.
               *
               * Guard that runs 23:00 Friday to 01:00 Saturday is an
               * obligation on both days. Filtering by start date drops it from
               * Saturday entirely, and a printed page that silently omits an
               * obligation is worse than no printed page.
               */
              const items = plan.blocks
                .filter((b) => b.kind !== 'open')
                .filter((b) =>
                  b.span.end > b.span.start
                    ? b.span.start < dayTo && b.span.end > dayFrom
                    : b.span.start >= dayFrom && b.span.start < dayTo,
                )
                .sort((a, b) => Math.max(a.span.start, dayFrom) - Math.max(b.span.start, dayFrom))
              const dayCapacity = plan.capacity.byDay[day]
              const date = parseLocalDate(addDays(state.selectedWeek, day))

              return (
                <div className="print-day" key={day}>
                  <h3>
                    <span>
                      {DAY_NAMES[day]} <span className="tnum">{date.d}</span>
                    </span>
                    <span className="tnum" style={{ fontWeight: 500 }}>
                      {dayCapacity ? `${formatHours(dayCapacity.freeMinutes)}h free` : ''}
                    </span>
                  </h3>
                  {items.length === 0 ? (
                    <p className="item-note" style={{ margin: 0 }}>
                      Nothing scheduled. The whole day is yours.
                    </p>
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
        </section>

        {/* ---- Page 3: deadlines, conflicts, what did not fit ------------ */}
        <section className="sheet-page">
          <div className="sheet-head">
            <h1>The read</h1>
            <div className="sheet-sub">Deadlines, collisions, and what did not fit</div>
          </div>

          <div className="print-narrative">
            {plan.narrative.map((line, index) => (
              <p key={index} style={{ margin: '0 0 4px' }}>
                {line}
              </p>
            ))}
          </div>

          <h2 className="print-section-title">Deadlines</h2>
          {deadlines.length === 0 ? (
            <p className="item-note">No deadlines this week.</p>
          ) : (
            <table className="print-table">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Course</th>
                  <th>Due</th>
                  <th>Effort</th>
                  <th>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {deadlines.map((task) => {
                  const blocks = plan.blocks.filter((b) => b.taskId === task.id)
                  const missing = plan.unplaced.filter((u) => u.taskId === task.id)
                  const due = task.dueAt ?? 0
                  return (
                    <tr key={task.id}>
                      <td>{task.title}</td>
                      <td>{task.course ?? '—'}</td>
                      <td className="tnum">
                        {due >= 10080
                          ? 'next week'
                          : `${DAY_ABBR[Math.floor(due / 1440)]} ${formatClock(due)}`}
                      </td>
                      <td className="tnum">{formatDuration(task.estimateMinutes)}</td>
                      <td>
                        {missing.length > 0
                          ? `✗ ${missing.length} piece${missing.length === 1 ? '' : 's'} unplaced`
                          : blocks.length > 0
                            ? `✓ ${blocks.length} block${blocks.length === 1 ? '' : 's'}`
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

          {plan.conflicts.length > 0 && (
            <>
              <h2 className="print-section-title">Collisions</h2>
              {plan.conflicts.map((conflict, index) => (
                <div className="print-notice" key={index}>
                  <strong>
                    {DAY_NAMES[Math.floor(conflict.span.start / 1440)]}{' '}
                    <span className="tnum">
                      {formatClock(conflict.span.start)}–{formatClock(conflict.span.end)}
                    </span>
                  </strong>
                  {conflict.note}
                </div>
              ))}
            </>
          )}

          {plan.unplaced.length > 0 && (
            <>
              <h2 className="print-section-title">Did not fit</h2>
              <table className="print-table">
                <thead>
                  <tr>
                    <th>Work</th>
                    <th>Needs</th>
                    <th>Why not</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.unplaced.map((item, index) => (
                    <tr key={`${item.taskId}-${index}`}>
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
            </>
          )}

          <div className="print-legend">
            <span>
              Engine <span className="tnum">{plan.engineVersion}</span>
            </span>
            <span>
              Fingerprint <span className="tnum">{plan.inputsFingerprint}</span>
            </span>
            <span>Ink is obligation. White space is freedom.</span>
          </div>
        </section>
      </div>
    </>
  )
}
