import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import { updatePreferredSuppliersForPlacedPurchaseOrder } from '@/lib/domain/purchasing/preferred-supplier'

function txForPurchaseOrder(po: {
  supplierId: string
  type?: string
  skipPreferredSupplierUpdate?: boolean
  productIds: string[]
}) {
  const calls: { lockedSql: unknown[]; updateManyArgs: unknown[] } = {
    lockedSql: [],
    updateManyArgs: [],
  }
  const tx = {
    $executeRaw: async (query: unknown) => {
      calls.lockedSql.push(query)
      return 1
    },
    purchaseOrder: {
      findUnique: async () => ({
        id: 'po-1',
        supplierId: po.supplierId,
        type: po.type ?? 'GOODS',
        skipPreferredSupplierUpdate: po.skipPreferredSupplierUpdate ?? false,
        lines: po.productIds.map((productId) => ({ productId })),
      }),
    },
    product: {
      updateMany: async (args: unknown) => {
        calls.updateManyArgs.push(args)
        return { count: new Set(po.productIds).size }
      },
    },
  }

  return { tx: tx as unknown as Prisma.TransactionClient, calls }
}

test('preferred supplier update locks sorted product ids and respects lock flag', async () => {
  const { tx, calls } = txForPurchaseOrder({
    supplierId: 'supplier-1',
    productIds: ['product-b', 'product-a', 'product-a'],
  })
  const placedAt = new Date('2026-06-10T10:00:00.000Z')

  const result = await updatePreferredSuppliersForPlacedPurchaseOrder(tx, 'po-1', placedAt)

  assert.deepEqual(result.productIds, ['product-a', 'product-b'])
  assert.equal(result.updatedCount, 2)
  assert.equal(calls.lockedSql.length, 1)
  assert.deepEqual(calls.updateManyArgs, [{
    where: {
      id: { in: ['product-a', 'product-b'] },
      preferredSupplierLocked: false,
    },
    data: {
      preferredSupplierId: 'supplier-1',
      preferredSupplierUpdatedAt: placedAt,
    },
  }])
})

test('preferred supplier update skips one-off and non-goods purchase orders', async () => {
  const oneOff = txForPurchaseOrder({
    supplierId: 'supplier-1',
    skipPreferredSupplierUpdate: true,
    productIds: ['product-a'],
  })
  assert.deepEqual(
    await updatePreferredSuppliersForPlacedPurchaseOrder(oneOff.tx, 'po-1', new Date()),
    { productIds: [], updatedCount: 0 },
  )
  assert.equal(oneOff.calls.updateManyArgs.length, 0)

  const freight = txForPurchaseOrder({
    supplierId: 'supplier-1',
    type: 'FREIGHT',
    productIds: ['product-a'],
  })
  assert.deepEqual(
    await updatePreferredSuppliersForPlacedPurchaseOrder(freight.tx, 'po-1', new Date()),
    { productIds: [], updatedCount: 0 },
  )
  assert.equal(freight.calls.updateManyArgs.length, 0)
})
