/**
 * Canvas .ics parser.
 *
 * Deliberately deterministic: no model involved. An iCalendar file is a precise
 * format, and handing a precise format to a language model only buys you the
 * chance of a hallucinated deadline. Gemini is for the Matrix, which is a human
 * artifact; this is machine output and is parsed as such.
 *
 * Implements the parts of RFC 5545 that Canvas actually emits: line unfolding,
 * property parameters, TEXT escaping, and the three DATE-TIME forms.
 */
import type { Assignment, AssignmentKind } from "./schemas";
import {
  DEFAULT_TZ,
  type LocalDate,
  instantToLocal,
  toEpochDay,
} from "./time";

type Prop = { name: string; params: Record<string, string>; value: string };
type RawEvent = Record<string, Prop[]>;

/* -------------------------------------------------------------- unfolding */

/**
 * RFC 5545 folds long lines by inserting CRLF followed by a single space or
 * tab. Unfolding must happen before anything else or values are silently cut.
 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.trim() !== "");
}

/** NAME;PARAM=value;PARAM2="quoted:value":the actual value */
function parseLine(line: string): Prop | null {
  // The value begins at the first colon that is not inside a quoted parameter.
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) { colon = i; break; }
  }
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/** Reverse RFC 5545 TEXT escaping. */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/* --------------------------------------------------------------- date-time */

/** ms offset of `tz` from UTC at a given instant. */
function tzOffsetMs(instant: Date, tz: string): number {
  const { date, minutes } = instantToLocal(instant, tz);
  const asIfUTC = toEpochDay(date) * 86_400_000 + minutes * 60_000;
  return asIfUTC - instant.getTime();
}

/**
 * Turn a wall-clock time in a named zone into a real instant.
 * Two passes, because the offset depends on the instant we are solving for.
 */
function zonedWallToInstant(
  y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = new Date(guess - tzOffsetMs(new Date(guess), tz));
  const second = new Date(guess - tzOffsetMs(first, tz));
  return second;
}

export type ParsedDateTime = { date: LocalDate; minutes: number; allDay: boolean };

/**
 * DTSTART comes in three shapes:
 *   20260915                       a floating DATE  (all-day)
 *   20260915T035900Z               a UTC instant
 *   20260915T235900 (+TZID param)  wall time in a named zone
 */
export function parseDateTime(prop: Prop, tz: string = DEFAULT_TZ): ParsedDateTime | null {
  const v = prop.value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || prop.params.VALUE === "DATE") {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: 0, allDay: true };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dt) return null;

  const [, Y, Mo, D, H, Mi, S, zulu] = dt;
  const nums = [+Y, +Mo, +D, +H, +Mi, +S] as const;

  if (zulu) {
    const inst = new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]));
    return { ...instantToLocal(inst, tz), allDay: false };
  }

  const tzid = prop.params.TZID;
  if (tzid && tzid !== tz) {
    try {
      const inst = zonedWallToInstant(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], tzid);
      return { ...instantToLocal(inst, tz), allDay: false };
    } catch {
      // Unknown zone id: fall through and treat the wall time as already local.
    }
  }

  // Floating time, or a TZID that matches ours: the wall clock is the answer.
  return { date: `${Y}-${Mo}-${D}`, minutes: +H * 60 + +Mi, allDay: false };
}

/* ------------------------------------------------------------------ events */

function splitEvents(lines: string[]): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;

  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN" && prop.value === "VEVENT") { current = {}; continue; }
    if (prop.name === "END" && prop.value === "VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    (current[prop.name] ??= []).push(prop);
  }
  return events;
}

const first = (e: RawEvent, name: string): Prop | undefined => e[name]?.[0];

/** Canvas writes "Assignment title [COURSE-CODE-SECTION]". */
export function splitSummary(summary: string): { title: string; courseCode?: string } {
  const m = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(summary.trim());
  if (!m) return { title: summary.trim() };
  // A bracket that is not a course code is part of the title, not a course.
  if (!looksLikeCourseCode(m[2])) return { title: summary.trim() };
  return { title: m[1].trim(), courseCode: normalizeCourseCode(m[2]) };
}

/**
 * "MATH-171-01" -> "MATH 171", "CIS-111L-03 and 04" -> "CIS 111L".
 *
 * The trailing letter is load-bearing: CIS 111L is the lab and CIS 111 is the
 * lecture, they meet at different times, and dropping the L silently merged two
 * real courses into one.
 */
export function normalizeCourseCode(raw: string): string {
  const cleaned = raw.trim();
  const m = /^([A-Za-z]{2,6})[-_\s]*(\d{2,4})([A-Za-z]?)/.exec(cleaned);
  return m ? `${m[1].toUpperCase()} ${m[2]}${m[3].toUpperCase()}` : cleaned;
}

/**
 * Does this bracket hold a course code at all?
 *
 * Canvas also brackets things like "Core Competency Module (Class 27+3)", which
 * is a title. Accepting it as a course code puts a phantom course in the
 * backlog and gives it a colour of its own.
 */
export function looksLikeCourseCode(raw: string): boolean {
  return /^[A-Za-z]{2,6}[-_\s]*\d{2,4}[A-Za-z]?\b/.test(raw.trim());
}

const KIND_PATTERNS: Array<[RegExp, AssignmentKind]> = [
  [/\b(final|midterm|exam)\b/i, "exam"],
  [/\b(quiz|test)\b/i, "quiz"],
  [/\b(paper|essay|write[- ]?up|reflection)\b/i, "paper"],
  [/\b(problem set|p\.?set|homework|hw|exercises?)\b/i, "problem_set"],
  [/\b(lab)\b/i, "lab"],
  [/\b(project|presentation|deliverable)\b/i, "project"],
  [/\b(read(ing)?|chapter|ch\.)\b/i, "reading"],
];

export function inferKind(title: string): AssignmentKind {
  for (const [re, kind] of KIND_PATTERNS) if (re.test(title)) return kind;
  return "other";
}

export type IcsParseResult = {
  assignments: Assignment[];
  skipped: number;
  calendarName?: string;
};

/**
 * Parse a Canvas calendar feed into assignments.
 *
 * Canvas emits both assignments (UID `event-assignment-*`) and plain calendar
 * events. Both are imported - a cadet's Canvas calendar carries real deadlines
 * in either form - but assignment UIDs are preferred for dedupe.
 */
export function parseIcs(text: string, tz: string = DEFAULT_TZ): IcsParseResult {
  const lines = unfold(text);
  const calendarName = (() => {
    for (const l of lines) {
      const p = parseLine(l);
      if (p && (p.name === "X-WR-CALNAME" || p.name === "NAME")) return unescapeText(p.value);
    }
    return undefined;
  })();

  const assignments: Assignment[] = [];
  let skipped = 0;

  for (const raw of splitEvents(lines)) {
    const summaryProp = first(raw, "SUMMARY");
    if (!summaryProp) { skipped++; continue; }

    // Canvas repeats the due time in DTSTART for assignments; DUE wins if sent.
    const timeProp = first(raw, "DUE") ?? first(raw, "DTSTART") ?? first(raw, "DTEND");
    if (!timeProp) { skipped++; continue; }

    const when = parseDateTime(timeProp, tz);
    if (!when) { skipped++; continue; }

    const summary = unescapeText(summaryProp.value);
    const { title, courseCode } = splitSummary(summary);
    if (!title) { skipped++; continue; }

    const uid = first(raw, "UID")?.value;
    const url = first(raw, "URL")?.value;
    const description = first(raw, "DESCRIPTION")?.value;

    assignments.push({
      // An all-day item is due at the end of that day, not at midnight - a
      // "due Tuesday" reading is not due before Monday night is over.
      id: uid ? `canvas:${uid}` : `canvas:${title}:${when.date}`,
      title,
      courseCode,
      dueDate: when.date,
      dueMin: when.allDay ? 23 * 60 + 59 : when.minutes,
      kind: inferKind(title),
      status: "todo",
      source: "canvas",
      uid,
      url,
      notes: description ? unescapeText(description).replace(/<[^>]+>/g, "").trim() || undefined : undefined,
    });
  }

  return { assignments, skipped, calendarName };
}

/**
 * Merge a fresh import over what is already stored.
 *
 * Re-importing must never wipe the cadet's own work: `status`, hand-tuned
 * `estimateMinutes`, `priority` and manual entries all survive. Canvas remains
 * authoritative for the things Canvas owns - title, due date, url.
 */
export function mergeAssignments(
  existing: Assignment[],
  incoming: Assignment[],
): { merged: Assignment[]; added: number; updated: number; removed: number } {
  const key = (a: Assignment) => a.uid ?? a.id;
  const byKey = new Map(existing.map((a) => [key(a), a]));
  const incomingKeys = new Set(incoming.map(key));

  let added = 0;
  let updated = 0;
  const merged: Assignment[] = [];

  for (const next of incoming) {
    const prev = byKey.get(key(next));
    if (!prev) {
      merged.push(next);
      added++;
      continue;
    }
    const changed = prev.dueDate !== next.dueDate || prev.dueMin !== next.dueMin || prev.title !== next.title;
    if (changed) updated++;
    merged.push({
      ...next,
      status: prev.status,
      estimateMinutes: prev.estimateMinutes,
      priority: prev.priority,
      notes: prev.notes ?? next.notes,
    });
  }

  // Manual entries are never dropped by a Canvas import.
  const manual = existing.filter((a) => a.source === "manual" && !incomingKeys.has(key(a)));
  const droppedCanvas = existing.filter((a) => a.source === "canvas" && !incomingKeys.has(key(a)));

  return {
    merged: [...merged, ...manual].sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.dueMin - b.dueMin,
    ),
    added,
    updated,
    removed: droppedCanvas.length,
  };
}
