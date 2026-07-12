import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { availableForTransfer, canDispatchTransferQty, isCostLayerCoverageSufficient } from '@/lib/domain/inventory/transfer-availability'

test('availableForTransfer nets reserved (allocated) qty out of on-hand', () => {
  assert.equal(availableForTransfer(new Prisma.Decimal('100'), new Prisma.Decimal('30')), 70)
})

test('availableForTransfer never goes negative', () => {
  assert.equal(availableForTransfer(new Prisma.Decimal('10'), new Prisma.Decimal('15')), 0)
})

test('availableForTransfer treats missing level as zero', () => {
  assert.equal(availableForTransfer(null, null), 0)
  assert.equal(availableForTransfer(undefined, undefined), 0)
})

test('canDispatchTransferQty: cannot dispatch into reserved stock', () => {
  // 100 on hand, 30 reserved for an order → only 70 transferable.
  assert.equal(canDispatchTransferQty(new Prisma.Decimal('100'), new Prisma.Decimal('30'), 70), true)
  assert.equal(canDispatchTransferQty(new Prisma.Decimal('100'), new Prisma.Decimal('30'), 71), false)
})

test('canDispatchTransferQty: full unreserved stock is transferable', () => {
  assert.equal(canDispatchTransferQty(new Prisma.Decimal('50'), new Prisma.Decimal('0'), 50), true)
})

test('canDispatchTransferQty: rejects when over-reserved (reservedQty > quantity)', () => {
  assert.equal(canDispatchTransferQty(new Prisma.Decimal('10'), new Prisma.Decimal('15'), 1), false)
})

test('isCostLayerCoverageSufficient: full coverage permits dispatch', () => {
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('10'), 10), true)
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('10'), 8), true)
})

test('isCostLayerCoverageSufficient: positive stock with too few cost layers is rejected (scjz.4)', () => {
  // stock_level may say 10, but only 6 units are covered by cost layers (desync).
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('6'), 10), false)
  // No cost layers at all → un-dispatchable until repaired.
  assert.equal(isCostLayerCoverageSufficient(null, 5), false)
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('0'), 5), false)
})

test('isCostLayerCoverageSufficient: sub-µ shortfall is tolerated (scjz.4/.6)', () => {
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('9.9999995'), 10), true)
  assert.equal(isCostLayerCoverageSufficient(new Prisma.Decimal('9.99999'), 10), false)
})
