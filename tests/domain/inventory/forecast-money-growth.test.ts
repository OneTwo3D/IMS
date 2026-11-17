import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { getReorderReport, type ReplenishmentReportClient, type ReplenishmentReportDeps } from '@/lib/domain/inventory/replenishment-reports'
import { getReorderDemandChart, type ReorderDemandChartDeps } from '@/lib/domain/inventory/reorder-demand-chart'
import { buildStockoutDays } from '@/lib/domain/inventory/stockout-history'
import { projectStockPosition } from '@/lib/domain/inventory/reorder-timing'
import {
  MAX_GROWTH_PERCENT,
  MIN_GROWTH_PERCENT,
  growthForCarry,
  resolveGrowthPercent,
} from '@/lib/domain/inventory/forecast-growth'
import {
  NO_COST_HISTORY_TEXT,
  computeForecastMoney,
  currentUnitCostBase,
  type ForecastMoneyProductInputs,
} from '@/lib/domain/inventory/reorder-forecast-money'

const d = (value: string | number) => new Prisma.Decimal(value)
const category = { id: 'category-1', name: 'Finished goods' }
const supplier = { name: 'Supplier A' }
const NOW = new Date('2027-01-06T10:00:00.000Z')

// 21 units in the 14-day window = 1.5/day.
function sale(at: string, qty: number) {
  return { productId: 'product-1', qty: d(qty), totalValueBase: d(0), createdAt: new Date(at), product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] } }
}
const SALES = [
  sale('2026-12-27T23:59:59.000Z', 7),
  sale('2026-12-28T00:00:00.000Z', 5),
  sale('2026-12-31T09:00:00.000Z', 3),
  sale('2027-01-03T23:59:59.000Z', 2),
  sale('2027-01-04T00:00:00.000Z', 4),
]

function client(stock = 20): ReplenishmentReportClient {
  const empty = { findMany: async () => [] }
  return {
    product: {
      findMany: async () => [{
        id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: null, reorderQty: d(10), safetyStockQty: d(3), leadTimeDays: 7, observedLeadTimeDays: null,
        category, preferredSupplierId: null, preferredSupplier: null, supplierProducts: [],
      }],
    },
    stockLevel: { findMany: async () => [{ productId: 'product-1', warehouseId: 'wh-1', quantity: d(stock), reservedQty: d(0), warehouse: { code: 'W1', name: 'Main' } }] },
    stockMovement: { findMany: async () => SALES },
    purchaseOrderLine: empty, purchaseReceipt: empty, salesOrderLine: empty, orderAllocation: empty, shipmentLine: empty, productionOrder: empty, bomItem: empty,
    warehouse: { findUnique: async () => ({ name: 'Main Warehouse', code: 'W1' }) },
  } as unknown as ReplenishmentReportClient
}

function deps(money?: Partial<ForecastMoneyProductInputs>, stock = 20): ReplenishmentReportDeps {
  return {
    client: client(stock),
    now: () => NOW,
    baseCurrency: 'GBP',
    loadForecastMoneyInputs: async (ids) => new Map(ids.map((id) => [id, { salesPrice: '10', salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase: '4', ...money }])),
  }
}

const noStockoutHistory: NonNullable<ReorderDemandChartDeps['loadStockoutHistory']> = async ({ dateFrom, dateTo }) =>
  buildStockoutDays({ dateFrom, dateTo, runDates: [], rows: [] })

// ---- forecast sales and margin ------------------------------------------------------------------

test('forecast money: sales is quantity x ex-VAT list price, margin is sales less quantity x cost', () => {
  const m = computeForecastMoney({ forecastQty: '56', salesPrice: '10', salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase: '4', baseCurrency: 'GBP' })
  assert.deepEqual(m, { forecastSales: '560', forecastMargin: '336', forecastSalesUnavailable: null, forecastMarginUnavailable: null })
})

test('forecast money: a VAT-inclusive list price has the sales VAT rate stripped, as in the PO line margin', () => {
  const m = computeForecastMoney({ forecastQty: '10', salesPrice: '12', salesPriceTaxInclusive: true, salesVatRate: 0.2, unitCostBase: '4', baseCurrency: 'GBP' })
  assert.equal(m.forecastSales, '100') // 10 x (12 / 1.2)
  assert.equal(m.forecastMargin, '60')
})

test('forecast money: VAT-inclusive price with no resolved VAT rate is unavailable, not guessed', () => {
  const m = computeForecastMoney({ forecastQty: '10', salesPrice: '12', salesPriceTaxInclusive: true, salesVatRate: null, unitCostBase: '4', baseCurrency: 'GBP' })
  assert.equal(m.forecastSales, null)
  assert.equal(m.forecastMargin, null)
  assert.match(m.forecastSalesUnavailable ?? '', /VAT/)
})

test('forecast money: no list price makes both unavailable', () => {
  const m = computeForecastMoney({ forecastQty: '10', salesPrice: null, salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase: '4', baseCurrency: 'GBP' })
  assert.equal(m.forecastSales, null)
  assert.equal(m.forecastMargin, null)
})

test('forecast money: no cost history leaves margin unavailable, never 0 and never 100%', () => {
  for (const unitCostBase of [null, undefined, '0']) {
    const m = computeForecastMoney({ forecastQty: '56', salesPrice: '10', salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase, baseCurrency: 'GBP' })
    assert.equal(m.forecastSales, '560')
    assert.equal(m.forecastMargin, null)
    assert.equal(m.forecastMarginUnavailable, NO_COST_HISTORY_TEXT)
  }
})

test('forecast money: a loss shows as a negative margin', () => {
  const m = computeForecastMoney({ forecastQty: '10', salesPrice: '3', salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase: '4', baseCurrency: 'GBP' })
  assert.equal(m.forecastMargin, '-10')
})

test('forecast money: rounded to the base currency minor units, exact decimal maths', () => {
  const m = computeForecastMoney({ forecastQty: '3', salesPrice: '0.1', salesPriceTaxInclusive: false, salesVatRate: null, unitCostBase: '0.2', baseCurrency: 'GBP' })
  assert.equal(m.forecastSales, '0.3') // 0.30000000000000004 in float
  assert.equal(m.forecastMargin, '-0.3')
})

test('current cost: open layers weighted by remaining quantity, else the latest layer, else none', () => {
  assert.equal(currentUnitCostBase([{ remainingQty: '10', unitCostBase: '2' }, { remainingQty: '30', unitCostBase: '4' }], '9')?.toFixed(), '3.5')
  assert.equal(currentUnitCostBase([], '9')?.toFixed(), '9')
  assert.equal(currentUnitCostBase([], null), null)
})

test('report rows carry forecast quantity, sales and margin only when asked', async () => {
  const on = await getReorderReport({ thresholdDays: 14, includeZero: true, includeForecastMoney: true }, { deps: deps() })
  const row = on.rows[0]!
  assert.equal(row.averageDailyDemand, '1.5')
  assert.equal(row.forecastQty, '84') // 1.5/day x 8 weeks x 7
  assert.equal(row.forecastSales, '840')
  assert.equal(row.forecastMargin, '504')
  assert.ok(on.notices.some((n) => /forward-looking estimates, not booked sales/.test(n)))
  const off = await getReorderReport({ thresholdDays: 14, includeZero: true }, { deps: deps() })
  for (const key of ['forecastQty', 'forecastSales', 'forecastMargin', 'forecastSalesUnavailable', 'forecastMarginUnavailable']) assert.equal(key in off.rows[0]!, false)
})

test('report: a product with no cost layers reports margin unavailable with a reason', async () => {
  const report = await getReorderReport({ thresholdDays: 14, includeZero: true, includeForecastMoney: true }, { deps: deps({ unitCostBase: null }) })
  const row = report.rows[0]!
  assert.equal(row.forecastSales, '840')
  assert.equal(row.forecastMargin, null)
  assert.equal(row.forecastMarginUnavailable, NO_COST_HISTORY_TEXT)
})

test('report: VAT-inclusive list price is stripped of VAT before forecast sales', async () => {
  const report = await getReorderReport({ thresholdDays: 14, includeZero: true, includeForecastMoney: true }, { deps: deps({ salesPrice: '12', salesPriceTaxInclusive: true, salesVatRate: 0.2 }) })
  assert.equal(report.rows[0]!.forecastSales, '840') // 84 x 10 ex-VAT
})

// ---- growth factor ------------------------------------------------------------------------------

test('growth 0, undefined and empty leave the report byte-identical', async () => {
  const base = JSON.stringify(await getReorderReport({ thresholdDays: 14, includeZero: true }, { deps: deps() }))
  assert.equal(JSON.stringify(await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 0 }, { deps: deps() })), base)
  assert.equal(JSON.stringify(await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: undefined }, { deps: deps() })), base)
  assert.equal(JSON.stringify(await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: '' as never }, { deps: deps() })), base)
})

test('growth +50% scales demand, reorder point, suggestion and the dates consistently', async () => {
  const base = (await getReorderReport({ thresholdDays: 14, includeZero: true }, { deps: deps(undefined, 12) })).rows[0]!
  const grown = (await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 50 }, { deps: deps(undefined, 12) })).rows[0]!
  assert.equal(base.averageDailyDemand, '1.5')
  assert.equal(grown.averageDailyDemand, '2.25')
  // reorder point = demand x lead 7 + safety 3
  assert.equal(base.reorderPoint, '14')   // 10.5 + 3 = 13.5 -> 14
  assert.equal(grown.reorderPoint, '19')  // 15.75 + 3 = 18.75 -> 19
  // order-up-to = reorder point + 56 days of demand, less projected available 12 (below both reorder points)
  assert.equal(base.suggestedReorderQty, '86')   // 13.5 + 84 - 12 = 85.5 -> 86
  assert.equal(grown.suggestedReorderQty, '133') // 18.75 + 126 - 12 = 132.75 -> 133
  // Dates are the same statement as the reorder point: they come from projectStockPosition on the scaled rate.
  const expected = projectStockPosition({ asOf: NOW, openingQty: d(12), averageDailyDemand: d('2.25'), safetyStockQty: d(3), leadTimeDays: 7, inbound: [] })
  assert.equal(grown.requiredReceiptDate, expected.requiredReceiptDate)
  assert.equal(grown.latestPoDate, expected.latestPoDate)
  assert.notEqual(grown.requiredReceiptDate, base.requiredReceiptDate)
  assert.ok(grown.requiredReceiptDate! < base.requiredReceiptDate!)
  assert.ok(grown.firstShortageDate! < base.firstShortageDate!)
})

test('growth also scales forecast quantity, sales and margin', async () => {
  const grown = (await getReorderReport({ thresholdDays: 14, includeZero: true, includeForecastMoney: true, growthPercent: 50 }, { deps: deps() })).rows[0]!
  assert.equal(grown.forecastQty, '126')
  assert.equal(grown.forecastSales, '1260')
  assert.equal(grown.forecastMargin, '756')
})

test('growth notice names the factor; negative growth plans for a decline', async () => {
  const up = await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 50 }, { deps: deps() })
  assert.ok(up.notices.some((n) => /Growth factor \+50% is applied/.test(n)))
  const down = (await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: -20 }, { deps: deps() })).rows[0]!
  assert.equal(down.averageDailyDemand, '1.2')
})

test('growth bounds: out of range is clamped with a notice, non-numeric is ignored with a notice', async () => {
  assert.deepEqual([MIN_GROWTH_PERCENT, MAX_GROWTH_PERCENT], [-90, 500])
  const high = await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 1000 }, { deps: deps() })
  assert.equal(high.rows[0]!.averageDailyDemand, '9') // 1.5 x 6
  assert.ok(high.notices.some((n) => /between -90% and \+500%/.test(n)))
  const low = await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: -95 }, { deps: deps() })
  assert.equal(low.rows[0]!.averageDailyDemand, '0.15') // 1.5 x 0.1
  const junk = await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 'abc' as never }, { deps: deps() })
  assert.equal(junk.rows[0]!.averageDailyDemand, '1.5')
  assert.ok(junk.notices.some((n) => /not a number/.test(n)))
})

test('resolveGrowthPercent: validation table', () => {
  assert.equal(resolveGrowthPercent(undefined).percent, 0)
  assert.equal(resolveGrowthPercent(null).percent, 0)
  assert.equal(resolveGrowthPercent('').percent, 0)
  assert.equal(resolveGrowthPercent('20').percent, 20)
  assert.equal(resolveGrowthPercent(' -20.5 ').percent, -20.5)
  assert.equal(resolveGrowthPercent(500).notice, null)
  assert.equal(resolveGrowthPercent(-90).notice, null)
  assert.equal(resolveGrowthPercent(500.01).percent, 500)
  assert.equal(resolveGrowthPercent(-100).percent, -90)
  assert.equal(resolveGrowthPercent(Number.NaN).percent, 0)
  assert.equal(resolveGrowthPercent(Number.POSITIVE_INFINITY).percent, 0)
  assert.equal(resolveGrowthPercent('1e400').percent, 0)
  assert.equal(resolveGrowthPercent({} as never).percent, 0)
  assert.equal(resolveGrowthPercent(0).factor.toFixed(), '1')
  assert.equal(resolveGrowthPercent(25).factor.toFixed(), '1.25')
  assert.equal(growthForCarry(0), undefined)
  assert.equal(growthForCarry('x'), undefined)
  assert.equal(growthForCarry(50), 50)
  assert.equal(growthForCarry(9999), 500)
})

test('the demand chart agrees with the report row under growth, and is unchanged at 0', async () => {
  const chartDeps = (): ReorderDemandChartDeps => ({ client: client() as ReorderDemandChartDeps['client'], now: () => NOW, loadStockoutHistory: noStockoutHistory })
  const base = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps: chartDeps() })
  const zero = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14, growthPercent: 0 }, deps: chartDeps() })
  assert.equal(JSON.stringify(zero), JSON.stringify(base))
  assert.equal('growthPercent' in base!, false)
  const grown = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14, growthPercent: 50 }, deps: chartDeps() })
  const row = (await getReorderReport({ thresholdDays: 14, includeZero: true, growthPercent: 50 }, { deps: deps() })).rows[0]!
  assert.equal(grown!.growthPercent, 50)
  assert.equal(grown!.averageDailyDemand, 2.25)
  assert.equal(grown!.averageDailyDemand, Number(row.averageDailyDemand))
  assert.equal(grown!.suggestedReorderQty, Number(row.suggestedReorderQty))
  assert.equal(grown!.requiredReceiptDate, row.requiredReceiptDate)
  assert.equal(grown!.latestPoDate, row.latestPoDate)
  assert.equal(grown!.firstShortageDate, row.firstShortageDate)
  const projected = grown!.weeks.find((w) => w.kind === 'forecast')!.projectedDemandQty
  assert.equal(projected, 15.75) // 2.25 x 7
  // History bars are actual sales and are not scaled.
  assert.deepEqual(grown!.weeks.filter((w) => w.kind === 'history').map((w) => w.actualDemandQty), base!.weeks.filter((w) => w.kind === 'history').map((w) => w.actualDemandQty))
  assert.ok(grown!.notices.some((n) => /Growth factor \+50% is applied/.test(n)))
})
