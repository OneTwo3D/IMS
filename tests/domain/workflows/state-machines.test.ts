import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  PURCHASE_ORDER_STATUSES,
  REFUND_STATUSES,
  SALES_ORDER_STATUSES,
  SHIPMENT_STATUSES,
  STOCK_TRANSFER_STATUSES,
  WorkflowTransitionError,
} from '@/lib/domain/workflows/status-types'
import {
  PURCHASE_ORDER_TRANSITIONS,
  assertPurchaseOrderTransition,
  canTransitionPurchaseOrder,
} from '@/lib/domain/workflows/purchase-order-state'
import {
  REFUND_TRANSITIONS,
  assertRefundTransition,
  canTransitionRefund,
} from '@/lib/domain/workflows/refund-state'
import {
  SALES_ORDER_TRANSITIONS,
  assertSalesOrderTransition,
  canTransitionSalesOrder,
} from '@/lib/domain/workflows/sales-order-state'
import {
  SHIPMENT_TRANSITIONS,
  assertShipmentTransition,
  canTransitionShipment,
} from '@/lib/domain/workflows/shipment-state'
import {
  STOCK_TRANSFER_TRANSITIONS,
  assertStockTransferTransition,
  canTransitionStockTransfer,
} from '@/lib/domain/workflows/stock-transfer-state'

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const schema = readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8')

function schemaEnumValues(name: string): string[] {
  const match = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`))
  assert.ok(match, `Missing Prisma enum ${name}`)
  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
}

test('workflow status lists match persisted Prisma enums', () => {
  assert.deepEqual([...SALES_ORDER_STATUSES], schemaEnumValues('SalesOrderStatus'))
  assert.deepEqual([...SHIPMENT_STATUSES], schemaEnumValues('ShipmentStatus'))
  assert.deepEqual([...PURCHASE_ORDER_STATUSES], schemaEnumValues('PurchaseOrderStatus'))
  assert.deepEqual([...STOCK_TRANSFER_STATUSES], schemaEnumValues('StockTransferStatus'))
})

test('every workflow transition map covers every known status', () => {
  assert.deepEqual(Object.keys(SALES_ORDER_TRANSITIONS), [...SALES_ORDER_STATUSES])
  assert.deepEqual(Object.keys(SHIPMENT_TRANSITIONS), [...SHIPMENT_STATUSES])
  assert.deepEqual(Object.keys(PURCHASE_ORDER_TRANSITIONS), [...PURCHASE_ORDER_STATUSES])
  assert.deepEqual(Object.keys(STOCK_TRANSFER_TRANSITIONS), [...STOCK_TRANSFER_STATUSES])
  assert.deepEqual(Object.keys(REFUND_TRANSITIONS), [...REFUND_STATUSES])
})

test('sales order state machine allows current forward paths and blocks direct jumps', () => {
  assert.equal(canTransitionSalesOrder('DRAFT', 'PROCESSING'), true)
  assert.equal(canTransitionSalesOrder('PROCESSING', 'ALLOCATED'), true)
  assert.equal(canTransitionSalesOrder('ALLOCATED', 'SHIPPED'), true)
  assert.equal(canTransitionSalesOrder('PICKING', 'ON_HOLD'), true)
  assert.equal(canTransitionSalesOrder('PICKING', 'SHIPPED'), true)
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'PICKING'), true)
  assert.equal(canTransitionSalesOrder('PACKING', 'ON_HOLD'), true)
  assert.equal(canTransitionSalesOrder('ON_HOLD', 'PACKING'), true)
  assert.equal(canTransitionSalesOrder('PACKING', 'SHIPPED'), true)
  assert.equal(canTransitionSalesOrder('SHIPPED', 'COMPLETED'), true)
  assert.equal(canTransitionSalesOrder('DRAFT', 'SHIPPED'), false)
  assert.equal(canTransitionSalesOrder('SHIPPED', 'CANCELLED'), false)
  assert.throws(
    () => assertSalesOrderTransition('DRAFT', 'SHIPPED'),
    WorkflowTransitionError,
  )
})

test('shipment state machine preserves pick-pack-ship sequence', () => {
  assert.equal(canTransitionShipment('PENDING', 'PICKING'), true)
  assert.equal(canTransitionShipment('PICKING', 'PACKED'), true)
  assert.equal(canTransitionShipment('PACKED', 'SHIPPED'), true)
  assert.equal(canTransitionShipment('PENDING', 'SHIPPED'), false)
  assert.equal(canTransitionShipment('SHIPPED', 'PACKED'), false)
  assert.throws(
    () => assertShipmentTransition('PENDING', 'SHIPPED'),
    WorkflowTransitionError,
  )
})

test('purchase order state machine includes manual, receipt, return, and cancel paths', () => {
  assert.equal(canTransitionPurchaseOrder('DRAFT', 'RFQ_SENT'), true)
  assert.equal(canTransitionPurchaseOrder('DRAFT', 'CANCELLED'), true)
  assert.equal(canTransitionPurchaseOrder('PO_SENT', 'PARTIALLY_RECEIVED'), true)
  assert.equal(canTransitionPurchaseOrder('PARTIALLY_RECEIVED', 'RECEIVED'), true)
  assert.equal(canTransitionPurchaseOrder('RECEIVED', 'INVOICED'), true)
  assert.equal(canTransitionPurchaseOrder('RECEIVED', 'PARTIALLY_RETURNED'), true)
  assert.equal(canTransitionPurchaseOrder('DRAFT', 'RECEIVED'), false)
  assert.equal(canTransitionPurchaseOrder('RETURNED', 'RECEIVED'), false)
  assert.throws(
    () => assertPurchaseOrderTransition('DRAFT', 'RECEIVED'),
    WorkflowTransitionError,
  )
})

test('refund state machine documents the current derived lifecycle', () => {
  assert.equal(canTransitionRefund('RECORDED', 'CREDIT_NOTE_SYNCED'), true)
  assert.equal(canTransitionRefund('RECORDED', 'PAID'), true)
  assert.equal(canTransitionRefund('CREDIT_NOTE_SYNCED', 'PAID'), true)
  assert.equal(canTransitionRefund('PAID', 'RECORDED'), false)
  assert.throws(
    () => assertRefundTransition('PAID', 'RECORDED'),
    WorkflowTransitionError,
  )
})

test('stock transfer state machine preserves dispatch-receive workflow', () => {
  assert.equal(canTransitionStockTransfer('DRAFT', 'IN_TRANSIT'), true)
  assert.equal(canTransitionStockTransfer('DRAFT', 'CANCELLED'), true)
  assert.equal(canTransitionStockTransfer('IN_TRANSIT', 'RECEIVED'), true)
  assert.equal(canTransitionStockTransfer('DRAFT', 'RECEIVED'), false)
  assert.equal(canTransitionStockTransfer('RECEIVED', 'CANCELLED'), false)
  assert.throws(
    () => assertStockTransferTransition('DRAFT', 'RECEIVED'),
    WorkflowTransitionError,
  )
})
