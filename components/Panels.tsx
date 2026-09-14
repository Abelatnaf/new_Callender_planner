'use client'

import { kindSpec, KINDS } from '@/lib/domain/kinds'
import {
  DAY_NAMES,
  dayOf,
  formatClock,
  formatDuration,
  formatHours,
} from '@/lib/domain/time'
import type { Capacity, Conflict, PlanBlock, Task, Unplaced } from '@/lib/domain/types'
import { clusterConflicts, describeCluster } from '@/lib/engine/conflicts'

/* ===========================================================================
   Capacity — the most useful thing on the screen
   ===========================================================================
   Over-capacity is a feature. A planner that crushes 14.5 hours of work into
   9 hours of free time and then shows a tidy grid is lying to you, and the
   lie is the expensive kind: you find out on Thursday.
   ========================================================================= */

export function CapacityMeter({ capacity }: { capacity: Capacity }): React.ReactNode {
  const total = Math.max(1, capacity.placedMinutes + capacity.slackMinutes + capacity.unplacedMinutes)
  const pct = (minutes: number): string => `${(minutes / total) * 100}%`
  const oversubscribed = capacity.unplacedMinutes > 0

  return (
    <section className="card" aria-labelledby="capacity-title">
      <div className="card-head">
        <h3 id="capacity-title">Capacity</h3>
        <span className="pill" data-accent={oversubscribed ? 'terracotta' : 'sage'}>
          {oversubscribed ? 'Over capacity' : 'Fits'}
        </span>
      </div>

      <div className="capacity-bar" role="img" aria-label={capacityLabel(capacity)}>
        <div className="capacity-seg" data-seg="placed" style={{ width: pct(capacity.placedMinutes) }} />
        <div className="capacity-seg" data-seg="slack" style={{ width: pct(capacity.slackMinutes) }} />
        <div className="capacity-seg" data-seg="short" style={{ width: pct(capacity.unplacedMinutes) }} />
      </div>

      <div>
        <div className="metric-row">
          <span className="secondary">Work scheduled</span>
          <span className="metric tnum">{formatHours(capacity.placedMinutes)} h</span>
        </div>
        <div className="metric-row">
          <span className="secondary">Free time left</span>
          <span className="metric tnum">{formatHours(capacity.slackMinutes)} h</span>
        </div>
        <div className="metric-row">
          <span className="secondary">Work that did not fit</span>
          <span className="metric tnum" style={oversubscribed ? { color: 'var(--danger)' } : undefined}>
            {formatHours(capacity.unplacedMinutes)} h
          </span>
        </div>
        <div className="metric-row">
          <span className="secondary">Committed to the Institute</span>
          <span className="metric tnum">
            {formatHours(capacity.byDay.reduce((sum, d) => sum + d.hardMinutes, 0))} h
          </span>
        </div>
      </div>

      <h4 className="label" style={{ marginTop: 'var(--space-md)', marginBottom: 'var(--space-xs)' }}>
        By day
      </h4>
      <ul className="item-list">
        {capacity.byDay.map((day) => {
          const span = Math.max(1, day.hardMinutes + day.freeMinutes)
          return (
            <li key={day.day} style={{ display: 'grid', gridTemplateColumns: '2.6rem 1fr 4.2rem', gap: 'var(--space-sm)', alignItems: 'center' }}>
              <span className="label" style={{ letterSpacing: '0.04em' }}>
                {DAY_NAMES[day.day]?.slice(0, 3)}
              </span>
              <span className="capacity-bar" style={{ margin: 0, height: 7 }}>
                <span className="capacity-seg" data-seg="placed" style={{ width: `${(day.studyMinutes / span) * 100}%` }} />
                <span
                  className="capacity-seg"
                  data-seg="slack"
                  style={{ width: `${(Math.max(0, day.freeMinutes - day.studyMinutes) / span) * 100}%` }}
                />
              </span>
              <span className="metric tnum" style={{ fontSize: 11, textAlign: 'right' }}>
                {formatHours(day.freeMinutes)} h free
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function capacityLabel(capacity: Capacity): string {
  return `${formatHours(capacity.placedMinutes)} hours scheduled, ${formatHours(capacity.slackMinutes)} hours free, ${formatHours(capacity.unplacedMinutes)} hours unplaced`
}

/* ===========================================================================
   Conflicts — reported, never resolved
   ========================================================================= */

/**
 * `conflicts` is every PAIRWISE overlap in the hard layer, which is complete
 * but unreadable the moment three or more things land in one slot — five
 * alternative activities in one window is C(5,2) = 10 pairwise lines for what
 * a cadet sees as one collision. `clusterConflicts` groups any conflicts that
 * share an obligation into one moment, so this renders "5 things compete for
 * 16:35–18:35: A, B, C, D, E" once instead of ten near-duplicate sentences.
 */
export function ConflictBanner({ conflicts }: { conflicts: Conflict[] }): React.ReactNode {
  const clusters = clusterConflicts(conflicts)
  if (clusters.length === 0) return null
  const blocking = clusters.filter((c) => c.severity === 'blocking').length

  const byDay = new Map<number, typeof clusters>()
  for (const cluster of clusters) {
    const day = dayOf(cluster.span.start)
    byDay.set(day, [...(byDay.get(day) ?? []), cluster])
  }

  return (
    <section className={blocking > 0 ? 'banner' : 'banner warn'} aria-labelledby="conflicts-title">
      <h3 id="conflicts-title">
        {clusters.length} moment{clusters.length === 1 ? '' : 's'} this week{' '}
        {clusters.length === 1 ? 'has' : 'have'} obligations colliding
      </h3>
      <p style={{ margin: '2px 0 0', fontSize: 13 }}>
        The app will not pick a winner. An institutional double-booking is a fact about your week that
        needs a human to resolve, and hiding one of them would be worse than showing all of them.
      </p>
      <div className="stack tight" style={{ marginTop: 'var(--space-sm)' }}>
        {[...byDay.entries()].map(([day, dayClusters]) => (
          <div key={day}>
            <div className="label" style={{ margin: '6px 0 2px' }}>
              {DAY_NAMES[day]}
            </div>
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {dayClusters.map((cluster, index) => (
                <li key={index} style={{ fontSize: 13, margin: '3px 0' }}>
                  <strong className="tnum">
                    {formatClock(cluster.span.start)}–{formatClock(cluster.span.end)}
                  </strong>{' '}
                  — {cluster.items.length} thing{cluster.items.length === 1 ? '' : 's'} compete for this window:{' '}
                  {describeCluster(cluster)}.
                  {cluster.severity === 'overlap' && (
                    <span className="item-note"> One normally takes precedence, but the app will not decide.</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ===========================================================================
   Unplaced work — names the binding constraint
   ========================================================================= */

const REASON_LABEL: Record<Unplaced['reason'], string> = {
  no_window_before_due: 'No window before the deadline',
  daily_cap_reached: 'Daily study ceiling reached',
  no_window_long_enough: 'No window long enough',
  week_exhausted: 'Week exhausted',
  due_before_week: 'Already overdue',
}

export function UnplacedList({ unplaced }: { unplaced: Unplaced[] }): React.ReactNode {
  if (unplaced.length === 0) return null

  return (
    <section className="card" aria-labelledby="unplaced-title" style={{ borderLeft: '3px solid var(--danger)' }}>
      <div className="card-head">
        <h3 id="unplaced-title">Did not fit</h3>
        <span className="pill" data-accent="terracotta">
          {formatHours(unplaced.reduce((sum, u) => sum + u.minutes, 0))} h
        </span>
      </div>
      <ul className="item-list">
        {unplaced.map((item, index) => (
          <li className="item" key={`${item.taskId}-${index}`}>
            <div className="item-body">
              <span className="item-title">
                {item.title}
                {item.chunkLabel !== 'session' ? ` · ${item.chunkLabel}` : ''}
              </span>
              <span className="pill" data-accent="terracotta" style={{ margin: '3px 0' }}>
                {REASON_LABEL[item.reason]}
              </span>
              <span className="item-note">{item.detail}</span>
            </div>
            <span className="metric tnum" style={{ whiteSpace: 'nowrap' }}>
              {formatDuration(item.minutes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ===========================================================================
   Narrative — deterministic prose, no model involved
   ========================================================================= */

export function NarrativeCard({ narrative }: { narrative: string[] }): React.ReactNode {
  if (narrative.length === 0) return null
  return (
    <section className="card accent-top" aria-labelledby="read-title">
      <h3 id="read-title" className="label" style={{ marginBottom: 'var(--space-sm)' }}>
        The read on your week
      </h3>
      <div className="narrative">
        {narrative.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
    </section>
  )
}

/* ===========================================================================
   Inspector — why this block is here
   ========================================================================= */

export function Inspector({
  block,
  task,
  locked,
  onToggleLock,
  onClear,
}: {
  block: PlanBlock | null
  task: Task | null
  locked: boolean
  onToggleLock: () => void
  onClear: () => void
}): React.ReactNode {
  if (!block) {
    return (
      <aside className="card inspector" aria-live="polite">
        <h3 className="label">Selected block</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          Pick a block on the grid to see what it is, and — for anything the app scheduled — why it
          landed there.
        </p>
        <div className="legend" style={{ marginTop: 'var(--space-md)' }}>
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--ink-tint)', borderLeftColor: 'var(--ink)', borderLeftStyle: 'solid' }} />
            Solid edge — the Institute decided
          </span>
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--sage-tint)', borderLeftColor: 'var(--sage)', borderLeftStyle: 'dashed' }} />
            Dashed edge — the app decided
          </span>
        </div>
      </aside>
    )
  }

  const spec = kindSpec(block.kind)
  const duration = block.span.end - block.span.start
  const generated = block.kind === 'study' || block.kind === 'recharge'

  return (
    <aside className="card inspector" aria-live="polite">
      <div className="card-head">
        <h3 className="label">Selected block</h3>
        <button type="button" className="button ghost small" onClick={onClear}>
          Close
        </button>
      </div>

      <h2 style={{ marginBottom: 'var(--space-xs)' }}>{block.title}</h2>
      <p className="secondary tnum" style={{ margin: '0 0 var(--space-sm)' }}>
        {DAY_NAMES[dayOf(block.span.start)]} · {formatClock(block.span.start)}–
        {formatClock(block.span.end)} · {formatDuration(duration)}
      </p>

      <div className="button-row" style={{ marginBottom: 'var(--space-md)' }}>
        <span className="pill" data-accent={spec.accent}>
          {spec.glyph} {spec.label}
        </span>
        <span className="pill">{spec.hard ? 'Required' : 'Planned by the app'}</span>
        {block.course && <span className="pill">{block.course}</span>}
      </div>

      {block.location && (
        <div className="metric-row">
          <span className="secondary">Where</span>
          <span>{block.location}</span>
        </div>
      )}
      {block.uniform && (
        <div className="metric-row">
          <span className="secondary">Uniform</span>
          <span>{block.uniform}</span>
        </div>
      )}
      {task && (
        <>
          <div className="metric-row">
            <span className="secondary">Estimate</span>
            <span className="tnum">
              {formatDuration(task.estimateMinutes)}{' '}
              <span className="muted">({task.estimateSource})</span>
            </span>
          </div>
          {task.dueAt !== null && (
            <div className="metric-row">
              <span className="secondary">Due</span>
              <span className="tnum">
                {DAY_NAMES[dayOf(task.dueAt)]} {formatClock(task.dueAt)}
              </span>
            </div>
          )}
        </>
      )}

      {block.because && block.because.length > 0 && (
        <>
          <h4 className="label" style={{ marginTop: 'var(--space-md)', marginBottom: 'var(--space-xs)' }}>
            Why here
          </h4>
          <ul className="item-list">
            {block.because.map((line, index) => (
              <li key={index} className="item-note">
                {line}
              </li>
            ))}
          </ul>
        </>
      )}

      {generated && (
        <div style={{ marginTop: 'var(--space-md)' }}>
          <button type="button" className={locked ? 'button' : 'button secondary'} onClick={onToggleLock}>
            {locked ? 'Unlock this block' : 'Lock this block'}
          </button>
          <p className="item-note" style={{ marginTop: 'var(--space-xs)' }}>
            A locked block is promoted into the hard layer on the next run: everything else is rebuilt
            around it. That is what replaces drag-and-drop.
          </p>
        </div>
      )}
    </aside>
  )
}

/* ===========================================================================
   Legend — the kind vocabulary, in one place
   ========================================================================= */

export function KindLegend(): React.ReactNode {
  const shown = KINDS.filter((k) => !['recharge', 'open', 'travel', 'athletics'].includes(k))
  return (
    <div className="legend">
      {shown.map((kind) => {
        const spec = kindSpec(kind)
        return (
          <span className="legend-item" key={kind}>
            <span
              className="legend-swatch"
              style={{
                background: `var(--${spec.accent}-tint)`,
                borderLeftColor: `var(--${spec.accent})`,
                borderLeftStyle: spec.hard ? 'solid' : 'dashed',
              }}
            />
            {spec.glyph} {spec.label}
          </span>
        )
      })}
    </div>
  )
}
