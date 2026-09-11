/**
 * Time primitives.
 *
 * Everything in this app is wall-clock local time, represented as
 * (localDate: "YYYY-MM-DD", minutesFromMidnight: 0..1440).
 *
 * Why not Date objects: a cadet thinks "1930 Thursday", not "an instant in
 * UTC". Storing wall-clock minutes keeps gap arithmetic exact and makes DST a
 * non-event for scheduling (a 0900-1000 block is one hour of wall clock in
 * March as in July). The single place we cross the boundary is Canvas .ics,
 * which hands us real UTC instants; those are converted once, at parse time.
 */

export const DEFAULT_TZ = "America/New_York";

/** Minutes in a day. */
export const DAY_MINUTES = 24 * 60;

/** Shorter than this and a gap is not worth walking back to your room for. */
export const MIN_USEFUL_GAP = 20;

/** No scheduled work block may be shorter than this. */
export const MIN_BLOCK = 15;

/** Work blocks snap to this grid. */
export const SNAP = 15;

export type LocalDate = string; // YYYY-MM-DD
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export const WEEKDAY_LONG: Record<Weekday, string> = {
  SU: "SUNDAY",
  MO: "MONDAY",
  TU: "TUESDAY",
  WE: "WEDNESDAY",
  TH: "THURSDAY",
  FR: "FRIDAY",
  SA: "SATURDAY",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(s: string): boolean {
  return DATE_RE.test(s);
}

/** "09:30" | "0930" | "9:30 PM" | "930" -> minutes from midnight. */
export function toMinutes(input: string): number {
  const s = input.trim().toUpperCase();
  const ampm = /\b(AM|PM)\b/.exec(s);
  const digits = /(\d{1,2})\s*[:.]?\s*(\d{2})?/.exec(s);
  if (!digits) throw new Error(`unparseable time: ${input}`);

  let h = Number(digits[1]);
  const m = Number(digits[2] ?? 0);

  // A bare 3-4 digit run like "0930" or "930" is military time, not an hour.
  if (!digits[2] && /^\d{3,4}$/.test(s.replace(/\D/g, "")) && !ampm) {
    const raw = s.replace(/\D/g, "").padStart(4, "0");
    return Number(raw.slice(0, 2)) * 60 + Number(raw.slice(2));
  }

  if (ampm) {
    if (ampm[1] === "PM" && h !== 12) h += 12;
    if (ampm[1] === "AM" && h === 12) h = 0;
  }
  if (h > 23 || m > 59) throw new Error(`out-of-range time: ${input}`);
  return h * 60 + m;
}

/** 1170 -> "1930" */
export function hhmm(min: number): string {
  const m = ((Math.round(min) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return String(Math.floor(m / 60)).padStart(2, "0") + String(m % 60).padStart(2, "0");
}

/** 1170 -> "19:30" */
export function hcolonmm(min: number): string {
  const s = hhmm(min);
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

/** 160 -> "2H 40M"; 45 -> "45M"; 120 -> "2H" */
export function formatDuration(min: number): string {
  const t = Math.max(0, Math.round(min));
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h && m) return `${h}H ${m}M`;
  if (h) return `${h}H`;
  return `${m}M`;
}

/** Round to the nearest SNAP-minute boundary. */
export function snap(min: number, grid = SNAP): number {
  return Math.round(min / grid) * grid;
}

/** Round up to the next SNAP boundary. Never moves a start earlier. */
export function snapCeil(min: number, grid = SNAP): number {
  return Math.ceil(min / grid) * grid;
}

/** Round down to the previous SNAP boundary. Never moves an end later. */
export function snapFloor(min: number, grid = SNAP): number {
  return Math.floor(min / grid) * grid;
}

/* ------------------------------------------------------------------ dates */

/** Parse "YYYY-MM-DD" into its numeric parts without touching Date/UTC. */
export function dateParts(d: LocalDate): { y: number; m: number; d: number } {
  if (!isLocalDate(d)) throw new Error(`bad local date: ${d}`);
  return { y: +d.slice(0, 4), m: +d.slice(5, 7), d: +d.slice(8, 10) };
}

/** Days since epoch for a local date. Calendar arithmetic only - no timezone. */
export function toEpochDay(d: LocalDate): number {
  const { y, m, d: day } = dateParts(d);
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
}

export function fromEpochDay(n: number): LocalDate {
  const dt = new Date(n * 86_400_000);
  return [
    String(dt.getUTCFullYear()).padStart(4, "0"),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function addDays(d: LocalDate, n: number): LocalDate {
  return fromEpochDay(toEpochDay(d) + n);
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** 0 = Sunday .. 6 = Saturday */
export function dayOfWeek(d: LocalDate): number {
  // 1970-01-01 was a Thursday (index 4).
  return (((toEpochDay(d) + 4) % 7) + 7) % 7;
}

export function weekdayOf(d: LocalDate): Weekday {
  return WEEKDAYS[dayOfWeek(d)];
}

/** The Monday on or before `d`. VMI weeks run Monday-Sunday. */
export function weekStart(d: LocalDate): LocalDate {
  const dow = dayOfWeek(d);
  const back = dow === 0 ? 6 : dow - 1; // Sunday belongs to the week that began Monday
  return addDays(d, -back);
}

export function weekDates(start: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** "2026-09-11" -> "11 SEP" */
export function shortDate(d: LocalDate): string {
  const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const { m, d: day } = dateParts(d);
  return `${String(day).padStart(2, "0")} ${MON[m - 1]}`;
}

/* -------------------------------------------------------------- timezone */

/**
 * Convert a real instant (what .ics hands us) into local wall clock.
 * Uses Intl so DST is handled by the platform tz database, not by us.
 */
export function instantToLocal(
  instant: Date,
  tz: string = DEFAULT_TZ,
): { date: LocalDate; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  // Intl renders midnight as "24" in some ICU versions.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(hour) * 60 + Number(parts.minute),
  };
}

/** Today, in the planner's timezone. */
export function todayLocal(tz: string = DEFAULT_TZ, now = new Date()): LocalDate {
  return instantToLocal(now, tz).date;
}

/** Sortable key so (date, minutes) pairs compare as one number. */
export function stamp(date: LocalDate, minutes: number): number {
  return toEpochDay(date) * DAY_MINUTES + minutes;
}
