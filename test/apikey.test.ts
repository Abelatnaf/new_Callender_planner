import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_HEADER, callerKey } from "@/lib/api";

const req = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/api/plan", { method: "POST", headers });

describe("callerKey", () => {
  it("reads a key from the header", () => {
    expect(callerKey(req({ [KEY_HEADER]: "AIzaTEST" }))).toBe("AIzaTEST");
  });
  it("trims surrounding whitespace", () => {
    expect(callerKey(req({ [KEY_HEADER]: "  AIzaTEST  " }))).toBe("AIzaTEST");
  });
  it("treats an empty or whitespace header as absent", () => {
    expect(callerKey(req({ [KEY_HEADER]: "" }))).toBeUndefined();
    expect(callerKey(req({ [KEY_HEADER]: "   " }))).toBeUndefined();
  });
  it("returns undefined when the header is missing", () => {
    expect(callerKey(req())).toBeUndefined();
  });
  it("is case-insensitive, as HTTP headers are", () => {
    expect(callerKey(req({ "X-Gemini-Key": "AIzaTEST" }))).toBe("AIzaTEST");
  });
});

describe("key precedence in getClient", () => {
  const original = process.env.GEMINI_API_KEY;

  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
  });

  it("refuses when neither the server nor the caller has a key", async () => {
    const { getClient, MissingKeyError } = await import("@/lib/gemini");
    expect(() => getClient()).toThrow(MissingKeyError);
    expect(() => getClient("   ")).toThrow(MissingKeyError);
  });

  it("accepts a caller key when the server has none", async () => {
    const { getClient } = await import("@/lib/gemini");
    expect(() => getClient("AIzaCALLER")).not.toThrow();
  });

  it("reports no server key so the browser knows to supply one", async () => {
    const { hasKey } = await import("@/lib/gemini");
    expect(hasKey()).toBe(false);
    process.env.GEMINI_API_KEY = "AIzaSERVER";
    expect(hasKey()).toBe(true);
  });
});
