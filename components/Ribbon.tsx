"use client";

/**
 * The Ribbon.
 *
 * Every calendar draws the events. This draws the gaps — because the question
 * the app exists to answer is "which hours are actually mine?", and drawing
 * that answer as empty space was backwards.
 *
 * So the paint order is the argument: light first and prominent, the void
 * second and recessed, claimed work last and on top. You cannot negotiate with
 * a formation, so only the chips are interactive.
 */
import type { Assignment, Gap, MatrixEvent, WorkBlock } from "@/lib/schemas";
import {
  type Axis, barDetail, gapGradient, glowBand, hourTicks, hueFor, isUrgent, placement, toPct,
} from "@/lib/layout";
import { WEEKDAY_LONG, formatDuration, hhmm, shortDate, weekdayOf, type LocalDate } from "@/lib/time";

export function RibbonScale({ axis, every = 2 }: { axis: Axis; every?: number }) {
  return (
    <div className="ribbon-scale" aria-hidden="true">
      <div />
      <div className="ribbon-scale__track">
        {hourTicks(axis, every).map((m) => (
          <span key={m} className="ribbon-scale__tick" style={{ left: `${toPct(m, axis)}%` }}>
            {hhmm(m)}
          </span>
        ))}
      </div>
    </div>
  );
}

export type RibbonProps = {
  date: LocalDate;
  axis: Axis;
  events: MatrixEvent[];
  meetings: Array<{ startMin: number; endMin: number; code: string }>;
  blocks: WorkBlock[];
  gaps: Gap[];
  assignments: Assignment[];
  nowStamp: number;
  nowMinutes?: number;
  isToday?: boolean;
  rowIndex?: number;
  dense?: boolean;
  capacityMin?: number;
  hues?: Map<string, number>;
  onSelectBlock?: (block: WorkBlock) => void;
};

export function Ribbon({
  date, axis, events, meetings, blocks, gaps, assignments,
  nowStamp, nowMinutes, isToday = false, rowIndex = 0, dense = false,
  capacityMin, hues, onSelectBlock,
}: RibbonProps) {
  const byId = new Map(assignments.map((a) => [a.id, a]));

  // Obligations: classes plus anything the Matrix marked BLOCKED.
  const voids = [
    ...meetings.map((m, i) => ({
      key: `m${i}`, startMin: m.startMin, endMin: m.endMin, label: m.code, ai: false,
    })),
    ...events
      .filter((e) => e.availability === "BLOCKED")
      .map((e) => ({
        key: e.id, startMin: e.startMin, endMin: e.endMin, label: e.title,
        ai: !e.confirmedByUser,
      })),
  ].sort((a, b) => a.startMin - b.startMin);

  const committed = blocks.reduce((n, b) => n + (b.endMin - b.startMin), 0);
  const free = gaps.reduce((n, g) => n + g.minutes, 0);

  return (
    <div className={`ribbon-row${isToday ? " ribbon-row--today" : ""}`}>
      <div className="ribbon-stub">
        <span className="ribbon-stub__day">{WEEKDAY_LONG[weekdayOf(date)].slice(0, 3)}</span>
        <span className="ribbon-stub__date">{shortDate(date)}</span>
        {capacityMin !== undefined && (
          <div
            className="meter"
            title={`${formatDuration(committed)} committed of ${formatDuration(capacityMin)}`}
          >
            <div
              className={`meter__fill${committed > capacityMin ? " is-over" : ""}`}
              style={{ width: `${Math.min(100, (committed / Math.max(1, capacityMin)) * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div
        className={`ribbon${dense ? " ribbon--dense" : ""}`}
        style={{ ["--row" as string]: rowIndex }}
        role="img"
        aria-label={
          `${WEEKDAY_LONG[weekdayOf(date)]} ${date}: ` +
          `${formatDuration(free)} free across ${gaps.length} windows, ` +
          `${formatDuration(committed)} of work planned.`
        }
      >
        {/* LIGHT — free time. Painted first, because it is the answer. */}
        {gaps.map((g, i) => {
          const pos = placement(g.startMin, g.endMin, axis);
          if (!pos) return null;
          const bound = g.quality === "ROOM_BOUND";
          const wide = pos.widthPct > 4;
          return (
            <div
              key={g.id}
              className={`gap gap--${glowBand(g.startMin)}${bound ? " gap--bound" : ""}`}
              style={{
                left: pos.left,
                width: pos.width,
                ["--i" as string]: i,
                backgroundImage: gapGradient(g.startMin, g.endMin),
              }}
              title={`${hhmm(g.startMin)}–${hhmm(g.endMin)} free${g.label ? ` · ${g.label}` : ""} · ${formatDuration(g.minutes)}`}
            >
              {bound && wide && g.label
                ? <span className="gap__tag">{g.label}</span>
                : <span className="gap__len">{formatDuration(g.minutes)}</span>}
            </div>
          );
        })}

        {/* VOID — obligations. Recessed, inert, not interactive. */}
        {voids.map((v) => {
          const pos = placement(v.startMin, v.endMin, axis);
          if (!pos) return null;
          const detail = barDetail(pos.widthPct);
          return (
            <div
              key={v.key}
              className={`void${v.ai ? " void--ai" : ""}${detail === "label" ? " void--tight" : ""}`}
              style={{ left: pos.left, width: pos.width }}
              title={`${v.label} ${hhmm(v.startMin)}–${hhmm(v.endMin)} — mandatory`}
            >
              {detail !== "none" && <span className="void__label">{v.label}</span>}
              {detail === "full" && <span className="void__time">{hhmm(v.startMin)}</span>}
            </div>
          );
        })}

        {/* CLAIMED — work you put into your own light. */}
        {blocks.map((b) => {
          const pos = placement(b.startMin, b.endMin, axis);
          if (!pos) return null;
          const a = byId.get(b.assignmentId);
          const label = a?.courseCode ?? a?.title ?? "Work";
          const detail = barDetail(pos.widthPct);
          const urgent = isUrgent(a, nowStamp);
          const cls = [
            "chip",
            `chip--h${hueFor(a?.courseCode, hues)}`,
            b.locked ? "is-locked" : "",
            urgent ? "is-urgent" : "",
            detail === "label" ? "chip--tight" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={b.id}
              type="button"
              className={cls}
              style={{ left: pos.left, width: pos.width, ["--row" as string]: rowIndex }}
              onClick={() => onSelectBlock?.(b)}
              title={`${label} ${hhmm(b.startMin)}–${hhmm(b.endMin)}${b.rationale ? ` — ${b.rationale}` : ""}`}
            >
              {detail !== "none" && <span className="chip__label">{label}</span>}
              {detail === "full" && (
                <span className="chip__time">{formatDuration(b.endMin - b.startMin)}</span>
              )}
            </button>
          );
        })}

        {isToday && nowMinutes !== undefined && nowMinutes >= axis.startMin && nowMinutes <= axis.endMin && (
          <div className="ribbon__now" style={{ left: `${toPct(nowMinutes, axis)}%` }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
