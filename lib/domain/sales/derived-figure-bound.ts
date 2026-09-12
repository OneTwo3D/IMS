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
 * WHY THE INTERVAL IS THE REPRESENTATION AND THE VERDICT IS ONLY A RENDERING OF IT (o3d-la3n r3)
 * ---------------------------------------------------------------------------------------------
 *
 * Round 1 of this branch replaced a two-valued boolean with a three-valued verdict and then folded
 * VERDICTS to bound a filtered subtotal. The three-state model was genuinely short of a state: a row
 * whose unplaced credit is negative-only has a delta interval of `[0, +30]`, so the true figure lies
 * between the published one and published + 30. That is a determinate LOWER bound, and a model with
 * no `lower` has to call it `indeterminate` — telling the reader the truth may be below a figure it
 * provably cannot be below. FOUR states fix that, and `DerivedFigureBound` has four.
 *
 * WHAT ROUNDS 1 AND 2 CLAIMED HERE AND WHAT IS ACTUALLY TRUE (corrected, Codex round 2). The
 * argument written here was that four verdicts still cannot classify a SUM: that `upper + lower`
 * might fold either way, with `[-30, 0] + [0, 0]` offered as the determinate case. THAT IS WRONG,
 * and `[0, 0]` is `exact`, not `lower` — the pair in the "counterexample" is `upper + exact`. Every
 * interval this module can mint CONTAINS ZERO: `EXACT_LINEAR_FIGURE_BOUND` is `[0, 0]`, and
 * `linearFigureBoundFromUnplacedCredit` accumulates `creditLower <= 0 <= creditUpper` from
 * `Σ min(e, 0)` and `Σ max(e, 0)`, whichever entries it is given. So an `upper` interval ENDS at
 * zero, a `lower` interval STARTS at zero, and their sum has a negative lower end and a positive
 * upper end — it straddles zero, always, and is always `indeterminate`. Under that invariant the
 * four verdicts ARE sufficient to classify a sum, and no counterexample of that shape exists.
 *
 * THE INTERVAL IS STILL THE RIGHT REPRESENTATION, FOR TWO REASONS THAT DO NOT REST ON THAT BEING
 * IMPOSSIBLE:
 *
 *   1. IT PRESERVES WIDTHS, AND THE VERDICT IS NOT THE ONLY THING READ OFF A BOUND. Product
 *      Profitability prints "Not subtracted: up to £42.00 of credit" under a subtotal of two rows
 *      bounded by £12 and £30. `linearFigureBoundWidth` gets that by adding endpoints; a fold over
 *      the verdicts `upper` and `upper` has thrown both magnitudes away and can only say "up to
 *      an unknown amount". A verdict fold is not merely awkward for the disclosure line, it cannot
 *      produce it at all.
 *   2. IT DOES NOT DEPEND ON THE CONSTRUCTOR INVARIANT HOLDING. "Every minted interval contains
 *      zero" is a property of today's only public constructor, not of the type, and nothing in the
 *      compiler enforces it. A verdict fold would be sound only for as long as that stayed true,
 *      and would go silently wrong — publishing `upper` over a figure whose truth is above it — the
 *      first time a producer mints `[-30, -5]`. Adding endpoints is correct for any intervals
 *      whatever, so the soundness of the aggregate owes nothing to how the parts were built.
 *
 * So: carry `[lower, upper]` through aggregation, ADD endpoints when figures are summed, and
 * classify ONCE, at the point of display. `combineDerivedFigureBounds`-style verdict folding is not
 * offered by this module at all — the operation that would carry that debt has no name to call.
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
 * INTERVALS. Folding the verdicts instead loses the endpoint magnitudes — which is what the
 * disclosure line "up to £42.00 of credit" is made of — and stakes the aggregate's soundness on
 * every part having been minted containing zero. See the header for both arguments.
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

declare const BOUNDED_FIGURE_STRING: unique symbol

/**
 * A PUBLISHED FIGURE THAT CARRIES A RELATION, RENDERED AT A PRECISION THAT CANNOT BREAK IT
 * (o3d-rv4a r2, Codex round 2 HIGH 2 + HIGH 3).
 *
 * THE BRAND IS HERE BECAUSE ALL THREE OF ROUND 1'S FINDINGS WERE ONE MISTAKE: a bound was handled as
 * an ordinary number — filtered like one, summed like one, and rounded like one. Comments asking for
 * care did not stop it; two of the three sites had a comment about bounds directly above the line
 * that broke one. So the DIRECTION is made a precondition of producing the string at all:
 *
 *   - `moneyString(value)` and `decimalString(value, places)` return a plain `string`, which is NOT
 *     assignable to this type. A row field or totals field declared `BoundedFigureString` therefore
 *     cannot be filled by a rounder that was never told which way to go — that is a type error, not
 *     a review note.
 *   - The one way to obtain one is `boundedFigureString` (`refund-basis-analytics.ts`), which takes
 *     the figure's `DerivedFigureBound` as a required argument and rounds toward +infinity for an
 *     `upper`, toward -infinity for a `lower`, and to nearest only for the two verdicts that claim no
 *     relation at all.
 *
 * Exactly the mechanism `CollapsedUnplacedCredit` below uses against a different unsound expression,
 * and for the same stated reason: what must not be written should not typecheck.
 *
 * A `≤` over a figure rounded to NEAREST is not a weaker claim, it is a false one. £100.004 of
 * revenue against £0.0001 of gross-basis credit is truly at most £100.0039167 at 20% VAT, and
 * "≤ £100.00" excludes the truth. Half a penny of politeness inverts the relation.
 *
 * Type-only: at runtime this is the string it says it is.
 */
export type BoundedFigureString = string & { readonly [BOUNDED_FIGURE_STRING]: 'rounded-toward-its-bound' }

// ---------------------------------------------------------------------------
// The collapsed-scalar entry point, for the producers not yet migrated
// ---------------------------------------------------------------------------

declare const COLLAPSED_UNPLACED_CREDIT: unique symbol

/**
 * A CREDIT BOUND THAT HAS ALREADY BEEN COLLAPSED TO ONE SIGNED NUMBER — and the only thing the
 * collapsed-scalar classifiers will accept (o3d-la3n r3).
 *
 * THE BRAND IS WHAT REMOVES THE OLD UNSOUND RULE, NOT A COMMENT ASKING NOBODY TO WRITE IT. Round 2
 * deleted `…RefundBasisComplete` from the wire so the broken classification could not be rebuilt
 * from a published row — but the two SIGNED disclosure buckets are still published, and must be:
 * `refundsGrossBasis` and `refundsUnknownBasis` are columns on the Product Profitability table, in
 * its CSV, and in the sales-analytics exports, where an operator reads them to find the credit that
 * was left out. What they may NOT do is become the input to a classifier, because adding them
 * cancels a +£120 against a −£120 into a zero that is not negative, and every classifier downstream
 * then answers `upper` about a figure whose truth can be £120 above the published one.
 *
 * `number` cannot say that, and completeness is still derivable (`classifyLinearFigureBound(bound)
 * === 'exact'` reconstructs the removed flag exactly), so while these functions took a plain
 * `number` the whole broken rule stayed one expression away for any consumer, with no cast needed.
 * A plain `number` is not assignable to this type, so `gross + unknown` — or any other hand-rolled
 * sum — no longer typechecks as a bound. The one public way to obtain one is
 * `unplacedCreditBoundFromParts`, which demands `Σ max(entry, 0)` ALONGSIDE each bucket's signed
 * total: precisely the endpoint the addition destroys, and precisely what a row's published
 * disclosure columns do not carry. Producing one from a published row therefore means fabricating
 * a `positive` that was never measured, not merely forgetting to read this paragraph.
 *
 * Type-only: at runtime this is the number it says it is.
 */
export type CollapsedUnplacedCredit = number & { readonly [COLLAPSED_UNPLACED_CREDIT]: 'collapsed' }

/**
 * The one place a collapsed scalar is minted. Kept here, beside the type, so the cast that creates
 * the brand exists exactly once — `refund-basis-analytics.ts` calls this rather than casting again.
 *
 * `total` is a bucket's SIGNED sum and `positive` is `Σ max(entry, 0)` over the entries that fed it,
 * so `Σ min(entry, 0)` is the difference. The collapse keeps the SIGN and throws one endpoint away:
 * a negative result means some unplaced entry was negative, and a non-negative one means none was,
 * which is the whole of what the collapsed classifiers read.
 */
export function collapseUnplacedCredit(
  parts: ReadonlyArray<{ total: number; positive: number }>,
): CollapsedUnplacedCredit {
  let lower = 0
  let upper = 0
  for (const part of parts) {
    lower += part.total - part.positive
    upper += part.positive
  }
  // Below zero at the bottom is what both collapsed classifiers read as "no `≤` may be claimed";
  // otherwise no unplaced entry was negative and the ceiling is the top of the credit interval.
  return (lower < 0 ? lower : upper) as CollapsedUnplacedCredit
}

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
 *
 * IT IS A `CollapsedUnplacedCredit` AND NOT A `number` ON PURPOSE (o3d-la3n r3). That is what makes
 * the rule this branch removed — completeness off the published bound, credit off
 * `refundsGrossBasis + refundsUnknownBasis` — fail to compile rather than merely fail to be
 * mentioned. See the type.
 */
export function netLinearFigureBound(params: {
  /** False when ANY credit could not be placed on the net basis — the producers' existing flag. */
  basisComplete: boolean
  /** The COLLAPSED credit bound. Negative means an entry was negative; the other endpoint is gone. */
  unplacedCredit: CollapsedUnplacedCredit
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
