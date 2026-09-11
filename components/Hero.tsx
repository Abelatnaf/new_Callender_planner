"use client";

/**
 * The hero.
 *
 * Replaces four identical stat boxes with one claim: this is how much of the
 * week is actually yours. The figure is set large and filled with the same
 * time-of-day gradient the ribbon uses, so the headline and the chart speak
 * the same language.
 *
 * Beside it, the week's light as seven bars — the whole shape of the week
 * before you have read a single label.
 */
import type { DayInventory } from "@/lib/gaps";
import { glowBand } from "@/lib/layout";
import { WEEKDAY_LONG, formatDuration, weekdayOf } from "@/lib/time";

export function Hero({
  freeMinutes, takenMinutes, committedMinutes, doneMinutes = 0, overdue, days, today,
}: {
  freeMinutes: number;
  takenMinutes: number;
  committedMinutes: number;
  doneMinutes?: number;
  overdue: number;
  days: DayInventory[];
  today: string;
}) {
  const busiest = Math.max(1, ...days.map((d) => d.freeMinutes));

  return (
    <section className="hero">
      <div className="hero__figure">
        <div className="hero__num">{formatDuration(freeMinutes)}</div>
        <div className="hero__cap">is actually yours this week</div>
      </div>

      <div className="hero__week" role="img" aria-label="Free time by day">
        {days.map((d) => {
          // The dominant light of each day decides that column's colour.
          const minutes = d.gaps.reduce<Record<string, number>>((acc, g) => {
            const b = glowBand(g.startMin);
            acc[b] = (acc[b] ?? 0) + g.minutes;
            return acc;
          }, {});
          const band = Object.entries(minutes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "day";
          const h = Math.max(3, Math.round((d.freeMinutes / busiest) * 100));
          return (
            <div key={d.date} className="hero__day" title={`${d.date}: ${formatDuration(d.freeMinutes)} free`}>
              <div className="hero__bar-track">
                <div className={`hero__bar gap--${band}`} style={{ height: `${h}%` }} />
              </div>
              <span className={`hero__daylabel${d.date === today ? " is-today" : ""}`}>
                {WEEKDAY_LONG[weekdayOf(d.date)].slice(0, 1)}
              </span>
            </div>
          );
        })}
      </div>

      <dl className="hero__stats">
        <Stat label="Taken from you" value={formatDuration(takenMinutes)} />
        <Stat label="Work planned" value={formatDuration(committedMinutes)} />
        <Stat label="Done" value={formatDuration(doneMinutes)} />
        <Stat label="Overdue" value={String(overdue)} alert={overdue > 0} />
      </dl>
    </section>
  );
}

function Stat({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="hero__stat">
      <dt>{label}</dt>
      <dd className={alert ? "is-alert" : undefined}>{value}</dd>
    </div>
  );
}
