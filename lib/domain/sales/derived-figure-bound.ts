/**
 * THE BOUND ON A DERIVED FIGURE, AS THE INTERVAL IT ACTUALLY IS.
 *
 * Split out from `refund-basis-analytics.ts` so a client component can render a marker without
 * pulling the analytics module — and Decimal with it — into the browser chunk. That split is not
 * tidiness: `refund-basis-analytics.ts` is imported by four server actions and an export route, and
 * when the dashboard client began importing `boundSuffix` from it, Turbopack had to generate a
 * client chunk for the whole module and codegen failed outright.
 *
 * Keep this file free of imports. That is the property that makes it safe to import from anywhere,
 * and the only thing a future edit could take away.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE INTERVAL IS THE REPRESENTATION AND THE VERDICT IS ONLY A RENDERING OF IT (o3d-la3n r2)
 * ---------------------------------------------------------------------------------------------
 *
 * Round 1 of this branch replaced a two-valued boolean with a three-valued verdict and then folded
 * VERDICTS to bound a filtered subtotal. Codex round 1 showed that no set of verdict states can be
 * both sound and tight, because the fold needs the ENDPOINT MAGNITUDES the verdict throws away:
 *
 *   - a row whose unplaced credit is negative-only occupies `[-30, 0]`, so the true figure lies
 *     between the published one and published + 30. That is a determinate LOWER bound, and a
 *     three-state model that has no `lower` has to call it `indeterminate` — which tells the reader
 *     the truth may be below the published figure when it provably cannot be.
 *   - an `upper` row and a `lower` row in the same subset may or may not fold to something
 *     determinate. `[-30, 0] + [0, 5]` is `[-30, 5]`, indeterminate; but `[-30, 0] + [0, 0]` is
 *     still `lower`… and from the two verdicts alone, `upper` and `lower`, both subsets look
 *     identical. The verdicts do not carry enough to tell them apart.
 *
 * So: carry `[lower, upper]` through aggregation, ADD endpoints when figures are summed, and
 * classify ONCE, at the point of display. `combineDerivedFigureBounds`-style verdict folding is not
 * offered by this module at all — the operation that was unsound is not merely discouraged, it has
 * no name to call.
 */

/**
 * What relation a PUBLISHED figure bears to the figure a complete refund basis would have produced.
 *
 * - `exact`         — the two are the same number. Publish it unmarked.
 * - `upper`         — the published figure is greater than or equal to the true one. Mark it `≤`.
 * - `lower`         — the published figure is less than or equal to the true one. Mark it `≥`.
 * - `indeterminate` — the true figure may be either side. Publishing a relation here would be a
 *                     FALSE CLAIM, which is worse than publishing no claim at all.
 *
 * This is a DISPLAY TOKEN derived from a `LinearFigureBoundInterval` (or, for a ratio, from
 * `marginFigureBound`'s own case analysis). It is not the fact; the interval is the fact.
 */
export type DerivedFigureBound = 'exact' | 'upper' | 'lower' | 'indeterminate'

/**
 * `≤` for an upper bound, `≥` for a lower one, `?` where the DIRECTION could not be established,
 * and nothing when the figure is exact. Marking a figure with the WRONG relation is worse than not
 * marking it, which is why `indeterminate` is `?` and never `≤`.
 */
export function boundSuffix(bound: DerivedFigureBound): string {
  if (bound === 'upper') return ' ≤'
  if (bound === 'lower') return ' ≥'
  if (bound === 'indeterminate') return ' ?'
  return ''
}

// ---------------------------------------------------------------------------
// The interval
// ---------------------------------------------------------------------------

declare const LINEAR_FIGURE_BOUND: unique symbol

/**
 * THE INTERVAL THE TRUE FIGURE OCCUPIES, STATED AS A DELTA ON THE PUBLISHED ONE:
 *
 *     true = published + δ,   δ ∈ [lower, upper]
 *
 * In the figure's own currency unit, UNROUNDED. Both endpoints, always — an interval collapsed to
 * one signed number is exactly the representation this module exists to stop being written.
 *
 * THE BRAND IS LOAD-BEARING. `marginFigureBound`'s case analysis divides two figures that move
 * together, so a row whose margin is indeterminate can sit inside a period whose margin is a sound
 * upper bound, and the reverse: ratio bounds DO NOT ADD. Round 1 stated that as a docstring
 * precondition, which is enforcement by comment. The nominal brand makes a structurally identical
 * `{ lower, upper }` built from ratio reasoning — or any other hand-rolled pair — unassignable to
 * `sumLinearFigureBounds`. The only public way to mint one is
 * `linearFigureBoundFromUnplacedCredit`, which takes REFUND-CREDIT BUCKETS: a ratio has no such
 * parts to offer it, so minting a ratio interval means actively fabricating credit entries rather
 * than merely forgetting to read a comment.
 */
export type LinearFigureBoundInterval = {
  readonly lower: number
  readonly upper: number
  readonly [LINEAR_FIGURE_BOUND]: 'linear'
}

/** `-0` and `0` compare equal but serialise and deep-equal differently. Normalise at the door. */
function zeroless(value: number): number {
  return value === 0 ? 0 : value
}

function mint(lower: number, upper: number): LinearFigureBoundInterval {
  return { lower: zeroless(lower), upper: zeroless(upper) } as LinearFigureBoundInterval
}

/** Nothing was left unsubtracted: the published figure IS the figure. The additive identity. */
export const EXACT_LINEAR_FIGURE_BOUND: LinearFigureBoundInterval = mint(0, 0)

/**
 * THE BOUND A LINEAR FIGURE CARRIES BECAUSE OF CREDIT IT COULD NOT PLACE ON ITS OWN BASIS.
 *
 * Each `part` is one bucket of unplaced credit: `total` is its SIGNED sum and `positive` is
 * `Σ max(entry, 0)` over the entries that fed it, so `Σ min(entry, 0)` is the difference. Both are
 * needed and neither alone will do — that is the whole finding this function descends from. Two
 * gross-basis credits of +£120 and −£60 leave a `total` of £60, and £60 is not negative, so a
 * classifier reading the signed sum answers `upper` about a figure whose truth can be £60 ABOVE the
 * published one.
 *
 * A credit entry `e` has a true value on the figure's basis somewhere in `[min(e, 0), max(e, 0)]`
 * — a gross credit's ex-VAT value is between zero and the credit itself, an unproven one is at most
 * itself, and a negative entry mirrors both. Summing per entry, the unplaced credit lies in
 * `[Σ min(e, 0), Σ max(e, 0)]`, and the figure is `published − credit`, so the DELTA interval is
 * that negated: `[-Σ max(e, 0), -Σ min(e, 0)]`.
 *
 * `positive` HAS TO BE ACCUMULATED AT THE ENTRY. By the time a bucket is a total there is no entry
 * left to look at, and no amount of care downstream can recover what the addition destroyed.
 */
export function linearFigureBoundFromUnplacedCredit(
  parts: ReadonlyArray<{ total: number; positive: number }>,
): LinearFigureBoundInterval {
  let creditLower = 0
  let creditUpper = 0
  for (const part of parts) {
    creditLower += part.total - part.positive
    creditUpper += part.positive
  }
  return mint(-creditUpper, -creditLower)
}

/**
 * THE BOUND ON A SUM OF LINEAR FIGURES — the endpoints ADD, and that is the whole of it.
 *
 * Sound and TIGHT: each part's delta is free to sit anywhere in its own interval independently of
 * the others, so the sum's extremes are attained. An empty iterable sums to
 * `EXACT_LINEAR_FIGURE_BOUND`, which is right — the empty subtotal is zero, exactly.
 *
 * This is the operation Product Profitability's browser-side filtered subtotal needs: there is one
 * published bound per row and an unbounded number of subsets the operator may filter to, so the
 * producer cannot publish a marker for the subtotal and the page must combine. It combines
 * INTERVALS. Folding the verdicts instead loses the endpoint magnitudes, and an `upper` row beside
 * a `lower` row cannot be classified without them.
 *
 * ONLY FOR A SUM. A RATIO is not covered — see the brand on `LinearFigureBoundInterval`, which is
 * what stops a ratio's bound arriving here in the first place.
 */
export function sumLinearFigureBounds(intervals: Iterable<LinearFigureBoundInterval>): LinearFigureBoundInterval {
  let lower = 0
  let upper = 0
  for (const interval of intervals) {
    lower += interval.lower
    upper += interval.upper
  }
  return mint(lower, upper)
}

/**
 * THE VERDICT, DERIVED FROM THE INTERVAL AT THE POINT OF DISPLAY.
 *
 * A zero-WIDTH interval that is not at zero (`[-5, -5]`) is `upper`, not `exact`: the true figure is
 * known exactly and it is not the published one, so a relation is owed and `≤` is the true one.
 * A non-finite endpoint is `indeterminate` — an unbounded interval establishes nothing — and so is
 * an inverted one, which can only mean a producer built it wrongly.
 */
export function classifyLinearFigureBound(interval: LinearFigureBoundInterval): DerivedFigureBound {
  const { lower, upper } = interval
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return 'indeterminate'
  if (lower === 0 && upper === 0) return 'exact'
  if (upper <= 0) return 'upper'
  if (lower >= 0) return 'lower'
  return 'indeterminate'
}

/**
 * HOW MUCH THE FIGURE COULD MOVE, IN THE DIRECTION THE VERDICT NAMES — for the disclosure line that
 * says how loose a marked figure is. `null` where no single direction applies (`exact`, and
 * `indeterminate`, where quoting one endpoint as "the width" is the cancelled-remainder defect
 * wearing a number).
 */
export function linearFigureBoundWidth(interval: LinearFigureBoundInterval): number | null {
  const bound = classifyLinearFigureBound(interval)
  if (bound === 'upper') return -interval.lower
  if (bound === 'lower') return interval.upper
  return null
}

// ---------------------------------------------------------------------------
// Display rounding
// ---------------------------------------------------------------------------

/**
 * ROUND A BOUNDED AMOUNT TO CENTS **IN THE DIRECTION ITS RELATION ALLOWS** (o3d-la3n r2, o3d-l4zz).
 *
 * Rounding is the last step and it is part of the claim. Codex round 1's counterexample: two
 * products each with raw revenue £0.014 and £0.001 of positive unplaced credit. Round each row to
 * cents FIRST and the subtotal is £0.01 + £0.01 = £0.02, while the true completed-basis aggregate
 * lies in [£0.026, £0.028] — so the page printed "at most £0.02" over a truth that is above it.
 * That is why every amount on this page is transported UNROUNDED and summed unrounded.
 *
 * But summing exactly is only half. The exact aggregate £0.028 rounds to the nearest cent as £0.03
 * — fine — while an exact aggregate of £0.024 would round to £0.02 and the `≤` would be false again
 * by up to half a cent. Nearest-cent rounding is not relation-preserving, so it is not used on a
 * figure that carries a relation:
 *
 *   - `upper` → round UP. The displayed figure is at least the exact one, which is at least the
 *     truth, so `≤ displayed` holds.
 *   - `lower` → round DOWN, by the mirror argument.
 *   - `exact` / `indeterminate` → nearest. Neither claims a relation for rounding to break.
 *
 * The pre-round to 9 decimal places is not cosmetic: `0.14 * 100` is `14.000000000000002` in
 * binary floating point, and a bare `Math.ceil` on that would publish £0.15 for £0.14.
 */
export function roundBoundedAmountForDisplay(amount: number, bound: DerivedFigureBound): number {
  if (!Number.isFinite(amount)) return amount
  const cents = Math.round(amount * 1e11) / 1e9
  if (bound === 'upper') return Math.ceil(cents) / 100
  if (bound === 'lower') return Math.floor(cents) / 100
  return Math.round(cents) / 100
}

// ---------------------------------------------------------------------------
// The collapsed-scalar entry point, for the producers not yet migrated
// ---------------------------------------------------------------------------

/**
 * `classifyLinearFigureBound` for a caller that has already collapsed its interval to one signed
 * number — Sales Statistics, the dashboard, and (through `netLinearFigureBoundDecimal`) the sales,
 * customer and margin reports.
 *
 * IT IS THE INPUT THAT IS THREE-VALUED HERE, NOT THE MODEL. A caller who hands over
 * `unplacedCreditBoundFromParts(...)` has already thrown away one endpoint: a negative value means
 * "some unplaced entry was negative" and says nothing about how much positive credit sat beside it,
 * so `indeterminate` is the strongest sound answer available and a provable `lower` cannot be
 * recovered from it. Migrating those five reports to `linearFigureBoundFromUnplacedCredit` is filed
 * as o3d-o20d; it is a change to their published markers and their own test suites, not to this
 * classification.
 *
 * `unplacedCredit` is the refund value the net figure could not absorb (gross-basis +
 * unproven-basis). Every figure of the form `netRevenue - k` for a basis-independent, non-negative
 * `k` (gross profit, average order value) moves with it one for one and carries the same relation.
 */
export function netLinearFigureBound(params: {
  /** False when ANY credit could not be placed on the net basis — the producers' existing flag. */
  basisComplete: boolean
  /** The COLLAPSED credit bound. Negative means an entry was negative; the other endpoint is gone. */
  unplacedCredit: number
}): DerivedFigureBound {
  if (params.basisComplete) return 'exact'
  if (!Number.isFinite(params.unplacedCredit) || params.unplacedCredit < 0) return 'indeterminate'
  // The collapse guarantees only that no entry was negative, so the delta interval it stands for is
  // `[-unplacedCredit, 0]`, and ONE classifier decides both forms.
  const bound = classifyLinearFigureBound(mint(-params.unplacedCredit, 0))
  // `basisComplete` is false, so something WAS left unsubtracted even where the amount rounds away
  // to nothing — dust is still value, and the interval alone would read that zero as `exact`.
  return bound === 'exact' ? 'upper' : bound
}
