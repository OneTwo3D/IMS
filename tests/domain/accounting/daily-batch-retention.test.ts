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

test('computeRetentionCutoff: subtracts the month window from now', () => {
  const cutoff = computeRetentionCutoff(6, new Date('2026-06-22T00:00:00Z'))
  assert.ok(cutoff)
  assert.equal(cutoff.toISOString(), '2025-12-22T00:00:00.000Z')
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
