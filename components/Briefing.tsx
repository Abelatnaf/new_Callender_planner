/**
 * The briefing. Prose with a spine, plus the things that did not fit.
 *
 * Unplaced work is shown as prominently as the plan itself. A planner that
 * quietly drops what it could not fit is lying by omission, and the cadet finds
 * out on Thursday.
 */
import type { Assignment, Plan } from "@/lib/schemas";
import { hhmm, shortDate } from "@/lib/time";

export function Briefing({ plan, assignments }: { plan: Plan; assignments: Assignment[] }) {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const { briefing } = plan;
  const hasLists = briefing.crunchPoints.length > 0 || briefing.risks.length > 0 || briefing.sacrifice;

  return (
    <section className="section avoid-break">
      <div className="section-head">
        <h2>The read on this week</h2>
        <span className="label">
          Generated {new Date(plan.generatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </span>
      </div>

      <div style={{ display: "grid", gap: "var(--u-5)", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {briefing.prose && (
          <p className="prose" style={{ gridColumn: hasLists ? "auto" : "1 / -1" }}>
            {briefing.prose}
          </p>
        )}

        {briefing.crunchPoints.length > 0 && (
          <List title="Where it bites" items={briefing.crunchPoints} />
        )}
        {briefing.risks.length > 0 && (
          <List title="What goes wrong if you ignore this" items={briefing.risks} />
        )}
      </div>

      {briefing.sacrifice && (
        <div className="notice" style={{ marginTop: "var(--u-4)" }}>
          <div className="notice__title">If the week compresses, drop this first</div>
          {briefing.sacrifice}
        </div>
      )}

      {plan.unplaced.length > 0 && (
        <div className="notice notice--signal avoid-break" style={{ marginTop: "var(--u-4)" }}>
          <div className="notice__title">
            {plan.unplaced.length} item{plan.unplaced.length > 1 ? "s" : ""} would not fit
          </div>
          <ul style={{ listStyle: "none", marginTop: 6 }}>
            {plan.unplaced.map((u) => {
              const a = byId.get(u.assignmentId);
              return (
                <li key={u.assignmentId} style={{ padding: "4px 0" }}>
                  <strong>{a ? `${a.courseCode ? a.courseCode + " · " : ""}${a.title}` : u.assignmentId}</strong>
                  {a && <span className="muted"> (due {shortDate(a.dueDate)} {hhmm(a.dueMin)})</span>}
                  {" — "}{u.reason}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="label label--ink" style={{ marginBottom: "var(--u)" }}>{title}</h3>
      <ul style={{ listStyle: "none" }}>
        {items.map((t) => (
          <li
            key={t}
            style={{
              padding: "var(--u) 0",
              borderTop: "var(--rule-hair) solid var(--rule-faint)",
              fontSize: "var(--t-tiny)",
              lineHeight: 1.5,
              display: "flex",
              gap: "var(--u)",
            }}
          >
            <span aria-hidden="true" style={{ color: "var(--ink-4)" }}>—</span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
