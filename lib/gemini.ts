/**
 * Gemini access. Server-side only - the API key must never reach the browser.
 *
 * Every call walks a *chain* of models rather than asking for one. The reason
 * is quota, not redundancy: a free AI Studio key has no allowance at all on
 * some models, and the floating `-latest` aliases track whichever preview is
 * newest, which is exactly the kind of model a free key is most often locked
 * out of. Being told "RESOURCE_EXHAUSTED" on the very first request of the day
 * is not a rate limit - it is the wrong model for that key. So the chain ends
 * on models with a long-standing, generous free tier, and a quota refusal
 * moves to the next one immediately.
 *
 * Override GEMINI_MODEL_PARSE / GEMINI_MODEL_PLAN to change the first choice,
 * or GEMINI_MODELS_PARSE / GEMINI_MODELS_PLAN (comma-separated) to replace a
 * whole chain.
 */
import { GoogleGenAI } from "@google/genai";
import type { ZodType } from "zod";
import { z } from "zod";

/**
 * Fallbacks, in order of preference after the first choice.
 *
 * `gemini-2.5-flash` and `gemini-2.0-flash` are here because they are stable
 * ids with a free tier that has outlived several model generations. They are
 * the floor the app lands on when everything newer is refused.
 */
const PARSE_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
const PLAN_FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash"];

function chain(single: string | undefined, list: string | undefined, first: string, rest: string[]): string[] {
  if (list?.trim()) {
    const explicit = list.split(",").map((s) => s.trim()).filter(Boolean);
    if (explicit.length) return explicit;
  }
  const head = single?.trim() || first;
  return [head, ...rest.filter((m) => m !== head)];
}

export const MODEL_CHAINS = {
  /** Grid and document extraction: cheap, fast, high volume. */
  parse: chain(
    process.env.GEMINI_MODEL_PARSE,
    process.env.GEMINI_MODELS_PARSE,
    "gemini-flash-latest",
    PARSE_FALLBACKS,
  ),
  /** Planning and briefing: the reasoning actually matters here. */
  plan: chain(
    process.env.GEMINI_MODEL_PLAN,
    process.env.GEMINI_MODELS_PLAN,
    "gemini-pro-latest",
    PLAN_FALLBACKS,
  ),
} as const;

/** The first choice in each chain, for display. */
export const MODELS = {
  parse: MODEL_CHAINS.parse[0],
  plan: MODEL_CHAINS.plan[0],
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

/**
 * Every model in the chain refused on quota.
 *
 * Carries what was tried and how long Google asked us to wait, so the person
 * reading the message learns something they can act on rather than "try again".
 */
export class QuotaError extends Error {
  constructor(
    readonly tried: string[],
    readonly retryAfterSec: number | null,
    readonly detail?: string,
  ) {
    super("every available Gemini model refused this request on quota");
    this.name = "QuotaError";
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

/* ------------------------------------------------------- failure taxonomy */

export type Failure = "quota" | "missing_model" | "transient" | "bad_key" | "fatal";

/**
 * What kind of failure this is, and therefore what to do about it.
 *
 * The distinction that matters is quota versus transient. A 503 means the
 * model is busy and waiting helps. A 429 means this key's allowance for *this
 * model* is spent, and waiting two seconds cannot help - only a different
 * model, or a much longer wait, can. Treating them the same is what turns one
 * failed upload into three wasted requests against an already-empty quota.
 */
export function classify(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err);
  if (/API[_ ]KEY[_ ]INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
    return "bad_key";
  }
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate limit/i.test(message)) return "quota";
  if (/NOT_FOUND|\b404\b|is not found for API version|not supported for generateContent/i.test(message)) {
    return "missing_model";
  }
  if (/\b(500|502|503|504)\b|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded|INTERNAL|ECONNRESET|fetch failed/i.test(message)) {
    return "transient";
  }
  return "fatal";
}

/**
 * Google's RetryInfo, in seconds, when it says how long to wait.
 *
 * It arrives inside the error message as JSON (`"retryDelay": "27s"`), so it is
 * read out of the text rather than a typed field - the SDK does not surface it.
 */
export function retryAfterSeconds(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = /"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i.exec(message);
  if (m) return Math.ceil(Number(m[1]));
  return null;
}

/**
 * Longest we will sit on a request waiting for a per-minute quota to roll over.
 *
 * Kept well under the routes' 60s maxDuration: a Matrix parse can itself take
 * twenty seconds, and a wait that pushes the request into a platform timeout
 * costs the cadet the upload it was trying to save.
 */
const MAX_QUOTA_WAIT_SEC = 15;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /** The chain to walk. Defaults to the parse chain. */
  models?: readonly string[];
  system: string;
  parts: Part[];
  schema: ZodType<T>;
  /** Lower for extraction, higher for the briefing's prose. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Tokens the model may spend thinking before it answers.
   *
   * 0 turns it off. Gemini 2.5-era models think by default, which is right for
   * planning a week and wrong for copying a spreadsheet cell into a field:
   * extraction gains nothing from deliberation and pays for all of it in
   * latency. A 9KB grid was timing out past 55 seconds with it left on.
   *
   * Undefined leaves the model's own default alone.
   */
  thinkingBudget?: number;
  /** Used only when the server has no key of its own. Never persisted. */
  apiKey?: string;
};

/** What came back, and which model actually produced it. */
export type Structured<T> = { value: T; model: string; fellBack: boolean };

/**
 * One structured call, validated against the zod schema before it is returned.
 *
 * Walks the chain. A quota refusal or an unknown model moves on at once; a
 * transient failure is retried on the same model, since waiting is exactly what
 * helps there. A schema violation is surfaced rather than re-rolled - silently
 * retrying a malformed plan hides the fact that the model is not doing what was
 * asked.
 *
 * If the whole chain is quota-blocked and Google told us how long to wait, we
 * wait once - but only if the wait is short enough to fit inside the request.
 */
export async function generateStructured<T>(req: StructuredRequest<T>): Promise<Structured<T>> {
  const ai = getClient(req.apiKey);
  const models = req.models?.length ? [...req.models] : [...MODEL_CHAINS.parse];
  const responseJsonSchema = toGeminiSchema(req.schema);

  const call = async (model: string): Promise<T> => {
    const result = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: req.parts }],
      config: {
        systemInstruction: req.system,
        responseMimeType: "application/json",
        responseJsonSchema,
        temperature: req.temperature ?? 0.1,
        maxOutputTokens: req.maxOutputTokens ?? 32_768,
        ...(req.thinkingBudget === undefined
          ? {}
          : { thinkingConfig: { thinkingBudget: req.thinkingBudget } }),
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
  };

  const quotaBlocked: string[] = [];
  let suggestedWait: number | null = null;
  let lastError: unknown;

  const walk = async (): Promise<Structured<T> | null> => {
    for (const [index, model] of models.entries()) {
      for (let attempt = 0; ; attempt++) {
        try {
          return { value: await call(model), model, fellBack: index > 0 };
        } catch (err) {
          lastError = err;
          const kind = classify(err);

          if (kind === "quota") {
            if (!quotaBlocked.includes(model)) quotaBlocked.push(model);
            const wait = retryAfterSeconds(err);
            if (wait !== null && (suggestedWait === null || wait < suggestedWait)) suggestedWait = wait;
            break; // this model's allowance is spent; another second will not restore it
          }
          if (kind === "missing_model") break; // the id is wrong or retired; try the next
          if (kind === "bad_key" || kind === "fatal") return null; // no model will fix either
          if (attempt >= 1) break; // transient, twice - give the next model a turn
          await sleep(700 * 2 ** attempt);
        }
      }
    }
    return null;
  };

  const first = await walk();
  if (first) return first;

  // Everything refused. If the only reason was quota and the wait is short
  // enough to sit inside this request, take it once - a per-minute limit that
  // rolls over in fifteen seconds should not cost the cadet the upload.
  const everyFailureWasQuota = quotaBlocked.length === models.length;
  if (everyFailureWasQuota && suggestedWait !== null && suggestedWait <= MAX_QUOTA_WAIT_SEC) {
    await sleep((suggestedWait + 1) * 1000);
    const second = await walk();
    if (second) return second;
  }

  if (quotaBlocked.length > 0 && classify(lastError) === "quota") {
    throw new QuotaError(
      quotaBlocked,
      suggestedWait,
      lastError instanceof Error ? lastError.message : undefined,
    );
  }
  if (lastError instanceof ModelError || lastError instanceof MissingKeyError) throw lastError;
  throw new ModelError(
    lastError instanceof Error ? lastError.message : "the model call failed",
    lastError,
  );
}

/** Free-form streaming, for the ask panel. Walks the plan chain the same way. */
export async function streamText(opts: {
  models?: readonly string[];
  system: string;
  history: Array<{ role: "user" | "model"; text: string }>;
  temperature?: number;
  apiKey?: string;
}): Promise<AsyncGenerator<string>> {
  const ai = getClient(opts.apiKey);
  const models = opts.models?.length ? [...opts.models] : [...MODEL_CHAINS.plan];

  const quotaBlocked: string[] = [];
  let suggestedWait: number | null = null;
  let lastError: unknown;

  for (const model of models) {
    try {
      const stream = await ai.models.generateContentStream({
        model,
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
    } catch (err) {
      lastError = err;
      const kind = classify(err);
      if (kind === "bad_key" || kind === "fatal") break;
      if (kind === "quota") {
        quotaBlocked.push(model);
        const wait = retryAfterSeconds(err);
        if (wait !== null && (suggestedWait === null || wait < suggestedWait)) suggestedWait = wait;
      }
    }
  }

  if (quotaBlocked.length > 0 && classify(lastError) === "quota") {
    throw new QuotaError(quotaBlocked, suggestedWait, lastError instanceof Error ? lastError.message : undefined);
  }
  throw lastError instanceof Error ? lastError : new ModelError("the model call failed");
}
