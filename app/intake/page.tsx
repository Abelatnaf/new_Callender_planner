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
import { ANY_FILE, Dropzone } from "@/components/Dropzone";
import { IntakeStatus } from "@/components/IntakeStatus";
import { KeyGate } from "@/components/KeyGate";
import { detectFile, routeTo } from "@/lib/detect";
import { describeStage, importCanvas, importMatrix } from "@/lib/importers";
import { useVault, weekFor } from "@/lib/store";
import { CONFIDENCE_FLOOR } from "@/lib/convert";
import type { Availability, MatrixEvent } from "@/lib/schemas";
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
  const [progress, setProgress] = useState<string | null>(null);

  const monday = useMemo(
    () => addDays(weekStart(todayLocal(vault.settings.timezone)), offset * 7),
    [vault.settings.timezone, offset],
  );
  const week = weekFor(vault, monday);

  /**
   * One entry point for both boxes.
   *
   * The file says where it belongs whenever it can — a Canvas feed dropped on
   * the Matrix box is still a Canvas feed — and the box only decides what the
   * file leaves genuinely ambiguous. Anything rerouted says so, so a wrong
   * guess is visible rather than silent.
   */
  const handleDrop = useCallback(async (file: File, zone: "matrix" | "canvas") => {
    const detection = await detectFile(file);
    const { destination, moved, because } = routeTo(detection, zone);
    const prefix = moved
      ? [`You dropped this on the ${zone === "matrix" ? "Matrix" : "Canvas"} box, but ${because} — so it was read as ${destination === "canvas" ? "your Canvas assignments" : "the Matrix"}.`]
      : [];
    const withPrefix = (r: Feedback): Feedback =>
      r && prefix.length ? { ...r, lines: [...prefix, ...r.lines] } : r;

    if (destination === "canvas") {
      setIcsBusy(true);
      setIcsMsg(null);
      try {
        const { report, assignments } = importCanvas(
          await file.text(), vault.assignments, vault.settings.timezone,
        );
        if (assignments) api.setAssignments(assignments, { fromCanvas: true });
        setIcsMsg(withPrefix(report));
      } finally {
        setIcsBusy(false);
      }
      return;
    }

    // A file that named itself has already been honoured above. What is left
    // here is a file that could be anything — a screenshot, a PDF — dropped on
    // the box that only ever wants a calendar. Naming what arrived beats
    // failing inside an .ics parser that was handed an image.
    if (zone === "canvas" && detection.destination === null) {
      setIcsMsg({
        kind: "bad",
        title: "That is not a Canvas feed",
        lines: [
          `It looks like ${because.replace(/^it is /, "")}. Canvas → Calendar → Calendar Feed gives you a .ics file.`,
          "If it is the Matrix, use the box on the left. If it is your semester schedule, it belongs on the Semester page.",
        ],
      });
      return;
    }

    setMatrixBusy(true);
    setMatrixMsg(null);
    setProgress(null);
    try {
      const { report, week } = await importMatrix(file, {
        weekStart: monday,
        timezone: vault.settings.timezone,
        cadet: vault.settings.cadet,
        onProgress: (stage, detail) => setProgress(describeStage(stage, detail)),
      });
      if (week) api.upsertMatrixWeek(week);
      setMatrixMsg(withPrefix(report));
    } finally {
      setMatrixBusy(false);
      setProgress(null);
    }
  }, [api, monday, vault.assignments, vault.settings.cadet, vault.settings.timezone]);

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

        <IntakeStatus vault={vault} weekStart={monday} />

        <div className="grid-2" style={{ marginTop: "var(--s-6)" }}>
          <div>
            <Dropzone
              title="Drop the Matrix"
              hint="CSV · Excel · PDF · screenshot — or drop any of the three files here"
              accept={ANY_FILE}
              busy={matrixBusy}
              loaded={week?.source?.filename ?? null}
              onFile={(f) => void handleDrop(f, "matrix")}
            />
            {progress && (
              <div className="notice" role="status" aria-live="polite" style={{ marginTop: "var(--s-4)" }}>
                <span className="working">{progress}</span>
              </div>
            )}
            <Note msg={matrixMsg} />
          </div>

          <div>
            <Dropzone
              title="Drop Canvas .ics"
              hint="Canvas → Calendar → Calendar Feed → download the .ics"
              accept={ANY_FILE}
              busy={icsBusy}
              loaded={vault.assignments.length ? `${vault.assignments.length} assignments loaded` : null}
              onFile={(f) => void handleDrop(f, "canvas")}
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
