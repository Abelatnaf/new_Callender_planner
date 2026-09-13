'use client'

import { usePlanner } from '@/components/PlannerProvider'
import { DAY_NAMES, formatClock, formatDuration } from '@/lib/domain/time'
import { DEFAULT_PREFERENCES } from '@/lib/engine/solve'
import type { Preferences } from '@/lib/domain/types'

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function fromTime(value: string): number {
  const [h, m] = value.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export default function PreferencesPage(): React.ReactNode {
  const { state, week, setPreferences } = usePlanner()
  const prefs = state.preferences

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]): void => {
    setPreferences({ ...prefs, [key]: value })
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Preferences</h1>
          <p>
            Every setting here is a constraint the solver obeys. Changing one re-runs the plan
            immediately, so you can watch what a shorter buffer or a higher ceiling actually buys you.
          </p>
        </div>
        <button
          type="button"
          className="button secondary small"
          onClick={() => setPreferences(DEFAULT_PREFERENCES)}
        >
          Reset to defaults
        </button>
      </header>

      <div className="workspace">
        <div className="stack">
          <section className="card">
            <h2>The day</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 'var(--space-md)',
                marginTop: 'var(--space-md)',
              }}
            >
              <label className="field">
                Wake
                <input type="time" value={toTime(prefs.wake)} onChange={(e) => set('wake', fromTime(e.target.value))} />
              </label>
              <label className="field">
                Sleep
                <input type="time" value={toTime(prefs.sleep)} onChange={(e) => set('sleep', fromTime(e.target.value))} />
              </label>
              <label className="field">
                Time zone
                <input type="text" value={prefs.timeZone} onChange={(e) => set('timeZone', e.target.value)} />
              </label>
            </div>
            <p className="item-note">
              Nothing is ever scheduled outside these hours. Sleep is subtracted before any work is
              placed, not treated as a soft preference.
            </p>
          </section>

          <section className="card">
            <h2>Meals</h2>
            <p className="item-note" style={{ marginTop: 0 }}>
              Mess is not optional and it is not study time. These windows are removed from free time
              the same way obligations are.
            </p>
            <ul className="item-list" style={{ marginTop: 'var(--space-md)' }}>
              {prefs.meals.map((meal, index) => (
                <li className="item" key={meal.label}>
                  <div className="item-body">
                    <span className="item-title">{meal.label}</span>
                  </div>
                  <input
                    type="time"
                    value={toTime(meal.start)}
                    aria-label={`${meal.label} start`}
                    style={{ width: 110 }}
                    onChange={(e) => {
                      const meals = [...prefs.meals]
                      meals[index] = { ...meal, start: fromTime(e.target.value) }
                      set('meals', meals)
                    }}
                  />
                  <input
                    type="time"
                    value={toTime(meal.end)}
                    aria-label={`${meal.label} end`}
                    style={{ width: 110 }}
                    onChange={(e) => {
                      const meals = [...prefs.meals]
                      meals[index] = { ...meal, end: fromTime(e.target.value) }
                      set('meals', meals)
                    }}
                  />
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => set('meals', prefs.meals.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  set('meals', [...prefs.meals, { label: `Meal ${prefs.meals.length + 1}`, start: 15 * 60, end: 15 * 60 + 30 }])
                }
              >
                Add a window
              </button>
            </div>
          </section>

          <section className="card">
            <h2>Blocks</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                gap: 'var(--space-md)',
                marginTop: 'var(--space-md)',
              }}
            >
              <Slider
                label="Shortest usable block"
                value={prefs.minBlockMinutes}
                min={10}
                max={90}
                step={5}
                onChange={(v) => set('minBlockMinutes', v)}
                note="Free windows shorter than this are ignored. Lower it to reclaim slivers between obligations."
              />
              <Slider
                label="Longest single block"
                value={prefs.maxBlockMinutes}
                min={30}
                max={240}
                step={15}
                onChange={(v) => set('maxBlockMinutes', v)}
                note="Long tasks are split into pieces no longer than this."
              />
              <Slider
                label="Daily study ceiling"
                value={prefs.maxStudyMinutesPerDay}
                min={60}
                max={720}
                step={30}
                onChange={(v) => set('maxStudyMinutesPerDay', v)}
                note="A hard cap per day. Work past it is reported as not fitting rather than piled on."
              />
              <Slider
                label="Transit buffer"
                value={prefs.bufferMinutes}
                min={0}
                max={30}
                step={5}
                onChange={(v) => set('bufferMinutes', v)}
                note="Taken off each edge of a free window that touches an obligation. Barracks to academic building is a real walk."
              />
              <Slider
                label="Finish this far ahead"
                value={prefs.minLeadHours}
                min={0}
                max={72}
                step={2}
                unit="h"
                onChange={(v) => set('minLeadHours', v)}
                note="Work is scheduled to finish this many hours before its deadline."
              />
              <label className="field">
                Prefer to work
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={prefs.dayPhaseBias}
                  onChange={(e) => set('dayPhaseBias', Number(e.target.value))}
                />
                <span className="item-note">
                  {prefs.dayPhaseBias < 0.35
                    ? 'Early — mornings first'
                    : prefs.dayPhaseBias > 0.6
                      ? 'Late — evenings first'
                      : 'No strong preference'}
                </span>
              </label>
            </div>
          </section>

          <section className="card">
            <h2>Protected windows</h2>
            <p className="item-note" style={{ marginTop: 0 }}>
              Time you declare untouchable. The solver treats these exactly like an order from the
              Institute: it will report work as not fitting rather than schedule into one.
            </p>
            {prefs.protectedWindows.length > 0 && (
              <ul className="item-list" style={{ marginTop: 'var(--space-md)' }}>
                {prefs.protectedWindows.map((window, index) => (
                  <li className="item" key={index}>
                    <div className="item-body">
                      <span className="item-title">{window.label}</span>
                      <span className="item-note tnum">
                        {window.days.length === 0
                          ? 'every day'
                          : window.days.map((d) => DAY_NAMES[d]?.slice(0, 3)).join(' · ')}{' '}
                        · {formatClock(window.start)}–{formatClock(window.end)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() =>
                        set('protectedWindows', prefs.protectedWindows.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  set('protectedWindows', [
                    ...prefs.protectedWindows,
                    { label: 'Sunday morning', days: [6], start: 8 * 60, end: 12 * 60 },
                  ])
                }
              >
                Protect Sunday morning
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  set('protectedWindows', [
                    ...prefs.protectedWindows,
                    { label: 'Evening decompression', days: [], start: 21 * 60 + 30, end: 23 * 60 },
                  ])
                }
              >
                Protect late evenings
              </button>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card accent-top">
            <h3 className="label">What these settings cost you</h3>
            <div style={{ marginTop: 'var(--space-sm)' }}>
              <div className="metric-row">
                <span className="secondary">Usable free time</span>
                <span className="metric tnum">{formatDuration(week.plan.capacity.freeMinutes)}</span>
              </div>
              <div className="metric-row">
                <span className="secondary">Work scheduled</span>
                <span className="metric tnum">{formatDuration(week.plan.capacity.placedMinutes)}</span>
              </div>
              <div className="metric-row">
                <span className="secondary">Did not fit</span>
                <span
                  className="metric tnum"
                  style={week.plan.capacity.unplacedMinutes > 0 ? { color: 'var(--danger)' } : undefined}
                >
                  {formatDuration(week.plan.capacity.unplacedMinutes)}
                </span>
              </div>
            </div>
            <p className="item-note" style={{ marginTop: 'var(--space-md)' }}>
              These numbers update as you change a setting. If tightening the buffer buys you nothing,
              the constraint was never what was binding.
            </p>
          </section>
        </div>
      </div>
    </>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = 'm',
  onChange,
  note,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (value: number) => void
  note: string
}): React.ReactNode {
  return (
    <label className="field">
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="metric tnum" style={{ fontSize: 13 }}>
        {unit === 'h' ? `${value} h` : formatDuration(value)}
      </span>
      <span className="item-note">{note}</span>
    </label>
  )
}
