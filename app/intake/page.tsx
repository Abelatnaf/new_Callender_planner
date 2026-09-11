"use client";

/**
 * INTAKE — the weekly ritual, in one screen.
 *
 * Two files go in. The review list below them is the important half: every
 * classification the model was unsure about is surfaced here for a one-tap
 * override, because the alternative is discovering the mistake on the printed
 * page during a formation.
 */
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Dropzone } from "@/components/Dropzone";
import { KeyGate } from "@/components/KeyGate";
import { keyHeaders } from "@/lib/apikey";
import { useVault, weekFor } from "@/lib/store";
import { parseIcs, mergeAssignments } from "@/lib/ics";
import { CONFIDENCE_FLOOR } from "@/lib/convert";
import type { Availability, MatrixEvent, MatrixWeek } from "@/lib/schemas";
import { addDays, formatDuration, hhmm, shortDate, todayLocal, weekDates, weekStart } from "@/lib/time";

type Feedback = { kind: "ok" | "warn" | "bad"; title: string; lines: string[] } | null;

export default function IntakePage() {
  const api = useVault();
  const { vault, ready } = api;
  const [offset, setOffset] = useState(0);
  const [matrixBusy, setMatrixBusy] = useState(false);
  const [icsBusy, setIcsBusy] = useState(false);
  const [matrixMsg, setMatrixMsg] = useState<Feedback>(null);
  const [icsMsg, setIcsMsg] = useState<Feedback>(null);

  const monday = useMemo(
    () => addDays(weekStart(todayLocal(vault.settings.timezone)), offset * 7),
    [vault.settings.timezone, offset],
  );
  const week = weekFor(vault, monday);

  const uploadMatrix = useCallback(async (file: File) => {
    setMatrixBusy(true);
    setMatrixMsg(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("weekStart", monday);
      form.set("timezone", vault.settings.timezone);
      form.set("cadet", JSON.stringify(vault.settings.cadet));
      const res = await fetch("/api/parse/matrix", {
        method: "POST", body: form, headers: keyHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read that file.");

      const parsed = data.week as MatrixWeek;
      api.upsertMatrixWeek(parsed);

      const mine = parsed.events.filter((e) => e.appliesToMe !== false);
      const blocked = mine.filter((e) => e.availability === "BLOCKED").length;
      setMatrixMsg({
        kind: data.ratchetedCount > 0 ? "warn" : "ok",
        title: `Read ${parsed.events.length} events for the week of ${shortDate(parsed.weekStart)}`,
        lines: [
          `${mine.length} apply to you — ${blocked} mandatory, ${mine.length - blocked} usable.`,
          ...(data.notMine > 0
            ? [`${data.notMine} belong to other companies, classes or the Band — kept for reference, but they do not take your time.`]
            : []),
          ...(data.ratchetedCount > 0
            ? [`${data.ratchetedCount} were marked mandatory because Gemini was not confident. Review them below — you may have more free time than shown.`]
            : []),
          ...(data.warnings ?? []),
        ],
      });
    } catch (e) {
      setMatrixMsg({ kind: "bad", title: "Matrix import failed", lines: [e instanceof Error ? e.message : "Unknown error."] });
    } finally {
      setMatrixBusy(false);
    }
  }, [api, monday, vault.settings.timezone]);

  const uploadIcs = useCallback(async (file: File) => {
    setIcsBusy(true);
    setIcsMsg(null);
    try {
      const text = await file.text();
      const { assignments, skipped, calendarName } = parseIcs(text, vault.settings.timezone);
      if (assignments.length === 0) {
        throw new Error("No assignments found. Is this the Canvas Calendar Feed .ics?");
      }
      const { merged, added, updated, removed } = mergeAssignments(vault.assignments, assignments);
      api.setAssignments(merged);
      setIcsMsg({
        kind: "ok",
        title: `${merged.length} assignments on the books`,
        lines: [
          `${added} new, ${updated} with changed deadlines, ${removed} no longer in Canvas.`,
          "Your statuses, estimates and manual entries were preserved.",
          ...(calendarName ? [`Feed: ${calendarName}`] : []),
          ...(skipped ? [`${skipped} entries had no usable date and were skipped.`] : []),
        ],
      });
    } catch (e) {
      setIcsMsg({ kind: "bad", title: "Canvas import failed", lines: [e instanceof Error ? e.message : "Unknown error."] });
    } finally {
      setIcsBusy(false);
    }
  }, [api, vault.assignments, vault.settings.timezone]);

  const setAvailability = useCallback((eventId: string, availability: Availability) => {
    if (!week) return;
    api.upsertMatrixWeek({
      ...week,
      events: week.events.map((e) =>
        e.id === eventId ? { ...e, availability, confirmedByUser: true, ratcheted: false } : e,
      ),
    });
  }, [api, week]);

  const needsReview = (week?.events ?? []).filter(
    (e) => !e.confirmedByUser && (e.ratcheted || e.confidence < CONFIDENCE_FLOOR),
  );

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  return (
    <div className="wrap">
      <section className="section">
        <div className="section-head">
          <div>
            <div className="label">Do this once a week</div>
            <h1 className="display" style={{ fontSize: "var(--t-title1)" }}>Intake</h1>
          </div>
          <div className="toolbar no-print">
            <button className="btn btn--sm" onClick={() => setOffset((o) => o - 1)}>←</button>
            <span className="label label--ink">Week of {shortDate(monday)}</span>
            <button className="btn btn--sm" onClick={() => setOffset((o) => o + 1)}>→</button>
          </div>
        </div>

        <KeyGate />

        <div className="grid-2">
          <div>
            <Dropzone
              title="Drop the Matrix"
              hint="CSV · Excel · PDF — the weekly master schedule"
              accept=".csv,.tsv,.xlsx,.xls,.xlsm,.pdf,text/csv,application/pdf"
              busy={matrixBusy}
              loaded={week?.source?.filename ?? null}
              onFile={uploadMatrix}
            />
            <Note msg={matrixMsg} />
          </div>

          <div>
            <Dropzone
              title="Drop Canvas .ics"
              hint="Canvas → Calendar → Calendar Feed → download"
              accept=".ics,text/calendar"
              busy={icsBusy}
              loaded={vault.assignments.length ? `${vault.assignments.length} assignments loaded` : null}
              onFile={uploadIcs}
            />
            <Note msg={icsMsg} />
          </div>
        </div>

        {!vault.term && (
          <div className="notice" style={{ marginTop: "var(--s-6)" }}>
            <div className="notice__title">No semester schedule yet</div>
            Your classes are not carving up these days, so free time will read high.{" "}
            <Link href="/setup" style={{ color: "inherit" }}>Load the semester →</Link>
          </div>
        )}
      </section>

      {needsReview.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{needsReview.length === 1 ? "Confirm this one" : `Confirm these ${needsReview.length}`}</h2>
            <span className="label">Gemini was unsure — it chose the safe answer</span>
          </div>
          <p className="prose" style={{ marginBottom: "var(--s-6)" }}>
            Anything the model could not classify confidently was marked mandatory, because
            sending you to the library during a formation is a worse mistake than losing an
            hour of study time. Correct any of these and the week re-opens.
          </p>
          {needsReview.map((e) => (
            <ReviewRow key={e.id} event={e} onSet={setAvailability} />
          ))}
        </section>
      )}

      {week && (
        <section className="section">
          <div className="section-head">
            <h2>Everything read from the Matrix</h2>
            <span className="label">{week.events.length} events</span>
          </div>
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th><th>Time</th><th>Event</th><th>For</th><th>Status</th><th>Source</th>
                </tr>
              </thead>
              <tbody>
                {week.events.map((e) => (
                  <tr key={e.id}>
                    <td className="num-cell">{shortDate(e.date)}</td>
                    <td className="num-cell">{hhmm(e.startMin)}–{hhmm(e.endMin)}</td>
                    <td>{e.title}</td>
                    <td className="muted">
                      {e.pax || e.kind}
                      {e.appliesToMe === false && (
                        <span className="label" style={{ marginLeft: 6 }}>not you</span>
                      )}
                    </td>
                    <td>
                      {e.appliesToMe === false
                        ? <span className="label">—</span>
                        : <AvailabilityTag value={e.availability} />}
                    </td>
                    <td className="muted" style={{ fontSize: "var(--t-caption)" }}>
                      {e.confirmedByUser ? "you" : `gemini ${Math.round(e.confidence * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="toolbar no-print" style={{ marginTop: "var(--s-6)" }}>
            <Link className="btn btn--solid" href="/">See the week →</Link>
          </div>
        </section>
      )}
    </div>
  );
}

function ReviewRow({ event, onSet }: { event: MatrixEvent; onSet: (id: string, a: Availability) => void }) {
  const options: Array<[Availability, string]> = [
    ["BLOCKED", "Mandatory"],
    ["PARTIAL", "In quarters"],
    ["USABLE", "Free"],
  ];
  return (
    <div className="review-row">
      <div>
        <strong>{event.title}</strong>{" "}
        <span className="muted num-cell">
          {shortDate(event.date)} · {hhmm(event.startMin)}–{hhmm(event.endMin)} ·{" "}
          {formatDuration(event.endMin - event.startMin)}
        </span>
        <div className="review-row__why">
          {event.pax ? `${event.pax} · ` : ""}
          {event.ratcheted ? "Forced to mandatory — " : ""}
          {event.note ?? `read from "${event.raw}"`}
          {` · ${Math.round(event.confidence * 100)}% confident`}
        </div>
      </div>
      <div className="seg">
        {options.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={event.availability === value}
            onClick={() => onSet(event.id, value)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AvailabilityTag({ value }: { value: Availability }) {
  const map: Record<Availability, string> = {
    BLOCKED: "Mandatory",
    PARTIAL: "In quarters",
    USABLE: "Free",
  };
  return (
    <span
      className="label"
      style={{
        color: value === "BLOCKED" ? "var(--label)" : "var(--label-3)",
        fontWeight: value === "BLOCKED" ? 700 : 400,
      }}
    >
      {map[value]}
    </span>
  );
}

function Note({ msg }: { msg: Feedback }) {
  if (!msg) return null;
  return (
    <div className={`notice${msg.kind === "bad" ? " notice--signal" : ""}`} style={{ marginTop: "var(--s-4)" }}>
      <div className="notice__title">{msg.title}</div>
      {msg.lines.filter(Boolean).map((l) => <div key={l} style={{ marginTop: 2 }}>{l}</div>)}
    </div>
  );
}
