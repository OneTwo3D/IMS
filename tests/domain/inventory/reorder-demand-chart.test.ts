import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, ProductType } from '@/app/generated/prisma/client'
import { getReorderReport, type ReplenishmentReportClient } from '@/lib/domain/inventory/replenishment-reports'
import { getReorderDemandChart, isoWeekStart, type ReorderDemandChartDeps } from '@/lib/domain/inventory/reorder-demand-chart'

const d = (value: string | number) => new Prisma.Decimal(value)
const category = { id: 'category-1', name: 'Finished goods' }
const supplier = { name: 'Supplier A' }
// Wednesday. The Monday of this week is 2027-01-04; the history window crosses the year end.
const NOW = new Date('2027-01-06T10:00:00.000Z')

type Calls = { stockMovement: unknown[]; stockLevel: unknown[]; purchaseOrderLine: unknown[] }

function sale(at: string, qty: number) {
  return { productId: 'product-1', qty: d(qty), totalValueBase: d(0), createdAt: new Date(at), product: { sku: 'SKU-1', name: 'Widget', category, supplierProducts: [{ supplier }] } }
}

function poLine(expectedDelivery: string | null, qty: number) {
  return { productId: 'product-1', qty: d(qty), qtyReceived: d(0), qtyReturned: d(0), po: { supplierId: 'supplier-1', expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null, destinationWarehouseId: 'wh-1', supplier } }
}

function build(options: { sales?: unknown[]; po?: unknown[]; stock?: number } = {}): { deps: ReorderDemandChartDeps; client: ReplenishmentReportClient; calls: Calls } {
  const calls: Calls = { stockMovement: [], stockLevel: [], purchaseOrderLine: [] }
  const empty = { findMany: async () => [] }
  const client = {
    product: {
      findMany: async () => [{
        id: 'product-1', sku: 'SKU-1', name: 'Widget', type: ProductType.SIMPLE, stockUnit: 'pcs',
        reorderPoint: null, reorderQty: d(10), safetyStockQty: d(3), leadTimeDays: 7, observedLeadTimeDays: null,
        category, preferredSupplierId: null, preferredSupplier: null, supplierProducts: [],
      }],
    },
    stockLevel: { findMany: async (args: unknown) => { calls.stockLevel.push(args); return [{ productId: 'product-1', warehouseId: 'wh-1', quantity: d(options.stock ?? 20), reservedQty: d(0), warehouse: { code: 'W1', name: 'Main' } }] } },
    stockMovement: { findMany: async (args: unknown) => { calls.stockMovement.push(args); return options.sales ?? [] } },
    purchaseOrderLine: { findMany: async (args: unknown) => { calls.purchaseOrderLine.push(args); return options.po ?? [] } },
    purchaseReceipt: empty, salesOrderLine: empty, orderAllocation: empty, shipmentLine: empty, productionOrder: empty, bomItem: empty,
    warehouse: { findUnique: async () => ({ name: 'Main Warehouse', code: 'W1' }) },
  } as unknown as ReplenishmentReportClient
  return { deps: { client: client as ReorderDemandChartDeps['client'], now: () => NOW }, client, calls }
}

// 21 units in the 14-day window (2026-12-24 .. 2027-01-06) = 1.5/day. The Sun 12-20 sale is outside it.
const SALES = [
  sale('2026-12-20T12:00:00.000Z', 99),
  sale('2026-12-27T23:59:59.000Z', 7), // Sunday: week of 12-21
  sale('2026-12-28T00:00:00.000Z', 5), // Monday 00:00 UTC: week of 12-28
  sale('2026-12-31T09:00:00.000Z', 3),
  sale('2027-01-03T23:59:59.000Z', 2), // Sunday across the year end: still the week of 12-28
  sale('2027-01-04T00:00:00.000Z', 4), // Monday: week of 01-04 (current)
]

test('isoWeekStart: Monday boundaries in UTC and across a year end', () => {
  assert.equal(isoWeekStart(new Date('2026-12-28T00:00:00.000Z')).toISOString().slice(0, 10), '2026-12-28')
  assert.equal(isoWeekStart(new Date('2027-01-03T23:59:59.999Z')).toISOString().slice(0, 10), '2026-12-28')
  assert.equal(isoWeekStart(new Date('2027-01-04T00:00:00.000Z')).toISOString().slice(0, 10), '2027-01-04')
  assert.equal(isoWeekStart(new Date('2027-01-01T12:00:00.000Z')).toISOString().slice(0, 10), '2026-12-28')
})

test('chart: weekly history buckets, flat-average forecast, lines and week counts', async () => {
  const { deps, calls } = build({ sales: SALES })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart)
  const history = chart.weeks.filter((w) => w.kind === 'history')
  assert.deepEqual(history.map((w) => [w.weekStart, w.actualDemandQty]), [['2026-12-21', 7], ['2026-12-28', 10], ['2027-01-04', 4]])
  assert.equal(history.at(-1)?.isCurrentWeek, true)
  // ceil(14 / 7) history weeks of demand window + the current partial week: bars sum to window demand
  assert.equal(history.reduce((sum, w) => sum + (w.actualDemandQty ?? 0), 0), 21)
  assert.equal(chart.averageDailyDemand, 1.5)
  assert.equal(chart.hasHistory, true)
  // forecastWeeks default = max(12, ceil((7 + 8*7) / 7)) = 12
  assert.equal(chart.forecastWeeks, 12)
  const forecast = chart.weeks.filter((w) => w.kind === 'forecast')
  assert.equal(forecast.length, 12)
  assert.equal(forecast[0]?.weekStart, '2027-01-11')
  assert.ok(forecast.every((w) => w.projectedDemandQty === 10.5 && w.actualDemandQty === null))
  assert.equal(chart.safetyStockQty, 3)
  assert.equal(chart.warehouseName, null) // no warehouse filter: all locations
  // one product only, planning-location scoped (warehouse-less historical rows are kept by the loader)
  const call = calls.stockMovement.at(-1) as { where: { productId?: string } }
  assert.equal(call.where.productId, 'product-1')
})

test('chart: week-history window honours the historyWeeks override', async () => {
  const { deps } = build({ sales: SALES })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, historyWeeks: 3, deps })
  assert.ok(chart)
  assert.equal(chart.historyFrom, '2026-12-17')
  const first = chart.weeks[0]
  assert.equal(first?.weekStart, '2026-12-14')
  assert.equal(chart.weeks.find((w) => w.weekStart === '2026-12-14')?.actualDemandQty, 99) // Sun 12-20 is now inside the window
  assert.equal(chart.weeks.find((w) => w.weekStart === '2026-12-21')?.actualDemandQty, 7)
  assert.equal(chart.averageDailyDemand, 1.5) // the projection rate stays the row's demand-window figure
})

test('chart: a PO landing mid-forecast lifts the position line; required receipt and first shortage markers', async () => {
  const { deps } = build({ sales: SALES, po: [poLine('2027-01-20T00:00:00.000Z', 30)] })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart)
  const byWeek = new Map(chart.weeks.map((w) => [w.weekStart, w]))
  const before = byWeek.get('2027-01-11')?.stockPositionQty // Sun 01-17: 20 - 1.5 x 11
  const after = byWeek.get('2027-01-18')?.stockPositionQty // Sun 01-24: 20 - 1.5 x 18 + 30
  assert.equal(before, 3.5)
  assert.equal(after, 23)
  assert.ok((after ?? 0) > (before ?? 0))
  assert.equal(byWeek.get('2027-01-18')?.inboundQty, 30)
  // required receipt: first day at or below safety stock 3 is 01-18 (before the PO lands on 01-20)
  assert.equal(chart.requiredReceiptDate, '2027-01-18')
  assert.equal(chart.latestPoDate, '2027-01-11')
  assert.equal(chart.latestPoWeekStart, '2027-01-11')
  const receiptWeeks = chart.weeks.filter((w) => w.requiredReceiptQty != null)
  assert.deepEqual(receiptWeeks.map((w) => w.weekStart), ['2027-01-18'])
  assert.equal(receiptWeeks[0]?.requiredReceiptQty, chart.suggestedReorderQty)
  // distinct series: the PO arrival and the required receipt are different fields on the same week
  assert.notEqual(byWeek.get('2027-01-18')?.inboundQty, byWeek.get('2027-01-18')?.requiredReceiptQty)
  // the PO lands the day stock would cross zero (01-20 at -1): it rescues it; the next crossing is 02-09
  assert.equal(chart.firstShortageDate, '2027-02-09')
  assert.equal(chart.firstShortageWeekStart, '2027-02-08')
  assert.deepEqual(chart.weeks.filter((w) => w.isFirstShortageWeek).map((w) => w.weekStart), ['2027-02-08'])
})

test('chart: without a PO the required receipt carries the suggested quantity', async () => {
  const { deps } = build({ sales: SALES, stock: 10 })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart)
  assert.ok(chart.suggestedReorderQty > 0)
  assert.equal(chart.requiredReceiptDate, '2027-01-11')
  assert.equal(chart.weeks.find((w) => w.requiredReceiptQty != null)?.requiredReceiptQty, chart.suggestedReorderQty)
  assert.equal(chart.firstShortageDate, '2027-01-13')
})

test('chart matches the Reorder Planning row it was opened from', async () => {
  const { deps, client } = build({ sales: SALES, po: [poLine('2027-01-20T00:00:00.000Z', 30)] })
  const report = await getReorderReport({ thresholdDays: 14, includeZero: true }, { deps: { client, now: () => NOW } })
  const row = report.rows[0]
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart && row)
  assert.equal(chart.requiredReceiptDate, row.requiredReceiptDate)
  assert.equal(chart.latestPoDate, row.latestPoDate)
  assert.equal(chart.firstShortageDate, row.firstShortageDate)
  assert.equal(chart.suggestedReorderQty, Number(row.suggestedReorderQty))
  assert.equal(chart.reorderPoint, Number(row.reorderPoint))
})

test('chart: empty history is flagged, not drawn', async () => {
  const { deps } = build({ sales: [] })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart)
  assert.equal(chart.hasHistory, false)
  assert.equal(chart.averageDailyDemand, 0)
  assert.ok(chart.notices.some((n) => /No sales demand/.test(n)))
})

test('chart: late and undated PO quantities are reported, not projected', async () => {
  const { deps } = build({ sales: SALES, po: [poLine('2026-12-30T00:00:00.000Z', 8), poLine(null, 5)] })
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14 }, deps })
  assert.ok(chart)
  assert.ok(chart.weeks.every((w) => w.inboundQty === 0))
  assert.ok(chart.notices.some((n) => /8 units on open POs are past their expected delivery date/.test(n)))
  assert.ok(chart.notices.some((n) => /5 units on open POs have no expected delivery date/.test(n)))
})

test('chart: unknown product is null', async () => {
  const { deps } = build({ sales: SALES })
  assert.equal(await getReorderDemandChart({ productId: 'nope', deps }), null)
})

test('chart: warehouse filter scopes stock, demand and POs to the planning location', async () => {
  const { deps, calls } = build({ sales: SALES })
  await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14, warehouseId: 'wh-1' }, deps })
  const movement = calls.stockMovement.at(-1) as { where: { OR?: unknown[] } }
  const chart = await getReorderDemandChart({ productId: 'product-1', filters: { thresholdDays: 14, warehouseId: 'wh-1' }, deps })
  assert.equal(chart?.warehouseName, 'Main Warehouse')
  assert.deepEqual(movement.where.OR, [{ fromWarehouseId: 'wh-1' }, { fromWarehouseId: null }])
  const level = calls.stockLevel.at(-1) as { where: { warehouseId?: string; productId?: string } }
  assert.equal(level.where.warehouseId, 'wh-1')
  assert.equal(level.where.productId, 'product-1')
  const po = calls.purchaseOrderLine.at(-1) as { where: { productId?: string; po: { destinationWarehouseId?: string } } }
  assert.equal(po.where.po.destinationWarehouseId, 'wh-1')
  assert.equal(po.where.productId, 'product-1')
})
