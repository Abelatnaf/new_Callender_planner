/**
 * Turn the model's placements into real work blocks - or refuse them.
 *
 * Gemini decides *what* to work on, *how long* it takes and *which gap* it
 * belongs in. It never decides whether that actually fits. Every placement is
 * re-derived here against the real intervals, and anything that fails lands in
 * `unplaced` with a human-readable reason rather than on the printed page.
 *
 * The check that matters most is COLLIDES_WITH_OBLIGATION. A planner that is
 * wrong about an obligation is worse than no planner, because the printed page
 * carries authority - so we re-test every block against the blocked intervals
 * even though the gap inventory should already have excluded them. Defense in
 * depth is cheap here and the failure it prevents is missing a formation.
 */
import type { Assignment, Gap, Plan, Unplaced, WorkBlock } from "./schemas";
import type { WeekInventory } from "./gaps";
import type { GeminiPlanResponse } from "./schemas";
import { normalize, overlaps } from "./intervals";
import { MIN_BLOCK, SNAP, snap, snapCeil, stamp, type LocalDate } from "./time";

export const REASONS = {
  NO_SUCH_GAP: "the plan referenced a time slot that does not exist",
  NO_SUCH_ASSIGNMENT: "the plan referenced an assignment that is not in the backlog",
  GAP_TOO_SHORT: "the remaining slot is shorter than the minimum useful block",
  PAST_DEADLINE: "this block would finish after the assignment was already due",
  IN_THE_PAST: "this slot has already elapsed",
  COLLIDES_WITH_OBLIGATION: "this slot collides with a mandatory obligation",
  NO_ROOM_LEFT: "every slot before the deadline is already committed",
  TOO_SHORT: "that would be shorter than the minimum useful block",
  OVERLAPS_WORK: "another work block is already in that time",
  ALREADY_DONE: "the assignment is marked done",
} as const;

export type ValidationIssue = {
  blockId?: string;
  assignmentId: string;
  reason: string;
  severity: "dropped" | "adjusted";
  detail?: string;
};

export type MaterializeInput = {
  response: GeminiPlanResponse;
  inventory: WeekInventory;
  assignments: Assignment[];
  /** User-placed blocks. These are honoured first and never silently moved. */
  locked?: WorkBlock[];
  nowStamp: number;
  idPrefix?: string;
};

export type MaterializeResult = {
  plan: Plan;
  issues: ValidationIssue[];
  /** Effort estimates the model produced, to merge back onto assignments. */
  estimates: GeminiPlanResponse["estimates"];
};

function blockedIntervalsByDate(inventory: WeekInventory) {
  const map = new Map<LocalDate, { startMin: number; endMin: number }[]>();
  for (const day of inventory.days) map.set(day.date, day.blocked);
  return map;
}

/**
 * Find a real start time for a block inside a gap.
 *
 * Starts are aligned to the absolute clock grid, not to the gap edge, because
 * a printed page that reads "0945-1045" is worth more than one that reads
 * "0950-1050". The raw gap edge is kept as a fallback for the case where grid
 * alignment would waste an otherwise usable slot.
 */
function firstFreeSlotInGap(
  gap: Gap,
  desiredStart: number,
  minutes: number,
  taken: WorkBlock[],
): number | null {
  const sameDay = taken
    .filter((b) => b.date === gap.date)
    .map((b) => ({ startMin: b.startMin, endMin: b.endMin }))
    .sort((a, b) => a.startMin - b.startMin);

  const fits = (start: number) => {
    if (start < gap.startMin || start + minutes > gap.endMin) return false;
    return !sameDay.some((t) => overlaps({ startMin: start, endMin: start + minutes }, t));
  };

  const candidates: number[] = [Math.max(gap.startMin, snapCeil(desiredStart))];
  for (let s = snapCeil(gap.startMin); s + minutes <= gap.endMin; s += SNAP) {
    candidates.push(s);
  }
  candidates.push(gap.startMin); // last resort: hug the edge rather than lose the gap

  for (const c of candidates) if (fits(c)) return c;
  return null;
}

/* ------------------------------------------------- the shared safety check */

export type PlacementCheck =
  | { ok: true }
  | { ok: false; reason: string; detail?: string };

export type PlacementContext = {
  inventory: WeekInventory;
  /** Every other block already placed. The block under test must not be here. */
  others: WorkBlock[];
  nowStamp: number;
};

/**
 * Is this a legal place for work?
 *
 * Extracted so that a block nudged by hand and a block placed by the model are
 * judged by exactly the same rules. Before this existed the checks lived inline
 * in the placement loop, which meant any hand-editing feature would have
 * silently bypassed the entire ratchet - the one safety property this product
 * is built on.
 *
 * Free time is taken as the *merged* run of the day's gaps, not a single gap:
 * an open window and the CQ window that follows it are contiguous in time but
 * separate Gap objects, and a block spanning that seam is perfectly legal.
 */
export function checkPlacement(opts: {
  date: LocalDate;
  startMin: number;
  endMin: number;
  assignment: Assignment;
  ctx: PlacementContext;
  /** Ignore this block id when testing overlap - it is the one being moved. */
  ignoreBlockId?: string;
  /**
   * How much of the past to refuse.
   *
   * "start" (the default) is right for the model: do not *plan* work into a
   * slot that has already begun. "end" is right for a hand edit, because the
   * cadet is the authority on their own past - at 1930, inside a 1900-2000
   * block, extending it to 2100 is a legitimate thing to want, and refusing it
   * because the block started half an hour ago is simply wrong.
   */
  pastPolicy?: "start" | "end";
}): PlacementCheck {
  const { date, startMin, endMin, assignment, ctx, ignoreBlockId } = opts;
  const pastPolicy = opts.pastPolicy ?? "start";
  const day = ctx.inventory.days.find((d) => d.date === date);

  if (assignment.status === "done") {
    return { ok: false, reason: REASONS.ALREADY_DONE };
  }
  if (endMin - startMin < MIN_BLOCK) {
    return { ok: false, reason: REASONS.TOO_SHORT, detail: `${endMin - startMin}min` };
  }
  const pastEdge = pastPolicy === "end" ? endMin : startMin;
  if (stamp(date, pastEdge) < ctx.nowStamp) {
    return { ok: false, reason: REASONS.IN_THE_PAST, detail: `${date} ${pastEdge}` };
  }
  if (stamp(date, endMin) > stamp(assignment.dueDate, assignment.dueMin)) {
    return { ok: false, reason: REASONS.PAST_DEADLINE, detail: `due ${assignment.dueDate}` };
  }

  // The block must sit inside free time. This subsumes both "not on an
  // obligation" and "not outside the waking day", since gaps are bounded by
  // each.
  const free = normalize(day?.gaps ?? []);
  const fits = free.some((f) => startMin >= f.startMin && endMin <= f.endMin);
  if (!fits) {
    return { ok: false, reason: REASONS.COLLIDES_WITH_OBLIGATION, detail: `${date} ${startMin}-${endMin}` };
  }

  // Defense in depth: the gap inventory should already guarantee the above.
  const blocked = day?.blocked ?? [];
  if (blocked.some((iv) => overlaps({ startMin, endMin }, iv))) {
    return { ok: false, reason: REASONS.COLLIDES_WITH_OBLIGATION, detail: "overlapped an obligation" };
  }

  const clash = ctx.others.some(
    (b) => b.id !== ignoreBlockId && b.date === date && overlaps({ startMin, endMin }, b),
  );
  if (clash) {
    return { ok: false, reason: REASONS.OVERLAPS_WORK, detail: "another block is already here" };
  }

  return { ok: true };
}

/* ------------------------------------------------------------ hand edits */

export type EditResult = PlacementCheck & { block?: WorkBlock };

/** Shift a block on the clock grid. Refuses rather than clamping silently. */
export function moveBlock(block: WorkBlock, deltaMin: number, assignment: Assignment, ctx: PlacementContext): EditResult {
  const step = snap(deltaMin);
  const startMin = block.startMin + step;
  const endMin = block.endMin + step;
  if (startMin < 0 || endMin > 24 * 60) {
    return { ok: false, reason: REASONS.COLLIDES_WITH_OBLIGATION, detail: "outside the day" };
  }
  const check = checkPlacement({
    date: block.date, startMin, endMin, assignment, ctx,
    ignoreBlockId: block.id, pastPolicy: "end",
  });
  return check.ok ? { ok: true, block: { ...block, startMin, endMin } } : check;
}

/** Grow or shrink a block from its end, on the clock grid. */
export function resizeBlock(block: WorkBlock, deltaMin: number, assignment: Assignment, ctx: PlacementContext): EditResult {
  const endMin = block.endMin + snap(deltaMin);
  if (endMin - block.startMin < MIN_BLOCK) {
    return { ok: false, reason: REASONS.TOO_SHORT, detail: `minimum is ${MIN_BLOCK} minutes` };
  }
  const check = checkPlacement({
    date: block.date, startMin: block.startMin, endMin, assignment, ctx,
    ignoreBlockId: block.id, pastPolicy: "end",
  });
  return check.ok ? { ok: true, block: { ...block, endMin } } : check;
}

export function materializePlan(input: MaterializeInput): MaterializeResult {
  const { response, inventory, assignments, nowStamp } = input;
  const prefix = input.idPrefix ?? "B";

  const byId = new Map(assignments.map((a) => [a.id, a]));
  const gapById = new Map(inventory.gaps.map((g) => [g.id, g]));
  const blockedByDate = blockedIntervalsByDate(inventory);

  const issues: ValidationIssue[] = [];
  const unplaced: Unplaced[] = [...(response.unplaced ?? [])];
  const accepted: WorkBlock[] = [];

  const reject = (assignmentId: string, reason: string, detail?: string) => {
    unplaced.push({ assignmentId, reason });
    issues.push({ assignmentId, reason, severity: "dropped", detail });
  };

  // Locked (user-placed) blocks are seeded first so the model cannot displace
  // a decision the cadet made by hand.
  for (const b of input.locked ?? []) {
    const blocked = blockedByDate.get(b.date) ?? [];
    if (blocked.some((iv) => overlaps({ startMin: b.startMin, endMin: b.endMin }, iv))) {
      reject(b.assignmentId, REASONS.COLLIDES_WITH_OBLIGATION, `locked block ${b.id}`);
      continue;
    }
    accepted.push({ ...b, locked: true });
  }

  let seq = accepted.length;

  for (const p of response.placements) {
    const assignment = byId.get(p.assignmentId);
    if (!assignment) {
      reject(p.assignmentId, REASONS.NO_SUCH_ASSIGNMENT);
      continue;
    }
    if (assignment.status === "done") {
      reject(p.assignmentId, REASONS.ALREADY_DONE);
      continue;
    }

    const gap = gapById.get(p.gapId);
    if (!gap) {
      reject(p.assignmentId, REASONS.NO_SUCH_GAP, `gapId=${p.gapId}`);
      continue;
    }

    // The model's offset and duration are advisory; we re-derive real times.
    let minutes = Math.max(MIN_BLOCK, snap(p.minutes));
    minutes = Math.min(minutes, gap.minutes);
    if (minutes < MIN_BLOCK) {
      reject(p.assignmentId, REASONS.GAP_TOO_SHORT, `gap ${gap.id} is ${gap.minutes}min`);
      continue;
    }

    const desired = gap.startMin + Math.max(0, p.offsetMin);
    const start = firstFreeSlotInGap(gap, desired, minutes, accepted);
    if (start === null) {
      reject(p.assignmentId, REASONS.NO_ROOM_LEFT, `gap ${gap.id}`);
      continue;
    }
    const end = start + minutes;

    if (start !== Math.max(gap.startMin, snapCeil(desired))) {
      issues.push({
        assignmentId: p.assignmentId,
        reason: "shifted to the first opening in the slot",
        severity: "adjusted",
      });
    }

    // The same predicate a hand-nudged block goes through, so the model path
    // and the cadet's own edits are held to identical rules.
    const verdict = checkPlacement({
      date: gap.date, startMin: start, endMin: end, assignment,
      ctx: { inventory, others: accepted, nowStamp },
    });
    if (!verdict.ok) {
      reject(p.assignmentId, verdict.reason, verdict.detail);
      continue;
    }

    accepted.push({
      id: `${prefix}-${String(++seq).padStart(3, "0")}`,
      assignmentId: p.assignmentId,
      gapId: gap.id,
      date: gap.date,
      startMin: start,
      endMin: end,
      rationale: p.rationale,
      locked: false,
      done: false,
    });
  }

  accepted.sort((a, b) => stamp(a.date, a.startMin) - stamp(b.date, b.startMin));

  // Collapse duplicate unplaced entries, keeping the first reason given.
  const seen = new Set<string>();
  const dedupedUnplaced = unplaced.filter((u) => {
    if (seen.has(u.assignmentId)) return false;
    seen.add(u.assignmentId);
    return !accepted.some((b) => b.assignmentId === u.assignmentId);
  });

  return {
    plan: {
      id: `P-${inventory.weekStart}`,
      weekStart: inventory.weekStart,
      generatedAt: new Date().toISOString(),
      blocks: accepted,
      unplaced: dedupedUnplaced,
      briefing: response.briefing,
    },
    issues,
    estimates: response.estimates ?? [],
  };
}

/** Post-hoc audit. Used by tests and by the document view before printing. */
export function auditPlan(
  plan: Plan,
  inventory: WeekInventory,
  assignments: Assignment[],
): ValidationIssue[] {
  const problems: ValidationIssue[] = [];
  const blockedByDate = blockedIntervalsByDate(inventory);
  const byId = new Map(assignments.map((a) => [a.id, a]));

  for (const b of plan.blocks) {
    const blocked = blockedByDate.get(b.date) ?? [];
    if (blocked.some((iv) => overlaps({ startMin: b.startMin, endMin: b.endMin }, iv))) {
      problems.push({
        blockId: b.id,
        assignmentId: b.assignmentId,
        reason: REASONS.COLLIDES_WITH_OBLIGATION,
        severity: "dropped",
      });
    }
    const a = byId.get(b.assignmentId);
    if (a && stamp(b.date, b.endMin) > stamp(a.dueDate, a.dueMin)) {
      problems.push({
        blockId: b.id,
        assignmentId: b.assignmentId,
        reason: REASONS.PAST_DEADLINE,
        severity: "dropped",
      });
    }
  }

  for (let i = 0; i < plan.blocks.length; i++) {
    for (let j = i + 1; j < plan.blocks.length; j++) {
      const a = plan.blocks[i];
      const b = plan.blocks[j];
      if (a.date === b.date && overlaps(a, b)) {
        problems.push({
          blockId: b.id,
          assignmentId: b.assignmentId,
          reason: "overlaps another work block",
          severity: "dropped",
        });
      }
    }
  }

  return problems;
}
