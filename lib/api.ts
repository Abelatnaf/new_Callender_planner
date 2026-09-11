/** Shared response helpers so every route fails the same, legible way. */
import { MissingKeyError, ModelError } from "./gemini";

export type ApiError = { error: string; kind: string; detail?: string };

/** Header carrying a caller-supplied Gemini key, for deployments with no env var. */
export const KEY_HEADER = "x-gemini-key";

/**
 * A Gemini key supplied by the browser.
 *
 * Only consulted when the server has none of its own. It is passed straight to
 * the Gemini client for that single request - never logged, never cached, never
 * written anywhere. Read from a header rather than the body so the same path
 * works for JSON routes and multipart uploads alike.
 */
export function callerKey(request: Request): string | undefined {
  const raw = request.headers.get(KEY_HEADER)?.trim();
  return raw ? raw : undefined;
}

export function fail(message: string, status: number, kind = "error", detail?: string) {
  return Response.json({ error: message, kind, detail } satisfies ApiError, { status });
}

export function handleError(err: unknown): Response {
  if (err instanceof MissingKeyError) {
    return fail(err.message, 503, "missing_key");
  }

  const message = err instanceof Error ? err.message : String(err);

  // These are matched on the message BEFORE the ModelError branch: a rejected
  // key arrives wrapped in a ModelError, and a typo is by far the likeliest
  // failure for someone pasting their own key. Showing them Google's raw JSON
  // instead of "your key was rejected" would be a poor way to find that out.
  if (/PERMISSION_DENIED|API[_ ]KEY[_ ]INVALID|API key not valid/i.test(message)) {
    return fail(
      "That Gemini API key was rejected. Check it was copied whole, and that the " +
        "Generative Language API is enabled for it.",
      401,
      "bad_key",
    );
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(message)) {
    return fail(
      "Gemini is rate limiting this key, or its quota is spent. Wait a moment and try again.",
      429,
      "rate_limit",
    );
  }

  if (err instanceof ModelError) {
    return fail(`Gemini could not complete this: ${err.message}`, 502, "model_error");
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
