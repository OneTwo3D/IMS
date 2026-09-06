import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { Prisma, ProductType, SalesOrderStatus } from '@/app/generated/prisma/client'
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
  /** NULL for a guest order — the grouping key then falls back to the email, and failing that the name. */
  customerId: string | null
  id: string
  customerName: string
  /** Defaults to NULL, which is what every test written before o3d-7jfq round 4 assumed. */
  customerEmail?: string | null
  totalBase: string
  taxBase: string
  paidAt?: Date | null
  lines: Array<{ id: string; productId: string; totalBase: string; qty?: string; productType?: ProductType }>
}

function order(input: OrderInput) {
  return {
    id: input.id,
    status: SalesOrderStatus.SHIPPED,
    currency: 'GBP',
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail ?? null,
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
      // SIMPLE unless the line says otherwise: `orderCostCoverage` reads the type to tell a line
      // with no cost to post (NON_INVENTORY) from a line whose cost it cannot establish.
      product: { id: line.productId, sku: line.productId.toUpperCase(), type: line.productType ?? ProductType.SIMPLE, name: line.productId, category: { name: 'Cat' } },
    })),
  }
}

function orderRefund(orderId: string, totalBase: string, totalsBasis: string | null) {
  return { orderId, totalBase: D(totalBase), totalForeign: D(totalBase), totalsBasis }
}

/**
 * The id of the dispatch movement a line's shipment produced.
 *
 * Named, not implied. The report matches posted cost to dispatched units MOVEMENT BY MOVEMENT, so a
 * fixture that can only say "this order carries 40 of cost" cannot express the case that rule
 * exists for: an order whose every unit shipped and whose lines only PARTLY posted their cost.
 */
function dispatchMovementId(orderId: string, lineId: string) {
  return `mv-${orderId}-${lineId}`
}

/** One in-window dispatch movement, linked to the sales line it shipped. */
function dispatch(orderId: string, lineId: string, productId: string, qty: string) {
  return { id: dispatchMovementId(orderId, lineId), qty: D(qty), referenceId: orderId, productId, shipmentLine: { lineId } }
}

/** A COGS entry costing `qty` units OF ONE NAMED DISPATCH MOVEMENT at `totalCostBase`. */
function cogsForDispatch(orderId: string, lineId: string, qty: string, totalCostBase: string) {
  return { totalCostBase: D(totalCostBase), qty: D(qty), movement: { id: dispatchMovementId(orderId, lineId), referenceId: orderId } }
}

/**
 * Every dispatch of `orders` costed IN FULL, each order's whole cost carried on its first line.
 *
 * The companion to `dispatchedInFull`: a fixture that means "this order is completely costed" now
 * has to say so at the movement, because that is where the report reads it.
 */
function costedInFull(orders: Array<ReturnType<typeof order>>, costByOrder: Record<string, string>) {
  return {
    findMany: async () => orders.flatMap((row) => row.lines.map((line, index) => cogsForDispatch(
      row.id,
      line.id,
      line.qty.toString(),
      index === 0 ? (costByOrder[row.id] ?? '0') : '0',
    ))),
  }
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
    cogsEntry: costedInFull(ACME_120, { 'order-1': '40' }),
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
    cogsEntry: costedInFull(ACME_120, { 'order-1': '40' }),
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
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '1', '40'), cogsForDispatch('order-3', 'line-3', '1', '5')] },
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
    cogsEntry: costedInFull(RETURNER_AND_KEEPER, { 'order-1': '0', 'order-2': '0' }),
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
    cogsEntry: costedInFull(ACME_AND_BETA, { 'order-1': '0', 'order-2': '0' }),
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
    cogsEntry: costedInFull(ACME_100, { 'order-1': '0' }),
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
    cogsEntry: costedInFull(ACME_UNPAID_AND_PAID, { 'order-1': '0', 'order-2': '0' }),
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
    cogsEntry: costedInFull(ACME_120_UNPAID, { 'order-1': '0' }),
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
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '1', '4')] },
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
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '10', '0')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 100 of ex-VAT revenue less a posted cost of 0 = 100.
  assert.equal(report.rows[0]?.grossProfitBase, '100')
  assert.equal(report.rows[0]?.costCaptured, true)
  assert.equal(report.totals.costCapturedRows, '1')
})

// ---------------------------------------------------------------------------------------------
// Customer Mix: COVERAGE IS NOT COSTEDNESS — the mirror of the partial-dispatch defect
// ---------------------------------------------------------------------------------------------

/**
 * Two lines, BOTH shipped in full inside the window, and only one of them posts a cost.
 *
 * Ex-VAT revenue 240 - 40 = 200. line-1 is ten units at an ex-VAT 120 and line-2 is five units at
 * an ex-VAT 80; the movements for both are in the window, so `orderCostCoverage` answers `covered`.
 * The order carries a COGS entry, so "does any cost exist?" answers yes as well.
 */
const COVERED_BUT_HALF_COSTED = [order({
  id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '240', taxBase: '40',
  lines: [
    { id: 'line-1', productId: 'product-1', totalBase: '120', qty: '10' },
    { id: 'line-2', productId: 'product-2', totalBase: '80', qty: '5' },
  ],
})]

test('customer mix: every unit shipped but only one line posted its cost — no profit from a PARTIAL cost (o3d-7jfq)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => COVERED_BUT_HALF_COSTED },
    stockMovement: dispatchedInFull(COVERED_BUT_HALF_COSTED),
    // line-1's ten units cost 60. line-2's five units — dispatched, in the window — cost NOTHING,
    // because no entry names its movement. That is the whole fixture.
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '10', '60')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const row = report.rows[0]!

  // Revenue is untouched — this rule withholds a PROFIT, it does not restate revenue.
  assert.equal(row.revenueBase, '240')
  assert.equal(row.netRevenueExVatBase, '200')
  // `coverage === 'covered' && cogsByOrder.has(order.id)` published 200 - 60 = 140 here: five units'
  // cost treated as zero because ONE other line happened to post one. 140 is not a profit, it is a
  // cost that is 40 short wearing a profit's name.
  assert.equal(row.grossProfitBase, null)
  assert.equal(row.grossProfitBaseBound, 'indeterminate')
  assert.equal(row.costCaptured, false)
  assert.equal(report.totals.grossProfitBase, '0')
  assert.equal(report.totals.costCapturedRows, '0')
})

test('customer mix: the SAME order with both lines costed publishes its profit (o3d-7jfq)', async () => {
  // The counterweight, on the identical fixture: the rule above must not be satisfiable by
  // withholding everything with two lines on it. line-1's ten units cost 60 and line-2's five cost
  // 40, so every dispatched unit is a costed unit.
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => COVERED_BUT_HALF_COSTED },
    stockMovement: dispatchedInFull(COVERED_BUT_HALF_COSTED),
    cogsEntry: {
      findMany: async () => [
        cogsForDispatch('order-1', 'line-1', '10', '60'),
        cogsForDispatch('order-1', 'line-2', '5', '40'),
      ],
    },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 200 of ex-VAT revenue less 60 + 40 = 100 of cost.
  assert.equal(report.rows[0]?.grossProfitBase, '100')
  assert.equal(report.rows[0]?.costCaptured, true)
  assert.equal(report.totals.grossProfitBase, '100')
  assert.equal(report.totals.costCapturedRows, '1')
})

test('customer mix: a dispatch costed for PART of its quantity is not a costed dispatch (o3d-7jfq)', async () => {
  // One line, one movement, so no other line can be blamed: ten units shipped in the window and the
  // entry against that movement costs FOUR of them. Presence of an entry is what the DB's own
  // COGS-evidence guard checks, and presence is exactly what this fixture has — so a rule written
  // as "every dispatch has an entry" would wave it through and publish 100 - 24 = 76.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '10')] },
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '4', '24')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  assert.equal(report.rows[0]?.netRevenueExVatBase, '100')
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costCaptured, false)
})

test('customer mix: the costed-quantity tolerance is the FIFO engine\u2019s, to the micro-unit (o3d-7jfq)', async () => {
  // `consumeFifoLayersStrict` absorbs a shortfall of at most 0.000001 and throws above it, so a
  // dispatch costed to within that IS costed and one costed less is not. Both sides are asserted:
  // a tolerance that only ever withholds would fail the first half, and one that never withholds
  // would fail the second.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
  })]
  const withCostedQty = async (costedQty: string) => {
    const client: SalesFulfillmentAnalyticsClient = {
      ...baseClient(),
      salesOrder: { findMany: async () => orders },
      stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '10')] },
      cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', costedQty, '30')] },
    }
    return getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  }

  // Short by exactly the tolerance: costed. 100 of ex-VAT revenue less 30 of cost = 70.
  const absorbed = await withCostedQty('9.999999')
  assert.equal(absorbed.rows[0]?.grossProfitBase, '70')
  assert.equal(absorbed.rows[0]?.costCaptured, true)

  // Short by twice it: not costed, and the same 70 is withheld rather than published.
  const short = await withCostedQty('9.999998')
  assert.equal(short.rows[0]?.grossProfitBase, null)
  assert.equal(short.rows[0]?.costCaptured, false)
})

// ---------------------------------------------------------------------------------------------
// Customer Mix: EXCESS cost evidence — the direction the costed-quantity match did not test
// ---------------------------------------------------------------------------------------------

/**
 * Ten units ordered at an ex-VAT 10 each, all ten shipped inside the window.
 *
 * 120 invoiced with 20 of VAT, so the ex-VAT revenue every profit below is measured against is
 * 120 - 20 = 100. What changes between the tests is only the COGS evidence against the ONE dispatch
 * movement, which is where a costed-quantity rule has to read it.
 */
const TEN_UNITS_ALL_SHIPPED = [order({
  id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
  lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
})]

function reportForCogsEntries(entries: Array<ReturnType<typeof cogsForDispatch>>) {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => TEN_UNITS_ALL_SHIPPED },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '10')] },
    cogsEntry: { findMany: async () => entries },
  }
  return getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
}

/** The standing notice the report raises only when a customer's cost evidence contradicts itself. */
const inconsistentNotice = (report: { notices: string[] }) =>
  report.notices.find((notice) => notice.includes('withheld as INCONSISTENT rather than incomplete'))

test('customer mix: a dispatch costed for MORE units than it moved is withheld, not published (o3d-7jfq)', async () => {
  // The one-sided match. Ten units shipped, and the COGS entry set for that movement is posted
  // TWICE: 20 costed units against a 10-unit movement. `movement.qty - costedQty` is -10, which is
  // not greater than the tolerance, so the movement read as fully costed and BOTH entries reached
  // costByOrder — 30 + 30 = 60 of cost against 100 of ex-VAT revenue, published as a complete
  // gross profit of 40. The true cost is 30 and the true profit 70, so the figure was understated
  // by the whole duplicate and said nothing about it.
  const report = await reportForCogsEntries([
    cogsForDispatch('order-1', 'line-1', '10', '30'),
    cogsForDispatch('order-1', 'line-1', '10', '30'),
  ])
  const row = report.rows[0]!

  // Revenue is untouched: this rule withholds a PROFIT, it does not restate revenue.
  assert.equal(row.revenueBase, '120')
  assert.equal(row.netRevenueExVatBase, '100')
  // 40 is not published, and neither is 70: the evidence contradicts itself, so there is no figure
  // this report is entitled to pick.
  assert.equal(row.grossProfitBase, null)
  assert.equal(row.grossProfitBaseBound, 'indeterminate')
  assert.equal(row.costCaptured, false)
  // AND IT IS NOT THE SAME ANSWER AS AN INCOMPLETE ORDER. Nothing will ship or post to complete
  // this one; somebody has to delete an entry. A reader told only "withheld" goes looking for the
  // missing cost that is not missing.
  assert.equal(row.costEvidence, 'inconsistent')
  assert.equal(report.totals.grossProfitBase, '0')
  assert.equal(report.totals.costCapturedRows, '0')
  assert.equal(report.totals.costInconsistentRows, '1')
  // And the page says so in words, because a count in a CSV total is not a thing anybody reads.
  assert.ok(inconsistentNotice(report), 'the report did not raise the inconsistent-evidence notice')
  assert.match(inconsistentNotice(report)!, /^1 of 1 customers/)
})

test('customer mix: the SAME order costed exactly once still publishes its profit (o3d-7jfq)', async () => {
  // The counterweight on the identical fixture, so the rule above cannot be satisfied by refusing
  // everything: one entry, ten costed units for a ten-unit movement, 30 of cost. A match that
  // rejected any non-shortfall — `excess >= 0` — would withhold here too and fail this.
  const report = await reportForCogsEntries([cogsForDispatch('order-1', 'line-1', '10', '30')])

  // 100 of ex-VAT revenue less 30 of cost = 70.
  assert.equal(report.rows[0]?.grossProfitBase, '70')
  assert.equal(report.rows[0]?.costCaptured, true)
  assert.equal(report.rows[0]?.costEvidence, 'complete')
  assert.equal(report.totals.grossProfitBase, '70')
  assert.equal(report.totals.costCapturedRows, '1')
  assert.equal(report.totals.costInconsistentRows, '0')
  // No contradiction, so no standing warning about one.
  assert.equal(inconsistentNotice(report), undefined)
})

test('customer mix: the costed-quantity tolerance is a SHORTFALL band, and one storage unit of EXCESS contradicts (o3d-7jfq)', async () => {
  // The band is 0.000001 because that is what `consumeFifoLayersStrict` absorbs on the way DOWN: it
  // leaves a residue that small and still treats the movement as costed, so a match tighter than
  // the engine's would withhold a profit the engine has already ruled complete. UPWARDS it absorbs
  // nothing — the engine consumes at most the requested quantity, so it cannot produce excess at
  // all — and 0.000001 is the smallest quantity `Decimal(14,6)` can hold, which is the scale both
  // `StockMovement.qty` and `CogsEntry.qty` are stored at. An excess of exactly that is therefore a
  // whole stored unit somebody posted, not noise. All four points are asserted, so neither a rule
  // that withheld everything nor one that withheld nothing can pass.
  const at = (costedQty: string) => reportForCogsEntries([cogsForDispatch('order-1', 'line-1', costedQty, '30')])

  // OVER by ONE STORAGE UNIT: the smallest excess the schema can express, and contradictory. The
  // 70 the entry would support is not published, because the evidence for it contradicts itself.
  const over = await at('10.000001')
  assert.equal(over.rows[0]?.grossProfitBase, null)
  assert.equal(over.rows[0]?.costEvidence, 'inconsistent')
  assert.equal(over.totals.costInconsistentRows, '1')

  // EXACTLY costed: published. 100 of ex-VAT revenue less 30 of cost = 70.
  const exact = await at('10')
  assert.equal(exact.rows[0]?.grossProfitBase, '70')
  assert.equal(exact.rows[0]?.costEvidence, 'complete')

  // SHORT by exactly the tolerance: still costed, and the same 70 published. The band survives on
  // the side it belongs to — this is the assertion a blanket `excess.abs().gt(0)` would fail.
  const shortAbsorbed = await at('9.999999')
  assert.equal(shortAbsorbed.rows[0]?.grossProfitBase, '70')
  assert.equal(shortAbsorbed.rows[0]?.costEvidence, 'complete')

  // Short by twice it: incomplete — a gap, and NOT reported as a contradiction.
  const short = await at('9.999998')
  assert.equal(short.rows[0]?.grossProfitBase, null)
  assert.equal(short.rows[0]?.costEvidence, 'incomplete')
  assert.equal(short.totals.costInconsistentRows, '0')
})

/**
 * Fifty-one customers, ONE of them contradicted and ranked last.
 *
 * Fifty invoice 200 apiece and rank above the contradicted Gamma on 100, so with the smallest page
 * this report allows (50) Gamma is on page 2 and nothing on page 1 carries the condition.
 */
function fiftyCleanCustomersAndOneContradicted(): SalesFulfillmentAnalyticsClient {
  const clean = Array.from({ length: 50 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return order({
      id: `order-${n}`,
      customerId: `cust-${n}`,
      customerName: `Clean ${n}`,
      totalBase: '200',
      taxBase: '0',
      lines: [{ id: `line-${n}`, productId: `product-${n}`, totalBase: '200', qty: '10' }],
    })
  })
  const gamma = order({ id: 'order-gamma', customerId: 'cust-gamma', customerName: 'Gamma', totalBase: '100', taxBase: '0', lines: [{ id: 'line-gamma', productId: 'product-gamma', totalBase: '100', qty: '10' }] })
  return {
    ...baseClient(),
    salesOrder: { findMany: async () => [...clean, gamma] },
    stockMovement: {
      findMany: async () => [
        ...clean.map((row) => dispatch(row.id, row.lines[0]!.id, row.lines[0]!.productId!, '10')),
        dispatch('order-gamma', 'line-gamma', 'product-gamma', '10'),
      ],
    },
    cogsEntry: {
      findMany: async () => [
        ...clean.map((row) => cogsForDispatch(row.id, row.lines[0]!.id, '10', '30')),
        // Gamma's ten-unit entry, posted twice: twenty costed units for a ten-unit movement.
        cogsForDispatch('order-gamma', 'line-gamma', '10', '10'),
        cogsForDispatch('order-gamma', 'line-gamma', '10', '10'),
      ],
    },
  }
}

test('customer mix: a contradicted customer OUTSIDE the visible page is NAMED in the notice (o3d-7jfq)', async () => {
  // The count and the notice are computed over every group; the rows are then paginated. Fifty
  // clean customers invoice 200 each and Gamma invoices 100, so on the smallest page this report
  // allows Gamma is alone on page 2 — and an operator reading page 1 is told a customer is
  // double-posted with nothing in front of them that is. A count cannot answer "which one", which
  // is the whole reason over-costing was made a status of its own rather than a line in a summary.
  //
  // No VAT anywhere, so ex-VAT revenue is the invoiced figure: each clean customer publishes
  // 200 - 30 = 170, and the period total covers those fifty only, 50 x 170 = 8500. Gamma's row is
  // withheld — neither the 100 - 10 = 90 one entry would support nor the 100 - 20 = 80 both would.
  const report = await getCustomerAnalyticsReport({ ...WINDOW, page: 1, pageSize: 50 }, { client: fiftyCleanCustomersAndOneContradicted(), now: NOW })

  assert.equal(report.pageInfo.totalRows, 51)
  assert.equal(report.pageInfo.totalPages, 2)
  assert.equal(report.rows.length, 50)
  // Nothing on this page carries the condition the notice below is about.
  assert.equal(report.rows.some((row) => row.customerName === 'Gamma'), false)
  assert.equal(report.rows.some((row) => row.costEvidence === 'inconsistent'), false)
  assert.equal(report.totals.grossProfitBase, '8500')
  assert.equal(report.totals.costCapturedRows, '50')
  assert.equal(report.totals.costInconsistentRows, '1')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.match(notice!, /^1 of 51 customers/)
  // THE ROUTE FROM THE NOTICE TO THE ROW: the Customer cell, the Email cell, the id the CSV export
  // carries, and the group key the row was filed under — see `inconsistentCustomerLabel` for why
  // the name alone is not enough, and why the absent email is a token and not a form of words.
  assert.ok(notice!.endsWith('highest-ranked first: name="Gamma" email=<none> customerId="cust-gamma" group="cust-gamma".'), notice)
  // And ONLY the affected one. Naming every row would be no list at all at the size that matters.
  assert.equal(notice!.includes('Clean '), false)
})

test('customer mix: past the tenth name the notice counts the rest and says where all of them are (o3d-7jfq)', async () => {
  // Eleven contradicted customers, invoiced 1100 down to 100 so the ranking is Cust 01 first and
  // Cust 11 last. Each ships ten units on one dispatch and posts its ten-unit entry TWICE, so every
  // one of them contradicts itself. A notice is one line of prose and a data incident could
  // contradict hundreds, so it names ten, counts the remainder out loud, and points at the CSV
  // export — which is built with `paginate: false` and carries costEvidence on every row.
  const orders = Array.from({ length: 11 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    const revenue = String(1200 - (index + 1) * 100)
    return order({
      id: `order-${n}`,
      customerId: `cust-${n}`,
      customerName: `Cust ${n}`,
      totalBase: revenue,
      taxBase: '0',
      lines: [{ id: `line-${n}`, productId: `product-${n}`, totalBase: revenue, qty: '10' }],
    })
  })
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => orders.map((row) => dispatch(row.id, row.lines[0]!.id, row.lines[0]!.productId!, '10')) },
    cogsEntry: {
      findMany: async () => orders.flatMap((row) => [
        cogsForDispatch(row.id, row.lines[0]!.id, '10', '10'),
        cogsForDispatch(row.id, row.lines[0]!.id, '10', '10'),
      ]),
    },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  assert.equal(report.totals.costInconsistentRows, '11')
  assert.equal(report.totals.costCapturedRows, '0')
  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.match(notice!, /^11 of 11 customers/)
  const named = Array.from({ length: 10 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return `name="Cust ${n}" email=<none> customerId="cust-${n}" group="cust-${n}"`
  }).join('; ')
  assert.ok(notice!.includes(`highest-ranked first: ${named}, and 1 more not named here`), notice)
  // The eleventh is not named, and the sentence that omits it says where it can be found.
  assert.equal(notice!.includes('Cust 11'), false)
  assert.match(notice!, /costEvidence=inconsistent\.$/)
})

// ---------------------------------------------------------------------------------------------
// Customer Mix: WHAT THE NOTICE CLAIMS, AND WHO IT NAMES — o3d-7jfq round 4
// ---------------------------------------------------------------------------------------------

/**
 * A contradicted customer: ten units ordered, ten dispatched on one movement, and that movement's
 * ten-unit COGS entry posted TWICE. Twenty costed units against ten moved.
 *
 * `costPerEntry` is what each of the two entries sums to, because the whole point of round 4 is
 * that the quantity contradiction is independent of the money: at `'0'` the entries are doubled and
 * the total cost is still exactly right.
 */
function contradicted(input: { id: string; customerId: string | null; customerName: string; customerEmail?: string | null; totalBase: string; costPerEntry?: string }) {
  const lineId = `line-${input.id}`
  return {
    order: order({
      id: input.id,
      customerId: input.customerId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      totalBase: input.totalBase,
      taxBase: '0',
      lines: [{ id: lineId, productId: `product-${input.id}`, totalBase: input.totalBase, qty: '10' }],
    }),
    movement: dispatch(input.id, lineId, `product-${input.id}`, '10'),
    entries: [
      cogsForDispatch(input.id, lineId, '10', input.costPerEntry ?? '10'),
      cogsForDispatch(input.id, lineId, '10', input.costPerEntry ?? '10'),
    ],
  }
}

function reportForContradicted(fixtures: Array<ReturnType<typeof contradicted>>) {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => fixtures.map((fixture) => fixture.order) },
    stockMovement: { findMany: async () => fixtures.map((fixture) => fixture.movement) },
    cogsEntry: { findMany: async () => fixtures.flatMap((fixture) => fixture.entries) },
  }
  return getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
}

test('customer mix: the contradiction notice claims the QUANTITY it proved, not duplicated money (o3d-7jfq)', async () => {
  // ROUND 5, FINDING 1 — ON THE FIXTURE ROUND 4 BUILT AND THEN DID NOT BELIEVE.
  // `dispatchCostEvidenceByOrder` compares Σ CogsEntry.qty with StockMovement.qty and never reads
  // totalCostBase. Round 3 said "every report summing COGS is overstating cost by the duplicate";
  // round 4 moved that behind `where duplicate entries are the cause` and kept it. THIS FIXTURE IS
  // THE ANTECEDENT OF THAT CONDITIONAL AND THE NEGATION OF ITS CONSEQUENT: the ten-unit entry is
  // posted TWICE — duplicate entries, and they ARE the cause — at a cost of ZERO each. Costed
  // quantity 20 against a 10-unit movement, contradictory; money 0 + 0 = 0, exactly right and
  // overstating nothing. So "duplicates ⇒ cost overstated" is false, conditioned or not, and the
  // only honest thing the notice can say about money is that it did not look.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme Ltd', totalBase: '200', costPerEntry: '0' }),
  ])

  // 200 invoiced with no VAT, so the ex-VAT revenue is 200 and a report willing to publish would
  // have shown 200 - 0 = 200. It is withheld anyway: the quantity evidence contradicts itself.
  assert.equal(report.rows[0]?.netRevenueExVatBase, '200')
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costEvidence, 'inconsistent')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  // WHAT IT STATES AS FACT: a quantity, and that the money was never looked at.
  assert.ok(notice!.includes('COGS entries for more units than the movement moved'), notice)
  assert.ok(notice!.includes('the costed quantity exceeds the quantity that moved'), notice)
  assert.ok(notice!.includes('Nothing here is proven about the MONEY'), notice)
  assert.ok(notice!.includes('never reads CogsEntry.totalCostBase'), notice)
  // AND THE STATE THE MONEY IS LEFT IN: unmeasured, named as such.
  assert.ok(notice!.includes('The monetary correctness of those entries is UNMEASURED'), notice)
  // AND WHAT IT MUST NOT SAY. An operator sent after a monetary error that does not exist goes
  // looking for cost evidence to delete — on THIS customer, whose posted cost is already correct.
  // Both the round-3 sentence and the round-4 conditional that preserved it are asserted absent;
  // `overstates` catches any third phrasing of the same claim. Round 5's own replacement — the
  // REASSURING conclusion `every cost total is already right` — is asserted absent by
  // `noMonetaryConclusion` below, which bans it in both directions at once.
  assert.equal(notice!.includes('every report that sums COGS entries is overstating cost by the duplicate'), false)
  assert.equal(notice!.includes('where they are the cause every figure that sums CogsEntry.totalCostBase overstates cost by the duplicate'), false)
  assert.equal(notice!.includes('overstates'), false)
})

// ---------------------------------------------------------------------------------------------
// Customer Mix: THE NOTICE SAYS NOTHING ABOUT MONEY, AND THE LABEL SURVIVES BEING RENDERED
//   — o3d-7jfq round 6
// ---------------------------------------------------------------------------------------------

/**
 * EVERY MONETARY CONCLUSION, IN EITHER DIRECTION, THAT THIS NOTICE IS NOT ENTITLED TO DRAW.
 *
 * Round 3 said the cost was overstated. Round 5 deleted that and said, of the zero-cost branch,
 * that `every cost total is already right` — the same unmeasured claim with the sign flipped, and
 * one an operator acts on just as readily by not looking. The check reads `CogsEntry.qty` and never
 * `CogsEntry.totalCostBase`, so it licenses NEITHER, and `Which of the two it is` additionally
 * asserted the two were exhaustive, which nothing establishes.
 *
 * The bans are on the CLAIM's grammar rather than on any one sentence, so a re-phrasing of the same
 * conclusion is caught too. `correct` is deliberately NOT banned: the notice both says the monetary
 * correctness is unmeasured and asks somebody to correct the entries, and a ban that hit those
 * would be a ban this notice cannot satisfy while saying anything true.
 */
const MONETARY_CONCLUSIONS = [
  'overstat', // cost is too high — round 3
  'understat', // cost is too low — the mirror nobody has written yet
  'already right', // round 5's reassurance
  'is already', //  ... and any softening of it
  'which of the two', // and the claim that those are the only two
  'no cost at all', // the branch round 5 named in order to conclude from it
  'cost total is',
  'totals are right',
]

function noMonetaryConclusion(notice: string): void {
  const lower = notice.toLowerCase()
  for (const phrase of MONETARY_CONCLUSIONS) {
    assert.equal(lower.includes(phrase), false, `the notice draws a monetary conclusion it did not measure: ${phrase}`)
  }
}

test('customer mix: the contradiction notice is the SAME words whether the posted cost is right or wrong (o3d-7jfq r6)', async () => {
  // ROUND 6, FINDING 1 — THE STRONGEST FORM OF "IT SAYS NOTHING ABOUT THE MONEY": say it twice,
  // over the two fixtures that differ ONLY in the money, and compare the sentences.
  //
  // Both customers are `cust-1`/`Acme Ltd` invoicing 200 with no VAT, ten units ordered, ten
  // dispatched on one movement, and that movement's ten-unit COGS entry posted TWICE — 20 costed
  // units against 10 moved, contradictory in both. The one difference is what each entry costs:
  //   RIGHT:  0 + 0 = 0 posted against a true cost of 0. Nothing is overstated by a penny.
  //   WRONG: 40 + 40 = 80 posted against a true cost of 40. Overstated by the whole duplicate.
  // A notice that had measured the money — in either direction — could not print one string for
  // both. Byte equality is therefore a proof of silence, and it is a proof that cannot be
  // satisfied by re-wording: any sentence that leans either way breaks it.
  const moneyCorrect = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme Ltd', totalBase: '200', costPerEntry: '0' }),
  ])
  const moneyDoubled = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme Ltd', totalBase: '200', costPerEntry: '40' }),
  ])

  // THE PREMISE, so this cannot pass by the two fixtures being the same fixture. Both rows withhold
  // for the same quantity reason, and the posted cost really does differ: 0 against 80.
  assert.equal(moneyCorrect.rows[0]?.costEvidence, 'inconsistent')
  assert.equal(moneyDoubled.rows[0]?.costEvidence, 'inconsistent')
  assert.equal(moneyCorrect.totals.costInconsistentRows, '1')
  assert.equal(moneyDoubled.totals.costInconsistentRows, '1')

  const correctNotice = inconsistentNotice(moneyCorrect)
  const doubledNotice = inconsistentNotice(moneyDoubled)
  assert.ok(correctNotice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(doubledNotice, 'the report did not raise the inconsistent-evidence notice')
  assert.equal(correctNotice, doubledNotice)

  // AND NEITHER OF THEM DRAWS THE CONCLUSION. Equality alone would also be satisfied by a notice
  // that said the same WRONG thing twice.
  noMonetaryConclusion(correctNotice!)
  assert.ok(correctNotice!.includes('Nothing here is proven about the MONEY'), correctNotice)
  assert.ok(correctNotice!.includes('never reads CogsEntry.totalCostBase'), correctNotice)
  assert.ok(correctNotice!.includes('The monetary correctness of those entries is UNMEASURED'), correctNotice)
})

/**
 * WHAT THE OPERATOR ACTUALLY SEES, given the notice is rendered as HTML.
 *
 * `ReportPageTitle` puts each notice in a `whitespace-normal` `TooltipContent`, so the CSS
 * `white-space: normal` rules apply: every run of the document white space characters — space, tab,
 * line feed, carriage return, form feed — is collapsed to a SINGLE space. This is that rule, and
 * nothing more; a label is only distinguishable to the operator if it is still distinct after it.
 */
function asRendered(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, ' ')
}

/** The entries of the notice's `They are, highest-ranked first: …` list, in rank order. */
function noticeEntries(notice: string): string[] {
  const marker = 'highest-ranked first: '
  const list = notice.slice(notice.indexOf(marker) + marker.length)
  return list.replace(/\.$/, '').split('; name=').map((entry, index) => (index === 0 ? entry : `name=${entry}`))
}

test('customer mix: guests whose names differ ONLY in whitespace stay distinguishable after rendering (o3d-7jfq r6)', async () => {
  // ROUND 6, FINDING 2. Round 5 escaped quotes and nothing else, so `Acme Ltd` and `Acme\nLtd` were
  // two group keys (`guest-name:Acme Ltd` / `guest-name:Acme<LF>Ltd`) and two distinct raw label
  // strings — and the notice is rendered as collapsing HTML, which turned both into the one visible
  // string `name="Acme Ltd" … group="guest-name:Acme Ltd"`. Injective in the string, not injective
  // in what is SEEN, and the thing wanted was the second: the collision the labelling exists to
  // remove, surviving one layer further out.
  //
  // Five emailless guests, each named `Acme` and `Ltd` separated by a different invisible thing:
  //   200  a lone ordinary space          — the readable case, which must NOT be escaped
  //   190  a NO-BREAK SPACE (U+00A0)      — renders as a space and is not one
  //   180  two ordinary spaces            — a run, collapsed to one on screen
  //   170  a TAB                          — collapsed to one space on screen
  //   160  a ZERO WIDTH SPACE (U+200B)    — renders as nothing at all
  // Descending revenue, so rank order is exactly that and no tie falls to localeCompare. Each keys
  // on `guest-name:<its own name>`, so there are five groups; the question is only whether the five
  // labels survive being drawn.
  const separators = [' ', '\u00a0', '  ', '\t', '\u200b']
  const report = await reportForContradicted(
    separators.map((separator, index) => contradicted({
      id: `order-${index + 1}`,
      customerId: null,
      customerName: `Acme${separator}Ltd`,
      customerEmail: null,
      totalBase: String(200 - index * 10),
    })),
  )

  // THE PREMISE: five separate groups. A grouping that folded whitespace would make this test
  // vacuous — there would be one row and nothing for the label to tell apart.
  assert.equal(report.rows.length, 5)
  assert.equal(report.totals.costInconsistentRows, '5')
  assert.deepEqual(report.rows.map((row) => row.customerName), separators.map((separator) => `Acme${separator}Ltd`))

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')

  // THE FIVE LABELS, DERIVED BY HAND from the escaping rule: a lone ordinary space is kept because
  // an operator has to read the label against the Customer column; every other invisible character
  // is spelled out, and the second of two consecutive spaces is spelled `\u0020` because the pair
  // renders as one.
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="Acme Ltd" email=<none> customerId=<none> group="guest-name:Acme Ltd"; '
    + 'name="Acme\\u00a0Ltd" email=<none> customerId=<none> group="guest-name:Acme\\u00a0Ltd"; '
    + 'name="Acme \\u0020Ltd" email=<none> customerId=<none> group="guest-name:Acme \\u0020Ltd"; '
    + 'name="Acme\\tLtd" email=<none> customerId=<none> group="guest-name:Acme\\tLtd"; '
    + 'name="Acme\\u200bLtd" email=<none> customerId=<none> group="guest-name:Acme\\u200bLtd".',
  ), notice)

  // AND THE PROPERTY THAT IS ACTUALLY LOAD-BEARING, asserted through the renderer's own rule rather
  // than by reading the strings above: five entries, and no two of them look alike once drawn.
  const entries = noticeEntries(notice!)
  assert.equal(entries.length, 5)
  const rendered = entries.map(asRendered)
  assert.equal(new Set(rendered).size, 5, `two labels render alike: ${rendered.join(' || ')}`)
  // The rendering step is not a no-op on the INPUT it is protecting against — proof this assertion
  // is reached with something to do. The raw names collapse to three distinct strings; the labels
  // built from them collapse to five.
  assert.equal(new Set(separators.map((separator) => asRendered(`Acme${separator}Ltd`))).size, 3)
})

test('customer mix: control and bidi characters in a name reach the operator as visible escapes (o3d-7jfq r6)', async () => {
  // The other half of "invisible": characters that are not whitespace and draw nothing, so a name
  // carrying one is indistinguishable on screen from the same name without it — and one that
  // REORDERS what follows it, so a label could be made to read as another customer's. Two guests,
  // `Acme Ltd` plain on 200 and `Acme Ltd` carrying a RIGHT-TO-LEFT OVERRIDE (U+202E) and a SOFT
  // HYPHEN (U+00AD) on 100. Both key on `guest-name:` plus their own name, so two groups.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: 'Acme Ltd', customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: '\u202eAcme\u00adLtd', customerEmail: null, totalBase: '100' }),
  ])

  assert.equal(report.rows.length, 2)

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="Acme Ltd" email=<none> customerId=<none> group="guest-name:Acme Ltd"; '
    + 'name="\\u202eAcme\\u00adLtd" email=<none> customerId=<none> group="guest-name:\\u202eAcme\\u00adLtd".',
  ), notice)
  // NOTHING INVISIBLE SURVIVES INTO THE OUTPUT. Every code point of the notice is a printable ASCII
  // character or one of the punctuation marks the prose itself uses — so there is no character left
  // in it whose rendering the label's uniqueness could depend on.
  const invisible = Array.from(notice!).filter((char) => {
    const code = char.codePointAt(0)!
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0xa0) || code === 0xad
      || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202f) || code === 0xfeff
  })
  assert.deepEqual(invisible, [])
})

test('customer mix: a name that SPELLS an escape is not the name that contains one (o3d-7jfq r6)', async () => {
  // The sentinel problem again, one level down: the escapes are made of characters a customer can
  // type. A guest literally called `Acme\nLtd` — backslash, letter n — must not wear the label of
  // the guest whose name contains a newline, or round 5's `(no email)` collision is back in a new
  // costume. The backslash doubles, so `\n` in the output can only have come from a newline and
  // `\\n` only from a typed backslash followed by an n. 200 and 100, so rank order is the typed
  // one first.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: 'Acme\\nLtd', customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'Acme\nLtd', customerEmail: null, totalBase: '100' }),
  ])

  // THE PREMISE: two groups, and the first really does store a backslash rather than a newline.
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.rows.map((row) => row.customerName), ['Acme\\nLtd', 'Acme\nLtd'])

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="Acme\\\\nLtd" email=<none> customerId=<none> group="guest-name:Acme\\\\nLtd"; '
    + 'name="Acme\\nLtd" email=<none> customerId=<none> group="guest-name:Acme\\nLtd".',
  ), notice)
  const rendered = noticeEntries(notice!).map(asRendered)
  assert.equal(new Set(rendered).size, 2, rendered.join(' || '))
})

/**
 * WHAT THE OPERATOR SEES, one step beyond the whitespace rule: CANONICAL EQUIVALENCE.
 *
 * Unicode defines two canonically equivalent sequences — `é` as U+00E9, and `é` as `e` followed by
 * COMBINING ACUTE U+0301 — as two spellings of ONE character, and a conforming renderer is REQUIRED
 * to draw them identically. `asRendered` models the CSS whitespace rule; this composes it with NFC,
 * which is exactly the set of pairs a renderer is obliged to make indistinguishable. A label that
 * is distinct only before this is not distinct on screen.
 */
function asSeen(text: string): string {
  return asRendered(text).normalize('NFC')
}

/** The `group=` field of one notice entry, quotes included — it is the last field of the entry. */
function groupField(entry: string): string {
  const marker = ' group='
  return entry.slice(entry.indexOf(marker) + marker.length)
}

/** The readable half of one notice entry: `name=`, `email=` and `customerId=`, without `group=`. */
function readableFields(entry: string): string {
  return entry.slice(0, entry.indexOf(' group='))
}

/** The code points of a string that are not printable ASCII — the ones whose rendering is a guess. */
function nonPrintableAscii(text: string): string[] {
  return Array.from(text).filter((char) => {
    const code = char.codePointAt(0)!
    return code < 0x20 || code > 0x7e
  })
}

test('customer mix: NFC and NFD spellings of one guest name stay distinguishable on screen (o3d-7jfq r7)', async () => {
  // ROUND 7. The round-6 encoder escapes a LIST of code-point ranges and emits every other code
  // point unchanged, so its injectivity-as-rendered holds only for the characters somebody
  // remembered to list. Canonical equivalence is one class further out: `Café` spelled with U+00E9
  // and `Café` spelled `e` + U+0301 are two strings, two group keys and two distinct raw labels —
  // and Unicode REQUIRES a renderer to draw them identically, so on screen they were ONE label.
  // The whitespace collision again, at a character nobody had put on the list, which is why the
  // fix is a rule with no list rather than a longer list.
  const nfc = 'Café'
  const nfd = 'Café'
  assert.notEqual(nfc, nfd)
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'))

  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: nfc, customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: nfd, customerEmail: null, totalBase: '100' }),
  ])

  // THE PREMISE: two groups. A grouping that normalised would make this vacuous — one row, and
  // nothing for the label to tell apart.
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.costInconsistentRows, '2')
  assert.deepEqual(report.rows.map((row) => row.customerName), [nfc, nfd])

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')

  // DERIVED BY HAND from the split: `name=` prints the name as stored, because it exists to be read
  // against the Customer column; `group=` is ASCII-only, so U+00E9 and U+0301 are spelled out.
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="Café" email=<none> customerId=<none> group="guest-name:Caf\\u00e9"; '
    + 'name="Café" email=<none> customerId=<none> group="guest-name:Cafe\\u0301".',
  ), notice)

  // AND THE PROPERTY THAT IS LOAD-BEARING, asserted through the rendering model rather than by
  // reading the strings above: two entries, and no two of them look alike once drawn.
  const entries = noticeEntries(notice!)
  assert.equal(entries.length, 2)
  const seen = entries.map(asSeen)
  assert.equal(new Set(seen).size, 2, `two labels look alike on screen: ${seen.join(' || ')}`)

  // NOT VACUOUS, AND `group=` IS WHAT DOES IT. The two raw names fold to one on screen, and so does
  // the whole readable half of both entries — so the distinctness above cannot have come from
  // `name=`, `email=` or `customerId=`. Only the identity field separates these two rows.
  assert.equal(new Set([nfc, nfd].map(asSeen)).size, 1)
  assert.equal(new Set(entries.map(readableFields).map(asSeen)).size, 1)
})

test('customer mix: guest names differing only in a non-ASCII homoglyph stay distinguishable (o3d-7jfq r7)', async () => {
  // THE CLASS NORMALISATION CANNOT FIX, so that the fix has to be the encoding and not an NFC pass.
  // GREEK CAPITAL ALPHA (U+0391) and CYRILLIC CAPITAL A (U+0410) are distinct code points, stay
  // distinct under every normalisation form, and are drawn with the same glyph in every font that
  // carries both. Two emailless guests whose names differ in nothing else; 200 and 100, so rank
  // order is Greek then Cyrillic and no tie falls to localeCompare.
  const greek = 'Αcme Ltd'
  const cyrillic = 'Аcme Ltd'
  assert.notEqual(greek.normalize('NFC'), cyrillic.normalize('NFC'))
  assert.notEqual(greek.normalize('NFKC'), cyrillic.normalize('NFKC'))

  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: greek, customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: cyrillic, customerEmail: null, totalBase: '100' }),
  ])

  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.rows.map((row) => row.customerName), [greek, cyrillic])

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="Αcme Ltd" email=<none> customerId=<none> group="guest-name:\\u0391cme Ltd"; '
    + 'name="Аcme Ltd" email=<none> customerId=<none> group="guest-name:\\u0410cme Ltd".',
  ), notice)

  // THE LOAD-BEARING PROPERTY, and the reason it is stated about `group=` rather than about the
  // whole entry: printable ASCII contains no two code points that draw alike, so two `group=`
  // fields that are distinct AND printable-ASCII throughout are distinct TO THE OPERATOR. That is
  // an invariant of the encoding, not a fact about the characters this fixture happens to use.
  const entries = noticeEntries(notice!)
  assert.equal(entries.length, 2)
  const groups = entries.map(groupField)
  assert.equal(new Set(groups).size, 2, groups.join(' || '))
  for (const group of groups) assert.deepEqual(nonPrintableAscii(group), [], group)

  // NOT VACUOUS: the readable half of the two entries differs in exactly the one code point that
  // draws the same as the other, so nothing before `group=` separates these rows on screen.
  assert.equal(readableFields(entries[0]!).replaceAll('Α', 'А'), readableFields(entries[1]!))
})

test('customer mix: a non-Latin name is spelled out in `group=` and left readable in `name=` (o3d-7jfq r7)', async () => {
  // WHAT THE SPLIT COSTS, WRITTEN DOWN. `group=` is ASCII-only, so an emailless guest called
  // `株式会社アクメ` gets an identity field of seven escapes that an operator cannot read as a
  // name. That is the price of a rule with no list to keep extending, and it is affordable only
  // because the other three fields are untouched: `name=` still prints the EXACT string the
  // Customer column prints, which is what the operator matches the row on. Escape both and the
  // notice stops being usable — this test is what stops the fix doing that.
  const name = '株式会社アクメ'

  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: name, customerEmail: null, totalBase: '200' }),
  ])

  assert.equal(report.rows.length, 1)
  assert.equal(report.totals.costInconsistentRows, '1')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith(
    'They are, highest-ranked first: '
    + 'name="株式会社アクメ" email=<none> customerId=<none> '
    + 'group="guest-name:\\u682a\\u5f0f\\u4f1a\\u793e\\u30a2\\u30af\\u30e1".',
  ), notice)

  // THE READABLE FIELD, TAKEN FROM THE COLUMN ITSELF rather than from a literal: whatever the
  // Customer column shows for this row is what `name=` has to print, character for character.
  assert.equal(report.rows[0]!.customerName, name)
  assert.ok(notice!.includes(`name="${report.rows[0]!.customerName}"`), notice)

  const entry = noticeEntries(notice!)[0]!
  assert.deepEqual(nonPrintableAscii(groupField(entry)), [], groupField(entry))
  // AND THE TWO POLICIES REALLY ARE DIFFERENT HERE — proof the assertion above is not satisfied by
  // an accidentally all-ASCII fixture: the readable half carries all seven characters raw.
  assert.equal(nonPrintableAscii(readableFields(entry)).length, 7)
})

/**
 * THE OPERATOR-FACING DOC FOR THIS NOTICE, read as a fixture.
 *
 * It has now been wrong TWICE about the same notice — round 3's `every figure summing COGS is
 * overstating cost` outlived the code that said it, and the documented label format outlived two
 * rewrites of `inconsistentCustomerLabel`. A paragraph nobody executes drifts silently, so this
 * file executes it.
 */
function analyticsDoc(): string {
  return readFileSync(path.join(process.cwd(), 'help-docs/analytics.md'), 'utf8')
}

/** The one paragraph of that doc that is about what the contradiction notice claims. */
function whatTheNoticeClaimsParagraph(doc: string): string {
  const opener = '**Read what that notice claims carefully'
  const start = doc.indexOf(opener)
  assert.notEqual(start, -1, 'help-docs/analytics.md no longer explains what the contradiction notice claims')
  const end = doc.indexOf('\n\n', start)
  assert.notEqual(end, -1, 'the paragraph runs to the end of the file — the extraction found no boundary')
  return doc.slice(start, end)
}

test('help-docs/analytics.md draws no monetary conclusion the check did not measure (o3d-7jfq r6)', async () => {
  // ROUND 6, FINDING 3. The doc still carried round 3's claim — duplicate entries imply every
  // COGS-summing figure overstates cost — which THIS branch's own zero-cost fixture disproves, and
  // which the notice itself stopped saying two rounds ago. The same ban list is applied to the doc
  // and to the notice, so the two cannot drift into disagreeing about what was measured.
  const paragraph = whatTheNoticeClaimsParagraph(analyticsDoc())

  // THE EXTRACTION REACHED SOMETHING: this is one paragraph about this notice, not an empty slice
  // that every assertion below would pass over vacuously.
  assert.ok(paragraph.length > 400, `the extracted paragraph is ${paragraph.length} characters`)
  assert.ok(paragraph.includes('CogsEntry.qty'), paragraph)
  assert.ok(paragraph.includes('never `CogsEntry.totalCostBase`'), paragraph)

  noMonetaryConclusion(paragraph)
  // AND IT SAYS THE THING THAT IS TRUE: unmeasured, and unmeasured in both directions.
  assert.ok(paragraph.includes('unmeasured'), paragraph)
  assert.ok(paragraph.includes('does not establish that any figure summing COGS entries is wrong'), paragraph)
  assert.ok(paragraph.includes('does not establish that any of them is right'), paragraph)
})

test('help-docs/analytics.md documents the label format the code actually emits (o3d-7jfq r6)', async () => {
  // The doc described `"customer name" email [customer id]` — the round-3 format, two rewrites
  // stale, with the `[guest]` marker that no longer exists. Rather than describe the shape in prose
  // and hope, the doc carries two worked examples and this test PRODUCES them: a registered
  // customer with no stored email on 200, and an emailless guest of the same name on 100. Same
  // Customer cell, same (absent) Email cell, and two rows — which is the pair the format exists for.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme Ltd', customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'Acme Ltd', customerEmail: null, totalBase: '100' }),
  ])
  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')

  const entries = noticeEntries(notice!)
  // THE PREMISE: two labels, and they are not the same label. If the report merged these two the
  // doc assertions below would still pass on one example and prove nothing about the other.
  assert.equal(entries.length, 2)
  assert.equal(entries[0], 'name="Acme Ltd" email=<none> customerId="cust-1" group="cust-1"')
  assert.equal(entries[1], 'name="Acme Ltd" email=<none> customerId=<none> group="guest-name:Acme Ltd"')

  const doc = analyticsDoc()
  for (const entry of entries) {
    assert.ok(doc.includes(entry), `help-docs/analytics.md does not show the label the code emits: ${entry}`)
  }
  // AND THE ESCAPES IT PROMISES ARE THE ESCAPES THE CODE WRITES — the four the whitespace test
  // derives by hand, named in the doc so an operator meeting one knows it is not part of the name.
  for (const escape of ['`\\t`', '`\\n`', '`\\u00a0`', '`\\u0020`']) {
    assert.ok(doc.includes(escape), `help-docs/analytics.md does not document the ${escape} escape`)
  }
  // AND IT NO LONGER SHOWS THE FORMAT IT USED TO. `[guest]` was the round-3 marker for a guest with
  // no customer record; the code has emitted `customerId=<none>` since round 5.
  assert.equal(doc.includes('`"customer name" email [customer id]`'), false)
  assert.equal(doc.includes('[guest]'), false)
})

test('customer mix: two distinct customer groups sharing one name are two distinguishable entries (o3d-7jfq)', async () => {
  // ROUND 4, FINDING 2. Rows are grouped on `customerId ?? guest-email:… ?? guest-name:…`, so two
  // guests really called `John Smith` are two rows — and a notice projecting them to `customerName`
  // said `John Smith; John Smith`, which names neither. Both contradict themselves; the first
  // invoices 200 and the second 100, so the net-revenue ranking is one.example then two.example.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: 'John Smith', customerEmail: 'john@one.example', totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'John Smith', customerEmail: 'john@two.example', totalBase: '100' }),
  ])

  // Two rows, one name: the premise. A grouping that merged them would make this test vacuous.
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.rows.map((row) => row.customerName), ['John Smith', 'John Smith'])
  assert.equal(report.totals.costInconsistentRows, '2')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.match(notice!, /^2 of 2 customers/)
  // The Email column is what separates these two on screen, so it is what separates them here —
  // and the group key says so a second time, from the identity the grouping actually used.
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="John Smith" email="john@one.example" customerId=<none> group="guest-email:john@one.example"; name="John Smith" email="john@two.example" customerId=<none> group="guest-email:john@two.example".'), notice)
})

test('customer mix: a registered customer and a guest sharing BOTH name and email are still told apart (o3d-7jfq)', async () => {
  // The case the email cannot settle. `cust-1` and a guest ordering under the same address are two
  // groups — `cust-1` and `guest-email:ops@acme.example` — with the same Customer cell and the same
  // Email cell, so only the identity segment separates the two labels. `customerId` is a column of
  // the CSV export the notice already points at, and its absence is stated rather than left blank.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme Ltd', customerEmail: 'ops@acme.example', totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'Acme Ltd', customerEmail: 'ops@acme.example', totalBase: '100' }),
  ])

  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.rows.map((row) => row.customerName), ['Acme Ltd', 'Acme Ltd'])
  assert.deepEqual(report.rows.map((row) => row.customerEmail), ['ops@acme.example', 'ops@acme.example'])

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="Acme Ltd" email="ops@acme.example" customerId="cust-1" group="cust-1"; name="Acme Ltd" email="ops@acme.example" customerId=<none> group="guest-email:ops@acme.example".'), notice)
})

test('customer mix: a guest whose email IS the absence sentinel does not wear the emailless guest label (o3d-7jfq)', async () => {
  // ROUND 5, FINDING 2. Round 4 closed the name-collision by printing the email too, and spelled a
  // missing email `(no email)` — a form of words, which is to say a value a customer can hold. This
  // is that value held. Both guests are called `Acme Ltd`; one has no email at all and keys on
  // `guest-name:Acme Ltd`, the other's stored email is the literal string `(no email)` and keys on
  // `guest-email:(no email)`. Two groups, and under round 4 ONE label — `"Acme Ltd" (no email)
  // [guest]` twice — which is exactly the defect round 4 set out to remove, reached through the fix.
  // Absence is now the unquoted token `<none>` and every present value is quoted, so the two live
  // in spaces that cannot overlap. 200 and 100 invoiced, so the emailless one ranks first.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: 'Acme Ltd', customerEmail: null, totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'Acme Ltd', customerEmail: '(no email)', totalBase: '100' }),
  ])

  // THE PREMISE, so this cannot pass by the two merging into one row: two groups, same name, and
  // the second really does store the sentinel as its address.
  assert.equal(report.rows.length, 2)
  assert.deepEqual(report.rows.map((row) => row.customerName), ['Acme Ltd', 'Acme Ltd'])
  assert.deepEqual(report.rows.map((row) => row.customerEmail), [null, '(no email)'])
  assert.equal(report.totals.costInconsistentRows, '2')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="Acme Ltd" email=<none> customerId=<none> group="guest-name:Acme Ltd"; name="Acme Ltd" email="(no email)" customerId=<none> group="guest-email:(no email)".'), notice)
  // AND THE TWO ENTRIES ARE NOT THE SAME STRING. Split on the separator and compare: the round-4
  // label made these identical, and a list that names one row twice names neither.
  const entries = notice!.slice(notice!.indexOf('highest-ranked first: ') + 'highest-ranked first: '.length).replace(/\.$/, '').split('; ')
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0], entries[1])
})

test('customer mix: the group key in the label is the one the rows were actually grouped under (o3d-7jfq)', async () => {
  // `group=` is only worth printing if it is the SAME identity the grouping used — a second,
  // parallel derivation would be a new place for the two to disagree, and a label that disagrees
  // with the grouping sends the operator to a row that is not there. Both are `customerGroupKey`,
  // and this is the case where that is observable: one guest ordering twice under the same address
  // typed in two cases. The key lower-cases, so these are ONE customer of two orders — and the
  // label prints the address AS STORED for the Email column and the lower-cased key for the
  // identity, which is the pair an operator needs to match the row and to say which row it is.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: null, customerName: 'Acme Ltd', customerEmail: 'Ops@Acme.example', totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: null, customerName: 'Acme Ltd', customerEmail: 'ops@acme.example', totalBase: '100' }),
  ])

  // THE PREMISE: one row, two orders, 200 + 100 invoiced. A key that did not fold case would make
  // two rows here and this test would be about something else.
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.orderCount, 2)
  assert.equal(report.rows[0]?.revenueBase, '300')
  assert.equal(report.rows[0]?.customerEmail, 'Ops@Acme.example')
  assert.equal(report.totals.costInconsistentRows, '1')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.match(notice!, /^1 of 1 customers/)
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="Acme Ltd" email="Ops@Acme.example" customerId=<none> group="guest-email:ops@acme.example".'), notice)
})

test('customer mix: a BLANK stored name is still one findable entry in the notice (o3d-7jfq)', async () => {
  // `customerName(order)` falls back only when the stored name is NULL; an empty string is a value
  // and passes straight through, so the Customer cell renders blank. Unquoted, that name is a hole
  // in the list — two separators with nothing between them — and the reader cannot tell whether a
  // customer was named at all. Quoted, it is `""`: visibly one entry, and an honest description of
  // the cell to look for. `Zeta` is here so the blank one has a neighbour to be confused with.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: '', customerEmail: 'jo@x.example', totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: 'cust-2', customerName: 'Zeta', totalBase: '100' }),
  ])

  // The premise: the row really does render an empty Customer cell.
  assert.equal(report.rows[0]?.customerName, '')

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="" email="jo@x.example" customerId="cust-1" group="cust-1"; name="Zeta" email=<none> customerId="cust-2" group="cust-2".'), notice)
})

test('customer mix: a name containing the list separator does not break the list (o3d-7jfq)', async () => {
  // Entries are separated by `; `, and a company name may contain one. Every value is delimited by
  // quotes and every quote inside one is doubled, CSV-style, so a reader tracking quote state knows
  // whether a `; ` is inside a name or between two entries. `Smith; Jones Ltd` invoices 200 and
  // ranks above `Say "Hi" Ltd` on 100.
  const report = await reportForContradicted([
    contradicted({ id: 'order-1', customerId: 'cust-1', customerName: 'Smith; Jones Ltd', totalBase: '200' }),
    contradicted({ id: 'order-2', customerId: 'cust-2', customerName: 'Say "Hi" Ltd', totalBase: '100' }),
  ])

  const notice = inconsistentNotice(report)
  assert.ok(notice, 'the report did not raise the inconsistent-evidence notice')
  assert.ok(notice!.endsWith('They are, highest-ranked first: name="Smith; Jones Ltd" email=<none> customerId="cust-1" group="cust-1"; name="Say ""Hi"" Ltd" email=<none> customerId="cust-2" group="cust-2".'), notice)
  // AND THE LIST IS SPLITTABLE: exactly one entry boundary for two customers. The name's own
  // semicolon is followed by ` Jones`, not by the field that opens an entry.
  assert.equal(notice!.split('; name="').length, 2)
})

test('customer mix: an incomplete customer and a contradicted one are told apart (o3d-7jfq)', async () => {
  // Both withhold, and an operator does different things about them, so the row has to say which.
  // Acme's order-1 ships ten of ten and posts its entry set twice — 20 costed units for 10 moved.
  // Beta's order-2 ships four of ten and costs exactly those four: a plain gap, which next month's
  // shipping closes on its own.
  const orders = [
    ...TEN_UNITS_ALL_SHIPPED,
    order({
      id: 'order-2', customerId: 'cust-2', customerName: 'Beta', totalBase: '120', taxBase: '20',
      lines: [{ id: 'line-2', productId: 'product-2', totalBase: '100', qty: '10' }],
    }),
  ]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: {
      findMany: async () => [
        dispatch('order-1', 'line-1', 'product-1', '10'),
        dispatch('order-2', 'line-2', 'product-2', '4'),
      ],
    },
    cogsEntry: {
      findMany: async () => [
        cogsForDispatch('order-1', 'line-1', '10', '30'),
        cogsForDispatch('order-1', 'line-1', '10', '30'),
        cogsForDispatch('order-2', 'line-2', '4', '12'),
      ],
    },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  // Both customers invoice 120, so the net-revenue ranking ties and the name breaks it: Acme, Beta.
  const [acme, beta] = report.rows
  assert.equal(acme?.customerName, 'Acme')
  assert.equal(beta?.customerName, 'Beta')

  assert.equal(acme?.grossProfitBase, null)
  assert.equal(acme?.costEvidence, 'inconsistent')
  assert.equal(beta?.grossProfitBase, null)
  assert.equal(beta?.costEvidence, 'incomplete')
  // One of the two withheld customers is actionable, and the count says so: 1 of 2, not 2 of 2.
  assert.equal(report.totals.costCapturedRows, '0')
  assert.equal(report.totals.costInconsistentRows, '1')
  assert.match(inconsistentNotice(report)!, /^1 of 2 customers/)
})

test('customer mix: a customer with both keeps the graver answer, whichever order is read first (o3d-7jfq)', async () => {
  // One customer, two orders: order-1 contradicts itself, order-2 is merely short. The grouped row
  // shows one word for both, and it has to be the one that needs a person — a later incomplete
  // order must not overwrite it, and an earlier one must not be preferred by arriving first.
  const contradicted = order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' }],
  })
  const merelyShort = order({
    id: 'order-2', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [{ id: 'line-2', productId: 'product-2', totalBase: '100', qty: '10' }],
  })
  const reportFor = (orders: Array<ReturnType<typeof order>>) => getCustomerAnalyticsReport(WINDOW, {
    client: {
      ...baseClient(),
      salesOrder: { findMany: async () => orders },
      stockMovement: {
        findMany: async () => [
          dispatch('order-1', 'line-1', 'product-1', '10'),
          dispatch('order-2', 'line-2', 'product-2', '4'),
        ],
      },
      cogsEntry: {
        findMany: async () => [
          cogsForDispatch('order-1', 'line-1', '10', '30'),
          cogsForDispatch('order-1', 'line-1', '10', '30'),
          cogsForDispatch('order-2', 'line-2', '4', '12'),
        ],
      },
    },
    now: NOW,
  })

  for (const orders of [[contradicted, merelyShort], [merelyShort, contradicted]]) {
    const report = await reportFor(orders)
    // One customer, two orders, one row.
    assert.equal(report.rows.length, 1)
    assert.equal(report.rows[0]?.orderCount, 2)
    assert.equal(report.rows[0]?.grossProfitBase, null)
    assert.equal(report.rows[0]?.costEvidence, 'inconsistent')
    assert.equal(report.totals.costInconsistentRows, '1')
  }
})

test('customer mix: an order with nothing to dispatch is still not costed at zero when its evidence contradicts itself (o3d-7jfq)', async () => {
  // "Costed at zero, on its own evidence" is what makes a service-only order publishable, and it is
  // an argument about an order that CANNOT carry a dispatch. An order that carries one anyway, with
  // twice the entries the movement can justify, has not established anything — so the contradiction
  // is read BEFORE coverage, not after it.
  //
  // 100 invoiced, no VAT, on one delivery-charge line. Coverage answers `nothing-to-dispatch`, and
  // reading that first would publish 100 - (20 + 20) = 60 as a complete profit.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0',
    lines: [{ id: 'line-1', productId: 'delivery', totalBase: '100', qty: '1', productType: ProductType.NON_INVENTORY }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'delivery', '1')] },
    cogsEntry: {
      findMany: async () => [
        cogsForDispatch('order-1', 'line-1', '1', '20'),
        cogsForDispatch('order-1', 'line-1', '1', '20'),
      ],
    },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  assert.equal(report.rows[0]?.netRevenueExVatBase, '100')
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costEvidence, 'inconsistent')
  assert.equal(report.totals.costInconsistentRows, '1')
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
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '2', '20')] },
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
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '1', '25')] },
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
    cogsEntry: costedInFull(ACME_100, { 'order-1': '10' }),
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

    // csvResponse caps its metadata payload and, past the cap, keeps only a handful of essential
    // keys — in the FILE as well as the header. That is the same silent drop this test exists to
    // catch, arriving by size instead of by omission, so the file must say it was not truncated.
    assert.ok(!body.includes('\r\n# metadataTruncated,'), `${reportType}: the export metadata was truncated, so totals were dropped from the file`)

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

test('every total all six sales-analytics reports emit has an empty-state fallback and reaches its CSV metadata (o3d-kyey)', async () => {
  /**
   * The same gap as the one above, found in the other consumer of a producer's totals: the page's
   * `salesAnalyticsEmptyTotals` is a hand-kept map used when a source scan is refused, and it had
   * drifted from the producer within this branch. Both consumers are now checked from the
   * producer's own key set, and over EVERY export the route can produce rather than the three this
   * change happened to touch — a subset is how a hand-kept list rots in the first place.
   *
   * Empty fixtures on purpose: `totals` is constructed unconditionally, so an empty report still
   * states the full shape, and no fixture can quietly narrow what is compared.
   */
  const { salesAnalyticsEmptyTotals } = await import('@/app/(dashboard)/analytics/_components/sales-analytics-page-utils')
  const {
    getFulfillmentAnalyticsReport, getReturnsAnalyticsReport, getThroughputAnalyticsReport,
  } = await import('@/lib/domain/sales/sales-fulfillment-analytics')
  const deps = { client: baseClient(), now: NOW }

  const reports: Array<[string, keyof typeof salesAnalyticsEmptyTotals, { rows: Record<string, unknown>[]; totals: Record<string, string> }]> = [
    ['sales', 'sales', await getSalesAnalyticsReport(WINDOW, deps)],
    ['customers', 'customers', await getCustomerAnalyticsReport(WINDOW, deps)],
    ['margin', 'margin', await getMarginAnalyticsReport(WINDOW, deps)],
    ['returns', 'returns', await getReturnsAnalyticsReport(WINDOW, deps)],
    ['fulfillment', 'fulfillment', await getFulfillmentAnalyticsReport(WINDOW, deps)],
    ['throughput', 'throughput', await getThroughputAnalyticsReport(WINDOW, deps)],
  ]
  // The route can produce exactly these six, so the sweep is total rather than a chosen subset.
  const { SALES_ANALYTICS_EXPORTS } = await import('@/app/api/export/sales-analytics/route')
  assert.deepEqual(reports.map(([type]) => type).sort(), Object.keys(SALES_ANALYTICS_EXPORTS).sort())

  const missing: string[] = []
  for (const [reportType, emptyKey, report] of reports) {
    const keys = Object.keys(report.totals)
    // Not a vacuous sweep: every one of these reports really does publish totals.
    assert.ok(keys.length >= 2, `${reportType}: the producer returned near-empty totals`)
    const fallback = salesAnalyticsEmptyTotals[emptyKey] as Record<string, string>
    const body = await exportedCsv(reportType, report)
    for (const key of keys) {
      if (!(key in fallback)) missing.push(`${reportType}: total ${key} has no empty-state fallback`)
      if (!body.includes(`\r\n# totals.${key},`)) missing.push(`${reportType}: total ${key} is nowhere in the exported file`)
    }
  }
  assert.deepEqual(missing, [], 'A producer total is missing from a consumer that keeps its own list of them.')
})

// ---------------------------------------------------------------------------------------------
// Customer Mix: a line with NO COST TO POST is not a line whose cost is UNKNOWN
// ---------------------------------------------------------------------------------------------

test('customer mix: a delivery charge beside a fully dispatched line does NOT withhold the profit (o3d-kyey)', async () => {
  // The over-correction this pins. "Every ordered unit of every line dispatched in-window" is right
  // for goods and impossible for a service: a NON_INVENTORY line books no stock movement, so it can
  // never show a dispatch, and an order carrying a delivery charge would withhold that customer's
  // profit for as long as the order exists. Its cost is a KNOWN ZERO, not an unknown one.
  //
  // 132 invoiced with 22 of VAT, so ex-VAT revenue is 132 - 22 = 110. Ten units of product-1 at an
  // ex-VAT 100 for the goods and 10 for the carriage. All ten units shipped in the window, and 40
  // of cost is posted for them.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '132', taxBase: '22',
    lines: [
      { id: 'line-1', productId: 'product-1', totalBase: '100', qty: '10' },
      { id: 'line-2', productId: 'delivery', totalBase: '10', qty: '1', productType: ProductType.NON_INVENTORY },
    ],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '10')] },
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '10', '40')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })
  const row = report.rows[0]!

  // 110 of ex-VAT revenue against the 40 of cost posted for the goods: 110 - 40 = 70.
  assert.equal(row.netRevenueExVatBase, '110')
  assert.equal(row.grossProfitBase, '70')
  assert.equal(row.costCaptured, true)
  // And it reaches the period figure, which is the number a permanently-withheld customer is
  // missing from: 1 of 1 rows covered.
  assert.equal(report.totals.grossProfitBase, '70')
  assert.equal(report.totals.costCapturedRows, '1')
})

test('customer mix: a service-only order is completely costed AT ZERO, with no COGS entry to prove it (o3d-kyey)', async () => {
  // The second half of the same defect. A service-only order has no CogsEntry BY DESIGN — nothing
  // on it can dispatch — so `cogsByOrder.has(order.id)` is false forever and the surrounding check
  // withheld the profit even once coverage stopped objecting. There is no missing cost here to
  // withhold FOR: the whole order is 50 ex-VAT of consultancy with a cost of zero.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '60', taxBase: '10',
    lines: [{ id: 'line-1', productId: 'service', totalBase: '50', qty: '1', productType: ProductType.NON_INVENTORY }],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    // No dispatch and no COGS row anywhere. That is the ordinary state of a service order, not a gap.
    stockMovement: { findMany: async () => [] },
    cogsEntry: { findMany: async () => [] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 60 - 10 of VAT = 50 ex-VAT, less a cost of 0 = 50.
  assert.equal(report.rows[0]?.netRevenueExVatBase, '50')
  assert.equal(report.rows[0]?.grossProfitBase, '50')
  assert.equal(report.rows[0]?.costCaptured, true)
  assert.equal(report.totals.grossProfitBase, '50')
  assert.equal(report.totals.costCapturedRows, '1')
})

test('customer mix: a VARIABLE line is an UNKNOWN cost, not an absent one, and still withholds (o3d-kyey)', async () => {
  // The distinction the fix turns on, tested from the other side. VARIABLE is a parent of
  // stock-tracked variants: goods really do leave for such a line, and `external-fulfillment`
  // records that it can never receive shipment coverage. So no dispatch can ever be found for it
  // and its real cost can never be posted — the exact opposite of a service line, and treating the
  // two alike (as `isStockTrackedProductType` alone would) publishes a cost of zero for goods.
  //
  // 100 ex-VAT: 60 on a dispatched simple line, 40 on the VARIABLE line. 25 of cost is posted.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0',
    lines: [
      { id: 'line-1', productId: 'product-1', totalBase: '60', qty: '1' },
      { id: 'line-2', productId: 'parent', totalBase: '40', qty: '1', productType: ProductType.VARIABLE },
    ],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '1')] },
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '1', '25')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  // 100 - 25 = 75 is what a report that waved the VARIABLE line through would print, against a cost
  // that covers only the 60 of goods it could see.
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costCaptured, false)
  // Revenue is untouched: this rule withholds a PROFIT, it does not restate revenue.
  assert.equal(report.rows[0]?.netRevenueExVatBase, '100')
  assert.equal(report.totals.grossProfitBase, '0')
  assert.equal(report.totals.costCapturedRows, '0')
})

test('customer mix: a SHORT goods line beside a delivery charge still withholds (o3d-kyey)', async () => {
  // The counterweight, so the non-stock exemption cannot be satisfied by exempting the whole order.
  // Ten units ordered and one shipped, with a carriage line beside them. A rule that answered
  // "nothing to dispatch" as soon as it saw ANY non-stock line would publish 100 - 4 = 96 of profit
  // from one shipped unit of ten — the very figure the coverage rule exists to suppress.
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20',
    lines: [
      { id: 'line-1', productId: 'product-1', totalBase: '90', qty: '10' },
      { id: 'line-2', productId: 'delivery', totalBase: '10', qty: '1', productType: ProductType.NON_INVENTORY },
    ],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '1')] },
    cogsEntry: { findMany: async () => [cogsForDispatch('order-1', 'line-1', '1', '4')] },
  }

  const report = await getCustomerAnalyticsReport(WINDOW, { client, now: NOW })

  assert.equal(report.rows[0]?.netRevenueExVatBase, '100')
  assert.equal(report.rows[0]?.grossProfitBase, null)
  assert.equal(report.rows[0]?.costCaptured, false)
  assert.equal(report.totals.costCapturedRows, '0')
})

test('gross margin: a service line beside a dispatched one leaves the margin row whole (o3d-kyey)', async () => {
  // Gross Margin shares Customer Mix's in-window dispatched-quantity loader, so the over-withholding
  // had to be checked here too. It does not reach: a NON_INVENTORY product posts no COGS, so it is
  // not in `cogsProductIds` and never becomes a margin bucket — it neither invents a costless row
  // nor takes anything away from the row beside it.
  //
  // One dispatched unit of product-1 at an ex-VAT 100 with 40 of COGS, plus a 10 carriage line.
  const productRef = { sku: 'PRODUCT-1', name: 'product-1', category: { name: 'Cat' } }
  const orders = [order({
    id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '110', taxBase: '0',
    lines: [
      { id: 'line-1', productId: 'product-1', totalBase: '100', qty: '1' },
      { id: 'line-2', productId: 'delivery', totalBase: '10', qty: '1', productType: ProductType.NON_INVENTORY },
    ],
  })]
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => orders },
    stockMovement: { findMany: async () => [dispatch('order-1', 'line-1', 'product-1', '1')] },
    cogsEntry: {
      findMany: async () => [{
        id: 'cogs-1',
        totalCostBase: D('40'),
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
  }

  const report = await getMarginAnalyticsReport(WINDOW, { client, now: NOW })

  // One bucket, and it is the goods one. The carriage line contributes no row and no revenue.
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]?.productId, 'product-1')
  // The whole of the dispatched line's revenue: (100 / 1 ordered) * 1 dispatched = 100.
  assert.equal(report.rows[0]?.revenueBase, '100')
  assert.equal(report.rows[0]?.cogsBase, '40')
  assert.equal(report.rows[0]?.grossProfitBase, '60')
  // 60 / 100 = 60%.
  assert.equal(report.rows[0]?.marginPct, '60')
  assert.equal(report.rows[0]?.revenueBaseBound, 'exact')
  assert.equal(report.totals.revenueBase, '100')
  assert.equal(report.totals.grossProfitBase, '60')
})

// ---------------------------------------------------------------------------------------------
// Credit entries stay apart until the interval is formed
// ---------------------------------------------------------------------------------------------

test('gross margin: two opposite GROSS off-row credits do not cancel into an exactness claim (o3d-kyey)', async () => {
  // The same-basis half of the cancellation. +120 and -120 of GROSS credit, both off every row.
  // They land in ONE bucket and sum to zero there, so a summary that read existence or direction off
  // the bucket answered "no off-row credit" and published everything exact.
  //
  // They do not cancel. A gross credit's ex-VAT value is `g / (1 + rate)` and the two rates need not
  // match — that is precisely why this module refuses to convert. Worked per ENTRY: +120 is worth
  // [0, 120] net and -120 is worth [-120, 0], so the credit missing from the net figures lies in
  // [-120, 120]. A negative missing credit means the published revenue is too LOW, so no `<=` holds.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '120', totalsBasis: 'GROSS' },
        { productId: null, salesOrderLineProductId: null, totalBase: '-120', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  // The published bucket really is zero — two same-basis amounts ARE the same unit and do add.
  assert.equal(report.totals.refundsUnattributedGrossBasis, '0')
  // The amounts are untouched: 100 of revenue, 100 - 40 = 60 of profit.
  assert.equal(report.totals.revenueBase, '100')
  assert.equal(report.totals.grossProfitBase, '60')
  // But none of them may carry a relation, because the interval straddles zero.
  assert.equal(report.totals.revenueBaseBound, 'indeterminate')
  assert.equal(report.totals.grossProfitBaseBound, 'indeterminate')
  assert.equal(report.totals.marginPctBound, 'indeterminate')
  assert.equal(report.rows[0]?.contributionPctBound, 'indeterminate')
  // The ROW saw neither credit, and its own figures stay exact — the withholding is where the
  // uncertainty is, not everywhere.
  assert.equal(report.rows[0]?.revenueBaseBound, 'exact')
})

test('gross margin: two opposite UNPROVEN-basis off-row credits do not cancel either (o3d-kyey)', async () => {
  // The unproven bucket has the same problem for a stronger reason: its rows need not even share a
  // basis. +80 could be NET and -80 GROSS, so their net values cannot be assumed to cancel at all.
  // Per entry the missing net credit is in [-80, 80], which straddles zero.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: null, salesOrderLineProductId: null, totalBase: '80', totalsBasis: null },
        { productId: null, salesOrderLineProductId: null, totalBase: '-80', totalsBasis: null },
      ],
    }),
    now: NOW,
  })

  assert.equal(report.totals.refundsUnattributedUnknownBasis, '0')
  assert.equal(report.totals.revenueBase, '100')
  assert.equal(report.totals.grossProfitBase, '60')
  assert.equal(report.totals.revenueBaseBound, 'indeterminate')
  assert.equal(report.totals.marginPctBound, 'indeterminate')
})

test('gross margin: opposite GROSS credits ON A ROW stop that row claiming a ceiling (o3d-kyey)', async () => {
  // The cancellation is not only an off-row problem: a ROW's unplaced credit was a signed bucket sum
  // too, and every row and total bound was classified from it. +120 and -120 of GROSS credit against
  // product-1 summed to a zero "unplaced" amount, which is not negative, so the row printed `<=` —
  // a claim that the truth is at or below 100 when the truth is anywhere in [-20, 220].
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: 'product-1', totalBase: '120', totalsBasis: 'GROSS' },
        { productId: 'product-1', totalBase: '-120', totalsBasis: 'GROSS' },
      ],
    }),
    now: NOW,
  })

  // GROSS credit is never subtracted from this report's NET revenue, so the amounts stand: 100 of
  // revenue and 100 - 40 = 60 of profit, with a zero gross-basis credit column.
  assert.equal(report.rows[0]?.refundsGrossBasis, '0')
  assert.equal(report.rows[0]?.revenueBase, '100')
  assert.equal(report.rows[0]?.grossProfitBase, '60')
  // And no relation may be attached to any of them.
  assert.equal(report.rows[0]?.revenueBaseBound, 'indeterminate')
  assert.equal(report.rows[0]?.grossProfitBaseBound, 'indeterminate')
  assert.equal(report.rows[0]?.marginPctBound, 'indeterminate')
  // The totals are built from the same interval and inherit it.
  assert.equal(report.totals.revenueBaseBound, 'indeterminate')
  assert.equal(report.totals.marginPctBound, 'indeterminate')
})

test('gross margin: three bases on one row are subtracted, bounded and published separately (o3d-kyey)', async () => {
  // NOTHING PUBLISHED IS A SUM ACROSS BASES, AT ANY STAGE. 10 NET, 20 GROSS and 30 of unproven
  // basis, all against product-1, on a report whose revenue is ex-VAT and therefore NET.
  //
  //   subtracted: the 10 NET only, because only it is the same unit -> 100 - 10 = 90 of revenue.
  //   profit:     90 - 40 = 50.
  //   margin:     50 / 90 = 55.5555...% -> 55.56.
  //   bounded by: the 20 + 30 that could not be placed, each worth [0, itself] ex-VAT, so the
  //               missing net credit is in [0, 50]. Never negative, so `<=` is honest and the
  //               ceiling is 50; 90 - 50 = 40 > 0 keeps the margin in its monotone case.
  //   published:  three columns, three bases, never one number. A cross-basis subtraction would
  //               have given 100 - 60 = 40 of revenue and 0 of profit.
  const report = await getMarginAnalyticsReport(WINDOW, {
    client: marginClient({
      lineTotalBase: '100',
      cogs: '40',
      refundLines: [
        { productId: 'product-1', totalBase: '10', totalsBasis: 'NET' },
        { productId: 'product-1', totalBase: '20', totalsBasis: 'GROSS' },
        { productId: 'product-1', totalBase: '30', totalsBasis: null },
      ],
    }),
    now: NOW,
  })

  assert.equal(report.rows[0]?.refundsNetBasis, '10')
  assert.equal(report.rows[0]?.refundsGrossBasis, '20')
  assert.equal(report.rows[0]?.refundsUnknownBasis, '30')
  assert.equal(report.rows[0]?.revenueBase, '90')
  assert.equal(report.rows[0]?.grossProfitBase, '50')
  assert.equal(report.rows[0]?.marginPct, '55.56')
  assert.equal(report.rows[0]?.revenueBaseBound, 'upper')
  assert.equal(report.rows[0]?.grossProfitBaseBound, 'upper')
  assert.equal(report.rows[0]?.marginPctBound, 'upper')
  assert.equal(report.totals.revenueBase, '90')
  assert.equal(report.totals.grossProfitBase, '50')
  assert.equal(report.totals.marginPct, '55.56')
})
