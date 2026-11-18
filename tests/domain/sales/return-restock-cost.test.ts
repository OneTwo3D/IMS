import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'

const queued: Array<Record<string, unknown>> = []
mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({ cogsAccount: '5000', inventoryAccount: '1200', connector: 'xero' }),
    queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: Record<string, unknown>) => {
      queued.push(params)
      return { queued: true, connector: 'xero' }
    },
  },
})

const loadModule = () => import('@/lib/domain/sales/return-restock-cost')
const priceUnpricedReturnRows = async (...args: Parameters<Awaited<ReturnType<typeof loadModule>>['priceUnpricedReturnRows']>) =>
  (await loadModule()).priceUnpricedReturnRows(...args)
const queueReturnRestockValueJournal = async (...args: Parameters<Awaited<ReturnType<typeof loadModule>>['queueReturnRestockValueJournal']>) =>
  (await loadModule()).queueReturnRestockValueJournal(...args)

function client(
  layers: Array<{ warehouseId: string; productId: string; remainingQty: number; receivedQty: number; unitCostBase: number }>,
  productType = 'SIMPLE',
) {
  return {
    product: { findUnique: async () => ({ type: productType, sku: 'SKU1', name: 'Thing' }) },
    costLayer: {
      count: async ({ where }: { where: { productId: string } }) => layers.filter((l) => l.productId === where.productId).length,
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

test('a product whose layers all sit at cost 0 restocks at 0 instead of being blocked', async () => {
  const tx = client([{ warehouseId: 'w1', productId: 'p1', remainingQty: 2, receivedQty: 2, unitCostBase: 0 }])
  const rows = await priceUnpricedReturnRows(tx, 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('a NON_INVENTORY product with no layers restocks at 0', async () => {
  const rows = await priceUnpricedReturnRows(client([], 'NON_INVENTORY'), 'w1', [{ productId: 'p1', qty: 1 }])
  assert.equal(Number(rows[0].unitCostBase), 0)
})

test('the refusal advice names a step that works', async () => {
  await assert.rejects(
    () => priceUnpricedReturnRows(client([]), 'w1', [{ productId: 'p1', qty: 1 }]),
    /unit cost first \(use 0 only for genuinely zero-cost stock\)/,
  )
})

const warehouse = { id: 'w1', code: 'MAIN', name: 'Main' }

test('a newly priced row queues the Dr Inventory / Cr COGS journal at the booked value', async () => {
  queued.length = 0
  const original = [{ productId: 'p1', qty: 3 }]
  const priced = [{ productId: 'p1', qty: 3, unitCostBase: 20 }]
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, { inboxId: 'inbox1', warehouse, originalRows: original, pricedRows: priced })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].type, 'INVENTORY_ADJUSTMENT')
  assert.equal(queued[0].referenceId, 'inbox1')
  const lines = (queued[0].payload as { lines: Array<{ accountCode: string; debit?: number; credit?: number }> }).lines
  assert.deepEqual(lines.map((l) => [l.accountCode, l.debit ?? 0, l.credit ?? 0]), [['1200', 60, 0], ['5000', 0, 60]])
})

test('rows an expectation already priced queue no journal here', async () => {
  queued.length = 0
  const rows = [{ productId: 'p1', qty: 1, unitCostBase: 20 }]
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, { inboxId: 'inbox1', warehouse, originalRows: rows, pricedRows: rows })
  assert.equal(queued.length, 0)
})

test('a zero-cost restock queues no journal', async () => {
  queued.length = 0
  await queueReturnRestockValueJournal(client([]) as Prisma.TransactionClient, {
    inboxId: 'inbox1', warehouse, originalRows: [{ productId: 'p1', qty: 1 }], pricedRows: [{ productId: 'p1', qty: 1, unitCostBase: 0 }],
  })
  assert.equal(queued.length, 0)
})
