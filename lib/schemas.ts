/**
 * The single source of truth for every shape in the app.
 *
 * These zod schemas do double duty: they validate what comes back from Gemini
 * at the API boundary, and `toGeminiSchema()` in lib/gemini.ts derives the
 * responseSchema we hand the model. One definition, both directions.
 */
import { z } from "zod";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const Minute = z.number().int().min(0).max(1440);

/* ------------------------------------------------------------------- term */

export const MeetingSchema = z.object({
  days: z.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).min(1),
  startMin: Minute,
  endMin: Minute,
  location: z.string().optional(),
});

export const CourseSchema = z.object({
  id: z.string(),
  code: z.string(),          // "CHEM 141"
  title: z.string(),
  instructor: z.string().optional(),
  credits: z.number().optional(),
  meetings: z.array(MeetingSchema),
});

export const TermSchema = z.object({
  id: z.string(),
  name: z.string(),          // "Fall 2026"
  startDate: LocalDate,
  endDate: LocalDate,
  courses: z.array(CourseSchema),
  source: z.object({ filename: z.string(), importedAt: z.string() }).optional(),
});

/* ----------------------------------------------------------------- matrix */

/**
 * BLOCKED  - you must be somewhere doing something. Never schedulable.
 * USABLE   - time the Matrix hands you (CQ, ESP, open evening). Schedulable.
 * PARTIAL  - schedulable but constrained, e.g. confined to your room.
 *
 * The ratchet: anything the model is unsure about becomes BLOCKED. The model
 * may only take time away from you, never hand it back, without confirmation.
 */
export const AvailabilitySchema = z.enum(["BLOCKED", "USABLE", "PARTIAL"]);

export const MatrixEventKindSchema = z.enum([
  "formation", "class", "parade", "inspection", "duty",
  "athletics", "meal", "study", "academic", "other",
]);

export const MatrixEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  raw: z.string(),                 // verbatim cell text, so a bad parse is auditable
  date: LocalDate,
  startMin: Minute,
  endMin: Minute,
  kind: MatrixEventKindSchema,
  availability: AvailabilitySchema,
  confidence: z.number().min(0).max(1),
  note: z.string().optional(),     // why the model classified it this way
  /** The Matrix's PAX column: who this row is for. */
  pax: z.string().default(""),
  /**
   * Where it happens, and what to wear.
   *
   * Both are columns of the real Matrix and both are what a cadet actually
   * needs at 0600 - "Crozet" and "Class Dyke" answer the two questions a
   * printed page is carried around to answer. Dropping them, as this schema
   * used to, threw away the most practical half of every row.
   */
  location: z.string().default(""),
  uniform: z.string().default(""),
  /** The Matrix gave a start but no end; the duration below is inferred. */
  endEstimated: z.boolean().default(false),
  /**
   * Whether this row is this cadet's problem at all.
   *
   * False means it stays visible but never consumes time - Band Practice for a
   * non-Band cadet, Guard Mount for another company. Most Matrix rows are
   * somebody else's.
   */
  appliesToMe: z.boolean().default(true),
  confirmedByUser: z.boolean().default(false),
  /** True when the ratchet overrode the model and forced this to BLOCKED. */
  ratcheted: z.boolean().default(false),
});

/**
 * What happened during one import, kept so the document can show its working.
 *
 * The reference document prints this at the foot of its last page - "20 source
 * rows filtered out as not applying to a Rat; 33 times estimated because the
 * matrix gives no end time" - and it is the most trustworthy thing on the page.
 * A schedule that tells you which parts of it were guessed is one you can
 * actually rely on; a schedule that hides that is one you find out about at a
 * formation.
 */
export const MatrixAuditSchema = z.object({
  /** Events the model returned, before anything was dropped. */
  rowsReturned: z.number().int().default(0),
  rowsKept: z.number().int().default(0),
  rowsSkipped: z.number().int().default(0),
  /** Rows belonging to other companies, classes, the Band, NCAA teams. */
  notMine: z.number().int().default(0),
  /** Forced to BLOCKED because the model was not confident enough. */
  ratcheted: z.number().int().default(0),
  /** The Matrix gave a start but no end, so the length was inferred. */
  endsEstimated: z.number().int().default(0),
  /** Spreadsheet cells before and after the deterministic trim. */
  cellsBefore: z.number().int().default(0),
  cellsAfter: z.number().int().default(0),
  /** Which model actually answered, which is not always the one we asked for. */
  model: z.string().default(""),
});

export const MatrixWeekSchema = z.object({
  id: z.string(),
  weekStart: LocalDate,
  events: z.array(MatrixEventSchema),
  source: z.object({ filename: z.string(), importedAt: z.string() }).optional(),
  // prefault, not default: every field already has one, so the empty object is
  // an *input* to be parsed rather than a finished value.
  audit: MatrixAuditSchema.prefault({}),
});

/* ------------------------------------------------------------ assignments */

export const AssignmentKindSchema = z.enum([
  "exam", "quiz", "paper", "problem_set", "project", "reading", "lab", "other",
]);

export const AssignmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  courseCode: z.string().optional(),
  dueDate: LocalDate,
  dueMin: Minute,
  kind: AssignmentKindSchema.default("other"),
  estimateMinutes: z.number().int().min(0).optional(),
  priority: z.number().int().min(1).max(5).optional(),   // 1 = most urgent
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  source: z.enum(["canvas", "manual"]).default("canvas"),
  uid: z.string().optional(),      // Canvas VEVENT UID, for dedupe across imports
  url: z.string().optional(),
  notes: z.string().optional(),
});

/* ------------------------------------------------------------------ plan */

export const GapQualitySchema = z.enum(["OPEN", "ROOM_BOUND"]);

export const GapSchema = z.object({
  id: z.string(),                  // "G-2026-09-14-03"
  date: LocalDate,
  startMin: Minute,
  endMin: Minute,
  minutes: z.number().int(),
  quality: GapQualitySchema,
  label: z.string().optional(),    // "CQ" when the gap comes from a USABLE block
});

export const WorkBlockSchema = z.object({
  id: z.string(),
  assignmentId: z.string(),
  gapId: z.string(),
  date: LocalDate,
  startMin: Minute,
  endMin: Minute,
  rationale: z.string().optional(),
  locked: z.boolean().default(false),   // user-placed blocks survive replanning
  /** Ticked off as the week is worked. Additive, so stored vaults still parse. */
  done: z.boolean().default(false),
});

export const UnplacedSchema = z.object({
  assignmentId: z.string(),
  reason: z.string(),
});

export const BriefingSchema = z.object({
  prose: z.string(),
  crunchPoints: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  sacrifice: z.string().optional(),     // what to drop if the week compresses
});

export const PlanSchema = z.object({
  id: z.string(),
  weekStart: LocalDate,
  generatedAt: z.string(),
  blocks: z.array(WorkBlockSchema),
  unplaced: z.array(UnplacedSchema).default([]),
  briefing: BriefingSchema,
});

/* ------------------------------------------- what we ask Gemini to return */

/**
 * The model-facing schemas deliberately differ from the internal ones.
 *
 * Gemini is asked for "HH:MM" and a weekday letter, never minutes-from-midnight
 * and never a computed date. Every arithmetic step we can do exactly in code is
 * taken away from the model, because a model that miscounts minutes produces a
 * plan that looks authoritative and is wrong.
 */
const ClockTime = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "expected HH:MM in 24-hour time");

export const GeminiMatrixEventSchema = z.object({
  title: z.string().describe("Short event name as a person would say it, e.g. BRC, Parade, CQ"),
  raw: z.string().describe("The verbatim cell text this came from, for auditing"),
  pax: z.string().describe("The PAX column verbatim: who this row is for"),
  appliesToMe: z.boolean().describe("Whether this row applies to THIS cadet, given their profile"),
  day: z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]),
  start: ClockTime,
  end: ClockTime,
  kind: MatrixEventKindSchema,
  availability: AvailabilitySchema,
  confidence: z.number().min(0).max(1),
  note: z.string().optional().describe("Why this availability was chosen"),
  location: z.string().describe("The Location column verbatim, or empty. e.g. Crozet, Bricks, Cormack Hall 115A"),
  uniform: z.string().describe("The Uniform column verbatim, or empty. e.g. Class Dyke, Gym Dyke, Blouse"),
  /** Set when the Matrix gave an instant rather than a range and we had to guess a length. */
  endEstimated: z.boolean().describe("True when the source gave only a start time and the end was inferred"),
});

export const GeminiMatrixResponseSchema = z.object({
  weekStartDate: LocalDate.describe("The Monday of the week this Matrix covers"),
  events: z.array(GeminiMatrixEventSchema),
});

export const GeminiMeetingSchema = z.object({
  days: z.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).min(1),
  start: ClockTime,
  end: ClockTime,
  location: z.string().optional(),
});

export const GeminiCourseSchema = z.object({
  code: z.string().describe('Course code, e.g. "MATH 171"'),
  title: z.string(),
  instructor: z.string().optional(),
  credits: z.number().optional(),
  meetings: z.array(GeminiMeetingSchema),
});

export const GeminiTermResponseSchema = z.object({
  name: z.string().describe('e.g. "Fall 2026"'),
  startDate: LocalDate,
  endDate: LocalDate,
  courses: z.array(GeminiCourseSchema),
});

/**
 * Plan: the model places assignments into *gap ids we gave it* and estimates
 * effort. It never computes a clock time - `offsetMin` is measured from the
 * start of the named gap, and our code turns that into real times.
 */
export const GeminiPlacementSchema = z.object({
  assignmentId: z.string(),
  gapId: z.string().describe("Must be one of the gap ids listed in the prompt"),
  offsetMin: z.number().int().min(0).describe("Minutes into that gap to begin"),
  minutes: z.number().int().min(1).describe("How long this block should run"),
  rationale: z.string().optional().describe("One short clause on why here"),
});

export const GeminiPlanResponseSchema = z.object({
  estimates: z.array(
    z.object({
      assignmentId: z.string(),
      estimateMinutes: z.number().int().min(0),
      priority: z.number().int().min(1).max(5).describe("1 is most urgent"),
      kind: AssignmentKindSchema,
    }),
  ),
  placements: z.array(GeminiPlacementSchema),
  unplaced: z.array(UnplacedSchema).default([]),
  briefing: BriefingSchema,
});

/* ------------------------------------------------------------------ vault */

/**
 * Who the cadet is.
 *
 * The Matrix lists the whole Corps' week, and most rows do not apply to any one
 * cadet: Band Practice is for Band, Guard Mount rotates by company, Rat
 * Challenge is for rats. Without this, every row would block time and the week
 * would vanish under other people's obligations.
 */
export const CadetSchema = z.object({
  class: z.enum(["4/C", "3/C", "2/C", "1/C"]).default("4/C"),
  company: z.string().default("Bravo"),
  athletics: z.enum(["none", "ncaa", "club"]).default("none"),
  team: z.string().optional(),
});

export const SettingsSchema = z.object({
  cadet: CadetSchema.default({ class: "4/C", company: "Bravo", athletics: "none" }),
  timezone: z.string().default("America/New_York"),
  dayStartMin: Minute.default(6 * 60),     // nothing scheduled before 0600
  dayEndMin: Minute.default(23 * 60 + 30), // Taps is 2330 on the real Matrix
  dailyCapacityMin: z.number().int().default(4 * 60),
  name: z.string().optional(),
});

export const VaultSchema = z.object({
  version: z.literal(1),
  settings: SettingsSchema,
  term: TermSchema.nullable().default(null),
  termHistory: z.array(TermSchema).default([]),
  matrixWeeks: z.array(MatrixWeekSchema).default([]),
  assignments: z.array(AssignmentSchema).default([]),
  plans: z.array(PlanSchema).default([]),
  /**
   * When Canvas was last imported.
   *
   * Term and MatrixWeek each carry their own `source.importedAt`; assignments
   * are a merged list with no single source, so the timestamp lives here. The
   * status panel needs all three to say what is loaded and how stale it is.
   */
  canvasImportedAt: z.string().nullable().default(null),
});

/* ------------------------------------------------------------------ types */

export type Meeting = z.infer<typeof MeetingSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type Term = z.infer<typeof TermSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type MatrixEventKind = z.infer<typeof MatrixEventKindSchema>;
export type MatrixEvent = z.infer<typeof MatrixEventSchema>;
export type MatrixWeek = z.infer<typeof MatrixWeekSchema>;
export type MatrixAudit = z.infer<typeof MatrixAuditSchema>;
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type Gap = z.infer<typeof GapSchema>;
export type GapQuality = z.infer<typeof GapQualitySchema>;
export type WorkBlock = z.infer<typeof WorkBlockSchema>;
export type Unplaced = z.infer<typeof UnplacedSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Cadet = z.infer<typeof CadetSchema>;
export type Vault = z.infer<typeof VaultSchema>;
export type GeminiPlanResponse = z.infer<typeof GeminiPlanResponseSchema>;
export type GeminiMatrixResponse = z.infer<typeof GeminiMatrixResponseSchema>;
export type GeminiTermResponse = z.infer<typeof GeminiTermResponseSchema>;
export type GeminiMatrixEvent = z.infer<typeof GeminiMatrixEventSchema>;
export type GeminiCourse = z.infer<typeof GeminiCourseSchema>;
