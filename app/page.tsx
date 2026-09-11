"use client";

/**
 * THE WEEK.
 *
 * The whole product in one screen: seven ribbons showing what the Institute
 * takes, what the cadet has left, and what has been put into it. Everything
 * else in the app exists to feed this page or to print it.
 */
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Ribbon, RibbonScale } from "@/components/Ribbon";
import { Empty } from "@/components/Empty";
import { AskPanel } from "@/components/AskPanel";
import { KeyGate } from "@/components/KeyGate";
import { keyHeaders } from "@/lib/apikey";
import { Briefing } from "@/components/Briefing";
import { useVault, planFor, weekFor, currentWeekStart } from "@/lib/store";
import { buildWeekInventory, labeledMeetingsOn } from "@/lib/gaps";
import { isOverdue } from "@/lib/layout";
import {
  addDays, formatDuration, instantToLocal, shortDate, stamp, todayLocal, weekDates, weekStart,
} from "@/lib/time";
import type { Plan } from "@/lib/schemas";

export default function WeekPage() {
  const api = useVault();
  const { vault, ready } = api;
  const [offset, setOffset] = useState(0);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);

  const tz = vault.settings.timezone;
  const today = todayLocal(tz);
  const monday = useMemo(
    () => addDays(weekStart(today), offset * 7),
    [today, offset],
  );

  const matrixWeek = weekFor(vault, monday);
  const plan = planFor(vault, monday);
  const events = matrixWeek?.events ?? [];

  const inventory = useMemo(
    () => buildWeekInventory(monday, vault.term, events, vault.settings),
    [monday, vault.term, events, vault.settings],
  );

  const now = instantToLocal(new Date(), tz);
  const nowStamp = stamp(now.date, now.minutes);
  const axis = { startMin: vault.settings.dayStartMin, endMin: vault.settings.dayEndMin };

  const committed = (plan?.blocks ?? []).reduce((n, b) => n + (b.endMin - b.startMin), 0);
  const obligationMin = inventory.days.reduce(
    (n, d) => n + d.blocked.reduce((m, b) => m + (b.endMin - b.startMin), 0), 0,
  );
  const overdue = vault.assignments.filter((a) => isOverdue(a, nowStamp)).length;
  const unconfirmed = events.filter((e) => e.ratcheted || (!e.confirmedByUser && e.confidence < 0.75)).length;

  const generate = useCallback(async () => {
    setPlanning(true);
    setError(null);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: keyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          weekStart: monday,
          term: vault.term,
          events,
          assignments: vault.assignments,
          settings: vault.settings,
          locked: (plan?.blocks ?? []).filter((b) => b.locked),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Planning failed.");
      api.upsertPlan(data.plan as Plan);
      if (data.assignments) api.setAssignments(data.assignments);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Planning failed.");
    } finally {
      setPlanning(false);
    }
  }, [monday, vault, events, plan, api]);

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  const hasNothing = !vault.term && events.length === 0 && vault.assignments.length === 0;

  return (
    <div className="wrap">
      <section className="section">
        <div className="section-head">
          <div>
            <div className="label">
              {offset === 0 ? "Current week" : offset > 0 ? `${offset} week${offset > 1 ? "s" : ""} ahead` : `${-offset} week${offset < -1 ? "s" : ""} back`}
            </div>
            <h1 className="display" style={{ fontSize: "var(--t-3xl)" }}>
              Week of {shortDate(monday)}
            </h1>
            <div className="muted" style={{ fontSize: "var(--t-tiny)", marginTop: 4 }}>
              {shortDate(monday)} — {shortDate(weekDates(monday)[6])}
              {matrixWeek?.source && ` · Matrix: ${matrixWeek.source.filename}`}
            </div>
          </div>

          <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn--sm" onClick={() => setOffset((o) => o - 1)}>← Prev</button>
            {offset !== 0 && <button className="btn btn--sm" onClick={() => setOffset(0)}>Today</button>}
            <button className="btn btn--sm" onClick={() => setOffset((o) => o + 1)}>Next →</button>
          </div>
        </div>

        {hasNothing ? (
          <Empty
            title="Nothing here yet. Three steps and it works."
            lines={[
              "Load your semester schedule once — it stays until the term changes.",
              "Drop this week's Matrix spreadsheet in. That is what carves up your week.",
              "Drop your Canvas .ics export in. That is what has to fit in what is left.",
            ]}
            cta={{ href: "/setup", label: "Start with the semester" }}
          />
        ) : (
          <>
            <div className="tallies">
              <div className="tally">
                <span className="tally__n">{formatDuration(inventory.freeMinutes)}</span>
                <span className="tally__l">Actually yours</span>
              </div>
              <div className="tally">
                <span className="tally__n">{formatDuration(obligationMin)}</span>
                <span className="tally__l">Taken from you</span>
              </div>
              <div className="tally">
                <span className="tally__n">{formatDuration(committed)}</span>
                <span className="tally__l">Work placed</span>
              </div>
              <div className={`tally${overdue ? " tally--signal" : ""}`}>
                <span className="tally__n">{overdue}</span>
                <span className="tally__l">Overdue</span>
              </div>
            </div>

            <KeyGate />

            {unconfirmed > 0 && (
              <div className="notice notice--signal no-print" style={{ marginTop: "var(--u-3)" }}>
                <div className="notice__title">{unconfirmed} block{unconfirmed > 1 ? "s" : ""} need{unconfirmed > 1 ? "" : "s"} your eyes</div>
                Gemini was not confident about {unconfirmed === 1 ? "one entry" : "these entries"} in the Matrix,
                so {unconfirmed === 1 ? "it was" : "they were"} marked mandatory to be safe — which means you may
                have more free time than shown.{" "}
                <Link href="/intake" style={{ color: "inherit" }}>Review them →</Link>
              </div>
            )}

            {events.length === 0 && (
              <div className="notice no-print" style={{ marginTop: "var(--u-3)" }}>
                <div className="notice__title">No Matrix loaded for this week</div>
                Only your class schedule is carving up these days, so the free time below is
                optimistic. <Link href="/intake" style={{ color: "inherit" }}>Load the Matrix →</Link>
              </div>
            )}

            <div className="ribbon-board" style={{ marginTop: "var(--u-4)" }}>
              <div className="ribbon-board__inner">
                <RibbonScale axis={axis} />
                {inventory.days.map((day, i) => (
                  <Ribbon
                    key={day.date}
                    date={day.date}
                    axis={axis}
                    events={events.filter((e) => e.date === day.date)}
                    meetings={labeledMeetingsOn(vault.term, day.date)}
                    blocks={(plan?.blocks ?? []).filter((b) => b.date === day.date)}
                    gaps={day.gaps}
                    assignments={vault.assignments}
                    nowStamp={nowStamp}
                    nowMinutes={now.minutes}
                    isToday={day.date === today}
                    rowIndex={i}
                    capacityMin={vault.settings.dailyCapacityMin}
                  />
                ))}
              </div>
            </div>

            <Legend />

            <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "var(--u-4)" }}>
              <button className="btn btn--solid" onClick={generate} disabled={planning || vault.assignments.length === 0}>
                {planning ? "Planning…" : plan ? "Re-plan this week" : "Plan this week"}
              </button>
              <button className="btn" onClick={() => setAskOpen(true)}>Ask about this week</button>
              <Link className="btn" href="/document">Printable document →</Link>
            </div>

            {planning && (
              <p className="working" style={{ marginTop: "var(--u-2)" }}>
                Reading {inventory.gaps.length} free slots against {vault.assignments.filter((a) => a.status !== "done").length} open assignments
              </p>
            )}

            {error && (
              <div className="notice notice--signal no-print" style={{ marginTop: "var(--u-3)" }}>
                <div className="notice__title">Could not plan</div>
                {error}
              </div>
            )}
          </>
        )}
      </section>

      {plan && (
        <Briefing plan={plan} assignments={vault.assignments} />
      )}

      <AskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        weekStart={monday}
        vault={vault}
        plan={plan}
      />
    </div>
  );
}

function Legend() {
  const items = [
    { cls: "bar--ink", label: "Mandatory — you have no say" },
    { cls: "bar--hatch", label: "Yours, but confined to quarters" },
    { cls: "bar--work", label: "Work you chose to put here" },
    { cls: "", label: "Free" },
  ];
  return (
    <div style={{ display: "flex", gap: "var(--u-3)", flexWrap: "wrap", marginTop: "var(--u-2)", paddingTop: "var(--u-2)", borderTop: "var(--rule-hair) solid var(--rule-faint)" }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            className={it.cls ? `bar ${it.cls}` : ""}
            style={{
              position: "static", width: 26, height: 12, flex: "none", padding: 0,
              border: it.cls ? undefined : "var(--rule-hair) solid var(--rule-faint)",
              background: it.cls ? undefined : "transparent",
              animation: "none",
            }}
          />
          <span className="label">{it.label}</span>
        </span>
      ))}
    </div>
  );
}
