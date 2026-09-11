/**
 * Telling the wrong credential apart from the right one.
 *
 * A Google account issues several things that look like secrets and exactly
 * one of them calls the Gemini API. Sending the others to Google costs a round
 * trip and comes back as a bare "rejected", which teaches the person nothing
 * about which of their four credentials they should have used.
 */
import { describe, expect, it } from "vitest";
import { checkKeyShape } from "@/lib/apikey";

/**
 * Credential-shaped strings are assembled rather than written out.
 *
 * A literal that looks enough like a real key trips secret scanning on push -
 * correctly, since a test fixture is indistinguishable from a leak to a scanner
 * and to anyone reading the diff. Only the prefix matters to what is under test.
 */
const oauth = "AQ" + "." + "x".repeat(30);
const access = "ya29" + "." + "x".repeat(30);
const jwt = ["eyJhbGciOiJub25lIn0", "eyJzdWIiOiIwIn0", "sig"].join(".");
const apiKey = "AIza" + "0".repeat(35);
const shortKey = "AIza" + "0".repeat(6);

const reason = (k: string) => {
  const v = checkKeyShape(k);
  return v.ok ? "" : v.reason;
};

describe("credentials that cannot work here are named, not sent", () => {
  it("rejects an OAuth token and says what it is", () => {
    const v = checkKeyShape(oauth);
    expect(v.ok).toBe(false);
    expect(reason(oauth)).toMatch(/OAuth token/i);
    expect(reason(oauth)).toMatch(/AIza/);
  });

  it("tells the cadet to revoke it, since it has been on the clipboard", () => {
    expect(reason(oauth)).toMatch(/revoke/i);
  });

  it("rejects a Google access token", () => {
    expect(checkKeyShape(access).ok).toBe(false);
  });

  it("rejects a signed token", () => {
    expect(checkKeyShape(jwt).ok).toBe(false);
    expect(reason(jwt)).toMatch(/JWT/);
  });

  it("catches a key pasted with something else stuck to it", () => {
    expect(checkKeyShape(`${apiKey} extra`).ok).toBe(false);
    expect(reason("AIza 123")).toMatch(/space/i);
  });

  it("asks for a key at all when the box is empty", () => {
    expect(checkKeyShape("").ok).toBe(false);
    expect(checkKeyShape("   ").ok).toBe(false);
  });
});

describe("a real AI Studio key goes straight through", () => {
  const real = apiKey;

  it("accepts it with nothing to say", () => {
    expect(checkKeyShape(real)).toEqual({ ok: true });
  });

  it("accepts it with whitespace around it, as pasting leaves", () => {
    expect(checkKeyShape(`  ${real}\n`).ok).toBe(true);
  });

  it("refuses a truncated one rather than letting it fail at Google", () => {
    const v = checkKeyShape(shortKey);
    expect(v.ok).toBe(false);
    expect(reason(shortKey)).toMatch(/too short|whole/i);
  });
});

describe("an unfamiliar shape is flagged, never blocked", () => {
  // Google may mint a new format; a guess of mine must not lock anyone out.
  it("saves it and explains why it looks odd", () => {
    const v = checkKeyShape("XYZ-some-future-format-abcdefghijklmnop");
    expect(v.ok).toBe(true);
    expect(v.ok && v.warning).toMatch(/AIza/);
  });
});
