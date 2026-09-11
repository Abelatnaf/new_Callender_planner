/**
 * Generate the week's plan.
 *
 * The division of labour is the whole reliability story:
 *   code   computes the free-gap inventory, exactly, from real intervals
 *   Gemini decides what to work on, for how long, and in which gap
 *   code   re-derives every placement and refuses the ones that do not fit
 *
 * Gemini never sees a blank calendar and is never asked to do clock arithmetic.
 * It chooses among slots we handed it by id. Everything it returns is then
 * treated as a proposal, not an answer.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { callerKey, fail, handleError } from "@/lib/api";
import { MODEL_CHAINS, generateStructured } from "@/lib/gemini";
import { PLAN_SYSTEM } from "@/lib/prompts";
import {
  AssignmentSchema, GeminiPlanResponseSchema, MatrixEventSchema,
  SettingsSchema, TermSchema, WorkBlockSchema,
} from "@/lib/schemas";
import { buildWeekInventory, describeGapsForModel } from "@/lib/gaps";
import { materializePlan } from "@/lib/validate";
import { applyEstimates } from "@/lib/convert";
import {
  WEEKDAY_LONG, formatDuration, hhmm, stamp, todayLocal, weekDates, weekStart, weekdayOf,
} from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 90;

const BodySchema = z.object({
  weekStart: z.string(),
  term: TermSchema.nullable().default(null),
  events: z.array(MatrixEventSchema).default([]),
  assignments: z.array(AssignmentSchema).default([]),
  settings: SettingsSchema,
  locked: z.array(WorkBlockSchema).default([]),
});

export async function POST(request: NextRequest) {
  try {
    const body = BodySchema.safeParse(await request.json());
    if (!body.success) {
      return fail(`Bad request: ${body.error.issues[0]?.message}`, 400, "bad_request");
    }
    const { term, events, assignments, settings, locked } = body.data;
    const monday = weekStart(body.data.weekStart);

    const inventory = buildWeekInventory(monday, term, events, settings);
    if (inventory.gaps.length === 0) {
      return fail(
        "There is no free time at all in this week. Check the Matrix import - " +
          "every hour is currently marked as an obligation.",
        422,
        "no_free_time",
      );
    }

    const today = todayLocal(settings.timezone);
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    // Only refuse past slots when planning the week we are actually inside.
    const nowStamp = weekDates(monday).includes(today)
      ? stamp(today, nowMinutes)
      : stamp(monday, 0);

    const open = assignments.filter((a) => a.status !== "done");
    if (open.length === 0) {
      return fail("There is nothing in the backlog to plan.", 422, "empty_backlog");
    }

    const prompt = [
      `WEEK: Monday ${monday} through Sunday ${weekDates(monday)[6]}.`,
      `TODAY: ${today}. Do not schedule anything before now.`,
      `DAILY CAPACITY: ${formatDuration(settings.dailyCapacityMin)} of focused work.`,
      "",
      "FREE TIME INVENTORY - you may only place work into these slot ids:",
      describeGapsForModel(inventory),
      "",
      "BACKLOG:",
      ...open.map((a) => {
        const est = a.estimateMinutes ? ` [cadet's own estimate: ${a.estimateMinutes}min]` : "";
        const status = a.status === "in_progress" ? " [already started]" : "";
        return `  ${a.id} | ${a.courseCode ?? "—"} | ${a.title} | ${a.kind} | due ${WEEKDAY_LONG[weekdayOf(a.dueDate)]} ${a.dueDate} ${hhmm(a.dueMin)}${est}${status}`;
      }),
      "",
      locked.length
        ? "ALREADY FIXED BY THE CADET (plan around these, do not move them):\n" +
          locked.map((b) => `  ${b.date} ${hhmm(b.startMin)}-${hhmm(b.endMin)} (${b.assignmentId})`).join("\n")
        : "",
      "",
      "OBLIGATIONS THIS WEEK, for context on how the days actually feel:",
      ...inventory.days.map((d) => {
        const dayEvents = events.filter((e) => e.date === d.date && e.availability === "BLOCKED");
        const list = dayEvents.length
          ? dayEvents.map((e) => `${e.title} ${hhmm(e.startMin)}-${hhmm(e.endMin)}`).join(", ")
          : "nothing scheduled";
        return `  ${WEEKDAY_LONG[weekdayOf(d.date)]} ${d.date}: ${list} — ${formatDuration(d.freeMinutes)} free`;
      }),
    ].filter(Boolean).join("\n");

    const { value: response, model, fellBack } = await generateStructured({
      models: MODEL_CHAINS.plan,
      system: PLAN_SYSTEM,
      parts: [{ text: prompt }],
      schema: GeminiPlanResponseSchema,
      temperature: 0.3,
      maxOutputTokens: 16_384,
      apiKey: callerKey(request),
    });

    const { plan, issues, estimates } = materializePlan({
      response,
      inventory,
      assignments: open,
      locked,
      nowStamp,
    });

    return Response.json({
      plan,
      issues: fellBack
        ? [...issues, `Planned by ${model} - the preferred model was out of quota for this key.`]
        : issues,
      assignments: applyEstimates(assignments, estimates),
      inventory: {
        weekStart: inventory.weekStart,
        freeMinutes: inventory.freeMinutes,
        gapCount: inventory.gaps.length,
      },
      model,
    });
  } catch (err) {
    return handleError(err);
  }
}
