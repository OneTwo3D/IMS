import assert from 'node:assert/strict'
import test from 'node:test'

import { parseDriftSnapshot } from '@/lib/domain/accounting/tax-rate-drift-status'

const AT = '2026-06-25T03:00:00.000Z'

test('parses a drift snapshot into a map keyed by taxRateId', () => {
  const json = JSON.stringify([
    { taxRateId: 't1', name: 'UK Std', status: 'mismatch', lines: ['VAT 20% → 17.5%'] },
    { taxRateId: 't2', name: 'Canada', status: 'missing-on-xero', lines: [] },
  ])
  const result = parseDriftSnapshot(json, AT)
  assert.deepEqual(Object.keys(result).sort(), ['t1', 't2'])
  assert.equal(result.t1.status, 'mismatch')
  assert.deepEqual(result.t1.lines, ['VAT 20% → 17.5%'])
  assert.equal(result.t2.status, 'missing-on-xero')
  assert.equal(result.t1.detectedAt, AT)
})

test('empty/absent/invalid JSON yields an empty map', () => {
  assert.deepEqual(parseDriftSnapshot(null, AT), {})
  assert.deepEqual(parseDriftSnapshot(undefined, AT), {})
  assert.deepEqual(parseDriftSnapshot('', AT), {})
  assert.deepEqual(parseDriftSnapshot('not json', AT), {})
  assert.deepEqual(parseDriftSnapshot('{"not":"an array"}', AT), {})
})

test('ignores entries without a usable taxRateId or status', () => {
  const json = JSON.stringify([
    { name: 'no id', status: 'mismatch', lines: [] },
    { taxRateId: 't1', status: 'equal', lines: [] },
    { taxRateId: 't2', status: 'bogus' },
  ])
  assert.deepEqual(parseDriftSnapshot(json, AT), {})
})

test('defends against malformed name/lines fields', () => {
  const json = JSON.stringify([
    { taxRateId: 't1', name: 42, status: 'mismatch', lines: ['ok', 7, null] },
  ])
  const result = parseDriftSnapshot(json, AT)
  assert.equal(result.t1.name, '')
  assert.deepEqual(result.t1.lines, ['ok'])
})

test('keeps the first entry on a duplicate taxRateId', () => {
  const json = JSON.stringify([
    { taxRateId: 't1', name: 'first', status: 'mismatch', lines: [] },
    { taxRateId: 't1', name: 'second', status: 'missing-on-xero', lines: [] },
  ])
  const result = parseDriftSnapshot(json, AT)
  assert.equal(result.t1.name, 'first')
  assert.equal(result.t1.status, 'mismatch')
})
