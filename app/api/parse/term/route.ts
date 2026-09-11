/**
 * Semester schedule upload -> a Term.
 *
 * Accepts a spreadsheet, a PDF, or pasted text, because the registrar hands
 * this out in whatever form it feels like that year. Whatever comes back is
 * fully editable on /setup - a wrong extraction should cost a cadet thirty
 * seconds of correction, not a term of bad plans.
 */
import { NextRequest } from "next/server";
import { callerKey, fail, handleError, imageMime, isCsv, isImage, isPdf, isSpreadsheet, readUpload } from "@/lib/api";
import { MODELS, generateStructured } from "@/lib/gemini";
import { TERM_SYSTEM } from "@/lib/prompts";
import { GeminiTermResponseSchema } from "@/lib/schemas";
import { toTerm } from "@/lib/convert";
import { readWorkbook, renderWorkbookForModel } from "@/lib/xlsx";
import { readCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const upload = await readUpload(form);
    const pasted = String(form.get("text") ?? "").trim();

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    let filename = "pasted text";

    if (upload) {
      filename = upload.name;
      if (isImage(upload.name, upload.type)) {
        // VMI Student Planning is a web page, so the schedule usually arrives
        // as a screenshot rather than a file.
        parts.push({
          inlineData: {
            mimeType: imageMime(upload.name, upload.type),
            data: upload.bytes.toString("base64"),
          },
        });
      } else if (isCsv(upload.name, upload.type)) {
        const wb = readCsv(upload.bytes.toString("utf8"), upload.name);
        if (wb.sheets.length === 0) return fail("That CSV appears to be empty.", 422, "empty_file");
        parts.push({ text: renderWorkbookForModel(wb) });
      } else if (isSpreadsheet(upload.name, upload.type)) {
        const wb = await readWorkbook(upload.bytes, upload.name);
        if (wb.sheets.length === 0) {
          return fail("That workbook has no readable sheets.", 422, "empty_workbook");
        }
        parts.push({ text: renderWorkbookForModel(wb) });
      } else if (isPdf(upload.name, upload.type)) {
        parts.push({
          inlineData: { mimeType: "application/pdf", data: upload.bytes.toString("base64") },
        });
      } else {
        parts.push({ text: upload.bytes.toString("utf8") });
      }
    } else if (pasted) {
      parts.push({ text: pasted });
    } else {
      return fail("Upload a file or paste your schedule text.", 400, "no_input");
    }

    const response = await generateStructured({
      model: MODELS.parse,
      system: TERM_SYSTEM,
      parts,
      schema: GeminiTermResponseSchema,
      temperature: 0,
      apiKey: callerKey(request),
    });

    const { term, warnings } = toTerm(response, filename);
    return Response.json({ term, warnings, model: MODELS.parse });
  } catch (err) {
    return handleError(err);
  }
}
