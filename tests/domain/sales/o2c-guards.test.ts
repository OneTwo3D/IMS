import assert from 'node:assert/strict'
import test from 'node:test'

import {
  refundWouldExceedOrderTotal,
  isPaymentStatusMismatch,
  REFUND_TOTAL_EPSILON,
} from '@/lib/domain/sales/o2c-guards'

test('refund within the order total is allowed', () => {
  assert.equal(refundWouldExceedOrderTotal(40, 50, 100), false)
})

test('refund exactly at the order total is allowed (epsilon slack)', () => {
  assert.equal(refundWouldExceedOrderTotal(50, 50, 100), false)
})

test('cumulative partial refunds cannot creep over the total (fixed epsilon, not relative)', () => {
  // Old 0.1% relative slack on a £10,000 order allowed ~£10 over; the fixed
  // epsilon rejects anything beyond a rounding penny.
  assert.equal(refundWouldExceedOrderTotal(1, 10000, 10000), true)
  // A sub-penny rounding remainder is still tolerated.
  assert.equal(refundWouldExceedOrderTotal(0.01, 9999.99, 10000), false)
  assert.ok(REFUND_TOTAL_EPSILON < 0.02)
})

test('isPaymentStatusMismatch: advanced status + became unpaid → mismatch', () => {
  assert.equal(isPaymentStatusMismatch('SHIPPED', true), true)
  assert.equal(isPaymentStatusMismatch('COMPLETED', true), true)
  assert.equal(isPaymentStatusMismatch('DELIVERED', true), true)
  assert.equal(isPaymentStatusMismatch('PARTIALLY_REFUNDED', true), true)
})

test('isPaymentStatusMismatch: pre-payment status or still-paid → no mismatch', () => {
  assert.equal(isPaymentStatusMismatch('PROCESSING', true), false)
  assert.equal(isPaymentStatusMismatch('ALLOCATED', true), false)
  assert.equal(isPaymentStatusMismatch('SHIPPED', false), false)
})
