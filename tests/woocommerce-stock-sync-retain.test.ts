import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRetainJob } from '@/lib/connectors/woocommerce/sync/stock-sync-jobs'

type RetainResult = Parameters<typeof shouldRetainJob>[0]

function result(overrides: Partial<RetainResult> = {}): RetainResult {
  return { synced: 0, errors: [], ...overrides }
}

test('gate abort (sync disabled) retains the job for retry', () => {
  assert.equal(
    shouldRetainJob(result({ aborted: true }), { force: false, reason: 'IMS_CHANGE' }),
    true,
  )
})

test('gate abort retains regardless of reason or force', () => {
  for (const reason of ['IMS_CHANGE', 'WC_WEBHOOK', 'MANUAL', 'DAILY_RECONCILIATION'] as const) {
    assert.equal(shouldRetainJob(result({ aborted: true }), { force: false, reason }), true)
  }
})

test('any error retains, even on a mixed-success run', () => {
  assert.equal(
    shouldRetainJob(result({ synced: 3, errors: ['SKU lookup failed for ABC'] }), { force: false, reason: 'IMS_CHANGE' }),
    true,
  )
})

test('forced job that synced nothing retains', () => {
  assert.equal(shouldRetainJob(result(), { force: true, reason: 'MANUAL' }), true)
})

test('webhook job that synced nothing retains', () => {
  assert.equal(shouldRetainJob(result(), { force: false, reason: 'WC_WEBHOOK' }), true)
})

test('clean run completes: synced with no errors is not retained', () => {
  assert.equal(shouldRetainJob(result({ synced: 2 }), { force: false, reason: 'IMS_CHANGE' }), false)
})

test('benign no-op (nothing to push, not aborted) is not retained', () => {
  assert.equal(
    shouldRetainJob(result(), { force: false, reason: 'IMS_CHANGE' }),
    false,
  )
})
