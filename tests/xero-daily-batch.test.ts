import assert from 'node:assert/strict'
import test from 'node:test'

import {
  XERO_DAILY_BATCH_DEFAULT_LIMIT,
  XERO_DAILY_BATCH_MAX_LIMIT,
  buildDailyBatchReferenceId,
  resolveXeroDailyBatchLimit,
  takeDailyBatchWindow,
} from '@/lib/connectors/xero/daily-sync'

test('Xero daily batch limit defaults, floors, and clamps operator input', () => {
  assert.equal(resolveXeroDailyBatchLimit(''), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('0'), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('-1'), XERO_DAILY_BATCH_DEFAULT_LIMIT)
  assert.equal(resolveXeroDailyBatchLimit('10.9'), 10)
  assert.equal(resolveXeroDailyBatchLimit(String(XERO_DAILY_BATCH_MAX_LIMIT + 1)), XERO_DAILY_BATCH_MAX_LIMIT)
})

test('Xero daily batch window processes only the first limit rows and signals remaining work', () => {
  const firstRun = takeDailyBatchWindow(['a', 'b', 'c'], 2)

  assert.deepEqual(firstRun.rows, ['a', 'b'])
  assert.equal(firstRun.hasMore, true)

  const secondRun = takeDailyBatchWindow(['c'], 2)
  assert.deepEqual(secondRun.rows, ['c'])
  assert.equal(secondRun.hasMore, false)
})

test('Xero daily batch reference ids distinguish split batches for the same date', () => {
  assert.equal(
    buildDailyBatchReferenceId('A2', '2026-06-09', ['order-3', 'order-1', 'order-2']),
    buildDailyBatchReferenceId('A2', '2026-06-09', ['order-1', 'order-2', 'order-3']),
  )
  assert.notEqual(
    buildDailyBatchReferenceId('A1', '2026-06-09', ['order-1', 'order-2']),
    buildDailyBatchReferenceId('A1', '2026-06-09', ['order-3']),
  )
  assert.match(
    buildDailyBatchReferenceId('B', '2026-06-09', ['shipment-1']),
    /^B-2026-06-09-[a-f0-9]{8}$/,
  )
})
