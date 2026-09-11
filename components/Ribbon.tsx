"use client";

/**
 * The Ribbon.
 *
 * One day as a horizontal strip of time. Solid ink is what the Institute takes,
 * hatch is time the cadet holds but cannot leave the room for, a hairline box
 * is work they chose to put there, and bare paper is free.
 *
 * The bars are deliberately not interactive except for work blocks: you cannot
 * negotiate with a formation, and the interface should not imply otherwise.
 */
import type { Assignment, Gap, MatrixEvent, WorkBlock } from "@/lib/schemas";
import { type Axis, barsForDay, hourTicks, placement, toPct } from "@/lib/layout";
import { WEEKDAY_LONG, formatDuration, hhmm, shortDate, weekdayOf, type LocalDate } from "@/lib/time";

export function RibbonScale({ axis, every = 2 }: { axis: Axis; every?: number }) {
  return (
    <div className="ribbon-scale" aria-hidden="true">
      <div className="label" style={{ alignSelf: "end", paddingBottom: 2 }}>TIME</div>
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
  /** Minutes into today, when this row is today. Draws the vermilion now-line. */
  nowMinutes?: number;
  isToday?: boolean;
  rowIndex?: number;
  dense?: boolean;
  capacityMin?: number;
  onSelectBlock?: (block: WorkBlock) => void;
};

export function Ribbon({
  date, axis, events, meetings, blocks, gaps, assignments,
  nowStamp, nowMinutes, isToday = false, rowIndex = 0, dense = false,
  capacityMin, onSelectBlock,
}: RibbonProps) {
  const bars = barsForDay({ events, meetings, blocks, gaps, assignments, nowStamp });
  const committed = blocks.reduce((n, b) => n + (b.endMin - b.startMin), 0);
  const free = gaps.reduce((n, g) => n + g.minutes, 0);

  let i = 0;

  return (
    <div className={`ribbon-row${isToday ? " ribbon-row--today" : ""}`}>
      <div className="ribbon-stub">
        <span className="ribbon-stub__day">{WEEKDAY_LONG[weekdayOf(date)].slice(0, 3)}</span>
        <span className="ribbon-stub__date">{shortDate(date)}</span>
        {capacityMin !== undefined && (
          <div
            className="meter"
            title={`${formatDuration(committed)} committed of ${formatDuration(capacityMin)} capacity`}
          >
            <div
              className={`meter__fill${committed > capacityMin ? " is-over" : ""}`}
              style={{ width: `${Math.min(100, (committed / Math.max(1, capacityMin)) * 100)}%` }}
            />
            <div className="meter__cap" style={{ left: "100%" }} />
          </div>
        )}
      </div>

      <div
        className={`ribbon${dense ? " ribbon--dense" : ""}`}
        style={{ ["--row" as string]: rowIndex }}
        role="img"
        aria-label={
          `${WEEKDAY_LONG[weekdayOf(date)]} ${date}: ` +
          `${formatDuration(free)} free across ${gaps.length} slots, ` +
          `${formatDuration(committed)} of work scheduled.`
        }
      >
        {/* Free gaps sit underneath everything: they are the ground, not a layer. */}
        {bars.gaps.map((g) => {
          const pos = placement(g.startMin, g.endMin, axis);
          if (!pos) return null;
          return (
            <div
              key={g.id}
              className="gap"
              style={pos}
              data-duration={formatDuration(g.minutes)}
              title={`${hhmm(g.startMin)}-${hhmm(g.endMin)} free${g.label ? ` (${g.label})` : ""}`}
            />
          );
        })}

        {bars.hatch.map((b) => {
          const pos = placement(b.startMin, b.endMin, axis);
          if (!pos) return null;
          return (
            <div
              key={b.key}
              className={`bar bar--hatch${b.ai ? " bar--ai" : ""}`}
              style={{ ...pos, ["--i" as string]: i++ }}
              title={`${b.label} ${hhmm(b.startMin)}-${hhmm(b.endMin)} — yours, but confined`}
            >
              <span className="bar__label">{b.label}</span>
            </div>
          );
        })}

        {bars.ink.map((b) => {
          const pos = placement(b.startMin, b.endMin, axis);
          if (!pos) return null;
          return (
            <div
              key={b.key}
              className={`bar bar--ink${b.ai ? " bar--ai" : ""}`}
              style={{ ...pos, ["--i" as string]: i++ }}
              title={`${b.label} ${hhmm(b.startMin)}-${hhmm(b.endMin)} — mandatory`}
            >
              <span className="bar__label">{b.label}</span>
              <span className="bar__time">{hhmm(b.startMin)}</span>
            </div>
          );
        })}

        {bars.work.map((w) => {
          const pos = placement(w.block.startMin, w.block.endMin, axis);
          if (!pos) return null;
          const cls = [
            "bar", "bar--work",
            w.block.locked ? "is-locked" : "",
            w.urgent ? "is-urgent" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={w.key}
              type="button"
              className={cls}
              style={{ ...pos, ["--i" as string]: i++ }}
              onClick={() => onSelectBlock?.(w.block)}
              title={`${w.label} ${hhmm(w.block.startMin)}-${hhmm(w.block.endMin)}${w.block.rationale ? ` — ${w.block.rationale}` : ""}`}
            >
              <span className="bar__label">{w.label}</span>
              <span className="bar__time">{formatDuration(w.block.endMin - w.block.startMin)}</span>
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
