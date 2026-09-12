/**
 * The CSV reader, which reads the file that matters most.
 *
 * The Matrix arrives as a spreadsheet export and its columns are POSITIONAL:
 * Time | PAX | Event | Location | Uniform | Instructor. A parser that loses a
 * delimiter does not produce a slightly wrong row, it produces a row whose
 * every field after the mistake belongs to the wrong column — and the model
 * downstream has no way to know.
 */
import { describe, expect, it } from "vitest";
import { parseCsv, readCsv } from "@/lib/csv";

describe("quoted fields", () => {
  it("handles quoted fields containing commas", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("handles doubled quotes inside a quoted field", () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([["a", 'say "hi"', "c"]]);
  });

  it("handles a newline inside a quoted field", () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });

  it("does not leave a carriage return inside a quoted field", () => {
    // A spreadsheet exported on Windows puts CRLF inside the quotes too, and a
    // stray \r rides into the value and out the other side into the model.
    expect(parseCsv('a,"x\r\ny",c')).toEqual([["a", "x\ny", "c"]]);
  });

  it("handles CRLF and a BOM", () => {
    expect(parseCsv("﻿a,b\r\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("keeps empty trailing fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("still yields the row when a quote is never closed", () => {
    // Lenient on purpose: losing the last row of a day section because one
    // cell was malformed is worse than keeping a slightly odd value.
    expect(parseCsv('a,"b,c')).toEqual([["a", "b,c"]]);
  });
});

describe("a quote that is not opening a field is just a character", () => {
  // The bug this covers: a quote anywhere used to open quoted mode, so the
  // delimiters after it were swallowed and the quote itself vanished.
  it("keeps an inch mark and the columns around it", () => {
    expect(parseCsv('Drill,6" gun,Parade Ground')).toEqual([
      ["Drill", '6" gun', "Parade Ground"],
    ]);
  });

  it("does not let a stray quote eat the rest of a Matrix row", () => {
    const row = '1400,Corps,6" Gun Drill,Parade Ground,Class Dyke,CPT Smith';
    const [cells] = parseCsv(row);
    expect(cells).toHaveLength(6);
    expect(cells[3]).toBe("Parade Ground");   // Location, not folded into Event
    expect(cells[4]).toBe("Class Dyke");      // Uniform
    expect(cells[5]).toBe("CPT Smith");       // Instructor
  });

  it("treats text after a closing quote as continuation, not a new quote", () => {
    expect(parseCsv('a,"abc"def,c')).toEqual([["a", "abcdef", "c"]]);
  });

  it("keeps a quote that ends a field", () => {
    expect(parseCsv('a,6",c')).toEqual([["a", '6"', "c"]]);
  });
});

describe("rows and shape", () => {
  it("reads several rows", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a,b\n")).toHaveLength(1);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("readCsv builds the grid the rest of the app expects", () => {
  it("places cells one-indexed with spreadsheet refs", () => {
    const wb = readCsv("Time,PAX\n0700,Corps\n", "Week03.csv");
    const [sheet] = wb.sheets;
    expect(sheet.cells).toContainEqual({ row: 1, col: 1, ref: "A1", value: "Time" });
    expect(sheet.cells).toContainEqual({ row: 2, col: 2, ref: "B2", value: "Corps" });
  });

  it("drops empty cells rather than carrying thousands of them", () => {
    // The real export is 16,380 columns wide and almost entirely blank.
    const wb = readCsv("a,,,,\n,,,,b\n");
    expect(wb.sheets[0].cells.map((c) => c.value)).toEqual(["a", "b"]);
  });

  it("trims whitespace off each cell", () => {
    expect(readCsv("  Corps PT  ,x").sheets[0].cells[0].value).toBe("Corps PT");
  });

  it("reports the widest row as the column count", () => {
    expect(readCsv("a\na,b,c").sheets[0].colCount).toBe(3);
  });

  it("names the sheet after the file, without the extension", () => {
    expect(readCsv("a", "Week03_FinalMaster.csv").sheets[0].name).toBe("Week03_FinalMaster");
  });

  it("yields no sheet at all for a file with nothing in it", () => {
    expect(readCsv(",,,\n,,,\n").sheets).toEqual([]);
  });
});
