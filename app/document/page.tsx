"use client";

/**
 * DOCUMENT — the thing that gets printed and carried.
 *
 * Ten pages: one per day, then the courses and the horizon, then the study plan
 * with its audit. The arithmetic is all in lib/document.ts; this file only
 * chooses the week and lays the sheets out.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { CoursesSheet, DaySheet, StudySheet } from "@/components/DocumentSheets";
import { IntakeStatus } from "@/components/IntakeStatus";
import { buildDocument } from "@/lib/document";
import { buildWeekInventory } from "@/lib/gaps";
import { buildCourseHues } from "@/lib/layout";
import { bestWeekStart, importedWeekStarts, planFor, useVault, weekFor } from "@/lib/store";
import { auditPlan } from "@/lib/validate";
import { addDays, shortDate, weekDates } from "@/lib/time";

/** Whole weeks from one Monday to another. Parsed as UTC so DST cannot skew it. */
function weeksBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 604_800_000);
}

export default function DocumentPage() {
  const { vault: v, ready } = useVault();
  const [offset, setOffset] = useState(0);

  // Open on a week that has a Matrix, not blindly on today's. A cadet imports
  // next week's Matrix on Friday; opening on today would print seven empty
  // pages and say nothing about why.
  const base = bestWeekStart(v);
  const monday = useMemo(() => addDays(base, offset * 7), [base, offset]);

  const week = weekFor(v, monday);
  const plan = planFor(v, monday);
  const imported = importedWeekStarts(v);

  const model = useMemo(
    () => buildDocument({
      weekStart: monday, term: v.term, week, plan,
      assignments: v.assignments, settings: v.settings,
    }),
    [monday, v.term, week, plan, v.assignments, v.settings],
  );

  // Course colours come from the term list, so they match the screen exactly.
  const hues = useMemo(
    () => buildCourseHues((v.term?.courses ?? []).map((c) => c.code)),
    [v.term],
  );

  const problems = useMemo(() => {
    if (!plan) return [];
    const inv = buildWeekInventory(monday, v.term, week?.events ?? [], v.settings);
    return auditPlan(plan, inv, v.assignments);
  }, [plan, monday, v.term, week, v.settings, v.assignments]);

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  const total = model.days.length + 2;
  const range = `${shortDate(monday)} – ${shortDate(weekDates(monday)[6])}`;

  return (
    <div className="doc">
      <div className="wrap no-print">
        <div className="toolbar" style={{ paddingBlock: "var(--s-6)" }}>
          <button className="btn btn--sm" onClick={() => setOffset((o) => o - 1)} aria-label="Previous week">←</button>
          <span className="label label--ink">{range}</span>
          <button className="btn btn--sm" onClick={() => setOffset((o) => o + 1)} aria-label="Next week">→</button>
          <button className="btn btn--solid" onClick={() => window.print()}>Print · Save as PDF</button>
          <span className="label">{total} pages</span>
        </div>

        <IntakeStatus vault={v} weekStart={monday} compact />

        {!week && (
          <div className="notice notice--signal" style={{ marginTop: "var(--s-6)" }} role="alert">
            <div className="notice__title">No Matrix imported for this week</div>
            {imported.length === 0 ? (
              <>
                Nothing has been imported yet, so these pages are the empty form.{" "}
                <Link href="/intake" style={{ color: "inherit" }}>Import the Matrix →</Link>
              </>
            ) : (
              <>
                The pages below are blank because no Matrix covers{" "}
                {shortDate(monday)} – {shortDate(weekDates(monday)[6])}. Imported:{" "}
                {imported.map((s) => (
                  <button
                    key={s}
                    className="btn btn--sm"
                    style={{ marginInlineEnd: "var(--s-2)" }}
                    onClick={() => setOffset(weeksBetween(base, s))}
                  >
                    {shortDate(s)}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {problems.length > 0 && (
          <div className="notice notice--signal" style={{ marginTop: "var(--s-6)" }} role="alert">
            <div className="notice__title">
              {problems.length} block{problems.length > 1 ? "s" : ""} no longer fit
            </div>
            The schedule changed after this plan was made. Re-plan the week before printing —
            these blocks collide with something or sit past a deadline.{" "}
            <Link href="/" style={{ color: "inherit" }}>Re-plan →</Link>
          </div>
        )}
      </div>

      <div className="sheets">
        {model.days.map((d, i) => (
          <DaySheet key={d.date} day={d} hues={hues} index={i} total={total} />
        ))}
        <CoursesSheet model={model} hues={hues} page={model.days.length + 1} total={total} />
        <StudySheet model={model} hues={hues} page={total} total={total} />
      </div>
    </div>
  );
}
