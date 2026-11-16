import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * A PREPARED COUNT LINE WITH NO STOCK ROW vs A RECEIPT THAT CREATES THE ROW WHILE THE POST RUNS (app/actions/stock-counts.ts).
 * Reconcile and post materialise the zero row and lock it before reading live on-hand, so a receipt committing in between is seen
 * as drift and the post is refused. Without that, the post reads 0, the receipt's row appears, and the adjustment adds to the
 * receipt: on-hand ends at receipt + counted.
 * Mutation: drop materialiseStockRowsTx from postStockCount -> on-hand ends at 8 and the post succeeds.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

test('a receipt creating the stock row during the post is seen as drift, not added to the count', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createPreparedStockCount, saveStockCountCounts, reconcileStockCount, postStockCount } = await import('@/app/actions/stock-counts')
  const tag = `PMR-${process.pid}-${randomUUID().slice(0, 8)}`
  const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, type: 'STANDARD' }, select: { id: true } })
  const product = await db.product.create({ data: { sku: tag, name: tag, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const created = await createPreparedStockCount({ warehouseId: warehouse.id, productIds: [product.id] })
  assert.ok(created.success && created.count, JSON.stringify(created))
  const countId = created.count!.id
  const lineId = created.count!.lines[0]!.id
  t.after(async () => {
    const movements = await db.stockMovement.findMany({ where: { productId: product.id }, select: { id: true } })
    await db.cogsEntry.deleteMany({ where: { movementId: { in: movements.map((m) => m.id) } } })
    await db.costLayer.deleteMany({ where: { productId: product.id } })
    await db.stockMovement.deleteMany({ where: { productId: product.id } })
    await db.stockCountLine.deleteMany({ where: { countId } })
    await db.stockCount.deleteMany({ where: { id: countId } })
    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.product.deleteMany({ where: { id: product.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
  })

  assert.equal(await db.stockLevel.count({ where: { productId: product.id } }), 0, 'PRECONDITION: no stock row')
  assert.ok((await saveStockCountCounts({ countId, counts: [{ lineId, countedQty: 3 }] })).success)
  assert.ok((await reconcileStockCount({ countId })).success)
  // Reconcile materialised the zero row; remove it again so the POST is what meets an absent row.
  assert.equal((await db.stockLevel.deleteMany({ where: { productId: product.id } })).count, 1)

  // A receipt creates the row and holds its transaction open while the post starts.
  let releaseReceipt!: () => void
  const gate = new Promise<void>((resolve) => { releaseReceipt = resolve })
  let receiptInserted!: () => void
  const inserted = new Promise<void>((resolve) => { receiptInserted = resolve })
  const receipt = db.$transaction(async (tx) => {
    await tx.stockLevel.upsert({
      where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
      create: { productId: product.id, warehouseId: warehouse.id, quantity: 5 },
      update: { quantity: { increment: 5 } },
    })
    await tx.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: 5, remainingQty: 5, unitCostBase: 2, receivedAt: new Date() } })
    receiptInserted()
    await gate
  }, { timeout: 30000 })
  await inserted

  const post = postStockCount({ countId })
  await new Promise((r) => setTimeout(r, 750)) // let the post reach the stock-row step and wait on the receipt
  releaseReceipt()
  await receipt
  const res = await post

  const level = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } } })
  assert.equal(res.success, undefined, `the post must be refused, got ${JSON.stringify(res)}`)
  assert.equal(res.drift?.length, 1)
  assert.equal(res.drift![0]!.currentOnHand, 5)
  assert.equal(Number(level.quantity), 5, 'on-hand is the receipt alone: the count was not added on top')
  assert.equal(await db.stockMovement.count({ where: { productId: product.id } }), 0, 'no adjustment was posted')
})
