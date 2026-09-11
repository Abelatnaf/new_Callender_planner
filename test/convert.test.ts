import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, applyEstimates, applyRatchet, toMatrixWeek, toTerm } from "@/lib/convert";
import type { Assignment, GeminiMatrixResponse, GeminiTermResponse } from "@/lib/schemas";

const ev = (over: Partial<GeminiMatrixResponse["events"][number]> = {}) => ({
  title: "BRC", raw: "BRC", day: "MO" as const, start: "06:30", end: "07:00",
  kind: "formation" as const, availability: "BLOCKED" as const, confidence: 0.95, ...over,
});

const resp = (events: GeminiMatrixResponse["events"]): GeminiMatrixResponse => ({
  weekStartDate: "2026-09-07", events,
});

describe("applyRatchet", () => {
  it("trusts a confident USABLE call", () => {
    expect(applyRatchet("USABLE", 0.9)).toEqual({ availability: "USABLE", ratcheted: false });
  });

  it("downgrades an unsure USABLE to BLOCKED", () => {
    expect(applyRatchet("USABLE", 0.4)).toEqual({ availability: "BLOCKED", ratcheted: true });
  });

  it("downgrades an unsure PARTIAL to BLOCKED", () => {
    expect(applyRatchet("PARTIAL", 0.5)).toEqual({ availability: "BLOCKED", ratcheted: true });
  });

  it("leaves BLOCKED alone no matter how unsure the model was", () => {
    // The ratchet only ever restricts. It must never hand time back.
    expect(applyRatchet("BLOCKED", 0.01)).toEqual({ availability: "BLOCKED", ratcheted: false });
  });

  it("treats the floor as inclusive-trusting", () => {
    expect(applyRatchet("USABLE", CONFIDENCE_FLOOR).availability).toBe("USABLE");
    expect(applyRatchet("USABLE", CONFIDENCE_FLOOR - 0.01).availability).toBe("BLOCKED");
  });

  it("can only ever move time toward BLOCKED", () => {
    for (const a of ["BLOCKED", "USABLE", "PARTIAL"] as const) {
      for (const c of [0, 0.3, 0.74, 0.75, 1]) {
        const out = applyRatchet(a, c).availability;
        if (a === "BLOCKED") expect(out).toBe("BLOCKED");
        else expect(["BLOCKED", a]).toContain(out);
      }
    }
  });
});

describe("toMatrixWeek", () => {
  it("maps weekday letters onto real dates", () => {
    const { week } = toMatrixWeek(resp([
      ev({ day: "MO" }), ev({ day: "WE" }), ev({ day: "SU" }),
    ]), "matrix.xlsx");
    expect(week.events.map((e) => e.date)).toEqual(["2026-09-07", "2026-09-09", "2026-09-13"]);
  });

  it("converts clock strings into minutes", () => {
    const { week } = toMatrixWeek(resp([ev({ start: "19:30", end: "22:30" })]), "m.xlsx");
    expect(week.events[0]).toMatchObject({ startMin: 1170, endMin: 1350 });
  });

  it("counts and flags what the ratchet overrode", () => {
    const { week, ratchetedCount, lowConfidence } = toMatrixWeek(resp([
      ev({ title: "CQ", availability: "PARTIAL", confidence: 0.3 }),
      ev({ title: "Parade", availability: "BLOCKED", confidence: 0.99 }),
    ]), "m.xlsx");
    expect(ratchetedCount).toBe(1);
    expect(week.events.find((e) => e.title === "CQ")).toMatchObject({
      availability: "BLOCKED", ratcheted: true,
    });
    expect(lowConfidence.map((e) => e.title)).toEqual(["CQ"]);
  });

  it("snaps a non-Monday week start back to its Monday", () => {
    const { week, warnings } = toMatrixWeek(
      { weekStartDate: "2026-09-09", events: [ev()] }, "m.xlsx",
    );
    expect(week.weekStart).toBe("2026-09-07");
    expect(warnings.join(" ")).toContain("not a Monday");
  });

  it("skips an event whose times cannot be read, and says so", () => {
    const { week, warnings } = toMatrixWeek(resp([
      ev({ title: "Good" }), ev({ title: "Bad", start: "banana", end: "??" }),
    ]), "m.xlsx");
    expect(week.events.map((e) => e.title)).toEqual(["Good"]);
    expect(warnings.join(" ")).toContain("Bad");
  });

  it("skips a zero-length event", () => {
    const { week } = toMatrixWeek(resp([ev({ start: "08:00", end: "08:00" })]), "m.xlsx");
    expect(week.events).toEqual([]);
  });

  it("skips an unrecognized weekday rather than guessing", () => {
    const { week, warnings } = toMatrixWeek(
      resp([{ ...ev(), day: "XX" as unknown as "MO" }]), "m.xlsx",
    );
    expect(week.events).toEqual([]);
    expect(warnings.join(" ")).toContain("unrecognized day");
  });

  it("warns when a file yielded nothing at all", () => {
    const { warnings } = toMatrixWeek(resp([]), "m.xlsx");
    expect(warnings.join(" ")).toContain("No events were found");
  });

  it("sorts events by date then time", () => {
    const { week } = toMatrixWeek(resp([
      ev({ day: "WE", start: "08:00", end: "09:00" }),
      ev({ day: "MO", start: "18:00", end: "19:00" }),
      ev({ day: "MO", start: "06:30", end: "07:00" }),
    ]), "m.xlsx");
    expect(week.events.map((e) => [e.date, e.startMin])).toEqual([
      ["2026-09-07", 390], ["2026-09-07", 1080], ["2026-09-09", 480],
    ]);
  });

  it("records the source file for auditing", () => {
    const { week } = toMatrixWeek(resp([ev()]), "MATRIX_WK7.xlsx");
    expect(week.source?.filename).toBe("MATRIX_WK7.xlsx");
  });
});

describe("toTerm", () => {
  const termResp: GeminiTermResponse = {
    name: "Fall 2026", startDate: "2026-08-17", endDate: "2026-12-11",
    courses: [{
      code: "MATH 171", title: "Calculus I", instructor: "COL Smith",
      meetings: [{ days: ["MO", "WE", "FR"], start: "09:00", end: "09:50", location: "MA 214" }],
    }],
  };

  it("converts meeting times and keeps locations", () => {
    const { term } = toTerm(termResp, "schedule.xlsx");
    expect(term.courses[0].meetings[0]).toMatchObject({
      startMin: 540, endMin: 590, location: "MA 214",
    });
  });

  it("warns about a course it could not give meeting times", () => {
    const { warnings } = toTerm({
      ...termResp,
      courses: [{ code: "HI 104", title: "History", meetings: [{ days: ["MO"], start: "??", end: "??" }] }],
    }, "s.xlsx");
    expect(warnings.join(" ")).toContain("HI 104");
  });

  it("drops a meeting with no valid days instead of guessing one", () => {
    const { term, warnings } = toTerm({
      ...termResp,
      courses: [{ code: "X 1", title: "X", meetings: [{ days: [] as unknown as ["MO"], start: "09:00", end: "10:00" }] }],
    }, "s.xlsx");
    expect(term.courses[0].meetings).toEqual([]);
    expect(warnings.join(" ")).toContain("X 1");
  });
});

describe("applyEstimates", () => {
  const base: Assignment = {
    id: "A1", title: "PS 4", dueDate: "2026-09-14", dueMin: 1439,
    kind: "other", status: "todo", source: "canvas",
  };

  it("fills in an estimate the cadet has not set", () => {
    const [out] = applyEstimates([base], [
      { assignmentId: "A1", estimateMinutes: 90, priority: 2, kind: "problem_set" },
    ]);
    expect(out).toMatchObject({ estimateMinutes: 90, priority: 2, kind: "problem_set" });
  });

  it("never overwrites a number the cadet typed", () => {
    const [out] = applyEstimates([{ ...base, estimateMinutes: 45, priority: 1 }], [
      { assignmentId: "A1", estimateMinutes: 300, priority: 5, kind: "exam" },
    ]);
    expect(out.estimateMinutes).toBe(45);
    expect(out.priority).toBe(1);
  });

  it("leaves assignments the model did not mention untouched", () => {
    const [out] = applyEstimates([base], []);
    expect(out).toEqual(base);
  });
});
