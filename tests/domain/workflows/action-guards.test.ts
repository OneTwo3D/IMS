import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validatePurchaseOrderStatusTransition,
  validateRefundStatusTransition,
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
  validateStockTransferStatusTransition,
} from '@/lib/domain/workflows/action-guards'

test('sales order action guard allows current aggregate ship flow and blocks direct draft ship', () => {
  assert.deepEqual(validateSalesOrderStatusTransition('DRAFT', 'ALLOCATED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('PENDING_PAYMENT', 'ALLOCATED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('ALLOCATED', 'SHIPPED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('SHIPPED', 'DELIVERED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('SHIPPED', 'PARTIALLY_REFUNDED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('PARTIALLY_REFUNDED', 'REFUNDED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('DRAFT', 'SHIPPED'), {
    success: false,
    error: 'Cannot transition sales order from DRAFT to SHIPPED',
  })
})

test('shipment action guard blocks skipping pick and pack states', () => {
  assert.deepEqual(validateShipmentStatusTransition('PENDING', 'PICKING'), { success: true })
  assert.deepEqual(validateShipmentStatusTransition('PENDING', 'SHIPPED'), {
    success: false,
    error: 'Cannot transition shipment from PENDING to SHIPPED',
  })
})

test('purchase order action guard blocks invalid receipt and closed transitions', () => {
  assert.deepEqual(validatePurchaseOrderStatusTransition('PO_SENT', 'RECEIVED'), { success: true })
  assert.deepEqual(validatePurchaseOrderStatusTransition('DRAFT', 'RECEIVED'), {
    success: false,
    error: 'Cannot transition purchase order from DRAFT to RECEIVED',
  })
})

test('refund action guard blocks reverting a paid refund lifecycle', () => {
  assert.deepEqual(validateRefundStatusTransition('RECORDED', 'PAID'), { success: true })
  assert.deepEqual(validateRefundStatusTransition('PAID', 'RECORDED'), {
    success: false,
    error: 'Cannot transition refund from PAID to RECORDED',
  })
})

test('stock transfer action guard blocks direct receive from draft', () => {
  assert.deepEqual(validateStockTransferStatusTransition('DRAFT', 'IN_TRANSIT'), { success: true })
  assert.deepEqual(validateStockTransferStatusTransition('DRAFT', 'RECEIVED'), {
    success: false,
    error: 'Cannot transition stock transfer from DRAFT to RECEIVED',
  })
})

test('action guards report unknown statuses separately from invalid transitions', () => {
  assert.deepEqual(validateShipmentStatusTransition('PENDING', 'LOST'), {
    success: false,
    error: 'Unknown target shipment status: LOST',
  })
})
