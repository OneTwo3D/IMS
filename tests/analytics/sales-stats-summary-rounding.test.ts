import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-iigc round 5, Codex finding 2: THE PERIOD MARGIN CARRIED A `≤` THAT ROUNDING MADE FALSE.
 *
 * `marginFigureBound` reasons about the report's OWN margin function applied to an unknown true net
 * revenue. The summary was not calling that function on the same numbers: it re-summed the ROUNDED
 * per-row fields and divided those, so the published ratio and the counterfactual the mark was
 * classified against were two different functions of two different quantities.
 *
 * THE COUNTEREXAMPLE, worked. One product: £0.016 of ex-VAT revenue, £0.025 of COGS, and £0.014 of
 * credit whose basis was never proved.
 *
 *   round each row field first  → revenue £0.02, COGS £0.03, unplaced credit £0.01
 *   published summary margin    → -0.01 / 0.02 = -50.0%
 *   marginFigureBound case 3    → 0.02 - 0.01 = 0.01 > 0, so `upper`, so the card printed `-50% ≤`
 *
 * Now suppose that credit proves NET. It is subtracted BEFORE the row is rounded, so revenue is
 * £0.002, which rounds to £0.00, and the report's own `netRevenue > 0` guard publishes 0.0%.
 *
 *   0.0% IS NOT AT MOST -50.0%.
 *
 * The `≤` was manufactured entirely by rounding twice. Marking a figure with the wrong relation is
 * worse than not marking it, so the fix is not a looser mark — it is to publish the ratio and
 * classify it from the SAME unrounded quantities, which is also what the module's own rounding rule
 * says ("rounding happens once, in the caller-facing figure, never on the intermediate sums").
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

type RefundLine = { productId: string | null; qty: number; totalBase: number }
let ORDERS: unknown[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: { findMany: async () => ORDERS },
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

function order(lineTotalBase: number, cogsBase: number, totalsBasis: string | null, credit: number) {
  const lines: RefundLine[] = [{ productId: 'p1', qty: 1, totalBase: credit }]
  return {
    id: 'A', totalBase: lineTotalBase, discountAmount: 0, fxRateToBase: 1,
    pricesIncludeVat: false, taxRatePercent: 0.2,
    customerName: 'Acme', salesRep: null, shoppingLinks: [],
    lines: [{
      productId: 'p1', sku: 'SKU-1', description: 'Widget',
      qty: 1, totalBase: lineTotalBase, discountAmount: 0, cogsBase, taxRate: { rate: 0.2 },
    }],
    refunds: [{ totalsBasis, lines }],
  }
}

async function stats(totalsBasis: string | null) {
  ORDERS = [order(0.016, 0.025, totalsBasis, 0.014)]
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  return getProductSalesStats()
}

test('the period margin is published from UNROUNDED totals — -56.2%, not -50% (o3d-iigc r5 #2)', async () => {
  const { summary } = await stats(null)

  // The money totals still round to the penny for display, and are unchanged.
  assert.equal(summary.totalNetRevenue, 0.02)
  assert.equal(summary.totalCogs, 0.03)
  assert.equal(summary.totalGrossProfit, -0.01)
  assert.equal(summary.totalRefundsUnknownBasis, 0.01)
  assert.equal(summary.refundBasisComplete, false)

  // The RATIO is not: -0.009 / 0.016 = -56.25%. Re-dividing the rounded pennies gave -50%.
  assert.equal(summary.avgMarginPct, -56.2)
  assert.equal(summary.avgMarginPctBound, 'upper')
})

test('and the ≤ it prints is now TRUE of the report’s own output (o3d-iigc r5 #2)', async () => {
  // The claim `≤` makes is checkable, so check it against the report itself rather than against a
  // restatement of the helper: run the SAME figures with the credit proved NET, which is the
  // counterfactual the bound is about, and compare what the report publishes in each case.
  const unproven = await stats(null)
  const proven = await stats('NET')

  assert.equal(unproven.summary.avgMarginPctBound, 'upper', 'the published figure claims to be a ceiling')
  assert.equal(proven.summary.refundBasisComplete, true, 'the counterfactual has nothing left unplaced')

  // 0.016 - 0.014 = 0.002 of revenue against 0.025 of COGS → -1150%.
  assert.equal(proven.summary.avgMarginPct, -1150)
  assert.ok(
    proven.summary.avgMarginPct <= unproven.summary.avgMarginPct,
    `the ≤ must hold: ${proven.summary.avgMarginPct}% is not at most ${unproven.summary.avgMarginPct}%`,
  )
  // Before this fix the two sides were 0% and -50%, and this assertion failed — which is the whole
  // finding: the card claimed a relation its own output contradicted.
})

test('an ordinary period is unmoved by the change of accumulator (o3d-iigc r5 control)', async () => {
  ORDERS = [order(100, 40, 'NET', 25)]
  const { getProductSalesStats } = await import('@/app/actions/sales-stats')
  const { summary, rows } = await getProductSalesStats()

  // Whole pennies sum identically whether they are rounded before or after, so nothing a real
  // period shows may move. The control is not vacuous — the test above changes by 6.2 points.
  assert.equal(summary.totalGrossRevenue, 100)
  assert.equal(summary.totalRefunds, 25)
  assert.equal(summary.totalNetRevenue, 75)
  assert.equal(summary.totalCogs, 40)
  assert.equal(summary.totalGrossProfit, 35)
  assert.equal(summary.avgMarginPct, 46.7)
  assert.equal(summary.avgMarginPctBound, 'exact')
  assert.equal(summary.avgOrderValue, 75)
  assert.equal(rows[0]?.netRevenue, 75)
})

test('the row-level margin was already unrounded and is untouched (o3d-iigc r5 control)', async () => {
  const { rows } = await stats(null)

  // Rows classified from unrounded figures before the fix and still do. If the fix had "helpfully"
  // re-based rows on rounded values this would move.
  assert.equal(rows[0]?.marginPct, -56.2)
  assert.equal(rows[0]?.marginPctBound, 'upper')
  assert.equal(rows[0]?.netRevenue, 0.02)
})
