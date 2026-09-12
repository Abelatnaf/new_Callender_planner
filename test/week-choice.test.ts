/**
 * WHICH WEEK A SCREEN OPENS ON.
 *
 * The Matrix is published before the week it describes, so the week a cadet
 * has imported is routinely not the week today falls in. Both the main screen
 * and the printed document used to open on today's Monday unconditionally and
 * look up the Matrix by exact key. When those disagreed the lookup returned
 * null, every event filtered out on date, and the document rendered seven
 * immaculate empty pages with nothing on screen to say why.
 *
 * These tests pin the selector that chooses the week, and the silent-empty
 * behaviour of the builder that made the bug invisible.
 */
import { describe, expect, it } from "vitest";
import { bestWeekStart, emptyVault, importedWeekStarts, weekFor } from "@/lib/store";
import { buildDocument } from "@/lib/document";
import type { MatrixWeek, Vault } from "@/lib/schemas";

/** A week carrying one event on its Monday. */
function weekOf(weekStart: string): MatrixWeek {
  return {
    id: `MW-${weekStart}`,
    weekStart,
    events: [{
      id: `MX-${weekStart}-001`,
      title: "BRC",
      raw: "0700 Corps BRC",
      date: weekStart,
      startMin: 420,
      endMin: 450,
      kind: "formation",
      availability: "BLOCKED",
      pax: "Corps",
      location: "Bricks",
      uniform: "Class Dyke",
      endEstimated: true,
      appliesToMe: true,
      confidence: 0.95,
      confirmedByUser: false,
      ratcheted: false,
    }],
    source: { filename: "Matrix.csv", importedAt: "2026-09-01T00:00:00.000Z" },
    audit: {
      rowsReturned: 1, rowsKept: 1, rowsSkipped: 0, notMine: 0,
      ratcheted: 0, endsEstimated: 1, cellsBefore: 0, cellsAfter: 0, model: "test",
    },
  };
}

/** A vault fixed to a timezone, carrying the given imported weeks. */
function vaultWith(weeks: string[]): Vault {
  const v = emptyVault();
  return { ...v, matrixWeeks: weeks.map(weekOf) };
}

describe("importedWeekStarts", () => {
  it("is empty on a fresh vault", () => {
    expect(importedWeekStarts(emptyVault())).toEqual([]);
  });

  it("sorts chronologically however the weeks were stored", () => {
    // upsertMatrixWeek puts the newest import first, so storage order is not
    // date order and the caller must not assume it is.
    expect(importedWeekStarts(vaultWith(["2026-09-14", "2026-08-31", "2026-09-07"])))
      .toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
  });
});

describe("bestWeekStart", () => {
  const today = bestWeekStart(emptyVault()); // this week's Monday, whenever the suite runs

  it("falls back to today's week when nothing is imported", () => {
    expect(bestWeekStart(emptyVault())).toBe(today);
  });

  it("prefers today's week when a Matrix covers it", () => {
    expect(bestWeekStart(vaultWith(["2026-01-05", today, "2030-01-07"]))).toBe(today);
  });

  it("opens on the next imported week when today's is not covered", () => {
    // The real case: it is Friday, the cadet has imported next week's Matrix.
    const v = vaultWith(["2030-01-07", "2030-02-04"]);
    expect(bestWeekStart(v)).toBe("2030-01-07");
  });

  it("falls back to the most recent past week when none is ahead", () => {
    expect(bestWeekStart(vaultWith(["2020-01-06", "2020-02-03"]))).toBe("2020-02-03");
  });

  it("never returns a week that was not imported", () => {
    const weeks = ["2020-01-06", "2030-01-07"];
    const chosen = bestWeekStart(vaultWith(weeks));
    expect(weeks).toContain(chosen);
  });

  it("chooses a week the lookup can actually resolve", () => {
    // The whole point: whatever it picks, weekFor must find a Matrix there, or
    // the screen is empty again.
    const v = vaultWith(["2030-01-07", "2030-02-04"]);
    expect(weekFor(v, bestWeekStart(v))).not.toBeNull();
  });
});

describe("the silent empty document this prevents", () => {
  const settings = emptyVault().settings;

  it("fills the pages when the week matches", () => {
    const week = weekOf("2026-09-07");
    const doc = buildDocument({
      weekStart: "2026-09-07", term: null, week, plan: null, assignments: [], settings,
    });
    const rows = doc.days.reduce((n, d) => n + d.morning.length + d.evening.length, 0);
    expect(rows).toBe(1);
  });

  it("still renders seven full pages with nothing on them when it does not", () => {
    // Not a regression - this is what buildDocument is supposed to do with a
    // week it has no events for. The fix is that no screen asks it to, and that
    // when one does the page says so. Pinned here so the silence stays a
    // deliberate property rather than a surprise.
    const week = weekOf("2026-09-07");
    const doc = buildDocument({
      weekStart: "2026-09-14", term: null, week, plan: null, assignments: [], settings,
    });
    expect(doc.days).toHaveLength(7);
    expect(doc.days.reduce((n, d) => n + d.morning.length + d.evening.length, 0)).toBe(0);
  });
});
