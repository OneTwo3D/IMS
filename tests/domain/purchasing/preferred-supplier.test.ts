import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import { updatePreferredSuppliersForPlacedPurchaseOrder } from '@/lib/domain/purchasing/preferred-supplier'

function txForPurchaseOrder(po: {
  supplierId: string
  supplierName?: string
  reference?: string
  type?: string
  skipPreferredSupplierUpdate?: boolean
  productIds: string[]
  products?: Array<{
    id: string
    sku: string
    preferredSupplierId: string | null
    preferredSupplier: { name: string } | null
  }>
}) {
  const products = po.products ?? Array.from(new Set(po.productIds)).map((productId) => ({
    id: productId,
    sku: productId.toUpperCase(),
    preferredSupplierId: null,
    preferredSupplier: null,
  }))
  const calls: { lockedSql: unknown[]; findManyArgs: unknown[]; updateManyArgs: unknown[]; activityLogs: unknown[] } = {
    lockedSql: [],
    findManyArgs: [],
    updateManyArgs: [],
    activityLogs: [],
  }
  const tx = {
    $queryRaw: async (query: unknown) => {
      calls.lockedSql.push(query)
      return 1
    },
    purchaseOrder: {
      findUnique: async () => ({
        id: 'po-1',
        reference: po.reference ?? 'PO-1',
        supplierId: po.supplierId,
        supplier: { name: po.supplierName ?? 'Supplier 1' },
        type: po.type ?? 'GOODS',
        skipPreferredSupplierUpdate: po.skipPreferredSupplierUpdate ?? false,
        lines: po.productIds.map((productId) => ({ productId })),
      }),
    },
    product: {
      findMany: async (args: unknown) => {
        calls.findManyArgs.push(args)
        return products.filter((product) => product.preferredSupplierId !== po.supplierId)
      },
      updateMany: async (args: unknown) => {
        calls.updateManyArgs.push(args)
        const ids = ((args as { where: { id: { in: string[] } } }).where.id.in)
        return { count: ids.length }
      },
    },
    activityLog: {
      create: async (args: unknown) => {
        calls.activityLogs.push(args)
        return args
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
  assert.equal(calls.findManyArgs.length, 1)
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
  assert.equal(calls.activityLogs.length, 2)
  assert.deepEqual(calls.activityLogs.map((entry) => (entry as { data: { entityId: string } }).data.entityId), ['product-a', 'product-b'])
  assert.deepEqual((calls.activityLogs[0] as { data: { metadata: Record<string, unknown> } }).data.metadata, {
    sku: 'PRODUCT-A',
    previousSupplierId: null,
    previousSupplierName: null,
    newSupplierId: 'supplier-1',
    newSupplierName: 'Supplier 1',
    triggeredByPoId: 'po-1',
    triggeredByPoReference: 'PO-1',
    placedAt: placedAt.toISOString(),
  })
})

test('preferred supplier update skips activity log when supplier is unchanged', async () => {
  const { tx, calls } = txForPurchaseOrder({
    supplierId: 'supplier-1',
    productIds: ['product-a'],
    products: [{
      id: 'product-a',
      sku: 'SKU-A',
      preferredSupplierId: 'supplier-1',
      preferredSupplier: { name: 'Supplier 1' },
    }],
  })

  const result = await updatePreferredSuppliersForPlacedPurchaseOrder(tx, 'po-1', new Date('2026-06-10T10:00:00.000Z'))

  assert.deepEqual(result, { productIds: ['product-a'], updatedCount: 0 })
  assert.equal(calls.updateManyArgs.length, 0)
  assert.equal(calls.activityLogs.length, 0)
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
