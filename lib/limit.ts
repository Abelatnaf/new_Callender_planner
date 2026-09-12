/** Bounded-concurrency fan-out, for work that must not stampede a rate limit. */

/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * Seven simultaneous requests would be the fastest thing to write and the
 * quickest way to trip a free key's per-minute limit, which is the failure
 * this whole path already exists to avoid. Never rejects: a failed task is
 * reported, so six good days survive a bad one.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
