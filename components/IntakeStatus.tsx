"use client";

/**
 * What is loaded, and what is not.
 *
 * Three files feed this app and each arrives on its own schedule: the semester
 * once a term, the Matrix every week, Canvas whenever deadlines move. Without a
 * single place that states which of the three are in, the only way to find out
 * is to look at a week that reads wrong and guess which input is missing. A
 * week with no Matrix looks exactly like a week with nothing on - and those are
 * opposite situations.
 *
 * The fourth row answers a different question the cadet keeps having to ask by
 * uploading something: is this deployment's own Gemini key actually live?
 */
import Link from "next/link";
import { useHealth } from "@/lib/apikey";
import { weekFor } from "@/lib/store";
import type { Vault } from "@/lib/schemas";
import { shortDate } from "@/lib/time";

type State = "in" | "out" | "stale";

type Row = {
  key: string;
  label: string;
  state: State;
  headline: string;
  detail: string[];
  href?: string;
  action?: string;
};

/** "3 hours ago" beats a timestamp for the only question anyone asks of one. */
function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function IntakeStatus({
  vault,
  weekStart,
  compact = false,
}: {
  vault: Vault;
  weekStart: string;
  compact?: boolean;
}) {
  const health = useHealth();
  const rows: Row[] = [];

  /* ------------------------------------------------------------ semester */
  const term = vault.term;
  rows.push(
    term
      ? {
          key: "term",
          label: "Semester",
          state: "in",
          headline: `${term.courses.length} course${term.courses.length === 1 ? "" : "s"}`,
          detail: [term.name, term.source?.filename ?? "entered by hand", ago(term.source?.importedAt)].filter(Boolean),
          href: "/setup",
          action: "Edit",
        }
      : {
          key: "term",
          label: "Semester",
          state: "out",
          headline: "Not loaded",
          detail: ["Your classes are not carving up the week, so free time reads high."],
          href: "/setup",
          action: "Load it",
        },
  );

  /* -------------------------------------------------------------- matrix */
  const week = weekFor(vault, weekStart);
  const newest = [...vault.matrixWeeks].sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
  if (week) {
    const mine = week.events.filter((e) => e.appliesToMe !== false).length;
    const a = week.audit;
    rows.push({
      key: "matrix",
      label: "Matrix",
      state: "in",
      headline: `${week.events.length} events, ${mine} yours`,
      detail: [
        `Week of ${shortDate(week.weekStart)}`,
        week.source?.filename ?? "",
        ago(week.source?.importedAt),
        a.endsEstimated > 0 ? `${a.endsEstimated} end times estimated` : "",
      ].filter(Boolean),
      href: "/intake",
      action: "Review",
    });
  } else if (newest) {
    rows.push({
      key: "matrix",
      label: "Matrix",
      state: "stale",
      headline: `Loaded for a different week`,
      detail: [
        `You have the week of ${shortDate(newest.weekStart)}, not ${shortDate(weekStart)}.`,
        "This week's obligations are missing, so nothing is blocking your time.",
      ],
      href: "/intake",
      action: "Upload this week",
    });
  } else {
    rows.push({
      key: "matrix",
      label: "Matrix",
      state: "out",
      headline: "Not loaded",
      detail: ["No formations, parades or CQ — every hour will read as free."],
      href: "/intake",
      action: "Upload it",
    });
  }

  /* -------------------------------------------------------------- canvas */
  const count = vault.assignments.length;
  const courses = new Set(vault.assignments.map((a) => a.courseCode).filter(Boolean)).size;
  const open = vault.assignments.filter((a) => a.status !== "done").length;
  rows.push(
    count > 0
      ? {
          key: "canvas",
          label: "Canvas",
          state: "in",
          headline: `${count} assignments, ${open} open`,
          detail: [`${courses} course${courses === 1 ? "" : "s"}`, ago(vault.canvasImportedAt)].filter(Boolean),
          href: "/backlog",
          action: "Open backlog",
        }
      : {
          key: "canvas",
          label: "Canvas",
          state: "out",
          headline: "Not loaded",
          detail: ["Nothing to plan around — the week will have no deadlines in it."],
          href: "/intake",
          action: "Upload the .ics",
        },
  );

  /* ---------------------------------------------------------- connection */
  if (health) {
    const problem = health.keyProblem ?? (health.keyNeedsTrim ? "The key has whitespace around it — trim it and redeploy." : null);
    rows.push(
      health.serverKey
        ? {
            key: "gemini",
            label: "Gemini",
            state: problem ? "stale" : "in",
            headline: problem ? "Key set, but wrong" : "Connected on the server",
            detail: problem
              ? [problem]
              : ["You will never be asked for a key here.", `Trying ${health.models.parse[0]} first.`],
          }
        : {
            key: "gemini",
            label: "Gemini",
            state: "out",
            headline: "No server key",
            detail: [
              "Requests use the key stored in this browser.",
              "Set GEMINI_API_KEY in your hosting environment to stop being asked.",
            ],
          },
    );
  }

  return (
    <div className={`status${compact ? " status--compact" : ""}`} aria-label="What is loaded">
      {rows.map((r) => (
        <div key={r.key} className={`status__row status__row--${r.state}`}>
          <span className="status__dot" aria-hidden="true" />
          <div className="status__body">
            <div className="status__top">
              <span className="status__label">{r.label}</span>
              <span className="status__headline">{r.headline}</span>
            </div>
            {!compact && r.detail.length > 0 && (
              <div className="status__detail">{r.detail.join(" · ")}</div>
            )}
          </div>
          <span className="sr-only">
            {r.state === "in" ? "loaded" : r.state === "stale" ? "needs attention" : "missing"}
          </span>
          {r.href && (
            <Link className="btn btn--sm" href={r.href}>
              {r.action}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
