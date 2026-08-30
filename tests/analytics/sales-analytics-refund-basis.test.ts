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

// ---------------------------------------------------------------------------------------------
// Customer Mix
// ---------------------------------------------------------------------------------------------

test('customer mix: a full NET credit takes the sale out of net revenue and drives gross profit negative (o3d-kyey)', async () => {
  const client: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
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
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
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
    salesOrder: {
      findMany: async () => [
        order({ id: 'order-1', customerId: 'cust-1', customerName: 'Returner', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
        order({ id: 'order-2', customerId: 'cust-2', customerName: 'Keeper', totalBase: '60', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '60' }] }),
      ],
    },
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
    salesOrder: {
      findMany: async () => [
        order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
        order({ id: 'order-2', customerId: 'cust-2', customerName: 'Beta', totalBase: '60', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '60' }] }),
      ],
    },
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
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
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
    salesOrder: {
      findMany: async () => [
        order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', paidAt: null, lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] }),
        order({ id: 'order-2', customerId: 'cust-1', customerName: 'Acme', totalBase: '50', taxBase: '0', lines: [{ id: 'line-2', productId: 'product-1', totalBase: '50' }] }),
      ],
    },
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
  // The 40 that reached no row is published, split by why it could not.
  assert.equal(report.totals.refundsUnattributedBase, '15')
  assert.equal(report.totals.refundsOutsideReportBase, '25')
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
  assert.equal(report.totals.refundsOutsideReportBase, '0')
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
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '120', taxBase: '20', paidAt: null, lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
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
// The CSV half. A file reader has no tooltip, and no page either.
// ---------------------------------------------------------------------------------------------

test('every figure the three reports publish reaches their CSV, bound markers included (o3d-kyey)', async () => {
  /**
   * The producer and the export route are edited in different files, and the pinned inventory only
   * asks whether the route SAYS something about the figure names it contains — not whether the
   * column is actually written. A figure added to a row type and forgotten in `toCsv` would ship a
   * page that nets off credit and a file that silently does not, which is the worse half to be wrong.
   *
   * So this reads the route's real column arrays out of its source and compares them against the
   * keys of a row the producer really returned. Nothing is hand-listed on either side.
   */
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../app/api/export/sales-analytics/route.ts', import.meta.url), 'utf8')
  const columnsFor = (filename: string): string[] => {
    const line = source.split('\n').find((l) => l.includes(`\`${filename}-\${date}.csv\``))
    assert.ok(line, `no csvResponse line for ${filename}`)
    const list = /toCsv\(report\.rows, \[([^\]]*)\]\)/.exec(line!)
    assert.ok(list, `could not read the column list for ${filename}`)
    const columns = list![1]!.split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean)
    // Proof the extraction reached something real, so a regex slip cannot make this pass vacuously.
    assert.ok(columns.length >= 8, `${filename} column list looks empty: ${columns.join('|')}`)
    return columns
  }

  const salesClient: SalesFulfillmentAnalyticsClient = {
    ...baseClient(),
    salesOrder: { findMany: async () => [order({ id: 'order-1', customerId: 'cust-1', customerName: 'Acme', totalBase: '100', taxBase: '0', lines: [{ id: 'line-1', productId: 'product-1', totalBase: '100' }] })] },
    cogsEntry: { findMany: async () => [cogsByOrderRow('order-1', '10')] },
    salesOrderRefund: { findMany: async () => [orderRefund('order-1', '10', 'GROSS')] },
  }

  const cases: Array<[string, string[]]> = [
    ['sales-analytics', Object.keys((await getSalesAnalyticsReport(WINDOW, { client: salesClient, now: NOW })).rows[0]!)],
    ['customer-mix', Object.keys((await getCustomerAnalyticsReport(WINDOW, { client: salesClient, now: NOW })).rows[0]!)],
    ['gross-margin', Object.keys((await getMarginAnalyticsReport(WINDOW, { client: marginClient({ lineTotalBase: '100', cogs: '40' }), now: NOW })).rows[0]!)],
  ]

  const missing: string[] = []
  for (const [filename, keys] of cases) {
    const columns = columnsFor(filename)
    for (const key of keys) if (!columns.includes(key)) missing.push(`${filename}.csv: ${key}`)
  }
  assert.deepEqual(missing, [], 'These row fields are published on the page but dropped from the CSV.')
})
