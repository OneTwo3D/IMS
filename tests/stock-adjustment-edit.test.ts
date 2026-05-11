import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { calculateAdjustmentStockDelta } from '@/lib/domain/inventory/stock-adjustment-edit'

test('calculateAdjustmentStockDelta applies a single net stock delta', () => {
  assert.deepEqual(calculateAdjustmentStockDelta({
    oldSignedQty: -5,
    newSignedQty: -3,
    currentQuantity: new Prisma.Decimal('0'),
    currentReservedQty: new Prisma.Decimal('0'),
  }), {
    stockDelta: 2,
    resultingQuantity: 2,
    reservedQty: 0,
  })
})

test('calculateAdjustmentStockDelta rejects edits below reserved stock before callers write stock levels', () => {
  assert.throws(
    () => calculateAdjustmentStockDelta({
      oldSignedQty: -5,
      newSignedQty: -8,
      currentQuantity: new Prisma.Decimal('0'),
      currentReservedQty: new Prisma.Decimal('1'),
    }),
    /resulting stock \(-3\.0000\) would be below reserved quantity \(1\.0000\)/,
  )
})
