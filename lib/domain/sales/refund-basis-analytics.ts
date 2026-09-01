import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * o3d-lvk (analytics half): read the STAMPED refund basis in the sales-stats reports.
 *
 * THE PROBLEM THESE REPORTS HAD. `SalesOrderRefund.totalBase` is not on one basis. Refunds written
 * since the net contract are NET (ex-VAT) and carry `totalsBasis = 'NET'`; legacy rows are GROSS;
 * and after o3d-lvk's backfill a row that could not be PROVED either way is deliberately left NULL.
 * The reports subtracted all three from each other and from order totals as if they were the same
 * unit — so a fully-refunded taxable order read as roughly 83% refunded, and a customer's net
 * balance was wrong by the VAT on every legacy credit.
 *
 * WHAT THIS MODULE DOES, AND WHAT IT REFUSES TO DO. It answers "on what basis is this refund
 * total?" and "which order total is that comparable with?", and nothing else. In particular it does
 * NOT convert between the two bases. Converting a GROSS refund to NET needs the rate that produced
 * it, and on a mixed-rate order that rate is not recoverable from stored data — the same conclusion
 * o3d-w00 reached when it made the refund CREATE path fail closed. So a figure that cannot be
 * computed is returned as `null`, with the basis that made it uncomputable stated alongside, and a
 * caller renders it as unknown rather than as a number that looks authoritative.
 *
 * Pure and Decimal throughout: rounding happens once, in the caller-facing figure, never on the
 * intermediate sums.
 */

/** What a single refund's stored totals mean. Anything not positively stamped is UNKNOWN. */
export type RefundTotalsBasis = 'NET' | 'GROSS' | 'UNKNOWN'

/**
 * The basis of a WHOLE SET of refunds (an order's, typically).
 *
 * `NONE` is a distinct answer from `UNKNOWN` and the distinction carries the report: an order with
 * no refunds has nothing to be uncertain about, so its net-of-refunds figure is simply its total.
 * The overwhelming majority of orders are NONE, so nothing degrades for them.
 */
export type RefundSetBasis = 'NONE' | RefundTotalsBasis

export type RefundBasisRow = {
  totalsBasis: string | null
  totalBase: DecimalInput
}

export function refundTotalsBasis(totalsBasis: string | null | undefined): RefundTotalsBasis {
  if (totalsBasis === 'NET') return 'NET'
  if (totalsBasis === 'GROSS') return 'GROSS'
  // Includes NULL (never stamped, or stamped-as-unprovable by the backfill) and any value a future
  // writer might introduce. Treating an unrecognised marker as UNKNOWN is the only safe reading:
  // guessing it is NET is exactly the mislabelling the backfill went to such lengths to avoid.
  return 'UNKNOWN'
}

/**
 * The unanimous basis of a set of refunds, or UNKNOWN when they do not agree.
 *
 * EXACTLY-ZERO totals are skipped. Zero is the one amount that is identical on both bases, so a
 * zero-total row carries no basis information and must not veto an otherwise unanimous set. The
 * test is `isZero()`, not a tolerance: the same "dust is still value" rule classifyRefundBasis
 * applies — an epsilon here would let sub-penny unstamped rows accumulate into a material amount
 * while the set still reported a clean basis.
 */
export function refundSetBasis(refunds: RefundBasisRow[]): RefundSetBasis {
  let seen: RefundTotalsBasis | null = null
  for (const refund of refunds) {
    if (toDecimal(refund.totalBase).isZero()) continue
    const basis = refundTotalsBasis(refund.totalsBasis)
    if (basis === 'UNKNOWN') return 'UNKNOWN'
    if (seen === null) seen = basis
    else if (seen !== basis) return 'UNKNOWN' // a mixed NET+GROSS sum is not a quantity at all
  }
  return seen ?? 'NONE'
}

export type OrderTotals = {
  /** The order's GROSS (VAT-inclusive) total — SalesOrder.totalBase. */
  totalBase: DecimalInput
  /** The VAT within that total — SalesOrder.taxBase. */
  taxBase: DecimalInput
}

/**
 * The order total a refund on `basis` may legitimately be compared with.
 *
 * NET is `totalBase - taxBase`, which is what refund-status-reconciliation already compares
 * against. A negative result (a credit-heavy or mis-totalled order) is clamped to zero there; it is
 * NOT clamped here, because these are reporting figures and silently flooring a negative total
 * would hide the anomaly rather than show it.
 */
export function orderTotalOnBasis(order: OrderTotals, basis: 'NET' | 'GROSS') {
  const gross = toDecimal(order.totalBase)
  return basis === 'GROSS' ? gross : gross.sub(toDecimal(order.taxBase))
}

export type NetOfRefunds = {
  basis: RefundSetBasis
  /** The summed refund total, on `basis`. Always computable — it is one number's worth of facts. */
  refundsTotal: number
  /**
   * The order total less its refunds, or `null` when the two are not on the same basis and no
   * conversion between them is derivable. When non-null it is expressed on `basis` (so a NET set
   * yields a NET-of-VAT figure, and a GROSS set yields a VAT-inclusive one).
   */
  netTotal: number | null
}

/**
 * An order's value net of its refunds — the customer-aging `netTotal`.
 *
 * Rounded exactly once, at the end. `refundsTotal` is reported even when `netTotal` cannot be, so a
 * reader still sees how much credit exists; what they are not given is a subtraction that mixes
 * units.
 */
export function netOfRefunds(order: OrderTotals, refunds: RefundBasisRow[]): NetOfRefunds {
  const basis = refundSetBasis(refunds)
  const refundsTotal = refunds.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))
  const refundsTotalRounded = round2(refundsTotal)

  if (basis === 'NONE') {
    return { basis, refundsTotal: refundsTotalRounded, netTotal: round2(toDecimal(order.totalBase)) }
  }
  if (basis === 'UNKNOWN') {
    return { basis, refundsTotal: refundsTotalRounded, netTotal: null }
  }
  return {
    basis,
    refundsTotal: refundsTotalRounded,
    netTotal: round2(orderTotalOnBasis(order, basis).sub(refundsTotal)),
  }
}

/**
 * What proportion of the sale a refund line represents — the refunds report's `% of Sale`.
 *
 * Measured against the order total ON THE REFUND'S OWN BASIS, which is the whole point: a full NET
 * refund of a taxable order divided by the GROSS order total reads as ~83%, and looks like a
 * partial refund of something that was in fact refunded in full.
 *
 * `null` when the refund's basis is unproven, or when the comparable order total is not positive
 * (no meaningful proportion exists).
 */
export function refundPctOfSale(
  lineTotalBase: DecimalInput,
  order: OrderTotals,
  totalsBasis: string | null,
): number | null {
  const basis = refundTotalsBasis(totalsBasis)
  if (basis === 'UNKNOWN') return null
  const orderTotal = orderTotalOnBasis(order, basis)
  if (orderTotal.lte(0)) return null
  return Math.round(toDecimal(lineTotalBase).div(orderTotal).mul(1000).toNumber()) / 10
}

/**
 * Where a refund LINE's amount belongs in the product sales report, whose revenue is built from
 * ex-VAT line totals and is therefore a NET figure.
 *
 * Only a NET-basis refund is the same unit as that revenue. A GROSS one over-subtracts by its VAT;
 * an unproven one cannot be placed at all. Both are bucketed separately and left OUT of net
 * revenue, which makes that figure an UPPER BOUND — stated, rather than quietly wrong in an
 * unknown direction.
 *
 * `placeableOnNetBasis` is what the row's completeness flag is built from. An EXACTLY-zero amount
 * is placeable whatever its basis: zero is the same on both, so it cannot bias anything.
 */
export function refundLineBucket(
  totalsBasis: string | null,
  amountBase: DecimalInput,
): { bucket: 'net' | 'gross' | 'unknown'; placeableOnNetBasis: boolean } {
  const placement = creditPlacement('NET', totalsBasis, amountBase)
  return { bucket: placement.bucket, placeableOnNetBasis: placement.placeable }
}

/**
 * o3d-kyey: the same question `refundLineBucket` asks, but for a figure whose own basis is GROSS.
 *
 * Sales Analytics and Customer Mix build revenue from `SalesOrder.totalBase`, which is
 * VAT-INCLUSIVE. For those figures it is the GROSS-basis credit that is the comparable one and the
 * NET-basis credit that cannot be placed — the exact mirror of the product sales report, and the
 * reason this had to stop being hard-coded to NET. Nothing is converted in either direction, for the
 * reason stated at the top of this module.
 *
 * `comparable` is what the caller SUBTRACTS. `placeable` is what its completeness flag is built
 * from, and differs only for an EXACTLY-zero amount: zero is the same number on both bases, so it
 * can never bias a figure and must not degrade one. `isZero()` and not a tolerance — dust is still
 * value, and a tolerance here would let sub-penny unstamped credit accumulate behind a clean flag.
 */
export function creditPlacement(
  figureBasis: 'NET' | 'GROSS',
  totalsBasis: string | null,
  amountBase: DecimalInput,
): { bucket: 'net' | 'gross' | 'unknown'; comparable: boolean; placeable: boolean } {
  const basis = refundTotalsBasis(totalsBasis)
  const bucket = basis === 'NET' ? 'net' : basis === 'GROSS' ? 'gross' : 'unknown'
  const comparable = basis === figureBasis
  return { bucket, comparable, placeable: comparable || toDecimal(amountBase).isZero() }
}

/**
 * THE UNPLACED CREDIT A FIGURE COULD NOT ABSORB, AS AN INTERVAL — for the producers that are floats.
 *
 * `netLinearFigureBound` and `marginFigureBound` read their `unplacedCredit` for its SIGN: a
 * negative one means the true figure may be ABOVE the published one, so no `≤` may be claimed.
 * Passing them `refundsGrossBasis + refundsUnknownBasis` — a SIGNED SUM — destroys exactly that
 * information. A +120 and a −120 of gross-basis credit add to a bucket of zero, zero is not
 * negative, and the classifiers answer `upper` about a figure that can move 120 in either
 * direction. This is `unplacedCreditBound(unplacedCreditInterval(...))` in
 * sales-fulfillment-analytics, over `number` instead of `Decimal`, and the argument is the same
 * one: the interval has to be formed from `Σ max(b, 0)` recorded AT THE ENTRY, because by the time
 * a bucket is a total there is no entry left to record.
 *
 * `total` is the bucket's signed sum, `positive` is `Σ max(entry, 0)` over the entries that fed it,
 * and `Σ min(entry, 0)` is the difference. Pass every bucket the figure could NOT place.
 *
 * A NON-NEGATIVE result therefore means more than "the credit summed positive": it means no
 * unplaced entry was negative at all, which is why a caller may still describe the result as the
 * width of the bound when the classification comes back `upper`.
 */
export function unplacedCreditBoundFromParts(parts: ReadonlyArray<{ total: number; positive: number }>): number {
  let lower = 0
  let upper = 0
  for (const part of parts) {
    lower += part.total - part.positive
    upper += part.positive
  }
  return lower < 0 ? lower : upper
}

function round2(value: ReturnType<typeof toDecimal>): number {
  return Math.round(value.mul(100).toNumber()) / 100
}

// ---------------------------------------------------------------------------
// o3d-iigc round 4: WHICH DIRECTION a bounded figure is bounded IN.
// ---------------------------------------------------------------------------

/**
 * What relation a published figure bears to the figure the report WOULD have published if every
 * refund's basis were known.
 *
 * - `exact`        — nothing was left unsubtracted, or the unsubtracted credit provably cannot move
 *                    this figure. Publish it unmarked.
 * - `upper`        — the published figure is greater than or equal to the true one. Mark it `≤`.
 * - `indeterminate`— the true figure may be either side of the published one. Publishing `≤` here
 *                    would be a FALSE CLAIM, which is worse than publishing no claim at all.
 */
export { boundSuffix, netLinearFigureBound, type DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'
import type { DerivedFigureBound } from '@/lib/domain/sales/derived-figure-bound'


/**
 * MARGIN IS A RATIO, AND A RATIO IS NOT COVERED BY THE ARGUMENT ABOVE.
 *
 * Codex round 3 marked Avg Margin `≤` on the grounds that it "moves with revenue". It does — but an
 * unsubtracted credit moves the NUMERATOR AND THE DENOMINATOR TOGETHER, and which way the quotient
 * then moves depends on their relative sizes. Working it through, with `c` = COGS (basis-independent
 * — no refund line ever reduces it — and therefore fixed), `t` = net revenue, and the report's OWN
 * margin function:
 *
 *     m(t) = t > 0 ? ((t - c) / t) * 100 : 0            // the `netRevenue > 0` guard is part of it
 *          = 100 * (1 - c/t)     for t > 0
 *
 * The published figure is `m(netRevenue)`; the true one is `m(t*)` for an unknown
 * `t* ∈ [netRevenue - unplacedCredit, netRevenue]`. `m'(t) = c/t²`, so:
 *
 *   1. `c < 0` — m is DECREASING. A smaller true revenue gives a LARGER margin: the published figure
 *      is a lower bound, not an upper one. The exact opposite of the mark round 3 applied.
 *   2. `c >= 0`, `netRevenue <= 0` — the guard returns 0 across the whole interval, so published and
 *      true are both 0. EXACT, and marking it would overstate our uncertainty.
 *   3. `c >= 0`, `netRevenue - unplacedCredit > 0` — the interval sits entirely in `(0, ∞)` where m
 *      is non-decreasing, so the published figure is the maximum. A genuine UPPER bound.
 *   4. `c >= 0`, `netRevenue > 0 >= netRevenue - unplacedCredit` — the interval STRADDLES ZERO, so
 *      the guard's 0 is one of the values the true figure could take. That is above the published
 *      figure exactly when the published figure is negative, i.e. when `c > netRevenue`:
 *        - `netRevenue >= c` → published margin >= 0 → still an upper bound.
 *        - `netRevenue < c`  → INDETERMINATE. Worked: gross revenue 100 (ex-VAT), COGS 150, and a
 *          £120 gross-basis credit that could not be placed. Published net revenue 100, published
 *          margin 100*(1 - 150/100) = -50%. Place the credit and net revenue is -20, so the report
 *          prints margin 0% — and 0% is NOT "at most -50%". Marking that `≤` is a false claim about
 *          a figure we cannot establish.
 *
 * Cases 1 and 4b are why this exists. Note the answer is `indeterminate`, NOT withheld: the number
 * is still the best available reading of a real period, and refusing to show it at all is this
 * branch's failure mode in the other direction. What is withheld is the RELATION.
 */
export function marginFigureBound(params: {
  /** The published net revenue the margin was divided by. */
  netRevenue: number
  /** COGS — the margin's numerator offset. Basis-independent: refunds never reduce it. */
  cogs: number
  /**
   * Refund value the net revenue could not absorb (gross-basis + unproven-basis), as an AMOUNT.
   * Never used to decide WHETHER a bound exists — `basisComplete` does that. A sub-penny unstamped
   * credit rounds this to 0 while still bounding the figure, and reading existence off the amount
   * would publish that as exact.
   */
  unplacedCredit: number
  /** False when ANY credit could not be placed on the net basis — the producers' existing flag. */
  basisComplete: boolean
}): DerivedFigureBound {
  const { netRevenue, cogs, unplacedCredit, basisComplete } = params
  if (basisComplete) return 'exact'
  if (!Number.isFinite(netRevenue) || !Number.isFinite(cogs) || !Number.isFinite(unplacedCredit)) {
    return 'indeterminate'
  }
  if (unplacedCredit < 0) return 'indeterminate' // see netLinearFigureBound
  if (cogs < 0) return 'indeterminate' // case 1: the quotient moves the OTHER way
  if (netRevenue <= 0) return 'exact' // case 2: the guard pins both readings to 0
  if (netRevenue - unplacedCredit > 0) return 'upper' // case 3
  return netRevenue >= cogs ? 'upper' : 'indeterminate' // case 4
}

/**
 * The suffix a figure carries, so the UI cells, the summary cards and the CSV cannot drift apart on
 * what `≤` versus `?` means. `?` is deliberately NOT `≤`: it says a bound exists but its direction is
 * not established.
 */

// ---------------------------------------------------------------------------
// o3d-kyey: the same two classifications, over Decimal.
// ---------------------------------------------------------------------------

/**
 * `netLinearFigureBound` for a caller that is Decimal all the way down.
 *
 * `lib/domain` is inside the decimal-boundary check for a reason, and the sales-analytics producer
 * is Decimal-pure: converting a period total to a float purely to ask which side of the true figure
 * it sits on would put a rounding step between the number that is PUBLISHED and the number the
 * classification was made about — the precise mistake round 5 found in the sales-stats summary,
 * where rounding twice produced a `≤` that was a false claim.
 *
 * The reasoning is `netLinearFigureBound`'s, unchanged, and `derived-figure-bounds.test.ts` runs
 * both over one shared case table so they cannot drift.
 *
 * ONE THING THE DOCSTRING THERE STATES MORE NARROWLY THAN IS NEEDED. It reasons about a NET figure
 * and a credit whose net value lies in `[0, unplacedCredit]`, which makes the published figure a
 * ceiling that is loose by at most that much. For a GROSS figure carrying an unplaced NET credit the
 * TIGHTNESS does not hold — the credit's gross value is larger than its net amount, so the true
 * figure can be further below than `unplacedCredit` suggests. The DIRECTION still holds, and the
 * direction is all `≤` claims: an unsubtracted non-negative credit can only make the published
 * figure too high. Callers on the gross basis therefore get a sound `≤` and no tightness promise.
 */
export function netLinearFigureBoundDecimal(params: {
  basisComplete: boolean
  unplacedCredit: DecimalInput
}): DerivedFigureBound {
  if (params.basisComplete) return 'exact'
  return toDecimal(params.unplacedCredit).lt(0) ? 'indeterminate' : 'upper'
}

/** `marginFigureBound`'s case analysis, over Decimal. Same five branches, in the same order. */
export function marginFigureBoundDecimal(params: {
  netRevenue: DecimalInput
  cogs: DecimalInput
  unplacedCredit: DecimalInput
  basisComplete: boolean
}): DerivedFigureBound {
  if (params.basisComplete) return 'exact'
  const netRevenue = toDecimal(params.netRevenue)
  const cogs = toDecimal(params.cogs)
  const unplacedCredit = toDecimal(params.unplacedCredit)
  if (unplacedCredit.lt(0)) return 'indeterminate'
  if (cogs.lt(0)) return 'indeterminate' // case 1
  if (netRevenue.lte(0)) return 'exact' // case 2
  if (netRevenue.sub(unplacedCredit).gt(0)) return 'upper' // case 3
  return netRevenue.gte(cogs) ? 'upper' : 'indeterminate' // case 4
}

/**
 * A ROW'S SHARE OF A REPORT-WIDE TOTAL — Customer Mix's `shareOfRevenuePct` and Gross Margin's
 * `contributionPct`. NEITHER IS AN UPPER BOUND, AND SAYING SO WOULD BE A FALSE CLAIM.
 *
 * Both have the form `100 * f_r / Σ f_i`, so an unplaced credit moves the numerator and the
 * denominator TOGETHER — and, unlike margin, the two move by DIFFERENT and unrelated amounts,
 * because the credit that could not be placed on this row is not the credit that could not be placed
 * on the others. Worked, on gross profit, with the report's own `Σ ≤ 0 → 0` guard:
 *
 *   - row 50, report total 100 → published 50%. All the unplaced credit belongs to OTHER rows
 *     (u_r = 0, U = 50): true share is 50/50 = 100%. The published figure is BELOW the truth.
 *   - the same 50 of 100 → published 50%. All of it belongs to THIS row (u_r = 50, U = 50): true
 *     share is 0/50 = 0%. The published figure is ABOVE the truth.
 *
 * Same published figure, same unplaced amount, opposite directions — so no relation can be attached
 * to it from the report's own data, and `indeterminate` (`?`) is the whole of what is known. The
 * figure itself still stands: it is the best reading of a real period, and withholding it would be
 * the other direction's failure.
 *
 * IT IS REPORT-WIDE, NOT PER ROW. A row with no unplaced credit of its own is still bounded, because
 * its DENOMINATOR moved; classifying from the row's own flag would publish that row as exact.
 */
export function shareFigureBound(params: { reportBasisComplete: boolean }): DerivedFigureBound {
  return params.reportBasisComplete ? 'exact' : 'indeterminate'
}
