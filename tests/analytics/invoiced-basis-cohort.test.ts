import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { toCsv } from '@/lib/csv'
import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import { getArAgingReport, getCurrencySummaryReport, type FinanceAnalyticsClient } from '@/lib/domain/finance/finance-period-analytics'
import { getMarginAnalyticsReport, type SalesFulfillmentAnalyticsClient } from '@/lib/domain/sales/sales-fulfillment-analytics'
import { invoicedPeriodDate, isInvoicedOrder } from '@/lib/domain/sales/invoiced-revenue-basis'

/**
 * Three follow-ups to the shared invoiced basis:
 *   1. margin revenue, COGS and credit come from ONE cohort of invoiced orders;
 *   2. an order invoiced only by an IMS-posted Xero invoice (no number, no invoicedAt) does not break
 *      the invoice list;
 *   3. a Xeroom-era order (number, no invoicedAt) is placed in a period by its order date.
 */

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) } })

const D = (v: string | number) => new Prisma.Decimal(v)
type Row = Record<string, unknown>
const OPS = new Set(['in', 'notIn', 'not', 'gte', 'lte', 'lt', 'some'])

/** A just-enough Prisma `where` evaluator, including nested relation filters. Unknown operators throw. */
function matches(record: Row | undefined | null, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((c) => matches(record, c))
    if (key === 'OR') return (cond as Row[]).some((c) => matches(record, c))
    const value = record?.[key]
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond
    const c = cond as Row
    const keys = Object.keys(c)
    if (keys.length > 0 && !keys.every((k) => OPS.has(k))) return matches(value as Row, c)
    const cmp = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number
    return keys.every((op) => {
      const arg = c[op]
      switch (op) {
        case 'in': return (arg as unknown[]).includes(value)
        case 'notIn': return !(arg as unknown[]).includes(value)
        case 'not': return arg === null ? value != null : value !== arg
        case 'gte': return value != null && cmp(value) >= cmp(arg)
        case 'lte': return value != null && cmp(value) <= cmp(arg)
        case 'lt': return value != null && cmp(value) < cmp(arg)
        case 'some': return ((value as Row[]) ?? []).some((child) => matches(child, arg as Row))
        default: throw new Error(`unsupported operator ${op}`)
      }
    })
  })
}

const none = { findMany: async () => [] }
const DAY = new Date('2026-06-10T00:00:00.000Z')

// ---------------------------------------------------------------------------------------------
// 1. Margin: one cohort for revenue, cost and credit
// ---------------------------------------------------------------------------------------------

function salesOrder(id: string, over: Row): Row {
  return {
    id, status: SalesOrderStatus.SHIPPED, invoiceNumber: null, accountingInvoiceId: null, archived: false,
    currency: 'GBP', customerId: 'c1', customerName: 'Acme', customerEmail: null, createdAt: DAY, invoicedAt: null,
    expectedDelivery: null, paidAt: null,
    totalForeign: D(100), totalBase: D(100), taxForeign: D(0), taxBase: D(0), shippingForeign: D(0), shippingBase: D(0), discountAmount: D(0),
    shoppingLinks: over.invoiceNumber ? [{ connector: 'woocommerce' }] : [],
    lines: [{
      id: `${id}-l`, productId: 'p1', sku: 'P1', description: 'Widget', qty: D(1), totalForeign: D(100), totalBase: D(100),
      taxForeign: D(0), taxBase: D(0), discountAmount: D(0),
      product: { id: 'p1', sku: 'P1', type: 'SIMPLE', name: 'Widget', category: { name: 'Cat' } },
    }],
    ...over,
  }
}

const MARGIN_ORDERS = [
  salesOrder('inv', { invoiceNumber: 'INV-1' }),
  salesOrder('unp', {}), // shipped, never invoiced
]
const productRef = { sku: 'P1', name: 'Widget', category: { name: 'Cat' } }
const cogs = (orderId: string, cost: string) => ({
  id: `cogs-${orderId}`, totalCostBase: D(cost), qty: D(1), createdAt: DAY,
  movement: {
    id: `mv-${orderId}`, referenceType: 'SalesOrder', referenceId: orderId, productId: 'p1', createdAt: DAY, product: productRef,
    shipmentLine: { line: { productId: 'p1', product: productRef } },
  },
})
const refundLine = (orderId: string, total: string) => ({
  productId: 'p1', totalBase: D(total), salesOrderLine: { productId: 'p1' },
  refund: { totalsBasis: 'NET', refundedAt: DAY, order: MARGIN_ORDERS.find((o) => o.id === orderId) },
})

test('margin: a dispatched order that is not invoiced, and its refund, contribute to neither revenue, cost nor credit', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    product: { findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in.map((id) => ({ id, type: 'SIMPLE', productComponents: [] })) },
    salesOrder: { findMany: async (args?: unknown) => MARGIN_ORDERS.filter((o) => matches(o, (args as { where?: Row }).where)) },
    salesOrderRefund: none,
    salesOrderRefundLine: {
      findMany: async (args?: unknown) => [refundLine('inv', '10'), refundLine('unp', '25')].filter((l) => matches(l, (args as { where?: Row }).where)),
    },
    cogsEntry: { findMany: async () => [cogs('inv', '40'), cogs('unp', '30')] },
    stockMovement: {
      findMany: async () => MARGIN_ORDERS.map((o) => ({ qty: D(1), referenceId: o.id, productId: 'p1', shipmentLine: { lineId: `${String(o.id)}-l` } })),
    },
    shipment: none, activityLog: none,
  }
  const report = await getMarginAnalyticsReport({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, { client, now: () => new Date('2026-06-30T00:00:00.000Z') })
  const row = report.rows[0]!
  // Invoiced order only: revenue 100 less its 10 NET credit = 90, cost 40, profit 50.
  // Old code: revenue 100 (only the invoiced order was loaded) but cost 70 and credit 35, so 100 - 35 - 70 = -5.
  assert.equal(row.revenueBase, '90')
  assert.equal(row.cogsBase, '40')
  assert.equal(row.grossProfitBase, '50')
  assert.equal(row.refundsNetBasis, '10')
})

// ---------------------------------------------------------------------------------------------
// 2 + 3. Xeroom-era and Xero-id-only orders
// ---------------------------------------------------------------------------------------------

const INVOICE_ORDERS: Row[] = [
  // Invoiced by an IMS-posted Xero invoice only: no number, no invoicedAt.
  salesOrder('xero-only', { accountingInvoiceId: 'xero-1', createdAt: new Date('2026-06-10T12:00:00.000Z'), payments: [], refunds: [], orderNumber: 'SO-1', externalOrderNumber: null, salesRep: null }),
  // Xeroom-era: number, no invoicedAt, order date in May.
  salesOrder('xeroom', { invoiceNumber: 'INV-77', createdAt: new Date('2026-05-10T12:00:00.000Z'), payments: [], refunds: [], orderNumber: 'SO-2', externalOrderNumber: null, salesRep: null, totalBase: D(70), totalForeign: D(70) }),
  // IMS-numbered, with invoicedAt.
  salesOrder('dated', { invoiceNumber: 'INV-9', invoicedAt: new Date('2026-06-20T12:00:00.000Z'), createdAt: new Date('2026-06-01T12:00:00.000Z'), payments: [], refunds: [], orderNumber: 'SO-3', externalOrderNumber: null, salesRep: null }),
]

mock.module('@/lib/db', {
  namedExports: { db: { salesOrder: { findMany: async (args?: { where?: Row }) => INVOICE_ORDERS.filter((o) => matches(o, args?.where)) } } },
})

test('invoice list: an order with a Xero id but no invoice number or date does not crash and is dated by its order date', async () => {
  const { getInvoiceStats } = await import('@/app/actions/sales-stats')
  const rows = await getInvoiceStats()
  const byOrder = new Map(rows.map((r) => [r.orderId, r]))
  const xero = byOrder.get('xero-only')!
  assert.equal(xero.invoiceNumber, 'xero-1', 'the Xero id stands in for the missing number')
  assert.equal(xero.invoicedAt, '2026-06-10T12:00:00.000Z', 'dated by the order date')
  assert.equal(byOrder.get('xeroom')!.invoiceNumber, 'INV-77')
  // Newest first by the report date: dated (20 Jun), xero-only (10 Jun), xeroom (10 May).
  assert.deepEqual(rows.map((r) => r.orderId), ['dated', 'xero-only', 'xeroom'])
})

test('invoice list: a Xeroom-era order appears in the period of its order date, and only there', async () => {
  const { getInvoiceStats } = await import('@/app/actions/sales-stats')
  const may = await getInvoiceStats('2026-05-01', '2026-05-31')
  assert.deepEqual(may.map((r) => r.orderId), ['xeroom'])
  const june = await getInvoiceStats('2026-06-01', '2026-06-30')
  assert.deepEqual(june.map((r) => r.orderId).sort(), ['dated', 'xero-only'])
})

test('currency summary places a Xeroom-era order in the period of its order date', async () => {
  const client = { salesOrder: { findMany: async (args?: { where?: Row }) => INVOICE_ORDERS.filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
  const deps = { client, now: () => new Date('2026-06-30T00:00:00.000Z'), baseCurrency: async () => 'GBP' }
  const may = await getCurrencySummaryReport({ dateFrom: '2026-05-01', dateTo: '2026-05-31' }, { deps })
  assert.equal(Number(may.totals.salesBase), 70)
  const june = await getCurrencySummaryReport({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, { deps })
  assert.equal(Number(june.totals.salesBase), 200)
})

test('an order invoiced in July but created in June is a July order, not a June one', async () => {
  // invoicedAt present and outside the window: the order date must NOT pull it back in.
  INVOICE_ORDERS.push(salesOrder('july', {
    invoiceNumber: 'INV-80', invoicedAt: new Date('2026-07-05T12:00:00.000Z'), createdAt: new Date('2026-06-25T12:00:00.000Z'),
    payments: [], refunds: [], orderNumber: 'SO-4', externalOrderNumber: null, salesRep: null,
  }))
  try {
    const { getInvoiceStats } = await import('@/app/actions/sales-stats')
    assert.ok(!(await getInvoiceStats('2026-06-01', '2026-06-30')).some((r) => r.orderId === 'july'))
    assert.ok((await getInvoiceStats('2026-07-01', '2026-07-31')).some((r) => r.orderId === 'july'))
    const client = { salesOrder: { findMany: async (args?: { where?: Row }) => INVOICE_ORDERS.filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
    const deps = { client, now: () => new Date('2026-07-31T00:00:00.000Z'), baseCurrency: async () => 'GBP' }
    const june = await getCurrencySummaryReport({ dateFrom: '2026-06-01', dateTo: '2026-06-30' }, { deps })
    assert.equal(Number(june.totals.salesBase), 200, 'july (100) is not in June')
  } finally {
    INVOICE_ORDERS.pop()
  }
})

test('customer aging ages a Xeroom-era order from its order date', async () => {
  const old = new Date(Date.now() - 100 * 86400000)
  INVOICE_ORDERS.push(salesOrder('aged', {
    invoiceNumber: 'INV-90', createdAt: old, payments: [], refunds: [], taxBase: D(0), shipFromWarehouse: { code: 'W1' },
    orderNumber: 'SO-5', externalOrderNumber: null, salesRep: null,
  }))
  try {
    const { getCustomerAging } = await import('@/app/actions/sales-stats')
    const row = (await getCustomerAging()).find((r) => r.orderNumber === 'SO-5')!
    assert.equal(row.overdue91plus, 100, 'unpaid 100, 100 days old')
  } finally {
    INVOICE_ORDERS.pop()
  }
})

test('a Xeroom-era order created on 31 Oct and paid on 2 Nov lands in November, and is not approximate', async () => {
  INVOICE_ORDERS.push(salesOrder('crossmonth', {
    invoiceNumber: 'INV-120', createdAt: new Date('2026-10-31T22:00:00.000Z'), paidAt: new Date('2026-11-02T09:00:00.000Z'),
    payments: [], refunds: [], orderNumber: 'SO-6', externalOrderNumber: null, salesRep: null, totalBase: D(40), totalForeign: D(40),
  }))
  try {
    const { getInvoiceStats } = await import('@/app/actions/sales-stats')
    assert.ok(!(await getInvoiceStats('2026-10-01', '2026-10-31')).some((r) => r.orderId === 'crossmonth'))
    const nov = (await getInvoiceStats('2026-11-01', '2026-11-30')).find((r) => r.orderId === 'crossmonth')!
    assert.equal(nov.invoicedAt, '2026-11-02T09:00:00.000Z')
    assert.equal(nov.invoicedAtApproximate, false)
    const client = { salesOrder: { findMany: async (args?: { where?: Row }) => INVOICE_ORDERS.filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
    const deps = { client, now: () => new Date('2026-11-30T00:00:00.000Z'), baseCurrency: async () => 'GBP' }
    const oct = await getCurrencySummaryReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { deps })
    assert.equal(Number(oct.totals.salesBase), 0)
    const novReport = await getCurrencySummaryReport({ dateFrom: '2026-11-01', dateTo: '2026-11-30' }, { deps })
    assert.equal(Number(novReport.totals.salesBase), 40)
    assert.ok(!novReport.notices.some((n) => /approximate/.test(n)))
  } finally {
    INVOICE_ORDERS.pop()
  }
})

test('an unpaid Xeroom-era order with no invoice date is dated by the order date and flagged approximate', async () => {
  const { getInvoiceStats } = await import('@/app/actions/sales-stats')
  const row = (await getInvoiceStats('2026-05-01', '2026-05-31')).find((r) => r.orderId === 'xeroom')!
  assert.equal(row.invoicedAtApproximate, true)
  const client = { salesOrder: { findMany: async (args?: { where?: Row }) => INVOICE_ORDERS.filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
  const may = await getCurrencySummaryReport({ dateFrom: '2026-05-01', dateTo: '2026-05-31' }, { deps: { client, now: () => new Date('2026-06-30T00:00:00.000Z'), baseCurrency: async () => 'GBP' } })
  assert.ok(may.notices.some((n) => /approximate/.test(n)), 'the report says some orders are dated approximately')
})

function arReport(orders: Row[], dateTo: string) {
  const client = { salesOrder: { findMany: async (args?: { where?: Row }) => orders.filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
  return getArAgingReport({ dateTo }, { deps: { client, now: () => new Date(`${dateTo}T12:00:00.000Z`), baseCurrency: async () => 'GBP' } })
}

test('AR as-of: a Xeroom order created in October and paid in November is not October AR, nor November AR after payment', async () => {
  // No invoicedAt: Xeroom invoices as the order is paid, so the invoice date is the paid date (2 Nov).
  const paid = new Date('2026-11-02T09:00:00.000Z')
  const order = salesOrder('arx', {
    invoiceNumber: 'INV-130', createdAt: new Date('2026-10-31T22:00:00.000Z'), paidAt: paid,
    payments: [{ amount: D(40), paidAt: paid, refundId: null, currency: 'GBP' }], totalBase: D(40), totalForeign: D(40),
  })
  assert.equal(Number((await arReport([order], '2026-10-31')).totals.outstandingBase), 0, 'no invoice yet on 31 Oct')
  assert.equal(Number((await arReport([order], '2026-11-30')).totals.outstandingBase), 0, 'paid on 2 Nov, so nothing owed on 30 Nov')
})

test('AR as-of: an unpaid Xeroom order with no invoice date is owed from its order date, with the approximate notice', async () => {
  const order = salesOrder('aru', { invoiceNumber: 'INV-131', createdAt: new Date('2026-10-10T12:00:00.000Z'), totalBase: D(70), totalForeign: D(70), payments: [] })
  const report = await arReport([order], '2026-10-31')
  assert.equal(Number(report.totals.outstandingBase), 70)
  assert.ok(report.notices.some((n) => /dated by the order date/.test(n)), 'the AR report carries its own approximate-date notice')
  // And it is not owed before it existed.
  assert.equal(Number((await arReport([order], '2026-10-05')).totals.outstandingBase), 0)
})

test('invoicedAt beats paidAt: invoiced 28 Oct and paid 2 Nov is an October order', async () => {
  INVOICE_ORDERS.push(salesOrder('both', {
    invoiceNumber: 'INV-140', invoicedAt: new Date('2026-10-28T12:00:00.000Z'), paidAt: new Date('2026-11-02T09:00:00.000Z'),
    createdAt: new Date('2026-10-20T12:00:00.000Z'), payments: [], refunds: [], orderNumber: 'SO-7', externalOrderNumber: null, salesRep: null,
  }))
  try {
    const { getInvoiceStats } = await import('@/app/actions/sales-stats')
    const oct = (await getInvoiceStats('2026-10-01', '2026-10-31')).find((r) => r.orderId === 'both')
    assert.equal(oct?.invoicedAt, '2026-10-28T12:00:00.000Z')
    assert.ok(!(await getInvoiceStats('2026-11-01', '2026-11-30')).some((r) => r.orderId === 'both'), 'its paid date must not pull it into November')
  } finally {
    INVOICE_ORDERS.pop()
  }
})

test('AR ageing runs from the invoice date, not the order date', async () => {
  // Created 1 Oct, invoiced 2 Nov, part-paid: 60 still owed on 30 Nov, aged 28 days (1-30 bucket), not 60.
  // (A paidAt-dated order is settled from that date, so paidAt can never be the ageing date of an open receivable.)
  const invoiced = new Date('2026-11-02T09:00:00.000Z')
  const order = salesOrder('arage', {
    invoiceNumber: 'INV-150', createdAt: new Date('2026-10-01T12:00:00.000Z'), invoicedAt: invoiced, totalBase: D(100), totalForeign: D(100),
    payments: [{ amount: D(40), paidAt: invoiced, refundId: null, currency: 'GBP' }],
  })
  const row = (await arReport([order], '2026-11-30')).rows[0]!
  assert.equal(Number(row.outstandingBase), 60)
  assert.equal(Number(row.bucket1), 60, 'aged 28 days (1-30 bucket)')
})

test('AR Aging nets credits: a fully credited unpaid invoice is not outstanding, a part-credited one owes the rest, an unprovable one is flagged', async () => {
  const mk = (id: string, total: number, refund: Row) => salesOrder(id, { invoiceNumber: `INV-${id}`, createdAt: new Date('2026-10-10T12:00:00.000Z'), totalBase: D(total), totalForeign: D(total), payments: [], refunds: [refund] })
  const gross = (n: number): Row => ({ totalBase: D(n), totalsBasis: 'GROSS', lines: [] })
  assert.equal(Number((await arReport([mk('f', 80, gross(80))], '2026-10-31')).totals.outstandingBase), 0)
  assert.equal(Number((await arReport([mk('g', 100, gross(30))], '2026-10-31')).totals.outstandingBase), 70)
  const unproven = await arReport([mk('h', 60, { totalBase: D(10), totalsBasis: null, lines: [] })], '2026-10-31')
  assert.equal(Number(unproven.totals.outstandingBase), 60)
  assert.ok(unproven.notices.some((n) => /upper bound/.test(n)), 'the report flags the unplaceable credit')
})

test('AR as-of: a payment at exactly midnight after the as-of day is not counted', async () => {
  const order = salesOrder('arb', {
    invoiceNumber: 'INV-160', createdAt: new Date('2026-10-10T12:00:00.000Z'), totalBase: D(70), totalForeign: D(70),
    payments: [{ amount: D(70), currency: 'GBP', paidAt: new Date('2026-11-01T00:00:00.000Z'), refundId: null }],
  })
  assert.equal(Number((await arReport([order], '2026-10-31')).totals.outstandingBase), 70, 'paid in November, so still owed on 31 Oct')
})

test('a 100 invoice with a 30 credit is 70 owed in both the Currency Summary and AR Aging (base, and foreign at the booked ratio)', async () => {
  const gross = { totalBase: D(30), totalsBasis: 'GROSS', lines: [], refundedAt: new Date('2026-10-15T12:00:00.000Z') }
  const order = salesOrder('cs', {
    invoiceNumber: 'INV-170', createdAt: new Date('2026-10-10T12:00:00.000Z'), invoicedAt: new Date('2026-10-10T12:00:00.000Z'),
    currency: 'USD', totalBase: D(100), totalForeign: D(125), payments: [], refunds: [gross],
  })
  const client = { salesOrder: { findMany: async (args?: { where?: Row }) => [order].filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
  const deps = { client, now: () => new Date('2026-10-31T00:00:00.000Z'), baseCurrency: async () => 'GBP' }
  const summary = await getCurrencySummaryReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { deps })
  assert.equal(Number(summary.totals.arOutstandingBase), 70)
  assert.equal(Number(summary.rows.find((r) => r.currency === 'USD')!.arOutstandingForeign), 87.5, '70 x 125/100')
  const ar = await arReport([order], '2026-10-31')
  assert.equal(Number(ar.totals.outstandingBase), 70)
})

test('Currency Summary carries the bound of an unplaceable credit in the row, the total, the notice and the CSV', async () => {
  const order = salesOrder('csb', {
    invoiceNumber: 'INV-180', createdAt: new Date('2026-10-10T12:00:00.000Z'), invoicedAt: new Date('2026-10-10T12:00:00.000Z'),
    totalBase: D(100), totalForeign: D(100), payments: [],
    refunds: [{ totalBase: D(100), totalsBasis: null, lines: [], refundedAt: new Date('2026-10-15T12:00:00.000Z') }],
  })
  const client = { salesOrder: { findMany: async (args?: { where?: Row }) => [order].filter((o) => matches(o, args?.where)) }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none } as FinanceAnalyticsClient
  const report = await getCurrencySummaryReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { deps: { client, now: () => new Date('2026-10-31T00:00:00.000Z'), baseCurrency: async () => 'GBP' } })
  // The 100 credit cannot be placed (no basis), so nothing comes off: 100 owed, at most.
  assert.equal(Number(report.totals.arOutstandingBase), 100)
  assert.equal(report.rows[0]!.arOutstandingBound, 'upper')
  assert.equal(report.totals.arOutstandingBound, 'upper')
  assert.ok(report.notices.some((n) => /1 receivable.*could not be placed/.test(n)))
  // The CSV: the export route's own column list (the EXPORT_COLUMNS entry, read from its source, since the route needs the real db) applied to the rows.
  const routeSource = readFileSync(path.join(process.cwd(), 'app/api/export/finance-analytics/route.ts'), 'utf8')
  const listed = /EXPORT_COLUMNS[^=]*=\s*\{[\s\S]*?'currency-summary': \[([^\]]*)\]/.exec(routeSource)?.[1]
  assert.ok(listed, 'found the currency-summary column list in the export route')
  const columns = listed!.split(',').map((c) => c.trim().replace(/'/g, ''))
  assert.ok(columns.includes('arOutstandingBound'), 'the export lists the bound column')
  const csvLines = toCsv(report.rows, columns).trim().split(/\r?\n/)
  assert.equal(csvLines[1]!.split(',')[csvLines[0]!.split(',').indexOf('arOutstandingBound')], 'upper')
})

test('an IMS-minted invoice number with no posted invoice is not an invoiced order', () => {
  assert.equal(isInvoicedOrder({ status: 'SHIPPED', invoiceNumber: 'INV-1', shoppingLinks: [] }), false)
  assert.equal(isInvoicedOrder({ status: 'SHIPPED', invoiceNumber: 'INV-1', shoppingLinks: [{ connector: 'woocommerce' }] }), true)
  assert.equal(isInvoicedOrder({ status: 'SHIPPED', invoiceNumber: 'INV-1', accountingInvoiceId: 'x', shoppingLinks: [] }), true)
})

test('invoicedPeriodDate prefers invoicedAt and falls back to the order date', () => {
  const created = new Date('2026-01-01T00:00:00.000Z')
  assert.equal(invoicedPeriodDate({ invoicedAt: null, createdAt: created }), created)
  const paid = new Date('2026-01-15T00:00:00.000Z')
  assert.equal(invoicedPeriodDate({ invoicedAt: null, paidAt: paid, createdAt: created }), paid)
  const inv = new Date('2026-02-01T00:00:00.000Z')
  assert.equal(invoicedPeriodDate({ invoicedAt: inv, createdAt: created }), inv)
})
