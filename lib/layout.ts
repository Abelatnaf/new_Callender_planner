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
): { left: string; width: string; widthPct: number } | null {
  const s = Math.max(startMin, axis.startMin);
  const e = Math.min(endMin, axis.endMin);
  if (e <= s) return null;
  const left = toPct(s, axis);
  const width = toPct(e, axis) - left;
  return { left: `${left}%`, width: `${width}%`, widthPct: width };
}

/**
 * How much text a bar can honestly carry.
 *
 * A 50-minute class inside a 17-hour axis is a sliver. Squeezing "CHEM 141" and
 * a start time into it produces "C... 0800", which is noise pretending to be
 * information. Below these widths the bar says less, and means more - a solid
 * black sliver already reads as "this time is taken".
 */
/**
 * Which time-of-day band a minute falls in.
 *
 * The glow hue carries a second signal beyond "this time is yours": *when* it
 * falls. A week whose light is all night-blue is a week with no mornings, and
 * that reads instantly as colour without costing a number or a label.
 */
export type GlowBand = "dawn" | "day" | "dusk" | "night";

/** Where each band begins, in minutes from midnight. */
export const BANDS: Array<{ band: GlowBand; from: number }> = [
  { band: "dawn", from: 0 },
  { band: "day", from: 11 * 60 },
  { band: "dusk", from: 16 * 60 },
  { band: "night", from: 20 * 60 },
];

/**
 * A CSS gradient spanning the real hours a gap covers.
 *
 * A single flat hue would make a nine-hour Sunday look like a slab of orange.
 * Sweeping the actual bands the gap crosses turns it into a sunrise-to-night
 * run, which is both better looking and strictly more informative: you can see
 * where in the day a long window actually sits.
 */
export function gapGradient(startMin: number, endMin: number): string {
  const span = Math.max(1, endMin - startMin);
  const at = (m: number) => `${(((m - startMin) / span) * 100).toFixed(2)}%`;

  const stops: string[] = [];
  for (const [i, b] of BANDS.entries()) {
    const next = BANDS[i + 1]?.from ?? 24 * 60;
    if (next <= startMin || b.from >= endMin) continue;      // band not crossed
    const from = Math.max(b.from, startMin);
    const to = Math.min(next, endMin);
    stops.push(`var(--${b.band}) ${at(from)}`, `var(--${b.band}-2) ${at(to)}`);
  }
  if (stops.length === 0) {
    const b = glowBand(startMin);
    return `linear-gradient(90deg, var(--${b}), var(--${b}-2))`;
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export function glowBand(startMin: number): GlowBand {
  if (startMin < 11 * 60) return "dawn";   // through 1059
  if (startMin < 16 * 60) return "day";    // through 1559
  if (startMin < 20 * 60) return "dusk";   // through 1959
  return "night";
}

export const HUE_SLOTS = 8;

/**
 * Colour index for a course that has no place in the term list.
 *
 * A hash, and therefore only a fallback: four items in eight slots collide more
 * often than not (~59% by the birthday bound), so hashing cannot promise
 * distinct colours and is never used when a real assignment is available.
 */
export function courseHue(key: string | undefined, slots = HUE_SLOTS): number {
  if (!key) return 0;
  // FNV-1a with an avalanche finish; the naive h*31 variant clustered badly on
  // course codes, which share most of their characters.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) % slots;
}

/**
 * Assign every course in the term a distinct colour.
 *
 * Sequential rather than hashed, because distinctness is the entire point: with
 * eight slots this guarantees no two courses share a colour for any realistic
 * load, where a hash would collide most of the time. Order comes from the term
 * list, which is stable across renders and re-imports, so colours do not move.
 */
export function buildCourseHues(codes: Array<string | undefined>): Map<string, number> {
  const map = new Map<string, number>();
  let next = 0;
  for (const code of codes) {
    const key = code?.trim();
    if (!key || map.has(key)) continue;
    map.set(key, next % HUE_SLOTS);
    next++;
  }
  return map;
}

/** The colour for a course: its assigned slot, or a hashed fallback. */
export function hueFor(code: string | undefined, hues?: Map<string, number>): number {
  const key = code?.trim();
  if (!key) return 0;
  const assigned = hues?.get(key);
  return assigned ?? courseHue(key);
}

export function barDetail(widthPct: number): "none" | "label" | "full" {
  if (widthPct < 2.0) return "none";
  if (widthPct < 11) return "label";
  return "full";
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
