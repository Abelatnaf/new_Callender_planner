/**
 * The model cascade.
 *
 * The failure this exists to prevent: a free AI Studio key has no allowance on
 * the newest models, so the very first upload of the day comes back
 * RESOURCE_EXHAUSTED and the cadet is told their quota is spent when it is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** One scripted outcome per (model, attempt) pair. */
type Script = Record<string, Array<"ok" | Error>>;

const calls: string[] = [];
let script: Script = {};

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async ({ model }: { model: string }) => {
        calls.push(model);
        const queue = script[model] ?? [];
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error("no script for " + model);
        return { text: JSON.stringify({ ok: true }) };
      },
      generateContentStream: async ({ model }: { model: string }) => {
        calls.push(model);
        const queue = script[model] ?? [];
        const next = queue.length > 1 ? queue.shift()! : queue[0];
        if (next instanceof Error) throw next;
        async function* g() { yield { text: "hi" }; }
        return g();
      },
    };
  },
}));

const Schema = z.object({ ok: z.boolean() });

/** Errors shaped the way the Gemini SDK actually surfaces them. */
const quota = (retryDelay?: string) =>
  new Error(
    `got status: 429 Too Many Requests. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED",` +
      `"message":"You exceeded your current quota"${retryDelay ? `,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"${retryDelay}"}]` : ""}}}`,
  );
const notFound = (m: string) =>
  new Error(`got status: 404 Not Found. {"error":{"code":404,"status":"NOT_FOUND","message":"models/${m} is not found for API version v1beta"}}`);
const overloaded = () =>
  new Error(`got status: 503 Service Unavailable. {"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded"}}`);
const badKey = () =>
  new Error(`got status: 400 Bad Request. {"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}`);

async function load() {
  return await import("@/lib/gemini");
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  script = {};
  process.env.GEMINI_API_KEY = "AIzaTEST";
  delete process.env.GEMINI_MODEL_PARSE;
  delete process.env.GEMINI_MODELS_PARSE;
  delete process.env.GEMINI_MODEL_PLAN;
  delete process.env.GEMINI_MODELS_PLAN;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.GEMINI_API_KEY;
});

describe("classify", () => {
  it("separates a spent quota from a busy model", async () => {
    const { classify } = await load();
    expect(classify(quota())).toBe("quota");
    expect(classify(overloaded())).toBe("transient");
  });
  it("recognises a retired or misspelled model id", async () => {
    const { classify } = await load();
    expect(classify(notFound("gemini-flash-latest"))).toBe("missing_model");
  });
  it("recognises a rejected key, which no other model can fix", async () => {
    const { classify } = await load();
    expect(classify(badKey())).toBe("bad_key");
  });
  it("does not call an ordinary bug transient", async () => {
    const { classify } = await load();
    expect(classify(new Error("undefined is not a function"))).toBe("fatal");
  });
});

describe("retryAfterSeconds", () => {
  it("reads Google's RetryInfo out of the error text", async () => {
    const { retryAfterSeconds } = await load();
    expect(retryAfterSeconds(quota("27s"))).toBe(27);
    expect(retryAfterSeconds(quota("1.5s"))).toBe(2);
  });
  it("is null when Google did not say", async () => {
    const { retryAfterSeconds } = await load();
    expect(retryAfterSeconds(quota())).toBeNull();
    expect(retryAfterSeconds(overloaded())).toBeNull();
  });
});

describe("model chains", () => {
  it("ends on stable ids with a long-standing free tier", async () => {
    const { MODEL_CHAINS } = await load();
    expect(MODEL_CHAINS.parse[0]).toBe("gemini-flash-latest");
    expect(MODEL_CHAINS.parse).toContain("gemini-2.5-flash");
    expect(MODEL_CHAINS.plan[0]).toBe("gemini-pro-latest");
    expect(MODEL_CHAINS.plan).toContain("gemini-2.0-flash");
  });

  it("lets one env var change the first choice without losing the fallbacks", async () => {
    process.env.GEMINI_MODEL_PARSE = "gemini-2.0-flash";
    const { MODEL_CHAINS } = await load();
    expect(MODEL_CHAINS.parse[0]).toBe("gemini-2.0-flash");
    // and it is not also left further down the chain
    expect(MODEL_CHAINS.parse.filter((m) => m === "gemini-2.0-flash")).toHaveLength(1);
    expect(MODEL_CHAINS.parse.length).toBeGreaterThan(1);
  });

  it("lets a comma-separated list replace the chain outright", async () => {
    process.env.GEMINI_MODELS_PARSE = "a, b ,c";
    const { MODEL_CHAINS } = await load();
    expect(MODEL_CHAINS.parse).toEqual(["a", "b", "c"]);
  });
});

describe("generateStructured walks the chain", () => {
  it("moves past a model with no quota instead of failing the upload", async () => {
    const { generateStructured, MODEL_CHAINS } = await load();
    script = {
      "gemini-flash-latest": [quota()],
      "gemini-2.5-flash": ["ok"],
    };
    const out = await generateStructured({
      models: MODEL_CHAINS.parse, system: "s", parts: [{ text: "p" }], schema: Schema,
    });
    expect(out.value).toEqual({ ok: true });
    expect(out.model).toBe("gemini-2.5-flash");
    expect(out.fellBack).toBe(true);
    expect(calls).toEqual(["gemini-flash-latest", "gemini-2.5-flash"]);
  });

  it("does not retry a quota refusal on the same model - the minute is spent", async () => {
    const { generateStructured } = await load();
    script = { a: [quota()], b: ["ok"] };
    await generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema });
    expect(calls.filter((c) => c === "a")).toHaveLength(1);
  });

  it("does retry a busy model, because waiting is what helps there", async () => {
    const { generateStructured } = await load();
    script = { a: [overloaded(), "ok"] };
    const out = await generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema });
    expect(out.model).toBe("a");
    expect(out.fellBack).toBe(false);
    expect(calls).toEqual(["a", "a"]);
  });

  it("steps over a retired model id", async () => {
    const { generateStructured } = await load();
    script = { a: [notFound("a")], b: ["ok"] };
    const out = await generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema });
    expect(out.model).toBe("b");
  });

  it("stops at once on a rejected key rather than burning the chain", async () => {
    const { generateStructured } = await load();
    script = { a: [badKey()], b: ["ok"] };
    await expect(
      generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema }),
    ).rejects.toThrow();
    expect(calls).toEqual(["a"]);
  });

  it("reports fellBack false when the first choice works", async () => {
    const { generateStructured } = await load();
    script = { a: ["ok"] };
    const out = await generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema });
    expect(out.fellBack).toBe(false);
    expect(calls).toEqual(["a"]);
  });

  it("throws a QuotaError naming every model it tried", async () => {
    const { generateStructured, QuotaError } = await load();
    script = { a: [quota()], b: [quota()] };
    const err = await generateStructured({
      models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.tried).toEqual(["a", "b"]);
  });

  it("waits out a short per-minute limit once rather than losing the upload", async () => {
    const { generateStructured } = await load();
    // Refuses on the first pass, succeeds on the second - the wait is the point.
    script = { a: [quota("1s"), "ok"] };
    const out = await generateStructured({ models: ["a"], system: "s", parts: [{ text: "p" }], schema: Schema });
    expect(out.value).toEqual({ ok: true });
    expect(calls).toEqual(["a", "a"]);
  });

  it("does not sit on a request for a wait it cannot absorb", async () => {
    const { generateStructured, QuotaError } = await load();
    script = { a: [quota("600s")] };
    const err = await generateStructured({
      models: ["a"], system: "s", parts: [{ text: "p" }], schema: Schema,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.retryAfterSec).toBe(600);
    expect(calls).toEqual(["a"]);
  });

  it("surfaces a schema violation instead of re-rolling it on another model", async () => {
    const { generateStructured, ModelError } = await load();
    const mismatched = new Error("__mismatch__");
    script = { a: [mismatched], b: ["ok"] };
    // A fatal (non-transient, non-quota) failure must not walk the chain.
    await expect(
      generateStructured({ models: ["a", "b"], system: "s", parts: [{ text: "p" }], schema: Schema }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(calls).toEqual(["a"]);
  });
});

describe("streamText walks the chain too", () => {
  it("falls past a quota-blocked model", async () => {
    const { streamText } = await load();
    script = { a: [quota()], b: ["ok"] };
    const gen = await streamText({ models: ["a", "b"], system: "s", history: [{ role: "user", text: "hi" }] });
    let out = "";
    for await (const c of gen) out += c;
    expect(out).toBe("hi");
    expect(calls).toEqual(["a", "b"]);
  });

  it("throws a QuotaError when every model refuses", async () => {
    const { streamText, QuotaError } = await load();
    script = { a: [quota()], b: [quota()] };
    await expect(
      streamText({ models: ["a", "b"], system: "s", history: [{ role: "user", text: "hi" }] }),
    ).rejects.toBeInstanceOf(QuotaError);
  });
});
