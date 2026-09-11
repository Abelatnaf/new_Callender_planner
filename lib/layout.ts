/** Geometry helpers shared by the ribbon and the print views. */
import type { Assignment, Gap, MatrixEvent, WorkBlock } from "./schemas";
import { stamp } from "./time";

export type Axis = { startMin: number; endMin: number };

/** Where a minute sits along the axis, as a percentage. */
export function toPct(min: number, axis: Axis): number {
  const span = Math.max(1, axis.endMin - axis.startMin);
  return ((min - axis.startMin) / span) * 100;
}

/** Left/width for an interval, clamped to the axis so nothing overflows. */
export function placement(
  startMin: number,
  endMin: number,
  axis: Axis,
): { left: string; width: string } | null {
  const s = Math.max(startMin, axis.startMin);
  const e = Math.min(endMin, axis.endMin);
  if (e <= s) return null;
  const left = toPct(s, axis);
  const width = toPct(e, axis) - left;
  return { left: `${left}%`, width: `${width}%` };
}

/** Hour ticks to label along the scale. */
export function hourTicks(axis: Axis, every = 2): number[] {
  const out: number[] = [];
  const first = Math.ceil(axis.startMin / 60) * 60;
  for (let m = first; m <= axis.endMin; m += 60 * every) out.push(m);
  return out;
}

/** A deadline inside this many hours counts as urgent and prints in signal. */
export const URGENT_HOURS = 48;

export function isUrgent(a: Assignment | undefined, nowStamp: number): boolean {
  if (!a) return false;
  const due = stamp(a.dueDate, a.dueMin);
  return due - nowStamp <= URGENT_HOURS * 60 && due >= nowStamp;
}

export function isOverdue(a: Assignment | undefined, nowStamp: number): boolean {
  if (!a) return false;
  return stamp(a.dueDate, a.dueMin) < nowStamp && a.status !== "done";
}

export type RibbonBars = {
  ink: Array<{ key: string; startMin: number; endMin: number; label: string; ai: boolean }>;
  hatch: Array<{ key: string; startMin: number; endMin: number; label: string; ai: boolean }>;
  work: Array<{ key: string; block: WorkBlock; label: string; urgent: boolean }>;
  gaps: Gap[];
};

/** Sort every element of a day into the four visual states. */
export function barsForDay(opts: {
  events: MatrixEvent[];
  meetings: Array<{ startMin: number; endMin: number; code: string }>;
  blocks: WorkBlock[];
  gaps: Gap[];
  assignments: Assignment[];
  nowStamp: number;
}): RibbonBars {
  const { events, meetings, blocks, gaps, assignments, nowStamp } = opts;
  const byId = new Map(assignments.map((a) => [a.id, a]));

  return {
    ink: [
      ...meetings.map((m, i) => ({
        key: `m${i}`, startMin: m.startMin, endMin: m.endMin, label: m.code, ai: false,
      })),
      ...events
        .filter((e) => e.availability === "BLOCKED")
        .map((e) => ({
          key: e.id, startMin: e.startMin, endMin: e.endMin, label: e.title,
          ai: !e.confirmedByUser,
        })),
    ].sort((a, b) => a.startMin - b.startMin),

    hatch: events
      .filter((e) => e.availability === "PARTIAL")
      .map((e) => ({
        key: e.id, startMin: e.startMin, endMin: e.endMin, label: e.title,
        ai: !e.confirmedByUser,
      })),

    work: blocks.map((b) => {
      const a = byId.get(b.assignmentId);
      return {
        key: b.id,
        block: b,
        label: a?.courseCode ?? a?.title ?? "WORK",
        urgent: isUrgent(a, nowStamp),
      };
    }),

    gaps,
  };
}
