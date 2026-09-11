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
  confirmedByUser: z.boolean().default(false),
});

export const MatrixWeekSchema = z.object({
  id: z.string(),
  weekStart: LocalDate,
  events: z.array(MatrixEventSchema),
  source: z.object({ filename: z.string(), importedAt: z.string() }).optional(),
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

/** Matrix parse: the model returns events without ids; we mint those. */
export const GeminiMatrixEventSchema = z.object({
  title: z.string(),
  raw: z.string(),
  date: LocalDate,
  startMin: Minute,
  endMin: Minute,
  kind: MatrixEventKindSchema,
  availability: AvailabilitySchema,
  confidence: z.number().min(0).max(1),
  note: z.string().optional(),
});
export const GeminiMatrixResponseSchema = z.object({
  weekStart: LocalDate,
  events: z.array(GeminiMatrixEventSchema),
});

export const GeminiTermResponseSchema = z.object({
  name: z.string(),
  startDate: LocalDate,
  endDate: LocalDate,
  courses: z.array(CourseSchema.omit({ id: true })),
});

/**
 * Plan: the model places assignments into *gap ids we gave it* and estimates
 * effort. It never computes a clock time - `offsetMin` is measured from the
 * start of the named gap, and our code turns that into real times.
 */
export const GeminiPlacementSchema = z.object({
  assignmentId: z.string(),
  gapId: z.string(),
  offsetMin: z.number().int().min(0),
  minutes: z.number().int().min(1),
  rationale: z.string().optional(),
});
export const GeminiPlanResponseSchema = z.object({
  estimates: z.array(
    z.object({
      assignmentId: z.string(),
      estimateMinutes: z.number().int().min(0),
      priority: z.number().int().min(1).max(5),
      kind: AssignmentKindSchema,
    }),
  ),
  placements: z.array(GeminiPlacementSchema),
  unplaced: z.array(UnplacedSchema).default([]),
  briefing: BriefingSchema,
});

/* ------------------------------------------------------------------ vault */

export const SettingsSchema = z.object({
  timezone: z.string().default("America/New_York"),
  dayStartMin: Minute.default(6 * 60),     // nothing scheduled before 0600
  dayEndMin: Minute.default(23 * 60),      // nothing scheduled after 2300
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
});

/* ------------------------------------------------------------------ types */

export type Meeting = z.infer<typeof MeetingSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type Term = z.infer<typeof TermSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type MatrixEventKind = z.infer<typeof MatrixEventKindSchema>;
export type MatrixEvent = z.infer<typeof MatrixEventSchema>;
export type MatrixWeek = z.infer<typeof MatrixWeekSchema>;
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type Gap = z.infer<typeof GapSchema>;
export type GapQuality = z.infer<typeof GapQualitySchema>;
export type WorkBlock = z.infer<typeof WorkBlockSchema>;
export type Unplaced = z.infer<typeof UnplacedSchema>;
export type Briefing = z.infer<typeof BriefingSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Vault = z.infer<typeof VaultSchema>;
export type GeminiPlanResponse = z.infer<typeof GeminiPlanResponseSchema>;
export type GeminiMatrixResponse = z.infer<typeof GeminiMatrixResponseSchema>;
export type GeminiTermResponse = z.infer<typeof GeminiTermResponseSchema>;
