import { describe, expect, it } from "vitest";
import { buildWeekInventory, type WeekInventory } from "@/lib/gaps";
import { REASONS, auditPlan, materializePlan } from "@/lib/validate";
import { stamp } from "@/lib/time";
import type { GeminiPlanResponse } from "@/lib/schemas";
import { MONDAY, assignments, matrixEvents, settings, term } from "./fixtures/week";

const inventory = buildWeekInventory(MONDAY, term, matrixEvents, settings);
const NOW = stamp(MONDAY, 6 * 60); // Monday 0600, start of the week

const briefing = { prose: "", crunchPoints: [], risks: [] };

function respond(p: Partial<GeminiPlanResponse>): GeminiPlanResponse {
  return { estimates: [], placements: [], unplaced: [], briefing, ...p };
}

/** The first gap on Monday long enough to hold `minutes`. */
function gapFor(minutes: number, date = MONDAY) {
  const g = inventory.gaps.find((x) => x.date === date && x.minutes >= minutes);
  if (!g) throw new Error(`no gap >= ${minutes}min on ${date}`);
  return g;
}

describe("materializePlan - happy path", () => {
  it("places a block and re-derives its real clock times", () => {
    const gap = gapFor(60);
    const { plan, issues } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({
      assignmentId: "A2", gapId: gap.id, date: gap.date,
      startMin: gap.startMin, endMin: gap.startMin + 60,
    });
    expect(issues.filter((i) => i.severity === "dropped")).toHaveLength(0);
  });

  it("honours the model's offset inside the gap", () => {
    const gap = gapFor(120);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 30, minutes: 45 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    const start = plan.blocks[0].startMin;
    expect(start % 15).toBe(0);                          // sits on the clock grid
    expect(start).toBeGreaterThanOrEqual(gap.startMin + 30); // no earlier than asked
    expect(start).toBeLessThan(gap.endMin);
  });

  it("snaps ragged model durations onto the 15-minute grid", () => {
    const gap = gapFor(120);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 47 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks[0].endMin - plan.blocks[0].startMin).toBe(45);
  });
});

describe("materializePlan - rejections", () => {
  it("refuses a block that would finish after the deadline", () => {
    // A3 (reading) is due Monday 1330; find a gap that starts after that.
    const late = inventory.gaps.find((g) => g.date === MONDAY && g.startMin >= 900)!;
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A3", gapId: late.id, offsetMin: 0, minutes: 30 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unplaced[0]).toMatchObject({ assignmentId: "A3", reason: REASONS.PAST_DEADLINE });
  });

  it("refuses a gap id it was never given", () => {
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: "G-NONSENSE-99", offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.unplaced[0].reason).toBe(REASONS.NO_SUCH_GAP);
  });

  it("refuses an assignment that is not in the backlog", () => {
    const gap = gapFor(60);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "GHOST", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.unplaced[0].reason).toBe(REASONS.NO_SUCH_ASSIGNMENT);
  });

  it("refuses to schedule work that has already elapsed", () => {
    const gap = gapFor(60);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments,
      nowStamp: stamp("2026-09-11", 12 * 60), // it is now Friday noon
    });
    expect(plan.unplaced[0].reason).toBe(REASONS.IN_THE_PAST);
  });

  it("refuses work on an assignment already marked done", () => {
    const gap = gapFor(60);
    const done = assignments.map((a) => (a.id === "A2" ? { ...a, status: "done" as const } : a));
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments: done, nowStamp: NOW,
    });
    expect(plan.unplaced[0].reason).toBe(REASONS.ALREADY_DONE);
  });
});

describe("the obligation guard", () => {
  it("drops a block whose gap secretly overlaps an obligation", () => {
    // Hand-build a corrupt inventory: a gap sitting on top of a parade. This is
    // the failure mode the guard exists for - the printed page must never send
    // the cadet to study during a formation.
    const corrupt: WeekInventory = {
      weekStart: MONDAY,
      days: [{
        date: MONDAY,
        blocked: [{ startMin: 600, endMin: 720 }], // parade 1000-1200
        roomBound: [],
        gaps: [{ id: "G-BAD", date: MONDAY, startMin: 600, endMin: 720, minutes: 120, quality: "OPEN" }],
        freeMinutes: 120,
      }],
      gaps: [{ id: "G-BAD", date: MONDAY, startMin: 600, endMin: 720, minutes: 120, quality: "OPEN" }],
      freeMinutes: 120,
    };
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: "G-BAD", offsetMin: 0, minutes: 60 }],
      }),
      inventory: corrupt, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unplaced[0].reason).toBe(REASONS.COLLIDES_WITH_OBLIGATION);
  });

  it("drops a locked user block that collides with an obligation", () => {
    const { plan } = materializePlan({
      response: respond({}),
      inventory, assignments, nowStamp: NOW,
      locked: [{
        id: "L1", assignmentId: "A2", gapId: "manual", date: MONDAY,
        startMin: 480, endMin: 540, locked: true, // 0800-0900 is CHEM 141
      }],
    });
    expect(plan.blocks).toHaveLength(0);
    expect(plan.unplaced[0].reason).toBe(REASONS.COLLIDES_WITH_OBLIGATION);
  });
});

describe("collision between work blocks", () => {
  it("shifts the second block rather than double-booking", () => {
    const gap = gapFor(180);
    const { plan, issues } = materializePlan({
      response: respond({
        placements: [
          { assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 60 },
          { assignmentId: "A1", gapId: gap.id, offsetMin: 0, minutes: 60 },
        ],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(2);
    const [a, b] = plan.blocks;
    expect(a.endMin).toBeLessThanOrEqual(b.startMin);
    expect(issues.some((i) => i.severity === "adjusted")).toBe(true);
  });

  it("gives up when the gap genuinely cannot hold both", () => {
    const gap = gapFor(60);
    const { plan } = materializePlan({
      response: respond({
        placements: [
          { assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: gap.minutes },
          { assignmentId: "A1", gapId: gap.id, offsetMin: 0, minutes: 60 },
        ],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(1);
    expect(plan.unplaced[0].reason).toBe(REASONS.NO_ROOM_LEFT);
  });

  it("clamps a block that is longer than its gap", () => {
    const gap = gapFor(30);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 9999 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(plan.blocks[0].endMin - plan.blocks[0].startMin).toBeLessThanOrEqual(gap.minutes);
  });

  it("keeps locked blocks and plans around them", () => {
    const gap = gapFor(180);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A1", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments, nowStamp: NOW,
      locked: [{
        id: "L1", assignmentId: "A2", gapId: gap.id, date: gap.date,
        startMin: gap.startMin, endMin: gap.startMin + 60, locked: true,
      }],
    });
    expect(plan.blocks).toHaveLength(2);
    expect(plan.blocks.find((b) => b.id === "L1")?.locked).toBe(true);
    expect(plan.blocks.every((b, i, all) => i === 0 || all[i - 1].endMin <= b.startMin)).toBe(true);
  });
});

describe("grid alignment never escapes its gap", () => {
  // Regression: snapping a start to the clock grid could round it earlier than
  // the gap began, putting the block on top of the class that closed the gap.
  it("keeps every block inside its own gap for every gap in the week", () => {
    for (const gap of inventory.gaps) {
      const { plan } = materializePlan({
        response: respond({
          placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 15 }],
        }),
        inventory, assignments, nowStamp: NOW,
      });
      for (const b of plan.blocks) {
        expect(b.startMin).toBeGreaterThanOrEqual(gap.startMin);
        expect(b.endMin).toBeLessThanOrEqual(gap.endMin);
      }
    }
  });

  it("hugs the gap edge rather than losing a slot to alignment", () => {
    // A gap running 0947-1017 has no 15-minute grid start that fits 30 minutes,
    // so the block must fall back to the exact edge instead of going unplaced.
    const tight: WeekInventory = {
      weekStart: MONDAY,
      days: [{ date: MONDAY, blocked: [], roomBound: [], freeMinutes: 30,
        gaps: [{ id: "G-TIGHT", date: MONDAY, startMin: 587, endMin: 617, minutes: 30, quality: "OPEN" }] }],
      gaps: [{ id: "G-TIGHT", date: MONDAY, startMin: 587, endMin: 617, minutes: 30, quality: "OPEN" }],
      freeMinutes: 30,
    };
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: "G-TIGHT", offsetMin: 0, minutes: 30 }],
      }),
      inventory: tight, assignments, nowStamp: NOW,
    });
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0].startMin).toBe(587);
  });
});

describe("auditPlan", () => {
  it("passes a plan built by the materializer", () => {
    const gap = gapFor(60);
    const { plan } = materializePlan({
      response: respond({
        placements: [{ assignmentId: "A2", gapId: gap.id, offsetMin: 0, minutes: 60 }],
      }),
      inventory, assignments, nowStamp: NOW,
    });
    expect(auditPlan(plan, inventory, assignments)).toHaveLength(0);
  });

  it("catches a hand-edited block that was dragged onto a formation", () => {
    const plan = {
      id: "P", weekStart: MONDAY, generatedAt: "", briefing, unplaced: [],
      blocks: [{
        id: "B1", assignmentId: "A2", gapId: "x", date: MONDAY,
        startMin: 390, endMin: 420, locked: true, // BRC
      }],
    };
    const problems = auditPlan(plan, inventory, assignments);
    expect(problems.some((p) => p.reason === REASONS.COLLIDES_WITH_OBLIGATION)).toBe(true);
  });
});
