/**
 * Gemini access. Server-side only - the API key must never reach the browser.
 *
 * Model ids are read from the environment with floating-alias defaults, so a
 * model retirement cannot silently break the app for someone who is not
 * maintaining it. Override GEMINI_MODEL_PARSE / GEMINI_MODEL_PLAN to pin.
 */
import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";
import { z } from "zod";

export const MODELS = {
  /** Grid and document extraction: cheap, fast, high volume. */
  parse: process.env.GEMINI_MODEL_PARSE || "gemini-flash-latest",
  /** Planning and briefing: the reasoning actually matters here. */
  plan: process.env.GEMINI_MODEL_PLAN || "gemini-pro-latest",
} as const;

export class MissingKeyError extends Error {
  constructor() {
    super(
      "No Gemini API key is available. Either set GEMINI_API_KEY on the server, " +
        "or paste your own key on the Semester page - it stays in your browser.",
    );
    this.name = "MissingKeyError";
  }
}

export class ModelError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ModelError";
  }
}

let serverClient: GoogleGenAI | null = null;

/**
 * Resolve a client.
 *
 * The server key is preferred. A caller-supplied key is the fallback for a
 * deployment whose owner cannot set environment variables - it is used for that
 * one request and never cached, stored or logged.
 */
export function getClient(callerKey?: string): GoogleGenAI {
  const serverKey = process.env.GEMINI_API_KEY;
  if (serverKey) {
    serverClient ??= new GoogleGenAI({ apiKey: serverKey });
    return serverClient;
  }
  const trimmed = callerKey?.trim();
  if (trimmed) return new GoogleGenAI({ apiKey: trimmed });
  throw new MissingKeyError();
}

export function hasKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/* --------------------------------------------------------------- schemas */

type JsonSchema = Record<string, unknown>;

/**
 * zod emits draft-2020-12 with $defs and $ref for anything reused. Gemini wants
 * a self-contained schema, so references are inlined and the meta keys dropped.
 */
function inlineRefs(node: unknown, defs: Record<string, JsonSchema>, seen = 0): unknown {
  if (seen > 40) return { type: "object" }; // cycle guard; our schemas are acyclic
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, seen + 1));
  if (!node || typeof node !== "object") return node;

  const obj = node as JsonSchema;

  if (typeof obj.$ref === "string") {
    const key = obj.$ref.replace(/^#\/\$defs\//, "");
    const target = defs[key];
    if (target) {
      const { $ref: _drop, ...rest } = obj;
      return inlineRefs({ ...target, ...rest }, defs, seen + 1);
    }
  }

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(obj)) {
    // Keys Gemini rejects or ignores.
    if (k === "$schema" || k === "$defs" || k === "additionalProperties" || k === "$id") continue;
    out[k] = inlineRefs(v, defs, seen + 1);
  }
  return out;
}

/** Derive a Gemini-compatible JSON Schema from the zod schema we validate with. */
export function toGeminiSchema(schema: ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
  const defs = (raw.$defs ?? {}) as Record<string, JsonSchema>;
  return inlineRefs(raw, defs) as JsonSchema;
}

/* ------------------------------------------------------------- generation */

export type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export type StructuredRequest<T> = {
  model?: string;
  system: string;
  parts: Part[];
  schema: ZodType<T>;
  /** Lower for extraction, higher for the briefing's prose. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Used only when the server has no key of its own. Never persisted. */
  apiKey?: string;
};

const TRANSIENT = /\b(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|overloaded)\b/i;

/**
 * One structured call, validated against the zod schema before it is returned.
 *
 * Retries only transient failures. A schema violation is not retried blindly -
 * it is surfaced, because silently re-rolling a malformed plan hides the fact
 * that the model is not doing what was asked.
 */
export async function generateStructured<T>(req: StructuredRequest<T>): Promise<T> {
  const ai = getClient(req.apiKey);
  const model = req.model ?? MODELS.parse;
  const responseJsonSchema = toGeminiSchema(req.schema);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 750));
    }
    try {
      const result = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: req.parts }],
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema,
          temperature: req.temperature ?? 0.1,
          maxOutputTokens: req.maxOutputTokens ?? 32_768,
        },
      });

      const text = result.text;
      if (!text) throw new ModelError("the model returned an empty response");

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Structured output should make this impossible, but a truncated
        // response is worth a clear message rather than a JSON stack trace.
        throw new ModelError(
          "the model's response was not valid JSON - it may have been cut off by the token limit",
        );
      }

      const parsed = req.schema.safeParse(json);
      if (!parsed.success) {
        throw new ModelError(
          `the model's response did not match the expected shape: ${parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return parsed.data;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT.test(message)) break;
    }
  }

  if (lastError instanceof ModelError || lastError instanceof MissingKeyError) throw lastError;
  throw new ModelError(
    lastError instanceof Error ? lastError.message : "the model call failed",
    lastError,
  );
}

/** Free-form streaming, for the ask panel. */
export async function streamText(opts: {
  model?: string;
  system: string;
  history: Array<{ role: "user" | "model"; text: string }>;
  temperature?: number;
  apiKey?: string;
}): Promise<AsyncGenerator<string>> {
  const ai = getClient(opts.apiKey);
  const stream = await ai.models.generateContentStream({
    model: opts.model ?? MODELS.plan,
    contents: opts.history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    config: {
      systemInstruction: opts.system,
      temperature: opts.temperature ?? 0.4,
      maxOutputTokens: 4096,
    },
  });

  async function* iterate() {
    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) yield t;
    }
  }
  return iterate();
}
