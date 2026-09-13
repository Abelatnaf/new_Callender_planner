'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { usePlanner } from './PlannerProvider'
import { formatHours } from '@/lib/domain/time'

const ROUTES = [
  { href: '/', label: 'The week', glyph: 'W' },
  { href: '/sources', label: 'Sources', glyph: 'S' },
  { href: '/work', label: 'Work', glyph: 'K' },
  { href: '/preferences', label: 'Preferences', glyph: 'P' },
  { href: '/print', label: 'Print sheet', glyph: 'R' },
] as const

export function Dock(): React.ReactNode {
  const pathname = usePathname()
  const { state, week, storageWarning, setTheme } = usePlanner()
  const capacity = week.plan.capacity
  const oversubscribed = capacity.unplacedMinutes > 0

  return (
    <nav className="dock" aria-label="Main">
      <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
        <span className="brand-mark">ORDER</span>
        <span className="brand-motto">Ink is obligation.</span>
      </Link>

      <div className="nav">
        {ROUTES.map((route) => (
          <Link
            key={route.href}
            href={route.href}
            className="nav-item"
            aria-current={pathname === route.href ? 'page' : undefined}
          >
            <span className="nav-glyph" aria-hidden="true">
              {route.glyph}
            </span>
            {route.label}
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 'auto' }} className="stack tight">
        {storageWarning && (
          <div className="banner" role="alert" style={{ fontSize: 12 }}>
            <strong>Not saving</strong>
            <div>{storageWarning}</div>
          </div>
        )}

        <div>
          <div className="label" style={{ marginBottom: 4 }}>
            This week
          </div>
          <div className="capacity-bar" style={{ margin: '0 0 6px' }}>
            <span
              className="capacity-seg"
              data-seg="placed"
              style={{ width: `${share(capacity.placedMinutes, capacity)}%` }}
            />
            <span
              className="capacity-seg"
              data-seg="slack"
              style={{ width: `${share(capacity.slackMinutes, capacity)}%` }}
            />
            <span
              className="capacity-seg"
              data-seg="short"
              style={{ width: `${share(capacity.unplacedMinutes, capacity)}%` }}
            />
          </div>
          <div className="tnum" style={{ fontSize: 11, color: 'var(--ink-secondary)' }}>
            {formatHours(capacity.slackMinutes)} h free ·{' '}
            {oversubscribed ? (
              <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                {formatHours(capacity.unplacedMinutes)} h short
              </span>
            ) : (
              'everything fits'
            )}
          </div>
        </div>

        <label className="field" style={{ fontSize: 11 }}>
          Theme
          <select
            value={state.theme}
            onChange={(event) => setTheme(event.target.value as typeof state.theme)}
            style={{ padding: '0.3rem 0.5rem', fontSize: 12 }}
          >
            <option value="system">Match system</option>
            <option value="light">Paper</option>
            <option value="dark">After taps</option>
          </select>
        </label>
      </div>
    </nav>
  )
}

function share(minutes: number, capacity: { placedMinutes: number; slackMinutes: number; unplacedMinutes: number }): number {
  const total = capacity.placedMinutes + capacity.slackMinutes + capacity.unplacedMinutes
  return total <= 0 ? 0 : (minutes / total) * 100
}
