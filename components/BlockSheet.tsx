"use client";

/**
 * What happens when you click a work block.
 *
 * Until this existed every chip was a dead button: the plan could be made and
 * printed, but the screen went read-only the moment it was generated. A plan
 * that cannot absorb contact with the real week gets abandoned.
 *
 * Nudge buttons rather than drag. Drag is worse on every axis that matters
 * here: unusable by keyboard, awkward on the phone this gets opened on at 0600,
 * and it invites a drop that then has to be silently rejected. Each nudge is an
 * explicit transaction that either succeeds or says why it did not.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Assignment, WorkBlock } from "@/lib/schemas";
import type { WeekInventory } from "@/lib/gaps";
import { moveBlock, resizeBlock, type PlacementContext } from "@/lib/validate";
import { MIN_BLOCK, formatDuration, hhmm, shortDate } from "@/lib/time";

export function BlockSheet({
  block, assignment, siblings, inventory, nowStamp, onChange, onRemove, onClose,
}: {
  block: WorkBlock;
  assignment?: Assignment;
  /** Every other block in the plan, for overlap checks. */
  siblings: WorkBlock[];
  inventory: WeekInventory;
  nowStamp: number;
  onChange: (next: WorkBlock) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Escape closes; Tab cycles inside the sheet rather than escaping behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ctx: PlacementContext = { inventory, others: siblings, nowStamp };

  const attempt = useCallback((fn: () => ReturnType<typeof moveBlock>) => {
    if (!assignment) { setRefusal("This block has no assignment in the backlog."); return; }
    const r = fn();
    if (r.ok && r.block) { setRefusal(null); onChange(r.block); }
    else if (!r.ok) setRefusal(r.reason);
  }, [assignment, onChange]);

  const minutes = block.endMin - block.startMin;

  // Probe each nudge before offering it. These are pure functions, so asking
  // "would this work?" costs nothing - and a disabled button that explains
  // itself beats a live one that only ever answers no.
  const probe = (fn: () => ReturnType<typeof moveBlock>) =>
    assignment ? fn() : ({ ok: false, reason: "no assignment" } as const);
  const canEarlier = probe(() => moveBlock(block, -15, assignment!, ctx));
  const canLater   = probe(() => moveBlock(block, 15, assignment!, ctx));
  const canShorter = probe(() => resizeBlock(block, -15, assignment!, ctx));
  const canLonger  = probe(() => resizeBlock(block, 15, assignment!, ctx));

  const boxedIn = !canEarlier.ok && !canLater.ok && !canLonger.ok;

  return (
    <div className="sheet-backdrop no-print" onClick={onClose}>
      <div
        ref={panelRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Work block"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet__head">
          <div>
            <div className="label">{shortDate(block.date)} · {hhmm(block.startMin)}–{hhmm(block.endMin)}</div>
            <h2 style={{ fontSize: "var(--t-lg)", marginTop: 2 }}>
              {assignment?.courseCode ? `${assignment.courseCode} · ` : ""}
              {assignment?.title ?? "Unknown assignment"}
            </h2>
          </div>
          <button ref={firstRef} className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>

        <div className="sheet__body">
          {block.rationale && (
            <p className="prose" style={{ fontSize: "var(--t-sub)", marginBottom: "var(--s-5)" }}>
              {block.rationale}
            </p>
          )}

          <button
            className={`sheet__done${block.done ? " is-done" : ""}`}
            onClick={() => onChange({ ...block, done: !block.done })}
            aria-pressed={block.done}
          >
            <span className="sheet__check" aria-hidden="true">{block.done ? "✓" : ""}</span>
            {block.done ? "Done" : "Mark this sitting done"}
          </button>

          <Row label="Move" hint={formatDuration(minutes)}>
            <button
              className="btn btn--sm"
              disabled={!canEarlier.ok}
              title={canEarlier.ok ? undefined : canEarlier.reason}
              onClick={() => attempt(() => moveBlock(block, -15, assignment!, ctx))}
            >
              ← 15 earlier
            </button>
            <button
              className="btn btn--sm"
              disabled={!canLater.ok}
              title={canLater.ok ? undefined : canLater.reason}
              onClick={() => attempt(() => moveBlock(block, 15, assignment!, ctx))}
            >
              15 later →
            </button>
          </Row>

          <Row label="Length" hint={`minimum ${MIN_BLOCK} min`}>
            <button
              className="btn btn--sm"
              disabled={!canShorter.ok}
              title={canShorter.ok ? undefined : canShorter.reason}
              onClick={() => attempt(() => resizeBlock(block, -15, assignment!, ctx))}
            >
              − 15
            </button>
            <button
              className="btn btn--sm"
              disabled={!canLonger.ok}
              title={canLonger.ok ? undefined : canLonger.reason}
              onClick={() => attempt(() => resizeBlock(block, 15, assignment!, ctx))}
            >
              + 15
            </button>
          </Row>

          {boxedIn && (
            <p className="label" style={{ marginTop: "var(--s-3)" }}>
              This block is hemmed in by your obligations and other work. Remove it and
              re-plan the week if it needs to move.
            </p>
          )}

          <Row label="Keep" hint={block.locked ? "survives a re-plan" : "a re-plan may move it"}>
            <button
              className="btn btn--sm"
              aria-pressed={block.locked}
              onClick={() => onChange({ ...block, locked: !block.locked })}
            >
              {block.locked ? "Unlock" : "Lock in place"}
            </button>
          </Row>

          {refusal && (
            <p className="sheet__refusal" role="status">
              Can&apos;t do that — {refusal}.
            </p>
          )}
        </div>

        <footer className="sheet__foot">
          <button className="btn btn--sm btn--signal" onClick={() => { onRemove(block.id); onClose(); }}>
            Remove this block
          </button>
          <span className="label">The assignment stays in your backlog.</span>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="sheet__row">
      <div>
        <div className="label label--ink">{label}</div>
        {hint && <div className="label" style={{ fontSize: "var(--t-caption)" }}>{hint}</div>}
      </div>
      <div className="toolbar">{children}</div>
    </div>
  );
}
