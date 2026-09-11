/**
 * Gemini responses -> internal types.
 *
 * This is where the availability ratchet is actually enforced. The prompt asks
 * the model to prefer BLOCKED when unsure; this file makes that true whether or
 * not the model complied. A prompt is a request. Code is a guarantee.
 */
import type {
  Assignment, Availability, Course, GeminiMatrixResponse, GeminiTermResponse,
  MatrixEvent, MatrixWeek, Term,
} from "./schemas";
import { type LocalDate, WEEKDAYS, addDays, toMinutes, weekStart } from "./time";

/**
 * Below this confidence, a non-blocking classification is not trusted.
 *
 * The asymmetry is the whole point: forcing BLOCKED costs the cadet study time
 * they might have had. Trusting a wrong USABLE sends them to the library during
 * a formation. We pay the cheap error every time.
 */
export const CONFIDENCE_FLOOR = 0.75;

export function applyRatchet(
  availability: Availability,
  confidence: number,
): { availability: Availability; ratcheted: boolean } {
  if (availability === "BLOCKED") return { availability, ratcheted: false };
  if (confidence < CONFIDENCE_FLOOR) return { availability: "BLOCKED", ratcheted: true };
  return { availability, ratcheted: false };
}

const DAY_INDEX: Record<string, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

export type MatrixConversion = {
  week: MatrixWeek;
  /** Events whose classification the code overrode, for the review screen. */
  ratchetedCount: number;
  /** Events the model itself flagged as uncertain. */
  lowConfidence: MatrixEvent[];
  warnings: string[];
};

export function toMatrixWeek(
  response: GeminiMatrixResponse,
  filename: string,
  fallbackWeekStart?: LocalDate,
): MatrixConversion {
  const warnings: string[] = [];

  let monday = response.weekStartDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) {
    monday = fallbackWeekStart ?? weekStart(new Date().toISOString().slice(0, 10));
    warnings.push("The Matrix did not state its week; used the current week instead.");
  } else {
    const normalized = weekStart(monday);
    if (normalized !== monday) {
      warnings.push(`Week start ${monday} was not a Monday; using ${normalized}.`);
      monday = normalized;
    }
  }

  const events: MatrixEvent[] = [];
  let ratchetedCount = 0;

  for (const [i, raw] of response.events.entries()) {
    let startMin: number;
    let endMin: number;
    try {
      startMin = toMinutes(raw.start);
      endMin = toMinutes(raw.end);
    } catch {
      warnings.push(`Skipped "${raw.title}" - could not read its times (${raw.start}-${raw.end}).`);
      continue;
    }

    // An event that ends before it starts almost always means it crosses
    // midnight; clamp it to end of day rather than silently inverting.
    if (endMin <= startMin) {
      if (endMin === startMin) {
        warnings.push(`"${raw.title}" had zero length; skipped.`);
        continue;
      }
      warnings.push(`"${raw.title}" ended before it started; clamped to end of day.`);
      endMin = 24 * 60;
    }

    const offset = DAY_INDEX[raw.day];
    if (offset === undefined) {
      warnings.push(`Skipped "${raw.title}" - unrecognized day "${raw.day}".`);
      continue;
    }

    const { availability, ratcheted } = applyRatchet(raw.availability, raw.confidence);
    if (ratcheted) ratchetedCount++;

    events.push({
      id: `MX-${monday}-${String(i + 1).padStart(3, "0")}`,
      title: raw.title.trim() || raw.raw.trim() || "Untitled",
      raw: raw.raw,
      date: addDays(monday, offset),
      startMin,
      endMin,
      kind: raw.kind,
      availability,
      confidence: raw.confidence,
      note: raw.note,
      confirmedByUser: false,
      ratcheted,
    });
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

  if (events.length === 0) {
    warnings.push("No events were found in this file. Is it the right sheet?");
  }

  return {
    week: {
      id: `MW-${monday}`,
      weekStart: monday,
      events,
      source: { filename, importedAt: new Date().toISOString() },
    },
    ratchetedCount,
    lowConfidence: events.filter((e) => e.confidence < CONFIDENCE_FLOOR || e.ratcheted),
    warnings,
  };
}

export type TermConversion = { term: Term; warnings: string[] };

export function toTerm(response: GeminiTermResponse, filename: string): TermConversion {
  const warnings: string[] = [];
  const courses: Course[] = [];

  for (const [i, c] of response.courses.entries()) {
    const meetings: Course["meetings"] = [];
    for (const m of c.meetings) {
      try {
        const startMin = toMinutes(m.start);
        const endMin = toMinutes(m.end);
        if (endMin <= startMin) {
          warnings.push(`${c.code}: a meeting ended before it started; skipped.`);
          continue;
        }
        const days = m.days.filter((d) => WEEKDAYS.includes(d));
        if (days.length === 0) {
          warnings.push(`${c.code}: a meeting had no valid days; skipped.`);
          continue;
        }
        meetings.push({ days, startMin, endMin, location: m.location });
      } catch {
        warnings.push(`${c.code}: could not read times "${m.start}-${m.end}"; skipped.`);
      }
    }

    if (meetings.length === 0) {
      warnings.push(`${c.code} has no readable meeting times - add them by hand.`);
    }

    courses.push({
      id: `C-${String(i + 1).padStart(2, "0")}`,
      code: c.code.trim(),
      title: c.title.trim(),
      instructor: c.instructor,
      credits: c.credits,
      meetings,
    });
  }

  return {
    term: {
      id: `T-${Date.now()}`,
      name: response.name.trim() || "Untitled term",
      startDate: response.startDate,
      endDate: response.endDate,
      courses,
      source: { filename, importedAt: new Date().toISOString() },
    },
    warnings,
  };
}

/** Merge model effort estimates back onto the backlog without losing user edits. */
export function applyEstimates(
  assignments: Assignment[],
  estimates: Array<{ assignmentId: string; estimateMinutes: number; priority: number; kind: Assignment["kind"] }>,
): Assignment[] {
  const byId = new Map(estimates.map((e) => [e.assignmentId, e]));
  return assignments.map((a) => {
    const e = byId.get(a.id);
    if (!e) return a;
    return {
      ...a,
      // A number the cadet typed always beats a number the model guessed.
      estimateMinutes: a.estimateMinutes ?? e.estimateMinutes,
      priority: a.priority ?? e.priority,
      kind: a.kind === "other" ? e.kind : a.kind,
    };
  });
}
