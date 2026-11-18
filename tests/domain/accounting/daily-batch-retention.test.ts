import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SYNC_LOG_RETENTION_MONTHS,
  resolveRetentionMonths,
  computeRetentionCutoff,
} from '@/lib/domain/accounting/daily-batch-retention'

test('resolveRetentionMonths: parses a valid value', () => {
  assert.equal(resolveRetentionMonths('3'), 3)
  assert.equal(resolveRetentionMonths('0'), 0)
})

test('resolveRetentionMonths: falls back to default for missing/invalid/negative', () => {
  assert.equal(resolveRetentionMonths(null), DEFAULT_SYNC_LOG_RETENTION_MONTHS)
  assert.equal(resolveRetentionMonths(undefined), DEFAULT_SYNC_LOG_RETENTION_MONTHS)
  assert.equal(resolveRetentionMonths(''), DEFAULT_SYNC_LOG_RETENTION_MONTHS)
  assert.equal(resolveRetentionMonths('abc'), DEFAULT_SYNC_LOG_RETENTION_MONTHS)
  assert.equal(resolveRetentionMonths('-2'), DEFAULT_SYNC_LOG_RETENTION_MONTHS)
})

test('computeRetentionCutoff: returns null when retention is disabled (months <= 0)', () => {
  // Disabled retention → nothing is pruned → recreate must stay unbounded (no cutoff).
  assert.equal(computeRetentionCutoff(0, new Date('2026-06-22T00:00:00Z')), null)
  assert.equal(computeRetentionCutoff(-1, new Date('2026-06-22T00:00:00Z')), null)
})

/**
 * computeRetentionCutoff subtracts CALENDAR months in the host's local time zone (the same rule
 * lib/data-retention.ts's purge uses), so the instant it returns depends on the host TZ whenever the
 * window crosses a DST change. The expectations below therefore PIN the zone for the duration of the
 * test instead of inheriting the builder's or the CI runner's: an unpinned run failed by one hour on
 * any DST-observing host (o3d-o9d6k). Node re-reads process.env.TZ on assignment.
 */
function withTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

test('computeRetentionCutoff: subtracts the month window from now', () => {
  withTimeZone('UTC', () => {
    const cutoff = computeRetentionCutoff(6, new Date('2026-06-22T00:00:00Z'))
    assert.ok(cutoff)
    assert.equal(cutoff.toISOString(), '2025-12-22T00:00:00.000Z')
  })
})

test('computeRetentionCutoff: the window is calendar months in local time across a DST change (pinned zone)', () => {
  // 2026-06-22T12:00Z is 13:00 BST in London; six calendar months earlier is 13:00 GMT on 22 Dec,
  // i.e. 13:00Z — the same wall-clock time, one hour different from a fixed-length subtraction.
  withTimeZone('Europe/London', () => {
    const cutoff = computeRetentionCutoff(6, new Date('2026-06-22T12:00:00Z'))
    assert.ok(cutoff)
    assert.equal(cutoff.toISOString(), '2025-12-22T13:00:00.000Z')
  })
  withTimeZone('America/New_York', () => {
    // 08:00 EDT on 22 Jun -> 08:00 EST on 22 Dec = 13:00Z.
    const cutoff = computeRetentionCutoff(6, new Date('2026-06-22T12:00:00Z'))
    assert.ok(cutoff)
    assert.equal(cutoff.toISOString(), '2025-12-22T13:00:00.000Z')
  })
})

test('computeRetentionCutoff: a shipment journaled before the cutoff is windowed OUT', () => {
  // scjz.36: the double-post only happens for dates older than the retention window
  // (where the SYNCED log has been pruned). Verify the boundary the recreate filter uses.
  const now = new Date('2026-06-22T00:00:00Z')
  const cutoff = computeRetentionCutoff(6, now)!
  const prunedEra = new Date('2025-01-01T00:00:00Z') // > 6 months old → log pruned
  const recentEra = new Date('2026-05-01T00:00:00Z') // within window → log retained
  assert.ok(prunedEra < cutoff, 'old journaled date is excluded by { gte: cutoff }')
  assert.ok(recentEra >= cutoff, 'recent journaled date is included')
})
