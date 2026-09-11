/**
 * The free-gap inventory.
 *
 * This is the load-bearing computation of the whole product: given everything
 * imposed on the week, what is actually left? It is deliberately pure,
 * deterministic and model-free. Gemini is handed the output of this file; it
 * is never allowed to produce it.
 */
import type { Assignment, Gap, MatrixEvent, Settings, Term } from "./schemas";
import type { Interval } from "./intervals";
import { intersect, normalize, subtract } from "./intervals";
import {
  MIN_USEFUL_GAP,
  type LocalDate,
  addDays,
  hhmm,
  stamp,
  weekdayOf,
  weekDates,
} from "./time";

export type DayInventory = {
  date: LocalDate;
  /** Everything imposed on you, merged. Drawn as solid ink. */
  blocked: Interval[];
  /** Time the Matrix explicitly hands you but constrains (CQ). Drawn as hatch. */
  roomBound: Interval[];
  /** Schedulable gaps, split so each has a uniform quality. */
  gaps: Gap[];
  /** Sum of gap minutes. */
  freeMinutes: number;
};

/** Course meetings that fall on `date`, as intervals. */
export function meetingsOn(term: Term | null, date: LocalDate): Interval[] {
  if (!term) return [];
  if (date < term.startDate || date > term.endDate) return [];
  const wd = weekdayOf(date);
  const out: Interval[] = [];
  for (const course of term.courses) {
    for (const m of course.meetings) {
      if (m.days.includes(wd)) out.push({ startMin: m.startMin, endMin: m.endMin });
    }
  }
  return out;
}

/** Course meetings on `date` paired with the course that owns them. */
export function labeledMeetingsOn(
  term: Term | null,
  date: LocalDate,
): Array<Interval & { code: string; title: string; location?: string }> {
  if (!term) return [];
  if (date < term.startDate || date > term.endDate) return [];
  const wd = weekdayOf(date);
  const out: Array<Interval & { code: string; title: string; location?: string }> = [];
  for (const course of term.courses) {
    for (const m of course.meetings) {
      if (!m.days.includes(wd)) continue;
      out.push({
        startMin: m.startMin,
        endMin: m.endMin,
        code: course.code,
        title: course.title,
        location: m.location,
      });
    }
  }
  return out;
}

/**
 * Build one day's inventory.
 *
 * The rule that matters: only BLOCKED events subtract time. USABLE and PARTIAL
 * events never subtract - they only *describe* time that is already free, so a
 * misclassification in that direction can never silently consume your day.
 */
export function buildDayInventory(
  date: LocalDate,
  term: Term | null,
  events: MatrixEvent[],
  settings: Settings,
): DayInventory {
  const dayWindow: Interval[] = [
    { startMin: settings.dayStartMin, endMin: settings.dayEndMin },
  ];

  const todays = events.filter((e) => e.date === date);

  const blocked = normalize([
    ...meetingsOn(term, date),
    ...todays.filter((e) => e.availability === "BLOCKED"),
  ]);

  const free = subtract(dayWindow, blocked);

  // PARTIAL events mark free time as room-bound. Split gaps on those edges so
  // every gap carries one honest quality label.
  const partials = todays.filter((e) => e.availability === "PARTIAL");
  const roomBound = normalize(partials);

  const segments: Array<Interval & { quality: Gap["quality"]; label?: string }> = [];
  for (const f of free) {
    const insidePartials = partials
      .map((p) => {
        const hit = intersect(f, p);
        return hit ? { ...hit, label: p.title } : null;
      })
      .filter((x): x is Interval & { label: string } => x !== null)
      .sort((a, b) => a.startMin - b.startMin);

    // The open remainder of this free interval.
    for (const open of subtract([f], insidePartials)) {
      segments.push({ ...open, quality: "OPEN" });
    }
    for (const bound of insidePartials) {
      segments.push({ startMin: bound.startMin, endMin: bound.endMin, quality: "ROOM_BOUND", label: bound.label });
    }
  }

  segments.sort((a, b) => a.startMin - b.startMin);

  const gaps: Gap[] = segments
    .filter((s) => s.endMin - s.startMin >= MIN_USEFUL_GAP)
    .map((s, i) => ({
      id: `G-${date}-${String(i + 1).padStart(2, "0")}`,
      date,
      startMin: s.startMin,
      endMin: s.endMin,
      minutes: s.endMin - s.startMin,
      quality: s.quality,
      label: s.label,
    }));

  return {
    date,
    blocked,
    roomBound,
    gaps,
    freeMinutes: gaps.reduce((n, g) => n + g.minutes, 0),
  };
}

export type WeekInventory = {
  weekStart: LocalDate;
  days: DayInventory[];
  gaps: Gap[];
  freeMinutes: number;
};

export function buildWeekInventory(
  weekStart: LocalDate,
  term: Term | null,
  events: MatrixEvent[],
  settings: Settings,
): WeekInventory {
  const days = weekDates(weekStart).map((d) =>
    buildDayInventory(d, term, events, settings),
  );
  const gaps = days.flatMap((d) => d.gaps);
  return {
    weekStart,
    days,
    gaps,
    freeMinutes: gaps.reduce((n, g) => n + g.minutes, 0),
  };
}

/**
 * Gaps that can still take work for a given assignment: they must end before
 * the thing is due, and must not be in the past.
 */
export function usableGapsFor(
  inventory: WeekInventory,
  assignment: Assignment,
  nowStamp: number,
): Gap[] {
  const due = stamp(assignment.dueDate, assignment.dueMin);
  return inventory.gaps.filter((g) => {
    const gapEnd = stamp(g.date, g.endMin);
    const gapStart = stamp(g.date, g.startMin);
    return gapEnd <= due && gapStart >= nowStamp;
  });
}

/** The compact, numbered gap list handed to Gemini. It places into these ids. */
export function describeGapsForModel(inventory: WeekInventory): string {
  const byDay = new Map<LocalDate, Gap[]>();
  for (const g of inventory.gaps) {
    const list = byDay.get(g.date) ?? [];
    list.push(g);
    byDay.set(g.date, list);
  }
  const lines: string[] = [];
  for (const [date, gaps] of [...byDay.entries()].sort()) {
    lines.push(`${date} (${weekdayOf(date)}):`);
    for (const g of gaps) {
      const tag = g.quality === "ROOM_BOUND" ? ` [room-bound${g.label ? `: ${g.label}` : ""}]` : "";
      lines.push(`  ${g.id}  ${hhmm(g.startMin)}-${hhmm(g.endMin)}  ${g.minutes}min${tag}`);
    }
  }
  lines.push(`TOTAL FREE: ${inventory.freeMinutes} minutes across ${inventory.gaps.length} gaps.`);
  return lines.join("\n");
}

export { addDays };
