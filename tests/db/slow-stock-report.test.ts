import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * SLOW-STOCK REPORT against a real database: the loader's groupBy / relation-predicate queries, decimal handling and
 * warehouse scoping. GATED on RUN_DB_RETENTION_TESTS (npm run test:db). READ ONLY report; the test writes its own
 * fixtures and removes them.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/slow-stock-report.test.ts would have been skipped')
}

test('slow-stock report: loader on a real database', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { getSlowStockReport } = await import('@/lib/domain/inventory/slow-stock-report')
  const RUN = `SS-${process.pid}-${randomUUID().slice(0, 8)}`
  const NOW = new Date('2026-11-26T10:00:00.000Z')
  const w1 = await db.warehouse.create({ data: { code: `${RUN}-1`, name: RUN, type: 'STANDARD' }, select: { id: true } })
  const w2 = await db.warehouse.create({ data: { code: `${RUN}-2`, name: RUN, type: 'STANDARD' }, select: { id: true } })
  const slow = await db.product.create({ data: { sku: `${RUN}-SLOW`, name: RUN, type: 'SIMPLE' }, select: { id: true } })
  const fast = await db.product.create({ data: { sku: `${RUN}-FAST`, name: RUN, type: 'SIMPLE' }, select: { id: true } })
  const kit = await db.product.create({ data: { sku: `${RUN}-KIT`, name: RUN, type: 'KIT' }, select: { id: true } })
  const productIds = [slow.id, fast.id, kit.id]
  t.after(async () => {
    await db.cogsEntry.deleteMany({ where: { movement: { productId: { in: productIds } } } })
    await db.stockMovement.deleteMany({ where: { productId: { in: productIds } } })
    await db.costLayer.deleteMany({ where: { productId: { in: productIds } } })
    await db.stockLevel.deleteMany({ where: { productId: { in: productIds } } })
    await db.product.deleteMany({ where: { id: { in: productIds } } })
    await db.warehouse.deleteMany({ where: { id: { in: [w1.id, w2.id] } } })
  })

  await db.stockLevel.createMany({ data: [
    { productId: slow.id, warehouseId: w1.id, quantity: '10' },
    { productId: slow.id, warehouseId: w2.id, quantity: '5' },
    { productId: fast.id, warehouseId: w1.id, quantity: '6' },
    { productId: kit.id, warehouseId: w1.id, quantity: '3' },
  ] })
  await db.costLayer.createMany({ data: [
    { productId: slow.id, warehouseId: w1.id, receivedQty: '12', remainingQty: '10', unitCostBase: '2.123456', receivedAt: new Date('2025-06-01T00:00:00Z') },
    { productId: slow.id, warehouseId: w1.id, receivedQty: '4', remainingQty: '0', unitCostBase: '9', receivedAt: new Date('2024-01-01T00:00:00Z') },
    { productId: slow.id, warehouseId: w2.id, receivedQty: '5', remainingQty: '5', unitCostBase: '3.5', receivedAt: new Date('2026-09-01T00:00:00Z') },
    { productId: fast.id, warehouseId: w1.id, receivedQty: '6', remainingQty: '6', unitCostBase: '1', receivedAt: new Date('2026-11-01T00:00:00Z') },
  ] })
  // A real warehouse dispatch needs COGS evidence (database guard), checked at commit: write both in one transaction.
  const layerFor = async (productId: string, warehouseId: string) => (await db.costLayer.findFirstOrThrow({ where: { productId, warehouseId, remainingQty: { gt: 0 } }, select: { id: true } })).id
  const sale = async (productId: string, warehouseId: string, qty: string, at: string) => {
    const costLayerId = await layerFor(productId, warehouseId)
    await db.$transaction(async (tx) => {
      const movement = await tx.stockMovement.create({ data: { type: 'SALE_DISPATCH', productId, fromWarehouseId: warehouseId, qty, createdAt: new Date(at) }, select: { id: true } })
      await tx.cogsEntry.create({ data: { costLayerId, movementId: movement.id, qty, unitCostBase: '1', totalCostBase: qty, createdAt: new Date(at) } })
    })
  }
  await sale(slow.id, w1.id, '2', '2026-01-10T12:00:00Z')
  await sale(fast.id, w1.id, '4', '2026-11-20T12:00:00Z')
  await sale(fast.id, w1.id, '5', '2026-10-20T12:00:00Z')
  // Before the 90-day window: counts as last-sale evidence only, not in the rate.
  await sale(fast.id, w1.id, '7', '2026-05-01T12:00:00Z')
  // A non-sale movement must not count as a sale (the outbound adjustment needs its own COGS evidence).
  await db.$transaction(async (tx) => {
    const movement = await tx.stockMovement.create({ data: { type: 'ADJUSTMENT', productId: slow.id, fromWarehouseId: w1.id, qty: '1', createdAt: new Date('2026-11-10T00:00:00Z') }, select: { id: true } })
    await tx.cogsEntry.create({ data: { costLayerId: await layerFor(slow.id, w1.id), movementId: movement.id, qty: '1', unitCostBase: '1', totalCostBase: '1', createdAt: new Date('2026-11-10T00:00:00Z') } })
  })

  const run = (filters: Parameters<typeof getSlowStockReport>[0]) =>
    getSlowStockReport(filters, { deps: { now: () => NOW } })
  // Other fixtures may exist in a shared scratch database; keep to this run's SKUs.
  const mine = <T extends { sku: string }>(rows: T[]) => rows.filter((r) => r.sku.startsWith(RUN))

  await t.test('per product: exact value from layers, oldest open layer, last sale, 90-day rate and cover', async () => {
    const report = await run({ includeCost: true, pageSize: 500 })
    const rows = mine(report.rows)
    assert.deepEqual(rows.map((r) => r.sku), [`${RUN}-SLOW`, `${RUN}-FAST`], 'KIT excluded; ordered by value')
    const [s, f] = rows
    assert.equal(s.qty, '15')
    assert.equal(s.valueBase, '38.73456', '10 x 2.123456 + 5 x 3.5, the depleted 9.00 layer ignored')
    assert.equal(s.oldestLayerAt, '2025-06-01T00:00:00.000Z', 'the depleted older layer is not the oldest open layer')
    assert.equal(s.oldestLayerAgeDays, 543)
    assert.equal(s.ageBand, '365+')
    assert.equal(s.lastSaleAt, '2026-01-10T12:00:00.000Z', 'ADJUSTMENT does not count as a sale')
    assert.equal(s.ratePer30Days, '0')
    assert.equal(s.monthsOfCover, null)
    assert.equal(f.lastSaleAt, '2026-11-20T12:00:00.000Z')
    assert.equal(f.soldQtyInWindow, '9')
    assert.equal(f.ratePer30Days, '3')
    assert.equal(f.monthsOfCover, '2')
  })

  await t.test('per warehouse and warehouse filter scope the figures', async () => {
    const split = mine((await run({ includeCost: true, perWarehouse: true, pageSize: 500 })).rows)
    assert.deepEqual(split.map((r) => `${r.sku.slice(RUN.length + 1)}@${r.warehouseCode.slice(-1)}`), ['SLOW@1', 'SLOW@2', 'FAST@1'])
    assert.equal(split.find((r) => r.warehouseCode.endsWith('-2'))!.lastSaleAt, null)
    const only2 = mine((await run({ includeCost: true, warehouseId: w2.id, pageSize: 500 })).rows)
    assert.deepEqual(only2.map((r) => [r.sku.slice(RUN.length + 1), r.qty, r.valueBase]), [['SLOW', '5', '17.5']])
  })

  await t.test('age, no-sale and minimum-value filters', async () => {
    assert.deepEqual(mine((await run({ includeCost: true, minAgeDays: 365, pageSize: 500 })).rows).map((r) => r.sku.slice(RUN.length + 1)), ['SLOW'])
    assert.deepEqual(mine((await run({ includeCost: true, noSaleDays: 90, pageSize: 500 })).rows).map((r) => r.sku.slice(RUN.length + 1)), ['SLOW'])
    assert.deepEqual(mine((await run({ includeCost: true, minValueBase: '10', pageSize: 500 })).rows).map((r) => r.sku.slice(RUN.length + 1)), ['SLOW'])
  })

  await t.test('without cost visibility no value reaches the result', async () => {
    const report = await run({ pageSize: 500 })
    assert.ok(mine(report.rows).every((r) => r.valueBase === null))
    assert.equal(report.totals.valueBase, null)
  })

  await t.test('the report is read only', async () => {
    const before = [await db.stockLevel.count(), await db.costLayer.count(), await db.stockMovement.count()]
    await run({ includeCost: true, perWarehouse: true, pageSize: 500 })
    assert.deepEqual([await db.stockLevel.count(), await db.costLayer.count(), await db.stockMovement.count()], before)
  })
})
