import { describe, expect, it } from "vitest";
import {
  addDays, dayOfWeek, formatDuration, hhmm, instantToLocal, shortDate, snap,
  stamp, toMinutes, weekDates, weekStart, weekdayOf,
} from "@/lib/time";

describe("toMinutes", () => {
  it("parses military time", () => {
    expect(toMinutes("0930")).toBe(570);
    expect(toMinutes("1930")).toBe(1170);
    expect(toMinutes("0000")).toBe(0);
    expect(toMinutes("2359")).toBe(1439);
  });
  it("parses colon time", () => {
    expect(toMinutes("09:30")).toBe(570);
    expect(toMinutes("19:30")).toBe(1170);
  });
  it("parses 12-hour time", () => {
    expect(toMinutes("9:30 AM")).toBe(570);
    expect(toMinutes("7:30 PM")).toBe(1170);
    expect(toMinutes("12:00 AM")).toBe(0);
    expect(toMinutes("12:00 PM")).toBe(720);
  });
  it("rejects nonsense", () => {
    expect(() => toMinutes("25:00")).toThrow();
    expect(() => toMinutes("banana")).toThrow();
  });
});

describe("formatting", () => {
  it("renders military strings", () => {
    expect(hhmm(570)).toBe("0930");
    expect(hhmm(1170)).toBe("1930");
  });
  it("renders durations the way a person says them", () => {
    expect(formatDuration(160)).toBe("2H 40M");
    expect(formatDuration(45)).toBe("45M");
    expect(formatDuration(120)).toBe("2H");
    expect(formatDuration(0)).toBe("0M");
  });
  it("snaps to the 15-minute grid", () => {
    expect(snap(98)).toBe(105);  // 6.53 grid units -> 7
    expect(snap(97)).toBe(90);   // 6.47 grid units -> 6
    expect(snap(91)).toBe(90);
    expect(snap(90)).toBe(90);
  });
});

describe("calendar arithmetic", () => {
  it("knows the day of week", () => {
    expect(dayOfWeek("2026-09-11")).toBe(5); // a Friday
    expect(weekdayOf("2026-09-11")).toBe("FR");
  });
  it("finds the Monday of a week", () => {
    expect(weekStart("2026-09-11")).toBe("2026-09-07"); // Fri -> Mon
    expect(weekStart("2026-09-07")).toBe("2026-09-07"); // Mon -> itself
    expect(weekStart("2026-09-13")).toBe("2026-09-07"); // Sun belongs to prior Mon
  });
  it("produces seven dates for a week", () => {
    expect(weekDates("2026-09-07")).toEqual([
      "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10",
      "2026-09-11", "2026-09-12", "2026-09-13",
    ]);
  });
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("survives a leap year", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });
  it("formats short dates", () => {
    expect(shortDate("2026-09-11")).toBe("11 SEP");
  });
});

describe("timezone conversion", () => {
  it("converts a UTC instant to Virginia wall clock in EDT", () => {
    // 2026-09-11T23:59:00Z is 19:59 EDT on the 11th.
    const got = instantToLocal(new Date("2026-09-11T23:59:00Z"), "America/New_York");
    expect(got).toEqual({ date: "2026-09-11", minutes: 19 * 60 + 59 });
  });
  it("converts across the date line into the previous local day", () => {
    // 2026-01-05T03:00:00Z is 22:00 EST on the 4th.
    const got = instantToLocal(new Date("2026-01-05T03:00:00Z"), "America/New_York");
    expect(got).toEqual({ date: "2026-01-04", minutes: 22 * 60 });
  });
  it("handles the DST transition correctly", () => {
    // EST (UTC-5) before the March change, EDT (UTC-4) after.
    const before = instantToLocal(new Date("2026-03-08T06:00:00Z"), "America/New_York");
    const after = instantToLocal(new Date("2026-03-08T07:00:00Z"), "America/New_York");
    expect(before.minutes).toBe(60);       // 0100 EST
    expect(after.minutes).toBe(3 * 60);    // 0300 EDT - 0200 never existed
  });
  it("renders midnight as 0000, not 2400", () => {
    const got = instantToLocal(new Date("2026-09-11T04:00:00Z"), "America/New_York");
    expect(got).toEqual({ date: "2026-09-11", minutes: 0 });
  });
});

describe("stamp", () => {
  it("orders (date, minute) pairs as one comparable number", () => {
    expect(stamp("2026-09-11", 600)).toBeLessThan(stamp("2026-09-11", 601));
    expect(stamp("2026-09-11", 1439)).toBeLessThan(stamp("2026-09-12", 0));
  });
});
