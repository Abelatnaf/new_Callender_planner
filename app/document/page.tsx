"use client";

/**
 * THE DOCUMENT.
 *
 * This is the thing the cadet actually carries. The screen and the printout are
 * the same artifact - the design was built print-native, so nothing is
 * rearranged at print time except the page breaks.
 *
 * Every plan is audited before it is rendered. If a block has drifted onto an
 * obligation since it was generated, that is said on the page rather than
 * printed as though it were fine.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Ribbon, RibbonScale } from "@/components/Ribbon";
import { useVault, planFor, weekFor } from "@/lib/store";
import { buildWeekInventory, labeledMeetingsOn } from "@/lib/gaps";
import { auditPlan } from "@/lib/validate";
import { isOverdue, isUrgent } from "@/lib/layout";
import {
  WEEKDAY_LONG, addDays, dateParts, formatDuration, hhmm, instantToLocal,
  shortDate, stamp, todayLocal, weekDates, weekStart, weekdayOf,
} from "@/lib/time";

export default function DocumentPage() {
  const { vault: v, ready } = useVault();
  const [offset, setOffset] = useState(0);

  const tz = v.settings.timezone;
  const monday = useMemo(
    () => addDays(weekStart(todayLocal(tz)), offset * 7),
    [tz, offset],
  );

  const week = weekFor(v, monday);
  const plan = planFor(v, monday);
  const events = week?.events ?? [];
  const inventory = useMemo(
    () => buildWeekInventory(monday, v.term, events, v.settings),
    [monday, v.term, events, v.settings],
  );

  const now = instantToLocal(new Date(), tz);
  const nowStamp = stamp(now.date, now.minutes);
  const axis = { startMin: v.settings.dayStartMin, endMin: v.settings.dayEndMin };
  const byId = new Map(v.assignments.map((a) => [a.id, a]));

  const problems = plan ? auditPlan(plan, inventory, v.assignments) : [];

  const dueThisWeek = v.assignments
    .filter((a) => a.status !== "done")
    .filter((a) => {
      const d = weekDates(monday);
      return a.dueDate >= d[0] && a.dueDate <= addDays(d[6], 7);
    })
    .sort((a, b) => stamp(a.dueDate, a.dueMin) - stamp(b.dueDate, b.dueMin));

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  const range = `${shortDate(monday)} – ${shortDate(weekDates(monday)[6])}`;

  return (
    <div className="wrap">
      <div className="toolbar no-print" style={{ paddingBlock: "var(--s-6)" }}>
        <button className="btn btn--sm" onClick={() => setOffset((o) => o - 1)}>←</button>
        <span className="label label--ink">Week of {shortDate(monday)}</span>
        <button className="btn btn--sm" onClick={() => setOffset((o) => o + 1)}>→</button>
        <button className="btn btn--solid" onClick={() => window.print()}>Print / Save as PDF</button>
        {!plan && <Link className="btn" href="/">Generate a plan first →</Link>}
      </div>

      {problems.length > 0 && (
        <div className="notice notice--signal no-print" style={{ marginBottom: "var(--s-6)" }}>
          <div className="notice__title">{problems.length} block{problems.length > 1 ? "s" : ""} no longer fit</div>
          The schedule changed after this plan was made. Re-plan the week before printing —
          these blocks currently collide with something or sit past a deadline.
        </div>
      )}

      {/* ================================================= SHEET 1 — the week */}
      <section className="sheet">
        <header className="sheet__head print-only">
          <span className="sheet__title">Weekly Order</span>
          <span className="sheet__meta">{range}</span>
        </header>

        <div className="section-head no-print">
          <h1 className="display" style={{ fontSize: "var(--t-title2)" }}>Weekly Order</h1>
          <span className="label">{range}</span>
        </div>

        <div className="tallies avoid-break">
          <div className="tally">
            <span className="tally__n">{formatDuration(inventory.freeMinutes)}</span>
            <span className="tally__l">Yours</span>
          </div>
          <div className="tally">
            <span className="tally__n">{formatDuration((plan?.blocks ?? []).reduce((n, b) => n + b.endMin - b.startMin, 0))}</span>
            <span className="tally__l">Committed</span>
          </div>
          <div className="tally">
            <span className="tally__n">{dueThisWeek.length}</span>
            <span className="tally__l">Due</span>
          </div>
          <div className="tally">
            <span className="tally__n">{inventory.gaps.length}</span>
            <span className="tally__l">Usable slots</span>
          </div>
        </div>

        <div className="ribbon-board" style={{ marginTop: "var(--s-6)" }}>
          <div className="ribbon-board__inner">
            <RibbonScale axis={axis} every={2} />
            {inventory.days.map((day, i) => (
              <Ribbon
                key={day.date}
                date={day.date}
                axis={axis}
                events={events.filter((e) => e.date === day.date)}
                meetings={labeledMeetingsOn(v.term, day.date)}
                blocks={(plan?.blocks ?? []).filter((b) => b.date === day.date)}
                gaps={day.gaps}
                assignments={v.assignments}
                nowStamp={nowStamp}
                isToday={false}
                rowIndex={i}
                dense
                capacityMin={v.settings.dailyCapacityMin}
              />
            ))}
          </div>
        </div>

        {plan?.briefing.prose && (
          <div className="avoid-break" style={{ marginTop: "var(--s-8)", display: "grid", gap: "var(--s-6)", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <div>
              <div className="label label--ink">The read on this week</div>
              <p className="prose" style={{ marginTop: 6 }}>{plan.briefing.prose}</p>
            </div>
            <div>
              {plan.briefing.crunchPoints.length > 0 && (
                <>
                  <div className="label label--ink">Where it bites</div>
                  <ul style={{ listStyle: "none", marginTop: 4 }}>
                    {plan.briefing.crunchPoints.map((c) => (
                      <li key={c} style={{ fontSize: "var(--t-caption)", padding: "3px 0", borderTop: "1px solid var(--separator)" }}>{c}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.briefing.sacrifice && (
                <div style={{ marginTop: "var(--s-4)" }}>
                  <div className="label label--signal">Drop first</div>
                  <p style={{ fontSize: "var(--t-caption)", lineHeight: 1.5 }}>{plan.briefing.sacrifice}</p>
                </div>
              )}
            </div>
          </div>
        )}

        <Footer range={range} page="1" />
      </section>

      {/* ============================================== SHEET 2 — the backlog */}
      <section className="sheet">
        <header className="sheet__head print-only">
          <span className="sheet__title">Backlog</span>
          <span className="sheet__meta">{range}</span>
        </header>
        <div className="section-head no-print"><h2>Backlog</h2></div>

        {dueThisWeek.length === 0 ? (
          <p className="prose">Nothing due in this window.</p>
        ) : (
          <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>Due</th><th>Course</th><th>Item</th><th>Est.</th><th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {dueThisWeek.map((a) => {
                const blocks = (plan?.blocks ?? []).filter((b) => b.assignmentId === a.id);
                const placed = blocks.reduce((n, b) => n + b.endMin - b.startMin, 0);
                const flag = isOverdue(a, nowStamp) || isUrgent(a, nowStamp);
                return (
                  <tr key={a.id}>
                    <td><span className="daypage__check" style={{ display: "inline-block", width: 11, height: 11, border: "var(--separator) solid var(--label)" }} /></td>
                    <td className="num-cell" style={flag ? { color: "var(--red)", fontWeight: 700 } : undefined}>
                      {WEEKDAY_LONG[weekdayOf(a.dueDate)].slice(0, 3)} {hhmm(a.dueMin)}
                    </td>
                    <td className="num-cell">{a.courseCode ?? "—"}</td>
                    <td>{a.title}</td>
                    <td className="num-cell muted">{a.estimateMinutes ? formatDuration(a.estimateMinutes) : "—"}</td>
                    <td className="num-cell">
                      {placed ? formatDuration(placed) : <span className="signal">none</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}

        {plan && plan.unplaced.length > 0 && (
          <div className="notice notice--signal avoid-break" style={{ marginTop: "var(--s-6)" }}>
            <div className="notice__title">Did not fit anywhere</div>
            <ul style={{ listStyle: "none" }}>
              {plan.unplaced.map((u) => (
                <li key={u.assignmentId} style={{ padding: "2px 0" }}>
                  <strong>{byId.get(u.assignmentId)?.title ?? u.assignmentId}</strong> — {u.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Footer range={range} page="2" />
      </section>

      {/* ======================================= SHEETS 3-9 — one day per page */}
      {inventory.days.map((day, i) => {
        const dayBlocks = (plan?.blocks ?? [])
          .filter((b) => b.date === day.date)
          .sort((a, b) => a.startMin - b.startMin);
        const obligations = [
          ...labeledMeetingsOn(v.term, day.date).map((m) => ({ startMin: m.startMin, endMin: m.endMin, label: m.code })),
          ...events.filter((e) => e.date === day.date && e.availability === "BLOCKED")
            .map((e) => ({ startMin: e.startMin, endMin: e.endMin, label: e.title })),
        ].sort((a, b) => a.startMin - b.startMin);
        const dueToday = v.assignments.filter((a) => a.dueDate === day.date && a.status !== "done");

        return (
          <section className="sheet" key={day.date}>
            <header className="sheet__head print-only">
              <span className="sheet__title">{WEEKDAY_LONG[weekdayOf(day.date)]}</span>
              <span className="sheet__meta">{shortDate(day.date)}</span>
            </header>

            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-6)", borderBottom: "var(--separator-strong) solid var(--label)", paddingBottom: "var(--s-2)" }}>
              <span className="num" style={{ fontSize: "var(--t-hero)" }}>
                {String(dateParts(day.date).d).padStart(2, "0")}
              </span>
              <div>
                <div className="display" style={{ fontSize: "var(--t-title3)" }}>{WEEKDAY_LONG[weekdayOf(day.date)]}</div>
                <div className="label">{formatDuration(day.freeMinutes)} free · {formatDuration(dayBlocks.reduce((n, b) => n + b.endMin - b.startMin, 0))} committed</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "var(--s-8)", marginTop: "var(--s-6)" }}>
              <div>
                <div className="label label--ink">Work</div>
                {dayBlocks.length === 0 ? (
                  <p className="muted" style={{ fontSize: "var(--t-footnote)", marginTop: 6 }}>Nothing scheduled.</p>
                ) : dayBlocks.map((b) => {
                  const a = byId.get(b.assignmentId);
                  return (
                    <div key={b.id} className="daypage__block">
                      <span className="daypage__check" />
                      <div>
                        <div className="num-cell" style={{ fontWeight: 700 }}>
                          {hhmm(b.startMin)}–{hhmm(b.endMin)}
                          <span className="muted" style={{ fontWeight: 400 }}> · {formatDuration(b.endMin - b.startMin)}</span>
                        </div>
                        <div>{a?.courseCode ? `${a.courseCode} · ` : ""}{a?.title ?? b.assignmentId}</div>
                        {b.rationale && <div className="muted" style={{ fontSize: "var(--t-caption)" }}>{b.rationale}</div>}
                      </div>
                    </div>
                  );
                })}

                {dueToday.length > 0 && (
                  <div style={{ marginTop: "var(--s-6)" }}>
                    <div className="label label--signal">Due today</div>
                    {dueToday.map((a) => (
                      <div key={a.id} className="daypage__block">
                        <span className="daypage__check" />
                        <div>
                          <span className="num-cell signal" style={{ fontWeight: 700 }}>{hhmm(a.dueMin)}</span>{" "}
                          {a.courseCode ? `${a.courseCode} · ` : ""}{a.title}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="label label--ink">Obligations</div>
                {obligations.length === 0 ? (
                  <p className="muted" style={{ fontSize: "var(--t-footnote)", marginTop: 6 }}>None on the Matrix.</p>
                ) : (
                  <div className="scroll-x">
                  <table className="table" style={{ marginTop: 4 }}>
                    <tbody>
                      {obligations.map((o, k) => (
                        <tr key={k}>
                          <td className="num-cell" style={{ width: "10ch" }}>{hhmm(o.startMin)}–{hhmm(o.endMin)}</td>
                          <td>{o.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginTop: "var(--s-8)" }}>
              <div className="label label--ink">Notes</div>
              <div className="notes-rules" style={{ height: 150, borderTop: "var(--separator) solid var(--label)", marginTop: 4 }} />
            </div>

            <Footer range={range} page={String(i + 3)} />
          </section>
        );
      })}
    </div>
  );
}

function Footer({ range, page }: { range: string; page: string }) {
  return (
    <div className="print-only" style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--s-6)", paddingTop: 4, borderTop: "var(--separator) solid var(--label-4)", fontSize: "var(--t-caption)", letterSpacing: "var(--track-body)", textTransform: "uppercase", color: "var(--label-3)" }}>
      <span>Order · {range}</span>
      <span>Sheet {page}</span>
    </div>
  );
}
