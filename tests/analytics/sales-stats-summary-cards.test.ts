import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

/**
 * o3d-iigc round 2, Codex finding 1: the five SUMMARY CARDS above the sales statistics table.
 *
 * Round 1 marked every bounded figure in the table — a `≤`, the bound colour instead of the
 * green/red verdict colour, a title explaining the bound — and left the cards alone. But the cards
 * are the figures people actually read, and on a card there is no neighbouring "Refunds (gross)"
 * column to reveal that a number is an upper bound: an unmarked £100 there is indistinguishable
 * from a measurement. A bound presented as exact is the same error the round was about, one step up.
 *
 * These tests render the real client component with the real server action's output, so what is
 * asserted is what an operator would read.
 *
 * THE ORDER, worked (round 1's fixture, unchanged): one £120 order — 1 unit at £100 ex-VAT plus
 * £20 VAT at 20% — with £40 of COGS, credited in full by a LEGACY GROSS refund of £120. The gross
 * credit is not the same unit as the ex-VAT revenue, so it is reported but not subtracted, which
 * makes net revenue £100 an UPPER BOUND loose by at most that £120.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

type OrderRefund = { totalsBasis: string | null; lines: { productId: string | null; qty: number; totalBase: number }[] }

function productOrder(refunds: OrderRefund[]) {
  return {
    id: 'A', totalBase: 120, discountAmount: 0, fxRateToBase: 1,
    pricesIncludeVat: false, taxRatePercent: 0.2,
    customerName: 'Acme', salesRep: null, shoppingLinks: [],
    lines: [{
      productId: 'p1', sku: 'SKU-1', description: 'Widget',
      qty: 1, totalBase: 100, discountAmount: 0, cogsBase: 40, taxRate: { rate: 0.2 },
    }],
    refunds,
  }
}

let PRODUCT_ORDERS: ReturnType<typeof productOrder>[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: async () => PRODUCT_ORDERS },
      product: {
        findMany: async () => [{
          id: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', stockUnit: 'pcs',
          barcode: null, mpn: null, weight: null, salesPriceBase: null,
          lifecycleStatus: 'ACTIVE', stockLevels: [],
        }],
      },
    },
  },
})

// The client component's own hooks run under the harness's minimal dispatcher, which has no
// useContext — so the two provider hooks it calls are replaced by their real defaults (GBP, £).
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => () => '1 Jan 2026' },
})
mock.module('next/navigation', {
  namedExports: { useRouter: () => ({ refresh: () => {} }) },
})

/** Render the page exactly as it is served: the action's own rows and summary, straight in. */
async function renderPage(refunds: OrderRefund[]) {
  PRODUCT_ORDERS = [productOrder(refunds)]
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  const productStats = await getProductSalesStats()

  const { SalesStatsClient } = await import('@/app/(dashboard)/analytics/sales-stats/sales-stats-client')
  const mounted = mountClientComponent(SalesStatsClient as unknown as (props: unknown) => unknown, {
    productStats, shipments: [], details: [], invoices: [], refunds: [], aging: [], savedViews: [],
  })
  return { summary: productStats.summary, html: mounted.render().html }
}

/**
 * The markup of ONE summary card, found by its label. Cards are the only `rounded-md border p-3`
 * blocks on the page, and each closes at its first `</div>`.
 */
function card(html: string, label: string): string {
  const blocks = html.split('<div class="rounded-md border p-3">').slice(1)
  const block = blocks.find((b) => b.includes(`>${label}</p>`))
  assert.ok(block, `no summary card labelled ${label} was rendered`)
  return block.slice(0, block.indexOf('</div>'))
}

const GROSS_CREDIT: OrderRefund[] = [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }]
const NET_CREDIT: OrderRefund[] = [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }]

// ---------------------------------------------------------------------------
// A bounded period
// ---------------------------------------------------------------------------

test('cards: a bounded Net Revenue is shown AS a bound, with how loose it is (o3d-iigc)', async () => {
  const { summary, html } = await renderPage(GROSS_CREDIT)
  assert.equal(summary.totalNetRevenue, 100)
  assert.equal(summary.refundBasisComplete, false)

  const netRevenue = card(html, 'Net Revenue')
  // Was the bare string "£100.00", indistinguishable from a measured £100.00.
  assert.match(netRevenue, /£100\.00 ≤/)
  assert.match(netRevenue, /Upper bound — £120\.00 of refunds not subtracted/)
  assert.match(netRevenue, /title="Upper bound: some refunds in this period are on the gross basis/)
  assert.match(netRevenue, /text-orange-600/)
})

test('cards: a bounded Gross Profit drops the colouring that reads as a verdict (o3d-iigc)', async () => {
  const { summary, html } = await renderPage(GROSS_CREDIT)
  assert.equal(summary.totalGrossProfit, 60)

  const grossProfit = card(html, 'Gross Profit')
  assert.match(grossProfit, /£60\.00 ≤/)
  assert.ok(!grossProfit.includes('text-green-600'), 'green is a verdict, and an upper bound does not support one')
  assert.match(grossProfit, /text-orange-600/)
  assert.match(grossProfit, /Upper bound — £120\.00 of refunds not subtracted/)
})

test('cards: a bounded Avg Margin is marked too — it is 1 - COGS/revenue, so it moves with it (o3d-iigc)', async () => {
  const { summary, html } = await renderPage(GROSS_CREDIT)
  assert.equal(summary.avgMarginPct, 60)

  assert.match(card(html, 'Avg Margin'), /60% ≤/)
})

test('cards: COGS and Orders/Qty are basis-independent and are NEVER marked (o3d-iigc)', async () => {
  const { html } = await renderPage(GROSS_CREDIT)

  const cogs = card(html, 'COGS')
  assert.match(cogs, /£40\.00/)
  assert.ok(!cogs.includes('≤'), 'COGS does not move with the refund basis, so marking it would be noise')
  assert.ok(!cogs.includes('Upper bound'))

  // Quantity nets off EVERY refund line whatever its basis: 1 sold, 1 refunded.
  const orders = card(html, 'Orders / Qty')
  assert.match(orders, />1 \/ 0</)
  assert.ok(!orders.includes('≤'))
})

// ---------------------------------------------------------------------------
// An ordinary period — the overwhelming majority
// ---------------------------------------------------------------------------

test('cards: an all-NET period is byte-for-byte what it was, bounds and all absent (o3d-iigc control)', async () => {
  const { summary, html } = await renderPage(NET_CREDIT)
  assert.equal(summary.refundBasisComplete, true)
  assert.equal(summary.totalNetRevenue, 75)
  assert.equal(summary.totalGrossProfit, 35)

  const netRevenue = card(html, 'Net Revenue')
  assert.match(netRevenue, />£75\.00</, 'no bound mark, no explanatory line — it is a measurement')
  assert.ok(!netRevenue.includes('≤'))
  assert.ok(!netRevenue.includes('Upper bound'))
  assert.ok(!netRevenue.includes('text-orange-600'))

  const grossProfit = card(html, 'Gross Profit')
  assert.match(grossProfit, /text-green-600/, 'and the verdict colouring is still there when it is earned')
  assert.match(grossProfit, />£35\.00</)
})

test('cards: an UNSTAMPED credit bounds the cards too, by its own amount (o3d-iigc)', async () => {
  const { html } = await renderPage([{ totalsBasis: null, lines: [{ productId: 'p1', qty: 1, totalBase: 30 }] }])

  // The bound is the gross-basis PLUS unknown-basis credit — every refund the ex-VAT revenue could
  // not absorb, not merely the ones stamped GROSS.
  assert.match(card(html, 'Net Revenue'), /£100\.00 ≤/)
  assert.match(card(html, 'Net Revenue'), /Upper bound — £30\.00 of refunds not subtracted/)
})
