import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ORDER_STATUSES_NOT_READY_TO_DISPATCH,
  orderNotReadyToDispatchMessage,
  resolveShippedPromotion,
} from '@/lib/domain/workflows/sales-order-state'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'

test('resolveShippedPromotion: ALLOCATED, PICKING and PACKING have a direct edge', () => {
  for (const status of ['ALLOCATED', 'PICKING', 'PACKING'] as SalesOrderStatus[]) {
    assert.deepEqual(resolveShippedPromotion(status), { success: true, viaAllocated: false }, status)
  }
})

test('resolveShippedPromotion: only PROCESSING is promoted via ALLOCATED', () => {
  assert.deepEqual(resolveShippedPromotion('PROCESSING'), { success: true, viaAllocated: true })
})

test('resolveShippedPromotion: DRAFT, ON_HOLD and PENDING_PAYMENT are never promoted by a dispatch', () => {
  for (const status of ['DRAFT', 'ON_HOLD', 'PENDING_PAYMENT'] as SalesOrderStatus[]) {
    const result = resolveShippedPromotion(status)
    assert.equal(result.success, false, status)
    assert.match(result.success ? '' : result.error, new RegExp(`from ${status} to SHIPPED`))
  }
})

test('resolveShippedPromotion: terminal and unknown statuses are refused', () => {
  for (const status of ['CANCELLED', 'DELIVERED', 'NOPE'] as SalesOrderStatus[]) {
    assert.equal(resolveShippedPromotion(status).success, false, status)
  }
})

test('the not-ready set is exactly DRAFT, ON_HOLD and PENDING_PAYMENT, each with its own next step', () => {
  assert.deepEqual([...ORDER_STATUSES_NOT_READY_TO_DISPATCH].sort(), ['DRAFT', 'ON_HOLD', 'PENDING_PAYMENT'])
  assert.match(orderNotReadyToDispatchMessage('DRAFT'), /Finalise the draft/)
  assert.match(orderNotReadyToDispatchMessage('ON_HOLD'), /Release the hold/)
  assert.match(orderNotReadyToDispatchMessage('PENDING_PAYMENT'), /Record the payment/)
})
