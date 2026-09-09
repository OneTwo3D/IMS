import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { mountClientComponent } from '@/tests/fixtures/render-client-component'

/**
 * o3d-la3n: EVERY PLACE THIS PAGE PRINTS A RELATION, PINNED TO THE PRODUCER'S INTERVAL.
 *
 * o3d-7jfq fixed the same arithmetic in Sales Statistics and the dashboard and left this page — one
 * producer and fourteen consumer sites — deriving its own. Twelve of them derived it from
 * `…RefundBasisComplete`, a BOOLEAN, which has no third value and so could never say that the
 * direction is unknown; the other two, the CSV's `Revenue bound` and `Profit bound` columns, derived
 * it from `refundsGrossBasis + refundsUnknownBasis`, a SIGNED SUM in which +£120 and −£120 of
 * gross-basis credit cancel to a zero that is not negative.
 *
 * ROUND 2 REMOVED THE INGREDIENTS AS WELL AS THE RULE. The boolean is no longer published at all,
 * and each bounded amount arrives paired with the INTERVAL its truth occupies. So the contradictory
 * fixture that keeps these tests honest is now between the interval and the two DISCLOSURE buckets:
 * every fixture below publishes bucket columns that flatly disagree with its interval. A site that
 * still reads a bucket prints a different mark from one that reads the interval, and no site can
 * pass by coincidence, because the coincidence is exactly what the fixture removes.
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

type Interval = { lower: number; upper: number }
const EXACT: Interval = { lower: 0, upper: 0 }

/**
 * `disclose` is the two SIGNED bucket columns. Every fixture sets them to something the interval
 * contradicts — a fat positive bucket on an exact row, an empty one on an indeterminate row — so
 * that any site deriving a relation from them fails loudly.
 */
function fy(revenue: number, cogs: number, bound: Interval, disclose: { gross: number; unknown: number }) {
  return { revenue, cogs, profit: revenue - cogs, qtySold: 1, bound, refundsGrossBasis: disclose.gross, refundsUnknownBasis: disclose.unknown }
}

type Fy = ReturnType<typeof fy>

function row(id: string, name: string, currentFy: Fy, previousFy: Fy) {
  return {
    productId: id, sku: `SKU-${id}`, name, type: 'SIMPLE', lifecycleStatus: 'ACTIVE',
    totalStock: 0, salesPrice: null, salePrice: null, latestCogs: null, unitMargin: null, unitMarginPct: null,
    currentFy, previousFy,
  }
}

function props(rows: ReturnType<typeof row>[]) {
  return {
    data: {
      rows,
      // The client renders the FILTERED subtotal it folds itself; the server summary supplies the
      // period labels. Deliberately given figures nothing on screen should ever show.
      summary: {
        totalProducts: rows.length,
        currentFy: fy(-999, -999, EXACT, { gross: 0, unknown: 0 }),
        previousFy: fy(-999, -999, EXACT, { gross: 0, unknown: 0 }),
        fyLabel: 'FY26', prevFyLabel: 'FY25',
      },
    },
  }
}

async function renderPage(p: ReturnType<typeof props>) {
  const { ProductProfitabilityClient } = await import('@/app/(dashboard)/analytics/product-profitability/product-profitability-client')
  return mountClientComponent(ProductProfitabilityClient as unknown as (x: unknown) => unknown, p)
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

// A single row whose CURRENT FY carries `bound` and whose PREVIOUS FY is exact, with disclosure
// buckets that contradict both.
function oneRow(bound: Interval, disclose = { gross: 60, unknown: 0 }) {
  return props([row('p1', 'Widget',
    fy(100, 40, bound, disclose),
    fy(50, 20, EXACT, { gross: 77, unknown: 13 }),
  )])
}

test('an INDETERMINATE interval prints `?` at every site, and no bucket column can talk it out of it (o3d-la3n)', async () => {
  // +£120 and −£120 of gross-basis credit: the interval remembers both, the £0.00 bucket cannot.
  const { html } = (await renderPage(oneRow({ lower: -120, upper: 120 }, { gross: 0, unknown: 0 }))).render()

  assert.equal(occurrences(html, '£100.00 ?'), REVENUE_SITES, 'revenue: table cell, footer and card')
  assert.equal(occurrences(html, '£60.00 ?'), PROFIT_SITES, 'profit moves with revenue one for one, so it carries the same relation')
  assert.equal(occurrences(html, '£100.00 ≤'), 0, 'the direction is NOT established; `≤` here is a false claim')
  assert.equal(occurrences(html, '£100.00 ≥'), 0)
  assert.equal(occurrences(html, '£60.00 ≤'), 0)

  // The width sentence is dropped: no single direction describes an interval that runs both ways.
  assert.ok(!html.includes('Not subtracted: up to'), 'a cancelled remainder is not the width of the bound')
  assert.ok(html.includes('Direction not established'), 'and the card says what IS known instead')

  // The previous FY, on the same row, is exact — proving the marks are per figure, not per page —
  // even though its bucket columns are the fattest on the page.
  assert.equal(occurrences(html, '£50.00 ?'), 0)
  assert.equal(occurrences(html, '£50.00 ≤'), 0)
  assert.equal(occurrences(html, '£77.00'), 2, 'the disclosed bucket is still SHOWN: cell and footer')
})

test('an EXACT interval prints NO relation, however large the bucket columns beside it (o3d-la3n)', async () => {
  const { html } = (await renderPage(oneRow(EXACT, { gross: 60, unknown: 5 }))).render()

  assert.equal(occurrences(html, '£100.00 ≤'), 0, 'every site that derived a mark from the buckets would mark this')
  assert.equal(occurrences(html, '£100.00 ?'), 0)
  assert.equal(occurrences(html, '£100.00 ≥'), 0)
  assert.equal(occurrences(html, '£60.00 ≤'), 0)
  assert.equal(occurrences(html, '£100.00'), REVENUE_SITES, 'the figure itself is still printed, unmarked')
  assert.ok(!html.includes('Not subtracted: up to'))
  assert.ok(!html.includes('Direction not established'))
})

test('an ordinary UPPER interval prints `≤` and quotes the width FROM THE INTERVAL (o3d-la3n)', async () => {
  // Interval width £120; the bucket column says £7. The card must quote the interval.
  const { html } = (await renderPage(oneRow({ lower: -120, upper: 0 }, { gross: 7, unknown: 0 }))).render()

  assert.equal(occurrences(html, '£100.00 ≤'), REVENUE_SITES)
  assert.equal(occurrences(html, '£60.00 ≤'), PROFIT_SITES)
  assert.equal(occurrences(html, '£100.00 ?'), 0)
  assert.ok(html.includes('Not subtracted: up to £120.00 of credit'), 'the width is the interval, not the bucket')
  assert.ok(!html.includes('£7.00 of credit'))
  assert.ok(!html.includes('Direction not established'))
})

/**
 * CODEX ROUND 1, HIGH 2, AT THE GLASS. A negative-only unplaced credit puts the truth between the
 * published figure and published + 30. Round 1 had no `lower` verdict and printed `?`, telling the
 * reader the truth might be below a figure it provably cannot be below.
 */
test('a LOWER interval prints `≥`, not `?` — the published figure is a floor (o3d-la3n r2)', async () => {
  const { html } = (await renderPage(oneRow({ lower: 0, upper: 30 }, { gross: -30, unknown: 0 }))).render()

  assert.equal(occurrences(html, '£100.00 ≥'), REVENUE_SITES)
  assert.equal(occurrences(html, '£60.00 ≥'), PROFIT_SITES)
  assert.equal(occurrences(html, '£100.00 ?'), 0, 'round 1 printed this')
  assert.equal(occurrences(html, '£100.00 ≤'), 0, 'and marking it `≤` would be the opposite of the truth')
  assert.ok(html.includes('Not subtracted: up to £30.00 of NEGATIVE credit'))
})

test('the CSV’s two bound columns are the published verdict, not a re-derivation from the buckets (o3d-la3n)', async () => {
  // The signed bucket is a positive £60.00 — the thing the old code classified from. It said
  // `upper`; the interval says `indeterminate`, and the file must agree with the interval. This
  // page has no server export route, so this CSV is its whole export.
  const captured: Blob[] = []
  const realCreate = globalThis.URL.createObjectURL
  const realRevoke = globalThis.URL.revokeObjectURL
  const hadDocument = 'document' in globalThis
  globalThis.URL.createObjectURL = ((blob: Blob) => { captured.push(blob); return 'blob:test' }) as typeof URL.createObjectURL
  globalThis.URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  ;(globalThis as { document?: unknown }).document = { createElement: () => ({ href: '', download: '', click() {} }) }

  try {
    const mounted = await renderPage(props([row('p1', 'Widget',
      fy(100, 40, { lower: -120, upper: 60 }, { gross: 60, unknown: 0 }),
      fy(50, 20, { lower: 0, upper: 30 }, { gross: -30, unknown: 0 }),
    )]))
    const { controls } = mounted.render()
    await mounted.click(controls.find((c) => c.label.includes('Export')))

    assert.equal(captured.length, 1)
    const csv = await captured[0].text()
    const header = csv.split('\n')[0].split(',')
    const values = csv.split('\n')[1].split(',')

    assert.equal(values[header.indexOf('Refunds gross-basis (FY26)')], '60', 'the signed bucket really is positive; that is the trap')
    assert.equal(values[header.indexOf('Revenue bound (FY26)')], 'indeterminate')
    assert.equal(values[header.indexOf('Profit bound (FY26)')], 'indeterminate')
    assert.equal(values[header.indexOf('Revenue bound (FY25)')], 'lower', 'and the fourth verdict reaches the file too')
    assert.equal(values[header.indexOf('Profit bound (FY25)')], 'lower')
  } finally {
    globalThis.URL.createObjectURL = realCreate
    globalThis.URL.revokeObjectURL = realRevoke
    if (!hadDocument) delete (globalThis as { document?: unknown }).document
  }
})

test('a FILTERED subtotal adds the INTERVALS of the rows it actually contains (o3d-la3n)', async () => {
  // One `upper` row and one `lower` row. Each is individually determinate; the subtotal is not, and
  // no fold of the two MARKS could have told this subset from one whose lower row is exact.
  const { html } = (await renderPage(props([
    row('p1', 'Widget', fy(100, 40, { lower: -12, upper: 0 }, { gross: 12, unknown: 0 }), fy(0, 0, EXACT, { gross: 0, unknown: 0 })),
    row('p2', 'Gadget', fy(200, 50, { lower: 0, upper: 30 }, { gross: -30, unknown: 0 }), fy(0, 0, EXACT, { gross: 0, unknown: 0 })),
  ]))).render()

  // Card and footer both show the £300.00 subtotal; the summed interval [-12, +30] decides it.
  assert.equal(occurrences(html, '£300.00 ?'), 2, 'footer and card')
  assert.equal(occurrences(html, '£300.00 ≤'), 0)
  assert.equal(occurrences(html, '£300.00 ≥'), 0)
  // The constituent rows keep their own, different verdicts.
  assert.equal(occurrences(html, '£100.00 ≤'), 1, 'the sound ceiling is still a ceiling')
  assert.equal(occurrences(html, '£200.00 ≥'), 1, 'and the sound floor is still a floor')
})

test('a subtotal of two UPPER rows is an upper bound whose width is the SUM of theirs (o3d-la3n r2)', async () => {
  const { html } = (await renderPage(props([
    row('p1', 'Widget', fy(100, 40, { lower: -12, upper: 0 }, { gross: 12, unknown: 0 }), fy(0, 0, EXACT, { gross: 0, unknown: 0 })),
    row('p2', 'Gadget', fy(200, 50, { lower: -30, upper: 0 }, { gross: 30, unknown: 0 }), fy(0, 0, EXACT, { gross: 0, unknown: 0 })),
  ]))).render()

  assert.equal(occurrences(html, '£300.00 ≤'), 2, 'footer and card')
  assert.ok(html.includes('Not subtracted: up to £42.00 of credit'), '12 + 30 — endpoints add')
})

/**
 * CODEX ROUND 1, HIGH 1, AT THE GLASS.
 *
 * THREE products, raw FY revenue £0.014 each, each carrying £0.001 of positive unplaced credit.
 * Round 1 rounded each row to cents at the producer, so the page summed £0.01 + £0.01 + £0.01 and
 * printed "£0.03 ≤" — below a completed-basis aggregate that lies in [£0.039, £0.042]. The row
 * markers were individually correct, which is exactly why this could not be separated from bound
 * correctness: the relation was true of a number the page had already thrown away.
 *
 * What ships now: the rows arrive unrounded, the subtotal is summed unrounded, and the ONE rounding
 * happens at display in the direction the relation allows. £0.042 as a ceiling is £0.05, and a row's
 * own £0.014 as a ceiling is £0.02 — never £0.01, which £0.014 is not at most.
 */
test('sub-cent rows do not sum into a ceiling below the truth (o3d-la3n r2, o3d-l4zz)', async () => {
  const each = fy(0.014, 0, { lower: -0.001, upper: 0 }, { gross: 0.001, unknown: 0 })
  const clean = fy(0, 0, EXACT, { gross: 0, unknown: 0 })
  const { html } = (await renderPage(props([
    row('p1', 'Widget', each, clean),
    row('p2', 'Gadget', each, clean),
    row('p3', 'Doodah', each, clean),
  ]))).render()

  // Round 1's per-row figure, and round 1's subtotal. Neither is a ceiling, so neither may appear.
  assert.equal(occurrences(html, '£0.01 ≤'), 0, '£0.014 is not at most £0.01')
  assert.equal(occurrences(html, '£0.03 ≤'), 0, 'three rounded rows summed to £0.03, below a true minimum of £0.039')
  // What the page prints instead: each row's own ceiling (revenue and profit cells, three rows) and
  // the subtotal's (two footers and two cards).
  assert.equal(occurrences(html, '£0.02 ≤'), 6, 'per row: revenue cell and profit cell, rounded UP')
  assert.equal(occurrences(html, '£0.05 ≤'), 4, 'subtotal: revenue footer, profit footer, revenue card, profit card')
})
