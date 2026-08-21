import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

/**
 * o3d-iigc round 5, Codex finding 1: BEST SELLERS WAS THE SIXTH REFUND-BLIND SURFACE.
 *
 * `getDashboardData` built `topProducts` in its own loop over sales lines and never looked at a
 * refund at all — while the KPI block ten lines above it had bucketed every credit by basis since
 * round 1. So the same product's net revenue disagreed between the dashboard card and the sales
 * statistics page the card's own "View all" link goes to.
 *
 * Round 4 reached this figure and filed it as a NAMING problem. It is not: a figure called net
 * revenue that has never seen a refund makes exactly the claim a mis-subtracted one makes, and it
 * also ORDERS THE LIST.
 *
 * Every assertion below is a specific figure for a specific fixture, because the failure mode is a
 * plausible wrong number rather than an exception.
 */

mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) } })
mock.module('@/app/actions/settings', { namedExports: { getSetting: async () => '04-06' } })
mock.module('@/lib/display-timezone', { namedExports: { getDisplayTimeZone: async () => 'UTC' } })
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => () => '1 Jan 2026' },
})
mock.module('next/navigation', { namedExports: { useRouter: () => ({ refresh: () => {} }) } })

const NOW = new Date()
const TODAY_NOON = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 12)

type RefundLine = { productId: string | null; qty: number; totalBase: number }
type Refund = { totalsBasis: string | null; totalBase: number; lines: RefundLine[] }
type Line = { productId: string; sku: string; description: string; qty: number; totalBase: number; cogsBase: number }

let ORDERS: unknown[] = []

const PRODUCTS = [
  { id: 'p1', sku: 'SKU-1', name: 'Widget', lifecycleStatus: 'ACTIVE', stockLevels: [] },
  { id: 'p2', sku: 'SKU-2', name: 'Gadget', lifecycleStatus: 'ACTIVE', stockLevels: [] },
  { id: 'p3', sku: 'SKU-3', name: 'Sprocket', lifecycleStatus: 'ACTIVE', stockLevels: [] },
]

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async (args: { where?: { OR?: unknown; status?: { in?: string[] } } }) => {
          if (args.where?.status?.in?.includes('DRAFT')) return []
          if (args.where?.OR) return ORDERS
          return []
        },
      },
      product: { findMany: async () => PRODUCTS },
      purchaseOrder: { findMany: async () => [] },
      salesOrderRefund: { findMany: async () => [] },
      costLayer: { findMany: async () => [] },
    },
  },
})

function order(id: string, lines: Line[], refunds: Refund[] = []) {
  const total = lines.reduce((s, l) => s + l.totalBase, 0)
  return {
    id, externalOrderNumber: null, customerName: 'Acme', status: 'COMPLETED', createdAt: TODAY_NOON,
    // Ex-VAT contract: no discount, no FX, prices exclusive of VAT — so the line total IS the
    // revenue and the refund basis is the only thing under test.
    totalBase: total, subtotalBase: total, shippingBase: 0, discountAmount: 0,
    fxRateToBase: 1, pricesIncludeVat: false, taxRatePercent: 20, shoppingLinks: [],
    lines: lines.map((l) => ({ ...l, discountAmount: 0, taxRate: { rate: 0.2 } })),
    refunds,
  }
}

function line(productId: string, totalBase: number, cogsBase: number, qty = 1): Line {
  const product = PRODUCTS.find((p) => p.id === productId)!
  return { productId, sku: product.sku, description: product.name, qty, totalBase, cogsBase }
}

async function dashboard() {
  const { getDashboardData } = await import('@/app/actions/dashboard')
  return getDashboardData('today', 'previous_period')
}

async function renderDashboard(data: Awaited<ReturnType<typeof dashboard>>) {
  const { DashboardClient } = await import('@/app/(dashboard)/dashboard/dashboard-client')
  return mountClientComponent(DashboardClient as unknown as (props: unknown) => unknown, {
    kpi: data.kpi, chartData: data.chartData, topProducts: data.topProducts,
    recentOrders: data.recentOrders, incomingPOs: data.incomingPOs,
    periodLabel: 'Today', compLabel: 'Yesterday', initialPeriod: 'today', initialCompare: 'previous_period',
  }).render().html
}

/** The Best Sellers card only — so an assertion cannot be satisfied by a KPI card elsewhere. */
function bestSellers(html: string): string {
  const start = html.indexOf('Best Sellers')
  assert.ok(start > -1, 'the Best Sellers card was not rendered')
  const end = html.indexOf('Incoming POs', start)
  return html.slice(start, end > -1 ? end : undefined)
}

test('Best Sellers subtracts a NET credit from net revenue — £140, not £200 (o3d-iigc r5 #1)', async () => {
  ORDERS = [order('A', [line('p2', 200, 50)], [
    { totalsBasis: 'NET', totalBase: 60, lines: [{ productId: 'p2', qty: 1, totalBase: 60 }] },
  ])]
  const { topProducts } = await dashboard()

  const row = topProducts.find((p) => p.productId === 'p2')!
  // The figure itself moves: this credit IS the same unit as the ex-VAT line revenue, so it comes
  // off. Before round 5 the card published £200 while sales statistics published £140.
  assert.equal(row.netRevenue, 140)
  assert.equal(row.refundsNetBasis, 60)
  assert.equal(row.refundsGrossBasis, 0)
  assert.equal(row.refundsUnknownBasis, 0)
  assert.equal(row.refundBasisComplete, true)
  assert.equal(row.netRevenueBound, 'exact', 'every credit was placeable, so nothing is marked')
  // (140 - 50) / 140 = 64.28...%. The old figure was (200 - 50) / 200 = 75%.
  assert.equal(row.marginPct, 64.3)
  assert.equal(row.marginPctBound, 'exact')
  assert.equal(row.qtySold, 1)
  assert.equal(row.qtyRefunded, 1)
  assert.equal(row.netQty, 0)
})

test('Best Sellers does NOT subtract a GROSS credit, and says so on the card (o3d-iigc r5 #1)', async () => {
  // £100 ex-VAT sale credited in full by a legacy £120 VAT-inclusive refund.
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: 'GROSS', totalBase: 120, lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
  ])]
  const data = await dashboard()

  const row = data.topProducts.find((p) => p.productId === 'p1')!
  assert.equal(row.netRevenue, 100, 'subtracting £120 from an ex-VAT £100 would have produced -£20')
  assert.equal(row.refundsGrossBasis, 120)
  assert.equal(row.refundsNetBasis, 0)
  assert.equal(row.refundBasisComplete, false)
  assert.equal(row.netRevenueBound, 'upper')
  assert.equal(row.marginPct, 60)
  // COGS £40 ≤ net revenue £100, so even where placing the credit takes revenue through the guard
  // the published margin stays the maximum. A genuine ≤, not a blanket one.
  assert.equal(row.marginPctBound, 'upper')
  // Quantity is basis-independent: the unit came back whatever unit the money was recorded in.
  assert.equal(row.netQty, 0)

  const card = bestSellers(await renderDashboard(data))
  assert.match(card, /£100\.00 ≤/, 'the money figure carries its relation')
  assert.match(card, /60% ≤ margin/)
  assert.match(card, /0 sold net \(1 less 1 returned\)/, 'the count is exact and carries no marker')
  assert.match(card, /text-orange-600/)
  assert.match(card, /Upper bound: £120\.00 of credit on this product/, 'the LOOSENESS is stated, in words')
  assert.match(card, /The list order is by this figure/, 'and so is what that does to the ranking')
})

test('Best Sellers refuses an UNSTAMPED credit rather than guessing NET (o3d-iigc r5 #1)', async () => {
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: null, totalBase: 25, lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] },
  ])]
  const { topProducts } = await dashboard()

  const row = topProducts.find((p) => p.productId === 'p1')!
  assert.equal(row.netRevenue, 100, 'guessing NET would have published £75')
  assert.equal(row.refundsUnknownBasis, 25)
  assert.equal(row.refundBasisComplete, false)
  assert.equal(row.netRevenueBound, 'upper')
})

test('a sub-penny unstamped credit bounds the figure even though it rounds away (o3d-iigc r5 #1)', async () => {
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: null, totalBase: 0.004, lines: [{ productId: 'p1', qty: 1, totalBase: 0.004 }] },
  ])]
  const { topProducts } = await dashboard()

  const row = topProducts.find((p) => p.productId === 'p1')!
  // Existence of the bound comes from the FLAG, never from the amount — the amount is £0.00 here.
  assert.equal(row.refundsUnknownBasis, 0)
  assert.equal(row.refundBasisComplete, false)
  assert.equal(row.netRevenueBound, 'upper')
})

test('an EXACTLY-zero unstamped credit leaves Best Sellers exact (o3d-iigc r5 control)', async () => {
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: null, totalBase: 0, lines: [{ productId: 'p1', qty: 0, totalBase: 0 }] },
  ])]
  const data = await dashboard()

  // Zero is identical on both bases, so it carries no basis information and must not degrade a
  // clean row. This is the control against over-refusal, and it is asserted in the MARKUP.
  const row = data.topProducts.find((p) => p.productId === 'p1')!
  assert.equal(row.refundBasisComplete, true)
  assert.equal(row.netRevenueBound, 'exact')
  assert.equal(row.marginPctBound, 'exact')
  const card = bestSellers(await renderDashboard(data))
  assert.ok(!card.includes('≤'), 'nothing on this card is bounded')
  assert.ok(!card.includes('?'), 'and nothing has its direction withheld either')
  assert.match(card, /1 sold net/, 'with no returns the parenthetical is not printed')
})

test('the RANKING inherits the bound, and the card says which row it holds up (o3d-iigc r5 #1)', async () => {
  ORDERS = [
    // p1: £100 ex-VAT, credited in full by a £120 legacy GROSS refund that cannot be placed.
    order('A', [line('p1', 100, 40)], [
      { totalsBasis: 'GROSS', totalBase: 120, lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
    ]),
    // p2: £90 ex-VAT, no credit at all.
    order('B', [line('p2', 90, 20)]),
  ]
  const data = await dashboard()

  // p1 outranks p2 on £100 vs £90 — but its £100 is a ceiling, and placing that credit at its ex-VAT
  // £100 would take it to £0 and put it LAST. The order is a claim, and it is a bounded one.
  assert.deepEqual(data.topProducts.map((p) => p.productId), ['p1', 'p2'])
  assert.equal(data.topProducts[0].netRevenueBound, 'upper')
  assert.equal(data.topProducts[1].netRevenueBound, 'exact')

  const card = bestSellers(await renderDashboard(data))
  assert.match(card, /1\.<\/span>[\s\S]*?SKU-1/, 'p1 is rendered first')
  assert.match(card, /£100\.00 ≤/)
  // p2's row is on the same card, from the same markup path, and is NOT marked.
  const second = card.slice(card.indexOf('SKU-2'))
  assert.match(second, /£90\.00</)
  assert.ok(!second.includes('≤'), 'the marking is driven by the row’s own basis, not by the card')
})

test('a product credited but not sold in the period gets a row, and a label (o3d-iigc r5 #1)', async () => {
  // p3 was sold in an earlier period and returned in this one. Dropping the refund line because no
  // sales line matched would restore the blindness for exactly the worst case.
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: 'NET', totalBase: 30, lines: [{ productId: 'p3', qty: 2, totalBase: 30 }] },
  ])]
  const { topProducts } = await dashboard()

  const row = topProducts.find((p) => p.productId === 'p3')!
  assert.equal(row.netRevenue, -30, 'a period of pure returns is negative revenue, not absent')
  assert.equal(row.refundsNetBasis, 30)
  assert.equal(row.netQty, -2)
  // The row was created by a refund line, so its label comes from the product table rather than
  // from a sales line that does not exist.
  assert.equal(row.sku, 'SKU-3')
  assert.equal(row.name, 'Sprocket')
  // And it sorts below the product that actually sold.
  assert.deepEqual(topProducts.map((p) => p.productId), ['p1', 'p3'])
})

test('an all-NET period is byte-for-byte what it always was (o3d-iigc r5 control)', async () => {
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: 'NET', totalBase: 25, lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] },
  ])]
  const { topProducts } = await dashboard()

  const row = topProducts.find((p) => p.productId === 'p1')!
  assert.equal(row.netRevenue, 75)
  assert.equal(row.refundsGrossBasis, 0)
  assert.equal(row.refundsUnknownBasis, 0)
  assert.equal(row.refundBasisComplete, true)
  assert.equal(row.netRevenueBound, 'exact')
  assert.equal(row.marginPctBound, 'exact')
  // (75 - 40) / 75 = 46.66...%
  assert.equal(row.marginPct, 46.7)
})

test('a refund line with no productId cannot be attributed, and is not invented one (o3d-iigc r5)', async () => {
  // The mirrored order-discount line (lib/domain/sales/refund-service) is exactly this shape.
  ORDERS = [order('A', [line('p1', 100, 40)], [
    { totalsBasis: 'NET', totalBase: -10, lines: [{ productId: null, qty: 0, totalBase: -10 }] },
  ])]
  const { topProducts } = await dashboard()

  assert.deepEqual(topProducts.map((p) => p.productId), ['p1'])
  assert.equal(topProducts[0].netRevenue, 100, 'an unattributable credit does not land on an arbitrary product')
  assert.equal(topProducts[0].refundsNetBasis, 0)
  assert.equal(topProducts[0].netRevenueBound, 'exact')
})
