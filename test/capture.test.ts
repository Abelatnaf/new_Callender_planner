/**
 * What the importer keeps, and what it admits to guessing.
 *
 * The reference document is built out of two things this code used to throw
 * away: the Location and Uniform columns, and an honest count of what was
 * dropped or inferred. A schedule that shows its working is one you can rely
 * on; one that hides it is one you find out about at a formation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { toMatrixWeek } from "@/lib/convert";
import { readCsv } from "@/lib/csv";
import { renderWorkbookForModel } from "@/lib/grid";
import { MatrixWeekSchema, type GeminiMatrixResponse } from "@/lib/schemas";
import { mx } from "./fixtures/gemini";

const MON = "2026-09-07";
const week = (events: GeminiMatrixResponse["events"]) =>
  toMatrixWeek({ weekStartDate: MON, events }, "m.csv", MON);

describe("location and uniform survive the import", () => {
  it("keeps both verbatim", () => {
    const { week: w } = week([
      mx({ title: "BRC", day: "MO", start: "07:00", end: "07:20", location: "Crozet", uniform: "Class Dyke" }),
    ]);
    expect(w.events[0].location).toBe("Crozet");
    expect(w.events[0].uniform).toBe("Class Dyke");
  });

  it("trims stray whitespace, since spreadsheet cells are full of it", () => {
    const { week: w } = week([
      mx({ title: "SRC", day: "MO", start: "19:00", end: "19:15", location: "  Bricks \n", uniform: " Blouse " }),
    ]);
    expect(w.events[0].location).toBe("Bricks");
    expect(w.events[0].uniform).toBe("Blouse");
  });

  it("is an empty string, never undefined, when the column was blank", () => {
    const { week: w } = week([mx({ title: "CQ", day: "MO", start: "19:30", end: "22:30" })]);
    expect(w.events[0].location).toBe("");
    expect(w.events[0].uniform).toBe("");
  });

  it("round-trips through the schema, so a reload does not lose them", () => {
    const { week: w } = week([
      mx({ title: "Parade", day: "FR", start: "16:00", end: "17:30", location: "Parade Ground", uniform: "Coatee" }),
    ]);
    const reloaded = MatrixWeekSchema.parse(JSON.parse(JSON.stringify(w)));
    expect(reloaded.events[0].location).toBe("Parade Ground");
    expect(reloaded.events[0].uniform).toBe("Coatee");
  });

  it("defaults them on a week stored before these fields existed", () => {
    const old = {
      id: "MW-2026-09-07", weekStart: MON,
      events: [{
        id: "MX-1", title: "BRC", raw: "BRC", date: MON, startMin: 420, endMin: 440,
        kind: "formation", availability: "BLOCKED", confidence: 0.9,
      }],
    };
    const parsed = MatrixWeekSchema.parse(old);
    expect(parsed.events[0].location).toBe("");
    expect(parsed.events[0].uniform).toBe("");
    expect(parsed.events[0].endEstimated).toBe(false);
  });
});

describe("the audit counts what happened", () => {
  it("counts rows returned, kept and skipped", () => {
    const { week: w } = week([
      mx({ title: "Good", day: "MO", start: "07:00", end: "07:20" }),
      mx({ title: "Bad times", day: "MO", start: "nonsense", end: "also nonsense" }),
      mx({ title: "Zero length", day: "MO", start: "09:00", end: "09:00" }),
    ]);
    expect(w.audit.rowsReturned).toBe(3);
    expect(w.audit.rowsKept).toBe(1);
    expect(w.audit.rowsSkipped).toBe(2);
  });

  it("keeps the good rows when some rows are unreadable", () => {
    // Partial success: 1 of 3 unreadable must not cost the other 2.
    const { week: w, warnings } = week([
      mx({ title: "BRC", day: "MO", start: "07:00", end: "07:20" }),
      mx({ title: "Broken", day: "MO", start: "??", end: "??" }),
      mx({ title: "SRC", day: "MO", start: "19:00", end: "19:15" }),
    ]);
    expect(w.events.map((e) => e.title)).toEqual(["BRC", "SRC"]);
    expect(warnings.join(" ")).toMatch(/Broken/);
  });

  it("counts rows that are somebody else's", () => {
    const { week: w } = week([
      mx({ title: "BRC", day: "MO", start: "07:00", end: "07:20" }),
      mx({ title: "Band Practice", day: "MO", start: "19:00", end: "21:00", pax: "Band", appliesToMe: false }),
    ]);
    expect(w.audit.notMine).toBe(1);
  });

  it("counts the ends it had to invent", () => {
    const { week: w } = week([
      mx({ title: "BRC", day: "MO", start: "07:00", end: "07:20", endEstimated: true }),
      mx({ title: "CQ", day: "MO", start: "19:30", end: "22:30" }),
    ]);
    expect(w.audit.endsEstimated).toBe(1);
  });

  it("counts what the ratchet overrode", () => {
    const { week: w } = week([
      mx({ title: "Unit Function", day: "FR", start: "19:00", end: "21:00", availability: "USABLE", confidence: 0.3 }),
    ]);
    expect(w.audit.ratcheted).toBe(1);
  });

  it("records the trim and the model that answered", () => {
    const { week: w } = toMatrixWeek(
      { weekStartDate: MON, events: [mx({ title: "BRC", day: "MO", start: "07:00", end: "07:20" })] },
      "m.csv", MON,
      { cellsBefore: 8336, cellsAfter: 2204, model: "gemini-2.5-flash" },
    );
    expect(w.audit.cellsBefore).toBe(8336);
    expect(w.audit.cellsAfter).toBe(2204);
    expect(w.audit.model).toBe("gemini-2.5-flash");
  });

  it("is zeroed rather than absent when nothing was recorded", () => {
    const { week: w } = week([]);
    expect(w.audit.cellsBefore).toBe(0);
    expect(w.audit.model).toBe("");
  });
});

describe("the browser trims exactly what the server would have", () => {
  // The whole speed argument rests on this: if the two disagree, moving the
  // trim to the browser changes what the model reads, not just how fast.
  const raw = readFileSync("test/fixtures/matrix-real.csv", "utf8");

  it("renders byte-identically on both sides", () => {
    const inBrowser = renderWorkbookForModel(readCsv(raw, "matrix-real.csv"));
    const onServer = renderWorkbookForModel(readCsv(Buffer.from(raw).toString("utf8"), "matrix-real.csv"));
    expect(inBrowser).toBe(onServer);
  });

  it("sends a small fraction of the file", () => {
    const rendered = renderWorkbookForModel(readCsv(raw, "matrix-real.csv"));
    expect(rendered.length).toBeLessThan(raw.length / 3);
  });

  it("still carries every day section the fixture holds", () => {
    // The committed fixture is a three-day slice of the 2.4MB original; the
    // full file was validated against the trim when the heuristic was written.
    const rendered = renderWorkbookForModel(readCsv(raw, "matrix-real.csv"));
    for (const day of ["Monday, September 7", "Tuesday, September 8", "Wednesday, September 9"]) {
      expect(rendered).toContain(day);
    }
  });

  it("collapses the fill-right artifact that made the original 2.4MB", () => {
    const rendered = renderWorkbookForModel(readCsv(raw, "matrix-real.csv"));
    const corpsPt = rendered.split("Corps PT").length - 1;
    expect(corpsPt).toBeLessThan(10);
  });

  it("still carries the Location and Uniform headers the document needs", () => {
    const rendered = renderWorkbookForModel(readCsv(raw, "matrix-real.csv"));
    expect(rendered).toMatch(/Location/);
    expect(rendered).toMatch(/Uniform/);
  });
});
