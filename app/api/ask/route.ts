/**
 * The ask panel: questions about this specific week, answered against real data.
 *
 * The week's schedule is rebuilt server-side and injected as ground truth, so
 * "can I take Saturday off?" is answered from the actual gap inventory rather
 * than from the model's impression of what a week looks like.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { callerKey, fail, handleError } from "@/lib/api";
import { MODEL_CHAINS, streamText } from "@/lib/gemini";
import { ASK_SYSTEM } from "@/lib/prompts";
import {
  AssignmentSchema, MatrixEventSchema, PlanSchema, SettingsSchema, TermSchema,
} from "@/lib/schemas";
import { buildWeekInventory, describeGapsForModel } from "@/lib/gaps";
import { WEEKDAY_LONG, formatDuration, hhmm, todayLocal, weekStart, weekdayOf } from "@/lib/time";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  question: z.string().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(["user", "model"]), text: z.string() })).default([]),
  weekStart: z.string(),
  term: TermSchema.nullable().default(null),
  events: z.array(MatrixEventSchema).default([]),
  assignments: z.array(AssignmentSchema).default([]),
  plan: PlanSchema.nullable().default(null),
  settings: SettingsSchema,
});

export async function POST(request: NextRequest) {
  try {
    const body = BodySchema.safeParse(await request.json());
    if (!body.success) {
      return fail(`Bad request: ${body.error.issues[0]?.message}`, 400, "bad_request");
    }
    const { question, history, term, events, assignments, plan, settings } = body.data;
    const monday = weekStart(body.data.weekStart);
    const inventory = buildWeekInventory(monday, term, events, settings);

    const ground = [
      `TODAY: ${todayLocal(settings.timezone)}`,
      `WEEK OF: ${monday}`,
      "",
      "FREE TIME:",
      describeGapsForModel(inventory),
      "",
      "OBLIGATIONS:",
      ...events
        .filter((e) => e.availability === "BLOCKED")
        .map((e) => `  ${WEEKDAY_LONG[weekdayOf(e.date)]} ${e.date} ${hhmm(e.startMin)}-${hhmm(e.endMin)} ${e.title}`),
      "",
      "BACKLOG:",
      ...assignments
        .filter((a) => a.status !== "done")
        .map((a) => `  ${a.courseCode ?? "—"} ${a.title} — due ${a.dueDate} ${hhmm(a.dueMin)}${a.estimateMinutes ? ` (~${formatDuration(a.estimateMinutes)})` : ""}`),
      "",
      plan
        ? "CURRENT PLAN:\n" +
          plan.blocks
            .map((b) => {
              const a = assignments.find((x) => x.id === b.assignmentId);
              return `  ${b.date} ${hhmm(b.startMin)}-${hhmm(b.endMin)} ${a?.title ?? b.assignmentId}`;
            })
            .join("\n")
        : "No plan has been generated for this week yet.",
    ].join("\n");

    const stream = await streamText({
      models: MODEL_CHAINS.plan,
      system: `${ASK_SYSTEM}\n\n--- THE CADET'S ACTUAL WEEK ---\n${ground}`,
      history: [...history, { role: "user" as const, text: question }],
      apiKey: callerKey(request),
    });

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) controller.enqueue(encoder.encode(chunk));
          } catch (err) {
            controller.enqueue(
              encoder.encode(`\n\n[the answer was cut off: ${err instanceof Error ? err.message : "unknown error"}]`),
            );
          } finally {
            controller.close();
          }
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleError(err);
  }
}
