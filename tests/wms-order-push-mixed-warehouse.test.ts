/**
 * Owner ruling 2026-11-18 (PR #1031 round 1): a WMS despatch ships only that warehouse's part of a mixed-warehouse order, so the warehouse must be SENT only
 * that part. Pure builders, no network. A single-warehouse (or unallocated) order must build exactly what it built before.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NOTHING_ALLOCATED_TO_WMS_WAREHOUSE_REASON,
  ORDER_PUSH_SELECT,
  WMS_CANCELLABLE_ORDER_WHERE,
  buildLines,
  buildPushInput,
  payloadTotalMismatchPence,
} from '../lib/domain/wms/order-push-sweep.ts'
import { DISPATCH_POLLED_ORDER_WHERE } from '../lib/domain/wms/dispatch-sweep.ts'

const lineA = { id: 'la', sku: 'SKU-A', qty: 5, taxForeign: 10, totalForeign: 50, description: 'A', productId: 'pa', externalLineItemId: 1, wclcFeeKind: null }
const lineB = { id: 'lb', sku: 'SKU-B', qty: 2, taxForeign: 4, totalForeign: 20, description: 'B', productId: 'pb', externalLineItemId: 2, wclcFeeKind: null }
const fee = { id: 'lf', sku: '', qty: 1, taxForeign: 1.26, totalForeign: 6, description: 'EU Import Duty', productId: null, externalLineItemId: null, wclcFeeKind: 'duty_flat' }
const alloc = (lineId: string, productId: string, warehouseId: string, qty: number) => ({ lineId, productId, warehouseId, qty })

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: '1001', currency: 'GBP',
    customerName: 'A B', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 St', firstName: 'A', lastName: 'B', country: 'GB' }, shippingService: null,
    subtotalForeign: 70, shippingForeign: 5, taxForeign: 15.26, taxRatePercent: null,
    pricesIncludeVat: false, discountAmount: 0, totalForeign: 96.26,
    lines: [lineA, lineB, fee], refunds: [], shipFromWarehouseId: 'wh-wms',
    ...over,
  } as unknown as Parameters<typeof buildPushInput>[0]
}

test('a mixed order pushes only the quantities allocated to the WMS warehouse; shipping and the order VAT go once, with that part', () => {
  const input = buildPushInput(order({ allocations: [alloc('la', 'pa', 'wh-wms', 3), alloc('la', 'pa', 'wh-home', 2), alloc('lb', 'pb', 'wh-home', 2)] }), '301')
  assert.deepEqual(input.lines.map((l) => [l.sku, l.quantity]), [['SKU-A', 3]])
  assert.equal(input.lines[0].unitPriceExVat, 10, 'unit price stays per ORIGINAL quantity')
  assert.equal(input.shippingExVat, 5)
  assert.equal(input.totalVat, 15.26)
})

test('the push-total guard stays balanced for a mixed order (the withheld foreign NET is on the expected side) and can still fail', () => {
  const o = order({ allocations: [alloc('la', 'pa', 'wh-wms', 3), alloc('la', 'pa', 'wh-home', 2), alloc('lb', 'pb', 'wh-home', 2)] })
  assert.equal(payloadTotalMismatchPence(o, buildPushInput(o, '301')), null)
  const wrong = order({ allocations: [alloc('la', 'pa', 'wh-wms', 3), alloc('la', 'pa', 'wh-home', 2), alloc('lb', 'pb', 'wh-home', 2)], totalForeign: 120 })
  assert.ok((payloadTotalMismatchPence(wrong, buildPushInput(wrong, '301')) ?? 0) > 0, 'a genuinely wrong total is still reported')
})

test('an amendment is scoped to the PUSHED warehouse, not a ship-from changed since', () => {
  const o = order({ shipFromWarehouseId: 'wh-home', pushWarehouseId: 'wh-wms', allocations: [alloc('la', 'pa', 'wh-wms', 5), alloc('lb', 'pb', 'wh-home', 2)] })
  assert.deepEqual(buildPushInput(o, '301').lines.map((l) => [l.sku, l.quantity]), [['SKU-A', 5]])
})

test('refunded units are netted first and never counted twice with the foreign withholding', () => {
  const o = order({ refunds: [{ lines: [{ salesOrderLineId: 'la', qty: 1 }] }], allocations: [alloc('la', 'pa', 'wh-wms', 3), alloc('la', 'pa', 'wh-home', 2), alloc('lb', 'pb', 'wh-wms', 2)] })
  assert.deepEqual(buildPushInput(o, '301').lines.map((l) => [l.sku, l.quantity]), [['SKU-A', 3], ['SKU-B', 2]])
})

test('a mixed order with nothing allocated to the WMS warehouse is refused locally: nothing is built to send', () => {
  const o = order({ allocations: [alloc('la', 'pa', 'wh-home', 5), alloc('lb', 'pb', 'wh-home', 2), alloc('lb', 'pb', 'wh-other', 1)] })
  assert.throws(() => buildPushInput(o, '301'), new RegExp(NOTHING_ALLOCATED_TO_WMS_WAREHOUSE_REASON.slice(0, 40)))
})

test('a kit line (allocated per component) is sent only for the whole units its components cover in the WMS warehouse', () => {
  const kit = { ...lineA, id: 'lk', qty: 4, productId: 'kit' }
  const o = order({ lines: [kit], allocations: [alloc('lk', 'c1', 'wh-wms', 4), alloc('lk', 'c1', 'wh-home', 4), alloc('lk', 'c2', 'wh-wms', 8)] })
  assert.deepEqual(buildPushInput(o, '301').lines.map((l) => l.quantity), [2], 'c1 has half of its units in the WMS warehouse, c2 all: two kits')
})

test('single-warehouse and unallocated orders build exactly what they built before (no diff)', () => {
  const base = order()
  const baseline = buildPushInput(base, '301')
  assert.deepEqual(baseline.lines, buildLines([lineA, lineB, fee]))
  for (const allocations of [[], [alloc('la', 'pa', 'wh-wms', 5), alloc('lb', 'pb', 'wh-wms', 2)], [alloc('la', 'pa', 'wh-home', 5), alloc('lb', 'pb', 'wh-home', 2)]]) {
    assert.deepEqual(buildPushInput(order({ allocations }), '301'), baseline)
  }
  assert.equal(payloadTotalMismatchPence(base, baseline), payloadTotalMismatchPence(order({ allocations: [alloc('la', 'pa', 'wh-wms', 5)] }), baseline))
})

test('the order read carries the allocations the scope needs', () => {
  assert.deepEqual(Object.keys((ORDER_PUSH_SELECT.allocations as { select: object }).select).sort(), ['lineId', 'productId', 'qty', 'warehouseId'])
})

test('a fully refunded order is not "not yet despatched" once a shipment has left, and a partly despatched link is not polled', () => {
  const refundArm = (WMS_CANCELLABLE_ORDER_WHERE.OR as Array<Record<string, unknown>>).find((arm) => arm.refundStatus === 'FULL')
  assert.deepEqual(refundArm?.shipments, { none: { status: 'SHIPPED' } })
  assert.deepEqual((DISPATCH_POLLED_ORDER_WHERE[0] as { partialDespatchAppliedAt?: null }).partialDespatchAppliedAt, null)
})
