/**
 * Carrying the Gemini key with the vault.
 *
 * Two rules pull against each other and both matter: an export is a file people
 * email themselves, so a key must never be in it by accident; and a key that
 * cannot travel means re-pasting it every time the deployment URL changes. The
 * resolution is an explicit tick, and these tests hold both ends of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carriedKey, emptyVault, vaultExportPayload } from "@/lib/store";
import { VaultSchema } from "@/lib/schemas";

describe("what an export contains", () => {
  it("has no key unless one was asked for", () => {
    const payload = vaultExportPayload(emptyVault(), "");
    expect(payload).not.toHaveProperty("geminiKey");
    expect(JSON.stringify(payload)).not.toMatch(/AIza/);
  });

  it("carries the key when it was", () => {
    const payload = vaultExportPayload(emptyVault(), "AIzaSECRET");
    expect(payload.geminiKey).toBe("AIzaSECRET");
  });

  it("treats a whitespace-only key as no key", () => {
    expect(vaultExportPayload(emptyVault(), "   ")).not.toHaveProperty("geminiKey");
  });

  it("does not mutate the vault it was handed", () => {
    const v = emptyVault();
    vaultExportPayload(v, "AIzaSECRET");
    expect(v).not.toHaveProperty("geminiKey");
  });

  it("still exports every field of the vault itself", () => {
    const v = emptyVault();
    const payload = vaultExportPayload(v, "AIzaSECRET");
    for (const k of Object.keys(v)) expect(payload).toHaveProperty(k);
  });
});

describe("what an import reads back", () => {
  it("finds a carried key", () => {
    expect(carriedKey({ geminiKey: "AIzaSECRET" })).toBe("AIzaSECRET");
    expect(carriedKey({ geminiKey: "  AIzaSECRET  " })).toBe("AIzaSECRET");
  });

  it("finds nothing in an ordinary export", () => {
    expect(carriedKey(emptyVault())).toBeNull();
    expect(carriedKey({ geminiKey: "" })).toBeNull();
    expect(carriedKey({ geminiKey: "   " })).toBeNull();
  });

  it("is not fooled by a non-string", () => {
    expect(carriedKey({ geminiKey: 42 })).toBeNull();
    expect(carriedKey({ geminiKey: { key: "AIza" } })).toBeNull();
    expect(carriedKey(null)).toBeNull();
    expect(carriedKey("AIzaSECRET")).toBeNull();
  });

  it("round-trips: exported with the key, read straight back", () => {
    const payload = vaultExportPayload(emptyVault(), "AIzaSECRET");
    const overTheWire = JSON.parse(JSON.stringify(payload));
    expect(carriedKey(overTheWire)).toBe("AIzaSECRET");
  });
});

describe("a carried key never becomes vault state", () => {
  it("is stripped by the schema, so it cannot reach storage or the UI", () => {
    const payload = vaultExportPayload(emptyVault(), "AIzaSECRET");
    const parsed = VaultSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty("geminiKey");
    expect(JSON.stringify(parsed.success && parsed.data)).not.toContain("AIzaSECRET");
  });
});

/* ------------------------------------------------------------ key storage */

function fakeStorage(blocked = false): Storage {
  const map = new Map<string, string>();
  const guard = () => { if (blocked) throw new DOMException("blocked", "SecurityError"); };
  return {
    getItem: (k: string) => { guard(); return map.get(k) ?? null; },
    setItem: (k: string, v: string) => { guard(); map.set(k, v); },
    removeItem: (k: string) => { guard(); map.delete(k); },
    clear: () => { guard(); map.clear(); },
    key: () => null,
    get length() { return map.size; },
  } as unknown as Storage;
}

function withWindow(local: Storage, session: Storage, host = "order.example") {
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session, location: { host } });
}

describe("the key survives what it can, and says when it cannot", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("stores durably in an ordinary browser", async () => {
    withWindow(fakeStorage(), fakeStorage());
    const { readKey, writeKey, keyOrigin } = await import("@/lib/apikey");
    expect(writeKey("AIzaSECRET")).toBe(true);
    expect(readKey()).toBe("AIzaSECRET");
    expect(keyOrigin()).toBe("order.example");
  });

  it("trims what it is given", async () => {
    withWindow(fakeStorage(), fakeStorage());
    const { readKey, writeKey } = await import("@/lib/apikey");
    writeKey("  AIzaSECRET  ");
    expect(readKey()).toBe("AIzaSECRET");
  });

  it("falls back to the session when the browser blocks long-term storage", async () => {
    const session = fakeStorage();
    withWindow(fakeStorage(true), session);
    const { readKey, writeKey } = await import("@/lib/apikey");
    // false is the signal the UI uses to warn that the key dies with the tab.
    expect(writeKey("AIzaSECRET")).toBe(false);
    expect(readKey()).toBe("AIzaSECRET");
  });

  it("reports no key rather than throwing when everything is blocked", async () => {
    withWindow(fakeStorage(true), fakeStorage(true));
    const { readKey, writeKey } = await import("@/lib/apikey");
    expect(() => writeKey("AIzaSECRET")).not.toThrow();
    expect(readKey()).toBe("");
  });

  it("clears from both stores", async () => {
    const local = fakeStorage();
    const session = fakeStorage();
    withWindow(local, session);
    const { readKey, writeKey } = await import("@/lib/apikey");
    writeKey("AIzaSECRET");
    writeKey("");
    expect(readKey()).toBe("");
  });

  it("is silent on the server, where there is no browser to store in", async () => {
    const { readKey, writeKey, keyOrigin } = await import("@/lib/apikey");
    expect(readKey()).toBe("");
    expect(writeKey("AIzaSECRET")).toBe(false);
    expect(keyOrigin()).toBe("");
  });
});
