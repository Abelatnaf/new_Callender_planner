"use client";

/**
 * Ask the week a question.
 *
 * A slide-over rather than a page, because the answer is only useful next to
 * the schedule it is about. Streams, so a slow answer still feels alive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Plan, Vault } from "@/lib/schemas";
import { keyHeaders } from "@/lib/apikey";

type Turn = { role: "user" | "model"; text: string };

const SUGGESTIONS = [
  "Can I take Saturday off?",
  "What is the single worst hour of this week?",
  "What should I start tonight?",
  "Am I actually going to finish everything?",
];

export function AskPanel({
  open, onClose, weekStart, vault, plan,
}: {
  open: boolean;
  onClose: () => void;
  weekStart: string;
  vault: Vault;
  plan: Plan | null;
}) {
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history]);

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const priorHistory = history;
    setHistory((h) => [...h, { role: "user", text: q }, { role: "model", text: "" }]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: keyHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          question: q,
          history: priorHistory,
          weekStart,
          term: vault.term,
          events: vault.matrixWeeks.find((w) => w.weekStart === weekStart)?.events ?? [],
          assignments: vault.assignments,
          plan,
          settings: vault.settings,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({ error: "The request failed." }));
        throw new Error(data.error ?? "The request failed.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setHistory((h) => {
          const next = [...h];
          next[next.length - 1] = { role: "model", text: acc };
          return next;
        });
      }
    } catch (e) {
      setHistory((h) => {
        const next = [...h];
        next[next.length - 1] = {
          role: "model",
          text: e instanceof Error ? e.message : "Something went wrong.",
        };
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, [busy, history, weekStart, vault, plan]);

  if (!open) return null;

  return (
    <div className="ask-backdrop no-print" onClick={onClose}>
      <aside
        className="ask-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Ask about this week"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ask-panel__head">
          <h2 style={{ fontSize: "var(--t-lg)" }}>Ask</h2>
          <button className="btn btn--sm btn--ghost" onClick={onClose}>Close ✕</button>
        </div>

        <div className="ask-panel__body">
          {history.length === 0 && (
            <>
              <p className="muted" style={{ fontSize: "var(--t-footnote)", marginBottom: "var(--s-4)" }}>
                Answered against this week&apos;s real schedule — not a general opinion about studying.
              </p>
              <div style={{ display: "grid", gap: 6 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="btn btn--sm" style={{ justifyContent: "flex-start", textTransform: "none", letterSpacing: 0 }} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}

          {history.map((t, i) => (
            <div key={i} className={`turn turn--${t.role}`}>
              <div className="label">{t.role === "user" ? "You" : "Order"}</div>
              <div className="turn__text">
                {t.text || (busy && i === history.length - 1 ? <span className="working">Thinking</span> : null)}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <form
          className="ask-panel__foot"
          onSubmit={(e) => { e.preventDefault(); send(input); }}
        >
          <textarea
            ref={inputRef}
            className="textarea"
            style={{ minHeight: 62 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
            }}
            placeholder="Ask about this week…"
            disabled={busy}
          />
          <button className="btn btn--solid" type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "Ask"}
          </button>
        </form>
      </aside>
    </div>
  );
}
