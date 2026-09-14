/**
 * A minimal XLSX reader.
 *
 * Why this exists: a published Corps schedule is a spreadsheet or a PDF, not a
 * tidy CSV. Making someone export to CSV before the planner will look at their
 * matrix adds a manual step to a weekly ritual, and manual steps in weekly
 * rituals are how tools get abandoned.
 *
 * Why it is hand-rolled rather than `exceljs`:
 *
 *   1. PRIVACY. Parsing has to happen on the device. The whole architecture
 *      rests on the schedule never being uploaded anywhere, so a server-side
 *      conversion route is not available, and a megabyte of library in the
 *      client bundle for one read path is a poor trade.
 *   2. NO DEPENDENCY NEEDED. An .xlsx is a ZIP of XML. Browsers inflate
 *      DEFLATE natively via `DecompressionStream`, which is available across
 *      every browser this app targets, so the only real work is reading the
 *      ZIP structure and two XML files.
 *   3. The same reasoning that produced the hand-rolled CSV and ICS readers:
 *      the interesting behaviour is surviving what real files contain, and
 *      that logic has to live somewhere we can fix and test.
 *
 * Scope is deliberately narrow — cell values from one worksheet, as strings.
 * No formulas, styles, charts or pivot tables. The matrix parser wants a grid
 * of text and nothing more.
 */

const TEXT = new TextDecoder('utf-8')

export interface XlsxSheet {
  name: string
  /** Rectangular grid of cell text, row-major. */
  rows: string[][]
}

export interface XlsxParseResult {
  sheets: XlsxSheet[]
  warnings: string[]
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  compression: number
  data: Uint8Array
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

/**
 * Read the ZIP central directory.
 *
 * The central directory is used rather than walking local file headers,
 * because a local header may carry zero sizes with the real values in a data
 * descriptor after the payload — which is exactly what streaming writers
 * produce, and what a naive reader gets wrong.
 */
function readZip(buffer: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buffer)

  // End of central directory: scan backwards for the signature.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65_557; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record).')

  const count = u16(bytes, eocd + 10)
  let offset = u32(bytes, eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < count; i++) {
    if (u32(bytes, offset) !== 0x02014b50) break
    const compression = u16(bytes, offset + 10)
    const compressedSize = u32(bytes, offset + 20)
    const nameLength = u16(bytes, offset + 28)
    const extraLength = u16(bytes, offset + 30)
    const commentLength = u16(bytes, offset + 32)
    const localOffset = u32(bytes, offset + 42)
    const name = TEXT.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    // Local header: the payload begins after its own variable-length fields.
    const localNameLength = u16(bytes, localOffset + 26)
    const localExtraLength = u16(bytes, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength

    entries.push({
      name,
      compression,
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    })

    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflate a stored (0) or deflated (8) entry. */
async function inflate(entry: ZipEntry): Promise<string> {
  if (entry.compression === 0) return TEXT.decode(entry.data)
  if (entry.compression !== 8) {
    throw new Error(`Unsupported compression method ${entry.compression} for ${entry.name}.`)
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress spreadsheets. Save the file as CSV and upload that instead.')
  }
  // `deflate-raw`: a ZIP member has no zlib header.
  const stream = new Blob([entry.data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return TEXT.decode(await new Response(stream).arrayBuffer())
}

// ---------------------------------------------------------------------------
// XML — enough of it, and no more
// ---------------------------------------------------------------------------

/** Cell references: `A1`, `AB12`, `XFD1048576`. */
export function decodeCellRef(ref: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!match?.[1] || !match[2]) return null
  let column = 0
  for (const char of match[1]) {
    column = column * 26 + (char.charCodeAt(0) - 64)
  }
  return { row: Number(match[2]) - 1, column: column - 1 }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

/**
 * Shared strings table.
 *
 * Every `<si>` is one string, but its text may be split across several `<t>`
 * runs when parts of it are styled differently — a bolded room number inside
 * an activity name does this. Concatenating the runs is what keeps
 * "BRC Formation" from arriving as "BRC" plus " Formation".
 */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  // Self-closing first, for the same reason as the cell scanner below: an
  // empty `<si/>` would otherwise swallow every entry up to the next `</si>`
  // and shift the whole table, silently relabelling every cell in the sheet.
  const items = xml.match(/<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []
  for (const item of items) {
    const runs = item.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []
    out.push(
      runs
        .map((run) => decodeEntities(run.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, '')))
        .join(''),
    )
  }
  return out
}

/**
 * Excel stores a time as a fraction of a day, so `0600` in a time-formatted
 * cell arrives as `0.25`. Left as "0.25" the time parser sees nonsense and the
 * row is dropped — which looks exactly like a broken file rather than a
 * conversion the reader failed to do.
 *
 * A bare fraction in [0, 1) is only treated as a time when the cell is
 * formatted as one; otherwise a legitimate numeric 0.5 would become "12:00".
 */
export function serialToClock(value: number): string {
  const minutes = Math.round(((value % 1) + 1) % 1 * 1440)
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`
}

/** Built-in numFmt ids that denote a time or a date-time. */
const TIME_FORMATS = new Set([18, 19, 20, 21, 22, 45, 46, 47])

/** Map style index → whether that style is a time format. */
function parseTimeStyles(stylesXml: string | undefined): Set<number> {
  const timeStyles = new Set<number>()
  if (!stylesXml) return timeStyles

  // Custom formats whose code contains h/m/s patterns.
  const customTime = new Set<number>()
  for (const fmt of stylesXml.match(/<numFmt\b[^>]*\/>/g) ?? []) {
    const id = /numFmtId="(\d+)"/.exec(fmt)?.[1]
    const code = /formatCode="([^"]*)"/.exec(fmt)?.[1] ?? ''
    if (id && /\bh{1,2}\b|hh?:mm|\[h\]/i.test(decodeEntities(code))) customTime.add(Number(id))
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  const xfs = cellXfs.match(/<xf\b[^>]*\/?>/g) ?? []
  xfs.forEach((xf, index) => {
    const id = Number(/numFmtId="(\d+)"/.exec(xf)?.[1] ?? '0')
    if (TIME_FORMATS.has(id) || customTime.has(id)) timeStyles.add(index)
  })
  return timeStyles
}

/**
 * Read one worksheet into a rectangular grid.
 *
 * Merged cells are expanded so every covered cell carries the value, because
 * a merged time label spanning four rows is the single most common shape in a
 * published schedule and the parser downstream reads cell by cell. Excel
 * stores the value only in the top-left of a merge; without expansion the
 * other three rows arrive blank.
 */
export function parseSheet(
  xml: string,
  shared: readonly string[],
  timeStyles: ReadonlySet<number>,
): string[][] {
  const grid: string[][] = []
  const set = (row: number, column: number, value: string): void => {
    while (grid.length <= row) grid.push([])
    const target = grid[row]
    if (!target) return
    while (target.length <= column) target.push('')
    target[column] = value
  }

  /**
   * Cell scanner. The SELF-CLOSING alternative must come first.
   *
   * Excel writes an empty cell as `<c r="B1"/>`. With the paired form first,
   * `[^>]*` eats the trailing slash, the `/>` branch fails, and the engine
   * then succeeds with `>[\s\S]*?</c>` — which runs past every self-closing
   * cell after it to find the next `</c>`, possibly rows later. One match then
   * swallows a dozen cells and adopts a distant cell's value:
   *
   *   <c r="A7"/></row><row r="8">...<c r="A10" t="s"><v>15</v></c>
   *   ^------------------- matched as one cell -------------------^
   *
   * which silently reports A7's value as A10's. Putting the self-closing
   * branch first makes the match unambiguous, because it is tried — and
   * succeeds — before the greedy one is considered.
   */
  const cells = xml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []
  for (const cell of cells) {
    const ref = /\br="([A-Z]+\d+)"/.exec(cell)?.[1]
    if (!ref) continue
    const position = decodeCellRef(ref)
    if (!position) continue

    const type = /\bt="([^"]+)"/.exec(cell)?.[1] ?? 'n'
    const styleIndex = Number(/\bs="(\d+)"/.exec(cell)?.[1] ?? '-1')

    let value = ''
    if (type === 's') {
      // Shared string: <v> holds the index.
      const index = Number(/<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? '-1')
      value = shared[index] ?? ''
    } else if (type === 'inlineStr') {
      const runs = cell.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? []
      value = runs.map((r) => decodeEntities(r.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join('')
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1]
      if (raw === undefined) continue
      value = decodeEntities(raw)
      const numeric = Number(value)
      // A time-formatted numeric cell must be rendered back as a clock time.
      if (Number.isFinite(numeric) && timeStyles.has(styleIndex)) {
        value = serialToClock(numeric)
      }
    }
    set(position.row, position.column, value.trim())
  }

  // Expand merges: Excel keeps the value only in the top-left cell.
  for (const merge of xml.match(/<mergeCell\b[^>]*ref="[^"]+"/g) ?? []) {
    const ref = /ref="([^"]+)"/.exec(merge)?.[1]
    if (!ref) continue
    const [fromRef, toRef] = ref.split(':')
    if (!fromRef || !toRef) continue
    const from = decodeCellRef(fromRef)
    const to = decodeCellRef(toRef)
    if (!from || !to) continue
    const value = grid[from.row]?.[from.column] ?? ''
    if (value === '') continue
    for (let r = from.row; r <= to.row; r++) {
      for (let c = from.column; c <= to.column; c++) {
        if ((grid[r]?.[c] ?? '') === '') set(r, c, value)
      }
    }
  }

  const width = Math.max(0, ...grid.map((row) => row.length))
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseXlsx(buffer: ArrayBuffer): Promise<XlsxParseResult> {
  const warnings: string[] = []
  const entries = readZip(buffer)
  const byName = new Map(entries.map((e) => [e.name, e]));

  const read = async (name: string): Promise<string | undefined> => {
    const entry = byName.get(name)
    return entry ? await inflate(entry) : undefined
  }

  const workbook = await read('xl/workbook.xml')
  if (!workbook) throw new Error('This file is a ZIP but not a spreadsheet — xl/workbook.xml is missing.')

  const sharedXml = await read('xl/sharedStrings.xml')
  const shared = sharedXml ? parseSharedStrings(sharedXml) : []
  const timeStyles = parseTimeStyles(await read('xl/styles.xml'))

  // Sheet order and names come from the workbook; the relationship ids map to
  // files, but sheetN.xml ordering matches in every writer worth supporting.
  const names = [...(workbook.match(/<sheet\b[^>]*\/?>/g) ?? [])]
    .map((tag) => decodeEntities(/name="([^"]*)"/.exec(tag)?.[1] ?? ''))
    .filter((name) => name !== '')

  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const an = Number(/sheet(\d+)\.xml$/.exec(a.name)?.[1] ?? '0')
      const bn = Number(/sheet(\d+)\.xml$/.exec(b.name)?.[1] ?? '0')
      return an - bn
    })

  if (sheetEntries.length === 0) throw new Error('This spreadsheet contains no worksheets.')

  const sheets: XlsxSheet[] = []
  for (const [index, entry] of sheetEntries.entries()) {
    try {
      const rows = parseSheet(await inflate(entry), shared, timeStyles)
      if (rows.length === 0) continue
      sheets.push({ name: names[index] ?? `Sheet ${index + 1}`, rows })
    } catch (error) {
      warnings.push(
        `Sheet ${names[index] ?? index + 1} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  if (sheets.length === 0) throw new Error('No readable worksheet was found in this spreadsheet.')
  if (sheets.length > 1) {
    warnings.push(
      `This workbook has ${sheets.length} sheets. Reading "${sheets[0]?.name}" — if the schedule is on another sheet, say which.`,
    )
  }
  return { sheets, warnings }
}

/**
 * Render a grid back to CSV so it can go through the same matrix detector,
 * mapping memory and cell-content parser as an uploaded CSV.
 *
 * Converting to CSV rather than adding a second path into the matrix parser is
 * deliberate: one code path means a spreadsheet and a CSV cannot drift apart in
 * how they are read, and every fix to the matrix parser applies to both.
 */
export function gridToCsv(rows: readonly string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[",\n;]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(','),
    )
    .join('\n')
}

/** Does this filename look like a spreadsheet we should try to unzip? */
export function isSpreadsheetName(filename: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(filename.trim())
}
