import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-iigc: the dashboard KPI block built `net = gross - discounts - refunds` where `gross` is made
 * of ex-VAT line totals but `refunds` was every `SalesOrderRefund.totalBase` regardless of the basis
 * stamped on it. A legacy GROSS credit therefore removed its VAT from a figure that never contained
 * VAT, and an unstamped one was subtracted on a guess.
 *
 * The worked example throughout is a £120 taxable order at 20% — £100 net + £20 VAT — credited in
 * full by a legacy GROSS refund. The old arithmetic turned a fully-credited £100 net sale into
 * MINUS £20 of net sales; every figure below is asserted as a specific number for that reason,
 * because the failure mode is a plausible-looking wrong figure, not an exception.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})
mock.module('@/app/actions/settings', {
  namedExports: { getSetting: async () => '04-06' },
})
mock.module('@/lib/display-timezone', {
  namedExports: { getDisplayTimeZone: async () => 'UTC' },
})

// Midday today and midday yesterday, in LOCAL time — the period helpers work in local calendar days.
const NOW = new Date()
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12)
const YESTERDAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 12)

type RefundFixture = { totalsBasis: string | null; totalBase: number }
type OrderFixture = {
  id: string
  createdAt: Date
  lineTotalBase: number
  cogsBase: number
  refunds: RefundFixture[]
}

function order(o: OrderFixture) {
  return {
    id: o.id,
    externalOrderNumber: null,
    customerName: 'Acme',
    status: 'COMPLETED',
    createdAt: o.createdAt,
    // Ex-VAT contract: no order- or line-level discount, no FX, prices exclusive of VAT, so `gross`
    // is exactly the line total and the refund basis is the only thing under test.
    totalBase: o.lineTotalBase,
    subtotalBase: o.lineTotalBase,
    shippingBase: 0,
    discountAmount: 0,
    fxRateToBase: 1,
    pricesIncludeVat: false,
    taxRatePercent: 20,
    shoppingLinks: [],
    lines: [{
      cogsBase: o.cogsBase, qty: 1, totalBase: o.lineTotalBase, discountAmount: 0,
      productId: `prod-${o.id}`, sku: `SKU-${o.id}`, description: `Product ${o.id}`,
      taxRate: { rate: 0.2 },
    }],
    refunds: o.refunds,
  }
}

let ORDERS: ReturnType<typeof order>[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async (args: { where?: { OR?: unknown; status?: { in?: string[] } } }) => {
          if (args.where?.OR) return ORDERS              // the metrics population
          if (args.where?.status?.in?.includes('DRAFT')) return []  // pending sales KPI
          return []                                      // recent-orders list
        },
      },
      product: { findMany: async () => [] },
      purchaseOrder: { findMany: async () => [] },
      salesOrderRefund: { findMany: async () => [] },
      costLayer: { findMany: async () => [] },
    },
  },
})

async function loadDashboard() {
  return (await import('@/app/actions/dashboard')).getDashboardData
}

/** period='today' vs compareMode='previous_period' => current = today, comparison = yesterday. */
function todayVsYesterday() {
  return loadDashboard().then((fn) => fn('today', 'previous_period'))
}

test('a legacy GROSS credit is NOT subtracted from ex-VAT net sales — £150, not £30 (o3d-iigc)', async () => {
  ORDERS = [
    // £100 net sale, credited in full by a £120 VAT-inclusive legacy refund.
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 40, refunds: [{ totalsBasis: 'GROSS', totalBase: 120 }] }),
    // £80 net sale with a £30 NET credit — the modern contract, unaffected.
    order({ id: 'B', createdAt: TODAY_NOON, lineTotalBase: 80, cogsBase: 30, refunds: [{ totalsBasis: 'NET', totalBase: 30 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  assert.equal(kpi.grossSalesCurrent, 180, 'gross is the ex-VAT line total, untouched by this fix')
  assert.equal(kpi.refundsCurrent, 30, 'only the NET-basis credit is the same unit as net sales')
  assert.equal(kpi.refundsGrossBasisCurrent, 120, 'the legacy credit is reported, not silently dropped')
  assert.equal(kpi.refundsUnknownBasisCurrent, 0)
  assert.equal(kpi.refundBasisCompleteCurrent, false, 'net sales is an upper bound and says so')
  // The whole point: 180 - 30 = 150. The old code computed 180 - (30 + 120) = 30.
  assert.equal(kpi.netSalesCurrent, 150)
  assert.equal(kpi.cogsCurrent, 70)
  assert.equal(kpi.profitCurrent, 80, 'old arithmetic gave -40 here')
  assert.equal(kpi.marginCurrent, 53.3, 'old arithmetic gave -133.3%')
  assert.equal(kpi.avgOrderValue, 75, 'net sales / 2 orders; the old figure was 15')
})

test('a SUB-PENNY unstamped credit still makes net sales an upper bound (o3d-iigc)', async () => {
  ORDERS = [
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 40, refunds: [{ totalsBasis: null, totalBase: 0.004 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  // Dust is still value: an epsilon tolerance here would let unstamped rows accumulate into a
  // material amount while net sales still reported itself as exact.
  assert.equal(kpi.refundBasisCompleteCurrent, false)
  assert.equal(kpi.refundsCurrent, 0, 'nothing was placeable on the net basis')
  assert.equal(kpi.refundsUnknownBasisCurrent, 0, 'the amount rounds away, but the FLAG does not')
  assert.equal(kpi.netSalesCurrent, 100, 'the unplaceable credit is not subtracted on a guess')
})

test('an EXACTLY-zero unstamped credit leaves net sales exact (o3d-iigc)', async () => {
  ORDERS = [
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 40, refunds: [{ totalsBasis: null, totalBase: 0 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  // Zero is the one amount identical on both bases, so it carries no basis information and must not
  // degrade an otherwise clean period.
  assert.equal(kpi.refundBasisCompleteCurrent, true)
  assert.equal(kpi.netSalesCurrent, 100)
  assert.equal(kpi.refundsUnknownBasisCurrent, 0)
})

test('an unrecognised basis marker is bucketed UNKNOWN, never assumed NET (o3d-iigc)', async () => {
  ORDERS = [
    // Lower case is a different stored literal, not a near-miss to be forgiven.
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 0, refunds: [{ totalsBasis: 'net', totalBase: 25 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  assert.equal(kpi.refundsUnknownBasisCurrent, 25)
  assert.equal(kpi.refundsCurrent, 0)
  assert.equal(kpi.netSalesCurrent, 100, 'guessing NET here would have produced 75')
})

test('the comparison period carries its own basis flag, so the change badge can refuse (o3d-iigc)', async () => {
  ORDERS = [
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 0, refunds: [{ totalsBasis: 'NET', totalBase: 10 }] }),
    order({ id: 'C', createdAt: YESTERDAY_NOON, lineTotalBase: 200, cogsBase: 0, refunds: [{ totalsBasis: 'GROSS', totalBase: 240 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  assert.equal(kpi.refundBasisCompleteCurrent, true, 'today is clean')
  assert.equal(kpi.refundBasisCompleteComparison, false, 'yesterday holds a legacy credit')
  assert.equal(kpi.netSalesCurrent, 90)
  // 200, not 200 - 240 = -40. The two sides are now on the same footing arithmetically, but the
  // comparison side is an upper bound, which is what the flag exists to say.
  assert.equal(kpi.netSalesComparison, 200)
})

test('a chart bucket whose credits are unplaceable marks its bar an upper bound (o3d-iigc)', async () => {
  ORDERS = [
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 0, refunds: [{ totalsBasis: 'GROSS', totalBase: 120 }] }),
    order({ id: 'C', createdAt: YESTERDAY_NOON, lineTotalBase: 200, cogsBase: 0, refunds: [{ totalsBasis: 'NET', totalBase: 20 }] }),
  ]
  const { chartData } = await todayVsYesterday()

  // period='today' buckets by hour; the order sits at 12:00 local.
  assert.equal(chartData.length, 24)
  const noon = chartData[12]
  assert.equal(noon.netSales, 100, 'old arithmetic gave -20 in this bucket')
  assert.equal(noon.netSalesUpperBound, true)
  assert.equal(noon.compNetSales, 180)
  assert.equal(noon.compNetSalesUpperBound, false)

  // An empty hour has nothing unplaceable and must not be marked.
  assert.equal(chartData[3].netSales, 0)
  assert.equal(chartData[3].netSalesUpperBound, false)
  assert.equal(chartData[3].compNetSalesUpperBound, false)
})

test('an all-NET period is byte-for-byte what it always was (o3d-iigc)', async () => {
  ORDERS = [
    order({ id: 'A', createdAt: TODAY_NOON, lineTotalBase: 100, cogsBase: 40, refunds: [{ totalsBasis: 'NET', totalBase: 25 }] }),
  ]
  const { kpi } = await todayVsYesterday()

  // The overwhelming majority of periods look like this; nothing about them may change.
  assert.equal(kpi.refundsCurrent, 25)
  assert.equal(kpi.netSalesCurrent, 75)
  assert.equal(kpi.refundBasisCompleteCurrent, true)
  assert.equal(kpi.refundsGrossBasisCurrent, 0)
  assert.equal(kpi.refundsUnknownBasisCurrent, 0)
})
