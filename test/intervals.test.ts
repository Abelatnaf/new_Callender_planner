import { describe, expect, it } from "vitest";
import { intersect, normalize, overlaps, subtract, totalMinutes } from "@/lib/intervals";

const iv = (startMin: number, endMin: number) => ({ startMin, endMin });

describe("normalize", () => {
  it("merges overlapping intervals", () => {
    expect(normalize([iv(60, 120), iv(90, 180)])).toEqual([iv(60, 180)]);
  });
  it("merges touching intervals", () => {
    expect(normalize([iv(60, 120), iv(120, 180)])).toEqual([iv(60, 180)]);
  });
  it("leaves disjoint intervals alone and sorts them", () => {
    expect(normalize([iv(300, 360), iv(60, 120)])).toEqual([iv(60, 120), iv(300, 360)]);
  });
  it("drops zero-length and inverted intervals", () => {
    expect(normalize([iv(60, 60), iv(180, 120)])).toEqual([]);
  });
});

describe("subtract", () => {
  it("punches a hole in the middle", () => {
    expect(subtract([iv(360, 1380)], [iv(600, 660)])).toEqual([iv(360, 600), iv(660, 1380)]);
  });
  it("trims a leading overlap", () => {
    expect(subtract([iv(360, 1380)], [iv(300, 420)])).toEqual([iv(420, 1380)]);
  });
  it("removes a fully covered interval", () => {
    expect(subtract([iv(600, 660)], [iv(540, 720)])).toEqual([]);
  });
  it("handles multiple overlapping cuts", () => {
    // Two obligations that overlap each other should behave as one.
    expect(subtract([iv(360, 1380)], [iv(600, 700), iv(650, 800)])).toEqual([
      iv(360, 600), iv(800, 1380),
    ]);
  });
  it("is a no-op when nothing intersects", () => {
    expect(subtract([iv(360, 480)], [iv(600, 660)])).toEqual([iv(360, 480)]);
  });
});

describe("intersect and overlaps", () => {
  it("treats intervals as half-open", () => {
    expect(overlaps(iv(60, 120), iv(120, 180))).toBe(false);
    expect(intersect(iv(60, 120), iv(120, 180))).toBeNull();
  });
  it("finds a real intersection", () => {
    expect(intersect(iv(60, 180), iv(120, 240))).toEqual(iv(120, 180));
  });
});

describe("totalMinutes", () => {
  it("counts overlap only once", () => {
    expect(totalMinutes([iv(0, 60), iv(30, 90)])).toBe(90);
  });
});

describe("glowBand", () => {
  it("maps each hour to its time of day", async () => {
    const { glowBand } = await import("@/lib/layout");
    expect(glowBand(6 * 60)).toBe("dawn");
    expect(glowBand(12 * 60)).toBe("day");
    expect(glowBand(17 * 60)).toBe("dusk");
    expect(glowBand(22 * 60)).toBe("night");
  });

  it("puts each boundary on the later band", async () => {
    const { glowBand } = await import("@/lib/layout");
    expect(glowBand(11 * 60 - 1)).toBe("dawn");
    expect(glowBand(11 * 60)).toBe("day");
    expect(glowBand(16 * 60 - 1)).toBe("day");
    expect(glowBand(16 * 60)).toBe("dusk");
    expect(glowBand(20 * 60 - 1)).toBe("dusk");
    expect(glowBand(20 * 60)).toBe("night");
  });

  it("never returns anything outside the four bands", async () => {
    const { glowBand } = await import("@/lib/layout");
    const bands = new Set(["dawn", "day", "dusk", "night"]);
    for (let m = 0; m <= 1440; m += 7) expect(bands.has(glowBand(m))).toBe(true);
  });
});

describe("courseHue", () => {
  it("is stable for the same key", async () => {
    const { courseHue } = await import("@/lib/layout");
    expect(courseHue("CHEM 141")).toBe(courseHue("CHEM 141"));
  });
  it("stays inside the palette", async () => {
    const { courseHue } = await import("@/lib/layout");
    for (const k of ["CHEM 141", "MATH 171", "HI 104", "ERH 102", "", "x"]) {
      const h = courseHue(k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(8);
    }
  });
  it("handles a missing key without throwing", async () => {
    const { courseHue } = await import("@/lib/layout");
    expect(courseHue(undefined)).toBe(0);
  });
});

describe("buildCourseHues", () => {
  const CODES = ["CHEM 141", "MATH 171", "HI 104", "ERH 102"];

  it("gives every course a distinct colour", async () => {
    // The guarantee a hash cannot make: four items in eight slots collide more
    // often than not, so assignment is sequential rather than hashed.
    const { buildCourseHues } = await import("@/lib/layout");
    const map = buildCourseHues(CODES);
    expect(new Set(map.values()).size).toBe(CODES.length);
  });

  it("stays distinct up to the full palette", async () => {
    const { buildCourseHues, HUE_SLOTS } = await import("@/lib/layout");
    const many = Array.from({ length: HUE_SLOTS }, (_, i) => `C${i} 100`);
    expect(new Set(buildCourseHues(many).values()).size).toBe(HUE_SLOTS);
  });

  it("is stable across calls and ignores duplicates and blanks", async () => {
    const { buildCourseHues } = await import("@/lib/layout");
    const a = buildCourseHues([...CODES, "CHEM 141", undefined, "  "]);
    const b = buildCourseHues(CODES);
    expect(a.get("CHEM 141")).toBe(b.get("CHEM 141"));
    expect(a.size).toBe(CODES.length);
  });

  it("wraps past the palette rather than running off the end", async () => {
    const { buildCourseHues, HUE_SLOTS } = await import("@/lib/layout");
    const many = Array.from({ length: HUE_SLOTS + 3 }, (_, i) => `C${i} 100`);
    for (const v of buildCourseHues(many).values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(HUE_SLOTS);
    }
  });
});

describe("hueFor", () => {
  it("prefers the assigned slot over the hash", async () => {
    const { buildCourseHues, hueFor } = await import("@/lib/layout");
    const hues = buildCourseHues(["CHEM 141", "MATH 171"]);
    expect(hueFor("CHEM 141", hues)).toBe(0);
    expect(hueFor("MATH 171", hues)).toBe(1);
  });
  it("falls back to a hash for a course not in the term", async () => {
    const { buildCourseHues, hueFor, courseHue } = await import("@/lib/layout");
    const hues = buildCourseHues(["CHEM 141"]);
    expect(hueFor("PY 201", hues)).toBe(courseHue("PY 201"));
  });
  it("handles a missing key without throwing", async () => {
    const { courseHue } = await import("@/lib/layout");
    expect(courseHue(undefined)).toBe(0);
  });
});

describe("gapGradient", () => {
  it("sweeps every band a long window crosses", async () => {
    const { gapGradient } = await import("@/lib/layout");
    const g = await gapGradient(6 * 60, 23 * 60);
    for (const band of ["--dawn", "--day", "--dusk", "--night"]) {
      expect(g).toContain(band);
    }
  });

  it("uses only the band a short window sits inside", async () => {
    const { gapGradient } = await import("@/lib/layout");
    const g = gapGradient(7 * 60, 8 * 60);
    expect(g).toContain("--dawn");
    expect(g).not.toContain("--dusk");
    expect(g).not.toContain("--night");
  });

  it("places stops between 0% and 100%", async () => {
    const { gapGradient } = await import("@/lib/layout");
    for (const pct of gapGradient(6 * 60, 23 * 60).match(/[\d.]+%/g) ?? []) {
      const n = parseFloat(pct);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
    }
  });

  it("survives a zero-length window without dividing by zero", async () => {
    const { gapGradient } = await import("@/lib/layout");
    expect(gapGradient(600, 600)).toContain("linear-gradient");
  });
});
