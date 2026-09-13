/**
 * The advisory AI endpoint.
 *
 * Three jobs, all optional, none of which can change the shape of the week by
 * itself:
 *
 *   estimate   — how long is this assignment, with a confidence band
 *   decompose  — split a long task into schedulable pieces
 *   replan     — turn a sentence into a CONSTRAINT PATCH, never a schedule
 *
 * Without `GEMINI_API_KEY` the whole app still works; only these three go
 * dark, and the UI says so rather than failing mysteriously. That is the point
 * of keeping the solver deterministic: the intelligence is a garnish and the
 * correctness is structural.
 */

import { GoogleGenAI } from '@google/genai'
import {
  constraintPatchSchema,
  decompositionSchema,
  estimateSchema,
  sanitizePatch,
} from '@/lib/ai/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODEL = 'gemini-2.5-flash'

export async function POST(request: Request): Promise<Response> {
  const key = process.env['GEMINI_API_KEY']
  if (!key) {
    return json(
      {
        error:
          'No model key is configured, so estimates and replanning are off. Everything else — parsing, scheduling, printing — works without it.',
      },
      503,
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'Expected a JSON body.' }, 400)

  const { job } = body as { job?: unknown }
  const client = new GoogleGenAI({ apiKey: key })

  try {
    if (job === 'estimate') return await handleEstimate(client, body)
    if (job === 'decompose') return await handleDecompose(client, body)
    if (job === 'replan') return await handleReplan(client, body)
    return json({ error: 'Unknown job.' }, 400)
  } catch (error) {
    return json(
      { error: error instanceof Error ? `The model call failed: ${error.message}` : 'The model call failed.' },
      502,
    )
  }
}

async function handleEstimate(client: GoogleGenAI, body: object): Promise<Response> {
  const { title, course, description } = body as { title?: unknown; course?: unknown; description?: unknown }
  if (typeof title !== 'string' || title.trim() === '') return json({ error: 'Expected a title.' }, 400)

  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              'Estimate the focused working time a university student needs for this assignment.',
              'Answer only with JSON: {"minutes": integer, "confidence": "low"|"medium"|"high", "reasoning": string}.',
              'Be realistic rather than generous; a student who is told four hours and needs six loses trust in the whole plan.',
              '',
              `Title: ${title.slice(0, 300)}`,
              typeof course === 'string' && course ? `Course: ${course.slice(0, 80)}` : '',
              typeof description === 'string' && description ? `Details: ${description.slice(0, 1200)}` : '',
            ]
              .filter((line) => line !== '')
              .join('\n'),
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.2 },
  })

  const parsed = estimateSchema.safeParse(extractJson(response.text ?? ''))
  if (!parsed.success) return json({ error: 'The model returned an unusable estimate.' }, 502)
  return json({ estimate: parsed.data }, 200)
}

async function handleDecompose(client: GoogleGenAI, body: object): Promise<Response> {
  const { title, minutes, maxBlockMinutes } = body as {
    title?: unknown
    minutes?: unknown
    maxBlockMinutes?: unknown
  }
  if (typeof title !== 'string' || typeof minutes !== 'number') {
    return json({ error: 'Expected a title and a total in minutes.' }, 400)
  }
  const cap = typeof maxBlockMinutes === 'number' ? Math.min(300, Math.max(20, maxBlockMinutes)) : 90

  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              `Split this assignment into sequential work sessions that sum to about ${Math.round(minutes)} minutes.`,
              `No session may exceed ${cap} minutes. Each needs a short concrete label such as "outline", "draft body", "revise".`,
              'Answer only with JSON: {"chunks":[{"label": string, "minutes": integer}]}.',
              'The point is that a cadet week offers fragmented free time, so a task that cannot be split cannot be scheduled at all.',
              '',
              `Assignment: ${title.slice(0, 300)}`,
            ].join('\n'),
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.3 },
  })

  const parsed = decompositionSchema.safeParse(extractJson(response.text ?? ''))
  if (!parsed.success) return json({ error: 'The model returned an unusable decomposition.' }, 502)
  return json({ decomposition: parsed.data }, 200)
}

async function handleReplan(client: GoogleGenAI, body: object): Promise<Response> {
  const { message, tasks } = body as { message?: unknown; tasks?: unknown }
  if (typeof message !== 'string' || message.trim() === '') return json({ error: 'Expected a message.' }, 400)

  const taskList = Array.isArray(tasks)
    ? tasks
        .filter((t): t is { id: string; title: string } =>
          typeof t === 'object' && t !== null && typeof (t as { id?: unknown }).id === 'string',
        )
        .slice(0, 60)
    : []

  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              'A cadet describes what changed about their week. Turn it into a CONSTRAINT PATCH for a deterministic scheduler.',
              '',
              'You must NOT schedule anything. You may not emit a date or a timestamp of any kind.',
              'Blocked-out time is expressed as a day index and two clock times in minutes past midnight:',
              '  day: 0 = Monday through 6 = Sunday',
              '  start/end: integer minutes past midnight, 0-1440, end greater than start',
              '',
              'Answer only with JSON of this shape, omitting keys you do not need:',
              '{"boostTaskIds":[id],"blockOut":[{"day":int,"start":int,"end":int,"reason":string}],',
              ' "relax":["maxStudyMinutesPerDay"|"minLeadHours"|"bufferMinutes"|"minBlockMinutes"],',
              ' "reestimate":[{"taskId":id,"minutes":int}],"summary":string}',
              '',
              'Use only these task ids:',
              ...taskList.map((t) => `  ${t.id} — ${String((t as { title?: unknown }).title ?? '').slice(0, 90)}`),
              '',
              `The cadet says: ${message.slice(0, 900)}`,
            ].join('\n'),
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.2 },
  })

  const parsed = constraintPatchSchema.safeParse(extractJson(response.text ?? ''))
  if (!parsed.success) {
    return json({ error: 'The model returned something that was not a valid constraint patch.' }, 502)
  }

  const { patch, dropped } = sanitizePatch(
    parsed.data,
    taskList.map((t) => t.id),
  )
  return json({ patch, summary: parsed.data.summary, dropped }, 200)
}

/**
 * Pull JSON out of a model response.
 *
 * `responseMimeType: 'application/json'` usually makes this unnecessary, but a
 * model that wraps its answer in a fenced code block should not turn into a
 * user-visible failure.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()]
  const braced = /\{[\s\S]*\}/.exec(trimmed)
  if (braced) candidates.push(braced[0])

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return null
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
