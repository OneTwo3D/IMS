import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPushPayload,
  parseDefaultCourierId,
  planMintsoftItemAmendments,
  resolveMappedCourierId,
} from '../lib/connectors/mintsoft/api/order-push.ts'
import type { WmsOrderPushInput, WmsOrderPushLine } from '../lib/connectors/wms/types.ts'

const wmsLine = (sku: string, quantity: number): WmsOrderPushLine => ({
  sku, quantity, unitPriceExVat: 10, unitPriceVat: 2, description: sku,
})

const SAMPLE_INPUT: WmsOrderPushInput = {
  orderNumber: 'SO-1001',
  externalReference: 'order-id-abc',
  externalWarehouseId: '301',
  currency: 'GBP',
  shippingAddress: {
    firstName: 'Jane', lastName: 'Doe', company: 'Acme',
    address1: '1 High St', address2: 'Flat 2', town: 'Leeds', county: 'West Yorkshire', postCode: 'LS1 1AA', country: 'GB',
  },
  email: 'jane@example.com',
  phone: null,
  vatNumber: null,
  comments: null,
  courierService: 'Royal Mail Tracked 24',
  totalVat: 4.001,
  shippingExVat: 3.5,
  shippingVat: 0,
  discountExVat: 0,
  discountVat: 0,
  lines: [
    { sku: 'SKU1', quantity: 2, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' },
  ],
}

test('resolveMappedCourierId honours a valid map and rejects non-integer ids', () => {
  const map = JSON.stringify({ 'Royal Mail Tracked 24': 12, 'DPD Next Day': '34' })
  assert.equal(resolveMappedCourierId('Royal Mail Tracked 24', map), 12)
  assert.equal(resolveMappedCourierId('DPD Next Day', map), 34) // numeric string ok
  assert.equal(resolveMappedCourierId('Unknown', map), null) // unmapped
  assert.equal(resolveMappedCourierId(null, map), null)
})

test('resolveMappedCourierId is strict: trailing junk / decimals / non-positive rejected', () => {
  assert.equal(resolveMappedCourierId('A', JSON.stringify({ A: '123abc' })), null)
  assert.equal(resolveMappedCourierId('A', JSON.stringify({ A: '12.9' })), null)
  assert.equal(resolveMappedCourierId('A', JSON.stringify({ A: 0 })), null)
  assert.equal(resolveMappedCourierId('A', JSON.stringify({ A: -5 })), null)
  assert.equal(resolveMappedCourierId('A', 'not json'), null)
  assert.equal(resolveMappedCourierId('A', ''), null)
})

test('parseDefaultCourierId accepts plain positive integers and rejects ambiguous forms', () => {
  // Plain digits only — so the saved value and the runtime consumer never diverge.
  assert.equal(parseDefaultCourierId('12'), 12)
  assert.equal(parseDefaultCourierId('  12  '), 12) // trimmed
  assert.equal(parseDefaultCourierId('0'), null) // not positive
  assert.equal(parseDefaultCourierId('-5'), null)
  assert.equal(parseDefaultCourierId('12.0'), null) // no decimals
  assert.equal(parseDefaultCourierId('1e3'), null) // would be 1000 via Number but 1 via parseInt — rejected
  assert.equal(parseDefaultCourierId('0x10'), null) // would be 16 via Number but 0 via parseInt — rejected
  assert.equal(parseDefaultCourierId('12abc'), null)
  assert.equal(parseDefaultCourierId(''), null)
  assert.equal(parseDefaultCourierId(null), null)
  assert.equal(parseDefaultCourierId(undefined), null)
})

test('buildPushPayload maps the core order + address fields', () => {
  const p = buildPushPayload(SAMPLE_INPUT, { kind: 'name' })
  assert.equal(p.OrderNumber, 'SO-1001')
  assert.equal(p.ExternalOrderReference, 'order-id-abc')
  assert.equal(p.WarehouseId, 301) // parsed to int
  assert.equal(p.Town, 'Leeds')
  assert.equal(p.PostCode, 'LS1 1AA')
  assert.equal(p.TotalVat, 4) // rounded to 2dp
})

test('buildPushPayload includes VATNumber only when the order carries one (G6b)', () => {
  assert.equal(buildPushPayload(SAMPLE_INPUT, { kind: 'name' }).VATNumber, undefined)
  const withVat = buildPushPayload({ ...SAMPLE_INPUT, vatNumber: 'GB123456789' }, { kind: 'name' })
  assert.equal(withVat.VATNumber, 'GB123456789')
})

test('buildPushPayload includes OrderItems on create, omits them on update', () => {
  const create = buildPushPayload(SAMPLE_INPUT, { kind: 'name' }, true)
  assert.deepEqual(create.OrderItems, [
    { SKU: 'SKU1', Quantity: 2, UnitPrice: 10, UnitPriceVat: 2, Details: 'Widget' },
  ])
  const update = buildPushPayload(SAMPLE_INPUT, { kind: 'name' }, false)
  assert.equal('OrderItems' in update, false)
})

test('buildPushPayload truncates Comments (1000) and item Details (255)', () => {
  const input: WmsOrderPushInput = {
    ...SAMPLE_INPUT,
    comments: 'x'.repeat(2000),
    lines: [{ sku: 'SKU1', quantity: 1, unitPriceExVat: 1, unitPriceVat: 0, description: 'y'.repeat(400) }],
  }
  const p = buildPushPayload(input, { kind: 'name' })
  assert.equal((p.Comments as string).length, 1000)
  assert.equal(((p.OrderItems as Array<{ Details: string }>)[0].Details).length, 255)
})

test('buildPushPayload courier branches: name / mappedId / defaultId', () => {
  const byName = buildPushPayload(SAMPLE_INPUT, { kind: 'name' })
  assert.equal(byName.CourierService, 'Royal Mail Tracked 24')
  assert.equal('CourierServiceId' in byName, false)

  const mapped = buildPushPayload(SAMPLE_INPUT, { kind: 'mappedId', courierServiceId: 12 })
  assert.equal(mapped.CourierService, 'Royal Mail Tracked 24') // both name + id
  assert.equal(mapped.CourierServiceId, 12)

  const fallback = buildPushPayload(SAMPLE_INPUT, { kind: 'defaultId', courierServiceId: 99 })
  assert.equal('CourierService' in fallback, false) // id only
  assert.equal(fallback.CourierServiceId, 99)
})

test('planMintsoftItemAmendments: reduces a partially-refunded line to its netted quantity', () => {
  const current = [{ ID: 11, SKU: 'A', Quantity: 3 }, { ID: 12, SKU: 'B', Quantity: 1 }]
  const plan = planMintsoftItemAmendments(current, [wmsLine('A', 1), wmsLine('B', 1)])
  assert.deepEqual(plan, [{ kind: 'update', itemId: 11, line: wmsLine('A', 1), quantity: 1 }])
})

test('planMintsoftItemAmendments: deletes a line refunded down to zero (or gone)', () => {
  const current = [{ ID: 11, SKU: 'A', Quantity: 2 }, { ID: 12, SKU: 'B', Quantity: 1 }]
  const plan = planMintsoftItemAmendments(current, [wmsLine('B', 1)])
  assert.deepEqual(plan, [{ kind: 'delete', itemId: 11 }])
})

test('planMintsoftItemAmendments: no change when quantities already match', () => {
  const current = [{ ID: 11, SKU: 'A', Quantity: 2 }]
  assert.deepEqual(planMintsoftItemAmendments(current, [wmsLine('A', 2)]), [])
})

test('planMintsoftItemAmendments: adds a desired line not yet on the WMS order, carrying its quantity', () => {
  const plan = planMintsoftItemAmendments([{ ID: 11, SKU: 'A', Quantity: 1 }], [wmsLine('A', 1), wmsLine('C', 2)])
  assert.deepEqual(plan, [{ kind: 'add', line: wmsLine('C', 2), quantity: 2 }])
})

test('planMintsoftItemAmendments: add carries the aggregated quantity for a duplicated desired SKU', () => {
  const plan = planMintsoftItemAmendments([], [wmsLine('A', 2), wmsLine('A', 1)])
  assert.deepEqual(plan, [{ kind: 'add', line: wmsLine('A', 2), quantity: 3 }])
})

test('planMintsoftItemAmendments: aggregates a SKU split across lines and consolidates duplicate WMS rows (delete before update)', () => {
  const current = [{ ID: 11, SKU: 'A', Quantity: 4 }, { ID: 12, SKU: 'A', Quantity: 1 }]
  const plan = planMintsoftItemAmendments(current, [wmsLine('A', 2), wmsLine('A', 1)])
  // desired total = 3: duplicate row deleted first, then the primary set to 3 (never overstates).
  assert.deepEqual(plan, [
    { kind: 'delete', itemId: 12 },
    { kind: 'update', itemId: 11, line: wmsLine('A', 2), quantity: 3 },
  ])
})

test('planMintsoftItemAmendments: matches on trimmed SKUs so an unchanged order yields no writes', () => {
  assert.deepEqual(planMintsoftItemAmendments([{ ID: 11, SKU: ' A ', Quantity: 2 }], [wmsLine('A', 2)]), [])
})
