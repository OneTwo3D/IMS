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
    await db.stockLevel.deleteMany({ where: { productId: product.id } })
    await db.product.deleteMany({ where: { id: { in: [product.id, kit.id] } } })
    await db.warehouse.deleteMany({ where: { id: { in: [w1.id, w2.id] } } })
  })

  await t.test('a row written without a buffer (every existing row) carries 0', async () => {
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w1.id } })
    assert.equal(row.bufferQty.toString(), '0')
  })

  await t.test('the database refuses a negative buffer', async () => {
    await assert.rejects(
      db.$executeRaw`UPDATE stock_levels SET "bufferQty" = -1 WHERE "productId" = ${product.id}`,
      /stock_levels_buffer_qty_check|check constraint/i,
    )
  })

  await t.test('save: sets the buffer, leaves on-hand and reserved alone, audits with the reason, enqueues one push', async () => {
    const result = await saveLocationBuffers(product.id, [{ warehouseId: w1.id, bufferQty: '3.5' }, { warehouseId: w2.id, bufferQty: '' }], 'Keep back for the trade show')
    assert.deepEqual(result, { success: true, changed: 1 })
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w1.id } })
    assert.deepEqual([row.bufferQty.toString(), row.quantity.toString(), row.reservedQty.toString()], ['3.5', '10', '2'])
    assert.equal(await db.stockLevel.count({ where: { productId: product.id, warehouseId: w2.id } }), 0, 'an unchanged 0 creates no row')
    const audit = await db.activityLog.findMany({ where: { entityId: product.id, action: 'location_buffer_changed' } })
    assert.equal(audit.length, 1)
    assert.match(audit[0]!.description, /Keep back for the trade show/)
    assert.deepEqual(audit[0]!.metadata, { sku: RUN, warehouseId: w1.id, warehouseCode: `${RUN}-1`, oldValue: '0', newValue: '3.5', reason: 'Keep back for the trade show' })
    assert.equal(audit[0]!.createdAt instanceof Date, true)
    assert.deepEqual(enqueued, [[product.id]])
  })

  await t.test('save: a missing reason is refused and the row stays as it was', async () => {
    enqueued.length = 0
    const result = await saveLocationBuffers(product.id, [{ warehouseId: w1.id, bufferQty: '9' }], ' ')
    assert.equal(result.success, false)
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w1.id } })
    assert.equal(row.bufferQty.toString(), '3.5')
    assert.equal(enqueued.length, 0)
  })

  await t.test('save: a location with no stock row gets one at zero quantity; a KIT is refused', async () => {
    assert.deepEqual(await saveLocationBuffers(product.id, [{ warehouseId: w2.id, bufferQty: '4' }], 'B2B reserve'), { success: true, changed: 1 })
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w2.id } })
    assert.deepEqual([row.quantity.toString(), row.bufferQty.toString()], ['0', '4'])
    const refused = await saveLocationBuffers(kit.id, [{ warehouseId: w1.id, bufferQty: '1' }], 'x')
    assert.equal(refused.success, false)
  })

  await t.test('read: the editor data carries the buffer next to real on-hand and available', async () => {
    const data = await getLocationBuffers(product.id)
    const mine = data!.warehouses.find((w) => w.warehouseId === w1.id)!
    assert.deepEqual([mine.onHand, mine.available, mine.bufferQty, mine.syncsToStore], ['10', '8', '3.5', true])
  })

  await t.test('without permission nothing changes', async () => {
    auth.denied = true
    try { await assert.rejects(saveLocationBuffers(product.id, [{ warehouseId: w1.id, bufferQty: '0' }], 'x'), /Forbidden/) } finally { auth.denied = false }
    const row = await db.stockLevel.findFirstOrThrow({ where: { productId: product.id, warehouseId: w1.id } })
    assert.equal(row.bufferQty.toString(), '3.5')
  })
})
