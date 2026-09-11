/**
 * Matrix upload -> classified weekly events.
 *
 * The spreadsheet is parsed deterministically first; Gemini only ever sees a
 * faithful rendering of the grid, never the raw file. It interprets meaning -
 * which cell is a formation and which is study time - and the ratchet in
 * lib/convert.ts decides how much of that interpretation to trust.
 */
import { NextRequest } from "next/server";
import { fail, handleError, isPdf, isSpreadsheet, readUpload } from "@/lib/api";
import { MODELS, generateStructured } from "@/lib/gemini";
import { MATRIX_SYSTEM } from "@/lib/prompts";
import { GeminiMatrixResponseSchema } from "@/lib/schemas";
import { toMatrixWeek } from "@/lib/convert";
import { readWorkbook, renderWorkbookForModel } from "@/lib/xlsx";
import { weekStart, todayLocal, weekDates, WEEKDAY_LONG, weekdayOf } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const upload = await readUpload(form);
    const hintedWeek = String(form.get("weekStart") ?? "") || undefined;
    const timezone = String(form.get("timezone") ?? "America/New_York");

    if (!upload) return fail("No file was uploaded.", 400, "no_file");

    let gridText: string;
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    if (isSpreadsheet(upload.name, upload.type)) {
      const wb = await readWorkbook(upload.bytes, upload.name);
      if (wb.sheets.length === 0) {
        return fail("That workbook has no readable sheets.", 422, "empty_workbook");
      }
      gridText = renderWorkbookForModel(wb);
      parts.push({ text: gridText });
    } else if (isPdf(upload.name, upload.type)) {
      // Gemini reads PDFs natively; hand it the file rather than OCR-ing badly.
      parts.push({
        inlineData: { mimeType: "application/pdf", data: upload.bytes.toString("base64") },
      });
    } else {
      const text = upload.bytes.toString("utf8");
      if (!text.trim()) return fail("That file appears to be empty.", 422, "empty_file");
      parts.push({ text });
    }

    const anchor = hintedWeek ? weekStart(hintedWeek) : weekStart(todayLocal(timezone));
    parts.push({
      text: [
        "",
        "The week this Matrix most likely covers begins Monday " + anchor + ".",
        "Map each day column onto these dates:",
        ...weekDates(anchor).map((d) => `  ${WEEKDAY_LONG[weekdayOf(d)]} = ${d}`),
        "",
        "If the document itself states a different week, trust the document and",
        "report that week in weekStartDate instead.",
      ].join("\n"),
    });

    const response = await generateStructured({
      model: MODELS.parse,
      system: MATRIX_SYSTEM,
      parts,
      schema: GeminiMatrixResponseSchema,
      temperature: 0,
    });

    const conversion = toMatrixWeek(response, upload.name, anchor);

    return Response.json({
      week: conversion.week,
      ratchetedCount: conversion.ratchetedCount,
      lowConfidence: conversion.lowConfidence.map((e) => e.id),
      warnings: conversion.warnings,
      model: MODELS.parse,
    });
  } catch (err) {
    return handleError(err);
  }
}
