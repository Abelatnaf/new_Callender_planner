/** Half-open wall-clock intervals [startMin, endMin) within a single day. */
export type Interval = { startMin: number; endMin: number };

export function isValid(i: Interval): boolean {
  return i.endMin > i.startMin;
}

export function duration(i: Interval): number {
  return Math.max(0, i.endMin - i.startMin);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return inner.startMin >= outer.startMin && inner.endMin <= outer.endMin;
}

export function intersect(a: Interval, b: Interval): Interval | null {
  const startMin = Math.max(a.startMin, b.startMin);
  const endMin = Math.min(a.endMin, b.endMin);
  return endMin > startMin ? { startMin, endMin } : null;
}

/** Sort and coalesce. Touching intervals (end === start) merge into one. */
export function normalize(intervals: Interval[]): Interval[] {
  const valid = intervals.filter(isValid).sort((a, b) => a.startMin - b.startMin);
  const out: Interval[] = [];
  for (const cur of valid) {
    const last = out[out.length - 1];
    if (last && cur.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, cur.endMin);
    } else {
      // Construct a clean interval: callers pass richer objects (MatrixEvent,
      // course meetings) and must not get those fields back out of the algebra.
      out.push({ startMin: cur.startMin, endMin: cur.endMin });
    }
  }
  return out;
}

/** base minus cut. Both are normalized internally, so inputs may be messy. */
export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  const cuts = normalize(cut);
  let result = normalize(base);

  for (const c of cuts) {
    const next: Interval[] = [];
    for (const b of result) {
      if (!overlaps(b, c)) {
        next.push(b);
        continue;
      }
      if (b.startMin < c.startMin) next.push({ startMin: b.startMin, endMin: c.startMin });
      if (c.endMin < b.endMin) next.push({ startMin: c.endMin, endMin: b.endMin });
    }
    result = next;
  }
  return result.filter(isValid);
}

/** Total covered minutes, counting overlap once. */
export function totalMinutes(intervals: Interval[]): number {
  return normalize(intervals).reduce((sum, i) => sum + duration(i), 0);
}
