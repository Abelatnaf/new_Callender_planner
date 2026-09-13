/**
 * Canvas ICS fetch proxy.
 *
 * This is the ONLY server-side work the planner needs, and it exists for one
 * reason: a browser cannot fetch a Canvas feed directly, because Instructure
 * does not send CORS headers. Nothing is stored here and nothing is logged.
 *
 * The URL comes from the client, so this endpoint is a server-side request
 * forgery primitive unless it is constrained. It is constrained by:
 *
 *   - https only
 *   - a host allowlist pattern (Instructure and the school's own domains)
 *   - rejection of credentials, non-standard ports, and IP-literal hosts
 *   - rejection of redirects, so an allowed host cannot bounce us inward
 *   - a response size cap and a timeout
 *
 * The feed URL is a credential. It is never written to a log line, never
 * echoed back in an error message, and never persisted server-side.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 4 MB. A semester of assignments is tens of kilobytes. */
const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 12_000

/**
 * Hosts allowed to be fetched.
 *
 * Canvas is almost always `*.instructure.com`, but institutions do host it on
 * their own domains, so `.edu` is permitted too. Everything else is refused:
 * an open fetch proxy is a liability regardless of who is using it.
 */
const ALLOWED_HOST = /(^|\.)instructure\.com$|(^|\.)canvas\.[a-z0-9-]+\.[a-z]{2,}$|(^|\.)[a-z0-9-]+\.edu$/i

/** Hostnames that resolve inward and must never be fetched. */
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\..*)$/i
const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|^\[?[0-9a-f:]+\]?$/i

interface Refusal {
  ok: false
  status: number
  error: string
}

export function validateFeedUrl(input: string): { ok: true; url: URL } | Refusal {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, status: 400, error: 'That is not a URL.' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'The feed URL must use https.' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, status: 400, error: 'The feed URL must not contain credentials.' }
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, status: 400, error: 'Only the standard https port is allowed.' }
  }
  if (IP_LITERAL.test(url.hostname)) {
    return { ok: false, status: 400, error: 'The feed URL must name a host, not an IP address.' }
  }
  if (BLOCKED_HOST.test(url.hostname)) {
    return { ok: false, status: 400, error: 'That host is not reachable from here.' }
  }
  if (!ALLOWED_HOST.test(url.hostname)) {
    return {
      ok: false,
      status: 400,
      error:
        'Only Canvas feeds are fetched here (an instructure.com or .edu host). For anything else, download the .ics and upload the file.',
    }
  }
  return { ok: true, url }
}

/** A response body must look like iCalendar before we hand it back. */
function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text.slice(0, 4096))
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400)
  }

  const raw = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : undefined
  if (typeof raw !== 'string' || raw.trim() === '') {
    return json({ error: 'Expected a feed URL.' }, 400)
  }

  const validated = validateFeedUrl(raw.trim())
  if (!validated.ok) {
    return json({ error: validated.error }, validated.status)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const upstream = await fetch(validated.url, {
      // A redirect could send us to an allowlisted host's open redirect and
      // out again, so redirects are refused rather than followed.
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'text/calendar, text/plain, */*' },
      cache: 'no-store',
    })

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: 'The feed redirected. Copy the final URL from Canvas and use that.' }, 400)
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ error: 'Canvas refused that feed URL. Generate a fresh one from Calendar → Calendar Feed.' }, 400)
    }
    if (!upstream.ok) {
      // Deliberately does not echo the URL back.
      return json({ error: `The calendar server answered with ${upstream.status}.` }, 502)
    }

    const length = Number(upstream.headers.get('content-length') ?? '0')
    if (length > MAX_BYTES) {
      return json({ error: 'That calendar is larger than 4 MB, which is not a class schedule.' }, 413)
    }

    const text = await readCapped(upstream, MAX_BYTES)
    if (text === null) {
      return json({ error: 'That calendar is larger than 4 MB, which is not a class schedule.' }, 413)
    }
    if (!looksLikeIcs(text)) {
      return json({ error: 'That URL did not return a calendar. Check you copied the Calendar Feed link.' }, 400)
    }

    return json({ ics: text }, 200)
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return json({ error: aborted ? 'The calendar server took too long to answer.' : 'The calendar server could not be reached.' }, 504)
  } finally {
    clearTimeout(timer)
  }
}

/** Read a body, refusing anything over the cap without buffering it all. */
async function readCapped(response: Response, cap: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return await response.text()

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > cap) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
