import { describe, expect, it } from "vitest";
import { inferKind, mergeAssignments, normalizeCourseCode, parseIcs, splitSummary } from "@/lib/ics";
import type { Assignment } from "@/lib/schemas";

const TZ = "America/New_York";

/** A Canvas feed, with CRLF line endings and a folded line, as Canvas emits. */
const CANVAS_FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Instructure//Canvas//EN",
  "X-WR-CALNAME:Fall 2026 Courses",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T120000Z",
  "DTSTART:20260915T035900Z",
  "SUMMARY:Problem Set 4 [MATH-171-01]",
  "DESCRIPTION:Complete exercises 1-20 from\\nchapter 7.",
  "UID:event-assignment-8891@vmi.instructure.com",
  "URL:https://vmi.instructure.com/courses/1/assignments/8891",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T120000Z",
  "DTSTART;VALUE=DATE:20260918",
  "SUMMARY:Reading: Chapter 7 [HI-104-02]",
  "UID:event-assignment-8892@vmi.instructure.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTAMP:20260901T120000Z",
  "DTSTART;TZID=America/New_York:20260916T235900",
  "SUMMARY:Lab Report 2 — spectroscopy\\, part one [CHEM-141-03]",
  "UID:event-assignment-8893@vmi.instructure.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  const result = parseIcs(CANVAS_FEED, TZ);

  it("reads the calendar name", () => {
    expect(result.calendarName).toBe("Fall 2026 Courses");
  });

  it("finds every assignment", () => {
    expect(result.assignments).toHaveLength(3);
    expect(result.skipped).toBe(0);
  });

  it("converts a UTC due time into local wall clock", () => {
    // 20260915T035900Z is 23:59 EDT on the 14th - the classic off-by-one-day
    // bug if you read the UTC date straight off the string.
    const ps = result.assignments.find((a) => a.title === "Problem Set 4")!;
    expect(ps.dueDate).toBe("2026-09-14");
    expect(ps.dueMin).toBe(23 * 60 + 59);
  });

  it("treats an all-day item as due at the end of that day", () => {
    const reading = result.assignments.find((a) => a.title.startsWith("Reading"))!;
    expect(reading.dueDate).toBe("2026-09-18");
    expect(reading.dueMin).toBe(23 * 60 + 59);
  });

  it("reads a TZID wall time without shifting it", () => {
    const lab = result.assignments.find((a) => a.title.startsWith("Lab Report"))!;
    expect(lab.dueDate).toBe("2026-09-16");
    expect(lab.dueMin).toBe(23 * 60 + 59);
  });

  it("pulls the course code out of the summary", () => {
    expect(result.assignments.map((a) => a.courseCode).sort())
      .toEqual(["CHEM 141", "HI 104", "MATH 171"]);
  });

  it("unescapes commas and newlines in text values", () => {
    const lab = result.assignments.find((a) => a.title.startsWith("Lab Report"))!;
    expect(lab.title).toBe("Lab Report 2 — spectroscopy, part one");
    const ps = result.assignments.find((a) => a.title === "Problem Set 4")!;
    expect(ps.notes).toContain("chapter 7.");
  });

  it("infers what kind of work each item is", () => {
    const kinds = Object.fromEntries(result.assignments.map((a) => [a.courseCode, a.kind]));
    expect(kinds["MATH 171"]).toBe("problem_set");
    expect(kinds["HI 104"]).toBe("reading");
    expect(kinds["CHEM 141"]).toBe("lab");
  });

  it("keeps the Canvas UID so re-imports can dedupe", () => {
    expect(result.assignments[0].uid).toContain("event-assignment-");
  });
});

describe("line folding", () => {
  it("rejoins a folded SUMMARY", () => {
    const folded = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT",
      "DTSTART:20260915T035900Z",
      "SUMMARY:A very long assignment title that Canvas decided to wrap acr",
      " oss two lines [PS-201-01]",
      "UID:x@y", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const { assignments } = parseIcs(folded, TZ);
    expect(assignments[0].title).toBe("A very long assignment title that Canvas decided to wrap across two lines");
    expect(assignments[0].courseCode).toBe("PS 201");
  });

  it("handles bare LF line endings too", () => {
    const lf = CANVAS_FEED.replace(/\r\n/g, "\n");
    expect(parseIcs(lf, TZ).assignments).toHaveLength(3);
  });
});

describe("malformed input", () => {
  it("returns nothing for an empty file instead of throwing", () => {
    expect(parseIcs("", TZ).assignments).toEqual([]);
  });
  it("returns nothing for a non-calendar file", () => {
    expect(parseIcs("just some text\nnot a calendar", TZ).assignments).toEqual([]);
  });
  it("skips an event with no date rather than inventing one", () => {
    const bad = ["BEGIN:VCALENDAR","BEGIN:VEVENT","SUMMARY:No date here","UID:x","END:VEVENT","END:VCALENDAR"].join("\r\n");
    const r = parseIcs(bad, TZ);
    expect(r.assignments).toEqual([]);
    expect(r.skipped).toBe(1);
  });
  it("ignores a quoted colon inside a parameter", () => {
    const tricky = [
      "BEGIN:VCALENDAR","BEGIN:VEVENT",
      'DTSTART;TZID="America/New_York":20260916T140000',
      "SUMMARY:Office hours","UID:x","END:VEVENT","END:VCALENDAR",
    ].join("\r\n");
    const { assignments } = parseIcs(tricky, TZ);
    expect(assignments[0].dueMin).toBe(14 * 60);
  });
});

describe("summary and code helpers", () => {
  it("splits a title from its bracketed course", () => {
    expect(splitSummary("Essay 1 [ERH-102-04]")).toEqual({ title: "Essay 1", courseCode: "ERH 102" });
  });
  it("leaves an unbracketed title alone", () => {
    expect(splitSummary("Ring Figure")).toEqual({ title: "Ring Figure" });
  });
  it("normalizes assorted course code spellings", () => {
    expect(normalizeCourseCode("MATH-171-01")).toBe("MATH 171");
    expect(normalizeCourseCode("chem 141")).toBe("CHEM 141");
    expect(normalizeCourseCode("CE301")).toBe("CE 301");
    expect(normalizeCourseCode("weird thing")).toBe("weird thing");
  });
  it("classifies work from its title", () => {
    expect(inferKind("Midterm Exam")).toBe("exam");
    expect(inferKind("Quiz 3")).toBe("quiz");
    expect(inferKind("Final Paper")).toBe("exam"); // "final" wins, and it should
    expect(inferKind("Read Ch. 4")).toBe("reading");
    expect(inferKind("Something else")).toBe("other");
  });
});

describe("mergeAssignments", () => {
  const base: Assignment = {
    id: "canvas:u1", uid: "u1", title: "Problem Set 4", courseCode: "MATH 171",
    dueDate: "2026-09-14", dueMin: 1439, kind: "problem_set", status: "todo", source: "canvas",
  };

  it("preserves work the cadet did on a re-import", () => {
    const existing = [{ ...base, status: "in_progress" as const, estimateMinutes: 120, priority: 2 }];
    const { merged, updated } = mergeAssignments(existing, [{ ...base, dueDate: "2026-09-16" }]);
    expect(merged[0].status).toBe("in_progress");
    expect(merged[0].estimateMinutes).toBe(120);
    expect(merged[0].priority).toBe(2);
    expect(merged[0].dueDate).toBe("2026-09-16"); // Canvas still owns the deadline
    expect(updated).toBe(1);
  });

  it("counts genuinely new assignments", () => {
    const { added } = mergeAssignments([base], [base, { ...base, id: "canvas:u2", uid: "u2", title: "PS 5" }]);
    expect(added).toBe(1);
  });

  it("never drops a manually added assignment", () => {
    const manual: Assignment = { ...base, id: "m1", uid: undefined, title: "Ring Figure prep", source: "manual" };
    const { merged } = mergeAssignments([base, manual], [base]);
    expect(merged.map((a) => a.title)).toContain("Ring Figure prep");
  });

  it("reports Canvas items that vanished without deleting silently", () => {
    const { removed, merged } = mergeAssignments([base], []);
    expect(removed).toBe(1);
    expect(merged).toEqual([]);
  });

  it("sorts the result by deadline", () => {
    const later = { ...base, id: "canvas:u2", uid: "u2", dueDate: "2026-10-01" };
    const { merged } = mergeAssignments([], [later, base]);
    expect(merged.map((a) => a.dueDate)).toEqual(["2026-09-14", "2026-10-01"]);
  });
});
