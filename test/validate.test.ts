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
        startMin: 480, endMin: 540, locked: true, done: false, // 0800-0900 is CHEM 141
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
        startMin: gap.startMin, endMin: gap.startMin + 60, locked: true, done: false,
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
        startMin: 390, endMin: 420, locked: true, done: false, // BRC
      }],
    };
    const problems = auditPlan(plan, inventory, assignments);
    expect(problems.some((p) => p.reason === REASONS.COLLIDES_WITH_OBLIGATION)).toBe(true);
  });
});

/* ===========================================================================
   Hand edits must be exactly as safe as the model's placements. Before
   checkPlacement was extracted, the rules lived inline in materializePlan and
   any editing feature would have bypassed them entirely.
   =========================================================================== */

import { checkPlacement, moveBlock, resizeBlock } from "@/lib/validate";
import { MIN_BLOCK } from "@/lib/time";
import type { WorkBlock } from "@/lib/schemas";

const ctxFor = (others: WorkBlock[] = []) => ({ inventory, others, nowStamp: NOW });

/** A real block sitting in the first Monday gap big enough to hold an hour. */
function blockInGap(minutes = 60, assignmentId = "A2"): WorkBlock {
  const gap = gapFor(minutes);
  return {
    id: "B-001", assignmentId, gapId: gap.id, date: gap.date,
    startMin: gap.startMin, endMin: gap.startMin + minutes, locked: false, done: false,
  };
}

const A2 = assignments.find((a) => a.id === "A2")!;

describe("checkPlacement", () => {
  it("accepts a block sitting in real free time", () => {
    const b = blockInGap();
    expect(checkPlacement({ ...b, assignment: A2, ctx: ctxFor() })).toEqual({ ok: true });
  });

  it("refuses work on an assignment already done", () => {
    const b = blockInGap();
    const r = checkPlacement({ ...b, assignment: { ...A2, status: "done" }, ctx: ctxFor() });
    expect(r).toMatchObject({ ok: false, reason: REASONS.ALREADY_DONE });
  });

  it("refuses anything shorter than the minimum useful block", () => {
    const b = blockInGap();
    const r = checkPlacement({ ...b, endMin: b.startMin + MIN_BLOCK - 1, assignment: A2, ctx: ctxFor() });
    expect(r).toMatchObject({ ok: false, reason: REASONS.TOO_SHORT });
  });

  it("refuses a slot that has already elapsed", () => {
    const b = blockInGap();
    const r = checkPlacement({
      ...b, assignment: A2,
      ctx: { inventory, others: [], nowStamp: stamp("2026-09-12", 12 * 60) },
    });
    expect(r).toMatchObject({ ok: false, reason: REASONS.IN_THE_PAST });
  });

  it("refuses a block that would finish after the deadline", () => {
    const b = blockInGap();
    const r = checkPlacement({
      ...b, assignment: { ...A2, dueDate: MONDAY, dueMin: b.startMin },
      ctx: ctxFor(),
    });
    expect(r).toMatchObject({ ok: false, reason: REASONS.PAST_DEADLINE });
  });

  it("refuses a block sitting on a formation", () => {
    // BRC runs 0630-0700 on the Monday fixture.
    const r = checkPlacement({
      date: MONDAY, startMin: 390, endMin: 420, assignment: A2, ctx: ctxFor(),
    });
    expect(r).toMatchObject({ ok: false, reason: REASONS.COLLIDES_WITH_OBLIGATION });
  });

  it("refuses a block outside the waking day", () => {
    // After the day window closes at 2300, and still in the future so that the
    // past-slot rule cannot be the one doing the refusing.
    const r = checkPlacement({
      date: MONDAY, startMin: 23 * 60 + 15, endMin: 23 * 60 + 45, assignment: A2, ctx: ctxFor(),
    });
    expect(r).toMatchObject({ ok: false, reason: REASONS.COLLIDES_WITH_OBLIGATION });
  });

  it("refuses landing on top of another work block", () => {
    const b = blockInGap();
    const r = checkPlacement({ ...b, assignment: A2, ctx: ctxFor([{ ...b, id: "OTHER" }]) });
    expect(r).toMatchObject({ ok: false, reason: REASONS.OVERLAPS_WORK });
  });

  it("does not count the block being moved as its own obstacle", () => {
    const b = blockInGap();
    const r = checkPlacement({ ...b, assignment: A2, ctx: ctxFor([b]), ignoreBlockId: b.id });
    expect(r).toEqual({ ok: true });
  });

  it("allows a block spanning the seam between an open window and CQ", () => {
    // Monday evening splits at 1930 where CQ begins; those gaps are adjacent in
    // time but separate objects, and a block across the seam is legal.
    const evening = inventory.gaps.filter((g) => g.date === MONDAY && g.startMin >= 1125);
    const open = evening.find((g) => g.quality === "OPEN" && g.endMin === 1170)!;
    const r = checkPlacement({
      date: MONDAY, startMin: open.endMin - 15, endMin: open.endMin + 30,
      assignment: A2, ctx: ctxFor(),
    });
    expect(r).toEqual({ ok: true });
  });
});

describe("moveBlock", () => {
  it("shifts a block and keeps it on the clock grid", () => {
    const gap = gapFor(120);   // needs slack, or the nudge correctly refuses
    const b: WorkBlock = {
      id: "B-mv", assignmentId: "A2", gapId: gap.id, date: gap.date,
      startMin: gap.startMin, endMin: gap.startMin + 60, locked: false, done: false,
    };
    const r = moveBlock(b, 15, A2, ctxFor([b]));
    expect(r.ok).toBe(true);
    expect(r.block!.startMin).toBe(b.startMin + 15);
    expect(r.block!.endMin - r.block!.startMin).toBe(b.endMin - b.startMin);
  });

  it("never crosses into a formation, however many times it is nudged", () => {
    // The adversarial case: the hand-edit path must be exactly as safe as the
    // model path. Walk a block toward an obligation one nudge at a time and
    // assert it stops at the boundary rather than stepping over it.
    let current = blockInGap(30);
    const blocked = inventory.days.find((d) => d.date === MONDAY)!.blocked;
    for (let i = 0; i < 80; i++) {
      const r = moveBlock(current, 15, A2, ctxFor([current]));
      if (!r.ok) break;
      current = r.block!;
      for (const iv of blocked) {
        expect(
          current.startMin < iv.endMin && iv.startMin < current.endMin,
          `block ${current.startMin}-${current.endMin} landed on ${iv.startMin}-${iv.endMin}`,
        ).toBe(false);
      }
    }
  });

  it("refuses to walk off the end of the day", () => {
    const b = { ...blockInGap(), startMin: 23 * 60 - 30, endMin: 23 * 60 };
    expect(moveBlock(b, 60, A2, ctxFor([b])).ok).toBe(false);
  });

  it("explains a refusal instead of silently clamping", () => {
    const b = { ...blockInGap(), startMin: 390, endMin: 420 };
    const r = moveBlock(b, 0, A2, ctxFor([b]));
    expect(r.ok).toBe(false);
    expect(typeof (r as { reason: string }).reason).toBe("string");
  });
});

describe("resizeBlock", () => {
  it("grows a block that has room", () => {
    const gap = gapFor(120);
    const b: WorkBlock = {
      id: "B-002", assignmentId: "A2", gapId: gap.id, date: gap.date,
      startMin: gap.startMin, endMin: gap.startMin + 30, locked: false, done: false,
    };
    const r = resizeBlock(b, 15, A2, ctxFor([b]));
    expect(r.ok).toBe(true);
    expect(r.block!.endMin).toBe(b.endMin + 15);
  });

  it("refuses to shrink below the minimum useful block", () => {
    const b = blockInGap(MIN_BLOCK);
    expect(resizeBlock(b, -15, A2, ctxFor([b]))).toMatchObject({
      ok: false, reason: REASONS.TOO_SHORT,
    });
  });

  it("refuses to grow into an obligation", () => {
    // Take the gap that ends where an obligation begins and push past its edge.
    const day = inventory.days.find((d) => d.date === MONDAY)!;
    const gap = day.gaps.find((g) => g.minutes >= 60 && day.blocked.some((iv) => iv.startMin === g.endMin))!;
    const b: WorkBlock = {
      id: "B-003", assignmentId: "A2", gapId: gap.id, date: gap.date,
      startMin: gap.endMin - 30, endMin: gap.endMin, locked: false, done: false,
    };
    expect(resizeBlock(b, 30, A2, ctxFor([b])).ok).toBe(false);
  });
});

describe("the past, for hand edits vs the model", () => {
  const gap = gapFor(120);
  const midBlock: WorkBlock = {
    id: "B-now", assignmentId: "A2", gapId: gap.id, date: gap.date,
    startMin: gap.startMin, endMin: gap.startMin + 60, locked: false, done: false,
  };
  // "Now" sits inside the block: it started, it has not finished.
  const midCtx = { inventory, others: [midBlock], nowStamp: stamp(gap.date, gap.startMin + 30) };

  it("refuses to PLAN work into a slot that already began", () => {
    const r = checkPlacement({ ...midBlock, assignment: A2, ctx: midCtx });
    expect(r).toMatchObject({ ok: false, reason: REASONS.IN_THE_PAST });
  });

  it("lets the cadet extend the block they are sitting in", () => {
    // The whole point of the split: at 30 minutes in, making an hour into 75
    // is a legitimate edit, and refusing it because it started is just wrong.
    expect(resizeBlock(midBlock, 15, A2, midCtx).ok).toBe(true);
  });

  it("still refuses an edit that lands entirely in the past", () => {
    const over = { ...midCtx, nowStamp: stamp(gap.date, gap.endMin + 600) };
    expect(resizeBlock(midBlock, 15, A2, over)).toMatchObject({
      ok: false, reason: REASONS.IN_THE_PAST,
    });
  });
});
