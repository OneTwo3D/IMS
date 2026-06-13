import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { availableForTransfer, canDispatchTransferQty } from '@/lib/domain/inventory/transfer-availability'

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
