'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePlanner } from '@/components/PlannerProvider'
import { WeekGrid, chooseHourRange } from '@/components/WeekGrid'
import {
  CapacityMeter,
  ConflictBanner,
  Inspector,
  KindLegend,
  NarrativeCard,
  UnplacedList,
} from '@/components/Panels'
import { encodeLockSignature } from '@/lib/engine/solve'
import { buildSampleState } from '@/lib/demo/sample'
import { addDays, isoWeekLabel, parseLocalDate, weekStartOf } from '@/lib/domain/time'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function rangeLabel(weekStart: string): string {
  const a = parseLocalDate(weekStart)
  const b = parseLocalDate(addDays(weekStart, 6))
  const left = `${MONTHS[a.m - 1]} ${a.d}`
  const right = a.m === b.m ? `${b.d}` : `${MONTHS[b.m - 1]} ${b.d}`
  return `${left} – ${right}, ${b.y}`
}

export default function WeekPage(): React.ReactNode {
  const { state, week, hydrating, today, shiftWeek, goToWeek, toggleLock, update } = usePlanner()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nowMinutes, setNowMinutes] = useState<number | null>(null)

  // The now-line is clock-dependent, so it is set after mount only. Rendering
  // it during SSR would produce markup that cannot match the client.
  useEffect(() => {
    const tick = (): void => {
      const now = new Date()
      setNowMinutes(now.getHours() * 60 + now.getMinutes())
    }
    tick()
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // Keyboard-first navigation. A planner you drive from the keyboard is a
  // planner you check twice a day instead of twice a week.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'ArrowLeft' || event.key === 'h') shiftWeek(-1)
      else if (event.key === 'ArrowRight' || event.key === 'l') shiftWeek(1)
      else if (event.key === 't') goToWeek(today)
      else if (event.key === 'Escape') setSelectedId(null)
      else if (event.key === 'p') window.print()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shiftWeek, goToWeek, today])

  const plan = week.plan
  const selected = useMemo(
    () => plan.blocks.find((b) => b.id === selectedId) ?? null,
    [plan.blocks, selectedId],
  )
  const selectedTask = useMemo(
    () => (selected?.taskId ? week.tasks.find((t) => t.id === selected.taskId) ?? null : null),
    [selected, week.tasks],
  )
  const hourRange = useMemo(
    () => chooseHourRange(plan.blocks, state.preferences.wake, state.preferences.sleep),
    [plan.blocks, state.preferences.wake, state.preferences.sleep],
  )

  const lockedSignatures = state.locks[state.selectedWeek] ?? []
  const selectedSignature = selected ? encodeLockSignature(selected) : null
  const isThisWeek = state.selectedWeek === weekStartOf(today)

  if (hydrating) {
    return (
      <div className="empty">
        <h3>Reading your plan…</h3>
        <p className="muted">Everything is stored in this browser, so there is nothing to wait on.</p>
      </div>
    )
  }

  if (!week.hasAnySource) {
    return (
      <FirstRun
        onLoadSample={() => update(() => buildSampleState(weekStartOf(today)))}
      />
    )
  }

  return (
    <>
      <header className="page-head no-print">
        <div>
          <h1>{rangeLabel(state.selectedWeek)}</h1>
          <p>
            <span className="tnum">{isoWeekLabel(state.selectedWeek)}</span>
            {isThisWeek ? ' · this week' : ''} · {plan.blocks.length} blocks ·{' '}
            <span className="muted">
              engine {plan.engineVersion} · fingerprint <span className="tnum">{plan.inputsFingerprint}</span>
            </span>
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="button secondary small" onClick={() => shiftWeek(-1)}>
            ← Previous
          </button>
          <button type="button" className="button secondary small" onClick={() => goToWeek(today)} disabled={isThisWeek}>
            Today
          </button>
          <button type="button" className="button secondary small" onClick={() => shiftWeek(1)}>
            Next →
          </button>
          <Link href="/print" className="button small" style={{ textDecoration: 'none' }}>
            Print sheet
          </Link>
        </div>
      </header>

      <ConflictBanner conflicts={plan.conflicts} />

      <div className="workspace">
        <div className="stack">
          <div className="grid-frame">
            <div className="grid-toolbar">
              <KindLegend />
              <span className="muted" style={{ fontSize: 11 }}>
                <span className="kbd">←</span> <span className="kbd">→</span> week ·{' '}
                <span className="kbd">t</span> today · <span className="kbd">p</span> print
              </span>
            </div>
            <WeekGrid
              weekStart={state.selectedWeek}
              blocks={plan.blocks}
              openWindows={plan.openWindows}
              selectedId={selectedId}
              onSelect={setSelectedId}
              today={today}
              nowMinutes={isThisWeek ? nowMinutes : null}
              dayStartHour={hourRange.dayStartHour}
              dayEndHour={hourRange.dayEndHour}
            />
          </div>

          <NarrativeCard narrative={plan.narrative} />
          <UnplacedList unplaced={plan.unplaced} />
        </div>

        <div className="stack">
          <Inspector
            block={selected}
            task={selectedTask}
            locked={selectedSignature ? lockedSignatures.includes(selectedSignature) : false}
            onToggleLock={() => selectedSignature && toggleLock(selectedSignature)}
            onClear={() => setSelectedId(null)}
          />
          <CapacityMeter capacity={plan.capacity} />
          {week.upcoming.length > 0 && (
            <section className="card" aria-labelledby="upcoming-title">
              <h3 id="upcoming-title" className="label">
                Just past this week
              </h3>
              <p className="item-note" style={{ marginTop: 0 }}>
                Deadlines that land after Sunday. Work on them now shows up in this week&apos;s plan.
              </p>
              <ul className="item-list">
                {week.upcoming.slice(0, 6).map((item, index) => (
                  <li className="item" key={index}>
                    <div className="item-body">
                      <span className="item-title">{item.title}</span>
                      <span className="item-note tnum">
                        {item.dueDate}
                        {item.course ? ` · ${item.course}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  )
}

function FirstRun({ onLoadSample }: { onLoadSample: () => void }): React.ReactNode {
  return (
    <div className="stack" style={{ maxWidth: 720, margin: '0 auto', paddingTop: 'var(--space-xl)' }}>
      <div>
        <h1>Which hours are actually yours?</h1>
        <p className="secondary">
          Most planners assume you own your time. A cadet does not. The Matrix imposes formations,
          parades, inspections and duty; the semester imposes classes; Canvas imposes deadlines. The
          genuinely scarce resource is the gaps between them, so this tool has one job: tell you which
          hours are yours, and what to do in them.
        </p>
      </div>

      <section className="card accent-top">
        <h2>Start with one file</h2>
        <p className="secondary">
          Drop in your cadetship matrix and you have a week. Add a course schedule and a Canvas feed
          and you have a plan. None of it leaves this device — there is no account and no server that
          stores your schedule.
        </p>
        <div className="button-row">
          <Link href="/sources" className="button" style={{ textDecoration: 'none' }}>
            Add your sources
          </Link>
          <Link href="/work" className="button secondary" style={{ textDecoration: 'none' }}>
            Or type in work by hand
          </Link>
        </div>
      </section>

      <section className="card">
        <h3>Just want to see it work?</h3>
        <p className="item-note" style={{ marginTop: 0 }}>
          Loads a plausible cadet week — a matrix, five courses, a Canvas feed with real deadlines —
          dated onto this week. It includes a genuine institutional conflict, so you can see what the
          app does with one. Everything stays in this browser and you can clear it in one click.
        </p>
        <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
          <button type="button" className="button" onClick={onLoadSample}>
            Load a sample week
          </button>
        </div>
      </section>

      <section className="card">
        <h3>What it will do</h3>
        <ul className="item-list" style={{ marginTop: 'var(--space-sm)' }}>
          <li className="item">
            <div className="item-body">
              <span className="item-title">Tell you the truth about capacity</span>
              <span className="item-note">
                If you have 14.5 hours of work and 9 hours of free time, it says so and names what did
                not fit, instead of drawing a tidy grid that quietly drops three blocks.
              </span>
            </div>
          </li>
          <li className="item">
            <div className="item-body">
              <span className="item-title">Show orders apart from suggestions</span>
              <span className="item-note">
                What the Institute decided renders solid. What the app decided renders with a dashed
                edge. You can always tell them apart, on screen and on paper.
              </span>
            </div>
          </li>
          <li className="item">
            <div className="item-body">
              <span className="item-title">Explain every placement</span>
              <span className="item-note">
                Each study block says why it is where it is, and each piece that did not fit names the
                one constraint that blocked it.
              </span>
            </div>
          </li>
          <li className="item">
            <div className="item-body">
              <span className="item-title">Print</span>
              <span className="item-note">
                Three pages: the week as a grid, a tear-off page per day with tick boxes, and the
                deadline table. A plan you cannot open is not a plan.
              </span>
            </div>
          </li>
        </ul>
      </section>
    </div>
  )
}
