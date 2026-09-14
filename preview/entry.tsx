/**
 * Single-file preview entry.
 *
 * Mounts the real app — real provider, real pages, real engine — with hash
 * routing in place of the Next.js router, so the preview is the same code and
 * cannot drift from what is deployed.
 *
 * Two things genuinely cannot work without a server, and the banner says so
 * rather than letting them fail silently: fetching a Canvas feed by URL (the
 * CORS proxy is a server route) and the advisory AI calls. Uploading an .ics
 * file works, because that is read on the device like everything else.
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PlannerProvider } from '../components/PlannerProvider'
import { Dock } from '../components/Dock'
import WeekPage from '../app/page'
import SourcesPage from '../app/sources/page'
import WorkPage from '../app/work/page'
import PreferencesPage from '../app/preferences/page'
import PrintPage from '../app/print/page'
import { usePathname } from './shims/navigation'
import { buildSampleState } from '../lib/demo/sample'
import { STORAGE_KEY } from '../lib/store/state'
import { weekStartOf } from '../lib/domain/time'

/**
 * Seed the sample week on a first visit only.
 *
 * A preview that opens on the empty state teaches nothing, but overwriting
 * on every load would throw away anything the viewer uploaded themselves.
 */
function seedSampleOnce(): void {
  try {
    if (window.localStorage.getItem(STORAGE_KEY)) return
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSampleState(weekStartOf(today))))
  } catch {
    // Private window or blocked storage: the app still runs, just empty.
  }
}

function Routes(): React.ReactNode {
  const path = usePathname()
  if (path === '/sources') return <SourcesPage />
  if (path === '/work') return <WorkPage />
  if (path === '/preferences') return <PreferencesPage />
  if (path === '/print') return <PrintPage />
  return <WeekPage />
}

function PreviewNotice(): React.ReactNode {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="banner warn no-print" style={{ marginBottom: 'var(--space-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-md)' }}>
        <div>
          <h3>Preview build</h3>
          <p style={{ margin: '2px 0 0', fontSize: 13 }}>
            The real app, running entirely in this page — same engine, same components. A sample week
            is loaded; replace it with your own files on <a href="#/sources">Sources</a>. Two things
            need a server and are off here: fetching a Canvas feed <em>by URL</em> (upload the .ics
            instead) and the advisory AI. Everything else is live, including the printable sheet.
          </p>
        </div>
        <button type="button" className="button ghost small" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function App(): React.ReactNode {
  useEffect(() => {
    // Keep the browser from restoring a scroll position onto a different route.
    if (window.location.hash === '') window.location.hash = '/'
  }, [])

  return (
    <PlannerProvider>
      <div className="shell">
        <Dock />
        <main className="main">
          <PreviewNotice />
          <Routes />
        </main>
      </div>
    </PlannerProvider>
  )
}

seedSampleOnce()

const host = document.getElementById('root')
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
