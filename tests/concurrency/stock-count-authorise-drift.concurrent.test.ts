import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * AUTHORISING A STOCK COUNT REFUSES WHEN ON-HAND MOVED SINCE THE COUNT WAS RECONCILED (app/actions/stock-counts.ts).
 *
 *   1. a count that was never reconciled is refused: nothing posted, counts kept
 *   2. CONTROL: reconcile then authorise posts, and on-hand ends at the counted figure
 *   3. stock moves between reconcile and authorise: refused with the earlier and current on-hand, the counted figure and the revised
 *      variance; nothing posted; reconciling again refreshes the lines and the next authorise posts
 *   4. a counted figure changed after the reconcile needs a new reconcile
 *   5. THE RACE: a movement holding the stock-level lock when the authorise arrives commits first; the authorise, which waits on the lock, reads the moved figure and refuses
 *   6. two authorises at once post once
 * Real Postgres, the real locks. Mutation: drop the in-lock comparison from the post -> arms 1, 3, 4, 5 post; drop the stamp from the reconcile -> arm 2 is refused.
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
const stockSyncs: string[][] = []
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: string[]) => { stockSyncs.push(ids) } } })

type Fx = { warehouseId: string; productId: string; sku: string; layerId: string; countId: string; lineId: string; cleanup: () => Promise<void> }

test('authorising a stock count refuses when on-hand moved since the reconcile', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { createStockCount, saveStockCountCounts, reconcileStockCount, postStockCount } = await import('@/app/actions/stock-counts')
  const RUN_ID = `SCD-${process.pid}-${randomUUID().slice(0, 8)}`

  async function seed(label: string, onHand = 10): Promise<Fx> {
    const tag = `${RUN_ID}-${label}`
    const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, type: 'STANDARD' }, select: { id: true } })
    const product = await db.product.create({ data: { sku: tag, name: tag, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: onHand } })
    const layer = await db.costLayer.create({
      data: { productId: product.id, warehouseId: warehouse.id, receivedQty: onHand, remainingQty: onHand, unitCostBase: 2, receivedAt: new Date(Date.now() - 60_000) },
      select: { id: true },
    })
    const created = await createStockCount({ warehouseId: warehouse.id })
    assert.ok(created.success && created.count, `PRECONDITION: the count is created: ${JSON.stringify(created)}`)
    const line = created.count!.lines[0]!
    return {
      warehouseId: warehouse.id, productId: product.id, sku: tag, layerId: layer.id, countId: created.count!.id, lineId: line.id,
      cleanup: async () => {
        const movements = await db.stockMovement.findMany({ where: { productId: product.id }, select: { id: true } })
        await db.cogsEntry.deleteMany({ where: { movementId: { in: movements.map((m) => m.id) } } })
        await db.costLayer.deleteMany({ where: { productId: product.id } })
        await db.stockMovement.deleteMany({ where: { productId: product.id } })
        await db.stockCountLine.deleteMany({ where: { countId: created.count!.id } })
        await db.stockCount.deleteMany({ where: { id: created.count!.id } })
        await db.stockLevel.deleteMany({ where: { productId: product.id } })
        await db.product.deleteMany({ where: { id: product.id } })
        await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      },
    }
  }
  const onHand = async (f: Fx) => Number((await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } } })).quantity)
  const movements = (f: Fx) => db.stockMovement.count({ where: { productId: f.productId } })
  /** A sale-like movement: on-hand and the layer drop together. */
  async function moveStock(f: Fx, delta: number) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_levels WHERE "productId" = ${f.productId} AND "warehouseId" = ${f.warehouseId} FOR UPDATE`
      await tx.stockLevel.update({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } }, data: { quantity: { increment: delta } } })
      await tx.costLayer.update({ where: { id: f.layerId }, data: { remainingQty: { increment: delta }, receivedQty: { increment: delta > 0 ? delta : 0 } } })
    })
  }
  const countedLine = (f: Fx, qty: number | null) => ({ lineId: f.lineId, countedQty: qty })

  await t.test('1. never reconciled: refused, nothing posted, the counts are kept', async (tt) => {
    const f = await seed('never')
    tt.after(f.cleanup)
    const res = await postStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })
    assert.equal(res.success, undefined)
    assert.equal(res.drift?.length, 1)
    assert.equal(res.drift![0]!.earlierOnHand, null)
    assert.equal(res.drift![0]!.currentOnHand, 10)
    assert.equal(res.drift![0]!.revisedVariance, -2)
    assert.match(res.message ?? '', /not reconciled/)
    assert.equal(await onHand(f), 10)
    assert.equal(await movements(f), 0)
    const count = await db.stockCount.findUniqueOrThrow({ where: { id: f.countId }, select: { status: true, lines: { select: { countedQty: true } } } })
    assert.notEqual(count.status, 'COMPLETED')
    assert.equal(Number(count.lines[0]!.countedQty), 8, 'the count entered with the refused authorise is kept')
  })

  await t.test('2. control: reconcile then authorise posts, and on-hand ends at the counted figure', async (tt) => {
    const f = await seed('ok')
    tt.after(f.cleanup)
    const rec = await reconcileStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })
    assert.equal(rec.success, true, JSON.stringify(rec))
    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })
    assert.equal(Number(line.reconciledQty), 10, 'the stamp is the live on-hand')
    assert.equal(Number(line.variance), -2)
    const stamped = await db.stockCount.findUniqueOrThrow({ where: { id: f.countId }, select: { reconciledAt: true, status: true } })
    assert.ok(stamped.reconciledAt)
    assert.equal(stamped.status, 'IN_PROGRESS')
    const res = await postStockCount({ countId: f.countId })
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal(await onHand(f), 8)
    assert.equal(await movements(f), 1)
    assert.equal((await db.stockCount.findUniqueOrThrow({ where: { id: f.countId } })).status, 'COMPLETED')
  })

  await t.test('3. stock moved after the reconcile: refused with the figures; re-reconcile refreshes; the next authorise posts', async (tt) => {
    const f = await seed('moved')
    tt.after(f.cleanup)
    assert.equal((await reconcileStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })).success, true)
    await moveStock(f, -3) // 10 -> 7
    const refused = await postStockCount({ countId: f.countId })
    assert.equal(refused.success, undefined)
    assert.deepEqual(
      refused.drift?.map((d) => [d.sku, d.earlierOnHand, d.currentOnHand, d.countedQty, d.revisedVariance]),
      [[f.sku, 10, 7, 8, 1]],
    )
    assert.match(refused.message ?? '', /was 10, now 7, counted 8, revised variance 1/)
    assert.equal(await onHand(f), 7, 'nothing was posted')
    assert.equal(await movements(f), 0)
    assert.equal(Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })).countedQty), 8, 'the count is preserved')
    const again = await reconcileStockCount({ countId: f.countId })
    assert.equal(again.success, true)
    assert.deepEqual(again.drift?.map((d) => [d.earlierOnHand, d.currentOnHand]), [[10, 7]], 'the reconcile reports what moved')
    const line = await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })
    assert.equal(Number(line.reconciledQty), 7)
    assert.equal(Number(line.variance), 1)
    const ok = await postStockCount({ countId: f.countId })
    assert.equal(ok.success, true, JSON.stringify(ok))
    assert.equal(await onHand(f), 8)
  })

  await t.test('4. a counted figure changed after the reconcile needs a new reconcile; re-submitting the same figure does not', async (tt) => {
    const f = await seed('edit')
    tt.after(f.cleanup)
    assert.equal((await reconcileStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })).success, true)
    assert.equal((await saveStockCountCounts({ countId: f.countId, counts: [countedLine(f, 8)] })).success, true)
    assert.equal(Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })).reconciledQty), 10, 'saving the same figure keeps the stamp')
    assert.equal((await saveStockCountCounts({ countId: f.countId, counts: [countedLine(f, 9)] })).success, true)
    assert.equal((await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })).reconciledQty, null, 'a new figure clears the stamp')
    const refused = await postStockCount({ countId: f.countId })
    assert.equal(refused.drift?.[0]?.earlierOnHand, null)
    assert.equal(await movements(f), 0)
    // reconciled again at 9, then the authorise call itself carries a different figure: the stamp is valid for 9 and not for 7
    assert.equal((await reconcileStockCount({ countId: f.countId })).success, true)
    assert.equal(Number((await db.stockCountLine.findUniqueOrThrow({ where: { id: f.lineId } })).reconciledQty), 10)
    const inline = await postStockCount({ countId: f.countId, counts: [countedLine(f, 7)] })
    assert.equal(inline.drift?.length, 1, 'a figure changed inside the authorise call is refused too')
    assert.equal(inline.drift?.[0]?.earlierOnHand, null)
    assert.equal(await movements(f), 0)
    assert.equal(await onHand(f), 10)
  })

  await t.test('5. the race: a movement holding the stock-level lock commits before the waiting authorise reads on-hand', async (tt) => {
    for (let round = 0; round < 3; round++) {
      const f = await seed(`race${round}`)
      tt.after(f.cleanup)
      assert.equal((await reconcileStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })).success, true)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      let locked: () => void = () => {}
      const lockTaken = new Promise<void>((resolve) => { locked = resolve })
      const mover = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM stock_levels WHERE "productId" = ${f.productId} AND "warehouseId" = ${f.warehouseId} FOR UPDATE`
        locked()
        await held
        await tx.stockLevel.update({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } }, data: { quantity: { decrement: 3 } } })
        await tx.costLayer.update({ where: { id: f.layerId }, data: { remainingQty: { decrement: 3 } } })
      }, { timeout: 30_000 })
      await lockTaken
      const posting = postStockCount({ countId: f.countId })
      // the authorise is waiting on the stock-level lock (it holds the count row lock and is blocked behind the mover)
      for (let i = 0; i < 100; i++) {
        const waiting = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`
        if (Number(waiting[0]!.n) > 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
      release()
      await mover
      const res = await posting
      assert.equal(res.success, undefined, `round ${round}: ${JSON.stringify(res)}`)
      assert.deepEqual(res.drift?.map((d) => [d.earlierOnHand, d.currentOnHand]), [[10, 7]])
      assert.equal(await movements(f), 0)
      assert.equal(await onHand(f), 7)
    }
  })

  await t.test('6. two authorises at once post once', async (tt) => {
    const f = await seed('double')
    tt.after(f.cleanup)
    assert.equal((await reconcileStockCount({ countId: f.countId, counts: [countedLine(f, 8)] })).success, true)
    const results = await Promise.all([postStockCount({ countId: f.countId }), postStockCount({ countId: f.countId })])
    assert.equal(results.filter((r) => r.success).length, 1, JSON.stringify(results))
    assert.equal(await movements(f), 1)
    assert.equal(await onHand(f), 8)
  })
})
