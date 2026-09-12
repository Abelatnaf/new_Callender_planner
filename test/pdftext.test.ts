/**
 * Reading a PDF's text layer, and knowing when there isn't one.
 *
 * The semester schedule arrives as a PDF and there are two unrelated kinds. A
 * registrar's print view carries the meeting times, rooms and instructors as
 * real characters. A screenshot saved as a PDF carries one JPEG and nothing
 * else. Sending the first to vision makes the model infer "0800-0915" from
 * where a box sits on a grid, when the document said so in words.
 *
 * The dangerous middle case is a PDF whose text is stored in a subset font's
 * private encoding: extracting it yields confident-looking mojibake, which is
 * worse than extracting nothing, because the caller would then skip vision and
 * hand the model nonsense.
 */
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { extractPdfText, looksLikeRealText } from "@/lib/pdftext";

/** A minimal PDF carrying one content stream. */
function pdfWithText(lines: string[], compress = true): Buffer {
  const body =
    "BT /F1 12 Tf 72 720 Td\n" +
    lines.map((l) => `(${l.replace(/([()\\])/g, "\\$1")}) Tj T*`).join("\n") +
    "\nET\n";
  const data = compress ? deflateSync(Buffer.from(body, "latin1")) : Buffer.from(body, "latin1");
  const head = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< ${compress ? "/Filter /FlateDecode " : ""}/Length ${data.length} >>\nstream\n`,
    "latin1",
  );
  return Buffer.concat([head, data, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
}

/** A PDF whose only stream is a JPEG - a screenshot, in other words. */
function pdfWithOnlyAnImage(): Buffer {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37) % 256)),
    Buffer.from([0xff, 0xd9]),
  ]);
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"),
    jpeg,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

/** What a subset font's private encoding looks like once inflated. */
function mojibake(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    // High bytes and control codes, which is precisely what makes it unreadable.
    out += String.fromCharCode(i % 7 === 0 ? (i % 26) + 1 : 160 + ((i * 13) % 95));
  }
  return out;
}

const SCHEDULE = [
  "Fall 2026 Schedule",
  "CIS-101-01  Intro to Computer Science  TU TH 0800-0915  Mallory Hall 314",
  "CIS-111-02  Programming I  MO WE FR 1000-1050  Mallory Hall 314",
  "ERH-101-22  Writing and Rhetoric I  TU TH 1050-1205  Scott Shipp Hall 401",
  "HI-103-22   World History I  TU TH 0925-1040  Scott Shipp Hall 368",
  "MA-106-02   Probability and Statistics  TU TH 1335-1450  Mallory Hall 212",
];

describe("a PDF with a real text layer", () => {
  it("reads the lines back", () => {
    const text = extractPdfText(pdfWithText(SCHEDULE));
    expect(text).toContain("Fall 2026 Schedule");
    expect(text).toContain("CIS-101-01");
    expect(text).toContain("Mallory Hall 314");
  });

  it("keeps the exact meeting times, which is the whole point", () => {
    const text = extractPdfText(pdfWithText(SCHEDULE));
    expect(text).toContain("0800-0915");
    expect(text).toContain("1335-1450");
  });

  it("keeps one course per line rather than running them together", () => {
    const lines = extractPdfText(pdfWithText(SCHEDULE)).split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(SCHEDULE.length);
  });

  it("reads an uncompressed stream too", () => {
    expect(extractPdfText(pdfWithText(SCHEDULE, false))).toContain("CIS-111-02");
  });

  it("unescapes parentheses in a course title", () => {
    const text = extractPdfText(pdfWithText([
      "Lab for Programming I (CIS-111L-04) meets WE 1430-1620 in Mallory Hall",
      "Second line so the sample is long enough to judge",
      "Third line with several ordinary words in it",
    ]));
    expect(text).toContain("(CIS-111L-04)");
  });
});

describe("a PDF with no text at all", () => {
  it("returns nothing, so the caller falls back to vision", () => {
    expect(extractPdfText(pdfWithOnlyAnImage())).toBe("");
  });

  it("does not throw on a file that is not a PDF", () => {
    expect(extractPdfText(Buffer.from("this is not a pdf at all"))).toBe("");
  });

  it("does not throw on an empty buffer", () => {
    expect(extractPdfText(Buffer.alloc(0))).toBe("");
  });

  it("does not throw on a truncated stream", () => {
    const cut = pdfWithText(SCHEDULE).subarray(0, 90);
    expect(() => extractPdfText(cut)).not.toThrow();
  });
});

describe("looksLikeRealText", () => {
  it("accepts a page of a schedule", () => {
    expect(looksLikeRealText(SCHEDULE.join("\n"))).toBe(true);
  });

  it("rejects a subset font's private encoding", () => {
    // The failure this guards: thousands of characters that pass a naive
    // length check and are not language.
    expect(looksLikeRealText(mojibake(600))).toBe(false);
  });

  it("rejects something too short to judge", () => {
    expect(looksLikeRealText("CIS 101")).toBe(false);
  });

  it("rejects a wall of digits with no words in it", () => {
    expect(looksLikeRealText("0800 1000 1050 ".repeat(20))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(looksLikeRealText("")).toBe(false);
  });
});
