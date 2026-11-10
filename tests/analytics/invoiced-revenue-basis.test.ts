import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { NextRequest } from 'next/server'
import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import {
  INVOICED_ORDER_WHERE,
  isInvoicedOrder,
} from '@/lib/domain/sales/invoiced-revenue-basis'
import { getArAgingReport, getCurrencySummaryReport, type FinanceAnalyticsClient } from '@/lib/domain/finance/finance-period-analytics'
import { getCustomerAnalyticsReport, getSalesAnalyticsReport, type SalesFulfillmentAnalyticsClient } from '@/lib/domain/sales/sales-fulfillment-analytics'

/**
 * ONE INVOICED-REVENUE BASIS ON EVERY REPORT.
 *
 * Seven orders are in the database below. Each report is run for real against an in-memory
 * `salesOrder.findMany` that EVALUATES the `where` it is given, so a report that filters on its own
 * private status list reads a different set of orders and the totals disagree:
 *
 *   counted   A  Xeroom-numbered, unpaid, pending payment ........ 50
 *             B  IMS-posted Xero invoice, no invoice number ........ 70
 *             C  shipped, invoiced, paid ........................... 100
 *             D  refunded (part), invoiced, paid ................... 200
 *   excluded  M  IMS-minted number on a manual order, never posted .. 19
 *             W  WooCommerce order with no number and no invoice ..... 21
 *             X  DRAFT, carries an invoice number ................... 11
 *             Y  PENDING_PAYMENT, never invoiced .................... 13
 *             Z  CANCELLED, carries an invoice ...................... 17
 *
 * Invoiced revenue is therefore 50 + 70 + 100 + 200 = 420 on every report. The old code gave the
 * dashboard and Sales Stats "shipped or refunded" (300), and Sales Analytics / AR Aging "anything
 * not cancelled" (461).
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1' } }),
    requireInternalUser: async () => ({ user: { id: 'u1' } }),
    requireApiAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  },
})
mock.module('@/app/actions/settings', {
  namedExports: { getSetting: async () => '04-06' },
})
mock.module('@/lib/display-timezone', {
  namedExports: { getDisplayTimeZone: async () => 'UTC' },
})

const D = (value: string | number) => new Prisma.Decimal(value)
const NOW = new Date()
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12)
const TODAY = TODAY_NOON.toISOString().slice(0, 10)

type Row = Record<string, unknown>

function row(id: string, total: number, over: Row): Row {
  const paid = over.paidAt != null
  return {
    id, orderNumber: id, externalOrderNumber: null, status: SalesOrderStatus.SHIPPED,
    invoiceNumber: null, accountingInvoiceId: null, refundStatus: 'NONE',
    createdAt: TODAY_NOON, invoicedAt: TODAY_NOON, archived: false, paidAt: null, paymentDueAt: null,
    customerId: 'cust-1', customerName: 'Acme', customerEmail: 'buyer@example.test', salesRep: null,
    currency: 'GBP', expectedDelivery: null,
    totalBase: D(total), totalForeign: D(total), taxBase: D(0), taxForeign: D(0), subtotalBase: D(total),
    shippingBase: D(0), shippingForeign: D(0), discountAmount: D(0), fxRateToBase: D(1),
    pricesIncludeVat: false, taxRatePercent: 0, shoppingLinks: over.invoiceNumber ? [{ connector: 'woocommerce' }] : [], shipFromWarehouse: { code: 'W1' },
    payments: paid ? [{ amount: D(total), paidAt: TODAY_NOON, refundId: null, currency: 'GBP' }] : [],
    refunds: [],
    lines: [{
      id: `${id}-l1`, productId: 'p1', sku: 'P1', description: 'Widget', qty: D(1),
      totalBase: D(total), totalForeign: D(total), taxBase: D(0), taxForeign: D(0), discountAmount: D(0),
      cogsBase: D(0), taxRate: { rate: 0 },
      product: { id: 'p1', sku: 'P1', type: 'SIMPLE', name: 'Widget', category: { name: 'Cat' } },
    }],
    ...over,
  }
}

const PAID = { paidAt: TODAY_NOON }
const ORDERS: Row[] = [
  row('A', 50, { status: SalesOrderStatus.PENDING_PAYMENT, invoiceNumber: 'INV-1' }),
  row('B', 70, { status: SalesOrderStatus.ALLOCATED, accountingInvoiceId: 'xero-b' }),
  row('C', 100, { ...PAID, status: SalesOrderStatus.SHIPPED, invoiceNumber: 'INV-3' }),
  row('D', 200, {
    ...PAID, status: SalesOrderStatus.COMPLETED, invoiceNumber: 'INV-4', refundStatus: 'PARTIAL',
    refunds: [{ totalsBasis: 'NET', totalBase: D(20), lines: [{ productId: 'p1', qty: D(1), totalBase: D(20), salesOrderLine: { totalBase: D(200), taxBase: D(0) } }] }],
  }),
  row('X', 11, { status: SalesOrderStatus.DRAFT, invoiceNumber: 'INV-5' }),
  row('Y', 13, { status: SalesOrderStatus.PENDING_PAYMENT }),
  // IMS-minted number on a manual order (no WooCommerce link), never posted: not proof of an invoice.
  row('M', 19, { status: SalesOrderStatus.SHIPPED, invoiceNumber: 'INV-IMS-1', shoppingLinks: [] }),
  // Linked to WooCommerce but carrying no invoice number and no posted invoice: nothing proves an invoice.
  row('W', 21, { status: SalesOrderStatus.PROCESSING, shoppingLinks: [{ connector: 'woocommerce' }] }),
  row('Z', 17, { status: SalesOrderStatus.CANCELLED, invoiceNumber: 'INV-6', accountingInvoiceId: 'xero-z' }),
]
const COUNTED = ['A', 'B', 'C', 'D']

/** A just-enough Prisma `where` evaluator. Anything it does not know is an error, never a silent pass. */
function matches(record: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((c) => matches(record, c))
    if (key === 'OR') return (cond as Row[]).some((c) => matches(record, c))
    const value = record[key]
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return value === cond
    const c = cond as Record<string, unknown>
    return Object.entries(c).every(([op, arg]) => {
      const cmp = (x: unknown) => (x instanceof Date ? x.getTime() : x)
      switch (op) {
        case 'in': return (arg as unknown[]).includes(value)
        case 'notIn': return !(arg as unknown[]).includes(value)
        case 'not': return arg === null ? value != null : value !== arg
        case 'gte': return value != null && (cmp(value) as number) >= (cmp(arg) as number)
        case 'lte': return value != null && (cmp(value) as number) <= (cmp(arg) as number)
        case 'lt': return value != null && (cmp(value) as number) < (cmp(arg) as number)
        case 'some': return (value as Row[]).some((p) => matches(p, arg as Row))
        default: throw new Error(`where evaluator: unsupported operator ${key}.${op}`)
      }
    })
  })
}

function customerRecord() {
  return {
    id: 'cust-1', firstName: 'Ada', lastName: 'Buyer', email: null, phone: null, company: null, taxNumber: null,
    billingAddress: null, shippingAddress: null, notes: null, active: true, createdAt: TODAY_NOON,
    gdprAnonymisedAt: null, _count: { salesOrders: ORDERS.length },
    salesOrders: ORDERS.map((o) => ({ ...o, _count: { lines: 1 } })),
  }
}

const findOrders = async (args?: { where?: Record<string, unknown> }) => ORDERS.filter((o) => matches(o, args?.where))
const none = { findMany: async () => [] }

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: findOrders },
      product: {
        findMany: async () => [{
          id: 'p1', sku: 'P1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs', barcode: null, mpn: null, weight: null,
          salesPriceBase: null, lifecycleStatus: 'ACTIVE', stockLevels: [],
        }],
      },
      purchaseOrder: none,
      costLayer: none,
      customer: {
        findMany: async () => [customerRecord()],
        findUnique: async () => customerRecord(),
      },
      salesOrderRefund: {
        findMany: async (args: { where?: { order?: Record<string, unknown> } }) =>
          ORDERS.filter((o) => (o.refunds as unknown[]).length > 0 && matches(o, args.where?.order)).map((o) => ({ totalBase: D(20), order: o })),
      },
    },
  },
})

function analyticsClient(): SalesFulfillmentAnalyticsClient {
  return {
    product: {
      findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
        .map((id) => ({ id, type: 'SIMPLE', productComponents: [] })),
    },
    salesOrder: { findMany: findOrders as (args?: unknown) => Promise<unknown[]> },
    salesOrderRefund: { findMany: async () => [{ orderId: 'D', totalBase: D(20), totalForeign: D(20), totalsBasis: 'NET' }] },
    salesOrderRefundLine: none, cogsEntry: none, stockMovement: none, shipment: none, activityLog: none,
  }
}

const sum = (ids: string[]) => ids.reduce((s, id) => s + Number(ORDERS.find((o) => o.id === id)!.totalBase), 0)
const EXPECTED_REVENUE = sum(COUNTED)

test('the shared predicate and the shared where-fragment agree on every fixture order', () => {
  for (const o of ORDERS) {
    assert.equal(
      isInvoicedOrder(o as { status: string; invoiceNumber: string | null; accountingInvoiceId: string | null }),
      matches(o, INVOICED_ORDER_WHERE as Record<string, unknown>),
      `order ${String(o.id)}`,
    )
  }
  assert.deepEqual(ORDERS.filter((o) => matches(o, INVOICED_ORDER_WHERE as Record<string, unknown>)).map((o) => o.id), COUNTED)
  assert.equal(EXPECTED_REVENUE, 420)
})

test('dashboard gross sales is the invoiced basis, not shipped-only', async () => {
  const { getDashboardData } = await import('@/app/actions/dashboard')
  const { kpi } = await getDashboardData('today', 'previous_period')
  assert.equal(kpi.grossSalesCurrent, EXPECTED_REVENUE)
})

test('Sales Statistics gross revenue is the invoiced basis', async () => {
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  const { summary } = await getProductSalesStats()
  assert.equal(summary.totalGrossRevenue, EXPECTED_REVENUE)
})

test('Sales Statistics invoice list and customer aging read the same orders', async () => {
  const { getInvoiceStats, getCustomerAging } = await import('@/app/actions/sales-stats')
  const invoices = await getInvoiceStats()
  assert.deepEqual([...new Set(invoices.map((r) => r.orderNumber))].sort(), COUNTED)
  const aging = await getCustomerAging()
  // Only what is still owed: A and B are unpaid; C and D are paid in full and drop out.
  assert.deepEqual(aging.map((r) => r.orderNumber).sort(), ['A', 'B'])
})

test('Sales Analytics and Customer Mix invoiced revenue is the invoiced basis', async () => {
  const filters = { dateFrom: TODAY, dateTo: TODAY }
  const sales = await getSalesAnalyticsReport(filters, { client: analyticsClient(), now: () => TODAY_NOON })
  assert.equal(Number(sales.totals.revenue), EXPECTED_REVENUE)
  const customers = await getCustomerAnalyticsReport(filters, { client: analyticsClient(), now: () => TODAY_NOON })
  assert.equal(Number(customers.totals.revenueBase), EXPECTED_REVENUE)
})

function financeClient(): FinanceAnalyticsClient {
  return { salesOrder: { findMany: findOrders }, salesOrderLine: none, payment: none, purchaseInvoice: none, fxRate: none }
}

test('AR Aging lists only invoiced, unpaid orders: A and B, 120 outstanding', async () => {
  const report = await getArAgingReport(
    { dateTo: TODAY },
    { deps: { client: financeClient(), now: () => TODAY_NOON, baseCurrency: async () => 'GBP' } },
  )
  assert.equal(Number(report.totals.outstandingBase), sum(['A', 'B']))
})

test('currency summary sales total is the invoiced basis', async () => {
  const report = await getCurrencySummaryReport(
    { dateFrom: TODAY, dateTo: TODAY },
    { deps: { client: financeClient(), now: () => TODAY_NOON, baseCurrency: async () => 'GBP' } },
  )
  assert.equal(Number(report.totals.salesBase), EXPECTED_REVENUE)
})

test('customer lifetime value and the customer page turnover use the invoiced basis with refunds netted', async () => {
  // A 50 + B 70 + C 100 + D (200 less its 20 NET credit; no tax on the fixture, so the NET and gross totals agree) = 400.
  const { getCustomers, getCustomerDetail } = await import('@/app/actions/customers')
  const [customer] = await getCustomers()
  assert.equal(customer!.lifetimeValueBase, 400)
  assert.equal(customer!.currentYearSalesBase, 400)
  assert.equal(customer!.lifetimeValueUpperBound, false)
  assert.equal(customer!.lifetimeValueIndeterminate, false)
  const detail = await getCustomerDetail('cust-1')
  assert.equal(detail!.totalTurnoverBase, 400)
  assert.equal(detail!.annualTurnoverBase[String(TODAY_NOON.getFullYear())], 400)
  assert.equal(detail!.orders.length, ORDERS.length, 'the order list still shows every order')
})

test('Details tab and its export list only invoiced orders', async () => {
  const { getDetails } = await import('@/app/actions/sales-stats')
  const rows = await getDetails()
  assert.deepEqual([...new Set(rows.map((r) => r.orderNumber))].sort(), COUNTED)
  assert.equal(rows.reduce((s, r) => s + r.totalBase, 0), EXPECTED_REVENUE)
})

test('Customer Aging and its CSV list only orders with an outstanding balance, never a paid one', async () => {
  const { getCustomerAging } = await import('@/app/actions/sales-stats')
  const rows = await getCustomerAging()
  assert.ok(!rows.some((r) => ['C', 'D'].includes(r.orderNumber)), 'paid orders are absent from the screen rows')
  assert.ok(rows.every((r) => r.dueAmount > 0))
  // The CSV is built from the same rows.
  const { GET } = await import('@/app/api/export/analytics/route')
  const res = await GET(new NextRequest('http://localhost/api/export/analytics?type=aging'))
  const csv = await res.text()
  const dataRows = csv.trim().split('\n').slice(1)
  assert.equal(dataRows.length, 2)
  assert.ok(!/(^|,)"?[CD]"?,/.test(dataRows.join('\n')), 'no paid order in the CSV')
})

test('customer figures carry the right marker: upper bound for a positive unplaced credit, approximate for a non-positive one', async () => {
  const { getCustomers } = await import('@/app/actions/customers')
  const q = (refunds: unknown[]) => row('Q', 30, { invoiceNumber: 'INV-Q', refunds })
  ORDERS.push(q([{ totalsBasis: null, totalBase: D(5), lines: [] }]))
  try {
    const [upper] = await getCustomers()
    assert.equal(upper!.lifetimeValueUpperBound, true)
    assert.equal(upper!.lifetimeValueIndeterminate, false)
  } finally { ORDERS.pop() }
  ORDERS.push(q([{ totalsBasis: null, totalBase: D(-2), lines: [] }]))
  try {
    const [approx] = await getCustomers()
    assert.equal(approx!.lifetimeValueIndeterminate, true)
    assert.equal(approx!.lifetimeValueUpperBound, false)
  } finally { ORDERS.pop() }
})

test('an order held as paid (paidAt set) with no Payment rows is not in Customer Aging or its CSV', async () => {
  // markSalesOrderPaid and the importer set paidAt without a Payment row; subtracting Payment rows alone would leave the full amount due.
  ORDERS.push(row('P', 55, { invoiceNumber: 'INV-P', paidAt: TODAY_NOON, payments: [] }))
  try {
    const { getCustomerAging } = await import('@/app/actions/sales-stats')
    assert.ok(!(await getCustomerAging()).some((r) => r.orderNumber === 'P'), 'absent from the screen rows')
    const { GET } = await import('@/app/api/export/analytics/route')
    const csv = await (await GET(new NextRequest('http://localhost/api/export/analytics?type=aging'))).text()
    assert.ok(!csv.includes(',P,') && !/^P,/m.test(csv), 'absent from the CSV')
  } finally { ORDERS.pop() }
})

test('Customer Aging nets credits: fully credited is absent, partly credited shows the reduced due, an unprovable credit is flagged', async () => {
  const gross = (n: number) => ({ totalBase: D(n), totalsBasis: 'GROSS', lines: [] })
  ORDERS.push(
    row('F', 80, { invoiceNumber: 'INV-F', refunds: [gross(80)] }),
    row('G', 100, { invoiceNumber: 'INV-G', refunds: [gross(30)] }),
    row('H', 60, { invoiceNumber: 'INV-H', refunds: [{ totalBase: D(10), totalsBasis: null, lines: [] }] }),
  )
  try {
    const { getCustomerAging } = await import('@/app/actions/sales-stats')
    const rows = new Map((await getCustomerAging()).map((r) => [r.orderNumber, r]))
    assert.ok(!rows.has('F'), 'a fully credited unpaid invoice owes nothing')
    assert.equal(rows.get('G')!.dueAmount, 70)
    assert.equal(rows.get('G')!.dueBound, 'exact')
    assert.equal(rows.get('H')!.dueAmount, 60, 'an unplaceable credit comes off nothing')
    assert.equal(rows.get('H')!.dueBound, 'upper', 'and the row says so')

    const { GET } = await import('@/app/api/export/analytics/route')
    const csv = await (await GET(new NextRequest('http://localhost/api/export/analytics?type=aging'))).text()
    const lines = csv.trim().split(/\r?\n/)
    const cols = lines[0]!.split(',')
    const cell = (order: string, col: string) => lines.slice(1).find((l) => l.split(',')[0] === order)?.split(',')[cols.indexOf(col)]
    assert.equal(cell('F', 'dueAmount'), undefined, 'absent from the CSV')
    assert.equal(cell('G', 'dueAmount'), '70.00')
    assert.equal(cell('H', 'dueBound'), 'upper')
  } finally { ORDERS.length -= 3 }
})

test('Invoices tab: an order held as paid with no Payment rows shows balance 0, and a part-paid one still shows its balance', async () => {
  ORDERS.push(
    row('P2', 40, { invoiceNumber: 'INV-P2', paidAt: TODAY_NOON, payments: [] }),
    row('Q2', 90, { invoiceNumber: 'INV-Q2', payments: [{ amount: D(25), paidAt: TODAY_NOON, refundId: null }] }),
  )
  try {
    const { getInvoiceStats } = await import('@/app/actions/sales-stats')
    const rows = await getInvoiceStats()
    assert.equal(rows.find((r) => r.orderNumber === 'P2')!.balance, 0)
    assert.equal(rows.find((r) => r.orderNumber === 'Q2')!.balance, 65)
    const { GET } = await import('@/app/api/export/analytics/route')
    const csv = await (await GET(new NextRequest('http://localhost/api/export/analytics?type=invoices'))).text()
    const lines = csv.trim().split(/\r?\n/); const cols = lines[0]!.split(',')
    const p2 = lines.slice(1).find((l) => l.split(',')[cols.indexOf('orderNumber')] === 'P2')!
    assert.equal(p2.split(',')[cols.indexOf('balance')], '0.00')
  } finally { ORDERS.length -= 2 }
})
