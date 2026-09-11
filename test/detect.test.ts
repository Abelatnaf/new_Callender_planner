/**
 * Routing a dropped file by what it is, not which box it landed in.
 *
 * The failure this prevents is mundane and total: a cadet with three files and
 * one visible drop zone uses the drop zone, and an `accept` string they cannot
 * see refuses two of the three with no way to find out why.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyContent, looksLikeCalendar, looksLikeMatrix, routeTo, SNIFF_BYTES } from "@/lib/detect";

const head = (p: string) => readFileSync(p, "utf8").slice(0, SNIFF_BYTES);
const REAL_ICS = head("test/fixtures/canvas-real.ics");
const REAL_MATRIX = head("test/fixtures/matrix-real.csv");

const classify = (name: string, type: string, text: string) =>
  classifyContent({ name, type, head: text });

describe("the real files are recognised from their own contents", () => {
  it("knows the cadet's Canvas export", () => {
    expect(looksLikeCalendar(REAL_ICS)).toBe(true);
    expect(classify("canvas.ics", "text/calendar", REAL_ICS).destination).toBe("canvas");
  });

  it("knows the cadet's Matrix by its Time/PAX/Event columns", () => {
    expect(looksLikeMatrix(REAL_MATRIX)).toBe(true);
    const d = classify("Week03.csv", "text/csv", REAL_MATRIX);
    expect(d.kind).toBe("matrix");
    expect(d.destination).toBe("matrix");
  });

  it("does not mistake the Canvas feed for the Matrix, or the reverse", () => {
    expect(looksLikeMatrix(REAL_ICS)).toBe(false);
    expect(looksLikeCalendar(REAL_MATRIX)).toBe(false);
  });
});

describe("content beats the file name", () => {
  it("recognises a Canvas feed saved as .txt", () => {
    const d = classify("calendar.txt", "text/plain", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    expect(d.destination).toBe("canvas");
  });

  it("recognises a Canvas feed served as application/octet-stream", () => {
    const d = classify("download", "application/octet-stream", "BEGIN:VCALENDAR\nPRODID:-//Instructure//");
    expect(d.destination).toBe("canvas");
  });

  it("still trusts a .ics extension when the head is unreadable", () => {
    expect(classify("feed.ics", "", "").destination).toBe("canvas");
  });
});

describe("what the file cannot settle, the box settles", () => {
  const cases: Array<[string, string, string]> = [
    ["schedule.png", "image/png", "\x89PNG\r\n"],
    ["schedule.pdf", "application/pdf", "%PDF-1.7"],
    ["courses.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK\x03\x04"],
    ["courses.csv", "text/csv", "CHEM 141,General Chemistry,MWF 0800-0850"],
  ];

  it.each(cases)("leaves %s to the drop zone", (name, type, text) => {
    expect(classify(name, type, text).destination).toBeNull();
  });

  it("sends an ambiguous file to whichever box it was dropped on", () => {
    const d = classify("schedule.png", "image/png", "\x89PNG");
    expect(routeTo(d, "term")).toMatchObject({ destination: "term", moved: false });
    expect(routeTo(d, "matrix")).toMatchObject({ destination: "matrix", moved: false });
  });

  it("names the kind so a wrong guess is legible", () => {
    expect(classify("x.png", "image/png", "\x89PNG").kind).toBe("image");
    expect(classify("x.pdf", "application/pdf", "%PDF-").kind).toBe("pdf");
    expect(classify("x.xlsx", "", "PK\x03\x04").kind).toBe("sheet");
    expect(classify("x.txt", "text/plain", "hello").kind).toBe("text");
    expect(classify("x.txt", "text/plain", "   ").kind).toBe("empty");
  });
});

describe("rerouting is flagged, never silent", () => {
  it("reports the move when a Canvas feed lands on the Matrix box", () => {
    const r = routeTo(classify("canvas.ics", "text/calendar", REAL_ICS), "matrix");
    expect(r).toMatchObject({ destination: "canvas", moved: true });
    expect(r.because).toMatch(/calendar|iCalendar/i);
  });

  it("reports the move when the Matrix lands on the Semester box", () => {
    const r = routeTo(classify("Week03.csv", "text/csv", REAL_MATRIX), "term");
    expect(r).toMatchObject({ destination: "matrix", moved: true });
    expect(r.because).toMatch(/PAX/);
  });

  it("does not flag a move when the file was already in the right box", () => {
    expect(routeTo(classify("canvas.ics", "text/calendar", REAL_ICS), "canvas").moved).toBe(false);
  });
});

describe("the Matrix signature does not fire on ordinary schedules", () => {
  it("ignores a term schedule that merely mentions time and location", () => {
    expect(looksLikeMatrix("Course,Title,Time,Location,Instructor\nCHEM 141,Gen Chem,0800,MI 302,Smith")).toBe(false);
  });
  it("ignores the word pax inside a longer word", () => {
    expect(looksLikeMatrix("Time,Event,Location,paxton,Uniform")).toBe(false);
  });
  it("needs companions, not PAX alone", () => {
    expect(looksLikeMatrix("PAX,Notes")).toBe(false);
  });
  it("accepts the header however it is quoted or spaced", () => {
    expect(looksLikeMatrix('"Time","PAX","Event","Location"')).toBe(true);
    expect(looksLikeMatrix("Time\tPAX\tEvent\tLocation")).toBe(true);
  });
});
