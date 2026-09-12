/**
 * The geometry every bar is drawn from.
 *
 * This module places obligations on the Ribbon and windows on the printed
 * sheet. A mistake here is not a crash — it is a bar in the wrong place on a
 * page a cadet is carrying, which is the one kind of error the whole app
 * exists to avoid producing.
 */
import { describe, expect, it } from "vitest";
import { HUE_SLOTS, buildCourseHues, courseHue, gapGradient, glowBand, placement, toPct } from "@/lib/layout";

/** The app's own waking day: 0600 to 2330. */
const axis = { startMin: 6 * 60, endMin: 23 * 60 + 30 };

describe("toPct", () => {
  it("puts the axis ends at 0 and 100", () => {
    expect(toPct(axis.startMin, axis)).toBe(0);
    expect(toPct(axis.endMin, axis)).toBe(100);
  });

  it("puts the midpoint halfway", () => {
    expect(toPct((axis.startMin + axis.endMin) / 2, axis)).toBeCloseTo(50, 10);
  });

  it("does not divide by zero on a collapsed axis", () => {
    expect(Number.isFinite(toPct(500, { startMin: 600, endMin: 600 }))).toBe(true);
  });
});

describe("placement", () => {
  it("places an ordinary class inside the day", () => {
    const p = placement(600, 650, axis);          // 1000-1050
    expect(p).not.toBeNull();
    expect(p!.widthPct).toBeGreaterThan(0);
    expect(p!.left).toMatch(/%$/);
    expect(p!.width).toMatch(/%$/);
  });

  it("clamps an event that starts before the day does", () => {
    // Optional 0500 PT should draw from the left edge, not off-canvas.
    const p = placement(300, 420, axis);
    expect(p!.left).toBe("0%");
    expect(p!.widthPct).toBeCloseTo(toPct(420, axis), 10);
  });

  it("clamps an event that runs past the end of the day", () => {
    const p = placement(1380, 1500, axis);        // 2300 to past midnight
    expect(toPct(1380, axis) + p!.widthPct).toBeCloseTo(100, 10);
  });

  it("returns null for an event entirely before the day", () => {
    expect(placement(60, 120, axis)).toBeNull();
  });

  it("returns null for an event entirely after the day", () => {
    expect(placement(1420, 1440, axis)).toBeNull();
  });

  it("returns null for an event that only touches the edge", () => {
    // Zero width is not a bar; drawing it would put a hairline at the margin.
    expect(placement(300, axis.startMin, axis)).toBeNull();
    expect(placement(axis.endMin, 1440, axis)).toBeNull();
  });

  it("returns null for a zero-length event", () => {
    expect(placement(600, 600, axis)).toBeNull();
  });

  it("never returns a bar that would overflow its track", () => {
    for (const [s, e] of [[0, 1440], [300, 1500], [axis.startMin, axis.endMin]]) {
      const p = placement(s, e, axis)!;
      expect(p.widthPct).toBeLessThanOrEqual(100.0001);
      expect(parseFloat(p.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(p.left) + p.widthPct).toBeLessThanOrEqual(100.0001);
    }
  });
});

describe("glowBand", () => {
  it("splits the day where the tokens say it does", () => {
    expect(glowBand(6 * 60)).toBe("dawn");
    expect(glowBand(10 * 60 + 59)).toBe("dawn");
    expect(glowBand(11 * 60)).toBe("day");
    expect(glowBand(15 * 60 + 59)).toBe("day");
    expect(glowBand(16 * 60)).toBe("dusk");
    expect(glowBand(19 * 60 + 59)).toBe("dusk");
    expect(glowBand(20 * 60)).toBe("night");
    expect(glowBand(23 * 60 + 30)).toBe("night");
  });
});

describe("gapGradient", () => {
  it("is a gradient, anchored at both ends", () => {
    const g = gapGradient(6 * 60, 23 * 60);
    expect(g).toMatch(/gradient/);
    expect(g).toMatch(/0\.00%/);
    expect(g).toMatch(/100\.00%/);
  });

  it("sweeps more bands across a long window than a short one", () => {
    // A nine-hour Sunday should read sunrise-to-night, not a slab of one hue.
    const long = (gapGradient(6 * 60, 23 * 60).match(/%/g) ?? []).length;
    const short = (gapGradient(9 * 60, 10 * 60).match(/%/g) ?? []).length;
    expect(long).toBeGreaterThan(short);
  });

  it("does not divide by zero on a zero-length gap", () => {
    expect(() => gapGradient(600, 600)).not.toThrow();
  });
});

describe("buildCourseHues", () => {
  it("gives every course its own slot", () => {
    const codes = ["CIS 101", "CIS 111", "ERH 101", "HI 103", "MA 106", "MS 109"];
    const hues = buildCourseHues(codes);
    expect(new Set(hues.values()).size).toBe(codes.length);
  });

  it("is stable across calls, so colours never move between renders", () => {
    const codes = ["CIS 101", "CIS 111", "ERH 101"];
    expect([...buildCourseHues(codes)]).toEqual([...buildCourseHues(codes)]);
  });

  it("assigns in term order rather than by hash", () => {
    // Hashing four courses into eight slots collides more often than not, and
    // a test once caught two of four sharing a colour.
    expect([...buildCourseHues(["A", "B", "C"]).values()]).toEqual([0, 1, 2]);
  });

  it("ignores blanks and repeats without burning a slot", () => {
    const hues = buildCourseHues(["CIS 101", undefined, "  ", "CIS 101", "HI 103"]);
    expect(hues.get("CIS 101")).toBe(0);
    expect(hues.get("HI 103")).toBe(1);
    expect(hues.size).toBe(2);
  });

  it("trims a code so a stray space is not a second course", () => {
    const hues = buildCourseHues(["CIS 101", " CIS 101 "]);
    expect(hues.size).toBe(1);
  });

  it("wraps rather than running off the end of the palette", () => {
    const many = Array.from({ length: HUE_SLOTS + 3 }, (_, i) => `C${i}`);
    for (const slot of buildCourseHues(many).values()) {
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(HUE_SLOTS);
    }
  });
});

describe("courseHue, the fallback", () => {
  it("stays inside the palette", () => {
    for (const k of ["CIS 101", "", "a very long course title", "🙂"]) {
      const h = courseHue(k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(HUE_SLOTS);
    }
  });

  it("gives the same answer for the same key", () => {
    expect(courseHue("HI 103")).toBe(courseHue("HI 103"));
  });

  it("handles an absent code without throwing", () => {
    expect(() => courseHue(undefined)).not.toThrow();
  });
});
