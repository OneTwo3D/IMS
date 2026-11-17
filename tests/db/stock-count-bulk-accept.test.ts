import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * BULK ACCEPT BY VARIANCE TRIAGE against a real database (app/actions/stock-counts.ts: bulkAcceptStockCountLines).
 *
 *   1. permission: every new action asks for stock_control.adjust first and writes nothing when refused
 *   2. NO_VARIANCE accepts only the lines whose saved count equals live on-hand; posts no movement; leaves stock untouched
 *   3. a count changed, or stock moved, between page load and commit drops the line from the accept
 *   4. SMALL_VARIANCE needs the explicit confirmation and a configured threshold, and accepts only small lines
 *   5. a small-variance line accepted in bulk posts the same movement and COGS as the same line accepted singly
 *   6. the activity entry records the mode and how many lines were accepted / excluded
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/stock-count-bulk-accept.test.ts would have been skipped')
}

const auth = { denied: false, asked: [] as string[] }
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      auth.asked.push(permission)
      if (auth.denied) throw new Error('Forbidden')
      return { user: { id: 'u1', role: 'ADMIN' } }
    },
    requireFreshPermission: async () => ({ user: { id: 'u1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => undefined } })
const activity: Array<{ action: string; description: string; metadata?: Record<string, unknown> | null }> = []
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (p: { action: string; description: string; metadata?: Record<string, unknown> | null }) => { activity.push(p) } },
})

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const actions = await import('@/app/actions/stock-counts')
  return { db, ...actions }
}

test('bulk accept by variance triage', { skip }, async (t) => {
  const { db, createStockCount, saveStockCountCounts, reconcileStockCount, postStockCount, bulkAcceptStockCountLines, saveStockCountSmallVarianceThreshold, getStockCountSmallVarianceThreshold } = await setup()
  const RUN = `BAC-${process.pid}-${randomUUID().slice(0, 8)}`
  const warehouseIds: string[] = []
  const productIds: string[] = []
  const countIds: string[] = []
  t.after(async () => {
    const movements = await db.stockMovement.findMany({ where: { productId: { in: productIds } }, select: { id: true } })
    await db.cogsEntry.deleteMany({ where: { movementId: { in: movements.map((m) => m.id) } } })
    await db.stockMovement.deleteMany({ where: { productId: { in: productIds } } })
    await db.costLayer.deleteMany({ where: { productId: { in: productIds } } })
    await db.stockCountLine.deleteMany({ where: { countId: { in: countIds } } })
    await db.stockCount.deleteMany({ where: { id: { in: countIds } } })
    await db.stockLevel.deleteMany({ where: { warehouseId: { in: warehouseIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.warehouse.deleteMany({ where: { id: { in: warehouseIds } } })
    await db.setting.deleteMany({ where: { key: { in: ['stock_count_small_variance_qty', 'stock_count_small_variance_pct'] } } })
  })

  /** A warehouse holding one costed product per entry of `books`, snapshotted into a count. */
  async function seed(label: string, books: number[]) {
    const tag = `${RUN}-${label}`
    const warehouse = await db.warehouse.create({ data: { code: tag, name: tag, type: 'STANDARD' }, select: { id: true } })
    warehouseIds.push(warehouse.id)
    const products: Array<{ id: string; sku: string }> = []
    for (const [i, book] of books.entries()) {
      const p = await db.product.create({ data: { sku: `${tag}-${i}`, name: `${tag}-${i}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true, sku: true } })
      productIds.push(p.id)
      products.push(p)
      await db.stockLevel.create({ data: { productId: p.id, warehouseId: warehouse.id, quantity: book } })
      await db.costLayer.create({ data: { productId: p.id, warehouseId: warehouse.id, receivedQty: book, remainingQty: book, unitCostBase: 2, receivedAt: new Date(Date.now() - 60_000) } })
    }
    const created = await createStockCount({ warehouseId: warehouse.id })
    assert.ok(created.success && created.count, `PRECONDITION: count created: ${JSON.stringify(created)}`)
    countIds.push(created.count!.id)
    const lineOf = (i: number) => created.count!.lines.find((l) => l.sku === products[i]!.sku)!.id
    return { warehouseId: warehouse.id, countId: created.count!.id, products, lineOf }
  }
  const movementCount = (productId: string) => db.stockMovement.count({ where: { productId } })
  const lineRow = (id: string) => db.stockCountLine.findUniqueOrThrow({ where: { id } })
  const onHand = async (productId: string, warehouseId: string) => Number((await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } })).quantity)

  await t.test('1. permission: each new action asks for stock_control.adjust first and writes nothing when refused', async () => {
    const f = await seed('auth', [10])
    await saveStockCountCounts({ countId: f.countId, counts: [{ lineId: f.lineOf(0), countedQty: 10 }] })
    auth.denied = true
    auth.asked = []
    try {
      const calls: Array<() => Promise<unknown>> = [
        () => bulkAcceptStockCountLines({ countId: f.countId, mode: 'NO_VARIANCE', lineIds: [f.lineOf(0)] }),
        () => saveStockCountSmallVarianceThreshold({ qty: 5, pct: 5 }),
        () => getStockCountSmallVarianceThreshold(),
      ]
      for (const call of calls) await assert.rejects(call, /Forbidden/)
      assert.deepEqual(auth.asked, ['stock_control.adjust', 'stock_control.adjust', 'stock_control.adjust'])
    } finally {
      auth.denied = false
    }
    assert.equal((await lineRow(f.lineOf(0))).reconciledQty, null, 'a refused bulk accept stamps nothing')
    assert.equal(await db.setting.count({ where: { key: { startsWith: 'stock_count_small_variance' } } }), 0, 'a refused threshold save writes nothing')
    assert.deepEqual(await getStockCountSmallVarianceThreshold(), { qty: 0, pct: 0 }, 'the default threshold is 0: nothing is small')
  })

  await t.test('2. NO_VARIANCE accepts only exact-zero lines, books nothing, and records who/how many', async () => {
    const f = await seed('zero', [10, 5, 10, 8, 10])
    await saveStockCountCounts({
      countId: f.countId,
      counts: [
        { lineId: f.lineOf(0), countedQty: 10 }, // zero
        { lineId: f.lineOf(1), countedQty: 5 }, // zero
        { lineId: f.lineOf(2), countedQty: 8 }, // variance -2
        // line 3 never counted
        { lineId: f.lineOf(4), countedQty: 10.0001 }, // variance 0.0001: tiny but not zero
      ],
    })
    activity.length = 0
    const res = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'NO_VARIANCE', lineIds: [0, 1, 2, 3, 4].map(f.lineOf) })
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal(res.accepted, 2)
    assert.equal(res.excluded, 3)
    for (const i of [0, 1]) {
      const l = await lineRow(f.lineOf(i))
      assert.notEqual(l.reconciledQty, null, `line ${i} is stamped`)
      assert.equal(Number(l.variance), 0)
    }
    for (const i of [2, 3, 4]) assert.equal((await lineRow(f.lineOf(i))).reconciledQty, null, `line ${i} is untouched`)
    for (const [i, book] of [[0, 10], [1, 5], [2, 10], [3, 8], [4, 10]] as const) {
      assert.equal(await movementCount(f.products[i]!.id), 0, 'no movement is posted for any line')
      assert.equal(await onHand(f.products[i]!.id, f.warehouseId), book, 'stock is untouched')
    }
    const entry = activity.find((a) => a.action === 'bulk_accepted')
    assert.ok(entry, 'an activity entry is written')
    assert.equal(entry!.metadata?.accepted, 2)
    assert.equal(entry!.metadata?.excluded, 3)
    assert.equal(entry!.metadata?.mode, 'NO_VARIANCE')
    assert.match(entry!.description, /Bulk-accepted 2 no-variance line/)
    // The reconcile stamp is the same one a single accept writes: authorising now refuses only because the other counted lines are unreconciled.
    const refused = await postStockCount({ countId: f.countId })
    assert.equal(refused.success, undefined)
    assert.deepEqual(refused.drift?.map((d) => d.sku).sort(), [f.products[2]!.sku, f.products[4]!.sku].sort())
  })

  await t.test('3. a count changed, or stock moved, after page load drops the line from the accept', async () => {
    const f = await seed('race', [10, 10, 10])
    await saveStockCountCounts({ countId: f.countId, counts: [0, 1, 2].map((i) => ({ lineId: f.lineOf(i), countedQty: 10 })) })
    const pageLoadLineIds = [0, 1, 2].map(f.lineOf) // the page saw three no-variance lines
    await saveStockCountCounts({ countId: f.countId, counts: [{ lineId: f.lineOf(1), countedQty: 7 }] }) // someone recounts line 1
    await db.stockLevel.update({ where: { productId_warehouseId: { productId: f.products[2]!.id, warehouseId: f.warehouseId } }, data: { quantity: 11 } }) // stock moves under line 2
    const res = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'NO_VARIANCE', lineIds: pageLoadLineIds })
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal(res.accepted, 1)
    assert.equal(res.excluded, 2)
    assert.notEqual((await lineRow(f.lineOf(0))).reconciledQty, null)
    assert.equal((await lineRow(f.lineOf(1))).reconciledQty, null, 'the recounted line is excluded')
    assert.equal((await lineRow(f.lineOf(2))).reconciledQty, null, 'the line whose stock moved is excluded')
    // A line id that is not on this count at all is excluded, not accepted.
    const other = await seed('other', [3])
    await saveStockCountCounts({ countId: other.countId, counts: [{ lineId: other.lineOf(0), countedQty: 3 }] })
    const foreign = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'NO_VARIANCE', lineIds: [other.lineOf(0)] })
    assert.equal(foreign.accepted, 0)
    assert.equal((await lineRow(other.lineOf(0))).reconciledQty, null)
  })

  await t.test('4. SMALL_VARIANCE needs the confirmation and a threshold, and takes only small lines', async () => {
    const f = await seed('small', [10, 10, 10])
    await saveStockCountCounts({
      countId: f.countId,
      counts: [{ lineId: f.lineOf(0), countedQty: 9 }, { lineId: f.lineOf(1), countedQty: 4 }, { lineId: f.lineOf(2), countedQty: 10 }],
    })
    const ids = [0, 1, 2].map(f.lineOf)
    const unconfirmed = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'SMALL_VARIANCE', lineIds: ids })
    assert.equal(unconfirmed.success, undefined)
    assert.match(unconfirmed.message ?? '', /explicit confirmation/)
    const noThreshold = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'SMALL_VARIANCE', lineIds: ids, confirmSmallVariance: true })
    assert.equal(noThreshold.success, undefined, 'with the default threshold nothing is small')
    assert.match(noThreshold.message ?? '', /No small-variance threshold/)
    for (const i of [0, 1, 2]) assert.equal((await lineRow(f.lineOf(i))).reconciledQty, null)

    assert.deepEqual(await saveStockCountSmallVarianceThreshold({ qty: '2', pct: '' }), { success: true, threshold: { qty: 2, pct: 0 } })
    assert.deepEqual(await getStockCountSmallVarianceThreshold(), { qty: 2, pct: 0 })
    assert.equal((await saveStockCountSmallVarianceThreshold({ qty: -1 })).success, undefined)
    const res = await bulkAcceptStockCountLines({ countId: f.countId, mode: 'SMALL_VARIANCE', lineIds: ids, confirmSmallVariance: true })
    assert.equal(res.success, true, JSON.stringify(res))
    assert.equal(res.accepted, 1, 'only the -1 line is small')
    assert.notEqual((await lineRow(f.lineOf(0))).reconciledQty, null)
    assert.equal((await lineRow(f.lineOf(1))).reconciledQty, null, '-6 needs review')
    assert.equal((await lineRow(f.lineOf(2))).reconciledQty, null, 'a zero line is not a small-variance line')
    for (const i of [0, 1, 2]) assert.equal(await movementCount(f.products[i]!.id), 0, 'accepting books nothing')
    assert.ok(activity.some((a) => a.action === 'bulk_accepted' && a.metadata?.mode === 'SMALL_VARIANCE' && a.metadata?.thresholdQty === 2 && a.metadata?.confirmed === true))
  })

  await t.test('5. a small-variance line accepted in bulk posts the same movement and COGS as one accepted singly', async () => {
    const bulk = await seed('twin-bulk', [10])
    const single = await seed('twin-single', [10])
    for (const f of [bulk, single]) await saveStockCountCounts({ countId: f.countId, counts: [{ lineId: f.lineOf(0), countedQty: 9 }] })
    await saveStockCountSmallVarianceThreshold({ qty: 2, pct: 0 })
    const b = await bulkAcceptStockCountLines({ countId: bulk.countId, mode: 'SMALL_VARIANCE', lineIds: [bulk.lineOf(0)], confirmSmallVariance: true })
    assert.equal(b.accepted, 1)
    assert.equal((await reconcileStockCount({ countId: single.countId })).success, true)
    const lb = await lineRow(bulk.lineOf(0))
    const ls = await lineRow(single.lineOf(0))
    assert.deepEqual([Number(lb.reconciledQty), Number(lb.expectedQty), Number(lb.variance)], [Number(ls.reconciledQty), Number(ls.expectedQty), Number(ls.variance)], 'the line is written identically')
    for (const f of [bulk, single]) assert.equal((await postStockCount({ countId: f.countId })).success, true)
    const shape = async (f: typeof bulk) => {
      const ms = await db.stockMovement.findMany({ where: { productId: f.products[0]!.id }, select: { id: true, type: true, qty: true, unitCostBase: true, totalValueBase: true } })
      const cogs = await db.cogsEntry.findMany({ where: { movementId: { in: ms.map((m) => m.id) } }, select: { qty: true, unitCostBase: true, totalCostBase: true } })
      return { movements: ms.map((m) => [m.type, Number(m.qty), m.unitCostBase == null ? null : Number(m.unitCostBase), m.totalValueBase == null ? null : Number(m.totalValueBase)]), cogs: cogs.map((c) => [Number(c.qty), Number(c.unitCostBase), Number(c.totalCostBase)]), onHand: await onHand(f.products[0]!.id, f.warehouseId) }
    }
    const sb = await shape(bulk)
    const ss = await shape(single)
    assert.equal(sb.movements.length, 1)
    assert.deepEqual(sb, ss)
    assert.equal(sb.onHand, 9)
  })
})
