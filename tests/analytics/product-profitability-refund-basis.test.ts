import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Import-free and pure by contract, so it is safe above the module mocks below.
import * as linear from '@/lib/domain/sales/derived-figure-bound'

/**
 * o3d-iigc: the FY profitability report built `revenue` from ex-VAT line totals and then did
 * `agg.revenue -= Number(rl.totalBase)` for every refund line, whatever basis the parent refund was
 * stamped with. The previous FY is far likelier to hold GROSS-basis credits than the current one, so
 * the defect landed hardest on exactly the column pair the report exists to compare.
 *
 * Worked example: a £120 taxable order at 20% — £100 net + £20 VAT — credited in full by a legacy
 * GROSS refund. The old arithmetic reported that product's FY revenue as MINUS £20.
 */

mock.module('@/lib/auth/server', {
  namedExports: { requirePermission: async () => ({ user: { id: 'u1' } }) },
})

const NOW = new Date()
// The org FY below starts 1 January, so the current FY is this calendar year and the previous FY is
// the one before it, whatever month the suite runs in. The two FY queries differ only in their
// createdAt.gte, so that is what the fixture db dispatches on.
const CURRENT_FY_YEAR = NOW.getFullYear()

type RefundFixture = { totalsBasis: string | null; lines: { productId: string; qty: number; totalBase: number }[] }
type OrderFixture = {
  lines: { productId: string; qty: number; totalBase: number; cogsBase: number }[]
  refunds: RefundFixture[]
}

function order(o: OrderFixture) {
  return {
    // Ex-VAT contract, no discounts, no FX — the refund basis is the only variable.
    fxRateToBase: 1, discountAmount: 0, pricesIncludeVat: false, taxRatePercent: 20,
    shoppingLinks: [],
    lines: o.lines.map((l) => ({ ...l, discountAmount: 0, taxRate: { rate: 0.2 } })),
    refunds: o.refunds,
  }
}

let CURRENT_FY_ORDERS: ReturnType<typeof order>[] = []
let PREVIOUS_FY_ORDERS: ReturnType<typeof order>[] = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      organisation: {
        findFirst: async () => ({ financialYearStartMonth: 1, financialYearStartDay: 1 }),
      },
      product: {
        findMany: async () => [
          { id: 'p1', sku: 'SKU-1', name: 'Widget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: null, salePriceBase: null, stockLevels: [] },
          { id: 'p2', sku: 'SKU-2', name: 'Gadget', type: 'SIMPLE', lifecycleStatus: 'ACTIVE', salesPriceBase: null, salePriceBase: null, stockLevels: [] },
        ],
      },
      costLayer: { findMany: async () => [] },
      salesOrder: {
        findMany: async (args: { where: { createdAt: { gte: Date } } }) =>
          (args.where.createdAt.gte.getFullYear() === CURRENT_FY_YEAR ? CURRENT_FY_ORDERS : PREVIOUS_FY_ORDERS),
      },
    },
  },
})

async function rowsBySku() {
  const { getProductProfitability } = await import('@/app/actions/product-profitability')
  const { rows, summary } = await getProductProfitability()
  return { bySku: new Map(rows.map((r) => [r.sku, r])), summary }
}

test('a legacy GROSS credit is NOT subtracted from ex-VAT FY revenue — £100, not -£20 (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRevenue, 100, 'the VAT-inclusive credit is not the same unit as this figure')
  assert.equal(r.currentFyRefundsGrossBasis, 120, 'it is reported beside the revenue, not discarded')
  assert.equal(r.currentFyRefundsUnknownBasis, 0)
  assert.equal(r.currentFyRefundBasisComplete, false, 'revenue is an upper bound and says so')
  assert.equal(r.currentFyProfit, 60, 'old arithmetic gave -60 here (-20 revenue less £40 COGS)')
  // Quantity is basis-independent — the unit came back whatever the credit was stamped with.
  assert.equal(r.currentFyQtySold, 0)
})

test('the previous-FY column is fixed on the same terms, so the FY comparison is like-for-like (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 2, totalBase: 200, cogsBase: 80 }],
    refunds: [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 100 }] }],
  })]
  PREVIOUS_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 2, totalBase: 200, cogsBase: 80 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRevenue, 100, 'modern NET credit, subtracted as before')
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.previousFyRevenue, 200, 'old arithmetic gave 80, understating the prior FY by the VAT')
  assert.equal(r.previousFyRefundsGrossBasis, 120)
  assert.equal(r.previousFyRefundBasisComplete, false)
  assert.equal(r.previousFyProfit, 120, 'old arithmetic gave 0')
})

test('a SUB-PENNY unstamped credit still makes the row an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0.004 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRefundBasisComplete, false, 'dust is still value')
  assert.equal(r.currentFyRefundsUnknownBasis, 0, 'the amount rounds away, but the FLAG does not')
  assert.equal(r.currentFyRevenue, 50)
})

test('an EXACTLY-zero unstamped credit leaves the row exact (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  // Zero is identical on both bases, so it carries no basis information.
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.currentFyRevenue, 50)
})

test('the summary is complete only when EVERY row is, and totals the unplaceable value (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 100, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 60, cogsBase: 0 },
    ],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
      { totalsBasis: 'NET', lines: [{ productId: 'p2', qty: 0, totalBase: 10 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(bySku.get('SKU-2')!.currentFyRefundBasisComplete, true, 'a clean row stays clean')
  assert.equal(bySku.get('SKU-2')!.currentFyRevenue, 50)
  assert.equal(summary.currentFyRefundBasisComplete, false, 'one dirty row taints the total')
  assert.equal(summary.currentFyRefundsGrossBasis, 120)
  assert.equal(summary.currentFyRefundsUnknownBasis, 0)
  // 100 + 50. The old total was (100 - 120) + 50 = 30.
  assert.equal(summary.currentFyRevenue, 150)
})

test('a product with no sales at all is not reported as an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = []
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-2')!

  // There is nothing it failed to subtract, so nothing to warn about.
  assert.equal(r.currentFyRefundBasisComplete, true)
  assert.equal(r.previousFyRefundBasisComplete, true)
  assert.equal(r.currentFyRevenue, 0)
})

// ---------------------------------------------------------------------------
// o3d-la3n: A `≤` MAY NOT COME OFF A SIGNED CREDIT SUM, OR OFF A BOOLEAN
// ---------------------------------------------------------------------------

/**
 * THE DEFECT IN MONEY. Widget sells for £100 ex-VAT in the FY against £40 of COGS, and carries two
 * GROSS-basis credits: +£120.00 and −£60.00 (a credit and a partial reversal of it, both stamped
 * gross, neither placeable on this report's ex-VAT basis).
 *
 *   published FY revenue                 £100.00      no gross-basis credit is subtracted
 *   published FY profit                  £ 60.00
 *   published `refundsGrossBasis`        £ 60.00      120 + (−60) — THE SIGNED SUM
 *
 * Every consumer classified the bound from that £60.00, or from the boolean beside it. £60.00 is not
 * negative, so all fourteen of them printed `≤`: "FY revenue is AT MOST £100.00".
 *
 * It is not. The unplaced credit's true ex-VAT value lies in [Σ min(entry,0), Σ max(entry,0)] =
 * [−£60.00, +£120.00] — a gross credit's net value is between zero and the credit itself, and this
 * one has an entry that is NEGATIVE. So the true revenue lies in [£100 − £120, £100 + £60] =
 * [−£20.00, £160.00], and can sit £60.00 ABOVE the ceiling the page printed. The relation is not
 * `≤`; there is no relation, and the report has to say so.
 */

/** The classification every consumer performed before this fix, reproduced exactly. */
function theOldRule(row: { basisComplete: boolean; gross: number; unknown: number }) {
  return linear.netLinearFigureBound({
    basisComplete: row.basisComplete,
    unplacedCredit: row.gross + row.unknown,
  })
}

test('two gross credits that partly cancel: the OLD rule says ≤, and the published verdict says nothing (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: -1, totalBase: -60 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  // The published figures are unchanged — this finding is about the RELATION, not the number.
  assert.equal(r.currentFyRevenue, 100)
  assert.equal(r.currentFyProfit, 60)
  // The trap, on the two columns a consumer had to work from.
  assert.equal(r.currentFyRefundsGrossBasis, 60, '120 + (-60): the signed sum is POSITIVE')
  assert.equal(r.currentFyRefundsUnknownBasis, 0)
  assert.equal(r.currentFyRefundBasisComplete, false)
  assert.equal(
    theOldRule({ basisComplete: r.currentFyRefundBasisComplete, gross: r.currentFyRefundsGrossBasis, unknown: r.currentFyRefundsUnknownBasis }),
    'upper',
    'the rule this fix removes really does answer `upper` on this order — otherwise the test below proves nothing',
  )
  assert.equal(r.currentFyRevenueBound, 'indeterminate', 'the true revenue can be £160 — £60 ABOVE the published £100')
})

test('two gross credits that cancel EXACTLY leave a zero bucket and still claim nothing (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: -1, totalBase: -120 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRefundsGrossBasis, 0, 'the two entries are gone; the column cannot tell this from "no credit"')
  assert.equal(r.currentFyRefundBasisComplete, false, 'but the flag remembers that something was unplaceable')
  assert.equal(theOldRule({ basisComplete: false, gross: 0, unknown: 0 }), 'upper', 'zero is not negative')
  assert.equal(r.currentFyRevenueBound, 'indeterminate')
})

test('an ORDINARY single gross credit is still a sound upper bound — the fix is not blanket (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFyRevenueBound, 'upper', 'no entry was negative, so £100 IS a ceiling')
  assert.equal(r.previousFyRevenueBound, 'exact', 'and the FY with no credit at all is unmarked')
})

test('a clean FY publishes `exact`, and so does a product with no sales (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(bySku.get('SKU-1')!.currentFyRevenue, 75, 'a NET credit is subtracted as it always was')
  assert.equal(bySku.get('SKU-1')!.currentFyRevenueBound, 'exact')
  assert.equal(bySku.get('SKU-2')!.currentFyRevenueBound, 'exact', 'nothing sold, nothing unplaced')
  assert.equal(summary.currentFyRevenueBound, 'exact')
})

test('SUB-PENNY cancellation: the ROUNDED column loses the negative entry, the verdict does not (o3d-la3n)', async () => {
  // The interval is classified from the UNROUNDED aggregate. Round the two endpoints first and
  // +£0.001 against −£0.004 becomes a total of £0.00 against a positive part of £0.00 — a lower
  // endpoint of zero, and a `≤` produced entirely by two decimal places.
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 0 }],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 0, totalBase: 0.001 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 0, totalBase: -0.004 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.ok(!(r.currentFyRefundsGrossBasis < 0), 'the published column rounds to zero, which is not negative — the trap')
  assert.equal(theOldRule({ basisComplete: false, gross: Math.abs(r.currentFyRefundsGrossBasis), unknown: 0 }), 'upper')
  assert.equal(r.currentFyRevenueBound, 'indeterminate', 'classified before the rounding, so the −£0.004 entry still counts')
})

test('ONE indeterminate row makes the whole-table total indeterminate, not merely bounded (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 },
      { productId: 'p2', qty: 1, totalBase: 60, cogsBase: 0 },
    ],
    refunds: [
      // p1 cancels to a positive bucket; p2 carries an ordinary gross credit.
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: -1, totalBase: -60 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p2', qty: 0, totalBase: 12 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(bySku.get('SKU-1')!.currentFyRevenueBound, 'indeterminate')
  assert.equal(bySku.get('SKU-2')!.currentFyRevenueBound, 'upper', 'a sound row beside it stays sound')
  assert.equal(summary.currentFyRevenueBound, 'indeterminate')
  assert.equal(summary.previousFyRevenueBound, 'exact', 'and the untouched FY is not dragged with it')
})

test('the combined verdict IS the verdict over the summed interval — the lemma the client relies on (o3d-la3n)', async () => {
  // combineNetLinearFigureBounds folds ROW VERDICTS because the browser re-sums an arbitrary
  // filtered subset and never sees the parts. This checks that fold against the arithmetic it
  // stands in for: `unplacedCreditBoundFromParts` over the SUMMED parts, which is what the producer
  // would compute if it could know the subset.
  const { unplacedCreditBoundFromParts } = await import('@/lib/domain/sales/refund-basis-analytics')
  type Part = { total: number; positive: number; complete: boolean }
  const universe: Part[] = [
    { total: 0, positive: 0, complete: true },      // clean
    { total: 120, positive: 120, complete: false }, // ordinary gross credit  -> upper
    { total: 60, positive: 120, complete: false },  // +120 and -60           -> indeterminate
    { total: 0, positive: 120, complete: false },   // +120 and -120          -> indeterminate
    { total: -30, positive: 0, complete: false },   // a lone negative credit -> indeterminate
    { total: 5, positive: 5, complete: false },     // small ordinary credit  -> upper
  ]
  const verdict = (p: Part) => linear.netLinearFigureBound({
    basisComplete: p.complete,
    unplacedCredit: unplacedCreditBoundFromParts([{ total: p.total, positive: p.positive }]),
  })
  let checked = 0
  for (let mask = 0; mask < 1 << universe.length; mask++) {
    const subset = universe.filter((_, i) => mask & (1 << i))
    const combined = linear.combineNetLinearFigureBounds(subset.map(verdict))
    const direct = linear.netLinearFigureBound({
      basisComplete: subset.every((p) => p.complete),
      unplacedCredit: unplacedCreditBoundFromParts(subset.map((p) => ({ total: p.total, positive: p.positive }))),
    })
    assert.equal(combined, direct, `subset ${mask}: folding the verdicts must equal classifying the summed interval`)
    checked++
  }
  assert.equal(checked, 64, 'every subset of the six was actually visited')
  // And the fold is not trivially constant: these three answers all occur in the universe above.
  assert.deepEqual(
    [...new Set(universe.map(verdict))].sort(),
    ['exact', 'indeterminate', 'upper'],
  )
})
