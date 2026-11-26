import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import {
  ageBandFor,
  ageInDays,
  getSlowStockReport,
  layersValue,
  matchesSlowStockFilters,
  monthsOfCover,
  oldestOpenLayerAt,
  parseMinValue,
  unitsPer30Days,
  type SlowStockReportClient,
} from '@/lib/domain/inventory/slow-stock-report'
import { InventoryHealthSourceLimitError } from '@/lib/domain/inventory/inventory-health-reports'

const d = (value: string | number) => new Prisma.Decimal(value)
const NOW = new Date('2026-11-26T10:00:00.000Z')

test('layersValue is exact decimal arithmetic over open layers only', () => {
  const value = layersValue([
    { remainingQty: d('3'), unitCostBase: d('0.1'), receivedAt: new Date('2026-01-01') },
    { remainingQty: d('0.2'), unitCostBase: d('0.1'), receivedAt: new Date('2026-02-01') },
    { remainingQty: d('0'), unitCostBase: d('999'), receivedAt: new Date('2026-03-01') },
  ])
  assert.equal(value.toString(), '0.32')
})

test('oldestOpenLayerAt ignores depleted layers', () => {
  const oldest = oldestOpenLayerAt([
    { remainingQty: d('0'), unitCostBase: d('1'), receivedAt: new Date('2025-01-01') },
    { remainingQty: d('1'), unitCostBase: d('1'), receivedAt: new Date('2026-03-01') },
    { remainingQty: d('1'), unitCostBase: d('1'), receivedAt: new Date('2026-05-01') },
  ])
  assert.equal(oldest?.toISOString(), '2026-03-01T00:00:00.000Z')
  assert.equal(oldestOpenLayerAt([]), null)
})

test('ageInDays counts UTC calendar days and never goes negative', () => {
  assert.equal(ageInDays(new Date('2026-11-25T23:59:00Z'), new Date('2026-11-26T00:01:00Z')), 1)
  assert.equal(ageInDays(new Date('2026-11-26T09:00:00Z'), NOW), 0)
  assert.equal(ageInDays(new Date('2026-12-01T00:00:00Z'), NOW), 0)
})

test('age bands cover the boundaries', () => {
  assert.equal(ageBandFor(0), '0-90')
  assert.equal(ageBandFor(90), '0-90')
  assert.equal(ageBandFor(91), '91-180')
  assert.equal(ageBandFor(180), '91-180')
  assert.equal(ageBandFor(181), '181-365')
  assert.equal(ageBandFor(365), '181-365')
  assert.equal(ageBandFor(366), '365+')
})

test('sales rate and months of cover', () => {
  // 9 units in 90 days = 3 per 30 days; 12 on hand = 4 months.
  assert.equal(unitsPer30Days('9').toString(), '3')
  assert.equal(monthsOfCover('12', '9')?.toString(), '4')
  // Not a repeating-decimal float: 1 unit in 90 days = 0.3333 per 30 days; 5 on hand = 15 months.
  assert.equal(unitsPer30Days('1').toString(), '0.3333')
  assert.equal(monthsOfCover('5', '1')?.toString(), '15')
  assert.equal(monthsOfCover('5', '0'), null)
  assert.throws(() => unitsPer30Days('-1'))
  assert.throws(() => unitsPer30Days('1', 0))
})

test('filters: age, no-sale days (never sold needs stock at least that old) and minimum value', () => {
  const row = (oldestLayerAgeDays: number | null, daysSinceLastSale: number | null, valueBase: string | null) => ({ oldestLayerAgeDays, daysSinceLastSale, valueBase })
  assert.equal(matchesSlowStockFilters(row(200, 10, '5'), { minAgeDays: 180 }), true)
  assert.equal(matchesSlowStockFilters(row(100, 10, '5'), { minAgeDays: 180 }), false)
  assert.equal(matchesSlowStockFilters(row(null, 10, '5'), { minAgeDays: 180 }), false)
  assert.equal(matchesSlowStockFilters(row(500, 120, '5'), { noSaleDays: 90 }), true)
  assert.equal(matchesSlowStockFilters(row(500, 30, '5'), { noSaleDays: 90 }), false)
  assert.equal(matchesSlowStockFilters(row(500, null, '5'), { noSaleDays: 90 }), true, 'never sold and old stock')
  assert.equal(matchesSlowStockFilters(row(20, null, '5'), { noSaleDays: 90 }), false, 'never sold but stock is new')
  assert.equal(matchesSlowStockFilters(row(500, 120, '99.99'), { minValueBase: d('100') }), false)
  assert.equal(matchesSlowStockFilters(row(500, 120, '100'), { minValueBase: d('100') }), true)
  assert.equal(matchesSlowStockFilters(row(500, 120, null), { minValueBase: d('100') }), true, 'no value: value filter does not apply')
})

test('parseMinValue accepts plain non-negative decimals only', () => {
  assert.equal(parseMinValue('12.5')?.toString(), '12.5')
  assert.equal(parseMinValue('-1'), undefined)
  assert.equal(parseMinValue('1e3'), undefined)
  assert.equal(parseMinValue(''), undefined)
  assert.equal(parseMinValue(undefined), undefined)
})

// --- loader with a fake client -------------------------------------------------------------

function level(productId: string, sku: string, warehouseId: string, code: string, quantity: string) {
  return {
    productId,
    warehouseId,
    quantity: d(quantity),
    product: { sku, name: sku, type: ProductType.SIMPLE, stockUnit: 'pcs', category: null, supplierProducts: [] },
    warehouse: { code },
  }
}

function fakeClient(over: { groupBy?: (args: { _max?: unknown; _sum?: unknown }) => unknown[]; layers?: unknown[]; levels?: unknown[] } = {}): SlowStockReportClient {
  return {
    stockLevel: { findMany: async () => over.levels ?? [] },
    costLayer: { findMany: async () => over.layers ?? [] },
    stockMovement: { groupBy: async (args) => (over.groupBy ? over.groupBy(args as { _max?: unknown; _sum?: unknown }) : []) },
  }
}

const levels = [
  level('p1', 'A-OLD', 'w1', 'WH1', '10'),
  level('p1', 'A-OLD', 'w2', 'WH2', '5'),
  level('p2', 'B-FAST', 'w1', 'WH1', '6'),
]
const layers = [
  { productId: 'p1', warehouseId: 'w1', remainingQty: d('10'), unitCostBase: d('2'), receivedAt: new Date('2025-06-01T00:00:00Z') },
  { productId: 'p1', warehouseId: 'w2', remainingQty: d('5'), unitCostBase: d('3.5'), receivedAt: new Date('2026-09-01T00:00:00Z') },
  { productId: 'p2', warehouseId: 'w1', remainingQty: d('6'), unitCostBase: d('1'), receivedAt: new Date('2026-11-01T00:00:00Z') },
]
const groupBy = (args: { _max?: unknown; _sum?: unknown }) => args._max
  ? [
      { productId: 'p1', fromWarehouseId: 'w1', _max: { createdAt: new Date('2026-01-10T12:00:00Z') } },
      { productId: 'p2', fromWarehouseId: 'w1', _max: { createdAt: new Date('2026-11-20T12:00:00Z') } },
    ]
  : [{ productId: 'p2', fromWarehouseId: 'w1', _sum: { qty: d('9') } }]

test('per-product report aggregates warehouses, sorts by value and computes age, last sale, rate and cover', async () => {
  const report = await getSlowStockReport({ includeCost: true }, { deps: { client: fakeClient({ levels, layers, groupBy }), now: () => NOW } })
  assert.deepEqual(report.rows.map((r) => r.sku), ['A-OLD', 'B-FAST'])
  const [slow, fast] = report.rows
  assert.equal(slow.qty, '15')
  assert.equal(slow.valueBase, '37.5')
  assert.equal(slow.oldestLayerAgeDays, 543)
  assert.equal(slow.ageBand, '365+')
  assert.equal(slow.lastSaleAt, '2026-01-10T12:00:00.000Z')
  assert.equal(slow.ratePer30Days, '0')
  assert.equal(slow.monthsOfCover, null)
  assert.equal(fast.valueBase, '6')
  assert.equal(fast.ratePer30Days, '3')
  assert.equal(fast.monthsOfCover, '2')
  assert.equal(report.totals.valueBase, '43.5')
  assert.equal(report.totals.qty, '21')
})

test('per-warehouse rows split the product and scope sales to the warehouse', async () => {
  const report = await getSlowStockReport({ includeCost: true, perWarehouse: true }, { deps: { client: fakeClient({ levels, layers, groupBy }), now: () => NOW } })
  assert.deepEqual(report.rows.map((r) => `${r.sku}@${r.warehouseCode}`), ['A-OLD@WH1', 'A-OLD@WH2', 'B-FAST@WH1'])
  const w2 = report.rows.find((r) => r.warehouseCode === 'WH2')!
  assert.equal(w2.lastSaleAt, null, 'WH2 never dispatched a sale')
  assert.equal(w2.valueBase, '17.5')
})

test('without cost visibility value is null everywhere and rows are ordered by age', async () => {
  const report = await getSlowStockReport({ minValueBase: '1000', minAgeDays: 0 }, { deps: { client: fakeClient({ levels, layers, groupBy }), now: () => NOW } })
  assert.equal(report.costVisible, false)
  assert.equal(report.rows.length, 2, 'the minimum-value filter is ignored without cost visibility')
  assert.ok(report.rows.every((r) => r.valueBase === null))
  assert.equal(report.totals.valueBase, null)
  assert.ok(report.bandSummary.every((b) => b.valueBase === null))
  assert.deepEqual(report.rows.map((r) => r.sku), ['A-OLD', 'B-FAST'])
  assert.ok(!JSON.stringify(report).includes('37.5'), 'no cost figure leaks into the payload')
})

test('age and no-sale filters narrow the rows', async () => {
  const deps = { client: fakeClient({ levels, layers, groupBy }), now: () => NOW }
  const old = await getSlowStockReport({ includeCost: true, minAgeDays: 365 }, { deps })
  assert.deepEqual(old.rows.map((r) => r.sku), ['A-OLD'])
  const quiet = await getSlowStockReport({ includeCost: true, noSaleDays: 90 }, { deps })
  assert.deepEqual(quiet.rows.map((r) => r.sku), ['A-OLD'])
  const valuable = await getSlowStockReport({ includeCost: true, minValueBase: '10' }, { deps })
  assert.deepEqual(valuable.rows.map((r) => r.sku), ['A-OLD'])
})

test('warehouse-less historical sales count for every warehouse of the product', async () => {
  const client = fakeClient({
    levels: [level('p1', 'A-OLD', 'w1', 'WH1', '10')],
    layers: [layers[0]],
    groupBy: (args) => args._max
      ? [{ productId: 'p1', fromWarehouseId: null, _max: { createdAt: new Date('2026-11-01T00:00:00Z') } }]
      : [{ productId: 'p1', fromWarehouseId: null, _sum: { qty: d('30') } }],
  })
  const report = await getSlowStockReport({ includeCost: true, perWarehouse: true }, { deps: { client, now: () => NOW } })
  assert.equal(report.rows[0].daysSinceLastSale, 25)
  assert.equal(report.rows[0].ratePer30Days, '10')
  assert.equal(report.rows[0].monthsOfCover, '1')
})

test('a stocked row with no open layer reports value 0, no age and a notice', async () => {
  const report = await getSlowStockReport({ includeCost: true }, { deps: { client: fakeClient({ levels: [levels[2]], layers: [] }), now: () => NOW } })
  assert.equal(report.rows[0].valueBase, '0')
  assert.equal(report.rows[0].oldestLayerAgeDays, null)
  assert.ok(report.notices.some((n) => /no open cost layer/.test(n)))
})

test('KIT filter and empty stock return an empty report', async () => {
  const kit = await getSlowStockReport({ productType: ProductType.KIT }, { deps: { client: fakeClient({ levels }), now: () => NOW } })
  assert.equal(kit.rows.length, 0)
  const none = await getSlowStockReport({}, { deps: { client: fakeClient(), now: () => NOW } })
  assert.equal(none.totals.rows, 0)
})

test('an over-limit source scan refuses the report instead of truncating', async () => {
  const many = Array.from({ length: 100001 }, (_, i) => level(`p${i}`, `S${i}`, 'w1', 'WH1', '1'))
  await assert.rejects(
    getSlowStockReport({}, { deps: { client: fakeClient({ levels: many }), now: () => NOW } }),
    (error: unknown) => error instanceof InventoryHealthSourceLimitError,
  )
})

test('pagination bounds the page and keeps totals over all rows', async () => {
  const report = await getSlowStockReport({ includeCost: true, pageSize: 50, page: 1 }, { deps: { client: fakeClient({ levels, layers, groupBy }), now: () => NOW } })
  assert.equal(report.pageInfo.pageSize, 50)
  assert.equal(report.totals.rows, 2)
})
