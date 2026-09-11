import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Import-free and pure by contract, so it is safe above the module mocks below.
import * as linear from '@/lib/domain/sales/derived-figure-bound'
import type { ProfitabilityFyFigures } from '@/app/actions/product-profitability'

/** The verdict a consumer would render for a published FY block. */
const verdictOf = (fy: ProfitabilityFyFigures) => linear.classifyLinearFigureBound(fy.bound)

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

  assert.equal(r.currentFy.revenue, 100, 'the VAT-inclusive credit is not the same unit as this figure')
  assert.equal(r.currentFy.refundsGrossBasis, 120, 'it is reported beside the revenue, not discarded')
  assert.equal(r.currentFy.refundsUnknownBasis, 0)
  assert.equal(verdictOf(r.currentFy), 'upper', 'revenue is an upper bound and says so')
  assert.equal(r.currentFy.profit, 60, 'old arithmetic gave -60 here (-20 revenue less £40 COGS)')
  // Quantity is basis-independent — the unit came back whatever the credit was stamped with.
  assert.equal(r.currentFy.qtySold, 0)
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

  assert.equal(r.currentFy.revenue, 100, 'modern NET credit, subtracted as before')
  assert.equal(verdictOf(r.currentFy), 'exact')
  assert.equal(r.previousFy.revenue, 200, 'old arithmetic gave 80, understating the prior FY by the VAT')
  assert.equal(r.previousFy.refundsGrossBasis, 120)
  assert.equal(verdictOf(r.previousFy), 'upper')
  assert.equal(r.previousFy.profit, 120, 'old arithmetic gave 0')
})

test('a SUB-PENNY unstamped credit still makes the row an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0.004 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(verdictOf(r.currentFy), 'upper', 'dust is still value')
  assert.equal(r.currentFy.refundsUnknownBasis, 0.004, 'and the amount is published UNROUNDED, so the dust survives the wire too')
  assert.deepEqual({ ...r.currentFy.bound }, { lower: -0.004, upper: 0 }, 'the interval is the dust, exactly')
  assert.equal(r.currentFy.revenue, 50)
})

test('an EXACTLY-zero unstamped credit leaves the row exact (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 50, cogsBase: 0 }],
    refunds: [{ totalsBasis: null, lines: [{ productId: 'p1', qty: 0, totalBase: 0 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  // Zero is identical on both bases, so it carries no basis information — and contributes nothing
  // to either endpoint, which is why the completeness boolean was redundant with the interval.
  assert.equal(verdictOf(r.currentFy), 'exact')
  assert.deepEqual({ ...r.currentFy.bound }, { lower: 0, upper: 0 })
  assert.equal(r.currentFy.revenue, 50)
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

  assert.equal(verdictOf(bySku.get('SKU-2')!.currentFy), 'exact', 'a clean row stays clean')
  assert.equal(bySku.get('SKU-2')!.currentFy.revenue, 50)
  assert.equal(verdictOf(summary.currentFy), 'upper', 'one dirty row bounds the total')
  assert.equal(summary.currentFy.refundsGrossBasis, 120)
  assert.equal(summary.currentFy.refundsUnknownBasis, 0)
  // 100 + 50. The old total was (100 - 120) + 50 = 30.
  assert.equal(summary.currentFy.revenue, 150)
})

test('a product with no sales at all is not reported as an upper bound (o3d-iigc)', async () => {
  CURRENT_FY_ORDERS = []
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-2')!

  // There is nothing it failed to subtract, so nothing to warn about.
  assert.equal(verdictOf(r.currentFy), 'exact')
  assert.equal(verdictOf(r.previousFy), 'exact')
  assert.equal(r.currentFy.revenue, 0)
})

// ---------------------------------------------------------------------------
// o3d-la3n: A RELATION MAY NOT COME OFF A SIGNED CREDIT SUM, OFF A BOOLEAN, OR
// OFF ROUNDED ROWS
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

/**
 * THE CLASSIFICATION EVERY CONSUMER PERFORMED BEFORE THIS FIX.
 *
 * Its two inputs — a completeness BOOLEAN and the SIGNED bucket sum — are restated here from the
 * FIXTURE rather than read off the published row, because as of round 2 the boolean is not on the
 * wire at all. That is the point of the change and not an inconvenience of the test: while both
 * inputs were published the broken rule remained reconstructible by any future reader, and its
 * absence was a convention rather than a property of the type.
 */
function theOldRule(row: { basisComplete: boolean; gross: number; unknown: number }) {
  return linear.netLinearFigureBound({
    basisComplete: row.basisComplete,
    // @ts-expect-error o3d-la3n r3: THIS LINE IS THE ASSERTION. A signed bucket sum is a `number`,
    // and `unplacedCredit` is a `CollapsedUnplacedCredit` that only `unplacedCreditBoundFromParts`
    // can mint — so the broken rule no longer typechecks for anyone, which is what "removed" has to
    // mean when both of its ingredients are still on the wire for their own good reasons. The
    // directive is load-bearing in both directions: widen the parameter back to `number` and tsc
    // fails this file with "unused '@ts-expect-error' directive". The call still RUNS, because the
    // tests below need the answer the old rule gave in order not to be vacuous.
    unplacedCredit: row.gross + row.unknown,
  })
}

test('two gross credits that partly cancel: the OLD rule says ≤, and the published interval claims nothing (o3d-la3n)', async () => {
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
  assert.equal(r.currentFy.revenue, 100)
  assert.equal(r.currentFy.profit, 60)
  // The trap, on the column a consumer had to work from.
  assert.equal(r.currentFy.refundsGrossBasis, 60, '120 + (-60): the signed sum is POSITIVE')
  assert.equal(r.currentFy.refundsUnknownBasis, 0)
  assert.equal(
    theOldRule({ basisComplete: false, gross: 60, unknown: 0 }),
    'upper',
    'the rule this fix removes really does answer `upper` on this order — otherwise the test below proves nothing',
  )
  // The interval, which is what is published, holds the entries the sum destroyed.
  assert.deepEqual({ ...r.currentFy.bound }, { lower: -120, upper: 60 })
  assert.equal(verdictOf(r.currentFy), 'indeterminate', 'the true revenue can be £160 — £60 ABOVE the published £100')
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

  assert.equal(r.currentFy.refundsGrossBasis, 0, 'the two entries are gone; the column cannot tell this from "no credit"')
  assert.equal(theOldRule({ basisComplete: false, gross: 0, unknown: 0 }), 'upper', 'zero is not negative')
  assert.deepEqual({ ...r.currentFy.bound }, { lower: -120, upper: 120 }, 'the interval still holds both entries')
  assert.equal(verdictOf(r.currentFy), 'indeterminate')
})

test('an ORDINARY single gross credit is still a sound upper bound — the fix is not blanket (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 1, totalBase: 120 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.deepEqual({ ...r.currentFy.bound }, { lower: -120, upper: 0 })
  assert.equal(verdictOf(r.currentFy), 'upper', 'no entry was negative, so £100 IS a ceiling')
  assert.equal(verdictOf(r.previousFy), 'exact', 'and the FY with no credit at all is unmarked')
})

/**
 * CODEX ROUND 1, HIGH 2: A NEGATIVE-ONLY UNPLACED CREDIT IS A PROVABLE LOWER BOUND.
 *
 * A lone −£30 gross-basis entry — a reversal with no refund beside it — occupies the credit interval
 * [−30, 0], so the true revenue lies in [published, published + 30]. Round 1 had three verdicts and
 * called that `indeterminate`, which told the reader the truth might be BELOW the published figure
 * when it provably cannot be. It is `lower`, and the page marks it `≥`.
 */
test('a NEGATIVE-only unplaced credit publishes a LOWER bound, not "direction unknown" (o3d-la3n r2)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: -1, totalBase: -30 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku } = await rowsBySku()
  const r = bySku.get('SKU-1')!

  assert.equal(r.currentFy.revenue, 100)
  assert.deepEqual({ ...r.currentFy.bound }, { lower: 0, upper: 30 }, 'the truth is between £100 and £130')
  assert.equal(verdictOf(r.currentFy), 'lower')
  assert.equal(linear.boundSuffix(verdictOf(r.currentFy)), ' ≥')
  assert.equal(linear.linearFigureBoundWidth(r.currentFy.bound), 30, 'and the width is known in that direction')
  // Round 1's collapsed-scalar classifier, on the same row, cannot get there: the collapse keeps the
  // sign and throws the other endpoint away.
  assert.equal(theOldRule({ basisComplete: false, gross: -30, unknown: 0 }), 'indeterminate')
})

test('an UPPER row and a LOWER row in one total fold to indeterminate — individually determinate, jointly not (o3d-la3n r2)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 100, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 60, cogsBase: 0 },
    ],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 0, totalBase: 12 }] },   // upper
      { totalsBasis: 'GROSS', lines: [{ productId: 'p2', qty: 0, totalBase: -30 }] },  // lower
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(verdictOf(bySku.get('SKU-1')!.currentFy), 'upper')
  assert.equal(verdictOf(bySku.get('SKU-2')!.currentFy), 'lower')
  assert.deepEqual({ ...summary.currentFy.bound }, { lower: -12, upper: 30 })
  assert.equal(verdictOf(summary.currentFy), 'indeterminate', 'the total can be £12 below or £30 above')
  assert.equal(linear.linearFigureBoundWidth(summary.currentFy.bound), null, 'and no single width describes it')
})

test('a LOWER row beside an EXACT row is still a lower bound, and keeps its width (o3d-la3n r2)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 100, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 60, cogsBase: 0 },
    ],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p2', qty: 0, totalBase: -30 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(verdictOf(bySku.get('SKU-1')!.currentFy), 'exact')
  assert.equal(verdictOf(bySku.get('SKU-2')!.currentFy), 'lower')
  assert.deepEqual({ ...summary.currentFy.bound }, { lower: 0, upper: 30 })
  assert.equal(verdictOf(summary.currentFy), 'lower')
  assert.equal(summary.currentFy.revenue, 160)
})

test('a clean FY publishes `exact`, and so does a product with no sales (o3d-la3n)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [{ productId: 'p1', qty: 1, totalBase: 100, cogsBase: 40 }],
    refunds: [{ totalsBasis: 'NET', lines: [{ productId: 'p1', qty: 1, totalBase: 25 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  assert.equal(bySku.get('SKU-1')!.currentFy.revenue, 75, 'a NET credit is subtracted as it always was')
  assert.equal(verdictOf(bySku.get('SKU-1')!.currentFy), 'exact')
  assert.equal(verdictOf(bySku.get('SKU-2')!.currentFy), 'exact', 'nothing sold, nothing unplaced')
  assert.equal(verdictOf(summary.currentFy), 'exact')
  assert.deepEqual({ ...summary.currentFy.bound }, { lower: 0, upper: 0 }, 'the EMPTY-and-clean fold is the identity, not a wide interval')
})

test('SUB-PENNY cancellation: the ROUNDED column loses the negative entry, the interval does not (o3d-la3n)', async () => {
  // Round the two endpoints first and +£0.001 against −£0.004 becomes a total of £0.00 against a
  // positive part of £0.00 — a lower endpoint of zero, and a `≤` produced entirely by two decimals.
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

  const roundedColumn = Math.round(r.currentFy.refundsGrossBasis * 100) / 100
  assert.ok(roundedColumn === 0, `a consumer rounding the column to cents sees zero, which is not negative — the trap (got ${roundedColumn})`)
  assert.equal(theOldRule({ basisComplete: false, gross: roundedColumn, unknown: 0 }), 'upper')
  assert.equal(r.currentFy.bound.lower, -0.001)
  assert.ok(r.currentFy.bound.upper > 0, 'and the −£0.004 entry is still an upper endpoint of £0.004')
  assert.equal(verdictOf(r.currentFy), 'indeterminate', 'classified before any rounding, so the entry still counts')
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

  assert.equal(verdictOf(bySku.get('SKU-1')!.currentFy), 'indeterminate')
  assert.equal(verdictOf(bySku.get('SKU-2')!.currentFy), 'upper', 'a sound row beside it stays sound')
  assert.equal(verdictOf(summary.currentFy), 'indeterminate')
  assert.equal(verdictOf(summary.previousFy), 'exact', 'and the untouched FY is not dragged with it')
})

// ---------------------------------------------------------------------------
// Codex round 1, HIGH 1: SUMMING ROUNDED ROWS CAN BREACH THE PUBLISHED RELATION
// ---------------------------------------------------------------------------

/**
 * CODEX'S COUNTEREXAMPLE, EXACTLY. Two products, raw FY revenue £0.014 each, each carrying £0.001 of
 * POSITIVE unplaced gross-basis credit — so every row is a sound `≤` and the total is too.
 *
 * Round 1 published `currentFyRevenue` ROUNDED to cents. Each row therefore left the server as
 * £0.01, the page summed them to £0.02, and printed "at most £0.02". The completed-basis aggregate
 * lies in [£0.026, £0.028]: the published ceiling sat BELOW the true minimum. The bound markers were
 * classified from unrounded entries and were individually right, which is precisely why this could
 * not be separated from bound correctness — the marker was true of a number the page had thrown away.
 */
test('sub-cent rows: the round-1 subtotal of ROUNDED rows breaches its own ≤; the unrounded one does not (o3d-la3n r2, o3d-l4zz)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 0.014, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 0.014, cogsBase: 0 },
    ],
    refunds: [
      { totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 0, totalBase: 0.001 }] },
      { totalsBasis: 'GROSS', lines: [{ productId: 'p2', qty: 0, totalBase: 0.001 }] },
    ],
  })]
  PREVIOUS_FY_ORDERS = []
  const { bySku, summary } = await rowsBySku()

  // Every row is an honest ceiling on its own.
  for (const sku of ['SKU-1', 'SKU-2']) {
    assert.equal(bySku.get(sku)!.currentFy.revenue, 0.014, 'the row travels UNROUNDED — this is the fix')
    assert.equal(verdictOf(bySku.get(sku)!.currentFy), 'upper')
  }

  // The interval the aggregate's truth occupies.
  const total = summary.currentFy
  assert.equal(verdictOf(total), 'upper')
  const trueLowest = total.revenue + total.bound.lower
  const trueHighest = total.revenue + total.bound.upper
  assert.ok(Math.abs(trueLowest - 0.026) < 1e-12, `true minimum is £0.026, got ${trueLowest}`)
  assert.ok(Math.abs(trueHighest - 0.028) < 1e-12, `true maximum is £0.028, got ${trueHighest}`)

  // ROUND 1's SUBTOTAL, reproduced: the rows as they were published then, added up.
  const roundOneSubtotal = [...bySku.values()].reduce((s, r) => s + Math.round(r.currentFy.revenue * 100) / 100, 0)
  assert.equal(roundOneSubtotal, 0.02, 'two rows of £0.01 — the number the page printed')
  assert.ok(
    roundOneSubtotal < trueLowest,
    'and it is BELOW the true minimum, so "revenue at most £0.02" was a false claim',
  )

  // What ships now: sum the unrounded rows, round ONCE, in the direction the relation allows.
  const published = linear.roundBoundedAmountForDisplay(total.revenue, verdictOf(total))
  assert.equal(published, 0.03)
  assert.ok(published >= trueHighest, 'the published ≤ holds against every point of the interval')
})

/**
 * SUMMING EXACTLY IS ONLY HALF OF IT. Two products at raw £0.012 each sum to £0.024 — and £0.024 to
 * the NEAREST cent is £0.02, which is below the truth again, by less than a penny but no less
 * falsely. A figure that carries a relation is rounded in the direction of that relation.
 */
test('an exact subtotal rounded to the NEAREST cent breaches the ≤; rounded in the relation’s direction it holds (o3d-la3n r2)', async () => {
  CURRENT_FY_ORDERS = [order({
    lines: [
      { productId: 'p1', qty: 1, totalBase: 0.012, cogsBase: 0 },
      { productId: 'p2', qty: 1, totalBase: 0.012, cogsBase: 0 },
    ],
    refunds: [{ totalsBasis: 'GROSS', lines: [{ productId: 'p1', qty: 0, totalBase: 0.001 }] }],
  })]
  PREVIOUS_FY_ORDERS = []
  const { summary } = await rowsBySku()
  const total = summary.currentFy

  assert.equal(verdictOf(total), 'upper')
  const trueHighest = total.revenue + total.bound.upper
  assert.ok(Math.abs(trueHighest - 0.024) < 1e-12)

  const nearest = Math.round(total.revenue * 100) / 100
  assert.equal(nearest, 0.02)
  assert.ok(nearest < trueHighest, 'nearest-cent rounding is not relation-preserving')

  const published = linear.roundBoundedAmountForDisplay(total.revenue, 'upper')
  assert.equal(published, 0.03)
  assert.ok(published >= trueHighest)
})

// ---------------------------------------------------------------------------
// The lemma the browser's filtered subtotal rests on
// ---------------------------------------------------------------------------

test('folding a subset’s INTERVALS gives what the producer would have published for that subset (o3d-la3n r2)', async () => {
  // The browser re-sums an arbitrary filtered subset and never sees the entries, so it adds the
  // published intervals. This checks that against the arithmetic it stands in for: minting ONE
  // interval from all of the subset's entries at once, which is what the producer would do.
  type Part = { total: number; positive: number }
  const universe: Part[] = [
    { total: 0, positive: 0 },      // clean                     -> exact
    { total: 120, positive: 120 },  // ordinary gross credit     -> upper
    { total: 60, positive: 120 },   // +120 and -60              -> indeterminate
    { total: 0, positive: 120 },    // +120 and -120             -> indeterminate
    { total: -30, positive: 0 },    // a lone negative credit    -> lower
    { total: 5, positive: 5 },      // small ordinary credit     -> upper
  ]
  const mint = (p: Part) => linear.linearFigureBoundFromUnplacedCredit([p])
  let checked = 0
  for (let mask = 0; mask < 1 << universe.length; mask++) {
    const subset = universe.filter((_, i) => mask & (1 << i))
    const folded = linear.sumLinearFigureBounds(subset.map(mint))
    const direct = linear.linearFigureBoundFromUnplacedCredit(subset)
    assert.deepEqual({ ...folded }, { ...direct }, `subset ${mask}: folding the intervals must equal minting one from all the entries`)
    assert.equal(linear.classifyLinearFigureBound(folded), linear.classifyLinearFigureBound(direct))
    checked++
  }
  assert.equal(checked, 64, 'every subset of the six was actually visited')
  // And the fold is not trivially constant: all four verdicts occur over this universe.
  assert.deepEqual(
    [...new Set(universe.map((p) => linear.classifyLinearFigureBound(mint(p))))].sort(),
    ['exact', 'indeterminate', 'lower', 'upper'],
  )
})

/**
 * WHAT A VERDICT-ONLY FOLD COULD NOT HAVE DONE, EVEN WITH FOUR VERDICTS.
 *
 * Two filtered subsets whose rows carry IDENTICAL verdicts and whose subtotals are equally sound
 * ceilings, but by different amounts. The page states how far a marked total could move; from two
 * `upper` marks alone there is nothing to state.
 */
test('two subsets with the same verdicts have different widths, which only the endpoints carry (o3d-la3n r2)', () => {
  const mint = (total: number) => linear.linearFigureBoundFromUnplacedCredit([{ total, positive: total }])
  const narrow = linear.sumLinearFigureBounds([mint(2), mint(3)])
  const wide = linear.sumLinearFigureBounds([mint(2), mint(300)])

  assert.equal(linear.classifyLinearFigureBound(narrow), 'upper')
  assert.equal(linear.classifyLinearFigureBound(wide), 'upper')
  assert.equal(linear.linearFigureBoundWidth(narrow), 5)
  assert.equal(linear.linearFigureBoundWidth(wide), 302)
})
