import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

/**
 * o3d-la3n: EVERY PLACE THIS PAGE PRINTS A RELATION, PINNED TO THE PRODUCER'S VERDICT.
 *
 * o3d-7jfq fixed the same arithmetic in Sales Statistics and the dashboard, and left this page — one
 * producer and fourteen consumer sites — deriving its own. Twelve of them derived it from
 * `…RefundBasisComplete`, a BOOLEAN, which has no third value and so could never say that the
 * direction is unknown; the other two, the CSV's `Revenue bound` and `Profit bound` columns, derived
 * it from `refundsGrossBasis + refundsUnknownBasis`, a SIGNED SUM in which +£120 and −£120 of
 * gross-basis credit cancel to a zero that is not negative.
 *
 * THE TEST IS A CONTRADICTORY ROW. Each fixture below carries a `…RefundBasisComplete` flag that
 * disagrees with its published `…RevenueBound`. A site that still reads the flag prints the opposite
 * mark from a site that reads the marker, so one render decides all fourteen at once — and no site
 * can pass by coincidence, because the coincidence is exactly what the fixture removes.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) },
})

// The harness has no useContext; the hook is replaced by its real default (as in the export tests).
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'PREFIX' }) },
})

/**
 * Every column made visible, so the PREVIOUS-FY cells and footers are rendered too. `loadCols`
 * reads the saved view from localStorage when a window exists; the default view hides them, and a
 * defect behind a hidden column is still a defect that ships.
 */
const ALL_KEYS = [
  'sku', 'name', 'lifecycleStatus', 'totalStock', 'unitMarginPct',
  'currentFyRevenue', 'currentFyRefundsGrossBasis', 'currentFyRefundsUnknownBasis', 'currentFyCogs', 'currentFyProfit', 'currentFyQtySold',
  'previousFyRevenue', 'previousFyRefundsGrossBasis', 'previousFyRefundsUnknownBasis', 'previousFyCogs', 'previousFyProfit', 'previousFyQtySold',
]
;(globalThis as Record<string, unknown>).window = (globalThis as Record<string, unknown>).window ?? {}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => JSON.stringify(ALL_KEYS),
  setItem: () => {},
}

type Bound = 'exact' | 'upper' | 'indeterminate'

function fixture(opts: { currentFlag: boolean; currentBound: Bound; previousFlag: boolean; previousBound: Bound; grossBasis?: number }) {
  const gross = opts.grossBasis ?? 60
  const row = {
    productId: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE',
    totalStock: 0, salesPrice: null, salePrice: null, latestCogs: null, unitMargin: null, unitMarginPct: null,
    currentFyRevenue: 100, currentFyRefundsGrossBasis: gross, currentFyRefundsUnknownBasis: 0,
    currentFyRefundBasisComplete: opts.currentFlag, currentFyRevenueBound: opts.currentBound,
    currentFyCogs: 40, currentFyProfit: 60, currentFyQtySold: 1,
    previousFyRevenue: 50, previousFyRefundsGrossBasis: 0, previousFyRefundsUnknownBasis: 0,
    previousFyRefundBasisComplete: opts.previousFlag, previousFyRevenueBound: opts.previousBound,
    previousFyCogs: 20, previousFyProfit: 30, previousFyQtySold: 1,
  }
  return {
    data: {
      rows: [row],
      summary: {
        totalProducts: 1,
        currentFyRevenue: 100, currentFyRefundsGrossBasis: gross, currentFyRefundsUnknownBasis: 0,
        currentFyRefundBasisComplete: opts.currentFlag, currentFyRevenueBound: opts.currentBound,
        currentFyCogs: 40, currentFyProfit: 60,
        previousFyRevenue: 50, previousFyRefundsGrossBasis: 0, previousFyRefundsUnknownBasis: 0,
        previousFyRefundBasisComplete: opts.previousFlag, previousFyRevenueBound: opts.previousBound,
        previousFyCogs: 20, previousFyProfit: 30,
        fyLabel: 'FY26', prevFyLabel: 'FY25',
      },
    },
  }
}

async function renderPage(props: ReturnType<typeof fixture>) {
  const { ProductProfitabilityClient } = await import('@/app/(dashboard)/analytics/product-profitability/product-profitability-client')
  return mountClientComponent(ProductProfitabilityClient as unknown as (p: unknown) => unknown, props)
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) { count++; index = haystack.indexOf(needle, index + needle.length) }
  return count
}

/**
 * The revenue figure appears three times over — table cell, column footer, summary card — and the
 * profit figure likewise. Asserting the COUNT, not merely "somewhere in the page", is what makes a
 * single un-migrated site fail: eleven right and one wrong is two `≤` and one `?` on the same number.
 */
const REVENUE_SITES = 3
const PROFIT_SITES = 3

test('a row whose verdict is `indeterminate` prints `?` at every site, even where the flag says complete (o3d-la3n)', async () => {
  const mounted = await renderPage(fixture({
    currentFlag: true, currentBound: 'indeterminate',
    previousFlag: true, previousBound: 'exact',
  }))
  const { html } = mounted.render()

  assert.equal(occurrences(html, '£100.00 ?'), REVENUE_SITES, 'revenue: table cell, footer and card')
  assert.equal(occurrences(html, '£60.00 ?'), PROFIT_SITES, 'profit moves with revenue one for one, so it carries the same relation')
  assert.equal(occurrences(html, '£100.00 ≤'), 0, 'the direction is NOT established; `≤` here is a false claim')
  assert.equal(occurrences(html, '£60.00 ≤'), 0)

  // The width sentence is dropped: the two bucket columns are the width only while nothing cancelled.
  assert.ok(!html.includes('Not subtracted:'), 'the £60.00 bucket is a cancelled remainder, not the width of the bound')
  assert.ok(html.includes('Direction not established'), 'and the card says what IS known instead')

  // The previous FY, on the same row, is exact — proving the marks are per figure, not per page.
  assert.equal(occurrences(html, '£50.00 ?'), 0)
  assert.equal(occurrences(html, '£50.00 ≤'), 0)
})

test('a row whose verdict is `exact` prints NO relation, even where the flag says incomplete (o3d-la3n)', async () => {
  const mounted = await renderPage(fixture({
    currentFlag: false, currentBound: 'exact',
    previousFlag: false, previousBound: 'exact',
  }))
  const { html } = mounted.render()

  assert.equal(occurrences(html, '£100.00 ≤'), 0, 'every site that still read the boolean would mark this')
  assert.equal(occurrences(html, '£100.00 ?'), 0)
  assert.equal(occurrences(html, '£60.00 ≤'), 0)
  assert.equal(occurrences(html, '£50.00 ≤'), 0)
  assert.ok(!html.includes('Not subtracted:'))
  assert.ok(!html.includes('Direction not established'))
})

test('an ordinary `upper` verdict still prints `≤` and still quotes the width (o3d-la3n)', async () => {
  const mounted = await renderPage(fixture({
    currentFlag: false, currentBound: 'upper',
    previousFlag: false, previousBound: 'upper',
  }))
  const { html } = mounted.render()

  assert.equal(occurrences(html, '£100.00 ≤'), REVENUE_SITES)
  assert.equal(occurrences(html, '£60.00 ≤'), PROFIT_SITES)
  assert.equal(occurrences(html, '£50.00 ≤'), REVENUE_SITES, 'the previous FY is marked on the same terms')
  assert.equal(occurrences(html, '£30.00 ≤'), PROFIT_SITES)
  assert.equal(occurrences(html, '£100.00 ?'), 0)
  assert.ok(html.includes('Not subtracted:'), 'nothing cancelled, so the bucket columns ARE the width')
  assert.ok(!html.includes('Direction not established'))
})

test('the CSV’s two bound columns are the published verdict, not a re-derivation from the buckets (o3d-la3n)', async () => {
  // The signed bucket is a positive £60.00 and the flag is true — the two things the old code
  // classified from. Both said `upper`; the producer said `indeterminate`, and the file must agree
  // with the producer. This page has no server export route, so this CSV is its whole export.
  const captured: Blob[] = []
  const realCreate = globalThis.URL.createObjectURL
  const realRevoke = globalThis.URL.revokeObjectURL
  const hadDocument = 'document' in globalThis
  globalThis.URL.createObjectURL = ((blob: Blob) => { captured.push(blob); return 'blob:test' }) as typeof URL.createObjectURL
  globalThis.URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  ;(globalThis as { document?: unknown }).document = { createElement: () => ({ href: '', download: '', click() {} }) }

  try {
    const mounted = await renderPage(fixture({
      currentFlag: true, currentBound: 'indeterminate',
      previousFlag: false, previousBound: 'upper',
    }))
    const { controls } = mounted.render()
    await mounted.click(controls.find((c) => c.label.includes('Export')))

    assert.equal(captured.length, 1)
    const csv = await captured[0].text()
    const header = csv.split('\n')[0].split(',')
    const values = csv.split('\n')[1].split(',')

    assert.equal(values[header.indexOf('Refunds gross-basis (FY26)')], '60', 'the signed bucket really is positive; that is the trap')
    assert.equal(values[header.indexOf('Revenue bound (FY26)')], 'indeterminate')
    assert.equal(values[header.indexOf('Profit bound (FY26)')], 'indeterminate')
    assert.equal(values[header.indexOf('Revenue bound (FY25)')], 'upper', 'and a sound bound in the same file is untouched')
    assert.equal(values[header.indexOf('Profit bound (FY25)')], 'upper')
  } finally {
    globalThis.URL.createObjectURL = realCreate
    globalThis.URL.revokeObjectURL = realRevoke
    if (!hadDocument) delete (globalThis as { document?: unknown }).document
  }
})

test('a FILTERED subtotal combines the rows it actually contains (o3d-la3n)', async () => {
  // Two rows, one `upper` and one `indeterminate`. The page re-sums whatever the operator filtered
  // to, so the producer cannot publish a marker for the subtotal — it has to be combined here, and
  // combining it as `every(row.flag)` would print `≤` over an indeterminate constituent.
  const { ProductProfitabilityClient } = await import('@/app/(dashboard)/analytics/product-profitability/product-profitability-client')
  const base = fixture({ currentFlag: false, currentBound: 'upper', previousFlag: true, previousBound: 'exact' }).data
  const clean = { ...base.rows[0] }
  const dirty = {
    ...base.rows[0], productId: 'p2', sku: 'SKU-2', name: 'Gadget',
    currentFyRevenue: 200, currentFyProfit: 150, currentFyCogs: 50,
    currentFyRefundBasisComplete: true, currentFyRevenueBound: 'indeterminate' as Bound,
  }
  const mounted = mountClientComponent(ProductProfitabilityClient as unknown as (p: unknown) => unknown, {
    data: {
      rows: [clean, dirty],
      summary: {
        ...base.summary,
        currentFyRevenue: 300, currentFyProfit: 210, currentFyCogs: 90,
        currentFyRefundBasisComplete: false, currentFyRevenueBound: 'indeterminate',
      },
    },
  })
  const { html } = mounted.render()

  // Card and footer both show the £300.00 subtotal; one `indeterminate` constituent decides it.
  assert.equal(occurrences(html, '£300.00 ?'), 2, 'footer and card')
  assert.equal(occurrences(html, '£300.00 ≤'), 0)
  // The constituent rows keep their own, different verdicts.
  assert.equal(occurrences(html, '£100.00 ≤'), 1, 'the sound row is still a sound ceiling')
  assert.equal(occurrences(html, '£200.00 ?'), 1)
})
