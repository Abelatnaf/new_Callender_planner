/**
 * The printed week's arithmetic.
 *
 * A printed page is the last place a mistake can be caught: on screen a wrong
 * figure is one refresh from being fixed, on paper it goes to a formation. So
 * every number the document shows is derived in a pure module and checked here.
 */
import { describe, expect, it } from "vitest";
import { buildDayPage, buildDocument, auditLines, uniformFor } from "@/lib/document";
import { SettingsSchema, type Assignment, type MatrixEvent, type MatrixWeek, type Term } from "@/lib/schemas";
import { ev } from "./fixtures/week";

const settings = SettingsSchema.parse({});
const MON = "2026-09-07";
const TUE = "2026-09-08";

const term: Term = {
  id: "T1", name: "Fall 2026", startDate: "2026-08-17", endDate: "2026-12-11",
  termHistory: undefined as never,
  courses: [
    { id: "C1", code: "CIS 111", title: "Programming I", credits: 3, instructor: "Dr. Park",
      meetings: [{ days: ["MO", "WE", "FR"], startMin: 600, endMin: 650, location: "Mallory 314" }] },
    { id: "C2", code: "HI 103", title: "World History I", credits: 3,
      meetings: [{ days: ["TU", "TH"], startMin: 565, endMin: 640, location: "Scott Shipp 368" }] },
  ],
} as unknown as Term;

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "A1", title: "Problem Set 4", courseCode: "CIS 111", dueDate: TUE, dueMin: 480,
  kind: "problem_set", status: "todo", source: "canvas", ...over,
});

const page = (events: MatrixEvent[], blocks: Parameters<typeof buildDayPage>[0]["blocks"] = [], assignments: Assignment[] = []) =>
  buildDayPage({ date: MON, term, events, blocks, assignments, settings });

describe("the masthead", () => {
  it("carries the weekday, the numeral and the month", () => {
    const p = page([]);
    expect(p.weekday).toBe("MONDAY");
    expect(p.numeral).toBe("7");
    expect(p.monthLabel).toBe("SEPTEMBER 7, 2026");
  });

  it("drops the leading zero from the numeral, as a 48pt figure should", () => {
    expect(buildDayPage({ date: "2026-09-07", term, events: [], blocks: [], assignments: [], settings }).numeral).toBe("7");
    expect(buildDayPage({ date: "2026-09-21", term, events: [], blocks: [], assignments: [], settings }).numeral).toBe("21");
  });

  it("counts the day's classes and their minutes", () => {
    const p = page([]);            // Monday: CIS 111 only, 600-650
    expect(p.pills[0].label).toBe("1 class");
    expect(p.pills[0].value).toBe("50M");
    expect(p.classMinutes).toBe(50);
  });

  it("splits free time into what is planned and what is left", () => {
    const blocks = [{ id: "B1", assignmentId: "A1", gapId: "G1", date: MON, startMin: 1200, endMin: 1320, locked: false, done: false }];
    const p = page([], blocks, [assignment()]);
    expect(p.pills[1]).toEqual({ label: "study", value: "2H" });
    expect(p.studyMinutes).toBe(120);
    // open is whatever the day had free, less what was planned into it.
    expect(p.pills[2].label).toBe("open");
  });
});

describe("the uniform", () => {
  it("is rolled up from the day's own rows", () => {
    expect(uniformFor([{ ...ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"), uniform: "Class Dyke" }])).toBe("Class Dyke");
  });

  it("joins genuinely different uniforms rather than picking one", () => {
    // A day with both a parade and PT really does say two things.
    const rows = [
      { ...ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"), uniform: "Class Dyke" },
      { ...ev("M2", "Corps PT", MON, 990, 1110, "athletics", "BLOCKED"), uniform: "Gym Dyke" },
    ];
    expect(uniformFor(rows)).toBe("Class Dyke | Gym Dyke");
  });

  it("does not repeat one that differs only in case", () => {
    const rows = [
      { ...ev("M1", "A", MON, 420, 440, "formation", "BLOCKED"), uniform: "Class Dyke" },
      { ...ev("M2", "B", MON, 500, 520, "formation", "BLOCKED"), uniform: "class dyke" },
    ];
    expect(uniformFor(rows)).toBe("Class Dyke");
  });

  it("ignores a dash, which the Matrix uses for no uniform", () => {
    expect(uniformFor([{ ...ev("M1", "Taps", MON, 1410, 1430, "other", "BLOCKED"), uniform: "-" }])).toBe("");
  });

  it("ignores somebody else's row", () => {
    const rows = [{ ...ev("M1", "Band", MON, 1140, 1260, "other", "BLOCKED"), uniform: "Band Blouse", appliesToMe: false }];
    expect(uniformFor(rows)).toBe("");
  });
});

describe("the two columns", () => {
  it("splits at noon", () => {
    const p = page([
      ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"),
      ev("M2", "SRC", MON, 1140, 1160, "formation", "BLOCKED"),
    ]);
    expect(p.morning.map((r) => r.title)).toContain("BRC");
    expect(p.evening.map((r) => r.title)).toContain("SRC");
    expect(p.morning.map((r) => r.title)).not.toContain("SRC");
  });

  it("prints classes, Matrix rows and study blocks together, in time order", () => {
    const blocks = [{ id: "B1", assignmentId: "A1", gapId: "G1", date: MON, startMin: 1200, endMin: 1320, locked: false, done: false }];
    const p = page([ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED")], blocks, [assignment()]);
    const all = [...p.morning, ...p.evening];
    expect(all.map((r) => r.kind)).toEqual(["matrix", "class", "study"]);
    expect(all.map((r) => r.startMin)).toEqual([420, 600, 1200]);
  });

  it("keeps somebody else's row visible and marked", () => {
    // Seeing WHY an hour is free matters as much as seeing that it is.
    const p = page([{ ...ev("M1", "Band Practice", MON, 1140, 1260, "other", "BLOCKED"), pax: "Band", appliesToMe: false }]);
    const row = [...p.morning, ...p.evening].find((r) => r.title === "Band Practice");
    expect(row?.mine).toBe(false);
    expect(row?.pax).toBe("Band");
  });

  it("prints an invented end as an instant rather than a span", () => {
    const p = page([{ ...ev("M1", "SRC", MON, 1140, 1160, "formation", "BLOCKED"), endEstimated: true }]);
    expect(p.evening.find((r) => r.title === "SRC")?.time).toBe("1900");
  });

  it("prints a real span as a span", () => {
    const p = page([ev("M1", "CQ", MON, 1170, 1350, "study", "PARTIAL")]);
    expect(p.evening.find((r) => r.title === "CQ")?.time).toBe("1930-2230");
  });

  it("carries the location through to the page", () => {
    const p = page([{ ...ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"), location: "Crozet" }]);
    expect(p.morning.find((r) => r.title === "BRC")?.location).toBe("Crozet");
  });

  it("names the task on a study block, never the word study", () => {
    const blocks = [{ id: "B1", assignmentId: "A1", gapId: "G1", date: MON, startMin: 1200, endMin: 1320, locked: false, done: false }];
    const p = page([], blocks, [assignment({ title: "Finish Problem Set 4" })]);
    const row = p.evening.find((r) => r.kind === "study");
    expect(row?.title).toBe("Finish Problem Set 4");
    expect(row?.title.toLowerCase()).not.toBe("study");
  });
});

describe("the cautions", () => {
  it("says how many times were estimated", () => {
    const p = page([
      { ...ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"), endEstimated: true },
      { ...ev("M2", "SRC", MON, 1140, 1160, "formation", "BLOCKED"), endEstimated: true },
    ]);
    expect(p.cautions.join(" ")).toMatch(/2 times below are estimates/);
  });

  it("says when the model was overruled toward busy", () => {
    const p = page([{ ...ev("M1", "Unit Function", MON, 1140, 1260, "other", "BLOCKED"), ratcheted: true }]);
    expect(p.cautions.join(" ")).toMatch(/more time than this page shows/);
  });

  it("says nothing when there is nothing to distrust", () => {
    expect(page([ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED")]).cautions).toEqual([]);
  });
});

describe("top three", () => {
  it("follows the order the day will actually happen in", () => {
    const blocks = [
      { id: "B2", assignmentId: "A2", gapId: "G1", date: MON, startMin: 1300, endMin: 1360, locked: false, done: false },
      { id: "B1", assignmentId: "A1", gapId: "G1", date: MON, startMin: 1200, endMin: 1260, locked: false, done: false },
    ];
    const p = page([], blocks, [assignment(), assignment({ id: "A2", title: "Essay Draft" })]);
    expect(p.topThree.map((t) => t.title)).toEqual(["Problem Set 4", "Essay Draft"]);
    expect(p.topThree[0].rank).toBe(1);
  });

  it("never lists more than three", () => {
    const blocks = [1, 2, 3, 4, 5].map((i) => ({
      id: `B${i}`, assignmentId: `A${i}`, gapId: "G1", date: MON,
      startMin: 1100 + i * 30, endMin: 1120 + i * 30, locked: false, done: false,
    }));
    const p = page([], blocks, [1, 2, 3, 4, 5].map((i) => assignment({ id: `A${i}`, title: `Task ${i}` })));
    expect(p.topThree).toHaveLength(3);
  });

  it("falls back to the nearest deadlines when nothing is planned", () => {
    const p = page([], [], [assignment({ dueDate: MON, title: "Due today" })]);
    expect(p.topThree.map((t) => t.title)).toEqual(["Due today"]);
  });
});

/* ----------------------------------------------------------- whole week */

const week = (events: MatrixEvent[]): MatrixWeek => ({
  id: "MW", weekStart: MON, events,
  audit: { rowsReturned: 40, rowsKept: 38, rowsSkipped: 2, notMine: 20, ratcheted: 3,
           endsEstimated: 33, cellsBefore: 8336, cellsAfter: 2204, model: "gemini-2.5-flash" },
  source: { filename: "Week03.csv", importedAt: "2026-09-07T10:00:00Z" },
});

const doc = (over: Partial<Parameters<typeof buildDocument>[0]> = {}) =>
  buildDocument({ weekStart: MON, term, week: null, plan: null, assignments: [], settings, ...over });

describe("the whole document", () => {
  it("has one page per day", () => {
    expect(doc().days).toHaveLength(7);
    expect(doc().days.map((d) => d.weekday)).toEqual(
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"],
    );
  });

  it("flags the heaviest class day, and only that one", () => {
    // Tuesday has HI 103 (75m); Monday has CIS 111 (50m).
    const tagged = doc().days.filter((d) => d.tag);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].date).toBe(TUE);
    expect(tagged[0].tag).toBe("HEAVIEST CLASS DAY");
  });

  it("flags nothing in a week with no classes at all", () => {
    expect(doc({ term: null }).days.every((d) => d.tag === null)).toBe(true);
  });

  it("totals credits and weekly contact time", () => {
    const d = doc();
    expect(d.totalCredits).toBe(6);
    // CIS 111 three times at 50m, HI 103 twice at 75m.
    expect(d.weeklyClassMinutes).toBe(3 * 50 + 2 * 75);
  });

  it("writes each course's meeting pattern the way a schedule states it", () => {
    expect(doc().courses[0].pattern).toBe("MOWEFR 1000-1050");
  });

  it("groups the horizon by date and counts what falls past it", () => {
    const near = assignment({ id: "N1", dueDate: "2026-09-17", title: "Draft" });
    const also = assignment({ id: "N2", dueDate: "2026-09-17", title: "Quiz #2" });
    const far = assignment({ id: "F1", dueDate: "2026-12-01", title: "Final paper" });
    const d = doc({ assignments: [near, also, far] });
    expect(d.horizon).toHaveLength(1);
    expect(d.horizon[0].items.map((i) => i.title)).toEqual(["Draft", "Quiz #2"]);
    expect(d.beyondHorizon).toBe(1);
  });

  it("does not put this week's deadlines on the horizon page", () => {
    expect(doc({ assignments: [assignment({ dueDate: TUE })] }).horizon).toHaveLength(0);
  });
});

describe("the study plan", () => {
  const blocks = [
    { id: "B1", assignmentId: "A1", gapId: "G1", date: MON, startMin: 1200, endMin: 1320, locked: false, done: false },
    { id: "B2", assignmentId: "A1", gapId: "G2", date: TUE, startMin: 1200, endMin: 1260, locked: false, done: false },
    { id: "B3", assignmentId: "A2", gapId: "G3", date: TUE, startMin: 1300, endMin: 1330, locked: false, done: false },
  ];
  const plan = { id: "P", weekStart: MON, blocks, unplaced: [], createdAt: "", briefing: { prose: "" } } as never;
  const assignments = [assignment(), assignment({ id: "A2", courseCode: "HI 103", title: "Reading" })];

  it("totals hours per course and the days they land on", () => {
    const s = doc({ plan, assignments }).study;
    expect(s.perCourse[0]).toEqual({ code: "CIS 111", title: "Programming I", minutes: 180, days: 2 });
    expect(s.perCourse[1]).toEqual({ code: "HI 103", title: "World History I", minutes: 30, days: 1 });
  });

  it("counts every block and every minute", () => {
    const s = doc({ plan, assignments }).study;
    expect(s.blockCount).toBe(3);
    expect(s.totalMinutes).toBe(210);
  });

  it("reports the share of free time it spends", () => {
    const s = doc({ plan, assignments }).study;
    expect(s.sharePct).toBeGreaterThan(0);
    expect(s.sharePct).toBeLessThanOrEqual(100);
  });

  it("lists every session under its day", () => {
    const s = doc({ plan, assignments }).study;
    const tue = s.sessions.find((x) => x.date === TUE);
    expect(tue?.blocks.map((b) => b.time)).toEqual(["2000", "2140"]);
    expect(tue?.blocks[0].course).toBe("CIS 111");
  });

  it("gives a daily load figure for all seven days, planned or not", () => {
    const s = doc({ plan, assignments }).study;
    expect(s.dailyLoad).toHaveLength(7);
    expect(s.dailyLoad.find((d) => d.date === MON)?.studyMinutes).toBe(120);
    expect(s.dailyLoad.find((d) => d.date === "2026-09-13")?.studyMinutes).toBe(0);
  });

  it("does not divide by zero in a week with no free time", () => {
    expect(doc().study.sharePct).toBe(0);
  });
});

describe("the audit", () => {
  it("states the trim, the filtering and the guesses in one sentence", () => {
    const line = auditLines(week([]), [], []).join(" ");
    expect(line).toMatch(/8,336 spreadsheet cells trimmed to 2,204/);
    expect(line).toMatch(/20 source rows filtered out as not applying to you/);
    expect(line).toMatch(/33 times estimated because the Matrix gives no end time/);
    expect(line).toMatch(/3 marked mandatory/);
    expect(line).toMatch(/2 rows unreadable/);
  });

  it("names the model that answered and the file it read", () => {
    const line = auditLines(week([]), [], []).join(" ");
    expect(line).toMatch(/Read by gemini-2\.5-flash/);
    expect(line).toMatch(/Source: Week03\.csv/);
  });

  it("counts the classifications the cadet overrode", () => {
    const w = week([{ ...ev("M1", "BRC", MON, 420, 440, "formation", "BLOCKED"), confirmedByUser: true }]);
    expect(auditLines(w, [], []).join(" ")).toMatch(/1 classification overridden by you/);
  });

  it("says plainly when there was no Matrix at all", () => {
    expect(auditLines(null, [], []).join(" ")).toMatch(/No Matrix was loaded/);
  });
});
