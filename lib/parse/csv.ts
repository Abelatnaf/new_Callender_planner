/**
 * A tolerant CSV reader.
 *
 * This is deliberately hand-rolled rather than pulled from a package, because
 * every failure mode below was observed in the wild on files that a CSV library
 * will happily accept and then mangle:
 *
 *   - UTF-8 BOM glued to the first header (`﻿TIME`)
 *   - semicolon delimiters (Excel in a European locale)
 *   - tab delimiters (a paste out of Word)
 *   - a decorative title row above the real header
 *   - merged cells exported as repeated values or as blanks
 *   - trailing all-blank columns from a spreadsheet's used range
 *   - en/em dashes where hyphens are expected
 *   - CRLF, lone CR, and mixed line endings
 */

export interface CsvTable {
  header: string[]
  rows: string[][]
  /** Which delimiter was detected. Reported so the UI can say so. */
  delimiter: string
  /** Rows skipped above the header, if a title row was found. */
  skippedPreamble: string[]
  warnings: string[]
}

const DELIMITERS = [',', ';', '\t', '|'] as const

/** Strip BOM, normalize line endings and exotic whitespace. */
export function cleanText(input: string): string {
  return input
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
}

/**
 * Pick the delimiter that yields the most consistent column count across the
 * first few lines. Counting only the winner's occurrences is not enough — a
 * file full of prose commas beats a real semicolon file on raw count.
 */
export function sniffDelimiter(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '').slice(0, 10)
  if (lines.length === 0) return ','

  let best = ','
  let bestScore = -1
  for (const delim of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delim).length)
    const max = Math.max(...counts)
    if (max < 2) continue
    const modal = counts.filter((c) => c === max).length / counts.length
    // Reward many columns, reward consistency harder.
    const score = modal * 10 + max
    if (score > bestScore) {
      bestScore = score
      best = delim
    }
  }
  return best
}

/** RFC4180-ish single-line split honouring quotes and `""` escapes. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/**
 * Full parse honouring quoted fields that contain newlines.
 *
 * A stray unbalanced quote is the nastiest real-world case: naive parsers
 * swallow the rest of the file into one cell. We detect an unterminated quote
 * at EOF and re-parse that logical row line-by-line instead, so one bad cell
 * costs one row rather than the document.
 */
export function parseCsv(input: string, forcedDelimiter?: string): CsvTable {
  const warnings: string[] = []
  const text = cleanText(input)
  const delimiter = forcedDelimiter ?? sniffDelimiter(text)

  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  let sawQuote = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
      sawQuote = true
    } else if (ch === delimiter) {
      record.push(field)
      field = ''
    } else if (ch === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += ch
    }
  }
  if (quoted) {
    warnings.push(
      'A quotation mark was opened and never closed. Re-read line by line so one bad cell did not swallow the file.',
    )
    return lineByLineFallback(text, delimiter, warnings)
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  if (sawQuote) {
    // no warning — quoting is normal; noted only to explain the fallback above
  }

  const live = records.filter((r) => r.some((cell) => cell.trim() !== ''))
  if (live.length === 0) {
    return { header: [], rows: [], delimiter, skippedPreamble: [], warnings: ['The file has no non-empty rows.'] }
  }

  const { headerIndex, preamble } = findHeaderRow(live)
  if (preamble.length > 0) {
    warnings.push(
      `Skipped ${preamble.length} decorative row${preamble.length === 1 ? '' : 's'} above the header.`,
    )
  }

  const rawHeader = live[headerIndex] ?? []
  const width = trimTrailingBlankColumns(live, headerIndex)
  if (width < rawHeader.length) {
    warnings.push(`Dropped ${rawHeader.length - width} trailing blank column(s).`)
  }

  // Build the header TO the detected width. `slice` cannot grow a short header,
  // so a file whose rows are wider than its header must have the missing names
  // synthesized here or the table comes out non-rectangular.
  const header = Array.from({ length: width }, (_, i) => {
    const clean = (rawHeader[i] ?? '').trim()
    return clean === '' ? `Column ${i + 1}` : clean
  })

  const rows: string[][] = []
  for (let r = headerIndex + 1; r < live.length; r++) {
    const row = live[r] ?? []
    if (row.length !== width) {
      // Ragged rows are normal (merged cells, short last row). Pad or trim
      // rather than rejecting, and only warn once.
      if (!warnings.some((w) => w.startsWith('Some rows had'))) {
        warnings.push(`Some rows had a different column count than the header; padded or trimmed to ${width}.`)
      }
    }
    if (row.length > rawHeader.length && !warnings.some((w) => w.startsWith('Some rows carry more'))) {
      // Keep the extra data and name the column rather than dropping content:
      // a spreadsheet with a merged header cell produces exactly this, and the
      // dropped column is usually real schedule detail.
      warnings.push(
        `Some rows carry more columns than the header. The extra ones are kept as "Column N" so nothing is lost.`,
      )
    }
    const padded = Array.from({ length: width }, (_, c) => (row[c] ?? '').trim())
    rows.push(padded)
  }

  return { header, rows, delimiter, skippedPreamble: preamble, warnings }
}

function lineByLineFallback(text: string, delimiter: string, warnings: string[]): CsvTable {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const records = lines.map((l) => splitLine(l, delimiter).map((c) => c.trim()))
  const { headerIndex, preamble } = findHeaderRow(records)
  const header = (records[headerIndex] ?? []).map((h, i) => (h === '' ? `Column ${i + 1}` : h))
  const rows = records.slice(headerIndex + 1).map((row) =>
    Array.from({ length: header.length }, (_, c) => (row[c] ?? '').trim()),
  )
  return { header, rows, delimiter, skippedPreamble: preamble, warnings }
}

/**
 * The header is the first row that looks structural rather than decorative.
 *
 * Three things disqualify a candidate:
 *
 *   - fewer than two non-empty cells — a lone banner like
 *     "CORPS OF CADETS — WEEKLY TRAINING SCHEDULE"
 *   - any cell that looks like data (a time range), which means the header is
 *     already behind us
 *   - EVERY non-empty cell carrying the same value
 *
 * That third rule exists because of spreadsheets. A title merged across
 * A1:H1 is one cell to a human and eight identical cells once the merge is
 * expanded — which passes the "at least two non-empty cells" test and gets
 * picked as the header, leaving the real header row treated as data and the
 * whole file unreadable. A genuine header names distinct columns.
 */
function findHeaderRow(records: string[][]): { headerIndex: number; preamble: string[] } {
  const preamble: string[] = []
  for (let i = 0; i < Math.min(records.length, 8); i++) {
    const row = records[i] ?? []
    const filled = row.filter((c) => c.trim() !== '')
    const looksLikeData = filled.some((c) => /^\d{1,2}[:.]?\d{2}\s*-\s*\d{1,2}[:.]?\d{2}$/.test(c.trim()))
    const allIdentical = filled.length >= 2 && new Set(filled.map((c) => c.trim())).size === 1

    if (filled.length >= 2 && !looksLikeData && !allIdentical) {
      return { headerIndex: i, preamble }
    }
    preamble.push(filled[0] ?? '')
  }
  return { headerIndex: 0, preamble: [] }
}

/** Width of the table ignoring columns that are blank in the header AND every row. */
function trimTrailingBlankColumns(records: string[][], headerIndex: number): number {
  const width = Math.max(...records.map((r) => r.length))
  let last = width
  while (last > 1) {
    const col = last - 1
    const headerBlank = ((records[headerIndex] ?? [])[col] ?? '').trim() === ''
    const allBlank = records.every((r, i) => i <= headerIndex || ((r[col] ?? '').trim() === ''))
    if (headerBlank && allBlank) last -= 1
    else break
  }
  return last
}

/** Normalized header key for fingerprinting and mapping memory. */
export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
