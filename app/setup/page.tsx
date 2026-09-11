"use client";

/**
 * SEMESTER — the dedicated space for the thing that only changes once a term.
 *
 * Everything here is editable by hand after import. A wrong extraction should
 * cost thirty seconds of correction, not a term of quietly bad plans, and
 * changing terms must never require touching code.
 */
import { useCallback, useState } from "react";
import { Dropzone } from "@/components/Dropzone";
import { useVault } from "@/lib/store";
import type { Course, Term } from "@/lib/schemas";
import { WEEKDAYS, type Weekday, formatDuration, hcolonmm, toMinutes } from "@/lib/time";

const DAY_LABELS: Record<Weekday, string> = {
  SU: "Su", MO: "M", TU: "T", WE: "W", TH: "Th", FR: "F", SA: "Sa",
};

export default function SetupPage() {
  const api = useVault();
  const { vault, ready } = api;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; title: string; lines: string[] } | null>(null);
  const [paste, setPaste] = useState("");

  const importTerm = useCallback(async (payload: FormData) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/parse/term", { method: "POST", body: payload });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read that.");
      const term = data.term as Term;
      api.setTerm(term);
      setPaste("");
      setMsg({
        kind: "ok",
        title: `${term.name}: ${term.courses.length} courses`,
        lines: [
          "Check the meeting times below before you rely on them.",
          ...(data.warnings ?? []),
        ],
      });
    } catch (e) {
      setMsg({ kind: "bad", title: "Import failed", lines: [e instanceof Error ? e.message : "Unknown error."] });
    } finally {
      setBusy(false);
    }
  }, [api]);

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
            <h1 className="display" style={{ fontSize: "var(--t-3xl)" }}>Semester</h1>
          </div>
          {vault.term && (
            <div className="tally" style={{ textAlign: "right" }}>
              <span className="tally__n" style={{ fontSize: "var(--t-xl)" }}>{formatDuration(weeklyClassMin)}</span>
              <span className="tally__l">In class each week</span>
            </div>
          )}
        </div>

        <div className="grid-2">
          <Dropzone
            title="Drop your schedule"
            hint="Excel · PDF · whatever the registrar handed you"
            accept=".xlsx,.xls,.xlsm,.pdf,.csv,.txt,application/pdf"
            busy={busy}
            loaded={vault.term?.source?.filename ?? null}
            onFile={(file) => { const f = new FormData(); f.set("file", file); void importTerm(f); }}
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
              style={{ marginTop: "var(--u)" }}
              disabled={busy || !paste.trim()}
              onClick={() => { const f = new FormData(); f.set("text", paste); void importTerm(f); }}
            >
              Read pasted schedule
            </button>
          </div>
        </div>

        {msg && (
          <div className={`notice${msg.kind === "bad" ? " notice--signal" : ""}`} style={{ marginTop: "var(--u-3)" }}>
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

          <div className="grid-2" style={{ marginBottom: "var(--u-4)" }}>
            <label className="field">
              <span className="label">Term name</span>
              <input
                className="input"
                value={vault.term.name}
                onChange={(e) => api.update((v) => ({ ...v, term: v.term ? { ...v.term, name: e.target.value } : v.term }))}
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--u)" }}>
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
            <div key={course.id} className="avoid-break" style={{ borderTop: "var(--rule) solid var(--ink)", paddingBlock: "var(--u-2)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 1fr) minmax(180px, 2fr) auto", gap: "var(--u)", alignItems: "end" }}>
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
                <div className="notice notice--signal" style={{ marginTop: "var(--u)" }}>
                  <div className="notice__title">No meeting times</div>
                  This course will not block any time until you add when it meets.
                </div>
              )}

              {course.meetings.map((m, i) => (
                <div key={i} style={{ display: "flex", gap: "var(--u-2)", flexWrap: "wrap", alignItems: "end", marginTop: "var(--u)" }}>
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

  return (
    <section className="section">
      <div className="section-head">
        <h2>Settings</h2>
        <span className="label">Everything stays in this browser</span>
      </div>

      {storageFailed && (
        <div className="notice notice--signal" style={{ marginBottom: "var(--u-3)" }}>
          <div className="notice__title">Could not save to this browser</div>
          Storage is full or blocked — a private window will do this. Your changes are live on
          screen but will not survive a reload. Export your vault to keep them.
        </div>
      )}

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

      <div className="toolbar no-print" style={{ marginTop: "var(--u-4)" }}>
        <button className="btn" onClick={api.exportVault}>Export everything</button>
        <label className="btn" style={{ cursor: "pointer" }}>
          Import a vault
          <input
            type="file" accept="application/json,.json" className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const r = await api.importVault(f);
              setImportMsg(r.ok ? "Imported." : r.error ?? "Import failed.");
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
