/**
 * Grouping pairwise conflicts into same-moment clusters.
 *
 * `findConflicts` reports every pairwise overlap in the hard layer, which is
 * complete but not readable: when five "alternative" activities (club sports,
 * in-season athletics, out-season athletics, a rat challenge) all land in one
 * slot, that is C(5,2) = 10 pairwise lines for what a cadet reading the page
 * sees as ONE moment with five things competing for it. Clustering connects
 * any two conflicts that share an event into one group, so the UI and the
 * printed sheet can say "five things collide at 16:35" once, instead of
 * naming the same five things across ten separate sentences.
 *
 * This does not change what is reported — every pairwise conflict is still
 * available via `cluster.pairs` — it only changes how it is grouped for
 * something a human can actually read.
 */

import type { Conflict } from '../domain/types'
import type { Kind } from '../domain/kinds'
import type { Span } from '../domain/time'

export interface ConflictCluster {
  /** The full range covered by every pairwise overlap in this cluster. */
  span: Span
  /** Blocking if any pair inside the cluster is blocking. */
  severity: 'blocking' | 'overlap'
  /** Every distinct obligation involved, sorted by title. */
  items: Array<{ id: string; title: string; kind: Kind }>
  /** The underlying pairwise conflicts, for anyone who wants the detail. */
  pairs: Conflict[]
}

export function clusterConflicts(conflicts: readonly Conflict[]): ConflictCluster[] {
  if (conflicts.length === 0) return []

  // Union-find over event ids: two conflicts that share an event belong to
  // the same cluster, transitively.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as string
    }
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const c of conflicts) {
    if (!parent.has(c.a.id)) parent.set(c.a.id, c.a.id)
    if (!parent.has(c.b.id)) parent.set(c.b.id, c.b.id)
    union(c.a.id, c.b.id)
  }

  const groups = new Map<string, Conflict[]>()
  for (const c of conflicts) {
    const root = find(c.a.id)
    const list = groups.get(root) ?? []
    list.push(c)
    groups.set(root, list)
  }

  const clusters: ConflictCluster[] = []
  for (const pairs of groups.values()) {
    const items = new Map<string, { id: string; title: string; kind: Kind }>()
    let start = Infinity
    let end = -Infinity
    let blocking = false
    for (const p of pairs) {
      items.set(p.a.id, p.a)
      items.set(p.b.id, p.b)
      start = Math.min(start, p.span.start)
      end = Math.max(end, p.span.end)
      if (p.severity === 'blocking') blocking = true
    }
    clusters.push({
      span: { start, end },
      severity: blocking ? 'blocking' : 'overlap',
      items: [...items.values()].sort((a, b) => a.title.localeCompare(b.title)),
      pairs: [...pairs].sort((a, b) => a.span.start - b.span.start),
    })
  }

  return clusters.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end)
}

/** The item titles as one prose fragment: "A, B and C". */
export function describeCluster(cluster: ConflictCluster): string {
  const names = cluster.items.map((i) => i.title)
  if (names.length === 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  const head = names.slice(0, -1).join(', ')
  return `${head} and ${names[names.length - 1]}`
}
