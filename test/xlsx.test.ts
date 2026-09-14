import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeCellRef,
  gridToCsv,
  isSpreadsheetName,
  parseSharedStrings,
  parseXlsx,
  serialToClock,
} from '@/lib/parse/xlsx'
import { detectMatrix, parseMatrix } from '@/lib/parse/matrix'
import { dayOf, formatClock, spanLength } from '@/lib/domain/time'

/**
 * The fixture is written by exceljs — a real Excel writer — so this reader is
 * validated against genuine .xlsx output rather than against my own
 * assumptions about the format.
 */
const workbook = readFileSync(join(__dirname, 'fixtures', 'matrix.xlsx'))
const buffer = workbook.buffer.slice(
  workbook.byteOffset,
  workbook.byteOffset + workbook.byteLength,
) as ArrayBuffer

describe('cell references', () => {
  it('decodes single and multi-letter columns', () => {
    expect(decodeCellRef('A1')).toEqual({ row: 0, column: 0 })
    expect(decodeCellRef('B3')).toEqual({ row: 2, column: 1 })
    expect(decodeCellRef('Z1')).toEqual({ row: 0, column: 25 })
    expect(decodeCellRef('AA1')).toEqual({ row: 0, column: 26 })
    expect(decodeCellRef('AB12')).toEqual({ row: 11, column: 27 })
  })

  it('rejects nonsense', () => {
    expect(decodeCellRef('1A')).toBeNull()
    expect(decodeCellRef('')).toBeNull()
  })
})

describe('time serials', () => {
  /**
   * Excel stores a time as a fraction of a day, so 06:00 in a time-formatted
   * cell arrives as 0.25. Left as "0.25" the time parser sees nonsense and
   * drops the row — which looks like a broken file rather than a conversion
   * the reader failed to perform.
   */
  it('converts a day fraction back to a clock time', () => {
    expect(serialToClock(0.25)).toBe('0600')
    expect(serialToClock(0.5)).toBe('1200')
    expect(serialToClock(0)).toBe('0000')
    expect(serialToClock(0.7916666666666666)).toBe('1900')
  })

  it('ignores the date part of a date-time serial', () => {
    // 45000.25 is a date at 06:00; only the time matters here.
    expect(serialToClock(45_000.25)).toBe('0600')
  })
})

describe('shared strings', () => {
  it('joins runs split by styling', () => {
    const xml = '<sst><si><r><t>BRC </t></r><r><t>Formation</t></r></si></sst>'
    expect(parseSharedStrings(xml)).toEqual(['BRC Formation'])
  })

  it('decodes entities', () => {
    expect(parseSharedStrings('<sst><si><t>Mess &amp; Chow</t></si></sst>')).toEqual(['Mess & Chow'])
    expect(parseSharedStrings('<sst><si><t>Mess &quot;A&quot; Line</t></si></sst>')).toEqual(['Mess "A" Line'])
  })

  it('handles an empty string entry', () => {
    expect(parseSharedStrings('<sst><si><t></t></si></sst>')).toEqual([''])
  })
})

describe('reading a real .xlsx', () => {
  it('unzips and finds the worksheet', async () => {
    const result = await parseXlsx(buffer)
    expect(result.sheets).toHaveLength(1)
    expect(result.sheets[0]?.name).toBe('Training Schedule')
    expect(result.sheets[0]?.rows.length).toBeGreaterThan(8)
  })

  it('produces a rectangular grid', async () => {
    const { sheets } = await parseXlsx(buffer)
    const rows = sheets[0]!.rows
    const width = rows[0]!.length
    expect(rows.every((r) => r.length === width)).toBe(true)
  })

  it('reads the header row', async () => {
    const { sheets } = await parseXlsx(buffer)
    // Rows 0 and 1 are the decorative title block; the real header is row 2.
    const header = sheets[0]!.rows[2]
    expect(header?.slice(0, 8)).toEqual(['TIME', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
  })

  it('converts a time-formatted numeric cell to a clock time', async () => {
    const { sheets } = await parseXlsx(buffer)
    // Row 4 col A was written as the number 0.25 with an hh:mm format.
    expect(sheets[0]!.rows[3]?.[0]).toBe('0600')
  })

  /**
   * The most valuable thing this reader does. A merged time cell spanning four
   * rows is the commonest shape in a published matrix, and Excel stores the
   * value only in the top-left — so without expansion three of the four rows
   * arrive blank and their activities are silently dropped.
   */
  it('expands a merged cell across every row it covers', async () => {
    const { sheets } = await parseXlsx(buffer)
    const rows = sheets[0]!.rows
    // A6:A9 merged, value in A6 only. Zero-indexed that is rows 5 through 8.
    expect(rows[5]?.[0]).toBe('1900-2100')
    expect(rows[6]?.[0]).toBe('1900-2100')
    expect(rows[7]?.[0]).toBe('1900-2100')
    expect(rows[8]?.[0]).toBe('1900-2100')
  })

  it('joins rich text split across runs', async () => {
    const { sheets } = await parseXlsx(buffer)
    const flat = sheets[0]!.rows.flat().join(' | ')
    expect(flat).toContain('Guard @ Jackson Arch')
  })

  it('decodes ampersands and quotes', async () => {
    const { sheets } = await parseXlsx(buffer)
    const flat = sheets[0]!.rows.flat()
    expect(flat).toContain('Mess & Chow')
    expect(flat).toContain('Mess "A" Line')
  })

  /**
   * Regression: Excel writes an empty cell as `<c r="B1"/>`, and a cell
   * scanner that prefers the paired form will match from there to the next
   * `</c>` — rows later — swallowing every cell between and adopting a
   * distant cell's value. This fixture has runs of self-closing cells
   * immediately before valued ones, which is exactly the trigger.
   */
  it('does not let an empty self-closing cell swallow the cells after it', async () => {
    const { sheets } = await parseXlsx(buffer)
    const rows = sheets[0]!.rows

    // Row 1 (the subtitle) is merged A2:H2, so every column carries it — and
    // crucially NOT the header's "TIME", which lives one row below.
    expect(rows[1]?.[1]).toBe('Effective 14 SEP 2026')
    expect(rows[1]?.[1]).not.toBe('TIME')

    // A7 is an empty cell followed by empty rows and then A10="2300-0100".
    // The bug reported A7 as "2300-0100"; correct is the merged "1900-2100".
    expect(rows[6]?.[0]).toBe('1900-2100')
    expect(rows[9]?.[0]).toBe('2300-0100')

    // And the title row is the title in every column, not the subtitle.
    expect(new Set(rows[0]).size).toBe(1)
  })

  it('refuses a file that is not a spreadsheet', async () => {
    await expect(parseXlsx(new TextEncoder().encode('just some text').buffer as ArrayBuffer)).rejects.toThrow(/ZIP/)
  })
})

describe('a spreadsheet goes through the same pipeline as a CSV', () => {
  /**
   * The conversion to CSV is deliberate. One code path means a spreadsheet and
   * a CSV cannot drift apart in how they are read, and every fix to the matrix
   * parser applies to both.
   */
  it('round-trips through the matrix detector and parser', async () => {
    const { sheets } = await parseXlsx(buffer)
    const csv = gridToCsv(sheets[0]!.rows)
    const detection = detectMatrix(csv)

    expect(detection.shape).toBe('wide')
    expect(detection.wide?.dayColumns).toHaveLength(7)

    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events.length).toBeGreaterThan(8)

    // The 06:00 SRC came from a numeric time cell.
    const src = events.find((e) => e.title === 'SRC')
    expect(src).toBeDefined()
    expect(formatClock(src!.span.start)).toBe('06:00')
    expect(src!.uniform).toBe('Class B')

    // The formation came through on all five weekdays.
    const formations = events.filter((e) => e.title === 'BRC Formation')
    expect(formations.map((e) => dayOf(e.span.start))).toEqual([0, 1, 2, 3, 4])

    // SST came from the merged time cell: it must appear, and be two hours.
    const sst = events.filter((e) => e.title === 'SST')
    expect(sst.length).toBeGreaterThan(0)
    expect(spanLength(sst[0]!.span)).toBe(120)

    // Guard's location survived the rich-text split.
    const guard = events.find((e) => e.title === 'Guard')
    expect(guard?.location).toBe('Jackson Arch')
  })

  it('quotes cells that would otherwise break the CSV', () => {
    expect(gridToCsv([['a,b', 'c"d', 'plain']])).toBe('"a,b","c""d",plain')
  })
})

describe('filename detection', () => {
  it('recognises spreadsheets and not csvs', () => {
    expect(isSpreadsheetName('matrix.xlsx')).toBe(true)
    expect(isSpreadsheetName('MATRIX.XLSX')).toBe(true)
    expect(isSpreadsheetName('matrix.xlsm')).toBe(true)
    expect(isSpreadsheetName('matrix.csv')).toBe(false)
    expect(isSpreadsheetName('matrix.xls')).toBe(false) // legacy binary, not a ZIP
  })
})
