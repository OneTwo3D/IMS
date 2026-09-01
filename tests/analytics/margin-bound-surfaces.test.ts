import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

/**
 * o3d-iigc round 4, Codex findings 1 and 2: THE FIGURE AS AN OPERATOR ACTUALLY READS IT.
 *
 * Finding 1 — Avg Margin was marked `≤` on reasoning the arithmetic does not support.
 * Finding 2 — the dashboard was never visited: its Margin % chart tooltips, its average order value,
 * its comparison net sales and its Cash Bridge all printed net-derived figures as measurements.
 *
 * THE COUNTEREXAMPLE ORDER, worked. One order of 1 unit at £100 ex-VAT (£120 gross at 20%) with
 * £150 of COGS, credited in full by a LEGACY GROSS refund of £120.
 *
 *   published net revenue  = £100          (the gross credit is reported, not subtracted)
 *   published gross profit = 100 - 150     = -£50
 *   published margin       = 100*(1 - 150/100) = -50.0%
 *
 * Place that credit at its £100 ex-VAT value and net revenue becomes £0, where the report's own
 * `netRevenue > 0` guard prints 0.0%. So the TRUE margin the report would publish is 0.0% — which is
 * ABOVE -50.0%, not at most it. Net revenue and profit are still genuine ceilings; margin is not.
 *
 * Every test below asserts a specific figure and a specific mark for that one order.
 */

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u1' } }),
  },
})
mock.module('@/app/actions/settings', { namedExports: { getSetting: async () => '04-06' } })
mock.module('@/lib/display-timezone', { namedExports: { getDisplayTimeZone: async () => 'UTC' } })

// ---------------------------------------------------------------------------
// Sales statistics — the cards and the Margin column
// ---------------------------------------------------------------------------

type OrderRefund = { totalsBasis: string | null; lines: { productId: string | null; qty: number; totalBase: number }[] }

function productOrder(cogsBase: number, refunds: OrderRefund[]) {
  return {
    id: 'A', totalBase: 120, discountAmount: 0, fxRateToBase: 1,
    pricesIncludeVat: false, taxRatePercent: 0.2,
    customerName: 'Acme', salesRep: null, shoppingLinks: [],
    lines: [{
      productId: 'p1', sku: 'SKU-1', description: 'Widget',
      qty: 1, totalBase: 100, discountAmount: 0, cogsBase, taxRate: { rate: 0.2 },
    }],
    refunds,
  }
}

let PRODUCT_ORDERS: ReturnType<typeof productOrder>[] = []
let DASHBOARD_ORDERS: unknown[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async (args: { where?: { OR?: unknown; status?: { in?: string[] }; createdAt?: unknown } }) => {
          // getProductSalesStats and getDashboardData both filter on OR; they never run in the same
          // test, so the fixture in play decides which set is returned.
          if (args.where?.status?.in?.includes('DRAFT')) return []
          if (args.where?.OR) return PRODUCT_ORDERS.length ? PRODUCT_ORDERS : DASHBOARD_ORDERS
          return []
        },
      },
      product: {
        findMany: async () => [{
          id: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
          barcode: null, mpn: null, weight: null, salesPriceBase: null,
          lifecycleStatus: 'ACTIVE', stockLevels: [],
        }],
      },
      purchaseOrder: { findMany: async () => [] },
      salesOrderRefund: { findMany: async () => [] },
      costLayer: { findMany: async () => [] },
    },
  },
})

mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => () => '1 Jan 2026' },
})
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => {} }) } })

const GROSS_CREDIT: OrderRefund[] = [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }]
const NET_CREDIT: OrderRefund[] = [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }]

async function salesStats(cogsBase: number, refunds: OrderRefund[]) {
  PRODUCT_ORDERS = [productOrder(cogsBase, refunds)]
  DASHBOARD_ORDERS = []
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  const stats = await getProductSalesStats()
  const { SalesStatsClient } = await import('@/app/(dashboard)/analytics/sales-stats/sales-stats-client')
  const mounted = mountClientComponent(SalesStatsClient as unknown as (props: unknown) => unknown, {
    productStats: stats, shipments: [], details: [], invoices: [], refunds: [], aging: [], savedViews: [],
  })
  return { rows: stats.rows, summary: stats.summary, html: mounted.render().html }
}

function card(html: string, label: string): string {
  const blocks = html.split('<div class="rounded-md border p-3">').slice(1)
  const block = blocks.find((b) => b.includes(`>${label}</p>`))
  assert.ok(block, `no summary card labelled ${label} was rendered`)
  return block.slice(0, block.indexOf('</div>'))
}

test('Avg Margin: COGS above net revenue makes ≤ FALSE, so the card does not claim it (o3d-iigc r4 #1)', async () => {
  const { summary, html } = await salesStats(150, GROSS_CREDIT)

  assert.equal(summary.totalNetRevenue, 100)
  assert.equal(summary.totalCogs, 150)
  assert.equal(summary.avgMarginPct, -50, 'the published margin, on the published net revenue')
  assert.equal(summary.avgMarginPctBound, 'indeterminate')

  const avgMargin = card(html, 'Avg Margin')
  // Was `-50% ≤`, which claims the true margin is at most -50%. It is 0%.
  assert.ok(!avgMargin.includes('≤'), 'the ≤ relation is the finding: it does not hold here')
  assert.match(avgMargin, /-50% \?/)
  assert.match(avgMargin, /Direction not established — £120\.00 of refunds not subtracted/)
  assert.match(avgMargin, /title="Direction not established: margin divides two figures that BOTH move/)
})

test('Avg Margin: the SAME render still marks Net Revenue and Profit ≤ — only the ratio differs (o3d-iigc r4 #1)', async () => {
  const { summary, html } = await salesStats(150, GROSS_CREDIT)

  // These two subtract a fixed, basis-independent COGS from a bounded revenue, so they can only fall.
  assert.equal(summary.totalGrossProfit, -50)
  assert.match(card(html, 'Net Revenue'), /£100\.00 ≤/)
  assert.match(card(html, 'Gross Profit'), /-£50\.00 ≤/)
  // If the fix had simply stopped marking everything, this assertion would fail — it is the control
  // against over-refusal, and it is on the same page as the `?` above.
  assert.match(card(html, 'Net Revenue'), /Upper bound — £120\.00 of refunds not subtracted/)
  assert.match(card(html, 'Net Revenue'), /text-orange-600/)
  assert.match(card(html, 'Gross Profit'), /Upper bound — £120\.00 of refunds not subtracted/)
})

test('Avg Margin: with COGS BELOW net revenue the bound does hold and is still marked ≤ (o3d-iigc r4 #1)', async () => {
  // Round 3's own fixture: £40 of COGS. Published margin 60%; the worst reachable reading is the
  // guard's 0%, which is below it. `≤` is correct here and must survive.
  const { summary, html } = await salesStats(40, GROSS_CREDIT)
  assert.equal(summary.avgMarginPct, 60)
  assert.equal(summary.avgMarginPctBound, 'upper')
  assert.match(card(html, 'Avg Margin'), /60% ≤/)
  assert.ok(!card(html, 'Avg Margin').includes('?'))
})

test('Avg Margin: an all-NET period carries no mark at all (o3d-iigc r4 control)', async () => {
  const { summary, html } = await salesStats(40, NET_CREDIT)
  assert.equal(summary.refundBasisComplete, true)
  assert.equal(summary.avgMarginPctBound, 'exact')

  const avgMargin = card(html, 'Avg Margin')
  assert.match(avgMargin, />46\.7%</)
  assert.ok(!avgMargin.includes('≤'))
  assert.ok(!avgMargin.includes('?'))
  assert.ok(!avgMargin.includes('text-orange-600'))
})

test('Margin COLUMN: the row cell carries the row’s own verdict, not the period flag (o3d-iigc r4 #1)', async () => {
  const { rows, html } = await salesStats(150, GROSS_CREDIT)
  assert.equal(rows[0].marginPct, -50)
  assert.equal(rows[0].marginPctBound, 'indeterminate')
  assert.equal(rows[0].refundBasisComplete, false, 'the LINEAR flag is still false — they disagree, which is the point')

  // The Margin cell and footer both read marginPctBound. Reading refundBasisComplete here — which is
  // what rounds 1-3 did — would print `≤`.
  assert.match(html, /-50% \?/)
  assert.ok(!/-50% ≤/.test(html), 'no surface on this page may claim the ≤ relation for this margin')
})

// ---------------------------------------------------------------------------
// The dashboard — finding 2's fourth surface
// ---------------------------------------------------------------------------

const NOW = new Date()
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12)

const YESTERDAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 12)

/**
 * o3d-iigc round 5: the dashboard query now selects each refund's LINES, because Best Sellers is
 * per-product and a header total says nothing about which product was credited. The fixture mirrors
 * the header credit onto the order's single line, which is what a real refund looks like.
 */
function dashboardOrder(cogsBase: number, refunds: { totalsBasis: string | null; totalBase: number }[], createdAt: Date = TODAY_NOON) {
  return {
    id: 'A', externalOrderNumber: null, customerName: 'Acme', status: 'COMPLETED',
    createdAt,
    totalBase: 100, subtotalBase: 100, shippingBase: 0, discountAmount: 0,
    fxRateToBase: 1, pricesIncludeVat: false, taxRatePercent: 20, shoppingLinks: [],
    lines: [{
      cogsBase, qty: 1, totalBase: 100, discountAmount: 0,
      productId: 'p1', sku: 'SKU-1', description: 'Widget', taxRate: { rate: 0.2 },
    }],
    refunds: refunds.map((r) => ({ ...r, lines: [{ productId: 'p1', qty: 1, totalBase: r.totalBase }] })),
  }
}

async function dashboard(
  cogsBase: number,
  refunds: { totalsBasis: string | null; totalBase: number }[],
  comparisonRefunds?: { totalsBasis: string | null; totalBase: number }[],
) {
  PRODUCT_ORDERS = []
  DASHBOARD_ORDERS = [
    dashboardOrder(cogsBase, refunds),
    ...(comparisonRefunds ? [dashboardOrder(cogsBase, comparisonRefunds, YESTERDAY_NOON)] : []),
  ]
  const { getDashboardData } = await import('@/app/actions/dashboard')
  return getDashboardData('today', 'previous_period')
}

const DASH_GROSS_CREDIT = [{ totalsBasis: 'GROSS', totalBase: 120 }]

test('dashboard: the Margin card stops claiming ≤ where the arithmetic refuses it (o3d-iigc r4 #2)', async () => {
  const { kpi } = await dashboard(150, DASH_GROSS_CREDIT)

  assert.equal(kpi.netSalesCurrent, 100)
  assert.equal(kpi.cogsCurrent, 150)
  assert.equal(kpi.marginCurrent, -50)
  assert.equal(kpi.marginBoundCurrent, 'indeterminate')
  // The linear figures on the same card row are untouched and still bounded.
  assert.equal(kpi.refundBasisCompleteCurrent, false)
  assert.equal(kpi.profitCurrent, -50)
})

test('dashboard: an ordinary bounded period keeps the ≤ on Margin (o3d-iigc r4 #2 control)', async () => {
  const data = await dashboard(40, DASH_GROSS_CREDIT)
  assert.equal(data.kpi.marginCurrent, 60)
  assert.equal(data.kpi.marginBoundCurrent, 'upper')
  // Rendered, not just computed: the control is against over-refusal, so it has to be the markup.
  const html = await renderDashboard(data)
  assert.match(html, />60% ≤<\/p>/)
  assert.ok(!html.includes('60% ?'))
})

test('dashboard: the Margin CARD prints ? where the card above it prints ≤ (o3d-iigc r4 #2)', async () => {
  const data = await dashboard(150, DASH_GROSS_CREDIT)
  const html = await renderDashboard(data)

  // Was `-50% ≤` — the card claiming the true margin is at most -50% when the report would print 0%.
  assert.match(html, />-50% \?<\/p>/)
  assert.ok(!html.includes('-50% ≤'), 'no card on this page may claim the ≤ relation for this margin')
  assert.match(html, /title="Direction not established: margin divides two figures that BOTH move/)
  // And on the SAME render the two linear figures keep their ≤ — the fix is not blanket refusal.
  assert.match(html, />£100\.00 ≤<\/p>/, 'net sales')
  assert.match(html, /Profit: -£50\.00 ≤/)
})

test('dashboard: a clean period marks nothing (o3d-iigc r4 #2 control)', async () => {
  const { kpi } = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }])
  assert.equal(kpi.refundBasisCompleteCurrent, true)
  assert.equal(kpi.marginBoundCurrent, 'exact')
  assert.equal(kpi.netSalesCurrent, 75)
  assert.equal(kpi.marginCurrent, 46.7)
})

test('dashboard: the Margin % CHART tooltip states the bound, per bucket (o3d-iigc r4 #2)', async () => {
  const { chartData } = await dashboard(150, DASH_GROSS_CREDIT)
  const today = chartData.find((p) => p.marginPct !== 0)
  assert.ok(today, 'the fixture order must land in a bucket')
  assert.equal(today.marginPct, -50)
  assert.equal(today.marginPctBound, 'indeterminate')

  const { marginChartTooltip } = await import('@/app/(dashboard)/dashboard/dashboard-client')
  const [text, label] = marginChartTooltip(today.marginPct, 'marginPct', today, 'Today', 'Yesterday')
  // Was exactly "-50.0%", indistinguishable from a measurement.
  assert.match(text, /^-50\.0% \?/)
  assert.match(text, /direction not established/)
  assert.equal(label, 'Today')

  // The comparison series reads the comparison bucket's OWN verdict, not the current one.
  const [compText] = marginChartTooltip(today.compMarginPct, 'compMarginPct', today, 'Today', 'Yesterday')
  assert.ok(!compText.includes('?'), 'yesterday had no orders, so nothing about it is bounded')
})

test('dashboard: an upper-bounded bucket says ≤ in the chart tooltip, a clean one says nothing (o3d-iigc r4 #2)', async () => {
  const bounded = await dashboard(40, DASH_GROSS_CREDIT)
  const { marginChartTooltip } = await import('@/app/(dashboard)/dashboard/dashboard-client')

  const point = bounded.chartData.find((p) => p.marginPct !== 0)!
  assert.equal(point.marginPctBound, 'upper')
  assert.match(marginChartTooltip(point.marginPct, 'marginPct', point, 'Today', 'Yesterday')[0], /^60\.0% ≤/)

  const clean = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }])
  const cleanPoint = clean.chartData.find((p) => p.marginPct !== 0)!
  assert.equal(cleanPoint.marginPctBound, 'exact')
  assert.equal(marginChartTooltip(cleanPoint.marginPct, 'marginPct', cleanPoint, 'Today', 'Yesterday')[0], '46.7%')
})

test('dashboard: the Cash Bridge marks its two net-derived bars and NO others (o3d-iigc r4 #2)', async () => {
  const { kpi } = await dashboard(40, DASH_GROSS_CREDIT)
  const { cashBridgeRows } = await import('@/app/(dashboard)/dashboard/dashboard-client')

  const marked = cashBridgeRows(kpi).filter((b) => b.bound !== 'exact').map((b) => b.name)
  // 'Margin' here is the MONEY profit bar (kpi.profitCurrent), which is a genuine ceiling — unlike
  // the Margin % ratio two charts away.
  assert.deepEqual(marked, ['Net Sales', 'Margin'])

  const clean = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }])
  assert.deepEqual(cashBridgeRows(clean.kpi).filter((b) => b.bound !== 'exact').map((b) => b.name), [],
    'and the marking is driven by the basis, not hardcoded to those two bars')
})

async function renderDashboard(data: Awaited<ReturnType<typeof dashboard>>) {
  const { DashboardClient } = await import('@/app/(dashboard)/dashboard/dashboard-client')
  return mountClientComponent(DashboardClient as unknown as (props: unknown) => unknown, {
    kpi: data.kpi, chartData: data.chartData, topProducts: data.topProducts,
    recentOrders: data.recentOrders, incomingPOs: data.incomingPOs,
    periodLabel: 'Today', compLabel: 'Yesterday', initialPeriod: 'today', initialCompare: 'previous_period',
  }).render().html
}

test('dashboard: the Gross Sales card marks its average order value (o3d-iigc r4 #2)', async () => {
  const data = await dashboard(40, DASH_GROSS_CREDIT)
  assert.equal(data.kpi.avgOrderValue, 100, 'netSalesCurrent / 1 order — a bounded numerator over a plain count')

  // Was "1 orders · avg £100.00" in the Gross Sales card — the one card nobody expects to be bounded,
  // because its headline figure (gross sales) genuinely is not.
  const html = await renderDashboard(data)
  assert.match(html, /1 orders · avg £100\.00 ≤/)
  // And the headline of that same card — gross sales, which no refund basis touches — stays bare.
  assert.match(html, /<p class="text-xl sm:text-2xl font-bold mt-1">£100\.00<\/p>/)
})

test('dashboard: the Comp. Orders tile marks the comparison net sales beneath the count (o3d-iigc r4 #2)', async () => {
  // Yesterday carries the legacy gross credit; today is clean. The tile prints an order COUNT, which
  // is basis-independent, above a MONEY figure that is not.
  const data = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }], DASH_GROSS_CREDIT)
  assert.equal(data.kpi.refundBasisCompleteCurrent, true)
  assert.equal(data.kpi.refundBasisCompleteComparison, false)
  assert.equal(data.kpi.netSalesComparison, 100)

  const html = await renderDashboard(data)
  const tile = html.slice(html.indexOf('Comp. Orders'))
  // Was a bare "£100.00" — the SAME figure the Margin card eight lines above already treats as bounded.
  assert.match(tile, /£100\.00 ≤/)
  assert.match(tile, /text-orange-600/)
  assert.match(tile, />1<\/p>/, 'the order count itself is never marked')
})

test('dashboard: a clean comparison period leaves the Comp. Orders tile unmarked (o3d-iigc r4 control)', async () => {
  const clean = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }], [{ totalsBasis: 'NET', totalBase: 25 }])
  assert.equal(clean.kpi.refundBasisCompleteComparison, true)
  const cleanTile = (await renderDashboard(clean)).split('Comp. Orders')[1]
  assert.ok(!cleanTile.includes('≤'), 'nothing on this tile is bounded when every credit could be placed')
  assert.match(cleanTile, /class="text-\[10px\] text-muted-foreground"/, 'and it keeps the ordinary tone')

  // The control is not vacuous: the SAME tile, with the SAME markup path, marks when the comparison
  // period holds a credit it could not place.
  const bounded = await dashboard(40, [{ totalsBasis: 'NET', totalBase: 25 }], DASH_GROSS_CREDIT)
  const boundedTile = (await renderDashboard(bounded)).split('Comp. Orders')[1]
  assert.match(boundedTile, /£100\.00 ≤/)
})
