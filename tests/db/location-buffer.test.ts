import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * LOCATION BUFFER against a real database: the migration (default 0, non-negative CHECK) and the save path
 * (app/actions/location-buffer.ts): stock_levels row, audit row, push enqueue. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/location-buffer.test.ts would have been skipped')
}

const auth = { denied: false }
const enqueued: string[][] = []
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => {
      if (auth.denied) throw new Error('Forbidden')
      return { user: { id: null, role: 'ADMIN' } }
    },
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: string[]) => { enqueued.push(ids) } } })

test('location buffer: migration and save path on a real database', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { saveLocationBuffers, getLocationBuffers } = await import('@/app/actions/location-buffer')
  const RUN = `LB-${process.pid}-${randomUUID().slice(0, 8)}`
  const w1 = await db.warehouse.create({ data: { code: `${RUN}-1`, name: RUN, type: 'STANDARD', syncToStore: true }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${RUN}-2`, name: RUN, type: 'STANDARD' }, select: { id: true } })
  const product = await db.product.create({ data: { sku: RUN, name: RUN, type: 'SIMPLE' }, select: { id: true } })
  const kit = await db.product.create({ data: { sku: `${RUN}-KIT`, name: RUN, type: 'KIT' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: w1.id, quantity: 10, reservedQty: 2 } })
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { entityId: { in: [product.id, kit.id] } } })
    await db.locationStockBuffer.deleteMany({ where: { productId: product.id } })
    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.product.deleteMany({ where: { id: { in: [product.id, kit.id] } } })
    await db.warehouse.deleteMany({ where: { id: { in: [w1.id, w2.id] } } })
  })

  const buffer = (warehouseId: string) => db.locationStockBuffer.findUnique({ where: { productId_warehouseId: { productId: product.id, warehouseId } } })
  const E = (warehouseId: string, expectedOld: string, bufferQty: string) => ({ warehouseId, expectedOld, bufferQty })

  await t.test('no buffer rows exist for a product by default (every existing product pushes as before)', async () => {
    assert.equal(await db.locationStockBuffer.count({ where: { productId: product.id } }), 0)
  })

  await t.test('the database refuses a negative buffer', async () => {
    await assert.rejects(
      db.$executeRaw`INSERT INTO location_stock_buffers (id, "productId", "warehouseId", "bufferQty", "updatedAt") VALUES (${randomUUID()}, ${product.id}, ${w1.id}, -1, now())`,
      /location_stock_buffers_buffer_qty_check|check constraint/i,
    )
  })

  await t.test('save: sets the buffer, leaves on-hand and reserved alone, audits with the reason, enqueues one push', async () => {
    const result = await saveLocationBuffers(product.id, [E(w1.id, '', '3.5')], 'Keep back for the trade show')
    assert.deepEqual(result, { success: true, changed: 1, stale: [] })
    assert.equal((await buffer(w1.id))!.bufferQty.toString(), '3.5')
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w1.id } })
    assert.deepEqual([row.quantity.toString(), row.reservedQty.toString()], ['10', '2'])
    assert.equal(await buffer(w2.id), null, 'an untouched warehouse gets no row')
    const audit = await db.activityLog.findMany({ where: { entityId: product.id, action: 'location_buffer_changed' } })
    assert.equal(audit.length, 1)
    assert.match(audit[0]!.description, /Keep back for the trade show/)
    assert.deepEqual(audit[0]!.metadata, { sku: RUN, warehouseId: w1.id, warehouseCode: `${RUN}-1`, oldValue: '0', newValue: '3.5', reason: 'Keep back for the trade show' })
    assert.deepEqual(enqueued, [[product.id]])
  })

  await t.test('a buffer at a warehouse with NO stock row creates NO stock_levels row', async () => {
    assert.deepEqual(await saveLocationBuffers(product.id, [E(w2.id, '', '4')], 'B2B reserve'), { success: true, changed: 1, stale: [] })
    assert.equal((await buffer(w2.id))!.bufferQty.toString(), '4')
    assert.equal(await db.stockLevel.count({ where: { productId: product.id, warehouseId: w2.id } }), 0)
    const alone = await db.product.create({ data: { sku: `${RUN}-ALONE`, name: RUN, type: 'SIMPLE' }, select: { id: true } })
    try {
      assert.equal((await saveLocationBuffers(alone.id, [E(w1.id, '', '2')], 'x')).success, true)
      assert.equal(await db.stockLevel.count({ where: { productId: alone.id } }), 0, 'the first buffer of a never-stocked product creates no stock row')
    } finally {
      await db.activityLog.deleteMany({ where: { entityId: alone.id } })
      await db.product.delete({ where: { id: alone.id } })
    }
  })

  await t.test('save: a STALE cell is refused, the other cell saves, an untouched warehouse is not written', async () => {
    enqueued.length = 0
    // the page loaded w1 = 3.5 and w2 = 4; someone moved w1 to 9 meanwhile
    await db.locationStockBuffer.update({ where: { productId_warehouseId: { productId: product.id, warehouseId: w1.id } }, data: { bufferQty: 9 } })
    const before = await buffer(w2.id)
    const result = await saveLocationBuffers(product.id, [E(w1.id, '3.5', '1'), E(w2.id, '4', '6')], 'rebalance')
    assert.deepEqual(result, { success: true, changed: 1, stale: [`${RUN}-1`] })
    assert.equal((await buffer(w1.id))!.bufferQty.toString(), '9')
    assert.equal((await buffer(w2.id))!.bufferQty.toString(), '6')
    assert.notEqual((await buffer(w2.id))!.updatedAt.getTime(), before!.updatedAt.getTime())
    const audit = await db.activityLog.findMany({ where: { entityId: product.id, action: 'location_buffer_changed' }, orderBy: { createdAt: 'desc' }, take: 1 })
    assert.equal((audit[0]!.metadata as Record<string, unknown>).oldValue, '4')
    assert.equal(enqueued.length, 1)
    enqueued.length = 0
    const allStale = await saveLocationBuffers(product.id, [E(w1.id, '3.5', '1')], 'again')
    assert.deepEqual(allStale, { success: true, changed: 0, stale: [`${RUN}-1`] })
    assert.equal(enqueued.length, 0, 'no push when nothing changed')
  })

  await t.test('save: a missing reason is refused and the row stays as it was', async () => {
    enqueued.length = 0
    const result = await saveLocationBuffers(product.id, [E(w1.id, '9', '2')], ' ')
    assert.equal(result.success, false)
    assert.equal((await buffer(w1.id))!.bufferQty.toString(), '9')
    assert.equal(enqueued.length, 0)
  })

  await t.test('save: back to 0 removes the row; a KIT is refused', async () => {
    assert.deepEqual(await saveLocationBuffers(product.id, [E(w2.id, '6', '')], 'released'), { success: true, changed: 1, stale: [] })
    assert.equal(await buffer(w2.id), null)
    assert.equal((await saveLocationBuffers(kit.id, [E(w1.id, '', '1')], 'x')).success, false)
  })

  await t.test('deleting a warehouse or product cascades its buffers', async () => {
    const tmpW = await db.warehouse.create({ data: { code: `${RUN}-T`, name: RUN, type: 'STANDARD' }, select: { id: true } })
    await saveLocationBuffers(product.id, [E(tmpW.id, '', '1')], 'x')
    await db.warehouse.delete({ where: { id: tmpW.id } })
    assert.equal(await buffer(tmpW.id), null)
  })

  await t.test('read: the editor data carries the buffer next to real on-hand and available', async () => {
    const data = await getLocationBuffers(product.id)
    const mine = data!.warehouses.find((w) => w.warehouseId === w1.id)!
    assert.deepEqual([mine.onHand, mine.available, mine.bufferQty, mine.syncsToStore], ['10', '8', '9', true])
  })

  await t.test('without permission nothing changes', async () => {
    auth.denied = true
    try { await assert.rejects(saveLocationBuffers(product.id, [E(w1.id, '9', '0')], 'x'), /Forbidden/) } finally { auth.denied = false }
    assert.equal((await buffer(w1.id))!.bufferQty.toString(), '9')
  })
})
