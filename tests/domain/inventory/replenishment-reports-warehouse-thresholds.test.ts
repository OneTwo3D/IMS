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

type Level = { productId: string; warehouseId: string; quantity: Prisma.Decimal; reservedQty: Prisma.Decimal; reorderPointOverride?: Prisma.Decimal | null; safetyStockQtyOverride?: Prisma.Decimal | null; reorderQtyOverride?: Prisma.Decimal | null; warehouse: { code: string; name: string } }
const level = (warehouseId: string, qty: number, over: Partial<Level> = {}): Level => ({
  productId: 'p1', warehouseId, quantity: d(qty), reservedQty: d(0), warehouse: { code: warehouseId, name: warehouseId }, ...over,
})

function client(levels: Level[]): ReplenishmentReportClient {
  return {
    stockMovement: empty, purchaseOrderLine: empty, purchaseReceipt: empty,
    salesOrderLine: empty, orderAllocation: empty, shipmentLine: empty, productionOrder: empty, bomItem: empty,
    product: { findMany: async () => [product] },
    // Honour the report's own warehouse filter, as the database would.
    stockLevel: {
      findMany: async (args?: unknown) => {
        const warehouseId = (args as { where?: { warehouseId?: string } })?.where?.warehouseId
        return warehouseId ? levels.filter((l) => l.warehouseId === warehouseId) : levels
      },
    },
  }
}

const LEVELS = [
  level('MAIN', 90),                                                // inherits: 90 <= 100 -> reorder
  level('SAT', 90, { reorderPointOverride: d(40), safetyStockQtyOverride: d(5), reorderQtyOverride: d(7) }), // override: 90 > 40
]

test('each warehouse is planned against its own thresholds', async () => {
  const main = await getReorderReport({ warehouseId: 'MAIN', includeZero: true }, { deps: { client: client(LEVELS), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, { deps: { client: client(LEVELS), now: NOW } })

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
  const main = await getReorderReport({ warehouseId: 'MAIN' }, { deps: { client: client(LEVELS), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT' }, { deps: { client: client(LEVELS), now: NOW } })
  assert.equal(main.rows.length, 1)
  assert.equal(sat.rows.length, 0)
})

test('a partial override only replaces the fields it sets', async () => {
  const partial = [level('SAT', 90, { reorderPointOverride: d(95) })]
  const report = await getReorderReport({ warehouseId: 'SAT', includeZero: true }, { deps: { client: client(partial), now: NOW } })
  assert.equal(report.rows[0]?.reorderPoint, '95')
  assert.equal(report.rows[0]?.safetyStockQty, '20')
  assert.equal(report.rows[0]?.configuredReorderQty, '30')
  assert.deepEqual(report.rows[0]?.thresholdOverrides, ['reorderPoint'])
})

test('the all-warehouses view is consolidated: Product values, with a notice that overrides were not applied', async () => {
  const report = await getReorderReport({ includeZero: true }, { deps: { client: client(LEVELS), now: NOW } })
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
  const withDemand = (levels: Level[]): ReplenishmentReportClient => ({ ...client(levels), stockMovement: demand })
  const levels = [
    level('MAIN', 100),
    level('SAT', 100, { safetyStockQtyOverride: d(60) }),
  ]
  const main = await getReorderReport({ warehouseId: 'MAIN', includeZero: true, thresholdDays: 90 }, { deps: { client: withDemand(levels), now: NOW } })
  const sat = await getReorderReport({ warehouseId: 'SAT', includeZero: true, thresholdDays: 90 }, { deps: { client: withDemand(levels), now: NOW } })
  // 1/day demand: stock 100 reaches safety 20 on day 80 (MAIN) but safety 60 on day 40 (SAT).
  assert.equal(main.rows[0]?.requiredReceiptDate, '2026-08-20')
  assert.equal(sat.rows[0]?.requiredReceiptDate, '2026-07-11')
})
