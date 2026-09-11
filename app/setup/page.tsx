"use client";

/**
 * SEMESTER — the dedicated space for the thing that only changes once a term.
 *
 * Everything here is editable by hand after import. A wrong extraction should
 * cost thirty seconds of correction, not a term of quietly bad plans, and
 * changing terms must never require touching code.
 */
import { useCallback, useState } from "react";
import { ANY_FILE, Dropzone } from "@/components/Dropzone";
import { IntakeStatus } from "@/components/IntakeStatus";
import { KeyGate } from "@/components/KeyGate";
import { detectFile, routeTo } from "@/lib/detect";
import { type Report, describeStage, importCanvas, importMatrix, importTerm } from "@/lib/importers";
import { useVault } from "@/lib/store";
import type { Course, Term } from "@/lib/schemas";
import {
  WEEKDAYS, type Weekday, formatDuration, hcolonmm, toMinutes, todayLocal, weekStart,
} from "@/lib/time";

const DAY_LABELS: Record<Weekday, string> = {
  SU: "Su", MO: "M", TU: "T", WE: "W", TH: "Th", FR: "F", SA: "Sa",
};

export default function SetupPage() {
  const api = useVault();
  const { vault, ready } = api;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Report | null>(null);
  const [paste, setPaste] = useState("");
  const [progress, setProgress] = useState<string | null>(null);

  const runTerm = useCallback(async (payload: FormData) => {
    setBusy(true);
    setMsg(null);
    try {
      const { report, term } = await importTerm(payload, (stage, detail) =>
        setProgress(describeStage(stage, detail)),
      );
      if (term) {
        api.setTerm(term);
        setPaste("");
      }
      setMsg(report);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [api]);

  /**
   * This box takes all three files, not just the semester schedule.
   *
   * A cadet with three files and one visible drop zone will use the drop zone.
   * Refusing the other two on a technicality — the wrong `accept` string — is a
   * dead end they have no way to diagnose, so the file is read and routed to
   * whichever importer it actually belongs to.
   */
  const handleDrop = useCallback(async (file: File) => {
    const detection = await detectFile(file);
    const { destination, moved, because } = routeTo(detection, "term");

    if (destination === "term") {
      const form = new FormData();
      form.set("file", file);
      await runTerm(form);
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      const prefix = moved
        ? [`This is not a semester schedule — ${because} — so it was read as ${destination === "canvas" ? "your Canvas assignments" : "the Matrix"} instead.`]
        : [];

      if (destination === "canvas") {
        const { report, assignments } = importCanvas(
          await file.text(), vault.assignments, vault.settings.timezone,
        );
        if (assignments) api.setAssignments(assignments, { fromCanvas: true });
        setMsg({ ...report, lines: [...prefix, ...report.lines] });
        return;
      }

      // The Matrix is a weekly document and this page has no week picker, so it
      // lands on the current one — the same default /intake opens with.
      const monday = weekStart(todayLocal(vault.settings.timezone));
      const { report, week } = await importMatrix(file, {
        weekStart: monday,
        timezone: vault.settings.timezone,
        cadet: vault.settings.cadet,
        onProgress: (stage, detail) => setProgress(describeStage(stage, detail)),
      });
      if (week) api.upsertMatrixWeek(week);
      setMsg({
        ...report,
        // Only point at Intake when there is something there to look at.
        lines: [...prefix, ...report.lines, ...(week ? ["Review it on the Intake page →"] : [])],
      });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [api, runTerm, vault.assignments, vault.settings.cadet, vault.settings.timezone]);

  const patchCourse = useCallback((id: string, patch: Partial<Course>) => {
    if (!vault.term) return;
    api.update((v) => ({
      ...v,
      term: v.term
        ? { ...v.term, courses: v.term.courses.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
        : v.term,
    }));
  }, [api, vault.term]);

  const patchMeeting = useCallback((courseId: string, index: number, patch: Partial<Course["meetings"][number]>) => {
    if (!vault.term) return;
    api.update((v) => ({
      ...v,
      term: v.term
        ? {
            ...v.term,
            courses: v.term.courses.map((c) =>
              c.id === courseId
                ? { ...c, meetings: c.meetings.map((m, i) => (i === index ? { ...m, ...patch } : m)) }
                : c,
            ),
          }
        : v.term,
    }));
  }, [api, vault.term]);

  const removeCourse = useCallback((id: string) => {
    if (!vault.term) return;
    api.update((v) => ({
      ...v,
      term: v.term ? { ...v.term, courses: v.term.courses.filter((c) => c.id !== id) } : v.term,
    }));
  }, [api, vault.term]);

  const addCourse = useCallback(() => {
    api.update((v) => {
      const term: Term = v.term ?? {
        id: `T-${Date.now()}`, name: "Untitled term",
        startDate: "2026-08-17", endDate: "2026-12-11", courses: [],
      };
      return {
        ...v,
        term: {
          ...term,
          courses: [...term.courses, {
            id: `C-${Date.now()}`, code: "NEW 101", title: "New course",
            meetings: [{ days: ["MO", "WE", "FR"], startMin: 480, endMin: 530 }],
          }],
        },
      };
    });
  }, [api]);

  if (!ready) return <div className="wrap section"><span className="working">Loading</span></div>;

  const weeklyClassMin = (vault.term?.courses ?? []).reduce(
    (n, c) => n + c.meetings.reduce((m, mt) => m + (mt.endMin - mt.startMin) * mt.days.length, 0), 0,
  );

  return (
    <div className="wrap">
      <section className="section">
        <div className="section-head">
          <div>
            <div className="label">Changes once a term, then leave it alone</div>
            <h1 className="display" style={{ fontSize: "var(--t-title1)" }}>Semester</h1>
          </div>
          {vault.term && (
            <div className="tally" style={{ textAlign: "right" }}>
              <span className="tally__n" style={{ fontSize: "var(--t-title3)" }}>{formatDuration(weeklyClassMin)}</span>
              <span className="tally__l">In class each week</span>
            </div>
          )}
        </div>

        <KeyGate />

        <IntakeStatus vault={vault} weekStart={weekStart(todayLocal(vault.settings.timezone))} />

        <div className="grid-2" style={{ marginTop: "var(--s-6)" }}>
          <Dropzone
            title="Drop your schedule"
            hint="Screenshot · PDF · Excel · CSV — the Matrix and Canvas .ics work here too"
            accept={ANY_FILE}
            busy={busy}
            loaded={vault.term?.source?.filename ?? null}
            onFile={(file) => void handleDrop(file)}
          />
          <div>
            <label className="field">
              <span className="label">…or paste it as text</span>
              <textarea
                className="textarea"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={"CHEM 141  General Chemistry  MWF 0800-0850  MI 302\nMATH 171  Calculus I         MWF 0900-0950  MA 214"}
              />
            </label>
            <button
              className="btn"
              style={{ marginTop: "var(--s-2)" }}
              disabled={busy || !paste.trim()}
              onClick={() => { const f = new FormData(); f.set("text", paste); void runTerm(f); }}
            >
              Read pasted schedule
            </button>
          </div>
        </div>

        {progress && (
          <div className="notice" role="status" aria-live="polite" style={{ marginTop: "var(--s-6)" }}>
            <span className="working">{progress}</span>
          </div>
        )}

        {msg && (
          <div className={`notice${msg.kind === "bad" ? " notice--signal" : ""}`} style={{ marginTop: "var(--s-6)" }}>
            <div className="notice__title">{msg.title}</div>
            {msg.lines.filter(Boolean).map((l) => <div key={l} style={{ marginTop: 2 }}>{l}</div>)}
          </div>
        )}
      </section>

      {vault.term && (
        <section className="section">
          <div className="section-head">
            <h2>{vault.term.name}</h2>
            <div className="toolbar no-print">
              <button className="btn btn--sm" onClick={addCourse}>+ Add course</button>
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: "var(--s-8)" }}>
            <label className="field">
              <span className="label">Term name</span>
              <input
                className="input"
                value={vault.term.name}
                onChange={(e) => api.update((v) => ({ ...v, term: v.term ? { ...v.term, name: e.target.value } : v.term }))}
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-2)" }}>
              <label className="field">
                <span className="label">First day</span>
                <input
                  className="input" type="date" value={vault.term.startDate}
                  onChange={(e) => api.update((v) => ({ ...v, term: v.term ? { ...v.term, startDate: e.target.value } : v.term }))}
                />
              </label>
              <label className="field">
                <span className="label">Last day</span>
                <input
                  className="input" type="date" value={vault.term.endDate}
                  onChange={(e) => api.update((v) => ({ ...v, term: v.term ? { ...v.term, endDate: e.target.value } : v.term }))}
                />
              </label>
            </div>
          </div>

          {vault.term.courses.map((course) => (
            <div key={course.id} className="avoid-break" style={{ borderTop: "var(--separator) solid var(--label)", paddingBlock: "var(--s-4)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 1fr) minmax(180px, 2fr) auto", gap: "var(--s-2)", alignItems: "end" }}>
                <label className="field">
                  <span className="label">Code</span>
                  <input className="input" value={course.code} onChange={(e) => patchCourse(course.id, { code: e.target.value })} />
                </label>
                <label className="field">
                  <span className="label">Title</span>
                  <input className="input" value={course.title} onChange={(e) => patchCourse(course.id, { title: e.target.value })} />
                </label>
                <button className="btn btn--sm btn--ghost" onClick={() => removeCourse(course.id)} aria-label={`Remove ${course.code}`}>
                  Remove
                </button>
              </div>

              {course.meetings.length === 0 && (
                <div className="notice notice--signal" style={{ marginTop: "var(--s-2)" }}>
                  <div className="notice__title">No meeting times</div>
                  This course will not block any time until you add when it meets.
                </div>
              )}

              {course.meetings.map((m, i) => (
                <div key={i} style={{ display: "flex", gap: "var(--s-4)", flexWrap: "wrap", alignItems: "end", marginTop: "var(--s-2)" }}>
                  <div>
                    <span className="label" style={{ display: "block", marginBottom: 4 }}>Days</span>
                    <div className="seg">
                      {WEEKDAYS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={m.days.includes(d)}
                          onClick={() => patchMeeting(course.id, i, {
                            days: m.days.includes(d) ? m.days.filter((x) => x !== d) : [...m.days, d],
                          })}
                        >
                          {DAY_LABELS[d]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="field" style={{ width: 110 }}>
                    <span className="label">Start</span>
                    <input
                      className="input" type="time" value={hcolonmm(m.startMin)}
                      onChange={(e) => { try { patchMeeting(course.id, i, { startMin: toMinutes(e.target.value) }); } catch { /* mid-edit */ } }}
                    />
                  </label>
                  <label className="field" style={{ width: 110 }}>
                    <span className="label">End</span>
                    <input
                      className="input" type="time" value={hcolonmm(m.endMin)}
                      onChange={(e) => { try { patchMeeting(course.id, i, { endMin: toMinutes(e.target.value) }); } catch { /* mid-edit */ } }}
                    />
                  </label>
                  <label className="field" style={{ minWidth: 120, flex: 1 }}>
                    <span className="label">Room</span>
                    <input
                      className="input" value={m.location ?? ""}
                      onChange={(e) => patchMeeting(course.id, i, { location: e.target.value || undefined })}
                    />
                  </label>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      <Settings />
    </div>
  );
}

function Settings() {
  const api = useVault();
  const { vault, storageFailed } = api;
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // Off by default: an export is a file people email themselves.
  const [carryKey, setCarryKey] = useState(false);

  return (
    <section className="section">
      <div className="section-head">
        <h2>Settings</h2>
        <span className="label">Everything stays in this browser</span>
      </div>

      {storageFailed && (
        <div className="notice notice--signal" style={{ marginBottom: "var(--s-6)" }}>
          <div className="notice__title">Could not save to this browser</div>
          Storage is full or blocked — a private window will do this. Your changes are live on
          screen but will not survive a reload. Export your vault to keep them.
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: "var(--s-6)" }}>
        <label className="field">
          <span className="label">Class</span>
          <select
            className="select"
            value={vault.settings.cadet.class}
            onChange={(e) => api.setSettings({
              cadet: { ...vault.settings.cadet, class: e.target.value as "4/C" | "3/C" | "2/C" | "1/C" },
            })}
          >
            {["4/C", "3/C", "2/C", "1/C"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Company</span>
          <input
            className="input"
            value={vault.settings.cadet.company}
            onChange={(e) => api.setSettings({
              cadet: { ...vault.settings.cadet, company: e.target.value },
            })}
          />
        </label>
        <label className="field">
          <span className="label">Athletics</span>
          <select
            className="select"
            value={vault.settings.cadet.athletics}
            onChange={(e) => api.setSettings({
              cadet: { ...vault.settings.cadet, athletics: e.target.value as "none" | "ncaa" | "club" },
            })}
          >
            <option value="none">None — regular Corps PT</option>
            <option value="ncaa">NCAA team</option>
            <option value="club">Club sport</option>
          </select>
        </label>
        {vault.settings.cadet.athletics === "ncaa" && (
          <label className="field">
            <span className="label">Team</span>
            <input
              className="input"
              value={vault.settings.cadet.team ?? ""}
              onChange={(e) => api.setSettings({
                cadet: { ...vault.settings.cadet, team: e.target.value || undefined },
              })}
            />
          </label>
        )}
      </div>

      <p className="prose" style={{ fontSize: "var(--t-footnote)", marginBottom: "var(--s-6)" }}>
        The Matrix lists the whole Corps&apos; week. This is how the app knows which rows are
        yours — Guard Mount rotates by company, Rat Challenge is for Rats, Band Practice is
        for Band.
      </p>

      <div className="grid-2">
        <label className="field">
          <span className="label">Timezone</span>
          <input
            className="input" value={vault.settings.timezone}
            onChange={(e) => api.setSettings({ timezone: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="label">Focused work per day — the honest number</span>
          <input
            className="input" type="number" min={30} max={720} step={30}
            value={vault.settings.dailyCapacityMin}
            onChange={(e) => api.setSettings({ dailyCapacityMin: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          <span className="label">Nothing scheduled before</span>
          <input
            className="input" type="time" value={hcolonmm(vault.settings.dayStartMin)}
            onChange={(e) => { try { api.setSettings({ dayStartMin: toMinutes(e.target.value) }); } catch { /* mid-edit */ } }}
          />
        </label>
        <label className="field">
          <span className="label">Nothing scheduled after</span>
          <input
            className="input" type="time" value={hcolonmm(vault.settings.dayEndMin)}
            onChange={(e) => { try { api.setSettings({ dayEndMin: toMinutes(e.target.value) }); } catch { /* mid-edit */ } }}
          />
        </label>
      </div>

      <div className="toolbar no-print" style={{ marginTop: "var(--s-8)" }}>
        <button className="btn" onClick={() => api.exportVault({ includeKey: carryKey })}>
          Export everything
        </button>
        <label
          className="label"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        >
          <input type="checkbox" checked={carryKey} onChange={(e) => setCarryKey(e.target.checked)} />
          Include my Gemini key
        </label>
        <label className="btn" style={{ cursor: "pointer" }}>
          Import a vault
          <input
            type="file" accept="application/json,.json" className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = await api.importVault(f);
              setImportMsg(
                r.ok
                  ? r.keyRestored
                    ? "Imported, Gemini key included."
                    : "Imported."
                  : r.error ?? "Import failed.",
              );
              e.target.value = "";
            }}
          />
        </label>
        <button
          className="btn btn--signal"
          onClick={() => { if (confirm("Erase everything stored in this browser? This cannot be undone.")) api.reset(); }}
        >
          Erase everything
        </button>
        {importMsg && <span className="label label--ink">{importMsg}</span>}
      </div>
    </section>
  );
}
