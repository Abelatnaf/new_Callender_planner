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

import {
  type GridCell, type SheetGrid, type WorkbookGrid,
  MAX_COLS, MAX_ROWS, cellToText, colName, parseRef,
} from "./grid";

// Re-exported so existing importers of lib/xlsx keep working; the
// implementations now live in lib/grid.ts, which is browser-safe.
export {
  type GridCell, type SheetGrid, type WorkbookGrid,
  cellToText, colName, renderSheetForModel, renderWorkbookForModel, trimSheet,
} from "./grid";

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
