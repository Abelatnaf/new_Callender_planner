'use client'

import { useMemo, useState } from 'react'
import { usePlanner } from '@/components/PlannerProvider'
import { UploadDropzone } from '@/components/UploadDropzone'
import { ColumnMapper } from '@/components/ColumnMapper'
import { detectMatrix, type LongField } from '@/lib/parse/matrix'
import { maskFeedUrl } from '@/lib/parse/ics'
import { TERM_TEMPLATE } from '@/lib/parse/term'
import { exportState, importState } from '@/lib/store/state'
import { buildSampleState } from '@/lib/demo/sample'
import { weekStartOf } from '@/lib/domain/time'

export default function SourcesPage(): React.ReactNode {
  const { state, week, setMatrix, setTerm, setCanvas, rememberMapping, update, today, reset } = usePlanner()
  const [mapping, setMapping] = useState(false)
  const [feedUrl, setFeedUrl] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const detection = useMemo(
    () => (state.matrix ? detectMatrix(state.matrix.text) : null),
    [state.matrix],
  )

  const fetchFeed = async (url: string): Promise<void> => {
    setSyncError(null)
    if (!/^https?:\/\//i.test(url)) {
      setSyncError('That does not look like a feed URL. It should start with https://')
      return
    }
    setSyncing(true)
    try {
      const response = await fetch('/api/canvas', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const payload: unknown = await response.json()
      if (!response.ok || !isFeedResponse(payload)) {
        setSyncError(
          isErrorResponse(payload) ? payload.error : 'The feed could not be fetched. Check the URL and try again.',
        )
        return
      }
      setCanvas({
        feedUrl: url,
        text: payload.ics,
        fetchedAt: new Date().toISOString(),
        label: `Canvas feed ${maskFeedUrl(url)}`,
      })
      setFeedUrl('')
    } catch {
      setSyncError('The feed could not be reached from this device.')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Sources</h1>
          <p>
            Three inputs, all optional, all stored only in this browser. Raw files are kept verbatim
            so a parser fix can be replayed without asking you for them again.
          </p>
        </div>
      </header>

      <section className="card">
        <h2>Who you are</h2>
        <p className="item-note" style={{ marginTop: 0 }}>
          Class year and company are not decoration: the matrix lists obligations for the whole Corps,
          and these are what let the app drop the ones that are not yours.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 'var(--space-md)',
            marginTop: 'var(--space-md)',
          }}
        >
          <label className="field">
            Name
            <input
              type="text"
              value={state.profile.name}
              placeholder="Optional"
              onChange={(event) => update((s) => ({ ...s, profile: { ...s.profile, name: event.target.value } }))}
            />
          </label>
          <label className="field">
            Class year
            <input
              type="text"
              value={state.profile.classYear}
              placeholder="2028"
              onChange={(event) => update((s) => ({ ...s, profile: { ...s.profile, classYear: event.target.value } }))}
            />
          </label>
          <label className="field">
            Company
            <input
              type="text"
              value={state.profile.company}
              placeholder="Band"
              onChange={(event) => update((s) => ({ ...s, profile: { ...s.profile, company: event.target.value } }))}
            />
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Cadetship matrix</h2>
          {state.matrix && detection && (
            <span className="pill" data-accent="terracotta">
              {detection.shape === 'wide'
                ? 'weekly grid'
                : detection.shape === 'long'
                  ? 'row per event'
                  : 'shape unclear'}
            </span>
          )}
        </div>

        {!state.matrix ? (
          <UploadDropzone
            label="Drop the matrix here"
            hint="CSV exported from the published schedule. A grid of times against days, or one row per event — both are read."
            accept=".csv,.txt,text/csv"
            onFile={(file) =>
              setMatrix({ filename: file.name, text: file.text, receivedAt: new Date().toISOString() })
            }
          />
        ) : (
          <>
            <div className="metric-row">
              <span className="secondary">File</span>
              <span>{state.matrix.filename}</span>
            </div>
            <div className="metric-row">
              <span className="secondary">Events this week</span>
              <span className="metric tnum">
                {week.reports.find((r) => r.label === 'Cadetship matrix')?.eventCount ?? 0}
              </span>
            </div>
            <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
              {detection?.shape !== 'wide' && (
                <button type="button" className="button secondary small" onClick={() => setMapping(true)}>
                  {state.matrix.mappings && detection && state.matrix.mappings[detection.headerFingerprint]
                    ? 'Change column mapping'
                    : 'Confirm column mapping'}
                </button>
              )}
              <button type="button" className="button ghost small" onClick={() => setMatrix(null)}>
                Remove
              </button>
            </div>
          </>
        )}

        {mapping && detection && (
          <div style={{ marginTop: 'var(--space-md)' }}>
            <ColumnMapper
              detection={detection}
              initial={state.matrix?.mappings?.[detection.headerFingerprint]}
              onSave={(next: Record<string, LongField>) => {
                rememberMapping(detection.headerFingerprint, next)
                setMapping(false)
              }}
              onCancel={() => setMapping(false)}
            />
          </div>
        )}
      </section>

      <section className="card">
        <h2>Course schedule</h2>
        {!state.term ? (
          <>
            <UploadDropzone
              label="Drop your course schedule"
              hint="One row per section: course_code, title, days, start_time, end_time, location."
              accept=".csv,.txt,text/csv"
              onFile={(file) =>
                setTerm({ filename: file.name, text: file.text, receivedAt: new Date().toISOString() })
              }
            />
            <details style={{ marginTop: 'var(--space-sm)' }}>
              <summary className="item-note" style={{ cursor: 'pointer' }}>
                Show the expected format
              </summary>
              <pre
                style={{
                  fontSize: 11,
                  overflowX: 'auto',
                  background: 'var(--subdued)',
                  padding: 'var(--space-sm)',
                  borderRadius: 'var(--r)',
                  border: '1px solid var(--hairline)',
                }}
              >
                {TERM_TEMPLATE}
              </pre>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  setTerm({
                    filename: 'example-schedule.csv',
                    text: TERM_TEMPLATE,
                    receivedAt: new Date().toISOString(),
                  })
                }
              >
                Load this example
              </button>
            </details>
          </>
        ) : (
          <>
            <div className="metric-row">
              <span className="secondary">File</span>
              <span>{state.term.filename}</span>
            </div>
            <div className="metric-row">
              <span className="secondary">Meetings this week</span>
              <span className="metric tnum">
                {week.reports.find((r) => r.label === 'Course schedule')?.eventCount ?? 0}
              </span>
            </div>
            <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
              <button type="button" className="button ghost small" onClick={() => setTerm(null)}>
                Remove
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Canvas calendar</h2>
        <p className="item-note" style={{ marginTop: 0 }}>
          In Canvas: Calendar → Calendar Feed → copy the link. A feed URL is a credential — it grants
          read access to your calendar to anyone who has it. It is stored in this browser, shown only
          as its last characters, and sent nowhere except through this app&apos;s own fetch.
        </p>

        {state.canvas ? (
          <>
            <div className="metric-row">
              <span className="secondary">Source</span>
              <span>{state.canvas.label}</span>
            </div>
            <div className="metric-row">
              <span className="secondary">Last fetched</span>
              <span className="tnum">{state.canvas.fetchedAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <div className="metric-row">
              <span className="secondary">Deadlines this week</span>
              <span className="metric tnum">{week.tasks.filter((t) => t.canvasUid).length}</span>
            </div>
            <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
              <button
                type="button"
                className="button secondary small"
                disabled={syncing || !state.canvas.feedUrl}
                onClick={() => {
                  const url = state.canvas?.feedUrl
                  if (url) void fetchFeed(url)
                  else setSyncError('This calendar came from a file, so there is nothing to resync. Upload a fresh export.')
                }}
              >
                {syncing ? 'Fetching…' : 'Resync'}
              </button>
              <button type="button" className="button ghost small" onClick={() => setCanvas(null)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <div className="stack tight" style={{ marginTop: 'var(--space-md)' }}>
            <label className="field">
              Feed URL
              <input
                type="url"
                value={feedUrl}
                placeholder="https://…instructure.com/feeds/calendars/user_….ics"
                onChange={(event) => setFeedUrl(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={() => void fetchFeed(feedUrl.trim())}
                disabled={syncing}
              >
                {syncing ? 'Fetching…' : 'Connect'}
              </button>
            </div>
            <UploadDropzone
              label="Or upload an .ics export"
              hint="Works offline, but goes stale the day after you upload it."
              accept=".ics,text/calendar"
              onFile={(file) =>
                setCanvas({ text: file.text, fetchedAt: new Date().toISOString(), label: file.name })
              }
            />
          </div>
        )}

        {syncError && (
          <p className="item-note" role="alert" style={{ color: 'var(--danger)', marginTop: 'var(--space-sm)' }}>
            {syncError}
          </p>
        )}
      </section>

      {week.reports.length > 0 && (
        <section className="card">
          <h2>What was read</h2>
          <p className="item-note" style={{ marginTop: 0 }}>
            Warnings are shown rather than swallowed. A parser that guesses quietly is how a planner
            ends up wrong in a way you only discover on Thursday.
          </p>
          <ul className="item-list" style={{ marginTop: 'var(--space-md)' }}>
            {week.reports.map((report) => (
              <li className="item" key={report.label}>
                <div className="item-body">
                  <span className="item-title">
                    {report.label}{' '}
                    <span className="pill" data-accent={report.ok ? 'sage' : 'terracotta'}>
                      {report.eventCount} events
                    </span>
                  </span>
                  <span className="item-note">{report.detail}</span>
                  {report.warnings.length > 0 && (
                    <ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem' }}>
                      {report.warnings.map((warning, index) => (
                        <li key={index} className="item-note">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Keep a copy</h2>
        <p className="item-note" style={{ marginTop: 0 }}>
          Everything lives in this browser, which means clearing site data clears your plan. Export
          writes a single file containing your sources, preferences and locks.
        </p>
        <div className="button-row" style={{ marginTop: 'var(--space-sm)' }}>
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              const blob = new Blob([exportState(state)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = `order-${state.selectedWeek}.json`
              anchor.click()
              URL.revokeObjectURL(url)
            }}
          >
            Export
          </button>
          <label className="button secondary small" style={{ cursor: 'pointer' }}>
            Import
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (file) {
                  const result = importState(await file.text(), today)
                  if ('error' in result) setImportError(result.error)
                  else {
                    setImportError(null)
                    update(() => result.state)
                  }
                }
                event.target.value = ''
              }}
            />
          </label>
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              if (
                !state.matrix ||
                window.confirm('Replace your current sources with the sample week?')
              ) {
                update(() => buildSampleState(weekStartOf(today)))
              }
            }}
          >
            Load sample week
          </button>
          <button
            type="button"
            className="button ghost small"
            onClick={() => {
              if (window.confirm('Delete every source, preference and lock stored in this browser?')) reset()
            }}
          >
            Delete everything
          </button>
        </div>
        {importError && (
          <p className="item-note" role="alert" style={{ color: 'var(--danger)' }}>
            {importError}
          </p>
        )}
      </section>
    </>
  )
}

function isFeedResponse(value: unknown): value is { ics: string } {
  return typeof value === 'object' && value !== null && typeof (value as { ics?: unknown }).ics === 'string'
}

function isErrorResponse(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string'
}
