'use client'

import { useState } from 'react'
import { LONG_FIELDS, type LongField, type MatrixDetection } from '@/lib/parse/matrix'

const FIELD_LABEL: Record<LongField, string> = {
  day: 'Day',
  start: 'Start time',
  end: 'End time',
  time_range: 'Time range',
  activity: 'Activity name',
  location: 'Location',
  uniform: 'Uniform',
  applies_to: 'Applies to',
  kind: 'Kind',
  notes: 'Notes',
  ignore: '— ignore —',
}

/**
 * Column mapping, confirmed once and then remembered forever.
 *
 * The mapping is keyed by a fingerprint of the file's header row, so the
 * second upload of the same report is zero-click. The build plan singled this
 * out as the feature that decides whether a tool gets used weekly or abandoned
 * in week three, and that is the right call: a tool that asks you to re-map
 * eleven columns every Sunday is a tool you stop opening.
 *
 * A suggested mapping is never applied without being shown. The suggestion is
 * a starting point for a human, not an answer.
 */
export function ColumnMapper({
  detection,
  initial,
  onSave,
  onCancel,
}: {
  detection: MatrixDetection
  initial?: Record<string, string>
  onSave: (mapping: Record<string, LongField>) => void
  onCancel: () => void
}): React.ReactNode {
  const [mapping, setMapping] = useState<Record<string, LongField>>(() => {
    const base = { ...(detection.suggestedMapping ?? {}) }
    if (initial) {
      for (const [header, field] of Object.entries(initial)) {
        if ((LONG_FIELDS as readonly string[]).includes(field)) base[header] = field as LongField
      }
    }
    return base
  })

  const used = Object.values(mapping)
  const missing = (['day', 'activity'] as const).filter((field) => !used.includes(field))
  const hasTime = used.includes('start') || used.includes('time_range')

  return (
    <section className="card" aria-labelledby="mapper-title">
      <div className="card-head">
        <h3 id="mapper-title">Confirm the columns</h3>
        <span className="pill">
          fingerprint <span className="tnum">{detection.headerFingerprint}</span>
        </span>
      </div>
      <p className="item-note" style={{ marginTop: 0 }}>
        Checked once. Every future upload with the same headers is read without asking.
      </p>

      <div className="stack tight" style={{ marginTop: 'var(--space-md)' }}>
        {detection.table.header.map((header, index) => (
          <div
            key={header}
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)', alignItems: 'center' }}
          >
            <div style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{header}</strong>
              <span className="item-note">
                {detection.sampleRows
                  .map((row) => row[index] ?? '')
                  .filter((v) => v.trim() !== '')
                  .slice(0, 2)
                  .join(' · ') || 'no sample values'}
              </span>
            </div>
            <select
              value={mapping[header] ?? 'ignore'}
              onChange={(event) => setMapping((m) => ({ ...m, [header]: event.target.value as LongField }))}
              aria-label={`Map column ${header}`}
            >
              {LONG_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {FIELD_LABEL[field]}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {(missing.length > 0 || !hasTime) && (
        <p className="item-note" style={{ color: 'var(--danger)', marginTop: 'var(--space-sm)' }}>
          Still needed: {[...missing.map((f) => FIELD_LABEL[f]), ...(hasTime ? [] : ['a start time or time range'])].join(', ')}.
        </p>
      )}

      <div className="button-row" style={{ marginTop: 'var(--space-md)' }}>
        <button
          type="button"
          className="button"
          disabled={missing.length > 0 || !hasTime}
          onClick={() => onSave(mapping)}
        >
          Save mapping
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
