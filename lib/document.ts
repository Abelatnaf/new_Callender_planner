/**
 * The printed week, as data.
 *
 * Everything the document renders is derived here and nowhere else, for one
 * reason: a printed page is the last place a mistake can be caught. On screen a
 * wrong figure is a refresh away from being fixed; on paper it goes to a
 * formation. So the arithmetic lives in a pure module with tests rather than
 * inside JSX where it cannot be checked.
 *
 * Shapes follow the reference document: a page per day carrying a masthead, two
 * timeline columns and a rail, then a courses page and a study plan that shows
 * its working.
 */
import type {
  Assignment, Course, MatrixEvent, MatrixWeek, Plan, Settings, Term, WorkBlock,
} from "./schemas";
import { buildDayInventory, labeledMeetingsOn, type DayInventory } from "./gaps";
import {
  type LocalDate, WEEKDAY_LONG, addDays, formatDuration, hhmm, stamp, weekDates, weekdayOf,
} from "./time";
import { CONFIDENCE_FLOOR } from "./convert";

/* --------------------------------------------------------------- one row */

export type RowKind = "class" | "matrix" | "study";

export type DayRow = {
  id: string;
  startMin: number;
  endMin: number;
  /** "0700" for a formation, "1330-1420" for anything with a real length. */
  time: string;
  title: string;
  subtitle?: string;
  location?: string;
  kind: RowKind;
  /** Course code when this belongs to a course; it is what picks the colour. */
  course?: string;
  /** False when the row is somebody else's: printed, but never blocking. */
  mine: boolean;
  pax?: string;
  /** The source gave a start and no end. */
  estimated: boolean;
  /** The ratchet overrode the model, or the model was unsure. */
  guessed: boolean;
};

/**
 * A formation is an instant, not a span.
 *
 * The Matrix writes "1900" and the app stores a plausible twenty minutes so the
 * interval maths works. Printing "1900-1920" would present that invention as
 * fact, so the label says what the source said.
 */
function timeLabel(startMin: number, endMin: number, estimated: boolean): string {
  return estimated ? hhmm(startMin) : `${hhmm(startMin)}-${hhmm(endMin)}`;
}

/* -------------------------------------------------------------- one page */

export type Pill = { label: string; value: string };

export type DayPage = {
  date: LocalDate;
  weekday: string;
  /** "7" — the reference sets this at 48pt in the masthead. */
  numeral: string;
  monthLabel: string;
  /** What to wear, rolled up from the day's own rows. */
  uniform: string;
  pills: Pill[];
  /** A gold flag when the day has earned one. At most one, and only if true. */
  tag: string | null;
  morning: DayRow[];
  evening: DayRow[];
  due: Assignment[];
  topThree: Array<{ rank: number; title: string; course?: string; why: string }>;
  /** Anything the reader should distrust, in plain sentences. */
  cautions: string[];
  freeMinutes: number;
  studyMinutes: number;
  classMinutes: number;
  /**
   * The hours that are actually yours, named.
   *
   * The whole product answers "which hours are mine?" and the day page was
   * answering it only by omission — by what it did not print. Stating the
   * windows outright is both the most useful thing on the sheet and what fills
   * a page that a light day would otherwise leave half empty.
   */
  windows: Array<{ time: string; minutes: number; label: string; bound: boolean }>;
};

/** Noon splits the page, as it does in the reference. */
const NOON = 12 * 60;

function rowsForDay(opts: {
  date: LocalDate;
  term: Term | null;
  events: MatrixEvent[];
  blocks: WorkBlock[];
  assignments: Map<string, Assignment>;
}): DayRow[] {
  const { date, term, events, blocks, assignments } = opts;
  const rows: DayRow[] = [];

  for (const m of labeledMeetingsOn(term, date)) {
    rows.push({
      id: `class-${date}-${m.startMin}-${m.code}`,
      startMin: m.startMin, endMin: m.endMin,
      time: timeLabel(m.startMin, m.endMin, false),
      title: m.code, subtitle: m.title, location: m.location,
      kind: "class", course: m.code, mine: true, estimated: false, guessed: false,
    });
  }

  for (const e of events) {
    rows.push({
      id: e.id,
      startMin: e.startMin, endMin: e.endMin,
      time: timeLabel(e.startMin, e.endMin, e.endEstimated),
      title: e.title,
      subtitle: e.note && e.confidence < CONFIDENCE_FLOOR ? e.note : undefined,
      location: e.location || undefined,
      kind: "matrix",
      mine: e.appliesToMe !== false,
      pax: e.pax || undefined,
      estimated: e.endEstimated,
      guessed: e.ratcheted || e.confidence < CONFIDENCE_FLOOR,
    });
  }

  for (const b of blocks) {
    const a = assignments.get(b.assignmentId);
    rows.push({
      id: b.id,
      startMin: b.startMin, endMin: b.endMin,
      time: timeLabel(b.startMin, b.endMin, false),
      // Never the word "study": an if-then plan names the task or it is not one.
      title: a?.title ?? "Study block",
      subtitle: b.rationale ?? (a?.courseCode ? `${a.courseCode} · due ${a.dueDate}` : undefined),
      kind: "study", course: a?.courseCode, mine: true, estimated: false, guessed: false,
    });
  }

  rows.sort((x, y) => x.startMin - y.startMin || x.endMin - y.endMin || x.title.localeCompare(y.title));
  return rows;
}

/**
 * What to wear today.
 *
 * Joined rather than reduced to one: the real Matrix genuinely does say "Class
 * Dyke | Gym Dyke" on a day with both a parade and PT, and picking one of them
 * would be a guess dressed as an answer.
 */
export function uniformFor(events: MatrixEvent[]): string {
  const seen: string[] = [];
  for (const e of events) {
    const u = (e.uniform || "").trim();
    if (!u || u === "-" || e.appliesToMe === false) continue;
    if (!seen.some((s) => s.toLowerCase() === u.toLowerCase())) seen.push(u);
  }
  return seen.slice(0, 3).join(" | ");
}

/** Ranked by deadline pressure, which is what "first" has to mean. */
function pickTopThree(
  due: Assignment[],
  blocks: WorkBlock[],
  assignments: Map<string, Assignment>,
  date: LocalDate,
): DayPage["topThree"] {
  // What is actually planned for today leads, in the order it will happen.
  const planned = blocks
    .map((b) => ({ b, a: assignments.get(b.assignmentId) }))
    .filter((x): x is { b: WorkBlock; a: Assignment } => Boolean(x.a))
    .sort((x, y) => x.b.startMin - y.b.startMin);

  const out: DayPage["topThree"] = [];
  for (const { b, a } of planned) {
    if (out.length === 3) break;
    if (out.some((t) => t.title === a.title)) continue;
    const days = Math.max(0, Math.round((stamp(a.dueDate, a.dueMin) - stamp(date, b.startMin)) / 1440));
    out.push({
      rank: out.length + 1,
      title: a.title,
      course: a.courseCode,
      why: days <= 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`,
    });
  }
  // Nothing planned: fall back to the nearest deadlines, which is the same
  // question answered with less information.
  for (const a of due) {
    if (out.length === 3) break;
    if (out.some((t) => t.title === a.title)) continue;
    out.push({ rank: out.length + 1, title: a.title, course: a.courseCode, why: `due ${hhmm(a.dueMin)}` });
  }
  return out;
}

function cautionsFor(events: MatrixEvent[], inv: DayInventory): string[] {
  const out: string[] = [];
  const est = events.filter((e) => e.endEstimated && e.appliesToMe !== false);
  const unsure = events.filter((e) => (e.ratcheted || e.confidence < CONFIDENCE_FLOOR) && e.appliesToMe !== false);

  if (est.length) {
    out.push(
      `${est.length} time${est.length === 1 ? "" : "s"} below ${est.length === 1 ? "is an estimate" : "are estimates"} — the Matrix gave a start and no end (${est.slice(0, 3).map((e) => e.title).join(", ")}${est.length > 3 ? "…" : ""}).`,
    );
  }
  if (unsure.length) {
    out.push(
      `${unsure.length} entr${unsure.length === 1 ? "y was" : "ies were"} marked mandatory because Gemini was not confident — you may have more time than this page shows.`,
    );
  }
  if (inv.freeMinutes === 0) out.push("Nothing free today. Do not plan work into this day.");
  return out;
}

export function buildDayPage(opts: {
  date: LocalDate;
  term: Term | null;
  events: MatrixEvent[];
  blocks: WorkBlock[];
  assignments: Assignment[];
  settings: Settings;
  /** Set when this day carries the week's heaviest class load, longest run, etc. */
  tag?: string | null;
}): DayPage {
  const { date, term, events, blocks, assignments, settings } = opts;
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const inv = buildDayInventory(date, term, events, settings);

  const rows = rowsForDay({ date, term, events, blocks, assignments: byId });
  const meetings = labeledMeetingsOn(term, date);
  const classMinutes = meetings.reduce((n, m) => n + (m.endMin - m.startMin), 0);
  const studyMinutes = blocks.reduce((n, b) => n + (b.endMin - b.startMin), 0);
  const openMinutes = Math.max(0, inv.freeMinutes - studyMinutes);

  const due = assignments
    .filter((a) => a.dueDate === date && a.status !== "done")
    .sort((a, b) => a.dueMin - b.dueMin);

  const [y, m, d] = date.split("-");

  return {
    date,
    weekday: WEEKDAY_LONG[weekdayOf(date)].toUpperCase(),
    numeral: String(Number(d)),
    monthLabel: new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    }).toUpperCase(),
    uniform: uniformFor(events),
    pills: [
      { label: `${meetings.length} class${meetings.length === 1 ? "" : "es"}`, value: formatDuration(classMinutes) },
      { label: "study", value: formatDuration(studyMinutes) },
      { label: "open", value: formatDuration(openMinutes) },
    ],
    tag: opts.tag ?? null,
    morning: rows.filter((r) => r.startMin < NOON),
    evening: rows.filter((r) => r.startMin >= NOON),
    due,
    topThree: pickTopThree(due, blocks, byId, date),
    cautions: cautionsFor(events, inv),
    freeMinutes: inv.freeMinutes,
    studyMinutes,
    classMinutes,
    windows: inv.gaps.map((g) => ({
      time: `${hhmm(g.startMin)}-${hhmm(g.endMin)}`,
      minutes: g.minutes,
      label: g.label ?? (g.quality === "ROOM_BOUND" ? "in quarters" : "open"),
      bound: g.quality === "ROOM_BOUND",
    })),
  };
}

/* ------------------------------------------------------------ whole week */

export type CourseLine = {
  code: string;
  title: string;
  credits?: number;
  instructor?: string;
  location?: string;
  pattern: string;
  /** Minutes in class each week — the figure a schedule never states. */
  weeklyMinutes: number;
};

export type StudyPlan = {
  perCourse: Array<{ code: string; title: string; minutes: number; days: number }>;
  dailyLoad: Array<{ date: LocalDate; weekday: string; studyMinutes: number; freeMinutes: number }>;
  sessions: Array<{ date: LocalDate; weekday: string; studyMinutes: number; blocks: Array<{ time: string; course: string; title: string }> }>;
  totalMinutes: number;
  freeMinutes: number;
  /** Share of free time this plan spends. */
  sharePct: number;
  blockCount: number;
};

export type DocumentModel = {
  weekStart: LocalDate;
  range: string;
  days: DayPage[];
  courses: CourseLine[];
  totalCredits: number;
  weeklyClassMinutes: number;
  horizon: Array<{ date: LocalDate; weekday: string; items: Assignment[] }>;
  beyondHorizon: number;
  study: StudyPlan;
  audit: string[];
};

function patternFor(course: Course): string {
  return course.meetings
    .map((m) => `${m.days.join("")} ${hhmm(m.startMin)}-${hhmm(m.endMin)}`)
    .join("  |  ");
}

/** Weeks of deadlines to print in full before they become a count. */
const HORIZON_WEEKS = 3;

export function buildDocument(opts: {
  weekStart: LocalDate;
  term: Term | null;
  week: MatrixWeek | null;
  plan: Plan | null;
  assignments: Assignment[];
  settings: Settings;
}): DocumentModel {
  const { weekStart, term, week, plan, assignments, settings } = opts;
  const dates = weekDates(weekStart);
  const events = week?.events ?? [];
  const blocks = plan?.blocks ?? [];
  const byId = new Map(assignments.map((a) => [a.id, a]));

  const classMinutesByDate = new Map(
    dates.map((d) => [d, labeledMeetingsOn(term, d).reduce((n, m) => n + (m.endMin - m.startMin), 0)]),
  );
  const heaviest = [...classMinutesByDate.entries()].sort((a, b) => b[1] - a[1])[0];

  const days = dates.map((date) => {
    const dayEvents = events.filter((e) => e.date === date);
    const dayBlocks = blocks.filter((b) => b.date === date);
    // Only one tag, only when it is true, and never on a day with no classes.
    const tag =
      heaviest && heaviest[0] === date && heaviest[1] > 0 ? "HEAVIEST CLASS DAY" : null;
    return buildDayPage({
      date, term, events: dayEvents, blocks: dayBlocks, assignments, settings, tag,
    });
  });

  /* --------------------------------------------------------------- courses */
  const courses: CourseLine[] = (term?.courses ?? []).map((c) => ({
    code: c.code,
    title: c.title,
    credits: c.credits,
    instructor: c.instructor,
    location: c.meetings.find((m) => m.location)?.location,
    pattern: patternFor(c),
    weeklyMinutes: c.meetings.reduce((n, m) => n + (m.endMin - m.startMin) * m.days.length, 0),
  }));

  /* --------------------------------------------------------------- horizon */
  const horizonEnd = addDays(dates[6], HORIZON_WEEKS * 7);
  const ahead = assignments
    .filter((a) => a.status !== "done" && a.dueDate > dates[6])
    .sort((a, b) => stamp(a.dueDate, a.dueMin) - stamp(b.dueDate, b.dueMin));
  const within = ahead.filter((a) => a.dueDate <= horizonEnd);
  const horizon: DocumentModel["horizon"] = [];
  for (const a of within) {
    const last = horizon[horizon.length - 1];
    if (last && last.date === a.dueDate) last.items.push(a);
    else horizon.push({ date: a.dueDate, weekday: WEEKDAY_LONG[weekdayOf(a.dueDate)].slice(0, 3).toUpperCase(), items: [a] });
  }

  /* ------------------------------------------------------------ study plan */
  const perCourseMap = new Map<string, { code: string; title: string; minutes: number; days: Set<string> }>();
  for (const b of blocks) {
    const a = byId.get(b.assignmentId);
    const code = a?.courseCode ?? "—";
    const title = courses.find((c) => c.code === code)?.title ?? a?.title ?? "";
    const row = perCourseMap.get(code) ?? { code, title, minutes: 0, days: new Set<string>() };
    row.minutes += b.endMin - b.startMin;
    row.days.add(b.date);
    perCourseMap.set(code, row);
  }

  const freeMinutes = days.reduce((n, d) => n + d.freeMinutes, 0);
  const totalMinutes = blocks.reduce((n, b) => n + (b.endMin - b.startMin), 0);

  const study: StudyPlan = {
    perCourse: [...perCourseMap.values()]
      .map((r) => ({ code: r.code, title: r.title, minutes: r.minutes, days: r.days.size }))
      .sort((a, b) => b.minutes - a.minutes),
    dailyLoad: days.map((d) => ({
      date: d.date, weekday: d.weekday.slice(0, 3),
      studyMinutes: d.studyMinutes, freeMinutes: d.freeMinutes,
    })),
    sessions: days.map((d) => ({
      date: d.date,
      weekday: d.weekday.slice(0, 3),
      studyMinutes: d.studyMinutes,
      blocks: blocks
        .filter((b) => b.date === d.date)
        .sort((a, b) => a.startMin - b.startMin)
        .map((b) => {
          const a = byId.get(b.assignmentId);
          return { time: hhmm(b.startMin), course: a?.courseCode ?? "—", title: a?.title ?? "" };
        }),
    })),
    totalMinutes,
    freeMinutes,
    sharePct: freeMinutes > 0 ? Math.round((totalMinutes / freeMinutes) * 100) : 0,
    blockCount: blocks.length,
  };

  return {
    weekStart,
    range: `${dates[0]} — ${dates[6]}`,
    days,
    courses,
    totalCredits: courses.reduce((n, c) => n + (c.credits ?? 0), 0),
    weeklyClassMinutes: courses.reduce((n, c) => n + c.weeklyMinutes, 0),
    horizon,
    beyondHorizon: ahead.length - within.length,
    study,
    audit: auditLines(week, assignments, blocks),
  };
}

/**
 * What this run actually did, in sentences.
 *
 * The most trustworthy thing on the reference's last page, and the part most
 * documents leave out: a schedule that names the parts it guessed is one you
 * can rely on, and one that hides them is one you find out about at a formation.
 */
export function auditLines(
  week: MatrixWeek | null,
  assignments: Assignment[],
  blocks: WorkBlock[],
): string[] {
  const out: string[] = [];
  if (week) {
    const a = week.audit;
    const bits: string[] = [];
    if (a.cellsBefore > 0 && a.cellsAfter > 0) {
      bits.push(`${a.cellsBefore.toLocaleString("en-US")} spreadsheet cells trimmed to ${a.cellsAfter.toLocaleString("en-US")} before Gemini saw them`);
    }
    if (a.notMine > 0) bits.push(`${a.notMine} source rows filtered out as not applying to you`);
    if (a.endsEstimated > 0) bits.push(`${a.endsEstimated} times estimated because the Matrix gives no end time`);
    if (a.ratcheted > 0) bits.push(`${a.ratcheted} marked mandatory because confidence was below the floor`);
    if (a.rowsSkipped > 0) bits.push(`${a.rowsSkipped} rows unreadable and left out`);
    if (bits.length) out.push(`${bits.join("; ")}.`);

    const confirmed = week.events.filter((e) => e.confirmedByUser).length;
    if (confirmed > 0) out.push(`${confirmed} classification${confirmed === 1 ? "" : "s"} overridden by you.`);
    if (a.model) out.push(`Read by ${a.model}.`);
    if (week.source) out.push(`Source: ${week.source.filename}.`);
  } else {
    out.push("No Matrix was loaded for this week, so nothing but your class schedule is blocking time.");
  }

  const estimated = assignments.filter((a) => a.estimateMinutes != null).length;
  if (estimated > 0 && blocks.length > 0) {
    out.push(`${estimated} effort estimates came from Gemini; every block below was placed by code into a gap it verified.`);
  }
  return out;
}
