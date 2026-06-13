import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  calculateAdjustmentStockDelta,
  assertAdjustmentEditFifoFeasible,
} from '@/lib/domain/inventory/stock-adjustment-edit'

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

test('assertAdjustmentEditFifoFeasible allows growing a reduction the restored layers can cover', () => {
  // Old reduction of 5 (restorable), 3 still on hand elsewhere → 8 available, new reduction 8.
  const { availableAfterCleanup } = assertAdjustmentEditFifoFeasible({
    newIsAddition: false,
    newAbsQty: 8,
    currentRemainingLayerQty: new Prisma.Decimal('3'),
    restorableConsumedQty: new Prisma.Decimal('5'),
  })
  assert.equal(availableAfterCleanup, 8)
})

test('assertAdjustmentEditFifoFeasible rejects a reduction larger than the post-cleanup pool, before mutation', () => {
  // Old reduction of 5 restored, only 3 elsewhere → 8 available, but edit asks to remove 20.
  assert.throws(
    () => assertAdjustmentEditFifoFeasible({
      newIsAddition: false,
      newAbsQty: 20,
      currentRemainingLayerQty: new Prisma.Decimal('3'),
      restorableConsumedQty: new Prisma.Decimal('5'),
    }),
    /Cannot edit this adjustment to remove 20 unit\(s\): only 8\.0000 unit\(s\) are available/,
  )
})

test('assertAdjustmentEditFifoFeasible removes the old addition layer from the pool before re-consuming', () => {
  // Old addition added 10 (its own layer remainingQty), total pool 10; edit to a reduction of 5.
  // After deleting the addition layer the pool is 0, so removing 5 is infeasible.
  assert.throws(
    () => assertAdjustmentEditFifoFeasible({
      newIsAddition: false,
      newAbsQty: 5,
      currentRemainingLayerQty: new Prisma.Decimal('10'),
      removableLayerQty: new Prisma.Decimal('10'),
    }),
    /only 0\.0000 unit\(s\) are available/,
  )
})

test('assertAdjustmentEditFifoFeasible always allows an addition (creates a layer, never consumes)', () => {
  const { availableAfterCleanup } = assertAdjustmentEditFifoFeasible({
    newIsAddition: true,
    newAbsQty: 999,
    currentRemainingLayerQty: new Prisma.Decimal('0'),
  })
  assert.equal(availableAfterCleanup, 0)
})
