/**
 * Cutting the week into days, and fanning the calls out safely.
 *
 * Asking Gemini for a whole week in one request meant one reply carrying a
 * hundred-odd events. Output tokens are what latency is made of, and that
 * reply ran past the minute a serverless function gets — the real import
 * failed with "Gemini took longer than a minute". It is also all-or-nothing:
 * one malformed row loses the other six days with it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readCsv } from "@/lib/csv";
import { renderWorkbookForModel, splitByDay } from "@/lib/grid";
import { mapWithLimit } from "@/lib/limit";

const realGrid = () =>
  renderWorkbookForModel(readCsv(readFileSync("test/fixtures/matrix-real.csv", "utf8"), "m.csv"), {
    dropSportColumns: true,
  });

describe("splitByDay", () => {
  it("finds every day section in the real file", () => {
    const { days } = splitByDay(realGrid());
    expect(days.map((d) => d.weekday)).toEqual(["Monday", "Tuesday", "Wednesday"]);
  });

  it("keeps each chunk small enough to answer quickly", () => {
    // The whole point: a call that returns a dozen events, not a hundred.
    for (const d of splitByDay(realGrid()).days) {
      expect(d.text.length).toBeLessThan(8_000);
    }
  });

  it("loses no row: the sections plus the preamble are the whole grid", () => {
    const grid = realGrid();
    const { preamble, days } = splitByDay(grid);
    const rebuilt = [preamble, ...days.map((d) => d.text)].filter(Boolean).join("\n");
    expect(rebuilt.split("\n").length).toBe(grid.split("\n").length);
  });

  it("keeps the heading with its own section", () => {
    const { days } = splitByDay(realGrid());
    for (const d of days) expect(d.text.startsWith(d.heading.split("\t")[0])).toBe(true);
    expect(days[0].heading).toMatch(/Monday, September 7, 2026/);
  });

  it("hands back the week title separately, so every chunk can carry it", () => {
    const { preamble } = splitByDay(realGrid());
    expect(preamble).toMatch(/Week 03/);
  });

  it("keeps a day's own rows with it", () => {
    const tuesday = splitByDay(realGrid()).days.find((d) => d.weekday === "Tuesday")!;
    expect(tuesday.text).toMatch(/Tuesday, September 8/);
    expect(tuesday.text).not.toMatch(/Wednesday, September 9/);
  });

  it("returns nothing to split when there are no day headings", () => {
    expect(splitByDay("Time\tPAX\tEvent\n0700\tCorps\tBRC")).toEqual({ preamble: "", days: [] });
  });

  it("reads a heading that the renderer prefixed with a row number", () => {
    const { days } = splitByDay('2\tMonday, September 7, 2026\t\tParade\n3\t0700\tCorps\tBRC');
    expect(days).toHaveLength(1);
    expect(days[0].weekday).toBe("Monday");
  });

  it("reads a quoted heading, as a CSV export writes it", () => {
    expect(splitByDay('"Friday, September 11, 2026"\n0700\tCorps\tBRC').days[0].weekday).toBe("Friday");
  });
});

describe("mapWithLimit", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("returns results in input order, not completion order", async () => {
    const out = await mapWithLimit([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual([30, 10, 20]);
  });

  it("never runs more than the limit at once", async () => {
    let live = 0;
    let peak = 0;
    await mapWithLimit([...Array(9).keys()], 3, async () => {
      peak = Math.max(peak, ++live);
      await sleep(5);
      live--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("keeps the good results when one task throws", async () => {
    // Six good days must survive a bad one; that is the whole reason to split.
    const out = await mapWithLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("Tuesday is unreadable");
      return n * 10;
    });
    expect(out[0]).toEqual({ ok: true, value: 10 });
    expect(out[1].ok).toBe(false);
    expect(out[2]).toEqual({ ok: true, value: 30 });
  });

  it("does not reject, whatever the tasks do", async () => {
    await expect(
      mapWithLimit([1, 2], 2, async () => { throw new Error("both fail"); }),
    ).resolves.toHaveLength(2);
  });

  it("carries the error through for the caller to report", async () => {
    const [r] = await mapWithLimit([1], 1, async () => { throw new Error("Thursday"); });
    expect(r.ok).toBe(false);
    expect(!r.ok && (r.error as Error).message).toBe("Thursday");
  });

  it("handles an empty list without hanging", async () => {
    await expect(mapWithLimit([], 3, async () => 1)).resolves.toEqual([]);
  });

  it("copes with a limit larger than the list", async () => {
    const out = await mapWithLimit([1, 2], 10, async (n) => n);
    expect(out.map((r) => (r.ok ? r.value : null))).toEqual([1, 2]);
  });
});
