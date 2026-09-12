/**
 * Matrix upload -> classified weekly events.
 *
 * The spreadsheet is parsed deterministically first; Gemini only ever sees a
 * faithful rendering of the grid, never the raw file. It interprets meaning -
 * which cell is a formation and which is study time - and the ratchet in
 * lib/convert.ts decides how much of that interpretation to trust.
 */
import { NextRequest } from "next/server";
import { callerKey, fail, handleError, imageMime, isCsv, isImage, isPdf, isSpreadsheet, readUpload } from "@/lib/api";
import { MODEL_CHAINS, generateStructured } from "@/lib/gemini";
import { matrixSystem } from "@/lib/prompts";
import { CadetSchema, type GeminiMatrixResponse, GeminiMatrixResponseSchema } from "@/lib/schemas";
import { toMatrixWeek } from "@/lib/convert";
import { readWorkbook } from "@/lib/xlsx";
import { renderWorkbookForModel, splitByDay } from "@/lib/grid";
import { mapWithLimit } from "@/lib/limit";
import { readCsv } from "@/lib/csv";
import { type Weekday, weekStart, todayLocal, weekDates, WEEKDAY_LONG, weekdayOf } from "@/lib/time";

/** A trimmed Matrix runs to tens of KB; past this it was never trimmed. */
const MAX_GRID_CHARS = 2_000_000;

/** Monday-first, matching weekDates(). */
const WEEK_ORDER: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const upload = await readUpload(form);
    const hintedWeek = String(form.get("weekStart") ?? "") || undefined;
    const timezone = String(form.get("timezone") ?? "America/New_York");
    // Who the cadet is decides which rows are theirs at all.
    const cadet = CadetSchema.parse(
      form.get("cadet") ? JSON.parse(String(form.get("cadet"))) : {},
    );

    // The browser trims a CSV Matrix before sending it, so what arrives is the
    // grid the model reads rather than megabytes of fill-right residue. The
    // file path below still works for anything else, and for older clients.
    const preTrimmed = String(form.get("grid") ?? "");
    const filename = preTrimmed
      ? String(form.get("filename") ?? "matrix.csv")
      : upload?.name ?? "matrix";
    const trim = {
      cellsBefore: Number(form.get("cellsBefore") ?? 0) || 0,
      cellsAfter: Number(form.get("cellsAfter") ?? 0) || 0,
      model: "",
    };

    // The per-sport attendance block is the whole point for an NCAA or club
    // cadet, and pure noise for everyone else.
    const noTeam = cadet.athletics === "none";

    if (!upload && !preTrimmed) return fail("No file was uploaded.", 400, "no_file");

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    if (preTrimmed) {
      if (!preTrimmed.trim()) return fail("That file appears to be empty.", 422, "empty_file");
      // A trimmed Matrix is tens of KB. Anything past this was not trimmed, and
      // would cost the caller a minute before Gemini refused it anyway.
      if (preTrimmed.length > MAX_GRID_CHARS) {
        return fail(
          `That grid is ${(preTrimmed.length / 1e6).toFixed(1)}M characters, which is too much for one request.`,
          413,
          "too_large",
        );
      }
      parts.push({ text: preTrimmed });
    } else if (!upload) {
      return fail("No file was uploaded.", 400, "no_file");
    } else if (isCsv(upload.name, upload.type)) {
      // The real Matrix exports as CSV, 2.4MB of which ~74% is spreadsheet
      // fill-right residue. renderWorkbookForModel trims that before sending.
      const wb = readCsv(upload.bytes.toString("utf8"), upload.name);
      if (wb.sheets.length === 0) return fail("That CSV appears to be empty.", 422, "empty_file");
      parts.push({ text: renderWorkbookForModel(wb, { dropSportColumns: noTeam }) });
    } else if (isSpreadsheet(upload.name, upload.type)) {
      const wb = await readWorkbook(upload.bytes, upload.name);
      if (wb.sheets.length === 0) {
        return fail("That workbook has no readable sheets.", 422, "empty_workbook");
      }
      parts.push({ text: renderWorkbookForModel(wb, { dropSportColumns: noTeam }) });
    } else if (isPdf(upload.name, upload.type)) {
      // Gemini reads PDFs natively; hand it the file rather than OCR-ing badly.
      parts.push({
        inlineData: { mimeType: "application/pdf", data: upload.bytes.toString("base64") },
      });
    } else if (isImage(upload.name, upload.type)) {
      // A screenshot of the Matrix, which is how it reaches a phone.
      parts.push({
        inlineData: {
          mimeType: imageMime(upload.name, upload.type),
          data: upload.bytes.toString("base64"),
        },
      });
    } else {
      const text = upload.bytes.toString("utf8");
      if (!text.trim()) return fail("That file appears to be empty.", 422, "empty_file");
      parts.push({ text });
    }

    // Captured BEFORE the week-context part is appended: afterwards `parts`
    // always holds two entries and the per-day path below would be dead code.
    const gridText = parts.length === 1 && "text" in parts[0] ? parts[0].text : "";

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

    /* --------------------------------------------------------------------
     * One call per day, in parallel.
     *
     * A whole week in one request means one reply carrying a hundred-odd
     * events. Output tokens are what latency is made of, and that reply was
     * taking longer than the minute a serverless function gets. It is also
     * all-or-nothing: one malformed row loses the other six days with it.
     *
     * The document is already stacked day sections, so each call reads under
     * 2KB and returns a dozen events. A day that fails costs a day.
     * ------------------------------------------------------------------ */
    const split = gridText ? splitByDay(gridText) : { preamble: "", days: [] };

    const dates = weekDates(anchor);
    const dayCode = (weekday: string) =>
      (Object.entries(WEEKDAY_LONG) as Array<[Weekday, string]>)
        .find(([, long]) => long.toLowerCase() === weekday.toLowerCase())?.[0];

    const models = MODEL_CHAINS.parse;
    const common = {
      models,
      system: matrixSystem(cadet),
      schema: GeminiMatrixResponseSchema,
      temperature: 0,
      // Copying cells into fields; deliberation buys nothing here.
      thinkingBudget: 0,
      apiKey: callerKey(request),
    } as const;

    let events: GeminiMatrixResponse["events"] = [];
    let model = models[0];
    let fellBack = false;
    const failures: string[] = [];

    if (split.days.length >= 2) {
      const results = await mapWithLimit(split.days, 3, async (day) => {
        const code = dayCode(day.weekday);
        const date = code ? dates[WEEK_ORDER.indexOf(code)] : undefined;
        const out = await generateStructured({
          ...common,
          parts: [
            { text: split.preamble ? `${split.preamble}\n\n${day.text}` : day.text },
            {
              text: [
                "",
                `You are reading ONE day of this Matrix: ${day.heading}`,
                date ? `That day is ${date}, and weekStartDate is ${anchor}.` : "",
                "Return only the rows in this section. Do not invent rows from other days.",
              ].filter(Boolean).join("\n"),
            },
          ],
        });
        // The section says which day it is; the model does not need to be
        // trusted with something already known for certain.
        const fixed = code
          ? out.value.events.map((e) => ({ ...e, day: code }))
          : out.value.events;
        return { events: fixed, model: out.model, fellBack: out.fellBack };
      });

      for (const [i, r] of results.entries()) {
        if (r.ok) {
          events = events.concat(r.value.events);
          model = r.value.model;
          fellBack ||= r.value.fellBack;
        } else {
          failures.push(split.days[i].weekday);
        }
      }

      if (events.length === 0) throw results.find((r) => !r.ok)?.error ?? new Error("No day could be read.");
    } else {
      const out = await generateStructured({ ...common, parts });
      events = out.value.events;
      model = out.model;
      fellBack = out.fellBack;
    }

    trim.model = model;
    const conversion = toMatrixWeek({ weekStartDate: anchor, events }, filename, anchor, trim);

    return Response.json({
      week: conversion.week,
      ratchetedCount: conversion.ratchetedCount,
      notMine: conversion.week.events.filter((e) => e.appliesToMe === false).length,
      lowConfidence: conversion.lowConfidence.map((e) => e.id),
      warnings: [
        ...conversion.warnings,
        ...(failures.length
          ? [`${failures.join(" and ")} could not be read and ${failures.length === 1 ? "is" : "are"} missing from this week. Everything else came through.`]
          : []),
        ...(fellBack ? [`Read by ${model} - the preferred model was out of quota for this key.`] : []),
      ],
      model,
    });
  } catch (err) {
    return handleError(err);
  }
}
