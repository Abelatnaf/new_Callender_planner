'use client'

import { useRef, useState } from 'react'
import { gridToCsv, isSpreadsheetName, parseXlsx } from '@/lib/parse/xlsx'

export function UploadDropzone({
  label,
  hint,
  accept,
  onFile,
}: {
  label: string
  hint: string
  accept: string
  onFile: (file: { name: string; text: string }) => void
}): React.ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const read = async (file: File): Promise<void> => {
    setError(null)
    setNote(null)
    // 8 MB is far beyond any real schedule file; past that it is a wrong file
    // and reading it would only freeze the tab.
    if (file.size > 8 * 1024 * 1024) {
      setError('That file is larger than 8 MB, which is not a schedule. Check you picked the right one.')
      return
    }

    try {
      /**
       * A spreadsheet is converted to CSV here and then follows exactly the
       * same path as an uploaded CSV — same shape detection, same mapping
       * memory, same cell parser. One code path means the two cannot drift
       * apart in how they are read, and every parser fix applies to both.
       *
       * It happens in the browser: the whole architecture rests on the
       * schedule never being uploaded anywhere, so there is no server-side
       * conversion to fall back on.
       */
      if (isSpreadsheetName(file.name)) {
        const { sheets, warnings } = await parseXlsx(await file.arrayBuffer())
        const sheet = sheets[0]
        if (!sheet) {
          setError('No readable worksheet was found in that spreadsheet.')
          return
        }
        if (warnings.length > 0) setNote(warnings.join(' '))
        onFile({ name: file.name, text: gridToCsv(sheet.rows) })
        return
      }

      const text = await file.text()
      if (text.trim() === '') {
        setError('That file is empty.')
        return
      }
      onFile({ name: file.name, text })
    } catch (error) {
      setError(
        error instanceof Error
          ? `That file could not be read: ${error.message}`
          : 'The file could not be read.',
      )
    }
  }

  return (
    <div>
      <div
        className="dropzone"
        data-over={over}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          const file = event.dataTransfer.files[0]
          if (file) void read(file)
        }}
      >
        <strong>{label}</strong>
        <p className="item-note" style={{ margin: '4px 0 0' }}>
          {hint}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void read(file)
            event.target.value = ''
          }}
        />
      </div>
      {error && (
        <p className="item-note" role="alert" style={{ color: 'var(--danger)', marginTop: 4 }}>
          {error}
        </p>
      )}
      {note && (
        <p className="item-note" style={{ marginTop: 4 }}>
          {note}
        </p>
      )}
    </div>
  )
}
