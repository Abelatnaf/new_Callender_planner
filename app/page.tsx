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
import { Hero } from "@/components/Hero";
import { BlockSheet } from "@/components/BlockSheet";
import { useVault, planFor, weekFor, currentWeekStart } from "@/lib/store";
import { buildWeekInventory, labeledMeetingsOn } from "@/lib/gaps";
import { auditPlan } from "@/lib/validate";
import { buildCourseHues, isOverdue } from "@/lib/layout";
import {
  addDays, formatDuration, instantToLocal, shortDate, stamp, todayLocal, weekDates, weekStart,
} from "@/lib/time";
import type { Plan, WorkBlock } from "@/lib/schemas";

export default function WeekPage() {
  const api = useVault();
  const { vault, ready } = api;
  const [offset, setOffset] = useState(0);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

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

  const hues = useMemo(
    () => buildCourseHues((vault.term?.courses ?? []).map((c) => c.code)),
    [vault.term],
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

  const blocks = plan?.blocks ?? [];

  const patchBlock = useCallback((next: WorkBlock) => {
    if (!plan) return;
    api.upsertPlan({ ...plan, blocks: plan.blocks.map((b) => (b.id === next.id ? next : b)) });
  }, [api, plan]);

  const removeBlock = useCallback((id: string) => {
    if (!plan) return;
    api.upsertPlan({ ...plan, blocks: plan.blocks.filter((b) => b.id !== id) });
  }, [api, plan]);

  // The plan can drift after it is made - the Matrix gets re-imported, a class
  // moves. /document already checked this; the week page stayed silent.
  const staleIssues = plan ? auditPlan(plan, inventory, vault.assignments) : [];

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
            <h1 className="display" style={{ fontSize: "var(--t-title1)" }}>
              Week of {shortDate(monday)}
            </h1>
            <div className="muted" style={{ fontSize: "var(--t-footnote)", marginTop: 4 }}>
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
            <Hero
              freeMinutes={inventory.freeMinutes}
              takenMinutes={obligationMin}
              committedMinutes={committed}
              doneMinutes={blocks.filter((b) => b.done).reduce((n, b) => n + (b.endMin - b.startMin), 0)}
              overdue={overdue}
              days={inventory.days}
              today={today}
            />

            <KeyGate />

            {staleIssues.length > 0 && (
              <div className="notice notice--signal no-print" style={{ marginTop: "var(--s-6)" }}>
                <div className="notice__title">
                  {staleIssues.length} block{staleIssues.length > 1 ? "s" : ""} no longer fit
                </div>
                Your schedule changed after this plan was made. Re-plan the week, or open the
                affected blocks and move them.
              </div>
            )}

            {unconfirmed > 0 && (
              <div className="notice notice--signal no-print" style={{ marginTop: "var(--s-6)" }}>
                <div className="notice__title">{unconfirmed} block{unconfirmed > 1 ? "s" : ""} need{unconfirmed > 1 ? "" : "s"} your eyes</div>
                Gemini was not confident about {unconfirmed === 1 ? "one entry" : "these entries"} in the Matrix,
                so {unconfirmed === 1 ? "it was" : "they were"} marked mandatory to be safe — which means you may
                have more free time than shown.{" "}
                <Link href="/intake" style={{ color: "inherit" }}>Review them →</Link>
              </div>
            )}

            {events.length === 0 && (
              <div className="notice no-print" style={{ marginTop: "var(--s-6)" }}>
                <div className="notice__title">No Matrix loaded for this week</div>
                Only your class schedule is carving up these days, so the free time below is
                optimistic. <Link href="/intake" style={{ color: "inherit" }}>Load the Matrix →</Link>
              </div>
            )}

            <div className="ribbon-board" style={{ marginTop: "var(--s-8)" }}>
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
                    hues={hues}
                    onSelectBlock={(b) => setSelected(b.id)}
                  />
                ))}
              </div>
            </div>

            <Legend />

            <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "var(--s-8)" }}>
              <button className="btn btn--solid" onClick={generate} disabled={planning || vault.assignments.length === 0}>
                {planning ? "Planning…" : plan ? "Re-plan this week" : "Plan this week"}
              </button>
              <button className="btn" onClick={() => setAskOpen(true)}>Ask about this week</button>
              <Link className="btn" href="/document">Printable document →</Link>
            </div>

            {planning && (
              <p className="working" style={{ marginTop: "var(--s-4)" }}>
                Reading {inventory.gaps.length} free slots against {vault.assignments.filter((a) => a.status !== "done").length} open assignments
              </p>
            )}

            {error && (
              <div className="notice notice--signal no-print" style={{ marginTop: "var(--s-6)" }}>
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

      {selected && plan && (() => {
        const block = plan.blocks.find((b) => b.id === selected);
        if (!block) return null;
        return (
          <BlockSheet
            block={block}
            assignment={vault.assignments.find((a) => a.id === block.assignmentId)}
            siblings={plan.blocks.filter((b) => b.id !== block.id)}
            inventory={inventory}
            nowStamp={nowStamp}
            onChange={patchBlock}
            onRemove={removeBlock}
            onClose={() => setSelected(null)}
          />
        );
      })()}

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
    { cls: "legend__swatch--lit", label: "Yours — colour shows the time of day" },
    { cls: "legend__swatch--bound", label: "Yours, but confined to quarters" },
    { cls: "legend__swatch--void", label: "Taken from you" },
    { cls: "legend__swatch--chip", label: "Work you put into your own time" },
  ];
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label} className="legend__item">
          <span className={`legend__swatch ${it.cls}`} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
