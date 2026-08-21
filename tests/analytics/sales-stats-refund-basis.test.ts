import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-iigc (sweep round 2): the three surfaces in `app/actions/sales-stats.ts` that still mixed the
 * two refund conventions in one arithmetic step.
 *
 * A sibling fixed the dashboard and product profitability and BUILT THE HELPERS FOR THESE THREE TOO
 * — `netOfRefunds` is documented as "the customer-aging netTotal" and `refundPctOfSale` as "the
 * refunds report's % of Sale" — but wired neither, because the sweep followed the helper module's
 * *importers* rather than its *docstrings*, and this file was never opened. All three defects lived
 * here.
 *
 * Worked examples, all on ONE £120 order: 1 unit at £100 net + £20 VAT at 20%, COGS £40.
 *
 *  1. Products tab, credited in full by a LEGACY GROSS refund (line £120):
 *     net revenue was £100 − £120 = MINUS £20, profit MINUS £60, avg order value MINUS £20.
 *     Now £100 with a stated upper bound, profit £60 ≤, margin 60.0% ≤.
 *  2. Customer aging, credited in full by a NET refund (£100) against the GROSS invoice total:
 *     net total was £120 − £100 = £20, so a fully-credited order read as £20 of surviving sale.
 *     Now £0.00 on the NET basis.
 *  3. Refunds report, the same NET credit: % of Sale was 100/120 = 83.3%, a FULL credit displayed
 *     as partial. Now 100.0%.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type RefundLine = { productId: string | null; qty: number; totalBase: number }
type OrderRefund = { totalsBasis: string | null; lines: RefundLine[] }

/** An ex-VAT-contract order: one line, no discount, no FX. The refund basis is the only variable. */
function productOrder(opts: {
  id: string
  lineTotalBase: number
  cogsBase: number
  qty?: number
  refunds: OrderRefund[]
}) {
  return {
    id: opts.id,
    totalBase: opts.lineTotalBase * 1.2,
    discountAmount: 0,
    fxRateToBase: 1,
    pricesIncludeVat: false,
    taxRatePercent: 0.2,
    customerName: 'Acme',
    salesRep: null,
    shoppingLinks: [],
    lines: [{
      productId: 'p1', sku: 'SKU-1', description: 'Widget',
      qty: opts.qty ?? 1, totalBase: opts.lineTotalBase, discountAmount: 0,
      cogsBase: opts.cogsBase, taxRate: { rate: 0.2 },
    }],
    refunds: opts.refunds,
  }
}

/** An invoiced order for the aging report. `totalBase` is GROSS; `taxBase` is the VAT within it. */
function agingOrder(opts: {
  id: string
  totalBase: number
  taxBase: number
  paid: number
  refunds: { totalBase: number; totalsBasis: string | null }[]
}) {
  return {
    id: opts.id,
    orderNumber: opts.id,
    externalOrderNumber: null,
    customerId: 'c1',
    customerName: 'Acme',
    salesRep: null,
    currency: 'GBP',
    totalBase: opts.totalBase,
    taxBase: opts.taxBase,
    invoicedAt: new Date('2026-01-05T00:00:00Z'),
    paidAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    shipFromWarehouse: { code: 'MAIN' },
    payments: opts.paid ? [{ amount: opts.paid }] : [],
    refunds: opts.refunds,
  }
}

let PRODUCT_ORDERS: ReturnType<typeof productOrder>[] = []
let AGING_ORDERS: ReturnType<typeof agingOrder>[] = []
let REFUND_ROWS: unknown[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        // getCustomerAging is the only caller filtering on invoiceNumber; getProductSalesStats
        // filters on status/refundStatus. That is what the fixture db dispatches on.
        findMany: async (args: { where?: Record<string, unknown> }) =>
          args?.where && 'invoiceNumber' in args.where ? AGING_ORDERS : PRODUCT_ORDERS,
      },
      product: {
        findMany: async () => [{
          id: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
          barcode: null, mpn: null, weight: null, salesPriceBase: null,
          lifecycleStatus: 'ACTIVE', stockLevels: [],
        }],
      },
      salesOrderRefund: { findMany: async () => REFUND_ROWS },
    },
  },
})

async function products() {
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  const { rows, summary } = await getProductSalesStats()
  return { row: rows[0], summary }
}

async function aging() {
  const { getCustomerAging } = await import('@/app/actions/sales-stats')
  const rows = await getCustomerAging()
  return new Map(rows.map((r) => [r.orderNumber, r]))
}

async function refunds() {
  const { getRefundStats } = await import('@/app/actions/sales-stats')
  return await getRefundStats()
}

// ---------------------------------------------------------------------------
// 1. Products tab — net revenue is ex-VAT, so only a NET credit is the same unit
// ---------------------------------------------------------------------------

test('products: a legacy GROSS credit is not subtracted from ex-VAT net revenue — £100, not -£20 (o3d-iigc)', async () => {
  PRODUCT_ORDERS = [productOrder({
    id: 'A', lineTotalBase: 100, cogsBase: 40,
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  const { row, summary } = await products()

  assert.equal(row.grossRevenue, 100)
  assert.equal(row.refunds, 0, 'the VAT-inclusive credit is not the same unit as this figure')
  assert.equal(row.refundsGrossBasis, 120, 'it is reported beside the figure, not discarded')
  assert.equal(row.refundsUnknownBasis, 0)
  assert.equal(row.refundBasisComplete, false)

  // Was -20.00. £120 of swing on a single order, and the sign of profit flips with it.
  assert.equal(row.netRevenue, 100)
  assert.equal(row.grossProfit, 60, 'was -60.00')
  assert.equal(row.marginPct, 60, 'was 0 — the old netRevenue was negative and hit the guard')
  assert.equal(row.avgOrderValue, 100, 'was -20.00')

  // Quantity is basis-independent: every refund line still nets off.
  assert.equal(row.qtyRefunded, 1)
  assert.equal(row.netQty, 0)

  assert.equal(summary.totalNetRevenue, 100)
  assert.equal(summary.totalRefundsGrossBasis, 120)
  assert.equal(summary.refundBasisComplete, false)
})

test('products: an UNSTAMPED credit is bucketed as unknown, never guessed onto the net basis (o3d-iigc)', async () => {
  PRODUCT_ORDERS = [productOrder({
    id: 'A', lineTotalBase: 100, cogsBase: 0,
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }],
  })]
  const { row } = await products()

  assert.equal(row.refundsUnknownBasis, 25)
  assert.equal(row.refundsGrossBasis, 0)
  assert.equal(row.refunds, 0)
  assert.equal(row.refundBasisComplete, false)
  assert.equal(row.netRevenue, 100, 'guessing NET here would have produced 75')
})

test('products: an all-NET row is byte-for-byte what it always was (o3d-iigc)', async () => {
  PRODUCT_ORDERS = [productOrder({
    id: 'A', lineTotalBase: 100, cogsBase: 40,
    refunds: [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }],
  })]
  const { row, summary } = await products()

  // The overwhelming majority of rows look like this; nothing about them may change.
  assert.equal(row.refunds, 25)
  assert.equal(row.netRevenue, 75)
  assert.equal(row.grossProfit, 35)
  assert.equal(row.refundBasisComplete, true)
  assert.equal(row.refundsGrossBasis, 0)
  assert.equal(row.refundsUnknownBasis, 0)
  assert.equal(summary.refundBasisComplete, true)
})

test('products: an EXACTLY-zero unstamped credit line does not spoil the row (o3d-iigc)', async () => {
  PRODUCT_ORDERS = [productOrder({
    id: 'A', lineTotalBase: 100, cogsBase: 0,
    refunds: [
      { totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 10 }] },
      { totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0 }] },
    ],
  })]
  const { row } = await products()

  // Zero is the one amount identical on both bases, so it carries no basis information and cannot
  // bias anything — the row stays exact rather than being degraded to an upper bound.
  assert.equal(row.refundBasisComplete, true)
  assert.equal(row.netRevenue, 90)
  assert.equal(row.refundsUnknownBasis, 0)
})

// ---------------------------------------------------------------------------
// 2. Customer aging — the invoice total is GROSS
// ---------------------------------------------------------------------------

test('aging: a NET credit is measured against the EX-VAT invoice total — £0.00, not £20.00 (o3d-iigc)', async () => {
  AGING_ORDERS = [agingOrder({ id: 'SO-1', totalBase: 120, taxBase: 20, paid: 120, refunds: [{ totalBase: 100, totalsBasis: 'NET' }] })]
  const byRef = await aging()
  const r = byRef.get('SO-1')!

  assert.equal(r.salesTotal, 120, 'the invoice total itself is unchanged and still GROSS')
  assert.equal(r.refundsTotal, 100)
  // Was 120 - 100 = 20.00: a fully-credited order reading as £20 of surviving sale, understated by
  // exactly the VAT on the credit.
  assert.equal(r.netTotal, 0)
  assert.equal(r.netTotalBasis, 'NET', 'the reader is told WHICH total this is')
})

test('aging: a GROSS credit against the GROSS total was already right, and stays right (o3d-iigc)', async () => {
  AGING_ORDERS = [agingOrder({ id: 'SO-2', totalBase: 120, taxBase: 20, paid: 0, refunds: [{ totalBase: 60, totalsBasis: 'GROSS' }] })]
  const r = (await aging()).get('SO-2')!

  assert.equal(r.netTotal, 60)
  assert.equal(r.netTotalBasis, 'GROSS')
})

test('aging: a MIXED credit set yields no net total at all (o3d-iigc)', async () => {
  AGING_ORDERS = [agingOrder({
    id: 'SO-3', totalBase: 120, taxBase: 20, paid: 0,
    refunds: [{ totalBase: 100, totalsBasis: 'NET' }, { totalBase: 12, totalsBasis: null }],
  })]
  const r = (await aging()).get('SO-3')!

  // Was 120 - 112 = 8.00 — a number with no unit, produced by adding £100 ex-VAT to £12 of unknown
  // basis. A zero here would be a figure; null is the admission.
  assert.equal(r.netTotal, null)
  assert.equal(r.netTotalBasis, 'UNKNOWN')
  assert.equal(r.refundsTotal, 112, 'how much credit exists is still reported')
})

test('aging: an order with NO credits is untouched, and its due/overdue buckets never move (o3d-iigc)', async () => {
  AGING_ORDERS = [agingOrder({ id: 'SO-4', totalBase: 120, taxBase: 20, paid: 45, refunds: [] })]
  const r = (await aging()).get('SO-4')!

  assert.equal(r.netTotal, 120)
  assert.equal(r.netTotalBasis, 'NONE')
  assert.equal(r.refundsTotal, 0)
  // Payment.amount is cash actually moved, which IS the same unit as the VAT-inclusive invoice
  // total — so the balance stays gross-on-gross and is deliberately not touched.
  assert.equal(r.dueAmount, 75)
})

// ---------------------------------------------------------------------------
// 3. Refunds report — % of Sale
// ---------------------------------------------------------------------------

function refundRow(opts: { id: string; totalsBasis: string | null; lineTotalBase: number; orderTotalBase: number; orderTaxBase: number }) {
  return {
    id: opts.id, creditNoteNumber: `CN-${opts.id}`, reason: 'damaged',
    totalBase: opts.lineTotalBase, refundedAt: new Date('2026-02-01T00:00:00Z'),
    totalsBasis: opts.totalsBasis,
    order: {
      id: `o-${opts.id}`, orderNumber: `SO-${opts.id}`, externalOrderNumber: null,
      customerName: 'Acme', salesRep: null, totalBase: opts.orderTotalBase, taxBase: opts.orderTaxBase,
    },
    lines: [{ id: `l-${opts.id}`, productId: 'p1', description: 'Widget', qty: 1, totalBase: opts.lineTotalBase }],
  }
}

test('refunds: a FULL net credit reads 100%, not 83.3% (o3d-iigc)', async () => {
  REFUND_ROWS = [refundRow({ id: '1', totalsBasis: 'NET', lineTotalBase: 100, orderTotalBase: 120, orderTaxBase: 20 })]
  const [r] = await refunds()

  // Was 100/120 = 83.3 — a credit that returned every penny of the sale, shown as partial.
  assert.equal(r.pctOfSale, 100)
})

test('refunds: a GROSS credit is measured against the GROSS total (o3d-iigc)', async () => {
  REFUND_ROWS = [refundRow({ id: '2', totalsBasis: 'GROSS', lineTotalBase: 60, orderTotalBase: 120, orderTaxBase: 20 })]
  const [r] = await refunds()

  assert.equal(r.pctOfSale, 50, 'against the ex-VAT £100 this would have read 60%')
})

test('refunds: an unprovable basis reports NO proportion, not 0% (o3d-iigc)', async () => {
  REFUND_ROWS = [refundRow({ id: '3', totalsBasis: null, lineTotalBase: 100, orderTotalBase: 120, orderTaxBase: 20 })]
  const [r] = await refunds()

  // 0% would read as "this credit returned nothing", which is the opposite of "we cannot say".
  assert.equal(r.pctOfSale, null)
  assert.equal(r.totalBase, 100, 'the amount itself is still reported')
})
