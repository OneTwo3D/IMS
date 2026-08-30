import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma, SalesOrderStatus } from '@/app/generated/prisma/client'
import {
  getCustomerAnalyticsReport,
  getMarginAnalyticsReport,
  getSalesAnalyticsReport,
  type SalesFulfillmentAnalyticsClient,
} from '@/lib/domain/sales/sales-fulfillment-analytics'

/**
 * o3d-kyey. THE ARITHMETIC IN EVERY ASSERTION BELOW IS WORKED OUT IN THE COMMENT ABOVE IT, FROM
 * NAMED INPUTS, AND NEVER BY RE-RUNNING THE IMPLEMENTATION.
 *
 * That is the only kind of test that can catch this defect. The reports did not crash and did not
 * disagree with themselves; they published a confident wrong number. A test that asserts the code
 * agrees with itself — `assert.equal(row.revenueBase, computeTheSameWay(fixture))` — would have
 * been green for the whole four rounds this bug survived.
 */

const D = (value: string | number) => new Prisma.Decimal(value)

function baseClient(): SalesFulfillmentAnalyticsClient {
  const empty = { findMany: async () => [] }
  return {
    // Every product SIMPLE unless a test says otherwise: one self-requirement of factor 1.
    product: {
      findMany: async (args?: unknown) => (args as { where: { id: { in: string[] } } }).where.id.in
        .map((id) => ({ id, type: 'SIMPLE', productComponents: [] })),
    },
    salesOrder: empty,
    salesOrderRefund: empty,
    salesOrderRefundLine: empty,
    cogsEntry: empty,
    stockMovement: empty,
    shipment: empty,
    activityLog: empty,
  }
}

const WINDOW = { dateFrom: '2026-06-01', dateTo: '2026-06-30' }
const NOW = () => new Date('2026-06-30T00:00:00.000Z')

type OrderInput = {
  id: string
  customerId: string
  customerName: string
  totalBase: string
  taxBase: string
  paidAt?: Date | null
  lines: Array<{ id: string; productId: string; totalBase: string; qty?: string }>
}

function order(input: OrderInput) {
  return {
    id: input.id,
    status: SalesOrderStatus.SHIPPED,
    currency: 'GBP',
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: null,
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    expectedDelivery: null,
    paidAt: input.paidAt === undefined ? new Date('2026-06-11T00:00:00.000Z') : input.paidAt,
    totalForeign: D(input.totalBase),
    totalBase: D(input.totalBase),
    taxForeign: D(input.taxBase),
    taxBase: D(input.taxBase),
    shippingForeign: D('0'),
    shippingBase: D('0'),
    discountAmount: D('0'),
    shoppingLinks: [],
    lines: input.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.productId.toUpperCase(),
      description: line.productId,
      qty: D(line.qty ?? '1'),
      totalForeign: D(line.totalBase),
      totalBase: D(line.totalBase),
      taxForeign: D('0'),
      taxBase: D('0'),
      discountAmount: D('0'),
      product: { id: line.productId, sku: line.productId.toUpperCase(), name: line.productId, category: { name: 'Cat' } },
    })),
  }
}

function orderRefund(orderId: string, totalBase: string, totalsBasis: string | null) {
  return { orderId, totalBase: D(totalBase), totalForeign: D(totalBase), totalsBasis }
}

function cogsByOrderRow(orderId: string, totalCostBase: string) {
  return { totalCostBase: D(totalCostBase), movement: { referenceId: orderId } }
}

/** One in-window dispatch movement, linked to the sales line it shipped. */
function dispatch(orderId: string, lineId: string, productId: string, qty: string) {
  return { qty: D(qty), referenceId: orderId, productId, shipmentLine: { lineId } }
}

/**
 * Every line of every order shipped IN FULL, inside the window.
 *
 * Customer Mix measures gross profit against the whole order's revenue, so a fixture that posts a
 * cost and ships nothing is not "an order with a cost" — it is a partially (here, zero-) dispatched
 * order, and the report withholds its profit. Fixtures that mean "this order is fully costed" have
 * to say so with dispatch movements; the ones that mean the opposite are written out by hand.
 */
function dispatchedInFull(orders: Array<ReturnType<typeof order>>) {
  return {
    findMany: async () => orders.flatMap((row) => row.lines.map((line) => dispatch(row.id, line.id, line.productId, line.qty.toString()))),
  }
}

// ---------------------------------------------------------------------------------------------
// Customer Mix
// ---------------------------------------------------------------------------------------------

/** One Acme order: 120 gross, 20 VAT, one line of one unit at an ex-VAT 100. */
const ACME_120 = [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })]
const ACME_120_UNPAID = [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', paidAt: null, lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })]
const ACME_100 = [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })]
const RETURNER_AND_KEEPER = [
  order({ id: 'order-1', customerId: 'cust-1', customerName: 'Returner', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
  order({ id: 'order-2', customerId: 'cust-2', customerName: 'Keeper', totalBase: '60', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '60' }] }),
]
const ACME_AND_BETA = [
  order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
  order({ id: 'order-2', customerId: 'cust-2', customerName: 'Beta', totalBase: '60', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '60' }] }),
]
const ACME_UNPAID_AND_PAID = [
  order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', paidAt: null, lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
  order({ id: 'order-2', customerId: 'cust-1', customerName: 'Acme', totalBase: '50', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '50' }] }),
]

test('customer mix: a full NET credit takes the sale out of net revenue and drives gross profit negative (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_120 },
    stockMovement: dispatchedInFull(ACME_120),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '40')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '100', 'NET')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const row = report.rows[0]!

  // Invoiced revenue is the order total, untouched: 120.
  assert.equal(row.revenueBase, '120')
  // Ex-VAT revenue is 120 - 20 = 100. The credit is stamped NET, so it IS the same unit: 100 - 100 = 0.
  assert.equal(row.netRevenueExVatBase, '0')
  // Gross profit is that ex-VAT net revenue less the posted cost: 0 - 40 = -40.
  // Before o3d-kyey this row read 120 - 40 = 80: it saw no refund, and it subtracted an ex-tax cost
  // from a VAT-inclusive revenue.
  assert.equal(row.grossProfitBase, '-40')
  assert.equal(row.grossProfitBaseBound, 'exact')
  assert.equal(row.costCaptured, true)
  // The GROSS-basis figure cannot absorb a NET credit — 100 ex-VAT is not 100 VAT-inclusive — so it
  // stays 120 and says it is at most the truth, with the 100 it could not place stated beside it.
  assert.equal(row.netRevenueBase, '120')
  assert.equal(row.netRevenueBaseBound, 'upper')
  assert.equal(row.refundsNetBasis, '100')
  assert.equal(row.refundsGrossBasis, '0')
})

test('customer mix: a full GROSS credit clears net revenue, and does NOT get converted into the ex-VAT figure (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_120 },
    stockMovement: dispatchedInFull(ACME_120),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '40')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '120', 'GROSS')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const row = report.rows[0]!

  // GROSS credit against the VAT-inclusive figure: 120 - 120 = 0, and nothing was left over.
  assert.equal(row.netRevenueBase, '0')
  assert.equal(row.netRevenueBaseBound, 'exact')
  // The ex-VAT figure is 100 and the credit is NOT the same unit as it. Converting would need the
  // rate that produced the 120, which a mixed-rate order does not preserve — so the 100 stands, and
  // gross profit stays 100 - 40 = 60, marked `≤`: the truth is at or below it (it is in fact -40).
  assert.equal(row.netRevenueExVatBase, '100')
  assert.equal(row.grossProfitBase, '60')
  assert.equal(row.grossProfitBaseBound, 'upper')
  assert.equal(row.refundsGrossBasis, '120')
})

test('customer mix: an order with no posted cost WITHHOLDS gross profit instead of counting its cost as zero (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: {
      findMany: async () => [
        // Acme: order-1 dispatched (cost posted), order-2 created in the window but not yet dispatched.
        order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
        order({ id: 'order-2', customerId: 'cust-1', customerName: 'Acme', totalBase: '60', taxBase: '10', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '50' }] }),
        // Beta: fully costed, so its figure is publishable and proves the withholding is selective.
        order({ id: 'order-3', customerId: 'cust-2', customerName: 'Beta', totalBase: '24', taxBase: '4', lines: [{ id: 'line-3', productId: 'product-1', totalBase: '20' }] }),
      ],
    },
    // order-1 and order-3 shipped what they sold; order-2 shipped nothing, which is why it has no
    // COGS entry either. Written out rather than derived, so the fixture states the difference.
    stockMovement: {
      findMany: async () => [
        dispatch('order-1', 'line-1', 'product-1', '1'),
        dispatch('order-3', 'line-3', 'product-1', '1'),
      ],
    },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '40'), cogsByOrderRow('order-3', '5')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const acme = report.rows.find((row) => row.customerName === 'Acme')!
  const beta = report.rows.find((row) => row.customerName === 'Beta')!

  // Acme's ex-VAT revenue is (120-20) + (60-10) = 150 and only 40 of cost is known. The old figure
  // was 180 - 40 = 140 of "profit", of which 50 was an undispatched order counted as costing nothing.
  assert.equal(acme.grossProfitBase, null)
  assert.equal(acme.costCaptured, false)
  assert.equal(acme.netRevenueExVatBase, '150')
  // Beta is complete: (24 - 4) - 5 = 15.
  assert.equal(beta.grossProfitBase, '15')
  assert.equal(beta.costCaptured, true)
  // The period total covers the costed customers only, and says how many that was: 1 of 2.
  assert.equal(report.totals.grossProfitBase, '15')
  assert.equal(report.totals.costCapturedRows, '1')
})

test('customer mix: rows rank on net revenue, and share of revenue is measured on it (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => RETURNER_AND_KEEPER },
    stockMovement: dispatchedInFull(RETURNER_AND_KEEPER),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0'), cogsByOrderRow('order-2', '0')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '100', 'GROSS')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // Invoiced: Returner 100, Keeper 60 — the old ordering, which put the customer who sent it all
  // back at the top. Net: Returner 100-100 = 0, Keeper 60. So Keeper leads.
  assert.deepEqual(report.rows.map((row) => row.customerName), ['Keeper', 'Returner'])
  assert.equal(report.rows[0]?.netRevenueBase, '60')
  assert.equal(report.rows[1]?.netRevenueBase, '0')
  // Period net revenue is 0 + 60 = 60, so Keeper is 60/60 = 100% of it and Returner is 0%.
  assert.equal(report.rows[0]?.shareOfRevenuePct, '100')
  assert.equal(report.rows[1]?.shareOfRevenuePct, '0')
  assert.equal(report.rows[0]?.shareOfRevenuePctBound, 'exact')
})

test('customer mix: a ratio is bounded by the WHOLE report, not by the row (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_AND_BETA },
    stockMovement: dispatchedInFull(ACME_AND_BETA),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0'), cogsByOrderRow('order-2', '0')] },
    // Only Acme carries credit, and it is on the basis the gross figure cannot use.
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '40', 'NET')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const beta = report.rows.find((row) => row.customerName === 'Beta')!

  // Beta has no credit of its own, so its own net revenue is exact...
  assert.equal(beta.netRevenueBase, '60')
  assert.equal(beta.netRevenueBaseBound, 'exact')
  // ...but its SHARE was divided by a period total that Acme's unplaced credit moves, so the ratio
  // is `?` on every row. Marking it `≤` would be a false claim: place Acme's credit and the period
  // total falls, which pushes Beta's share UP, not down.
  assert.equal(beta.shareOfRevenuePctBound, 'indeterminate')
  assert.equal(report.rows.every((row) => row.shareOfRevenuePctBound === 'indeterminate'), true)
})

test('customer mix: an exactly-zero credit on the other basis does not degrade the flag (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_100 },
    stockMovement: dispatchedInFull(ACME_100),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0')] },
    // Zero is the one amount identical on both bases, so it carries no basis information at all.
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '0', 'NET'), orderRefund('order-1', '25', 'GROSS')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 100 - 25 = 75, and the zero-value NET row cannot make that inexact.
  assert.equal(report.rows[0]?.netRevenueBase, '75')
  assert.equal(report.rows[0]?.netRevenueBaseBound, 'exact')
})

test('customer mix: AR exposure nets only the credit on UNPAID orders (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_UNPAID_AND_PAID },
    stockMovement: dispatchedInFull(ACME_UNPAID_AND_PAID),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0'), cogsByOrderRow('order-2', '0')] },
    salesOrderRefund: {
      findMany: async () => [
        orderRefund('order-1', '30', 'GROSS'), // unpaid: reduces what is owed
        orderRefund('order-2', '50', 'GROSS'), // already paid: a debt TO the customer, not less owed
      ],
    },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // Exposure is the unpaid order-1 only: 100 - 30 = 70. Order-2's 50 credit must not touch it.
  assert.equal(report.rows[0]?.arExposureBase, '70')
  // Both credits are on the comparable basis, so nothing was left unapplied to the unpaid side.
  assert.equal(report.rows[0]?.arExposureBaseBound, 'exact')
  // Net revenue still sees both: (100 + 50) - (30 + 50) = 70 as well, from a different sum.
  assert.equal(report.rows[0]?.netRevenueBase, '70')
})

// ---------------------------------------------------------------------------------------------
// Gross Margin
// ---------------------------------------------------------------------------------------------

function marginClient(options: {
  lineTotalBase: string
  cogs: string
  refundLines?: Array<{ productId: string | null; salesOrderLineProductId?: string | null; totalBase: string; totalsBasis: string | null }>
  extraCogsProductId?: string
}): SalesFulfillmentAnalyticsClient {
  const productRef = { sku: 'PRODUCT-1', name: 'product-1', category: { name: 'Cat' } }
  return {
    ...baseClient(),
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-1',
        totalCostBase: D(options.cogs),
        movement: {
          referenceType: 'SalesOrder',
          referenceId: 'order-1',
          productId: 'product-1',
          createdAt: new Date('2026-06-12T00:00:00.000Z'),
          product: productRef,
          shipmentLine: { line: { productId: 'product-1', product: productRef } },
        },
      }],
    },
    salesOrder: {
      findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: options.lineTotalBase, taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: options.lineTotalBase }] })],
    },
    stockMovement: {
      findMany: async () => [{ qty: D('1'), referenceId: 'order-1', productId: 'product-1', shipmentLine: { lineId: 'line-1' } }],
    },
    salesOrderRefundLine: {
      findMany: async () => (options.refundLines ?? []).map((line) => ({
        productId: line.productId,
        totalBase: D(line.totalBase),
        salesOrderLine: line.salesOrderLineProductId === undefined ? null : { productId: line.salesOrderLineProductId },
        refund: { totalsBasis: line.totalsBasis },
      })),
    },
  }
}

test('gross margin: a full NET credit takes a dispatched sale to zero revenue and negative profit (o3d-kyey)', async () => {
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [{ productId: 'product-1', salesOrderLineProductId: 'product-1', totalBase: '100', totalsBasis: 'NET' }],
    }),
    now: NOW,
  })
  const row = report.rows[0]!

  // The line dispatched 1 of 1 at an ex-VAT 100, so its in-window revenue is 100. The credit is
  // stamped NET and this report's revenue is ex-VAT, so they are the same unit: 100 - 100 = 0.
  assert.equal(row.revenueBase, '0')
  // 0 - 40 of posted cost = -40. Before o3d-kyey: 100 revenue, 60 profit, 60% margin.
  assert.equal(row.grossProfitBase, '-40')
  // pctString's own guard: a revenue of 0 is not a positive denominator, so the margin is 0%.
  assert.equal(row.marginPct, '0')
  assert.equal(row.revenueBaseBound, 'exact')
  assert.equal(row.marginPctBound, 'exact')
  assert.equal(row.refundsNetBasis, '100')
})

test('gross margin: a GROSS credit is reported and NOT subtracted, and the ratio is marked separately from the amounts (o3d-kyey)', async () => {
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '150',
      refundLines: [{ productId: 'product-1', salesOrderLineProductId: 'product-1', totalBase: '120', totalsBasis: 'GROSS' }],
    }),
    now: NOW,
  })
  const row = report.rows[0]!

  // The 120 is VAT-inclusive and this revenue is ex-VAT, so it stays out: revenue 100, profit -50.
  assert.equal(row.revenueBase, '100')
  assert.equal(row.grossProfitBase, '-50')
  assert.equal(row.refundsGrossBasis, '120')
  // Both amounts move one-for-one with the unsubtracted credit, so both are genuine ceilings.
  assert.equal(row.revenueBaseBound, 'upper')
  assert.equal(row.grossProfitBaseBound, 'upper')
  // The ratio is NOT. Published margin is 100*(1 - 150/100) = -50%. Place the 120 and revenue is
  // negative, at which point the report's own `revenue > 0` guard prints 0% — and 0% is not "at
  // most -50%". marginFigureBound case 4b, which is exactly why the flag alone cannot mark a ratio.
  assert.equal(row.marginPct, '-50')
  assert.equal(row.marginPctBound, 'indeterminate')
})

test('gross margin: credit that reaches no product row is stated, never dropped (o3d-kyey)', async () => {
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        // A monetary/shipping credit line: no product, so no revenue bucket it could belong to.
        { productId: null, salesOrderLineProductId: null, totalBase: '15', totalsBasis: 'NET' },
        // A product this period posted no COGS for, so this report has no row for it. Inventing one
        // would publish a margin over a bucket with revenue and no cost.
        { productId: 'product-9', salesOrderLineProductId: 'product-9', totalBase: '25', totalsBasis: 'NET' },
      ],
    }),
    now: NOW,
  })
  const row = report.rows[0]!

  // product-1's own row is untouched: 100 revenue, 100 - 40 = 60 profit.
  assert.equal(row.revenueBase, '100')
  assert.equal(row.grossProfitBase, '60')
  assert.equal(row.refundsNetBasis, '0')
  // The 40 that reached no row is published, split by why it could not — and ON ITS BASIS. Both
  // credits are stamped NET, so the net buckets carry them and the other four stay empty. A single
  // combined amount per case would be a number in no unit as soon as the two bases were both used.
  assert.equal(report.totals.refundsUnattributedNetBasis, '15')
  assert.equal(report.totals.refundsUnattributedGrossBasis, '0')
  assert.equal(report.totals.refundsUnattributedUnknownBasis, '0')
  assert.equal(report.totals.refundsOutsideReportNetBasis, '25')
  assert.equal(report.totals.refundsOutsideReportGrossBasis, '0')
  assert.equal(report.totals.refundsOutsideReportUnknownBasis, '0')
  // AND it bounds the period figures even though it is on the comparable basis. A NET credit is the
  // same UNIT as this revenue, so the basis test alone would call the total EXACT while 40 of credit
  // sat unsubtracted. Existence of the bound comes from the amount here, not from the basis.
  assert.equal(report.totals.revenueBaseBound, 'upper')
  assert.equal(report.totals.grossProfitBaseBound, 'upper')
  assert.equal(row.contributionPctBound, 'indeterminate')
})

test('gross margin: a KIT credit is attributed through the SALES LINE product, not the refund line product (o3d-kyey)', async () => {
  // The refund line names the leaf component that came back; the sales line names the kit the
  // revenue is priced in. Bucketing on the refund line's own product would leave the kit's revenue
  // uncredited and open a phantom off-report bucket instead — the o3d-7r6x defect, one relation over.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [{ productId: 'component-a', salesOrderLineProductId: 'product-1', totalBase: '30', totalsBasis: 'NET' }],
    }),
    now: NOW,
  })
  const row = report.rows[0]!

  // 100 - 30 = 70 of revenue, 70 - 40 = 30 of profit, and nothing left off-report.
  assert.equal(row.revenueBase, '70')
  assert.equal(row.grossProfitBase, '30')
  assert.equal(report.totals.refundsOutsideReportNetBasis, '0')
  assert.equal(report.totals.refundsOutsideReportGrossBasis, '0')
  assert.equal(report.totals.refundsOutsideReportUnknownBasis, '0')
  assert.equal(row.revenueBaseBound, 'exact')
})

// ---------------------------------------------------------------------------------------------
// Sales Analytics
// ---------------------------------------------------------------------------------------------

test('sales analytics: invoiced revenue still reconciles, and net revenue deducts the gross-basis credit (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: {
      findMany: async () => [
        order({ id: 'order-1', customerId: 'cust-1', customerName: 'Returner', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
        order({ id: 'order-2', customerId: 'cust-2', customerName: 'Keeper', totalBase: '60', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '60' }] }),
      ],
    },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '100', 'GROSS')] },
  }

  const report = await getSalesAnalyticsReport({ ...WINDOW, groupBy: 'customer' }, { client, now: NOW })

  // The invoiced column is untouched — this report's contract is that it reconciles to SalesOrder
  // totals, and a figure net of credit notes cannot also do that: 100 + 60 = 160.
  assert.equal(report.totals.revenue, '160')
  // Net revenue is the same total less the gross-basis credit: 160 - 100 = 60.
  assert.equal(report.totals.netRevenue, '60')
  assert.equal(report.totals.netRevenueBound, 'exact')
  // And the rows rank on it: Returner's 100 invoiced nets to 0, so Keeper's 60 leads.
  assert.deepEqual(report.rows.map((row) => row.label), ['Keeper', 'Returner'])
  assert.equal(report.rows[1]?.netRevenue, '0')
  assert.equal(report.rows[1]?.refundsGrossBasis, '100')
})

test('sales analytics: a NET credit is not subtracted from the VAT-inclusive figure, and says so (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '100', 'NET')] },
  }

  const report = await getSalesAnalyticsReport({ ...WINDOW, groupBy: 'customer' }, { client, now: NOW })

  // 100 ex-VAT is not 100 VAT-inclusive, so nothing comes off: net revenue is still 120, marked `≤`.
  assert.equal(report.rows[0]?.netRevenue, '120')
  assert.equal(report.rows[0]?.netRevenueBound, 'upper')
  assert.equal(report.rows[0]?.refundsNetBasis, '100')
  assert.equal(report.rows[0]?.refundsGrossBasis, '0')
})

test('sales analytics: product grouping allocates the credit by line value and the grand total still reconciles (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: {
      findMany: async () => [order({
        id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '0',
        lines: [
          { id: 'line-1', productId: 'product-1', totalBase: '90' },
          { id: 'line-2', productId: 'product-2', totalBase: '30' },
        ],
      })],
    },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '40', 'GROSS')] },
  }

  const report = await getSalesAnalyticsReport({ ...WINDOW, groupBy: 'product' }, { client, now: NOW })
  const p1 = report.rows.find((row) => row.key === 'product-1')!
  const p2 = report.rows.find((row) => row.key === 'product-2')!

  // Line values are 90 and 30 of 120, so the order total splits 90/30 and the 40 credit splits
  // 40*90/120 = 30 and 40*30/120 = 10 — the report's own allocation rule, the one it already uses
  // for order-level tax, shipping and discount.
  assert.equal(p1.revenue, '90')
  assert.equal(p2.revenue, '30')
  assert.equal(p1.netRevenue, '60') // 90 - 30
  assert.equal(p2.netRevenue, '20') // 30 - 10
  // Whatever the split, the whole credit reaches some row: 120 - 40 = 80.
  assert.equal(report.totals.revenue, '120')
  assert.equal(report.totals.netRevenue, '80')
})

test('customer mix: AR exposure is bounded by the credit it could not apply (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_120_UNPAID },
    stockMovement: dispatchedInFull(ACME_120_UNPAID),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '100', 'NET')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // A NET credit is real relief on a VAT-inclusive exposure, but not the same unit as it, so the
  // 120 stands and says it is at most what is owed. Publishing 120 unmarked would be a claim.
  assert.equal(report.rows[0]?.arExposureBase, '120')
  assert.equal(report.rows[0]?.arExposureBaseBound, 'upper')
  assert.equal(report.totals.arExposureBaseBound, 'upper')
})


// ---------------------------------------------------------------------------------------------
// Customer Mix: is the cost COMPLETE for the revenue it is measured against?
// ---------------------------------------------------------------------------------------------

test('customer mix: a PARTIALLY dispatched order withholds gross profit — a partial cost is not a complete one (o3d-kyey)', async () => {
  // Ten units ordered at an ex-VAT 10 each; ONE of them shipped in the window, so one unit's cost
  // is posted. The order is in ACTIVE_ORDER_STATUSES and carries a COGS entry, so "does any cost
  // exist?" answers yes — and answering that question is the defect: the published profit would set
  // one unit's cost against ten units' revenue.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '1')] },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '4')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const row = report.rows[0]!

  // Ex-VAT revenue is the whole order: 120 - 20 = 100.
  assert.equal(row.netRevenueExVatBase, '100')
  // The old rule published 100 - 4 = 96 of "gross profit" at a 96% margin, from one shipped unit of
  // ten. Nine units' cost is not zero, it is unposted, so there is no complete figure to publish.
  assert.equal(row.grossProfitBase, null)
  assert.equal(row.costCaptured, false)
  // And it is excluded from the period total, which says how many customers it does cover: 0 of 1.
  assert.equal(report.totals.grossProfitBase, '0')
  assert.equal(report.totals.costCapturedRows, '0')
})

test('customer mix: a FULLY dispatched order still publishes, and an explicit zero cost is still evidence (o3d-kyey)', async () => {
  // The other direction, so the withholding cannot be satisfied by withholding everything. Ten of
  // ten units shipped in the window, and the posted cost is exactly zero — which is a real answer,
  // not a missing one, and the distinction `.has` was introduced to keep.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '10')] },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '0')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 100 of ex-VAT revenue less a posted cost of 0 = 100.
  assert.equal(report.rows[0]?.grossProfitBase, '100')
  assert.equal(report.rows[0]?.costCaptured, true)
  assert.equal(report.totals.costCapturedRows, '1')
})

test('customer mix: a unit dispatched AFTER the window does not complete the in-window cost (o3d-kyey)', async () => {
  // Orders are selected by createdAt, so a dispatch can never fall before the window — but it can
  // fall after it, which puts the cost in the NEXT period's COGS and the revenue in this one. The
  // dispatch query is windowed, so a movement outside it simply is not there: two of three units
  // shipped in the window is a partial cost, exactly as an unshipped unit is.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '90', taxBase: '0',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '90', qty: '3' }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '2')] },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '20')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 90 - 20 = 70 would have been published against three units' revenue for two units' cost.
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costCaptured, false)
  // The revenue figures are untouched: this rule withholds a PROFIT, it does not restate revenue.
  assert.equal(report.rows[0]?.revenueBase, '90')
  assert.equal(report.rows[0]?.netRevenueExVatBase, '90')
})

test('customer mix: a line whose product is gone cannot prove coverage, and fails closed (o3d-kyey)', async () => {
  // SalesOrderLine.productId is nullable — "product deleted / not found". A dispatch movement is
  // attributed through the product, so how much that line shipped is not knowable from stored data.
  // Not knowable is the case this report withholds for, not one it waves through.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '60' }, { id: 'line-2', productId: 'product-2', totalBase: '40' }],
  })]
  orders[0]!.lines[1]!.productId = null as unknown as string
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    // The line that DOES have a product shipped in full, so nothing but the orphaned line is at issue.
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '1')] },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '25')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costCaptured, false)
})

// ---------------------------------------------------------------------------------------------
// Gross Margin: off-row credit is never recombined across bases
// ---------------------------------------------------------------------------------------------

test('gross margin: off-row credit on different bases does not cancel into an exactness claim (o3d-kyey)', async () => {
  // 100 of NET credit and -100 of GROSS credit, both on refund lines naming no product, so both
  // reach no row. They are not the same unit and they are not each other's opposite — but they add
  // to zero, and a report that decided "is there off-row credit?" from that sum would answer no.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '100', totalsBasis: 'NET' },
        { productId: null, salesOrderLineProductId: null, totalBase: '-100', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  // Each amount is published on its own basis, and neither is folded into the other.
  assert.equal(report.totals.refundsUnattributedNetBasis, '100')
  assert.equal(report.totals.refundsUnattributedGrossBasis, '-100')
  // The row itself never saw either credit: 100 of revenue, 100 - 40 = 60 of profit.
  assert.equal(report.totals.revenueBase, '100')
  assert.equal(report.totals.grossProfitBase, '60')
  // And NONE of those figures may be called exact. Before this fix the two amounts summed to 0,
  // `isZero()` was true, and revenue / profit / margin / contribution were all published as EXACT
  // with 200 of credit unaccounted for.
  //
  // What is true instead, worked from the amounts: the credit missing from the net revenue is the
  // 100 NET in full plus the ex-VAT value of a -100 gross, which lies in [-100, 0]. So the missing
  // credit is somewhere in [0, 100] — never negative, so the published figures really are ceilings,
  // and the ceiling is 100. Revenue and profit are `≤`.
  assert.equal(report.totals.revenueBaseBound, 'upper')
  assert.equal(report.totals.grossProfitBaseBound, 'upper')
  // Margin: revenue 100, cogs 40, ceiling 100. 100 - 100 = 0 is not > 0, so it is not the monotone
  // case; revenue 100 >= cogs 40 puts it in marginFigureBound case 4's `upper` half.
  assert.equal(report.totals.marginPctBound, 'upper')
  // The ratio over a report-wide denominator stays `?`, which is where the exactness claim was
  // loudest before: a contribution column of exact percentages over a moved total.
  assert.equal(report.rows[0]?.contributionPctBound, 'indeterminate')
})

test('gross margin: a negative NET off-row credit outweighed by a positive GROSS one is still indeterminate (o3d-kyey)', async () => {
  // -10 NET and +50 GROSS. A signed sum is +40 and looks like a safe ceiling, so a bound built on
  // it would print `≤`. It is not one: the +50 is VAT-inclusive, so its ex-VAT value is anywhere in
  // [0, 50], and the credit actually missing from the net figure is anywhere in [-10, 40]. A
  // NEGATIVE missing credit means the published revenue is too LOW, and `≤` claims the opposite.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '-10', totalsBasis: 'NET' },
        { productId: null, salesOrderLineProductId: null, totalBase: '50', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  assert.equal(report.totals.refundsUnattributedNetBasis, '-10')
  assert.equal(report.totals.refundsUnattributedGrossBasis, '50')
  assert.equal(report.totals.revenueBaseBound, 'indeterminate')
  assert.equal(report.totals.marginPctBound, 'indeterminate')
})

test('gross margin: off-row credit that CAN only lower the figure keeps its ≤, so the rule is not "always indeterminate" (o3d-kyey)', async () => {
  // The counterweight to the two above. +10 NET and +50 GROSS off-row: the missing NET credit is in
  // [10, 60], never negative, so the published revenue really is at or above the truth and `≤` is
  // the honest marker. A fix that answered `indeterminate` to every off-row credit would pass both
  // tests above and destroy the information this one asserts.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '10', totalsBasis: 'NET' },
        { productId: null, salesOrderLineProductId: null, totalBase: '50', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  assert.equal(report.totals.revenueBase, '100')
  assert.equal(report.totals.revenueBaseBound, 'upper')
  // Margin: revenue 100, cogs 40, ceiling on the missing credit 60. 100 - 60 = 40 > 0, so the whole
  // interval sits where the margin function is monotone — marginFigureBound case 3, `upper`.
  assert.equal(report.totals.marginPctBound, 'upper')
  // A ratio over a moved denominator is still never `≤`, whatever the amounts do.
  assert.equal(report.rows[0]?.contributionPctBound, 'indeterminate')
})

// ---------------------------------------------------------------------------------------------
// The CSV half. A file reader has no tooltip, and no page either.
// ---------------------------------------------------------------------------------------------

/**
 * Every disclosure the producer emits has to reach the file, and the CHECK has to be structural.
 *
 * The previous version of this test compared the route's column arrays against the keys of a ROW.
 * That is why it was green while the Gross Margin CSV dropped `refundsUnattributed*` and
 * `refundsOutsideReport*` entirely: those live in `totals`, and a test that only ever looked at
 * `rows[0]` could not see a totals-level figure go missing. The gap was not "one export was
 * uncovered" — all three were — it was that a whole HALF of every producer's output was outside
 * what the test compared.
 *
 * So this goes through the route's real serialiser and asks the file itself, for every export the
 * route can produce: does each row key appear as a CSV column, and does each `totals` key appear in
 * the export metadata? Neither side is hand-listed, so a figure added tomorrow is covered tomorrow.
 */
async function exportedCsv(reportType: string, report: { rows: Record<string, unknown>[]; totals: Record<string, string> }) {
  const { salesAnalyticsCsvResponse } = await import('@/app/api/export/sales-analytics/route')
  const response = salesAnalyticsCsvResponse(reportType as never, report, WINDOW, '2026-06-30')
  return response.text()
}

test('every disclosure a sales-analytics producer emits reaches its CSV — rows as columns, totals as metadata (o3d-kyey)', async () => {
  const { parseCsv } = await import('@/lib/csv')
  const salesClient: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => ACME_100 },
    stockMovement: dispatchedInFull(ACME_100),
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '10')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '10', 'GROSS')] },
  }
  // A margin fixture with credit on BOTH halves: some that reached the product row, and some that
  // reached no row at all. The off-row half is the one that only exists in `totals`.
  const marginReport = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: 'product-1', salesOrderLineProductId: 'product-1', totalBase: '5', totalsBasis: 'NET' },
        { productId: null, salesOrderLineProductId: null, totalBase: '15', totalsBasis: 'NET' },
        { productId: 'product-9', salesOrderLineProductId: 'product-9', totalBase: '25', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  const cases: Array<[string, { rows: Record<string, unknown>[]; totals: Record<string, string> }]> = [
    ['sales', await getSalesAnalyticsReport(WINDOW, { client: salesClient, now: NOW })],
    ['customers', await getCustomerAnalyticsReport(WINDOW, { client: salesClient, now: NOW })],
    ['margin', marginReport],
  ]

  const missing: string[] = []
  for (const [reportType, report] of cases) {
    const body = await exportedCsv(reportType, report)
    const parsed = parseCsv(body)
    // Proof the fixture and the serialiser both reached something real, so nothing below can pass
    // vacuously on an empty report or an empty file.
    assert.ok(parsed.length > 0, `${reportType}: the export produced no data rows`)
    assert.ok(Object.keys(report.rows[0]!).length >= 8, `${reportType}: the producer returned a near-empty row`)
    assert.ok(Object.keys(report.totals).length >= 4, `${reportType}: the producer returned near-empty totals`)

    const columns = Object.keys(parsed[0]!)
    for (const key of Object.keys(report.rows[0]!)) {
      if (!columns.includes(key)) missing.push(`${reportType}: row field ${key} is not a CSV column`)
    }
    for (const key of Object.keys(report.totals)) {
      if (!body.includes(`\r\n# totals.${key},`)) missing.push(`${reportType}: total ${key} is nowhere in the exported file`)
    }
  }
  assert.deepEqual(missing, [], 'These figures are published by the producer and dropped from the file an operator downloads.')
})

test('the Gross Margin CSV carries the credit that reached no product row, with its amount (o3d-kyey)', async () => {
  // The structural test above proves the KEY is present. This one proves the NUMBER is, because a
  // disclosure whose value never reaches the file is the same silence wearing a label.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '15', totalsBasis: 'NET' },
        { productId: 'product-9', salesOrderLineProductId: 'product-9', totalBase: '25', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })
  const body = await exportedCsv('margin', report)

  // Every exported product row shows exact revenue and no credit of its own — which is true, and is
  // exactly why the file needs the rest. 15 of credit named no product; 25 named a product this
  // report has no row for; and the period revenue is bounded, not exact.
  assert.equal(report.rows[0]?.revenueBase, '100')
  assert.equal(report.rows[0]?.refundsNetBasis, '0')
  assert.ok(body.includes('\r\n# totals.refundsUnattributedNetBasis,15'), body.slice(-800))
  assert.ok(body.includes('\r\n# totals.refundsOutsideReportGrossBasis,25'), body.slice(-800))
  assert.ok(body.includes('\r\n# totals.revenueBaseBound,upper'), body.slice(-800))
  // And the basis notice still travels with it: three amounts mean nothing without the sentence.
  assert.match(body, /# refundTreatment,/)
})
