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
  const basis = refundTotalsBasis(totalsBasis)
  if (basis === 'NET') return { bucket: 'net', placeableOnNetBasis: true }
  const bucket = basis === 'GROSS' ? 'gross' : 'unknown'
  return { bucket, placeableOnNetBasis: toDecimal(amountBase).isZero() }
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
