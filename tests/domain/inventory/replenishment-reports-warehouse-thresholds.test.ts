import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { getReorderReport, type ReplenishmentReportClient } from '@/lib/domain/inventory/replenishment-reports'

const d = (v: string | number) => new Prisma.Decimal(v)
const NOW = () => new Date('2026-06-01T18:00:00.000Z')
const category = { id: 'c1', name: 'Goods' }
const empty = { findMany: async () => [] }

/** Product thresholds: reorder point 100, safety 20, reorder qty 30. No demand, so the report is purely threshold-driven. */
const product = {
  id: 'p1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
  reorderPoint: d(100), reorderQty: d(30), safetyStockQty: d(20), leadTimeDays: 5,
  category, preferredSupplier: null, supplierProducts: [],
}

type Level = { productId: string; warehouseId: string; quantity: Prisma.Decimal; reservedQty: Prisma.Decimal; warehouse: { code: string; name: string } }
type Ovr = { productId: string; warehouseId: string; reorderPoint: Prisma.Decimal | null; safetyStockQty: Prisma.Decimal | null; reorderQty: Prisma.Decimal | null }
const level = (warehouseId: string, qty: number): Level => ({
  productId: 'p1', warehouseId, quantity: d(qty), reservedQty: d(0), warehouse: { code: warehouseId, name: warehouseId },
})
const ovr = (warehouseId: string, over: Partial<Ovr> = {}): Ovr => ({
  productId: 'p1', warehouseId, reorderPoint: null, safetyStockQty: null, reorderQty: null, ...over,
})

function client(levels: Level[], overrides: Ovr[] = []): ReplenishmentReportClient {
  return {
    stockMovement: empty, purchaseOrderLine: empty, purchaseReceipt: empty,
    salesOrderLine: empty, orderAllocation: empty, shipmentLine: empty, productionOrder: empty, bomItem: empty,
    product: {
      findMany: async () => [product],
      // The consolidated view's notice: a COUNT of report products that have any non-null override.
      count: async () => new Set(overrides.filter((o) => o.reorderPoint != null || o.safetyStockQty != null || o.reorderQty != null).map((o) => o.productId)).size,
    },
    reorderThresholdOverride: {
      findMany: async (args?: unknown) => {
        const where = (args as { where?: { warehouseId?: string; productId?: { in?: string[] } } })?.where
        // Loading override rows without a warehouse and a product list is exactly what must never happen.
        if (!where?.warehouseId || !where.productId?.in) throw new Error('override rows must be loaded per warehouse and per product batch')
        if (where.productId.in.length > 1000) throw new Error('override IN batch too large')
        return overrides.filter((o) => o.warehouseId === where.warehouseId && where.productId!.in!.includes(o.productId))
      },
    },
    // Honour the report's own warehouse filter, as the database would.
    stockLevel: {
      findMany: async (args?: unknown) => {
        const warehouseId = (args as { where?: { warehouseId?: string } })?.where?.warehouseId
        return warehouseId ? levels.filter((l) => l.warehouseId === warehouseId) : levels
      },
    },
  }
}

const LEVELS = [level('MAIN', 90), level('SAT', 90)]
// MAIN inherits (90 <= 100 -> reorder); SAT overrides (90 > 40).
const OVERRIDES = [ovr('SAT', { reorderPoint: d(40), safetyStockQty: d(5), reorderQty: d(7) })]

test('each warehouse is planned against its own thresholds', async () => {
  const main = await getReorderReport({ warehouseId: 'MAIN', includeZero: true }, { deps: { client: client(LEVELS, OVERRIDES), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, { deps: { client: client(LEVELS, OVERRIDES), now: NOW } })

  assert.equal(main.rows[0]?.reorderPoint, '100')
  assert.equal(main.rows[0]?.safetyStockQty, '20')
  assert.equal(main.rows[0]?.configuredReorderQty, '30')
  assert.equal(main.rows[0]?.suggestedReorderQty, '30') // top-up gap is 10; the configured lot size 30 is the floor
  assert.deepEqual(main.rows[0]?.thresholdOverrides, [])

  assert.equal(sat.rows[0]?.reorderPoint, '40')
  assert.equal(sat.rows[0]?.safetyStockQty, '5')
  assert.equal(sat.rows[0]?.configuredReorderQty, '7')
  assert.equal(sat.rows[0]?.suggestedReorderQty, '0') // 90 is above the satellite's own reorder point
  assert.deepEqual(sat.rows[0]?.thresholdOverrides, ['reorderPoint', 'safetyStockQty', 'reorderQty'])
})

test('the satellite stops appearing in the default view once its own threshold is lower', async () => {
  const main = await getReorderReport({ warehouseId: 'MAIN' }, { deps: { client: client(LEVELS, OVERRIDES), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT' }, { deps: { client: client(LEVELS, OVERRIDES), now: NOW } })
  assert.equal(main.rows.length, 1)
  assert.equal(sat.rows.length, 0)
})

test('a partial override only replaces the fields it sets', async () => {
  const report = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, { deps: { client: client([level('SAT', 90)], [ovr('SAT', { reorderPoint: d(95) })]), now: NOW } })
  assert.equal(report.rows[0]?.reorderPoint, '95')
  assert.equal(report.rows[0]?.safetyStockQty, '20')
  assert.equal(report.rows[0]?.configuredReorderQty, '30')
  assert.deepEqual(report.rows[0]?.thresholdOverrides, ['reorderPoint'])
})

test('the all-warehouses view is consolidated: Product values, with a notice that overrides were not applied', async () => {
  const report = await getReorderReport({ includeZero: true }, { deps: { client: client(LEVELS, OVERRIDES), now: NOW } })
  assert.equal(report.rows[0]?.reorderPoint, '100')
  assert.equal(report.rows[0]?.safetyStockQty, '20')
  assert.deepEqual(report.rows[0]?.thresholdOverrides, [])
  assert.ok(report.notices.some((n) => /1 product\(s\) have a per-warehouse threshold override that this all-warehouses view does not apply/.test(n)))
})

test('no overrides anywhere: no notice about unapplied overrides', async () => {
  const report = await getReorderReport({ includeZero: true }, { deps: { client: client([level('MAIN', 90)]), now: NOW } })
  assert.ok(!report.notices.some((n) => /does not apply/.test(n)))
})

test('safety stock override drives the reorder timing dates', async () => {
  const demand = {
    findMany: async () => [{
      productId: 'p1', qty: d(90), totalValueBase: d(0), createdAt: new Date('2026-05-20T12:00:00.000Z'),
      product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [] },
    }],
  }
  const withDemand = (levels: Level[]): ReplenishmentReportClient => ({ ...client(levels, overrides), stockMovement: demand })
  const levels = [level('MAIN', 100), level('SAT', 100)]
  const overrides = [ovr('SAT', { safetyStockQty: d(60) })]
  const main = await getReorderReport({ warehouseId: 'MAIN', includeZero: true, thresholdDays: 90 }, { deps: { client: withDemand(levels), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT', includeZero: true, thresholdDays: 90 }, { deps: { client: withDemand(levels), now: NOW } })
  // 1/day demand: stock 100 reaches safety 20 on day 80 (MAIN) but safety 60 on day 40 (SAT).
  assert.equal(main.rows[0]?.requiredReceiptDate, '2026-08-20')
  assert.equal(sat.rows[0]?.requiredReceiptDate, '2026-07-11')
})

test('more override rows than the source limit never makes the report refuse: consolidated counts, filtered applies the right row', async () => {
  // 60,001 override rows for other products at other warehouses (above the 50,000 source limit), plus p1's own at SAT.
  const noise: Ovr[] = Array.from({ length: 60001 }, (_, i) => ({
    productId: `other-${i}`, warehouseId: `W${i % 3}`, reorderPoint: d(1), safetyStockQty: null, reorderQty: null,
  }))
  const overrides = [...noise, ovr('SAT', { reorderPoint: d(40), safetyStockQty: d(5), reorderQty: d(7) })]
  const consolidated = await getReorderReport({ includeZero: true }, { deps: { client: client(LEVELS, overrides), now: NOW } })
  assert.equal(consolidated.rows[0]?.reorderPoint, '100')
  // The fake counts distinct products over the whole table, as the real count would over the products matching the filters.
  assert.ok(consolidated.notices.some((n) => /60002 product\(s\) have a per-warehouse threshold override that this all-warehouses view does not apply/.test(n)))

  const sat = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, { deps: { client: client(LEVELS, overrides), now: NOW } })
  assert.equal(sat.rows[0]?.reorderPoint, '40')
  assert.deepEqual(sat.rows[0]?.thresholdOverrides, ['reorderPoint', 'safetyStockQty', 'reorderQty'])
  const main = await getReorderReport({ warehouseId: 'MAIN', includeZero: true }, { deps: { client: client(LEVELS, overrides), now: NOW } })
  assert.equal(main.rows[0]?.reorderPoint, '100')
  assert.deepEqual(main.rows[0]?.thresholdOverrides, [])
})

test('filtered report loads overrides in IN batches of at most 1000 products', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ ...product, id: `p-${i}`, sku: `S-${i}` }))
  const batches: number[] = []
  const c = client(LEVELS, [])
  const run = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, {
    deps: {
      client: {
        ...c,
        product: { findMany: async () => many },
        reorderThresholdOverride: { findMany: async (args?: unknown) => { batches.push((args as { where: { productId: { in: string[] } } }).where.productId.in.length); return [] } },
      },
      now: NOW,
    },
  })
  assert.ok(run.rows.length > 0)
  assert.deepEqual(batches, [1000, 1000, 500])
})
