import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseIcs, normalizeCourseCode, splitSummary, looksLikeCourseCode } from "@/lib/ics";

/* ===========================================================================
   Against the cadet's ACTUAL Canvas export. Every earlier test used fixtures
   I invented; these are the real thing, committed so the shape cannot drift.
   =========================================================================== */

const REAL = readFileSync("test/fixtures/canvas-real.ics", "utf8");
const TZ = "America/New_York";

describe("the real Canvas feed", () => {
  const { assignments, skipped, calendarName } = parseIcs(REAL, TZ);

  it("reads every assignment in the file", () => {
    expect(assignments).toHaveLength(78);
    expect(skipped).toBe(0);
  });

  it("finds the calendar it came from", () => {
    expect(calendarName).toContain("Canvas");
  });

  it("keeps the lab distinct from the lecture", () => {
    // CIS-111L-03 and 04 is the lab; CIS-111-01, 02, and 03 is the lecture.
    // They meet at different times, and the old regex dropped the L and merged
    // them into one course.
    const codes = new Set(assignments.map((a) => a.courseCode));
    expect(codes).toContain("CIS 111L");
    expect(codes).toContain("CIS 111");
  });

  it("does not treat a bracketed title as a course code", () => {
    // "[Core Competency Module (Class 27+3)]" is a title, not a course.
    const codes = [...new Set(assignments.map((a) => a.courseCode))];
    expect(codes.some((c) => c?.includes("Core Competency"))).toBe(false);
  });

  it("recovers the real course list and nothing else", () => {
    const codes = [...new Set(assignments.map((a) => a.courseCode).filter(Boolean))].sort();
    expect(codes).toEqual(["CIS 101", "CIS 111", "CIS 111L", "ERH 101", "HI 103", "MA 106", "MS 109"]);
  });

  it("converts UTC stamps to Virginia wall clock", () => {
    // DTSTART:20260827T145000Z is 10:50 EDT, not 14:50.
    const first = assignments.find((a) => a.uid?.includes("296518"));
    expect(first?.dueDate).toBe("2026-08-27");
    expect(first?.dueMin).toBe(10 * 60 + 50);
  });

  it("gives every assignment a usable deadline", () => {
    for (const a of assignments) {
      expect(a.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.dueMin).toBeGreaterThanOrEqual(0);
      expect(a.dueMin).toBeLessThanOrEqual(1440);
    }
  });

  it("strips the HTML Canvas puts in descriptions", () => {
    const withNotes = assignments.filter((a) => a.notes);
    expect(withNotes.length).toBeGreaterThan(0);
    for (const a of withNotes) expect(a.notes).not.toMatch(/<[a-z][^>]*>/i);
  });
});

describe("course code parsing, from the real strings", () => {
  it("keeps a trailing lab letter", () => {
    expect(normalizeCourseCode("CIS-111L-03 and 04-FL26")).toBe("CIS 111L");
    expect(normalizeCourseCode("CIS-111-01, 02, and 03 -FL26")).toBe("CIS 111");
  });
  it("handles the multi-section spellings Canvas emits", () => {
    expect(normalizeCourseCode("MS-109-01, 02, 03, 04, 05, 06, and 07-FL26")).toBe("MS 109");
    expect(normalizeCourseCode("MA-106-01, 02, and 06-FL26")).toBe("MA 106");
  });
  it("rejects a title masquerading as a code", () => {
    expect(looksLikeCourseCode("Core Competency Module (Class 27+3)")).toBe(false);
    expect(looksLikeCourseCode("CIS-111L-03 and 04-FL26")).toBe(true);
  });
  it("leaves a non-course bracket in the title", () => {
    const r = splitSummary("Do the thing [Core Competency Module (Class 27+3)]");
    expect(r.courseCode).toBeUndefined();
    expect(r.title).toContain("Core Competency");
  });
});

/* ===========================================================================
   Against the cadet's ACTUAL Matrix export.
   =========================================================================== */

import { readCsv, parseCsv } from "@/lib/csv";
import { trimSheet, renderSheetForModel } from "@/lib/xlsx";

const MATRIX = readFileSync("test/fixtures/matrix-real.csv", "utf8");

describe("the real Matrix CSV", () => {
  const wb = readCsv(MATRIX, "Week03.csv");
  const sheet = wb.sheets[0];

  it("reads as a grid at all", () => {
    expect(wb.sheets).toHaveLength(1);
    expect(sheet.cells.length).toBeGreaterThan(500);
  });

  it("throws away the spreadsheet fill-right garbage", () => {
    // One row was fill-righted across hundreds of columns. It is 17% of this
    // trimmed fixture and 74% of the full 2.4MB file.
    const trimmed = trimSheet(sheet);
    expect(trimmed.cells.length).toBeLessThan(sheet.cells.length);
    const dropped = sheet.cells.length - trimmed.cells.length;
    expect(dropped).toBeGreaterThan(100);
  });

  it("keeps the real Corps PT row and drops its drag residue", () => {
    const trimmed = trimSheet(sheet);
    const corpsPT = trimmed.cells.filter((c) => c.value === "Corps PT");
    expect(corpsPT.length).toBe(1);           // not the 25 it exported as here
    expect(corpsPT[0].col).toBeLessThan(30);  // and it is the one in the schedule
  });

  it("does not mistake the per-sport columns for residue", () => {
    // Those columns repeat "Attend"/"Excused" down many rows, which a
    // value-repetition heuristic would have eaten. They are real.
    const trimmed = trimSheet(sheet);
    expect(trimmed.cells.some((c) => c.value === "BASBALL")).toBe(true);
    expect(trimmed.cells.filter((c) => c.value === "Attend").length).toBeGreaterThan(5);
  });

  it("collapses the used range instead of truncating real content", () => {
    // The full file declares 16,380 columns; the schedule lives in the first 30.
    const trimmed = trimSheet(sheet);
    const scheduleCols = trimmed.cells.filter((c) => c.col <= 30).length;
    expect(scheduleCols / trimmed.cells.length).toBeGreaterThan(0.9);
  });

  it("finds every day section", () => {
    const text = renderSheetForModel(sheet);
    for (const day of ["Monday", "Tuesday", "Wednesday"]) {
      expect(text).toContain(day);
    }
  });

  it("preserves the columns the schedule is actually made of", () => {
    const text = renderSheetForModel(sheet);
    for (const header of ["Time", "PAX", "Event", "Location", "Uniform"]) {
      expect(text).toContain(header);
    }
  });

  it("keeps the events and the PAX that scopes them", () => {
    const text = renderSheetForModel(sheet);
    expect(text).toContain("BRC");
    expect(text).toContain("Corps PT");
    expect(text).toContain("Band Practice");   // applies to Band only
    expect(text).toContain("Guard Mount");     // rotates by company
    expect(text).toContain("Rats and Cadre");
  });

  it("renders small enough to send", () => {
    const text = renderSheetForModel(sheet);
    expect(text.length).toBeLessThan(60_000);
  });
});

describe("CSV parsing edge cases", () => {
  it("handles quoted fields containing commas", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });
  it("handles doubled quotes inside a quoted field", () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([["a", 'say "hi"', "c"]]);
  });
  it("handles a newline inside a quoted field", () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([["a", "line1\nline2", "c"]]);
  });
  it("handles CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\nc,d')).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("keeps empty trailing fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });
});

/* ===========================================================================
   PAX: the Matrix is the whole Corps' week, and most of it is somebody else's.
   =========================================================================== */

import { buildDayInventory } from "@/lib/gaps";
import { toMatrixWeek } from "@/lib/convert";
import { SettingsSchema, type GeminiMatrixResponse } from "@/lib/schemas";

const settings = SettingsSchema.parse({});
const MON = "2026-09-07";

const row = (over: Partial<GeminiMatrixResponse["events"][number]>) => ({
  title: "Event", raw: "Event", day: "MO" as const, start: "18:00", end: "20:00",
  kind: "other" as const, availability: "BLOCKED" as const, confidence: 0.95,
  pax: "Corps", appliesToMe: true, location: "", uniform: "", endEstimated: false, ...over,
});

function freeAfter(events: GeminiMatrixResponse["events"]) {
  const { week } = toMatrixWeek({ weekStartDate: MON, events }, "m.csv");
  return buildDayInventory(MON, null, week.events, settings).freeMinutes;
}

const WHOLE_DAY = settings.dayEndMin - settings.dayStartMin;

describe("PAX filtering", () => {
  it("lets a Corps row take the cadet's time", () => {
    expect(freeAfter([row({ pax: "Corps", appliesToMe: true })])).toBe(WHOLE_DAY - 120);
  });

  it("does not let Band Practice take a non-Band cadet's evening", () => {
    // This is the failure that would have erased the week: 2,204 cells of the
    // whole Corps' obligations, most of them other people's.
    expect(freeAfter([
      row({ title: "Band Practice", pax: "Band", appliesToMe: false }),
    ])).toBe(WHOLE_DAY);
  });

  it("does not let another company's Guard Mount take Bravo's time", () => {
    expect(freeAfter([
      row({ title: "Guard Mount", pax: "E Company", appliesToMe: false }),
    ])).toBe(WHOLE_DAY);
  });

  it("blocks the time when the model is unsure whose row it is", () => {
    // Unsure cuts toward "you are busy" - the cheap error.
    expect(freeAfter([
      row({ title: "Unit Function", pax: "Select Cadets", appliesToMe: false, confidence: 0.3 }),
    ])).toBe(WHOLE_DAY - 120);
  });

  it("keeps a not-mine row visible rather than discarding it", () => {
    const { week } = toMatrixWeek(
      { weekStartDate: MON, events: [row({ pax: "Band", appliesToMe: false })] }, "m.csv",
    );
    expect(week.events).toHaveLength(1);
    expect(week.events[0].appliesToMe).toBe(false);
    expect(week.events[0].pax).toBe("Band");
  });

  it("does not let a not-mine CQ row create room-bound time either", () => {
    const { week } = toMatrixWeek({
      weekStartDate: MON,
      events: [row({ title: "CQ", availability: "PARTIAL", pax: "Rats and Cadre", appliesToMe: false })],
    }, "m.csv");
    const day = buildDayInventory(MON, null, week.events, settings);
    expect(day.gaps.some((g) => g.quality === "ROOM_BOUND")).toBe(false);
  });
});
