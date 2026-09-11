import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { cellToText, colName, readWorkbook, renderSheetForModel } from "@/lib/xlsx";

/** Build a workbook shaped like a VMI weekly Matrix. */
async function buildMatrixWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("MATRIX");

  ws.getCell("A1").value = "WEEK OF 07 SEP 2026";
  ws.mergeCells("A1:F1");

  ws.getCell("A2").value = "TIME";
  ws.getCell("B2").value = "MON";
  ws.getCell("C2").value = "TUE";
  ws.getCell("D2").value = "WED";
  ws.getCell("E2").value = "THU";
  ws.getCell("F2").value = "FRI";

  // A time-formatted cell: Excel stores this as a fraction of a day.
  const t = ws.getCell("A3");
  t.value = new Date(Date.UTC(1899, 11, 30, 6, 30));
  t.numFmt = "hh:mm";

  ws.getCell("B3").value = "BRC";
  ws.getCell("C3").value = "BRC";
  ws.getCell("D3").value = "BRC";

  ws.getCell("A4").value = "0800";
  ws.getCell("B4").value = "CLASS";

  // Corps Athletics runs 1600-1730, spanning three rows on Monday.
  ws.getCell("A5").value = "1600";
  ws.getCell("A6").value = "1630";
  ws.getCell("A7").value = "1700";
  ws.getCell("B5").value = "CORPS ATHLETICS";
  ws.mergeCells("B5:B7");

  // A parade spanning the whole Friday column-block.
  ws.getCell("E5").value = { richText: [{ text: "PARADE " }, { text: "(FULL DRESS)" }] } as ExcelJS.CellValue;

  ws.getCell("A8").value = "1930";
  ws.getCell("B8").value = "CQ";
  ws.getCell("C8").value = "CQ";

  return (await wb.xlsx.writeBuffer()) as Buffer;
}

describe("cellToText", () => {
  it("flattens every shape exceljs can hand back", () => {
    expect(cellToText("  BRC  ")).toBe("BRC");
    expect(cellToText(42)).toBe("42");
    expect(cellToText(true)).toBe("TRUE");
    expect(cellToText(null)).toBe("");
    expect(cellToText(undefined)).toBe("");
    expect(cellToText({ richText: [{ text: "PARADE " }, { text: "(FD)" }] })).toBe("PARADE (FD)");
    expect(cellToText({ formula: "A1+1", result: 7 })).toBe("7");
    expect(cellToText({ formula: "A1+1" })).toBe("");
    expect(cellToText({ error: "#REF!" })).toBe("#REF!");
    expect(cellToText({ text: "linked", hyperlink: "https://x" })).toBe("linked");
  });

  it("renders an Excel time serial as a clock time, not a 1899 date", () => {
    expect(cellToText(new Date(Date.UTC(1899, 11, 30, 6, 30)))).toBe("06:30");
    expect(cellToText(new Date(Date.UTC(1899, 11, 30, 19, 5)))).toBe("19:05");
  });

  it("renders a real date as a date", () => {
    expect(cellToText(new Date(Date.UTC(2026, 8, 7)))).toBe("2026-09-07");
  });
});

describe("colName", () => {
  it("counts like Excel", () => {
    expect(colName(1)).toBe("A");
    expect(colName(26)).toBe("Z");
    expect(colName(27)).toBe("AA");
    expect(colName(52)).toBe("AZ");
  });
});

describe("readWorkbook", () => {
  it("extracts cells with their positions", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    expect(grid.sheets).toHaveLength(1);
    const sheet = grid.sheets[0];
    expect(sheet.name).toBe("MATRIX");

    const b3 = sheet.cells.find((c) => c.ref === "B3");
    expect(b3?.value).toBe("BRC");
    expect(b3?.row).toBe(3);
    expect(b3?.col).toBe(2);
  });

  it("converts time-formatted cells to clock times", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const a3 = grid.sheets[0].cells.find((c) => c.ref === "A3");
    expect(a3?.value).toBe("06:30");
  });

  it("flattens rich text into the string a human sees", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const e5 = grid.sheets[0].cells.find((c) => c.ref === "E5");
    expect(e5?.value).toBe("PARADE (FULL DRESS)");
  });

  it("records merge spans on the anchor cell", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const anchor = grid.sheets[0].cells.find((c) => c.ref === "B5");
    expect(anchor?.value).toBe("CORPS ATHLETICS");
    expect(anchor?.rowSpan).toBe(3);
    expect(anchor?.colSpan).toBe(1);
  });

  it("skips empty cells entirely", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    expect(grid.sheets[0].cells.every((c) => c.value !== "")).toBe(true);
  });
});

describe("renderSheetForModel", () => {
  it("repeats a merged value across every row it covers", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const text = renderSheetForModel(grid.sheets[0]);
    const lines = text.split("\n");

    // Corps Athletics is anchored at B5 and must also appear on rows 6 and 7.
    // A blank there would read to the model as free time that does not exist.
    for (const r of ["5", "6", "7"]) {
      const row = lines.find((l) => l.startsWith(`${r}\t`));
      expect(row, `row ${r} missing`).toBeDefined();
      expect(row).toContain("CORPS ATHLETICS");
    }
  });

  it("lists merge spans explicitly so the model can audit the repetition", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const text = renderSheetForModel(grid.sheets[0]);
    expect(text).toContain("MERGED CELLS");
    expect(text).toContain('B5 spans 3 row(s) x 1 col(s): "CORPS ATHLETICS"');
  });

  it("keeps the day columns aligned under their headers", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const lines = renderSheetForModel(grid.sheets[0]).split("\n");
    const header = lines.find((l) => l.startsWith("2\t"))!.split("\t");
    const row3 = lines.find((l) => l.startsWith("3\t"))!.split("\t");
    expect(header[2]).toBe("MON");
    expect(row3[2]).toBe("BRC"); // BRC sits under MON, same column index
  });

  it("omits rows that are entirely empty", async () => {
    const grid = await readWorkbook(await buildMatrixWorkbook());
    const lines = renderSheetForModel(grid.sheets[0]).split("\n");
    expect(lines.some((l) => /^\d+\t(\t)*$/.test(l))).toBe(false);
  });
});
