import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-bo89l. The COGS report and the Gross Margin report answer "what did the dispatches of this period cost?", and an operator puts them side by side. Both now
 * window on LONDON days, so for a BST month their COGS totals agree, including the two boundary hours (23:00-24:00Z on the last day of the previous month and on
 * the last day of the month), where the UTC-day Gross Margin used to disagree with the London-day COGS report.
 *
 * Fixture, worked by hand for July 2026 (BST): London July is [2026-06-30T23:00Z, 2026-07-31T23:00Z).
 *   2026-06-30T22:30Z  cost 5    London 30 June  -> out
 *   2026-06-30T23:15Z  cost 30   London  1 July  -> IN   (UTC-day Gross Margin dropped it)
 *   2026-07-15T10:00Z  cost 10   London 15 July  -> IN
 *   2026-07-31T22:30Z  cost 7    London 31 July  -> IN
 *   2026-07-31T23:30Z  cost 40   London  1 Aug   -> out  (UTC-day Gross Margin counted it)
 * July COGS = 30 + 10 + 7 = 47 in BOTH reports.
 */

const PRODUCT = { id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea', category: null, supplierProducts: [] }
const WAREHOUSE = { id: 'w1', code: 'MAIN', name: 'Main' }

const ENTRIES = [
  ['2026-06-30T22:30:00.000Z', 5],
  ['2026-06-30T23:15:00.000Z', 30],
  ['2026-07-15T10:00:00.000Z', 10],
  ['2026-07-31T22:30:00.000Z', 7],
  ['2026-07-31T23:30:00.000Z', 40],
] as const

const rows = ENTRIES.map(([at, cost]) => ({
  id: `cogs-${at}`,
  qty: new Prisma.Decimal(1),
  totalCostBase: new Prisma.Decimal(cost),
  createdAt: new Date(at),
  movement: {
    id: `mv-${at}`, type: 'SALE_DISPATCH', referenceType: null, referenceId: null, productId: 'p1', product: PRODUCT, createdAt: new Date(at),
    fromWarehouseId: 'w1', toWarehouseId: null, fromWarehouse: WAREHOUSE, toWarehouse: null, shipmentLine: null,
  },
}))

const cogsFindMany = async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) => {
  const w = args?.where?.createdAt
  return rows.filter((r) => (!w?.gte || r.createdAt >= w.gte) && (!w?.lt || r.createdAt < w.lt))
}
const empty = { findMany: async () => [] }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      cogsEntry: { findMany: cogsFindMany },
      salesOrder: empty,
      salesOrderRefundLine: empty,
      salesOrderRefund: empty,
      shipmentLine: empty,
      shipment: empty,
      product: { findMany: async () => [{ id: 'p1' }] },
    },
  },
})

async function totals(dateFrom: string, dateTo: string) {
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  const { getMarginAnalyticsReport } = await import('@/lib/domain/sales/sales-fulfillment-analytics')
  const cogs = await getCogsReport({ dateFrom, dateTo, product: 'Widget' }, { paginate: false })
  const margin = await getMarginAnalyticsReport({ dateFrom, dateTo }, {
    now: () => new Date('2026-11-20T12:00:00.000Z'),
    baseCurrency: async () => 'GBP',
    client: { cogsEntry: { findMany: cogsFindMany }, salesOrder: empty, salesOrderRefundLine: empty, salesOrderRefund: empty, shipment: empty, shipmentLine: empty, stockMovement: empty, product: empty, activityLog: empty } as never,
  })
  return { cogs: Number(cogs.totals.cogsBase.exactString()), margin: Number(margin.totals.cogsBase) }
}

test('BST July: the COGS report and Gross Margin report the same COGS (47), boundary hours included', async () => {
  const t = await totals('2026-07-01', '2026-07-31')
  assert.equal(t.cogs, 47)
  assert.equal(t.margin, 47)
})

test('BST June and August: the boundary-hour dispatches move with their London month in both reports', async () => {
  const june = await totals('2026-06-01', '2026-06-30')
  assert.equal(june.cogs, 5, 'June: only the 22:30Z 30 June dispatch')
  assert.equal(june.margin, 5)
  const august = await totals('2026-08-01', '2026-08-31')
  assert.equal(august.cogs, 40, 'August: the 23:30Z 31 July dispatch is London 1 August')
  assert.equal(august.margin, 40)
})
