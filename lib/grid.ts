/**
 * The spreadsheet grid, and what to do with it - with no spreadsheet library.
 *
 * Split out of lib/xlsx.ts so the browser can trim a 2.4MB Matrix before
 * uploading it without pulling ExcelJS into the bundle. Everything here is
 * pure: a grid in, a smaller grid or a string out.
 */
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
export const MAX_ROWS = 300;
export const MAX_COLS = 60;

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

export function parseRef(ref: string): { row: number; col: number } | null {
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
