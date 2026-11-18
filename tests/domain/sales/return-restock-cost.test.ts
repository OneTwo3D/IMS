import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import { priceUnpricedReturnRows } from '@/lib/domain/sales/return-restock-cost'

function client(layers: Array<{ warehouseId: string; productId: string; remainingQty: number; receivedQty: number; unitCostBase: number }>) {
  return {
    costLayer: {
      findMany: async ({ where }: { where: { productId: string; warehouseId?: string; remainingQty?: unknown } }) =>
        layers.filter((l) =>
          l.productId === where.productId
          && (where.warehouseId == null || l.warehouseId === where.warehouseId)
          && (where.remainingQty == null || l.remainingQty > 0)),
    },
  } as unknown as Prisma.TransactionClient
}

test('an unpriced row takes the warehouse average cost', async () => {
  const tx = client([
    { warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 4 },
    { warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 6 },
  ])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 5)
})

test('with no stock in the warehouse it falls back to the historical average', async () => {
  const tx = client([{ warehouseId: 'w2', productId: 'p1', remainingQty: 0, receivedQty: 3, unitCostBase: 7 }])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 7)
})

test('a row that already carries a cost is left alone', async () => {
  const rows = await priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1, unitCostBase: 0 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('no cost basis anywhere refuses rather than restocking at zero', async () => {
  await assert.rejects(() => priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1 }]), /no unit cost could be derived/)
})
