/**
 * Regenerates test/fixtures/matrix.xlsx.
 *
 * The .xlsx reader is hand-rolled, so its fixture must come from a real Excel
 * writer rather than from the reader's own idea of the format — otherwise the
 * tests only prove the reader agrees with itself. `exceljs` is a devDependency
 * for exactly this, and is not shipped in the app bundle.
 *
 *   npm run fixture:xlsx
 */
import { writeFileSync } from 'node:fs'
import ExcelJS from 'exceljs'

const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Training Schedule')

// A decorative title block above the real header, merged across the width.
ws.addRow(['CORPS OF CADETS — WEEKLY TRAINING SCHEDULE'])
ws.addRow(['Effective 14 SEP 2026'])
ws.mergeCells('A1:H1')
ws.mergeCells('A2:H2')

ws.addRow(['TIME', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])

// A real time-formatted numeric cell: Excel stores 06:00 as the fraction 0.25.
const timed = ws.addRow([null, null, 'SRC / Class B', null, 'SRC / Class B', null, null, null])
timed.getCell(1).value = 0.25
timed.getCell(1).numFmt = 'hh:mm'

ws.addRow(['0630-0700', 'BRC Formation', 'BRC Formation', 'BRC Formation', 'BRC Formation', 'BRC Formation', null, null])

// One time cell merged down four rows — the commonest shape in a published
// matrix, and the one where Excel stores the value only in the top-left.
ws.addRow(['1900-2100', 'SST', 'SST', 'SST', 'SST', null, null, null])
ws.addRow([])
ws.addRow([])
ws.addRow([])
ws.mergeCells('A6:A9')

// Rich text split across runs, which must not arrive as two separate strings.
const rich = ws.addRow(['2300-0100', null, null, null, null, null, null, null])
rich.getCell(6).value = {
  richText: [{ text: 'Guard ', font: { bold: true } }, { text: '@ Jackson Arch' }],
}

// Entities that have to survive decoding.
ws.addRow(['1200-1245', 'Mess & Chow', 'Mess "A" Line', 'Mess', 'Mess', 'Mess', 'Mess', 'Mess'])

const buffer = await wb.xlsx.writeBuffer()
writeFileSync(new URL('../test/fixtures/matrix.xlsx', import.meta.url), Buffer.from(buffer))
console.log(`wrote test/fixtures/matrix.xlsx (${buffer.byteLength} bytes)`)
