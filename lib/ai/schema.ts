/**
 * What the model is allowed to say.
 *
 * The hard rule, from the build plan and kept verbatim because it is the best
 * engineering decision in that document:
 *
 *   THE LLM NEVER EMITS A DATETIME THAT REACHES THE PLAN.
 *
 * Estimates, labels, decompositions, constraint patches, prose — yes.
 * Calendar arithmetic — no. Three reasons, in order of how much they hurt:
 *
 *   1. Non-determinism kills debugging. When a plan is wrong and you cannot
 *      reproduce it, you cannot fix it.
 *   2. Models are bad at interval arithmetic. They will double-book a Tuesday
 *      and be confident about it.
 *   3. A solver run is under a millisecond. A model-authored week is fifteen
 *      seconds and a variable number of cents, every regeneration.
 *
 * The original plan's own example patch violated its own rule: it emitted
 * `{"start":"2026-09-17T16:00","end":"2026-09-17T22:00"}` — ISO datetimes,
 * straight from the model into the scheduler. The schema below closes that
 * hole. A blocked-out window is a DAY INDEX plus two CLOCK TIMES, each bounded
 * and integer-valued, so there is no date for the model to get wrong and
 * nothing to parse. The solver resolves them against the week it is already
 * planning.
 */

import { z } from 'zod'

/** Minutes past local midnight, 0–1440. Not a datetime. */
const clockMinute = z.number().int().min(0).max(1440)

/** 0 = Monday … 6 = Sunday, and only ever within the week being planned. */
const dayIndex = z.number().int().min(0).max(6)

export const estimateSchema = z.object({
  minutes: z.number().int().min(5).max(1200),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().max(400),
})
export type AiEstimate = z.infer<typeof estimateSchema>

export const decompositionSchema = z.object({
  chunks: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        minutes: z.number().int().min(10).max(300),
      }),
    )
    .min(1)
    .max(8),
})
export type AiDecomposition = z.infer<typeof decompositionSchema>

export const constraintPatchSchema = z.object({
  boostTaskIds: z.array(z.string().max(120)).max(20).optional(),
  blockOut: z
    .array(
      z.object({
        day: dayIndex,
        start: clockMinute,
        end: clockMinute,
        reason: z.string().max(120),
      }),
    )
    .max(21)
    .optional(),
  relax: z
    .array(z.enum(['maxStudyMinutesPerDay', 'minLeadHours', 'bufferMinutes', 'minBlockMinutes']))
    .max(4)
    .optional(),
  reestimate: z
    .array(z.object({ taskId: z.string().max(120), minutes: z.number().int().min(5).max(1200) }))
    .max(20)
    .optional(),
  /** One sentence back to the cadet describing what it changed. */
  summary: z.string().max(300),
})
export type AiConstraintPatch = z.infer<typeof constraintPatchSchema>

/**
 * Final gate before a patch reaches the solver.
 *
 * Schema validation proves the SHAPE is right. This proves the CONTENT is
 * sane: windows ordered and non-empty, task ids that actually exist, nothing
 * addressing a task the cadet never had. A model that hallucinates a task id
 * must not be able to silently boost nothing.
 */
export function sanitizePatch(
  patch: AiConstraintPatch,
  knownTaskIds: readonly string[],
): { patch: Omit<AiConstraintPatch, 'summary'>; dropped: string[] } {
  const known = new Set(knownTaskIds)
  const dropped: string[] = []

  const boostTaskIds = (patch.boostTaskIds ?? []).filter((id) => {
    if (known.has(id)) return true
    dropped.push(`Ignored a boost for "${id}", which is not one of your tasks.`)
    return false
  })

  const blockOut = (patch.blockOut ?? []).filter((window) => {
    if (window.end > window.start) return true
    dropped.push(`Ignored a blocked-out window on day ${window.day} that ended before it started.`)
    return false
  })

  const reestimate = (patch.reestimate ?? []).filter((entry) => {
    if (known.has(entry.taskId)) return true
    dropped.push(`Ignored an estimate for "${entry.taskId}", which is not one of your tasks.`)
    return false
  })

  return {
    patch: {
      ...(boostTaskIds.length > 0 ? { boostTaskIds } : {}),
      ...(blockOut.length > 0 ? { blockOut } : {}),
      ...(patch.relax && patch.relax.length > 0 ? { relax: patch.relax } : {}),
      ...(reestimate.length > 0 ? { reestimate } : {}),
    },
    dropped,
  }
}
