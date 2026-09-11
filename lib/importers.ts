"use client";

/**
 * The three imports, in one place.
 *
 * Both screens can run all three, because a file is routed by what it is rather
 * than by which box it landed in (see lib/detect.ts). Each function does the
 * work and hands back the data plus a report; committing to the vault stays
 * with the page, so nothing here needs the store.
 */
import { keyHeaders } from "./apikey";
import { mergeAssignments, parseIcs } from "./ics";
import type { Assignment, Cadet, MatrixWeek, Term } from "./schemas";
import { shortDate } from "./time";

export type Report = { kind: "ok" | "warn" | "bad"; title: string; lines: string[] };

/** A failed route says what went wrong and, when it helps, what was tried. */
async function readFailure(res: Response): Promise<never> {
  let data: { error?: string; detail?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* a proxy or a crash, not our JSON */
  }
  const message = data.error ?? `The server answered ${res.status}.`;
  throw new Error(data.detail ? `${message} (${data.detail})` : message);
}

const said = (e: unknown) => (e instanceof Error ? e.message : "Unknown error.");

/* ------------------------------------------------------------------ canvas */

export function importCanvas(
  text: string,
  current: Assignment[],
  timezone: string,
): { report: Report; assignments?: Assignment[] } {
  try {
    const { assignments, skipped, calendarName } = parseIcs(text, timezone);
    if (assignments.length === 0) {
      throw new Error("No assignments found. Is this the Canvas Calendar Feed .ics?");
    }
    const { merged, added, updated, removed } = mergeAssignments(current, assignments);
    return {
      assignments: merged,
      report: {
        kind: "ok",
        title: `${merged.length} assignments on the books`,
        lines: [
          `${added} new, ${updated} with changed deadlines, ${removed} no longer in Canvas.`,
          "Your statuses, estimates and manual entries were preserved.",
          ...(calendarName ? [`Feed: ${calendarName}`] : []),
          ...(skipped ? [`${skipped} entries had no usable date and were skipped.`] : []),
        ],
      },
    };
  } catch (e) {
    return { report: { kind: "bad", title: "Canvas import failed", lines: [said(e)] } };
  }
}

/* ------------------------------------------------------------------ matrix */

export async function importMatrix(
  file: File,
  opts: { weekStart: string; timezone: string; cadet: Cadet },
): Promise<{ report: Report; week?: MatrixWeek }> {
  try {
    const form = new FormData();
    form.set("file", file);
    form.set("weekStart", opts.weekStart);
    form.set("timezone", opts.timezone);
    form.set("cadet", JSON.stringify(opts.cadet));

    const res = await fetch("/api/parse/matrix", { method: "POST", body: form, headers: keyHeaders() });
    if (!res.ok) await readFailure(res);
    const data = await res.json();

    const week = data.week as MatrixWeek;
    const mine = week.events.filter((e) => e.appliesToMe !== false);
    const blocked = mine.filter((e) => e.availability === "BLOCKED").length;

    return {
      week,
      report: {
        kind: data.ratchetedCount > 0 ? "warn" : "ok",
        title: `Read ${week.events.length} events for the week of ${shortDate(week.weekStart)}`,
        lines: [
          `${mine.length} apply to you — ${blocked} mandatory, ${mine.length - blocked} usable.`,
          ...(data.notMine > 0
            ? [`${data.notMine} belong to other companies, classes or the Band — kept for reference, but they do not take your time.`]
            : []),
          ...(data.ratchetedCount > 0
            ? [`${data.ratchetedCount} were marked mandatory because Gemini was not confident. Review them below — you may have more free time than shown.`]
            : []),
          ...((data.warnings ?? []) as string[]),
        ],
      },
    };
  } catch (e) {
    return { report: { kind: "bad", title: "Matrix import failed", lines: [said(e)] } };
  }
}

/* -------------------------------------------------------------------- term */

export async function importTerm(payload: FormData): Promise<{ report: Report; term?: Term }> {
  try {
    const res = await fetch("/api/parse/term", { method: "POST", body: payload, headers: keyHeaders() });
    if (!res.ok) await readFailure(res);
    const data = await res.json();
    const term = data.term as Term;
    return {
      term,
      report: {
        kind: "ok",
        title: `${term.name}: ${term.courses.length} courses`,
        lines: [
          "Check the meeting times below before you rely on them.",
          ...((data.warnings ?? []) as string[]),
        ],
      },
    };
  } catch (e) {
    return { report: { kind: "bad", title: "Import failed", lines: [said(e)] } };
  }
}
