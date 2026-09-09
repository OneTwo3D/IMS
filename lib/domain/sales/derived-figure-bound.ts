/**
 * The bound MARKER, split out so a client component can render it without pulling the analytics
 * module — and Decimal with it — into the browser chunk.
 *
 * This split is not tidiness. `refund-basis-analytics.ts` is imported by four server actions and an
 * export route; when the dashboard client began importing `boundSuffix` from it, Turbopack had to
 * generate a client chunk for the whole module and codegen failed outright. A pure type and a
 * three-branch string are all the browser needs; everything that reasons ABOUT the bound stays
 * server-side, where the Decimal arithmetic that establishes it already lives.
 *
 * Keep this file free of imports. That is the property that makes it safe to import from anywhere,
 * and the only thing a future edit could take away.
 */
export type DerivedFigureBound = 'exact' | 'upper' | 'indeterminate'

/**
 * `≤` for an upper bound, `?` where the DIRECTION could not be established, and nothing when the
 * figure is exact. A ratio can move either way when a credit is unplaced, so it gets `?` rather
 * than a relation that would be a false claim — marking a figure with the WRONG relation is worse
 * than not marking it.
 */
export function boundSuffix(bound: DerivedFigureBound): string {
  return bound === 'upper' ? ' ≤' : bound === 'indeterminate' ? ' ?' : ''
}

/**
 * Rounds 1-3 marked EVERY net-revenue-derived figure `≤`, reasoning that they all "move with
 * revenue". For the figures that move with it ONE-FOR-ONE that is right, and this function says so.
 *
 * `unplacedCredit` is the refund value the net figure could not absorb (gross-basis + unproven-basis).
 * Its true NET value is somewhere in `[0, unplacedCredit]` — a GROSS credit's ex-VAT value is smaller
 * than the credit itself, and an unproven one is at most itself — so the true net revenue lies in
 * `[netRevenue - unplacedCredit, netRevenue]`. Every figure of the form `netRevenue - k` or
 * `netRevenue / k` for a basis-independent, NON-NEGATIVE `k` (gross profit, average order value)
 * therefore only ever moves DOWN, and the published value is a genuine ceiling.
 *
 * A NEGATIVE unplacedCredit would put the true figure ABOVE the published one, so it is reported as
 * indeterminate rather than silently mis-marked. It should not arise — the buckets are fed only by
 * refund lines carrying a productId, and the one refund line that is negative by construction (the
 * mirrored order-discount line, lib/domain/sales/refund-service) carries no productId — but the
 * classification does not depend on that holding.
 */
export function netLinearFigureBound(params: {
  /** False when ANY credit could not be placed on the net basis — the producers' existing flag. */
  basisComplete: boolean
  /** How much credit was left unsubtracted. Used only for its SIGN; the flag decides existence. */
  unplacedCredit: number
}): DerivedFigureBound {
  if (params.basisComplete) return 'exact'
  if (!Number.isFinite(params.unplacedCredit) || params.unplacedCredit < 0) return 'indeterminate'
  return 'upper'
}

/**
 * THE VERDICT FOR A SUM OF LINEAR FIGURES, FROM THE VERDICTS OF ITS PARTS (o3d-la3n).
 *
 * Product Profitability's totals are re-summed IN THE BROWSER over whatever subset the operator has
 * filtered to, so the producer cannot publish a marker for them: there is one marker per row and an
 * unbounded number of subsets. The browser must therefore combine. What it must NOT do is combine by
 * re-deriving from published columns — those arrive ROUNDED, and `refundsGrossBasis +
 * refundsUnknownBasis` is a SIGNED SUM in which two opposite same-basis credits cancel to a zero
 * that is not negative, which is the whole defect this function exists to make unrepresentable.
 *
 * WHY COMBINING THE VERDICTS IS SOUND HERE, WHICH IS NOT A GENERAL LICENCE.
 *
 * Write each part's unplaced credit as the interval `[lᵢ, uᵢ]` with `lᵢ = Σ min(entry, 0)` and
 * `uᵢ = Σ max(entry, 0)` over that part's own entries. Two facts do the work:
 *
 *   1. `lᵢ ≤ 0` ALWAYS — it is a sum of `min(x, 0)` terms. So `Σ lᵢ < 0` if and only if some
 *      individual `lᵢ < 0`. `netLinearFigureBound` answers `indeterminate` exactly on `l < 0`, so
 *      the sum is indeterminate exactly when SOME part is.
 *   2. A part whose flag says `basisComplete` has no unplaced entry that is not exactly zero — the
 *      placement rule treats an exactly-zero amount as placeable on either basis and nothing else —
 *      so its interval is `[0, 0]` and it cannot make the sum indeterminate. The sum is `exact`
 *      exactly when EVERY part is.
 *
 * That leaves `upper` for everything else, and the three cases are exhaustive.
 *
 * PRECONDITION, and it is the whole of it: the combined figure must be the SUM of the figures whose
 * verdicts these are, each one classified by `netLinearFigureBound` over its OWN unplaced-credit
 * interval. A RATIO is not covered — `marginFigureBound`'s case analysis divides two figures that
 * move together, and a row whose margin is indeterminate can sit inside a period whose margin is a
 * sound upper bound, and the reverse. Do not reach for this function there.
 *
 * `tests/analytics/product-profitability-refund-basis.test.ts` pins fact 1 by checking this against
 * `unplacedCreditBoundFromParts` over the summed parts, which is the arithmetic it stands in for.
 */
export function combineNetLinearFigureBounds(bounds: Iterable<DerivedFigureBound>): DerivedFigureBound {
  let sawInexact = false
  for (const bound of bounds) {
    if (bound === 'indeterminate') return 'indeterminate'
    if (bound !== 'exact') sawInexact = true
  }
  return sawInexact ? 'upper' : 'exact'
}
