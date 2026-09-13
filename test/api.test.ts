import { describe, expect, it } from 'vitest'
import { validateFeedUrl } from '@/app/api/canvas/route'
import { constraintPatchSchema, sanitizePatch } from '@/lib/ai/schema'

/**
 * The fetch proxy takes a URL from the client, which makes it a server-side
 * request forgery primitive unless it is constrained. These are the
 * constraints, asserted rather than assumed.
 */
describe('Canvas feed URL validation', () => {
  it('accepts a real Instructure feed', () => {
    const result = validateFeedUrl('https://vmi.instructure.com/feeds/calendars/user_abc123.ics')
    expect(result.ok).toBe(true)
  })

  it('accepts a school-hosted Canvas on a .edu host', () => {
    expect(validateFeedUrl('https://canvas.vmi.edu/feeds/calendars/user_x.ics').ok).toBe(true)
  })

  it('refuses plain http', () => {
    const result = validateFeedUrl('http://vmi.instructure.com/feeds/x.ics')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/https/)
  })

  it('refuses localhost', () => {
    expect(validateFeedUrl('https://localhost/feeds/x.ics').ok).toBe(false)
  })

  it('refuses an IP literal, which is how the metadata service is reached', () => {
    expect(validateFeedUrl('https://169.254.169.254/latest/meta-data/').ok).toBe(false)
    expect(validateFeedUrl('https://127.0.0.1/x').ok).toBe(false)
  })

  it('refuses internal hostnames', () => {
    expect(validateFeedUrl('https://metadata.google.internal/x').ok).toBe(false)
    expect(validateFeedUrl('https://db.internal/x').ok).toBe(false)
    expect(validateFeedUrl('https://host.local/x').ok).toBe(false)
  })

  it('refuses embedded credentials', () => {
    const result = validateFeedUrl('https://user:pass@vmi.instructure.com/x.ics')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/credential/)
  })

  it('refuses a non-standard port', () => {
    expect(validateFeedUrl('https://vmi.instructure.com:8443/x.ics').ok).toBe(false)
  })

  it('refuses an arbitrary host, so this is not an open proxy', () => {
    expect(validateFeedUrl('https://example.com/anything').ok).toBe(false)
    expect(validateFeedUrl('https://evil.test/x').ok).toBe(false)
  })

  it('is not fooled by a lookalike host', () => {
    // `instructure.com.evil.test` must not match an `instructure.com` suffix.
    expect(validateFeedUrl('https://instructure.com.evil.test/x').ok).toBe(false)
  })

  it('refuses nonsense', () => {
    expect(validateFeedUrl('not a url').ok).toBe(false)
    expect(validateFeedUrl('').ok).toBe(false)
  })
})

/**
 * The rule the whole AI design turns on: the model may constrain the solver,
 * never schedule. The schema is what enforces it — a blocked-out window is a
 * day index plus two clock times, so there is no datetime for the model to
 * emit and nothing to parse.
 */
describe('the constraint patch schema', () => {
  it('accepts a well-formed patch', () => {
    const result = constraintPatchSchema.safeParse({
      boostTaskIds: ['task:abc'],
      blockOut: [{ day: 3, start: 960, end: 1320, reason: 'guard' }],
      relax: ['maxStudyMinutesPerDay'],
      summary: 'Boosted the response and blocked out Thursday evening.',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an ISO datetime, which the original plan let through', () => {
    const result = constraintPatchSchema.safeParse({
      blockOut: [{ start: '2026-09-17T16:00', end: '2026-09-17T22:00', reason: 'guard' }],
      summary: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a day outside the week', () => {
    expect(
      constraintPatchSchema.safeParse({
        blockOut: [{ day: 9, start: 0, end: 60, reason: 'x' }],
        summary: 'x',
      }).success,
    ).toBe(false)
  })

  it('rejects a clock time beyond a day', () => {
    expect(
      constraintPatchSchema.safeParse({
        blockOut: [{ day: 0, start: 0, end: 5000, reason: 'x' }],
        summary: 'x',
      }).success,
    ).toBe(false)
  })

  it('rejects a relaxation it was not offered', () => {
    expect(constraintPatchSchema.safeParse({ relax: ['ignoreSleep'], summary: 'x' }).success).toBe(false)
  })
})

describe('patch sanitation', () => {
  it('drops a boost for a task that does not exist', () => {
    const { patch, dropped } = sanitizePatch(
      { boostTaskIds: ['real', 'hallucinated'], summary: 'x' },
      ['real'],
    )
    expect(patch.boostTaskIds).toEqual(['real'])
    expect(dropped[0]).toContain('hallucinated')
  })

  it('drops a window that ends before it starts', () => {
    const { patch, dropped } = sanitizePatch(
      { blockOut: [{ day: 2, start: 600, end: 300, reason: 'x' }], summary: 'x' },
      [],
    )
    expect(patch.blockOut).toBeUndefined()
    expect(dropped).toHaveLength(1)
  })

  it('drops an estimate for an unknown task', () => {
    const { patch } = sanitizePatch(
      { reestimate: [{ taskId: 'ghost', minutes: 60 }], summary: 'x' },
      ['real'],
    )
    expect(patch.reestimate).toBeUndefined()
  })

  it('never returns a summary to the solver', () => {
    const { patch } = sanitizePatch({ summary: 'prose the solver must not see' }, [])
    expect('summary' in patch).toBe(false)
  })
})
