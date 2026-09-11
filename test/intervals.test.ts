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
