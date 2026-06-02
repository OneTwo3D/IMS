import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  inventoryLedgerReferenceHref,
  matchAdjustmentReason,
  movementDirection,
  signedMovementQty,
  signedMovementValue,
} from '@/lib/domain/inventory/inventory-ledger-reports'

function movement(overrides: Partial<Parameters<typeof signedMovementQty>[0]>): Parameters<typeof signedMovementQty>[0] {
  return {
    type: 'PURCHASE_RECEIPT',
    qty: new Prisma.Decimal(5),
    totalValueBase: new Prisma.Decimal(12.5),
    fromWarehouseId: null,
    toWarehouseId: 'warehouse-1',
    ...overrides,
  }
}

test('signedMovementQty and signedMovementValue classify inbound and outbound movement evidence', () => {
  assert.equal(signedMovementQty(movement({ type: 'PURCHASE_RECEIPT' })).toString(), '5')
  assert.equal(signedMovementValue(movement({ type: 'PURCHASE_RECEIPT' })).toString(), '12.5')
  assert.equal(movementDirection(movement({ type: 'PURCHASE_RECEIPT' })), 'in')

  assert.equal(signedMovementQty(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-5')
  assert.equal(signedMovementValue(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-12.5')
  assert.equal(movementDirection(movement({ type: 'SALE_DISPATCH', fromWarehouseId: 'warehouse-1', toWarehouseId: null })), 'out')
})

test('signedMovementQty handles adjustment direction from populated warehouse side', () => {
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: null, toWarehouseId: 'warehouse-1' })).toString(), '5')
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: 'warehouse-1', toWarehouseId: null })).toString(), '-5')
  assert.equal(signedMovementQty(movement({ type: 'ADJUSTMENT', fromWarehouseId: 'warehouse-1', toWarehouseId: 'warehouse-2' })).toString(), '0')
})

test('matchAdjustmentReason prefers canonical adjustment reasons over note text', () => {
  const reasons = [{ name: 'Damaged stock' }, { name: 'Damaged' }]
  assert.deepEqual(matchAdjustmentReason('Damaged stock: crushed carton', reasons), {
    reasonName: 'Damaged stock',
    matched: true,
  })
  assert.deepEqual(matchAdjustmentReason('Cycle count correction', reasons), {
    reasonName: 'Cycle count correction',
    matched: false,
  })
  assert.deepEqual(matchAdjustmentReason(null, reasons), {
    reasonName: 'Uncategorised',
    matched: false,
  })
})

test('inventoryLedgerReferenceHref maps source references to drill-through URLs', () => {
  assert.equal(inventoryLedgerReferenceHref('PurchaseOrder', 'po-1'), '/purchase-orders/po-1')
  assert.equal(inventoryLedgerReferenceHref('SalesOrder', 'so-1'), '/sales/so-1')
  assert.equal(inventoryLedgerReferenceHref('ProductionOrder', 'mo-1'), '/manufacturing/mo-1')
  assert.equal(inventoryLedgerReferenceHref('Unknown', 'x'), null)
})
