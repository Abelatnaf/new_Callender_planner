/**
 * CSV reading for the Matrix.
 *
 * The real weekly Matrix arrives as a CSV exported from a spreadsheet, and the
 * export is pathological: 146 rows by 16,380 columns, of which only ~2,200
 * cells in the first 30 columns are the actual schedule. The rest is one row
 * fill-righted across a thousand columns.
 *
 * Hand-rolled rather than a dependency because the only hard parts of CSV -
 * quoted fields containing commas, newlines and doubled quotes - are twenty
 * lines, and the grid this produces has to match the shape lib/xlsx.ts emits.
 */
import type { GridCell, SheetGrid, WorkbookGrid } from "./xlsx";
import { colName } from "./xlsx";

/** RFC 4180 with the usual real-world tolerances: CRLF, LF, and a BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else quoted = false;
      } else if (ch !== "\r") field += ch;              // CRLF inside a quoted field
      continue;
    }

    // A quote only OPENS a field when the field is still empty. Anywhere else
    // it is a literal character - the same tolerance Excel and Python's csv
    // module apply outside strict mode. Treating every quote as an opener made
    // `Drill,6" gun,Parade Ground` collapse into two cells with the quote
    // dropped, and because the Matrix's columns are positional, every field
    // after it shifted: Location, Uniform and Instructor folded into Event.
    if (ch === '"' && field === "") { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export function readCsv(text: string, filename = "matrix.csv"): WorkbookGrid {
  const rows = parseCsv(text);
  const cells: GridCell[] = [];

  for (const [r, row] of rows.entries()) {
    for (const [c, raw] of row.entries()) {
      const value = raw.trim();
      if (!value) continue;
      cells.push({ row: r + 1, col: c + 1, ref: `${colName(c + 1)}${r + 1}`, value });
    }
  }

  const sheet: SheetGrid = {
    name: filename.replace(/\.csv$/i, ""),
    rowCount: rows.length,
    colCount: Math.max(0, ...rows.map((r) => r.length)),
    cells,
    merges: [],
    truncated: false,
  };
  return { filename, sheets: sheet.cells.length ? [sheet] : [] };
}
