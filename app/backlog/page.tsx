"use client";

/**
 * BACKLOG — everything with a deadline, ranked by how soon it bites.
 *
 * The estimate column is editable on purpose: a number the cadet types always
 * beats a number the model guessed, and the planner honours that override.
 */
import { useMemo, useState } from "react";
import { useVault } from "@/lib/store";
import type { Assignment, AssignmentKind } from "@/lib/schemas";
import { isOverdue, isUrgent } from "@/lib/layout";
import {
  WEEKDAY_LONG, daysBetween, formatDuration, hhmm, instantToLocal, shortDate, stamp, weekdayOf,
} from "@/lib/time";

type Filter = "open" | "all" | "done";

export default function BacklogPage() {
  const api = useVault();
  const { vault, ready } = api;
  const [filter, setFilter] = useState<Filter>("open");

  const now = instantToLocal(new Date(), vault.settings.timezone);
  const nowStamp = stamp(now.date, now.minutes);

  const rows = useMemo(() => {
    const list = vault.assignments.filter((a) =>
      filter === "all" ? true : filter === "done" ? a.status === "done" : a.status !== "done",
    );
    return [...list].sort(
      (a, b) => stamp(a.dueDate, a.dueMin) - stamp(b.dueDate, b.dueMin),
    );
  }, [vault.assignments, filter]);

  const patch = (id: string, p: Partial<Assignment>) =>
    api.setAssignments(vault.assignments.map((a) => (a.id === id ? { ...a, ...p } : a)));

  const addManual = () => {
    const today = now.date;
    api.setAssignments([
      ...vault.assignments,
      {
        id: `manual:${Date.now()}`,
        title: "New item",
        dueDate: today,
        dueMin: 23 * 60 + 59,
        kind: "other" as AssignmentKind,
        status: "todo",
        source: "manual",
      },
    ]);
  };

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  const open = vault.assignments.filter((a) => a.status !== "done");
  const totalEstimate = open.reduce((n, a) => n + (a.estimateMinutes ?? 0), 0);
  const unestimated = open.filter((a) => !a.estimateMinutes).length;

  return (
    <div className="wrap">
      <section className="section">
        <div className="section-head">
          <div>
            <div className="label">Everything with a deadline</div>
            <h1 className="display" style={{ fontSize: "var(--t-3xl)" }}>Backlog</h1>
          </div>
          <div className="toolbar no-print">
            <div className="seg">
              {(["open", "all", "done"] as Filter[]).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            <button className="btn btn--sm" onClick={addManual}>+ Add by hand</button>
          </div>
        </div>

        <div className="tallies">
          <div className="tally">
            <span className="tally__n">{open.length}</span>
            <span className="tally__l">Still open</span>
          </div>
          <div className="tally">
            <span className="tally__n">{formatDuration(totalEstimate)}</span>
            <span className="tally__l">Estimated work left</span>
          </div>
          <div className={`tally${open.filter((a) => isOverdue(a, nowStamp)).length ? " tally--signal" : ""}`}>
            <span className="tally__n">{open.filter((a) => isOverdue(a, nowStamp)).length}</span>
            <span className="tally__l">Overdue</span>
          </div>
          <div className="tally">
            <span className="tally__n">{unestimated}</span>
            <span className="tally__l">Not yet estimated</span>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="prose" style={{ marginTop: "var(--u-4)" }}>
            Nothing here. Drop your Canvas .ics on the Intake page, or add something by hand.
          </p>
        ) : (
          <div className="scroll-x" style={{ marginTop: "var(--u-4)" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}><span className="sr-only">Done</span></th>
                  <th>Due</th>
                  <th>Course</th>
                  <th>Item</th>
                  <th>Kind</th>
                  <th style={{ width: 110 }}>Estimate</th>
                  <th>In</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const overdue = isOverdue(a, nowStamp);
                  const urgent = isUrgent(a, nowStamp);
                  const days = daysBetween(now.date, a.dueDate);
                  return (
                    <tr key={a.id} style={overdue ? { background: "var(--signal-wash)" } : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={a.status === "done"}
                          onChange={(e) => patch(a.id, { status: e.target.checked ? "done" : "todo" })}
                          aria-label={`Mark ${a.title} done`}
                        />
                      </td>
                      <td className="num-cell" style={overdue || urgent ? { color: "var(--signal)", fontWeight: 700 } : undefined}>
                        {WEEKDAY_LONG[weekdayOf(a.dueDate)].slice(0, 3)} {shortDate(a.dueDate)} {hhmm(a.dueMin)}
                      </td>
                      <td className="num-cell">{a.courseCode ?? "—"}</td>
                      <td style={a.status === "done" ? { textDecoration: "line-through", color: "var(--ink-3)" } : undefined}>
                        {a.source === "manual" ? (
                          <input
                            className="input" style={{ minHeight: 28, padding: "2px 6px" }}
                            value={a.title}
                            onChange={(e) => patch(a.id, { title: e.target.value })}
                          />
                        ) : a.url ? (
                          <a href={a.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{a.title}</a>
                        ) : a.title}
                      </td>
                      <td className="muted">{a.kind.replace("_", " ")}</td>
                      <td>
                        <input
                          className="input"
                          style={{ minHeight: 28, padding: "2px 6px", width: 92 }}
                          type="number" min={0} step={15}
                          placeholder="—"
                          value={a.estimateMinutes ?? ""}
                          onChange={(e) => patch(a.id, {
                            estimateMinutes: e.target.value === "" ? undefined : Number(e.target.value),
                          })}
                          aria-label={`Estimate in minutes for ${a.title}`}
                        />
                      </td>
                      <td className="num-cell muted">
                        {overdue ? <span className="signal">overdue</span> : days === 0 ? "today" : `${days}d`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
