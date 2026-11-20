import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'

/**
 * The COGS Report and Gross Margin must answer for the SAME period on every input (o3d-z5shj): a From after the To collapses to the To day in both, a To-only
 * request resolves the same default From, and the default period is 30 London days (the COGS Report used 31, and an inverted range gave it an empty window).
 * Entries are worked by hand against London days (BST until 25 Oct 2026, GMT after).
 */

const PRODUCT = { id: 'p1', sku: 'SKU-1', name: 'Widget', stockUnit: 'ea', category: null, supplierProducts: [] }
const WAREHOUSE = { id: 'w1', code: 'MAIN', name: 'Main' }

const ENTRIES = [
  ['2026-07-09T22:30:00.000Z', 3], // London 9 July 23:30 BST: outside the collapsed single-day 10 July window
  ['2026-07-10T10:00:00.000Z', 100], // London 10 July
  ['2026-07-20T10:00:00.000Z', 7], // London 20 July
  ['2026-10-21T10:00:00.000Z', 1000], // London 21 Oct: day 31 back from 20 Nov, outside a 30-day default
  ['2026-10-26T10:00:00.000Z', 11], // London 26 Oct: inside the 30-day default
  ['2026-11-01T10:00:00.000Z', 13], // London 1 Nov
  ['2026-11-20T12:00:00.000Z', 17], // London 20 Nov (today)
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


async function both(filters: { dateFrom?: string; dateTo?: string }) {
  const { getCogsReport } = await import('@/lib/domain/inventory/inventory-costing-reports')
  const { getMarginAnalyticsReport } = await import('@/lib/domain/sales/sales-fulfillment-analytics')
  const cogs = await getCogsReport({ ...filters, product: 'Widget' }, { paginate: false })
  const margin = await getMarginAnalyticsReport(filters, {
    now: () => new Date('2026-11-20T12:00:00.000Z'),
    baseCurrency: async () => 'GBP',
    client: { cogsEntry: { findMany: cogsFindMany }, salesOrder: empty, salesOrderRefundLine: empty, salesOrderRefund: empty, shipment: empty, shipmentLine: empty, stockMovement: empty, product: empty, activityLog: empty } as never,
  })
  return { cogs: Number(cogs.totals.cogsBase.exactString()), margin: Number(margin.totals.cogsBase), cogsFrom: cogs.dateFrom, cogsTo: cogs.dateTo }
}

test('an inverted range collapses to the To day in BOTH reports (the COGS Report used to show 0)', async () => {
  const t = await both({ dateFrom: '2026-07-20', dateTo: '2026-07-10' })
  assert.equal(t.margin, 100, 'Gross Margin: the To day, 10 July')
  assert.equal(t.cogs, 100, 'COGS Report: the same day, not an empty window')
  assert.equal(t.cogsFrom, '2026-07-10')
  assert.equal(t.cogsTo, '2026-07-10')
})

test('a To-only request whose default From is later than the To collapses the same way', async () => {
  const realDate = Date
  mock.timers.enable({ apis: ['Date'], now: new realDate('2026-11-20T12:00:00.000Z') })
  try {
    const t = await both({ dateTo: '2026-07-10' })
    assert.equal(t.margin, 100)
    assert.equal(t.cogs, 100)
  } finally {
    mock.timers.reset()
  }
})

test('the default period is the 30 London days ending today (22 Oct..20 Nov), not 31', async () => {
  const realDate = Date
  mock.timers.enable({ apis: ['Date'], now: new realDate('2026-11-20T12:00:00.000Z') })
  try {
    const t = await both({})
    // 30 London days ending 20 Nov start on 22 Oct: 26 Oct (11) + 1 Nov (13) + 20 Nov (17) = 41. The old 31-day default started 21 Oct and added the 1000 entry.
    assert.equal(t.cogsFrom, '2026-10-22')
    assert.equal(t.cogsTo, '2026-11-20')
    assert.equal(t.cogs, 41)
    assert.equal(t.margin, 41)
  } finally {
    mock.timers.reset()
  }
})
