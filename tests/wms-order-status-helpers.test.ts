import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDeepLink,
  mergedParts,
  pickOrderRow,
  readTracking,
} from '../lib/connectors/mintsoft/api/orders.ts'

test('mergedParts splits a merged survivor and ignores plain/empty numbers', () => {
  assert.deepEqual(mergedParts('5001+5002'), ['5001', '5002'])
  assert.deepEqual(mergedParts('5001 + 5002'), ['5001', '5002']) // trims
  assert.deepEqual(mergedParts('5001'), [])
  assert.deepEqual(mergedParts(null), [])
  assert.deepEqual(mergedParts('5001+'), ['5001']) // drops empty segment
})

test('pickOrderRow prefers the exact OrderNumber match', () => {
  const rows = [
    { ID: 1, OrderNumber: '9000', ClientId: 5 },
    { ID: 2, OrderNumber: '5001', ClientId: 5 },
  ]
  assert.equal(pickOrderRow(rows, '5001', 5)?.ID, 2)
})

test('pickOrderRow returns the primary (lowest Part) for a split order', () => {
  const rows = [
    { ID: 11, OrderNumber: '5001', Part: 2, ClientId: 5 },
    { ID: 10, OrderNumber: '5001', Part: 1, ClientId: 5 },
    { ID: 12, OrderNumber: '5001', Part: 3, ClientId: 5 },
  ]
  assert.equal(pickOrderRow(rows, '5001', 5)?.ID, 10)
})

test('pickOrderRow falls back to a single merged survivor, but not when ambiguous', () => {
  const single = [{ ID: 20, OrderNumber: '5001+5002', ClientId: 5 }]
  assert.equal(pickOrderRow(single, '5001', 5)?.ID, 20)

  const ambiguous = [
    { ID: 21, OrderNumber: '5001+5002', ClientId: 5 },
    { ID: 22, OrderNumber: '5001+5003', ClientId: 5 },
  ]
  assert.equal(pickOrderRow(ambiguous, '5001', 5), null)
})

test('pickOrderRow sorts split parts even when Part is a string or missing', () => {
  const rows = [
    { ID: 31, OrderNumber: '5001', Part: '2', ClientId: 5 },
    { ID: 30, OrderNumber: '5001', ClientId: 5 }, // missing Part → treated as 1
  ]
  assert.equal(pickOrderRow(rows, '5001', 5)?.ID, 30)
})

test('pickOrderRow returns null when nothing matches', () => {
  assert.equal(pickOrderRow([{ ID: 1, OrderNumber: '9999', ClientId: 5 }], '5001', 5), null)
  assert.equal(pickOrderRow([], '5001', 5), null)
})

test('pickOrderRow never selects a foreign or unverifiable client row', () => {
  const rows = [
    { ID: 1, OrderNumber: '5001', ClientId: 99 },
    { ID: 2, OrderNumber: '5001' },
    { ID: 3, OrderNumber: '5001', ClientId: 5 },
  ]
  assert.equal(pickOrderRow(rows, '5001', 5)?.ID, 3)
  assert.equal(pickOrderRow(rows.slice(0, 2), '5001', 5), null)
})

test('buildDeepLink substitutes and encodes {id}; null when the template lacks it', () => {
  assert.equal(buildDeepLink('https://wms.example/Order/{id}', '42'), 'https://wms.example/Order/42')
  assert.equal(buildDeepLink('https://wms.example/Order/{id}', 'a b'), 'https://wms.example/Order/a%20b')
  assert.equal(buildDeepLink('https://wms.example/Order/none', '42'), null)
  // empty template falls back to the proven default, which carries {id}
  assert.match(buildDeepLink('', '42') ?? '', /42$/)
})

test('readTracking maps tracking fields and is empty when absent', () => {
  assert.deepEqual(
    readTracking({ TrackingNumber: '1Z999', CourierServiceName: 'Royal Mail', DespatchDate: '2026-06-25' }),
    [{ trackingNumber: '1Z999', carrier: 'Royal Mail', despatchedAt: '2026-06-25' }],
  )
  assert.deepEqual(readTracking({}), [])
  // partial row (carrier only) still yields one entry
  assert.deepEqual(readTracking({ CourierServiceName: 'DPD' }), [{ trackingNumber: null, carrier: 'DPD', despatchedAt: null }])
})
