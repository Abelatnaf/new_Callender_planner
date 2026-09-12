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
import { readCsv } from "./csv";
import { renderWorkbookForModel } from "./grid";
import { mergeAssignments, parseIcs } from "./ics";
import type { Assignment, Cadet, MatrixWeek, Term } from "./schemas";
import { shortDate } from "./time";

export type Report = { kind: "ok" | "warn" | "bad"; title: string; lines: string[] };

/** What the import is doing right now, so a long wait never reads as a hang. */
export type Stage = "reading" | "trimming" | "sending" | "thinking";
export type OnProgress = (stage: Stage, detail?: string) => void;

/**
 * How long we will wait before giving up on a route.
 *
 * Under the routes' own `maxDuration = 60`, so the browser gives up first and
 * can say something useful. A fetch that dies when the platform kills the
 * function surfaces as a bare network error with nothing to act on.
 */
const DEADLINE_MS = 55_000;

/**
 * What the import is doing, in the cadet's words.
 *
 * A thirty-second wait behind an unlabelled spinner reads as a hang. The cell
 * count is worth saying out loud too: it is the difference between "this is
 * slow" and "it just threw away six thousand cells of nothing for me".
 */
export function describeStage(stage: Stage, detail?: string): string {
  const base =
    stage === "reading" ? "Reading the file"
    : stage === "trimming" ? "Trimming the spreadsheet"
    : stage === "sending" ? "Sending"
    : "Gemini is reading your week";
  return detail ? `${base} — ${detail}` : base;
}

const n = (x: number) => x.toLocaleString("en-US");

async function postWithDeadline(url: string, body: FormData): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DEADLINE_MS);
  try {
    return await fetch(url, { method: "POST", body, headers: keyHeaders(), signal: abort.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        "Gemini took longer than a minute on this file and the request was dropped. " +
          "A smaller file, or the same one again, usually goes through.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * The Matrix, trimmed before it is sent.
 *
 * The real file is 2.4MB of which about three quarters is spreadsheet
 * fill-right residue - one row dragged across a thousand columns. Uploading
 * that and trimming it on the server means a cadet on barracks wifi waits for
 * megabytes of nothing. The trim is pure and already tested, so it runs here
 * and only the grid the model actually reads goes over the wire.
 *
 * Excel files are left alone: they are zip-compressed already, and parsing them
 * would drag a spreadsheet library into the browser bundle to save nothing.
 */
export async function importMatrix(
  file: File,
  opts: { weekStart: string; timezone: string; cadet: Cadet; onProgress?: OnProgress },
): Promise<{ report: Report; week?: MatrixWeek }> {
  const say = opts.onProgress ?? (() => {});
  try {
    const form = new FormData();
    form.set("weekStart", opts.weekStart);
    form.set("timezone", opts.timezone);
    form.set("cadet", JSON.stringify(opts.cadet));

    const isCsv = /\.(csv|tsv)$/i.test(file.name) || /csv|tab-separated/i.test(file.type);

    if (isCsv) {
      say("reading", `${(file.size / 1e6).toFixed(1)}MB`);
      const text = await file.text();

      say("trimming");
      const wb = readCsv(text, file.name);
      if (wb.sheets.length === 0) throw new Error("That CSV appears to be empty.");
      const cellsBefore = wb.sheets.reduce((t, sh) => t + sh.cells.length, 0);
      // A cadet with no team cannot act on twelve columns of per-sport
      // attendance, and on the real file they are 55% of the payload.
      const grid = renderWorkbookForModel(wb, {
        dropSportColumns: opts.cadet.athletics === "none",
      });
      // renderWorkbookForModel trims as it renders, so the honest "after" count
      // is what survived into the text the model will actually see.
      const cellsAfter = grid.split("\n").reduce((t, line) => t + line.split("\t").filter(Boolean).length, 0);

      form.set("grid", grid);
      form.set("filename", file.name);
      form.set("cellsBefore", String(cellsBefore));
      form.set("cellsAfter", String(cellsAfter));
      say("sending", `${n(cellsBefore)} cells trimmed to ${n(cellsAfter)} — sending ${(grid.length / 1024).toFixed(0)}KB instead of ${(file.size / 1024).toFixed(0)}KB`);
    } else {
      say("reading", `${(file.size / 1e6).toFixed(1)}MB`);
      form.set("file", file);
      say("sending");
    }

    say("thinking");
    const res = await postWithDeadline("/api/parse/matrix", form);
    if (!res.ok) await readFailure(res);
    const data = await res.json();

    const week = data.week as MatrixWeek;
    const mine = week.events.filter((e) => e.appliesToMe !== false);
    const blocked = mine.filter((e) => e.availability === "BLOCKED").length;
    const a = week.audit;

    return {
      week,
      report: {
        kind: data.ratchetedCount > 0 || a.rowsSkipped > 0 ? "warn" : "ok",
        title: `Read ${week.events.length} events for the week of ${shortDate(week.weekStart)}`,
        lines: [
          `${mine.length} apply to you — ${blocked} mandatory, ${mine.length - blocked} usable.`,
          ...(data.notMine > 0
            ? [`${data.notMine} belong to other companies, classes or the Band — kept for reference, but they do not take your time.`]
            : []),
          ...(data.ratchetedCount > 0
            ? [`${data.ratchetedCount} were marked mandatory because Gemini was not confident. Review them below — you may have more free time than shown.`]
            : []),
          // Partial success is stated, never silent: a week that kept 40 of 43
          // rows is useful, but only if you know about the 3.
          ...(a.rowsSkipped > 0
            ? [`${a.rowsSkipped} row${a.rowsSkipped === 1 ? "" : "s"} could not be read and ${a.rowsSkipped === 1 ? "was" : "were"} left out — the rest came through.`]
            : []),
          ...(a.endsEstimated > 0
            ? [`${a.endsEstimated} had a start but no end time, so their lengths are estimates.`]
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

export async function importTerm(
  payload: FormData,
  onProgress?: OnProgress,
): Promise<{ report: Report; term?: Term }> {
  try {
    onProgress?.("thinking");
    const res = await postWithDeadline("/api/parse/term", payload);
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
