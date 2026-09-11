import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { parseIcs, mergeAssignments } from "@/lib/ics";
import { readWorkbook, renderWorkbookForModel } from "@/lib/xlsx";
import { toMatrixWeek } from "@/lib/convert";
import { buildWeekInventory } from "@/lib/gaps";
import { materializePlan, auditPlan } from "@/lib/validate";
import { SettingsSchema, VaultSchema, type GeminiMatrixResponse, type GeminiPlanResponse, type Term } from "@/lib/schemas";
import { stamp } from "@/lib/time";

const MONDAY = "2026-09-07";
const settings = SettingsSchema.parse({});

/* ------------------------------------------------------- the source files */

async function matrixWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("MATRIX");
  ws.getCell("A1").value = "CORPS WEEKLY MATRIX — WEEK OF 07 SEP 2026";
  ws.mergeCells("A1:H1");
  ["TIME", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].forEach((h, i) => {
    ws.getCell(1 + i === 1 ? "A2" : String.fromCharCode(65 + i) + "2").value = h;
  });
  const rows: Array<[string, ...(string | null)[]]> = [
    ["0630", "BRC", "BRC", "BRC", "BRC", "BRC", null, null],
    ["0800", "CLASS", "CLASS", "CLASS", "CLASS", "CLASS", "SMI", null],
    ["1210", "DRC", "DRC", "DRC", "DRC", "DRC", null, null],
    ["1600", "CORPS ATHLETICS", "CORPS ATHLETICS", null, "PARADE", null, null, null],
    ["1815", "SRC", "SRC", "SRC", "SRC", "SRC", null, null],
    ["1930", "CQ", "CQ", "CQ", "CQ", null, null, "CQ"],
  ];
  rows.forEach((row, r) => {
    row.forEach((val, c) => {
      if (val) ws.getCell(String.fromCharCode(65 + c) + (r + 3)).value = val;
    });
  });
  return Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}

const CANVAS_FEED = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Instructure//Canvas//EN",
  "X-WR-CALNAME:Fall 2026 Courses",
  ...[
    ["Problem Set 4", "MATH-171-01", "20260909T035900Z"],
    ["Lab Report 2: Spectroscopy", "CHEM-141-03", "20260911T035900Z"],
    ["Reading: Chapter 7", "HI-104-02", "20260908T035900Z"],
    ["Midterm Exam 1", "MATH-171-01", "20260911T140000Z"],
    ["Essay Draft", "ERH-102-04", "20260914T035900Z"],
    ["Problem Set 5", "MATH-171-01", "20260916T035900Z"],
  ].flatMap(([title, code, dt], i) => [
    "BEGIN:VEVENT", `DTSTART:${dt}`, `SUMMARY:${title} [${code}]`,
    `UID:event-assignment-90${i}@vmi.instructure.com`,
    `URL:https://vmi.instructure.com/courses/1/assignments/90${i}`, "END:VEVENT",
  ]),
  "END:VCALENDAR",
].join("\r\n");

const term: Term = {
  id: "T-fall26", name: "Fall 2026", startDate: "2026-08-17", endDate: "2026-12-11",
  courses: [
    { id: "C1", code: "CHEM 141", title: "General Chemistry", instructor: "COL Reyes",
      meetings: [{ days: ["MO","WE","FR"], startMin: 480, endMin: 530, location: "MI 302" },
                 { days: ["TU"], startMin: 780, endMin: 900, location: "MI 110 (lab)" }] },
    { id: "C2", code: "MATH 171", title: "Calculus I", instructor: "LTC Hardin",
      meetings: [{ days: ["MO","WE","FR"], startMin: 540, endMin: 590, location: "MA 214" }] },
    { id: "C3", code: "HI 104", title: "Modern World History", instructor: "MAJ Okafor",
      meetings: [{ days: ["TU","TH"], startMin: 600, endMin: 675, location: "SC 121" }] },
    { id: "C4", code: "ERH 102", title: "Writing & Rhetoric", instructor: "Dr. Vance",
      meetings: [{ days: ["MO","WE"], startMin: 810, endMin: 860, location: "SH 205" }] },
  ],
};

/**
 * Stand in for Gemini with a deterministic planner.
 *
 * The point is not to test the model - it is to exercise every line of the real
 * pipeline the model's output flows through, with output we control, so a
 * regression in materializePlan shows up here rather than in production. It
 * spreads work across days the way the prompt asks Gemini to, so the fixture it
 * emits is representative rather than a pile on Monday.
 */
function fakeModelPlan(
  gaps: ReturnType<typeof buildWeekInventory>["gaps"],
  assignments: Array<{ id: string; dueDate: string; dueMin: number; estimateMinutes?: number }>,
): GeminiPlanResponse {
  const placements: GeminiPlanResponse["placements"] = [];
  const consumed = new Map<string, number>();
  const perDay = new Map<string, number>();
  const SITTING = 60;
  const DAILY_CAP = 180;

  for (const a of assignments) {
    const total = a.estimateMinutes ?? 90;
    let remaining = Math.ceil(total / SITTING) * SITTING;
    const usedDays = new Set<string>();

    while (remaining > 0) {
      const fit = gaps.find((g) => {
        if (stamp(g.date, g.endMin) > stamp(a.dueDate, a.dueMin)) return false;
        if (usedDays.has(g.date)) return false;                       // spread sittings
        if ((perDay.get(g.date) ?? 0) + SITTING > DAILY_CAP) return false;
        return g.minutes - (consumed.get(g.id) ?? 0) >= SITTING;
      });
      if (!fit) break;

      const offset = consumed.get(fit.id) ?? 0;
      placements.push({
        assignmentId: a.id, gapId: fit.id, offsetMin: offset, minutes: SITTING,
        rationale: "Earliest sitting that still clears the deadline.",
      });
      consumed.set(fit.id, offset + SITTING);
      perDay.set(fit.date, (perDay.get(fit.date) ?? 0) + SITTING);
      usedDays.add(fit.date);
      remaining -= SITTING;
    }
  }

  return {
    estimates: assignments.map((a) => ({
      assignmentId: a.id, estimateMinutes: a.estimateMinutes ?? 90, priority: 3,
      kind: "problem_set" as const,
    })),
    placements,
    unplaced: [],
    briefing: {
      prose: "Thursday is the pinch: parade eats the afternoon and the MATH 171 midterm lands Friday morning, so the only real preparation time is Tuesday and Wednesday CQ. The Chemistry lab report is the quiet risk - it is due Friday and nothing before Thursday touches it.",
      crunchPoints: ["Thursday 1530 parade removes the whole afternoon", "Friday 1000 midterm with no morning left to review"],
      risks: ["Leaving the lab report to Thursday CQ means writing it after parade, tired", "Two MATH deliverables land inside four days of each other"],
      sacrifice: "The Chapter 7 reading. It is graded on participation and you can carry the discussion from lecture notes.",
    },
  };
}

describe("end to end", () => {
  it("carries a real Matrix, a real Canvas feed and a plan all the way through", async () => {
    // 1. The Matrix spreadsheet, through the real extractor.
    const wb = await readWorkbook(await matrixWorkbook(), "MATRIX_WK03.xlsx");
    const rendered = renderWorkbookForModel(wb);
    expect(rendered).toContain("CORPS ATHLETICS");
    expect(rendered).toContain("MON");

    // 2. What Gemini would return for that grid, through the real ratchet.
    const modelMatrix: GeminiMatrixResponse = {
      weekStartDate: MONDAY,
      events: [
        ...(["MO","TU","WE","TH","FR"] as const).flatMap((day) => [
          { title: "BRC", raw: "BRC", day, start: "06:30", end: "07:00", kind: "formation" as const, availability: "BLOCKED" as const, confidence: 0.98 },
          { title: "DRC", raw: "DRC", day, start: "12:10", end: "12:40", kind: "formation" as const, availability: "BLOCKED" as const, confidence: 0.98 },
          { title: "SRC", raw: "SRC", day, start: "18:15", end: "18:45", kind: "formation" as const, availability: "BLOCKED" as const, confidence: 0.98 },
        ]),
        { title: "Corps Athletics", raw: "CORPS ATHLETICS", day: "MO", start: "16:00", end: "17:30", kind: "athletics", availability: "BLOCKED", confidence: 0.95 },
        { title: "Corps Athletics", raw: "CORPS ATHLETICS", day: "TU", start: "16:00", end: "17:30", kind: "athletics", availability: "BLOCKED", confidence: 0.95 },
        { title: "Parade", raw: "PARADE", day: "TH", start: "15:30", end: "17:30", kind: "parade", availability: "BLOCKED", confidence: 0.97 },
        { title: "SMI", raw: "SMI", day: "SA", start: "08:00", end: "10:00", kind: "inspection", availability: "BLOCKED", confidence: 0.96 },
        ...(["MO","TU","WE","TH","SU"] as const).map((day) => ({
          title: "CQ", raw: "CQ", day, start: "19:30", end: "22:30",
          kind: "study" as const, availability: "PARTIAL" as const, confidence: 0.93,
          note: "Call to Quarters — confined to room but this is the main study window.",
        })),
        // One the model is unsure about: the ratchet must force it to BLOCKED.
        { title: "Unit Function", raw: "UNIT FUNC?", day: "FR", start: "19:00", end: "21:00", kind: "other", availability: "USABLE", confidence: 0.42, note: "Cell text was ambiguous." },
      ],
    };
    const { week, ratchetedCount } = toMatrixWeek(modelMatrix, "MATRIX_WK03.xlsx", MONDAY);
    expect(ratchetedCount).toBe(1);
    expect(week.events.find((e) => e.title === "Unit Function")?.availability).toBe("BLOCKED");

    // 3. Canvas, through the real deterministic parser.
    const { assignments: fromCanvas } = parseIcs(CANVAS_FEED, settings.timezone);
    expect(fromCanvas).toHaveLength(6);
    const EFFORT: Record<string, number> = {
      "Problem Set 4": 90, "Lab Report 2: Spectroscopy": 180, "Reading: Chapter 7": 60,
      "Midterm Exam 1": 240, "Essay Draft": 150, "Problem Set 5": 90,
    };
    const { merged } = mergeAssignments([], fromCanvas);
    const assignments = merged.map((a) => ({ ...a, estimateMinutes: EFFORT[a.title] ?? 90 }));

    // 4. The gap inventory.
    const inventory = buildWeekInventory(MONDAY, term, week.events, settings);
    expect(inventory.gaps.length).toBeGreaterThan(10);

    // 5. A plan, through the real validator.
    const { plan, issues } = materializePlan({
      response: fakeModelPlan(inventory.gaps, assignments),
      inventory,
      assignments,
      nowStamp: stamp(MONDAY, 6 * 60),
    });
    expect(plan.blocks.length).toBeGreaterThan(8);
    expect(issues.filter((i) => i.severity === "dropped")).toHaveLength(0);
    // Work must be spread, not piled onto the first day with room.
    expect(new Set(plan.blocks.map((b) => b.date)).size).toBeGreaterThanOrEqual(4);

    // 6. The invariant that matters: nothing lands on an obligation.
    expect(auditPlan(plan, inventory, assignments)).toHaveLength(0);
    for (const block of plan.blocks) {
      const day = inventory.days.find((d) => d.date === block.date)!;
      for (const b of day.blocked) {
        expect(block.startMin < b.endMin && b.startMin < block.endMin).toBe(false);
      }
    }

    // Emit a seed so the UI can be inspected against real pipeline output.
    const vault = VaultSchema.parse({
      version: 1, settings, term, termHistory: [],
      matrixWeeks: [week], assignments, plans: [plan],
    });
    mkdirSync("test-output", { recursive: true });
    writeFileSync("test-output/seed.json", JSON.stringify(vault, null, 2));
  });
});
