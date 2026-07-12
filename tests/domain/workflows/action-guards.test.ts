import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateLinkedFreightReceiptStatus,
  validateManualSalesOrderStatusTransition,
  validatePurchaseOrderStatusTransition,
  validatePurchaseReceiptStatusUpdate,
  validateRefundSalesOrderStatusUpdate,
  validateRefundStatusTransition,
  validateSalesOrderStatusTransition,
  validateShipmentStatusTransition,
  validateStockTransferStatusTransition,
} from '@/lib/domain/workflows/action-guards'
import { PURCHASE_ORDER_STATUSES } from '@/lib/domain/workflows/status-types'

test('sales order action guard allows current aggregate ship flow and blocks direct draft ship', () => {
  assert.deepEqual(validateSalesOrderStatusTransition('DRAFT', 'ALLOCATED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('PENDING_PAYMENT', 'ALLOCATED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('ALLOCATED', 'SHIPPED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('SHIPPED', 'DELIVERED'), { success: true })
  assert.deepEqual(validateSalesOrderStatusTransition('DRAFT', 'SHIPPED'), {
    success: false,
    error: 'Cannot transition sales order from DRAFT to SHIPPED',
  })
})

test('manual sales order status guard routes refund states through refund workflow', () => {
  assert.deepEqual(validateManualSalesOrderStatusTransition('SHIPPED', 'COMPLETED'), { success: true })
  assert.deepEqual(validateManualSalesOrderStatusTransition('DRAFT', 'REFUNDED', { bypass: true }), { success: true })
  assert.deepEqual(validateManualSalesOrderStatusTransition('SHIPPED', 'PARTIALLY_REFUNDED'), {
    success: false,
    error: 'Use the refund workflow to update refund status.',
  })
  assert.deepEqual(validateManualSalesOrderStatusTransition('DRAFT', 'REFUNDED'), {
    success: false,
    error: 'Use the refund workflow to update refund status.',
  })
})

test('refund sales order status guard short-circuits same-status updates; refund states are retired', () => {
  // Refund state is the orthogonal refundStatus now; the lifecycle no longer has
  // REFUNDED/PARTIALLY_REFUNDED, so they are not valid transition targets.
  assert.deepEqual(validateRefundSalesOrderStatusUpdate('SHIPPED', 'SHIPPED'), { success: true })
  assert.equal(validateRefundSalesOrderStatusUpdate('SHIPPED', 'PARTIALLY_REFUNDED').success, false)
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

test('purchase receipt status guard permits repeated partial receipts as progress', () => {
  assert.deepEqual(validatePurchaseReceiptStatusUpdate('PO_SENT', 'PARTIALLY_RECEIVED'), { success: true })
  assert.deepEqual(validatePurchaseReceiptStatusUpdate('PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED'), { success: true })
  assert.deepEqual(validatePurchaseReceiptStatusUpdate('PARTIALLY_RECEIVED', 'RECEIVED'), { success: true })
  assert.deepEqual(validatePurchaseReceiptStatusUpdate('RECEIVED', 'PARTIALLY_RECEIVED'), {
    success: false,
    error: 'Cannot transition purchase order from RECEIVED to PARTIALLY_RECEIVED',
  })
})

test('linked freight receipt guard allows derived receipt from committed freight states only', () => {
  const allowedStatuses = new Set(['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED'])

  for (const status of PURCHASE_ORDER_STATUSES) {
    const result = validateLinkedFreightReceiptStatus(status)
    if (allowedStatuses.has(status)) {
      assert.deepEqual(result, { success: true }, `expected ${status} to be accepted`)
    } else {
      assert.deepEqual(result, {
        success: false,
        error: `Cannot mark linked freight purchase order as received from ${status}`,
      }, `expected ${status} to be rejected`)
    }
  }
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
