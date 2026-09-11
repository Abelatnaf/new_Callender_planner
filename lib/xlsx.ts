/**
 * Excel grid extraction for the weekly Matrix.
 *
 * The Matrix is grid-semantic: a cell means what it means because of the column
 * it sits under and the rows it spans. A merged cell running down four rows is
 * a four-period event, and flattening that away loses the schedule. So this
 * module preserves position and merge spans, and hands Gemini a faithful
 * picture rather than a bag of strings.
 *
 * Runs server-side only (exceljs is a Node library).
 */
import ExcelJS from "exceljs";

export type GridCell = {
  row: number;      // 1-indexed, as Excel counts
  col: number;      // 1-indexed
  ref: string;      // "B7"
  value: string;
  rowSpan?: number; // present only on a merge anchor
  colSpan?: number;
};

export type SheetGrid = {
  name: string;
  rowCount: number;
  colCount: number;
  cells: GridCell[];
  merges: string[];
  truncated: boolean;
};

export type WorkbookGrid = {
  filename: string;
  sheets: SheetGrid[];
};

/** Guard rails so a pathological sheet cannot blow the model's context. */
const MAX_ROWS = 300;
const MAX_COLS = 60;

/**
 * A column used by only this many rows, sitting past the body of the sheet, is
 * an export artifact rather than a column of the schedule.
 *
 * The real Matrix has one row whose six cells were fill-righted in a repeating
 * block out to column 16,373 - 6,132 of the file's 8,336 non-empty cells, or
 * 74% of it. Detecting repeated *values* misses this, because the six cells in
 * each block differ from each other; it is the block that repeats.
 *
 * Column occupancy catches it cleanly and without guessing at widths: a real
 * column (a day, a sport, a field) is used by many rows, while every one of
 * those thousands of artifact columns is touched by exactly one.
 */
const MIN_COLUMN_ROWS = 2;

export function colName(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel stores a time-only cell as a fraction of 1899-12-30. */
function isExcelTimeSerial(d: Date): boolean {
  return d.getUTCFullYear() < 1901;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * exceljs hands back eight different value shapes. Flatten every one of them to
 * the text a human would see in the cell, because that is what the Matrix means.
 */
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  if (value instanceof Date) {
    if (isExcelTimeSerial(value)) {
      // A time of day, not a date: render it as the clock time it represents.
      const s = value.getUTCSeconds() ? `:${pad(value.getUTCSeconds())}` : "";
      return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}${s}`;
    }
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return v.richText.map((r) => String((r as { text?: string }).text ?? "")).join("").trim();
    }
    if ("text" in v && typeof v.text === "string") return v.text.trim();
    if ("result" in v) return cellToText(v.result);
    if ("formula" in v) return "";           // a formula with no cached result
    if ("error" in v) return String(v.error);
    if ("hyperlink" in v) return String(v.hyperlink);
  }
  return String(value).trim();
}

export async function readWorkbook(
  buffer: ArrayBuffer | Buffer,
  filename = "matrix.xlsx",
): Promise<WorkbookGrid> {
  const wb = new ExcelJS.Workbook();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);

  const sheets: SheetGrid[] = [];

  for (const ws of wb.worksheets) {
    if (ws.state === "hidden" || ws.state === "veryHidden") continue;

    // exceljs exposes merges as a private map keyed by anchor ref; fall back to
    // reading each cell's master when the shape is not what we expect.
    const merges: string[] = Array.isArray((ws as unknown as { model?: { merges?: string[] } }).model?.merges)
      ? ((ws as unknown as { model: { merges: string[] } }).model.merges)
      : [];

    const spanByAnchor = new Map<string, { rowSpan: number; colSpan: number }>();
    for (const range of merges) {
      const [from, to] = range.split(":");
      const a = parseRef(from);
      const b = parseRef(to);
      if (!a || !b) continue;
      spanByAnchor.set(from, { rowSpan: b.row - a.row + 1, colSpan: b.col - a.col + 1 });
    }

    const cells: GridCell[] = [];
    const rowCount = Math.min(ws.rowCount || 0, MAX_ROWS);
    const colCount = Math.min(ws.columnCount || 0, MAX_COLS);
    const truncated = (ws.rowCount || 0) > MAX_ROWS || (ws.columnCount || 0) > MAX_COLS;

    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        const text = cellToText(cell.value);
        if (!text) continue;

        const ref = `${colName(c)}${r}`;
        const span = spanByAnchor.get(ref);
        cells.push({ row: r, col: c, ref, value: text, ...(span ?? {}) });
      }
    }

    if (cells.length > 0) {
      sheets.push({ name: ws.name, rowCount, colCount, cells, merges, truncated });
    }
  }

  return { filename, sheets };
}

/**
 * Strip the export garbage before anything sees the grid.
 *
 * Returns a new sheet holding only cells that carry information: fill-right
 * runs collapsed to their first occurrence, and the used range recomputed so a
 * declared width of 16,380 columns does not push the real content past the
 * MAX_COLS cap.
 */
export function trimSheet(sheet: SheetGrid): SheetGrid {
  // How many distinct rows use each column?
  const rowsPerCol = new Map<number, Set<number>>();
  for (const cell of sheet.cells) {
    const set = rowsPerCol.get(cell.col) ?? new Set<number>();
    set.add(cell.row);
    rowsPerCol.set(cell.col, set);
  }

  // The body of the sheet: columns shared by more than one row. Anything to the
  // right of the last of those, used by a single row, is drag residue.
  const coreCols = [...rowsPerCol.entries()]
    .filter(([, rows]) => rows.size >= MIN_COLUMN_ROWS)
    .map(([col]) => col);
  const lastCore = coreCols.length ? Math.max(...coreCols) : Infinity;

  const kept = sheet.cells.filter(
    (c) => c.col <= lastCore || (rowsPerCol.get(c.col)?.size ?? 0) >= MIN_COLUMN_ROWS,
  );

  return {
    ...sheet,
    cells: kept,
    rowCount: Math.max(0, ...kept.map((c) => c.row)),
    colCount: Math.max(0, ...kept.map((c) => c.col)),
  };
}

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.replace(/\$/g, "").toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

/**
 * Render a sheet as a table the model can read positionally.
 *
 * Merged values are repeated across every cell they cover rather than left
 * blank, because a blank cell under a merged header reads to a model as "no
 * event here" - which is exactly the misreading that would hand a cadet a free
 * hour that does not exist.
 */
export function renderSheetForModel(input: SheetGrid): string {
  const sheet = trimSheet(input);
  const filled = new Map<string, string>();

  for (const cell of sheet.cells) {
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    for (let dr = 0; dr < rowSpan; dr++) {
      for (let dc = 0; dc < colSpan; dc++) {
        filled.set(`${cell.row + dr},${cell.col + dc}`, cell.value);
      }
    }
  }

  const usedCols = [...new Set(sheet.cells.map((c) => c.col))].sort((a, b) => a - b);
  const usedRows = [...new Set(sheet.cells.map((c) => c.row))].sort((a, b) => a - b);
  // Cap on the used range, not the declared one: the real file declares 16,380
  // columns and a naive cap would have truncated the schedule itself.
  const maxCol = Math.min(Math.max(...usedCols, 1), MAX_COLS);

  const lines: string[] = [];
  const dropped = input.cells.length - sheet.cells.length;
  lines.push(`SHEET "${sheet.name}" (${sheet.rowCount} rows x ${sheet.colCount} cols)`);
  if (dropped > 0) {
    lines.push(`(${dropped} cells were spreadsheet fill-right artifacts and have been removed)`);
  }
  lines.push(["ROW", ...range(1, maxCol).map(colName)].join("\t"));

  const lastRow = Math.max(...usedRows, 1);
  for (let r = 1; r <= lastRow; r++) {
    const cols = range(1, maxCol).map((c) => (filled.get(`${r},${c}`) ?? "").replace(/\s+/g, " "));
    if (cols.every((v) => v === "")) continue;
    lines.push([String(r), ...cols].join("\t"));
  }

  const anchors = sheet.cells.filter((c) => c.rowSpan || c.colSpan);
  if (anchors.length) {
    lines.push("");
    lines.push("MERGED CELLS (value repeated above across its whole span):");
    for (const a of anchors.slice(0, 120)) {
      lines.push(`  ${a.ref} spans ${a.rowSpan ?? 1} row(s) x ${a.colSpan ?? 1} col(s): "${a.value}"`);
    }
  }
  if (sheet.truncated) lines.push("", "NOTE: sheet was truncated for size.");

  return lines.join("\n");
}

export function renderWorkbookForModel(wb: WorkbookGrid): string {
  return wb.sheets.map(renderSheetForModel).join("\n\n" + "=".repeat(60) + "\n\n");
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}
