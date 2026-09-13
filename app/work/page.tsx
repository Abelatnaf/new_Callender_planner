'use client'

import { useState } from 'react'
import { usePlanner } from '@/components/PlannerProvider'
import { DAY_NAMES, atDay, dayOf, formatClock, formatDuration } from '@/lib/domain/time'
import { KINDS, kindSpec } from '@/lib/domain/kinds'
import type { Task } from '@/lib/domain/types'
import { simpleHash } from '@/lib/parse/matrix'

export default function WorkPage(): React.ReactNode {
  const { state, week, addManualTask, removeManualTask, overrideTask, addManualEvent, removeManualEvent, setPatch, patch } =
    usePlanner()

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Work</h1>
          <p>
            Canvas is not the only source of truth, and often not a complete one — plenty of
            instructors never publish due dates to the calendar. Typing work in by hand is a
            first-class path here, not a fallback.
          </p>
        </div>
      </header>

      <ReplanBox tasks={week.tasks} patch={patch} onPatch={setPatch} />

      <AddTask onAdd={addManualTask} />

      <section className="card">
        <div className="card-head">
          <h2>Open work</h2>
          <span className="pill">
            {formatDuration(
              week.tasks.filter((t) => t.status !== 'done').reduce((sum, t) => sum + t.estimateMinutes, 0),
            )}{' '}
            owed
          </span>
        </div>

        {week.tasks.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Nothing open. Connect Canvas or add a task above.
          </p>
        ) : (
          <table className="sheet">
            <thead>
              <tr>
                <th>Task</th>
                <th>Due</th>
                <th style={{ width: 120 }}>Estimate</th>
                <th style={{ width: 90 }}>Status</th>
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {[...week.tasks]
                .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
                .map((task) => {
                  const key = task.canvasUid ?? task.id
                  const scheduled = week.plan.blocks.filter((b) => b.taskId === task.id)
                  const unplaced = week.plan.unplaced.filter((u) => u.taskId === task.id)
                  return (
                    <tr key={task.id}>
                      <td>
                        <strong>{task.title}</strong>
                        <div className="item-note">
                          {task.course ? `${task.course} · ` : ''}
                          {scheduled.length > 0
                            ? `${scheduled.length} block${scheduled.length === 1 ? '' : 's'} scheduled`
                            : 'not scheduled'}
                          {unplaced.length > 0 && (
                            <span style={{ color: 'var(--danger)' }}>
                              {' '}
                              · {unplaced.length} piece{unplaced.length === 1 ? '' : 's'} did not fit
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="tnum">
                        {task.dueAt === null ? (
                          <span className="muted">—</span>
                        ) : task.dueAt >= 10080 ? (
                          <span className="muted">next week</span>
                        ) : (
                          `${DAY_NAMES[dayOf(task.dueAt)]?.slice(0, 3)} ${formatClock(task.dueAt)}`
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          min={5}
                          max={1200}
                          step={5}
                          value={task.estimateMinutes}
                          aria-label={`Estimate in minutes for ${task.title}`}
                          onChange={(event) => {
                            const minutes = Number(event.target.value)
                            if (Number.isFinite(minutes)) overrideTask(key, { estimateMinutes: minutes })
                          }}
                          style={{ padding: '0.25rem 0.4rem', fontSize: 12 }}
                        />
                        <span className="item-note">
                          {task.estimateSource === 'user' ? 'yours — permanent' : `${task.estimateSource} guess`}
                        </span>
                      </td>
                      <td>
                        <select
                          value={task.status}
                          aria-label={`Status for ${task.title}`}
                          onChange={(event) =>
                            overrideTask(key, { status: event.target.value as Task['status'] })
                          }
                          style={{ padding: '0.25rem 0.3rem', fontSize: 12 }}
                        >
                          <option value="todo">To do</option>
                          <option value="doing">Doing</option>
                          <option value="done">Done</option>
                        </select>
                      </td>
                      <td>
                        {!task.canvasUid && (
                          <button
                            type="button"
                            className="button ghost small"
                            onClick={() => removeManualTask(task.id)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        )}
      </section>

      <ManualObligations
        events={state.manualEvents}
        onAdd={addManualEvent}
        onRemove={removeManualEvent}
      />
    </>
  )
}

/* ------------------------------------------------------------------------- */

function AddTask({ onAdd }: { onAdd: (task: Task) => void }): React.ReactNode {
  const [title, setTitle] = useState('')
  const [course, setCourse] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [day, setDay] = useState(4)
  const [time, setTime] = useState('23:59')
  const [weight, setWeight] = useState(1)

  const submit = (): void => {
    if (title.trim() === '') return
    const [h, m] = time.split(':').map(Number)
    onAdd({
      id: `manual:${simpleHash(`${title}|${Date.now()}`)}`,
      title: title.trim(),
      ...(course.trim() ? { course: course.trim().toUpperCase() } : {}),
      dueAt: atDay(day, (h ?? 23) * 60 + (m ?? 59)),
      estimateMinutes: minutes,
      estimateSource: 'user',
      chunks: [],
      status: 'todo',
      weight,
    })
    setTitle('')
    setCourse('')
  }

  return (
    <section className="card">
      <h2>Add work</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 'var(--space-md)',
          marginTop: 'var(--space-md)',
        }}
      >
        <label className="field" style={{ gridColumn: 'span 2' }}>
          What
          <input
            type="text"
            value={title}
            placeholder="Gilgamesh response"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </label>
        <label className="field">
          Course
          <input type="text" value={course} placeholder="ERH-101" onChange={(event) => setCourse(event.target.value)} />
        </label>
        <label className="field">
          Due day
          <select value={day} onChange={(event) => setDay(Number(event.target.value))}>
            {DAY_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Due time
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
        <label className="field">
          Minutes
          <input
            type="number"
            min={5}
            max={1200}
            step={5}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </label>
        <label className="field">
          Weight
          <select value={weight} onChange={(event) => setWeight(Number(event.target.value))}>
            <option value={1}>Normal</option>
            <option value={2}>Important</option>
            <option value={4}>Critical</option>
          </select>
        </label>
      </div>
      <div className="button-row" style={{ marginTop: 'var(--space-md)' }}>
        <button type="button" className="button" onClick={submit} disabled={title.trim() === ''}>
          Add
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------- */

function ManualObligations({
  events,
  onAdd,
  onRemove,
}: {
  events: ReturnType<typeof usePlanner>['state']['manualEvents']
  onAdd: (event: ReturnType<typeof usePlanner>['state']['manualEvents'][number]) => void
  onRemove: (id: string) => void
}): React.ReactNode {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('personal')
  const [days, setDays] = useState<number[]>([])
  const [start, setStart] = useState('18:00')
  const [end, setEnd] = useState('19:00')

  const submit = (): void => {
    if (title.trim() === '' || days.length === 0) return
    const toMinutes = (value: string): number => {
      const [h, m] = value.split(':').map(Number)
      return (h ?? 0) * 60 + (m ?? 0)
    }
    onAdd({
      id: simpleHash(`${title}|${Date.now()}`),
      title: title.trim(),
      kind,
      days: [...days].sort((a, b) => a - b),
      start: toMinutes(start),
      end: toMinutes(end),
      hard: kindSpec(kind as never).hard,
    })
    setTitle('')
    setDays([])
  }

  return (
    <section className="card">
      <h2>Recurring obligations</h2>
      <p className="item-note" style={{ marginTop: 0 }}>
        Anything the matrix does not cover — a job, a team practice, a standing appointment. Marked
        hard or soft by its kind, and the solver treats hard ones as walls.
      </p>

      {events.length > 0 && (
        <ul className="item-list" style={{ margin: 'var(--space-md) 0' }}>
          {events.map((event) => {
            const spec = kindSpec(event.kind as never)
            return (
              <li className="item" key={event.id}>
                <div className="item-body">
                  <span className="item-title">
                    <span className="pill" data-accent={spec.accent}>
                      {spec.glyph} {spec.label}
                    </span>{' '}
                    {event.title}
                  </span>
                  <span className="item-note tnum">
                    {event.days.map((d) => DAY_NAMES[d]?.slice(0, 3)).join(' · ')} ·{' '}
                    {formatClock(event.start)}–{formatClock(event.end)}
                  </span>
                </div>
                <button type="button" className="button ghost small" onClick={() => onRemove(event.id)}>
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 'var(--space-md)',
          marginTop: 'var(--space-md)',
        }}
      >
        <label className="field" style={{ gridColumn: 'span 2' }}>
          What
          <input
            type="text"
            value={title}
            placeholder="Rifle team practice"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="field">
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {KINDS.filter((k) => kindSpec(k).occupiesTime).map((k) => (
              <option key={k} value={k}>
                {kindSpec(k).label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label className="field">
          To
          <input type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
        </label>
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: 'var(--space-md) 0 0' }}>
        <legend className="label">Days</legend>
        <div className="button-row" style={{ marginTop: 'var(--space-xs)' }}>
          {DAY_NAMES.map((name, index) => (
            <button
              key={name}
              type="button"
              className={days.includes(index) ? 'button small' : 'button secondary small'}
              aria-pressed={days.includes(index)}
              onClick={() =>
                setDays((current) =>
                  current.includes(index) ? current.filter((d) => d !== index) : [...current, index],
                )
              }
            >
              {name.slice(0, 3)}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="button-row" style={{ marginTop: 'var(--space-md)' }}>
        <button
          type="button"
          className="button"
          onClick={submit}
          disabled={title.trim() === '' || days.length === 0}
        >
          Add obligation
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------- */

/**
 * Conversational replan.
 *
 * The model reads a sentence and emits a CONSTRAINT PATCH — boost this, block
 * that out, relax this ceiling. It never emits a schedule. The solver then
 * re-runs, deterministically, and the patch is shown before it is applied so
 * nothing happens to your week that you did not see.
 */
function ReplanBox({
  tasks,
  patch,
  onPatch,
}: {
  tasks: Task[]
  patch: ReturnType<typeof usePlanner>['patch']
  onPatch: (patch: ReturnType<typeof usePlanner>['patch']) => void
}): React.ReactNode {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dropped, setDropped] = useState<string[]>([])

  const send = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          job: 'replan',
          message,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
        }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) {
        setError(
          typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'The replan failed.',
        )
        return
      }
      const typed = payload as { patch?: unknown; summary?: unknown; dropped?: unknown }
      onPatch((typed.patch ?? null) as ReturnType<typeof usePlanner>['patch'])
      setSummary(typeof typed.summary === 'string' ? typed.summary : null)
      setDropped(Array.isArray(typed.dropped) ? (typed.dropped as string[]) : [])
      setMessage('')
    } catch {
      setError('The replan could not be reached.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card accent-top">
      <div className="card-head">
        <h2>Tell it what changed</h2>
        {patch && (
          <button type="button" className="button ghost small" onClick={() => { onPatch(null); setSummary(null) }}>
            Clear patch
          </button>
        )}
      </div>
      <p className="item-note" style={{ marginTop: 0 }}>
        &ldquo;I&apos;m behind on the Gilgamesh response and Thursday got eaten by guard duty.&rdquo; The
        model turns that into constraints — boost this, block that out — and the same deterministic
        solver re-runs. It is never allowed to write the schedule itself.
      </p>

      <textarea
        rows={2}
        value={message}
        placeholder="What changed?"
        onChange={(event) => setMessage(event.target.value)}
        style={{ marginTop: 'var(--space-sm)' }}
      />
      <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
        <button type="button" className="button" onClick={() => void send()} disabled={busy || message.trim() === ''}>
          {busy ? 'Thinking…' : 'Replan'}
        </button>
      </div>

      {summary && (
        <div className="banner warn" style={{ marginTop: 'var(--space-md)' }}>
          <h3>Applied as constraints</h3>
          <p style={{ margin: 0, fontSize: 13 }}>{summary}</p>
          {patch?.blockOut && patch.blockOut.length > 0 && (
            <ul>
              {patch.blockOut.map((window, index) => (
                <li key={index} style={{ fontSize: 13 }} className="tnum">
                  {DAY_NAMES[window.day]} {formatClock(window.start)}–{formatClock(window.end)} — {window.reason}
                </li>
              ))}
            </ul>
          )}
          {dropped.length > 0 && (
            <ul>
              {dropped.map((line, index) => (
                <li key={index} style={{ fontSize: 12 }}>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="item-note" role="alert" style={{ color: 'var(--danger)', marginTop: 'var(--space-sm)' }}>
          {error}
        </p>
      )}
    </section>
  )
}
