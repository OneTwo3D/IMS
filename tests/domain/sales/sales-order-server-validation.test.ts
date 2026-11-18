import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransitionSalesOrder } from '../../../lib/domain/workflows/sales-order-state.ts'
import { markPaidRefusal } from '../../../lib/domain/sales/mark-paid-guard.ts'
import { resolveHeaderTaxRate, salesOrderMoneyRefusal } from '../../../lib/domain/sales/sales-order-input-validation.ts'
import { manualRefundStatusRefusal, refundLinesNotOnOrder } from '../../../lib/domain/sales/refund-service.ts'

test('no status moves back to DRAFT, but drafts still finalise and cancel', () => {
  for (const from of ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const) {
    assert.equal(canTransitionSalesOrder(from, 'DRAFT'), false, from)
  }
  for (const to of ['PROCESSING', 'PENDING_PAYMENT', 'ALLOCATED', 'CANCELLED', 'ON_HOLD'] as const) {
    assert.equal(canTransitionSalesOrder('DRAFT', to), true, to)
  }
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'PROCESSING'), true)
})

test('markSalesOrderPaid refuses draft/cancelled and clearing a paid state with receipts', () => {
  const ok = { status: 'PROCESSING', markingAsPaid: true, hasUnregisteredPaidMarker: false, paymentCount: 0 }
  assert.equal(markPaidRefusal(ok), null)
  assert.ok(markPaidRefusal({ ...ok, status: 'DRAFT' }))
  assert.ok(markPaidRefusal({ ...ok, status: 'CANCELLED' }))
  assert.ok(markPaidRefusal({ ...ok, markingAsPaid: false, hasUnregisteredPaidMarker: true, paymentCount: 1 }))
  assert.ok(markPaidRefusal({ ...ok, markingAsPaid: false, hasUnregisteredPaidMarker: false, paymentCount: 0 }))
  assert.equal(markPaidRefusal({ ...ok, markingAsPaid: false, hasUnregisteredPaidMarker: true, paymentCount: 0 }), null)
})

test('negative header money and line discounts are refused; zero and positive pass', () => {
  const base = { lines: [{ sku: 'A', discountAmount: 0 }] }
  assert.equal(salesOrderMoneyRefusal({ ...base, shippingForeign: 0, orderDiscountForeign: 5, fees: [{ description: 'x', amount: 1 }], taxRateValue: 0.2 }), null)
  assert.ok(salesOrderMoneyRefusal({ ...base, orderDiscountForeign: -50 }))
  assert.ok(salesOrderMoneyRefusal({ ...base, shippingForeign: -1 }))
  assert.ok(salesOrderMoneyRefusal({ ...base, fees: [{ description: 'x', amount: -1 }] }))
  assert.ok(salesOrderMoneyRefusal({ lines: [{ sku: 'A', discountAmount: -3 }] }))
  assert.ok(salesOrderMoneyRefusal({ ...base, shippingForeign: Number.NaN }))
})

test('the named rate value beats the caller value', () => {
  assert.equal(resolveHeaderTaxRate(0.2, 0), 0.2)
  assert.equal(resolveHeaderTaxRate(0.2, 0.05), 0.2)
  assert.equal(resolveHeaderTaxRate(null, 0.05), 0.05)
  assert.equal(resolveHeaderTaxRate(undefined, undefined), 0)
})

test('manual refunds refuse draft and pending-payment orders and foreign line ids', () => {
  assert.ok(manualRefundStatusRefusal('DRAFT'))
  assert.ok(manualRefundStatusRefusal('PENDING_PAYMENT'))
  for (const s of ['PROCESSING', 'SHIPPED', 'DELIVERED', 'ON_HOLD']) assert.equal(manualRefundStatusRefusal(s), null, s)
  const orderLines = [{ id: 'l1' }, { id: 'l2' }]
  assert.equal(refundLinesNotOnOrder([{ lineId: 'l1' }, { lineId: null }], orderLines), null)
  assert.deepEqual(refundLinesNotOnOrder([{ lineId: 'l1' }, { lineId: 'other' }], orderLines), { lineId: 'other' })
})
