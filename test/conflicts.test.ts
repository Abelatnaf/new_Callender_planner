import { describe, expect, it } from 'vitest'
import { clusterConflicts, describeCluster } from '../lib/engine/conflicts'
import type { Conflict } from '../lib/domain/types'

function pair(
  aId: string,
  aTitle: string,
  bId: string,
  bTitle: string,
  start: number,
  end: number,
  severity: 'blocking' | 'overlap' = 'blocking',
): Conflict {
  return {
    a: { id: aId, title: aTitle, kind: 'class' },
    b: { id: bId, title: bTitle, kind: 'class' },
    span: { start, end },
    minutes: end - start,
    severity,
    note: '',
  }
}

describe('clusterConflicts', () => {
  it('merges three mutually overlapping events into one cluster', () => {
    const conflicts = [
      pair('a', 'Corps PT', 'b', 'Club Sports', 100, 200),
      pair('a', 'Corps PT', 'c', 'In-Season Athletics', 100, 200),
      pair('b', 'Club Sports', 'c', 'In-Season Athletics', 100, 200),
    ]
    const clusters = clusterConflicts(conflicts)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.items.map((i) => i.title)).toEqual(['Club Sports', 'Corps PT', 'In-Season Athletics'])
    expect(clusters[0]?.pairs).toHaveLength(3)
  })

  it('keeps unrelated collisions in separate clusters', () => {
    const conflicts = [
      pair('a', 'Formation', 'b', 'Inspection', 100, 130),
      pair('c', 'Lab', 'd', 'MAC Training', 500, 560),
    ]
    const clusters = clusterConflicts(conflicts)
    expect(clusters).toHaveLength(2)
  })

  it('marks a cluster blocking if any pair inside it is blocking', () => {
    const conflicts = [
      pair('a', 'X', 'b', 'Y', 100, 130, 'overlap'),
      pair('a', 'X', 'c', 'Z', 100, 130, 'blocking'),
    ]
    const clusters = clusterConflicts(conflicts)
    expect(clusters[0]?.severity).toBe('blocking')
  })

  it('does not mark a cluster blocking when every pair is overlap-only', () => {
    const conflicts = [pair('a', 'X', 'b', 'Y', 100, 130, 'overlap')]
    const clusters = clusterConflicts(conflicts)
    expect(clusters[0]?.severity).toBe('overlap')
  })

  it('spans the full range covered by the cluster', () => {
    const conflicts = [
      pair('a', 'X', 'b', 'Y', 100, 200),
      pair('b', 'Y', 'c', 'Z', 150, 260),
    ]
    const clusters = clusterConflicts(conflicts)
    expect(clusters[0]?.span).toEqual({ start: 100, end: 260 })
  })

  it('sorts clusters by start time', () => {
    const conflicts = [
      pair('a', 'Late', 'b', 'Late2', 500, 560),
      pair('c', 'Early', 'd', 'Early2', 100, 130),
    ]
    const clusters = clusterConflicts(conflicts)
    expect(clusters[0]?.items.some((i) => i.title.startsWith('Early'))).toBe(true)
  })

  it('returns nothing for no conflicts', () => {
    expect(clusterConflicts([])).toEqual([])
  })
})

describe('describeCluster', () => {
  it('joins two names with "and"', () => {
    const [cluster] = clusterConflicts([pair('a', 'Corps PT', 'b', 'Club Sports', 100, 200)])
    expect(cluster && describeCluster(cluster)).toBe('Club Sports and Corps PT')
  })

  it('joins three or more names with a comma list and a final "and"', () => {
    const conflicts = [
      pair('a', 'Corps PT', 'b', 'Club Sports', 100, 200),
      pair('a', 'Corps PT', 'c', 'In-Season Athletics', 100, 200),
    ]
    const [cluster] = clusterConflicts(conflicts)
    expect(cluster && describeCluster(cluster)).toBe('Club Sports, Corps PT and In-Season Athletics')
  })
})
