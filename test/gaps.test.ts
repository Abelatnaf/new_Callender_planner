import { describe, expect, it } from "vitest";
import { buildDayInventory, buildWeekInventory, describeGapsForModel, meetingsOn } from "@/lib/gaps";
import { MIN_USEFUL_GAP } from "@/lib/time";
import { MONDAY, ev, matrixEvents, settings, term } from "./fixtures/week";

describe("meetingsOn", () => {
  it("returns the courses that meet that weekday", () => {
    // Monday: CHEM 0800-0850, MATH 0900-0950, HI 1330-1420
    expect(meetingsOn(term, MONDAY)).toHaveLength(3);
  });
  it("returns nothing on a day no course meets", () => {
    expect(meetingsOn(term, "2026-09-12")).toHaveLength(0); // Saturday
  });
  it("ignores dates outside the term", () => {
    expect(meetingsOn(term, "2026-07-06")).toHaveLength(0); // a Monday in summer
  });
  it("returns nothing when there is no term yet", () => {
    expect(meetingsOn(null, MONDAY)).toHaveLength(0);
  });
});

describe("buildDayInventory", () => {
  const day = buildDayInventory(MONDAY, term, matrixEvents, settings);

  it("subtracts both classes and mandatory formations", () => {
    // 3 classes + 4 BLOCKED matrix events, none overlapping = 7 blocked runs.
    expect(day.blocked).toHaveLength(7);
  });

  it("never lets a gap intersect an obligation", () => {
    for (const gap of day.gaps) {
      for (const b of day.blocked) {
        expect(gap.startMin < b.endMin && b.startMin < gap.endMin).toBe(false);
      }
    }
  });

  it("keeps every gap inside the waking day window", () => {
    for (const gap of day.gaps) {
      expect(gap.startMin).toBeGreaterThanOrEqual(settings.dayStartMin);
      expect(gap.endMin).toBeLessThanOrEqual(settings.dayEndMin);
    }
  });

  it("discards slivers too short to be worth using", () => {
    for (const gap of day.gaps) {
      expect(gap.minutes).toBeGreaterThanOrEqual(MIN_USEFUL_GAP);
    }
  });

  it("marks CQ as room-bound rather than removing it", () => {
    const cq = day.gaps.filter((g) => g.quality === "ROOM_BOUND");
    expect(cq.length).toBeGreaterThan(0);
    expect(cq[0].label).toBe("CQ");
    // CQ runs 1930-2250 but the day window closes at 2300, so it survives whole.
    expect(cq[0].startMin).toBe(1170);
    expect(cq[0].endMin).toBe(1350);
  });

  it("splits the evening around CQ into separate labelled gaps", () => {
    const evening = day.gaps.filter((g) => g.startMin >= 1125);
    // 1845-1930 open, 1930-2230 room-bound (CQ), then open until the day ends.
    expect(evening.map((g) => g.quality)).toEqual(["OPEN", "ROOM_BOUND", "OPEN"]);
    expect(evening.map((g) => [g.startMin, g.endMin])).toEqual([
      [1125, 1170], [1170, 1350], [1350, settings.dayEndMin],
    ]);
  });

  it("assigns stable, sorted gap ids", () => {
    const ids = day.gaps.map((g) => g.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]).toMatch(/^G-2026-09-07-\d{2}$/);
  });
});

describe("the availability ratchet", () => {
  it("lets BLOCKED events consume time", () => {
    const withBlock = buildDayInventory(MONDAY, null,
      [ev("X", "Parade", MONDAY, 600, 720, "parade", "BLOCKED")], settings);
    expect(withBlock.freeMinutes).toBe(settings.dayEndMin - settings.dayStartMin - 120);
  });

  it("never lets a USABLE event consume time", () => {
    const withUsable = buildDayInventory(MONDAY, null,
      [ev("X", "Open Period", MONDAY, 600, 720, "study", "USABLE")], settings);
    expect(withUsable.freeMinutes).toBe(settings.dayEndMin - settings.dayStartMin);
  });

  it("never lets a PARTIAL event consume time - only label it", () => {
    const withPartial = buildDayInventory(MONDAY, null,
      [ev("X", "CQ", MONDAY, 600, 720, "study", "PARTIAL")], settings);
    expect(withPartial.freeMinutes).toBe(settings.dayEndMin - settings.dayStartMin);
    expect(withPartial.gaps.some((g) => g.quality === "ROOM_BOUND")).toBe(true);
  });
});

describe("messy input", () => {
  it("merges Matrix events that overlap each other", () => {
    const day = buildDayInventory(MONDAY, null, [
      ev("X", "Guard", MONDAY, 600, 700, "duty", "BLOCKED"),
      ev("Y", "Guard mount", MONDAY, 650, 800, "duty", "BLOCKED"),
    ], settings);
    expect(day.blocked).toEqual([{ startMin: 600, endMin: 800 }]);
  });

  it("survives an all-day blocking event", () => {
    const day = buildDayInventory(MONDAY, term, [
      ev("X", "Parents Weekend", MONDAY, 0, 1440, "other", "BLOCKED"),
    ], settings);
    expect(day.gaps).toEqual([]);
    expect(day.freeMinutes).toBe(0);
  });

  it("ignores events belonging to a different date", () => {
    const day = buildDayInventory(MONDAY, null, [
      ev("X", "Parade", "2026-09-09", 600, 720, "parade", "BLOCKED"),
    ], settings);
    expect(day.blocked).toEqual([]);
  });
});

describe("buildWeekInventory", () => {
  const week = buildWeekInventory(MONDAY, term, matrixEvents, settings);

  it("covers exactly seven days", () => {
    expect(week.days).toHaveLength(7);
    expect(week.days[0].date).toBe(MONDAY);
    expect(week.days[6].date).toBe("2026-09-13");
  });

  it("totals free minutes across the week", () => {
    expect(week.freeMinutes).toBe(week.days.reduce((n, d) => n + d.freeMinutes, 0));
  });

  it("produces globally unique gap ids", () => {
    const ids = week.gaps.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes gaps for the model with ids it can reference back", () => {
    const text = describeGapsForModel(week);
    expect(text).toContain("TOTAL FREE:");
    for (const gap of week.gaps.slice(0, 5)) expect(text).toContain(gap.id);
  });
});
