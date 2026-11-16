import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * PREPARED STOCKTAKES against a real database (app/actions/stock-counts.ts): the product list is chosen up front and stays
 * editable while the count is open.
 *
 *   1. auth: every new action asks for stock_control.adjust FIRST and writes nothing when refused
 *   2. a prepared count holds exactly the chosen products, flagged `prepared`, at their book quantity (0 where there is no stock row)
 *   3. a product cannot be on a count twice: refused by the server (nothing added), by the in-request de-duplication, under a race, and by the database
 *   4. archived and non-stock product types are refused with their SKUs
 *   5. removability: an untouched line goes; a counted line, a reconciled line, and a request containing one, are refused with nothing removed;
 *      clearing the counted quantity makes the line removable again; the last line cannot be removed
 *   6. a posted or cancelled count refuses both edits
 *   7. the whole-warehouse count still snapshots every stocked product and is not flagged prepared
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/stock-count-prepared.test.ts would have been skipped')
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
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const actions = await import('@/app/actions/stock-counts')
  return { db, ...actions }
}

test('prepared stocktakes: choose, edit, refuse', { skip }, async (t) => {
  const { db, createStockCount, createPreparedStockCount, addStockCountLines, removeStockCountLines, searchStockCountProducts, saveStockCountCounts, reconcileStockCount, cancelStockCount } = await setup()
  const RUN = `PSC-${process.pid}-${randomUUID().slice(0, 8)}`
  const warehouse = await db.warehouse.create({ data: { code: RUN, name: RUN, type: 'STANDARD' }, select: { id: true } })
  const mk = async (suffix: string, extra: Record<string, unknown> = {}) =>
    db.product.create({ data: { sku: `${RUN}-${suffix}`, name: `${RUN} ${suffix}`, type: 'SIMPLE', ...extra }, select: { id: true, sku: true } })
  const [a, b, c, d, e] = [await mk('A'), await mk('B'), await mk('C'), await mk('D'), await mk('E')]
  const archived = await mk('ARCH', { lifecycleStatus: 'ARCHIVED' })
  const kit = await mk('KIT', { type: 'KIT' })
  await db.stockLevel.createMany({ data: [{ productId: a.id, warehouseId: warehouse.id, quantity: 10 }, { productId: b.id, warehouseId: warehouse.id, quantity: 4 }] })
  const countIds: string[] = []
  t.after(async () => {
    await db.stockCountLine.deleteMany({ where: { countId: { in: countIds } } })
    await db.stockCount.deleteMany({ where: { id: { in: countIds } } })
    await db.stockLevel.deleteMany({ where: { warehouseId: warehouse.id } })
    await db.product.deleteMany({ where: { sku: { startsWith: RUN } } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
  })
  const lineCount = (countId: string) => db.stockCountLine.count({ where: { countId } })
  const lineOf = async (countId: string, productId: string) => db.stockCountLine.findFirstOrThrow({ where: { countId, productId } })

  await t.test('1. auth: each action asks for stock_control.adjust first and writes nothing when refused', async () => {
    const before = await db.stockCount.count()
    auth.denied = true
    auth.asked = []
    try {
      const calls: Array<() => Promise<unknown>> = [
        () => createPreparedStockCount({ warehouseId: warehouse.id, productIds: [a.id] }),
        () => addStockCountLines({ countId: 'x', productIds: [a.id] }),
        () => removeStockCountLines({ countId: 'x', lineIds: ['y'] }),
        () => searchStockCountProducts({ warehouseId: warehouse.id }),
      ]
      for (const call of calls) await assert.rejects(call, /Forbidden/)
    } finally { auth.denied = false }
    assert.deepEqual(auth.asked, Array(4).fill('stock_control.adjust'))
    assert.equal(await db.stockCount.count(), before, 'nothing was written')
  })

  let prepared: string
  let lines: Record<string, string>
  await t.test('2. a prepared count holds exactly the chosen products at their book quantity', async () => {
    const res = await createPreparedStockCount({ warehouseId: warehouse.id, productIds: [b.id, a.id, a.id, c.id], notes: 'n' })
    assert.ok(res.success && res.count, JSON.stringify(res))
    prepared = res.count!.id
    countIds.push(prepared)
    assert.equal(res.count!.prepared, true)
    assert.equal(res.count!.status, 'DRAFT')
    assert.deepEqual(res.count!.lines.map((l) => [l.sku, l.expectedQty]), [[a.sku, 10], [b.sku, 4], [c.sku, 0]])
    assert.ok(res.count!.lines.every((l) => l.removable))
    lines = Object.fromEntries(res.count!.lines.map((l) => [l.sku, l.id]))
    assert.deepEqual((await createPreparedStockCount({ warehouseId: warehouse.id, productIds: [] })).message, 'Pick at least one product.')
  })

  await t.test('3. a product cannot be on a count twice', async () => {
    const dup = await addStockCountLines({ countId: prepared, productIds: [d.id, a.id] })
    assert.equal(dup.success, undefined)
    assert.match(dup.message!, /^Nothing was added: 1 product\(s\) are already on this count: .*-A/)
    assert.equal(await lineCount(prepared), 3, 'D was not added either: the whole request is refused')

    const ok = await addStockCountLines({ countId: prepared, productIds: [d.id, d.id] })
    assert.ok(ok.success, JSON.stringify(ok))
    assert.equal(await lineCount(prepared), 4, 'a repeated id in one request adds once')

    const race = await Promise.all([addStockCountLines({ countId: prepared, productIds: [e.id] }), addStockCountLines({ countId: prepared, productIds: [e.id] })])
    assert.equal(race.filter((r) => r.success).length, 1, 'one of two simultaneous adds wins')
    assert.equal(race.filter((r) => !r.success).length, 1)
    assert.equal(await db.stockCountLine.count({ where: { countId: prepared, productId: e.id } }), 1)

    await assert.rejects(db.stockCountLine.create({ data: { countId: prepared, productId: a.id, sku: a.sku, expectedQty: 0 } }), { code: 'P2002' }, 'the database refuses it too')

    const search = await searchStockCountProducts({ warehouseId: warehouse.id, countId: prepared, query: RUN })
    const flags = Object.fromEntries(search.rows.map((r) => [r.sku, r.inCount]))
    assert.equal(flags[a.sku], true)
    assert.equal(flags[`${RUN}-KIT`], undefined, 'a kit is not offered')
    assert.equal(flags[`${RUN}-ARCH`], undefined, 'an archived product is not offered by default')
    const archivedOnly = await searchStockCountProducts({ warehouseId: warehouse.id, query: RUN, state: 'ARCHIVED' })
    assert.deepEqual(archivedOnly.rows.map((r) => r.sku), [archived.sku])
  })

  await t.test('4. archived and non-stock product types are refused with their SKUs', async () => {
    const res = await addStockCountLines({ countId: prepared, productIds: [archived.id, kit.id] })
    assert.match(res.message!, /archived/)
    assert.match(res.message!, /not a stocked product type/)
    assert.match(res.message!, new RegExp(archived.sku))
    const created = await createPreparedStockCount({ warehouseId: warehouse.id, productIds: [a.id, kit.id] })
    assert.equal(created.success, undefined)
    assert.match(created.message!, new RegExp(kit.sku))
  })

  await t.test('5. removability', async () => {
    const counted = await saveStockCountCounts({ countId: prepared, counts: [{ lineId: lines[a.sku]!, countedQty: 9 }] })
    assert.ok(counted.success)
    const refusedCounted = await removeStockCountLines({ countId: prepared, lineIds: [lines[a.sku]!, lines[b.sku]!] })
    assert.match(refusedCounted.message!, /^Nothing was removed: 1 product\(s\) can no longer be taken off this count/)
    assert.match(refusedCounted.message!, /-A \(already counted\)/)
    assert.equal(await lineCount(prepared), 5, 'B was not removed either')

    const rec = await reconcileStockCount({ countId: prepared })
    assert.ok(rec.success, JSON.stringify(rec))
    const refusedReconciled = await removeStockCountLines({ countId: prepared, lineIds: [lines[a.sku]!] })
    assert.match(refusedReconciled.message!, /already counted and reconciled/)

    // Clearing the figure (which drops the reconcile stamp) makes the line removable again.
    assert.ok((await saveStockCountCounts({ countId: prepared, counts: [{ lineId: lines[a.sku]!, countedQty: null }] })).success)
    const a2 = await lineOf(prepared, a.id)
    assert.equal(a2.countedQty, null)
    assert.equal(a2.reconciledQty, null)

    const gone = await removeStockCountLines({ countId: prepared, lineIds: [lines[b.sku]!, lines[a.sku]!] })
    assert.ok(gone.success, JSON.stringify(gone))
    assert.deepEqual(gone.count!.lines.map((l) => l.sku).sort(), [c.sku, d.sku, e.sku].sort())
    assert.match((await removeStockCountLines({ countId: prepared, lineIds: ['not-a-line'] })).message!, /not on this count any more/)

    const rest = gone.count!.lines.map((l) => l.id)
    const last = await removeStockCountLines({ countId: prepared, lineIds: rest })
    assert.match(last.message!, /needs at least one product/)
    assert.equal(await lineCount(prepared), 3)
  })

  await t.test('6. a cancelled count refuses both edits', async () => {
    assert.ok((await cancelStockCount(prepared)).success)
    assert.match((await addStockCountLines({ countId: prepared, productIds: [b.id] })).message!, /cancelled/)
    const someLine = (await db.stockCountLine.findFirstOrThrow({ where: { countId: prepared } })).id
    assert.match((await removeStockCountLines({ countId: prepared, lineIds: [someLine] })).message!, /cancelled/)
    assert.equal(await lineCount(prepared), 3)
  })

  await t.test('7. the whole-warehouse count still snapshots every stocked product', async () => {
    const res = await createStockCount({ warehouseId: warehouse.id })
    assert.ok(res.success && res.count, JSON.stringify(res))
    countIds.push(res.count!.id)
    assert.equal(res.count!.prepared, false)
    assert.deepEqual(res.count!.lines.map((l) => l.sku), [a.sku, b.sku])
    // A whole-warehouse count's open list can be edited the same way.
    const added = await addStockCountLines({ countId: res.count!.id, productIds: [c.id] })
    assert.ok(added.success)
    assert.equal(added.count!.lines.length, 3)
  })
})
