/** Shared response helpers so every route fails the same, legible way. */
import { MissingKeyError, ModelError } from "./gemini";

export type ApiError = { error: string; kind: string; detail?: string };

export function fail(message: string, status: number, kind = "error", detail?: string) {
  return Response.json({ error: message, kind, detail } satisfies ApiError, { status });
}

export function handleError(err: unknown): Response {
  if (err instanceof MissingKeyError) {
    return fail(err.message, 503, "missing_key");
  }
  if (err instanceof ModelError) {
    return fail(`Gemini could not complete this: ${err.message}`, 502, "model_error");
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/PERMISSION_DENIED|API key not valid|API_KEY_INVALID/i.test(message)) {
    return fail("The Gemini API key was rejected. Check GEMINI_API_KEY.", 401, "bad_key");
  }
  if (/RESOURCE_EXHAUSTED|429/.test(message)) {
    return fail("Gemini is rate limiting this key. Wait a moment and try again.", 429, "rate_limit");
  }
  return fail(message || "Something went wrong.", 500, "unknown");
}

/** Files larger than this are a mistake, not a Matrix. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export async function readUpload(
  form: FormData,
  field = "file",
): Promise<{ name: string; type: string; bytes: Buffer } | null> {
  const file = form.get(field);
  if (!file || typeof file === "string") return null;
  const blob = file as File;
  if (blob.size === 0) return null;
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is ${(blob.size / 1e6).toFixed(1)}MB - the limit is 12MB.`);
  }
  return {
    name: blob.name || "upload",
    type: blob.type || "application/octet-stream",
    bytes: Buffer.from(await blob.arrayBuffer()),
  };
}

export function isSpreadsheet(name: string, type: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(name) || /spreadsheet|excel/i.test(type);
}

export function isPdf(name: string, type: string): boolean {
  return /\.pdf$/i.test(name) || type === "application/pdf";
}
