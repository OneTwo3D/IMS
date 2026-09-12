import assert from 'node:assert/strict'
import test from 'node:test'

import { toDecimal } from '@/lib/domain/math/decimal'
import { boundedFigureString, collapseUnplacedCreditDecimal, marginFigureBound, marginFigureBoundDecimal, netLinearFigureBound, netLinearFigureBoundDecimal, shareFigureBound, boundSuffix, unplacedCreditBoundFromParts, type CollapsedUnplacedCreditDecimal } from '@/lib/domain/sales/refund-basis-analytics'
import {
  EXACT_LINEAR_FIGURE_BOUND,
  classifyLinearFigureBound,
  linearFigureBoundFromUnplacedCredit,
  linearFigureBoundWidth,
  roundBoundedAmountForDisplay,
  sumLinearFigureBounds,
  type CollapsedUnplacedCredit,
  type DerivedFigureBound,
  type LinearFigureBoundInterval,
} from '@/lib/domain/sales/derived-figure-bound'

/**
 * o3d-iigc round 4, Codex finding 1: AVG MARGIN IS NOT NECESSARILY AN UPPER BOUND.
 *
 * Rounds 1-3 marked every net-revenue-derived figure `≤` on one argument: they all move with net
 * revenue, and net revenue can only be too HIGH when a credit could not be subtracted from it. For
 * net revenue, gross profit and average order value that argument is sound — each is
 * `netRevenue - k` or `netRevenue / k` for a fixed, non-negative, basis-independent `k`.
 *
 * Margin is not one of those. It is
 *
 *     m(t) = t > 0 ? ((t - c) / t) * 100 : 0
 *
 * for COGS `c` and net revenue `t` — the `netRevenue > 0` guard is part of the published figure, not
 * an implementation detail — and the unsubtracted credit moves the NUMERATOR AND THE DENOMINATOR
 * TOGETHER. `m'(t) = c/t²`, so the direction of the error depends on the sign of `c` and on whether
 * the interval of possible true revenues stays on one side of zero.
 *
 * These tests pin all four branches with worked numbers, INCLUDING the two that make `≤` a false
 * claim. Marking a figure with the wrong relation is worse than not marking it at all.
 */

/**
 * A COLLAPSED SCALAR NAMED OUTRIGHT — WHICH ONLY A TEST MAY DO (o3d-la3n r3).
 *
 * `netLinearFigureBound` and `marginFigureBound` take a `CollapsedUnplacedCredit`, and the only
 * public way to mint one is `unplacedCreditBoundFromParts`, which demands `Σ max(entry, 0)` beside
 * each bucket's signed total. That is what makes `refundsGrossBasis + refundsUnknownBasis` fail to
 * compile as a bound: a published row carries the totals and not the positives, so rebuilding the
 * removed rule now means inventing a number nobody measured.
 *
 * These tests are ABOUT what the classifiers answer for a given scalar — including scalars no
 * bucket could produce, like NaN — so they state the scalar and cast once, here. The tests that
 * pin the MINT itself go through `unplacedCreditBoundFromParts` and do not use this.
 */
const collapsed = (value: number) => value as CollapsedUnplacedCredit

/** The same, for the Decimal twins. `collapseUnplacedCreditDecimal` is the real mint. */
const collapsedDecimal = (value: number): CollapsedUnplacedCreditDecimal =>
  collapseUnplacedCreditDecimal({ lower: toDecimal(value), upper: toDecimal(value) })

// ---------------------------------------------------------------------------
// The figures that move one-for-one — the argument rounds 1-3 made, which holds for these
// ---------------------------------------------------------------------------

test('linear figures: a complete basis is exact, an incomplete one is a genuine upper bound (o3d-iigc r4)', () => {
  assert.equal(netLinearFigureBound({ basisComplete: true, unplacedCredit: collapsed(0) }), 'exact')
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(120) }), 'upper')
})

test('linear figures: EXISTENCE comes from the flag, not the amount — a sub-penny credit still bounds (o3d-iigc r4)', () => {
  // The producers round their reported bucket totals to 2dp, so a £0.004 unstamped credit reports
  // as £0.00 while `refundBasisComplete` stays false. Reading existence off the amount would
  // publish that row as EXACT — a claim about a figure we just said we could not place.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(0) }), 'upper')
  assert.equal(
    marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(0), basisComplete: false }),
    'upper',
  )
})

test('linear figures: a NEGATIVE unplaced credit would bound the other way, so it is not marked ≤ (o3d-iigc r4)', () => {
  // Not reachable today — the buckets are fed only by refund lines carrying a productId, and the one
  // refund line that is negative by construction (the mirrored order-discount line) carries none —
  // but the classification does not depend on that holding.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(-5) }), 'indeterminate')
  assert.equal(
    marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(-5), basisComplete: false }),
    'indeterminate',
  )
})

// ---------------------------------------------------------------------------
// Margin — the four branches
// ---------------------------------------------------------------------------

test('margin: a complete basis is exact and carries NO mark (o3d-iigc r4 control)', () => {
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(0), basisComplete: true }), 'exact')
  // And the control is not vacuous: the SAME numbers with the flag flipped are marked.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(0), basisComplete: false }), 'upper')
})

test('margin case 3: the whole interval of possible revenues stays positive, so ≤ holds (o3d-iigc r4)', () => {
  // £1,000 net revenue, £400 COGS, £120 of credit that could not be placed. The true revenue is
  // somewhere in [880, 1000], all positive, and m rises with t when COGS is positive:
  //   m(1000) = 100*(1 - 400/1000) = 60.0%   <- published
  //   m(880)  = 100*(1 - 400/880)  = 54.5%   <- the loosest the truth can be
  // 54.5 <= 60.0, so the published figure really is a ceiling.
  assert.equal(marginFigureBound({ netRevenue: 1000, cogs: 400, unplacedCredit: collapsed(120), basisComplete: false }), 'upper')
})

test('margin case 4a: the interval straddles zero but the published margin is positive — still ≤ (o3d-iigc r4)', () => {
  // £100 net revenue, £40 COGS, a £120 gross credit. The true revenue could be as low as -£20, where
  // the report's own guard prints 0%. Published is 100*(1 - 40/100) = 60%, and every reachable value
  // — 0% from the guard, and everything below 60% for a positive revenue — is at most that.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(120), basisComplete: false }), 'upper')
})

test('margin case 4b: COGS above net revenue makes ≤ A FALSE CLAIM — the finding (o3d-iigc r4)', () => {
  // THE COUNTEREXAMPLE. £100 net revenue (ex-VAT), £150 COGS, and a £120 gross-basis credit that
  // could not be placed.
  //   published: m(100) = 100*(1 - 150/100) = -50.0%
  //   place the credit at its £100 ex-VAT value and net revenue is 0, where the guard prints 0.0%
  //   0.0% is NOT "at most -50.0%".
  // Round 3 marked this `≤`. It is not a bound in that direction at all.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 150, unplacedCredit: collapsed(120), basisComplete: false }), 'indeterminate')

  // And the boundary is exactly `netRevenue >= cogs`, not a hand-wave: at COGS 100 the published
  // margin is 0%, which the guard's 0% ties rather than exceeds.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 100, unplacedCredit: collapsed(120), basisComplete: false }), 'upper')
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 100.01, unplacedCredit: collapsed(120), basisComplete: false }), 'indeterminate')
})

test('margin case 1: a NEGATIVE COGS inverts the direction entirely (o3d-iigc r4)', () => {
  // m'(t) = c/t², so with c < 0 the margin RISES as revenue falls: at revenue 1000 and COGS -100,
  //   m(1000) = 100*(1 + 100/1000) = 110.0%   <- published
  //   m(900)  = 100*(1 + 100/900)  = 111.1%   <- higher than the "upper bound"
  // The published figure is a LOWER bound here, so `≤` is again the wrong relation.
  assert.equal(marginFigureBound({ netRevenue: 1000, cogs: -100, unplacedCredit: collapsed(120), basisComplete: false }), 'indeterminate')
})

test('margin case 2: a non-positive net revenue pins both readings to the guard, so it is EXACT (o3d-iigc r4)', () => {
  // The true revenue can only be lower than the published one, and the guard already prints 0% for
  // everything at or below zero. Both readings are 0%, so marking this would OVERSTATE the
  // uncertainty — the failure mode in the other direction.
  assert.equal(marginFigureBound({ netRevenue: 0, cogs: 40, unplacedCredit: collapsed(120), basisComplete: false }), 'exact')
  assert.equal(marginFigureBound({ netRevenue: -30, cogs: 40, unplacedCredit: collapsed(120), basisComplete: false }), 'exact')
})

test('a non-finite CREDIT is never silently classified as a bound (o3d-iigc r4)', () => {
  // The load-bearing input is the credit, not the revenue: a NaN or infinite revenue already fails
  // every comparison below and lands on `indeterminate` anyway, whereas a NaN credit makes
  // `netRevenue - unplacedCredit > 0` merely FALSE, which without the guard falls through to the
  // case-4 test and publishes `upper` — a bound asserted from an amount that is not a number.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(Number.NaN), basisComplete: false }), 'indeterminate')
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(Number.POSITIVE_INFINITY), basisComplete: false }), 'indeterminate')
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(Number.NaN) }), 'indeterminate')

  // And with a real credit the same shape IS a bound, so the assertion is not merely "always refuse".
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: collapsed(120), basisComplete: false }), 'upper')
})

// ---------------------------------------------------------------------------
// The mark itself
// ---------------------------------------------------------------------------

test('the suffix distinguishes the four claims, and ? is deliberately not ≤ (o3d-iigc r4, o3d-la3n r2)', () => {
  assert.equal(boundSuffix('exact'), '')
  assert.equal(boundSuffix('upper'), ' ≤')
  assert.equal(boundSuffix('lower'), ' ≥')
  assert.equal(boundSuffix('indeterminate'), ' ?')
  assert.notEqual(boundSuffix('indeterminate'), boundSuffix('upper'))
  assert.notEqual(boundSuffix('lower'), boundSuffix('upper'))
  // All four are distinct: a mark that collides with another is a mark that says the wrong thing.
  assert.equal(new Set((['exact', 'upper', 'lower', 'indeterminate'] as const).map(boundSuffix)).size, 4)
})

// ---------------------------------------------------------------------------
// o3d-kyey: the Decimal-native twins, and the ratio-of-a-total classifier
// ---------------------------------------------------------------------------

/**
 * THE ANTI-DIVERGENCE TEST. The sales-analytics producer is Decimal-pure and must not round a period
 * total to a float purely to ask which side of the true figure it sits on, so the two classifiers
 * above got Decimal twins. Two copies of a five-branch case analysis is exactly the thing that rots:
 * this walks a case table that reaches EVERY branch of both and asserts they answer identically.
 *
 * The table is asserted to reach all three verdicts, so a mistake that made one classifier constant
 * cannot pass by making the other constant in the same way.
 */
const BOUND_CASES: Array<{ netRevenue: number; cogs: number; unplacedCredit: number; basisComplete: boolean }> = [
  { netRevenue: 100, cogs: 40, unplacedCredit: 0, basisComplete: true },     // exact by the flag
  { netRevenue: 100, cogs: 40, unplacedCredit: 10, basisComplete: false },   // margin case 3
  { netRevenue: 100, cogs: 40, unplacedCredit: 120, basisComplete: false },  // margin case 4a
  { netRevenue: 100, cogs: 150, unplacedCredit: 120, basisComplete: false }, // margin case 4b
  { netRevenue: 100, cogs: -5, unplacedCredit: 10, basisComplete: false },   // margin case 1
  { netRevenue: 0, cogs: 40, unplacedCredit: 10, basisComplete: false },     // margin case 2
  { netRevenue: -20, cogs: 40, unplacedCredit: 10, basisComplete: false },   // margin case 2, negative
  { netRevenue: 100, cogs: 40, unplacedCredit: -1, basisComplete: false },   // negative credit
  { netRevenue: 100, cogs: 40, unplacedCredit: 0, basisComplete: false },    // sub-penny: flag decides
]

test('the Decimal bound classifiers answer exactly what their number twins do (o3d-kyey)', () => {
  const linear = new Set<string>()
  const margin = new Set<string>()
  for (const input of BOUND_CASES) {
    const linearNumber = netLinearFigureBound({ basisComplete: input.basisComplete, unplacedCredit: collapsed(input.unplacedCredit) })
    const linearDecimal = netLinearFigureBoundDecimal({ basisComplete: input.basisComplete, unplacedCredit: collapsedDecimal(input.unplacedCredit) })
    assert.equal(linearDecimal, linearNumber, `linear disagreed on ${JSON.stringify(input)}`)
    linear.add(linearNumber)
    const marginNumber = marginFigureBound({ ...input, unplacedCredit: collapsed(input.unplacedCredit) })
    const marginDecimal = marginFigureBoundDecimal({ ...input, unplacedCredit: collapsedDecimal(input.unplacedCredit) })
    assert.equal(marginDecimal, marginNumber, `margin disagreed on ${JSON.stringify(input)}`)
    margin.add(marginNumber)
  }
  // The table must actually exercise the branches, or "they agree" is a statement about nothing.
  assert.deepEqual([...linear].sort(), ['exact', 'indeterminate', 'upper'])
  assert.deepEqual([...margin].sort(), ['exact', 'indeterminate', 'upper'])
})

/**
 * A RATIO OF A ROW TO A REPORT TOTAL IS NEVER AN UPPER BOUND — Customer Mix's share of revenue and
 * Gross Margin's contribution. Worked in `shareFigureBound`'s docstring: the same published 50% of a
 * 100 total with 50 of unplaced credit is 100% if none of that credit is this row's and 0% if all of
 * it is. Same figure, same amount, opposite directions, so no relation can be attached to it.
 */
test('a share-of-total ratio is exact or it is indeterminate — never ≤ (o3d-kyey)', () => {
  assert.equal(shareFigureBound({ reportBasisComplete: true }), 'exact')
  assert.equal(shareFigureBound({ reportBasisComplete: false }), 'indeterminate')
  assert.equal(boundSuffix(shareFigureBound({ reportBasisComplete: false })), ' ?')
})

/**
 * THE DOOR THE BRAND CLOSES, ASSERTED AT THE TYPE LEVEL (o3d-la3n r3).
 *
 * Round 2 removed the completeness boolean from the published row so the old unsound rule could not
 * be rebuilt from it. It left the rest of the rule reachable: both SIGNED disclosure buckets are
 * still published — they are columns an operator reads, on screen and in three CSVs, and removing
 * them would hide the very credit the mark exists to disclose — completeness is recoverable from
 * the interval, and all four classifiers took a plain number. So `gross + unknown` handed to any of
 * them rebuilt the whole thing with no cast, which is a convention against it, not an absence of it.
 *
 * These four lines ARE the assertion. Each fails to compile today; widen any parameter back and tsc
 * reports "Unused '@ts-expect-error' directive" on that line and the build goes red. `DecimalInput`
 * admits a plain `number`, which is why the Decimal twins need the same brand — closing only the
 * float door would have been a proof about the wrong door.
 *
 * The calls still RUN: the brand is type-only, so this also pins that nothing about it changes what
 * the classifiers answer at runtime.
 */
test('a hand-rolled signed bucket sum is not a bound, at any of the four classifiers (o3d-la3n r3)', () => {
  const gross = 60
  const unknown = 0
  const basisComplete = false

  // @ts-expect-error a signed bucket sum is a plain number, never a CollapsedUnplacedCredit
  netLinearFigureBound({ basisComplete, unplacedCredit: gross + unknown })
  // @ts-expect-error the ratio classifier reads the same scalar for the same sign, so same door
  marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: gross + unknown, basisComplete })
  // @ts-expect-error DecimalInput admits a plain number; only the brand closes this one
  netLinearFigureBoundDecimal({ basisComplete, unplacedCredit: gross + unknown })
  // @ts-expect-error and the ratio's Decimal twin, for the same reason
  marginFigureBoundDecimal({ netRevenue: 100, cogs: 40, unplacedCredit: gross + unknown, basisComplete })

  // What the caller must write instead, and why it is not a formality: the mint demands
  // Σ max(entry, 0) beside the signed total, and with that endpoint present the +£120/−£60 pair
  // that summed to a harmless-looking £60 is correctly refused a direction.
  assert.equal(
    netLinearFigureBound({ basisComplete, unplacedCredit: unplacedCreditBoundFromParts([{ total: gross, positive: 120 }]) }),
    'indeterminate',
    'the endpoint the addition destroyed is exactly what changes the answer',
  )
})

/**
 * o3d-7jfq: THE INTERVAL, OVER `number`, FOR THE PRODUCERS THAT ARE NOT DECIMAL.
 *
 * `unplacedCreditBoundFromParts` is what stops a signed bucket sum reaching the classifiers above.
 * The endpoints are `Σ min(entry, 0) = total - positive` and `Σ max(entry, 0) = positive`, and the
 * classifiers read the result for its SIGN — so what has to hold is that a bucket containing a
 * negative entry comes back below zero even when its signed total does not.
 */
test('the number-world interval keeps a negative entry visible through a zero bucket (o3d-7jfq)', () => {
  // +120 and -120 of the same basis: total 0, positive 120, so the lower end is 0 - 120 = -120.
  assert.equal(unplacedCreditBoundFromParts([{ total: 0, positive: 120 }]), -120)
  // The signed sum this replaced. Zero is not negative, so the classifier said `upper` about it.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(0) }), 'upper')
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: unplacedCreditBoundFromParts([{ total: 0, positive: 120 }]) }), 'indeterminate')

  // All entries non-negative: lower is 0, so the upper end is returned and the ceiling stands.
  assert.equal(unplacedCreditBoundFromParts([{ total: 240, positive: 240 }]), 240)
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: collapsed(240) }), 'upper')

  // Two buckets summed as one interval, which is what every call site passes: gross +120/-120 and
  // unknown +5. Lower = -120 + 0 = -120, so it is negative and wins, even though the ARITHMETIC sum
  // across both buckets (0 + 5 = 5) is positive.
  assert.equal(unplacedCreditBoundFromParts([{ total: 0, positive: 120 }, { total: 5, positive: 5 }]), -120)

  // Nothing unplaced at all: both endpoints zero, and the caller's basisComplete flag decides.
  assert.equal(unplacedCreditBoundFromParts([{ total: 0, positive: 0 }]), 0)
  assert.equal(unplacedCreditBoundFromParts([]), 0)
})

// ---------------------------------------------------------------------------
// o3d-la3n round 2: THE INTERVAL IS THE MODEL; THE VERDICT IS A RENDERING OF IT
// ---------------------------------------------------------------------------

/**
 * Codex round 1, HIGH 2. Round 1 modelled a bound as a three-valued verdict and folded VERDICTS to
 * bound a filtered subtotal. Two things were wrong with that, and both are about the endpoints the
 * verdict throws away:
 *
 *   1. a negative-only unplaced credit is a PROVABLE LOWER bound — the true figure lies between the
 *      published one and published + width — and a model with no `lower` has to call that
 *      `indeterminate`, telling the reader the truth may be below a figure it cannot be below;
 *   2. the WIDTH of a subtotal's bound is the sum of its parts' widths, and there is nothing in a
 *      list of marks to sum.
 *
 * So the endpoints are carried, added, and classified last.
 */

test('a NEGATIVE-only unplaced credit is a lower bound, not "direction unknown" (o3d-la3n r2)', () => {
  const bound = linearFigureBoundFromUnplacedCredit([{ total: -30, positive: 0 }])
  assert.deepEqual({ ...bound }, { lower: 0, upper: 30 }, 'the truth is between the published figure and +30')
  assert.equal(classifyLinearFigureBound(bound), 'lower')
  assert.equal(linearFigureBoundWidth(bound), 30)
  // The collapsed-scalar classifier the un-migrated producers still use cannot get there: collapsing
  // keeps the sign and discards the other endpoint, so `indeterminate` is all it can soundly say.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: unplacedCreditBoundFromParts([{ total: -30, positive: 0 }]) }), 'indeterminate')
})

test('an UPPER part and a LOWER part fold to indeterminate, and the endpoints say by how much (o3d-la3n r2)', () => {
  const up = linearFigureBoundFromUnplacedCredit([{ total: 12, positive: 12 }])
  const down = linearFigureBoundFromUnplacedCredit([{ total: -30, positive: 0 }])
  assert.equal(classifyLinearFigureBound(up), 'upper')
  assert.equal(classifyLinearFigureBound(down), 'lower')

  const both = sumLinearFigureBounds([up, down])
  assert.deepEqual({ ...both }, { lower: -12, upper: 30 })
  assert.equal(classifyLinearFigureBound(both), 'indeterminate')
  assert.equal(linearFigureBoundWidth(both), null, 'no single direction, so no single width')

  // A LOWER part beside an EXACT one stays determinate — and this is the case a verdict fold would
  // have to get from the same two marks it sees above if `exact` were mistaken for `upper`.
  const still = sumLinearFigureBounds([down, EXACT_LINEAR_FIGURE_BOUND])
  assert.deepEqual({ ...still }, { lower: 0, upper: 30 })
  assert.equal(classifyLinearFigureBound(still), 'lower')
})

test('ZERO-WIDTH intervals: at zero it is exact, away from zero it is a determinate relation (o3d-la3n r2)', () => {
  assert.deepEqual({ ...EXACT_LINEAR_FIGURE_BOUND }, { lower: 0, upper: 0 })
  assert.equal(classifyLinearFigureBound(EXACT_LINEAR_FIGURE_BOUND), 'exact')
  assert.equal(linearFigureBoundWidth(EXACT_LINEAR_FIGURE_BOUND), null, 'an exact figure has no width to disclose')
  assert.equal(classifyLinearFigureBound(linearFigureBoundFromUnplacedCredit([{ total: 0, positive: 0 }])), 'exact')

  // A zero-width interval AWAY from zero cannot be minted from credit parts — Σmax(e,0) = Σmin(e,0)
  // forces both to zero — so it is cast in here deliberately, to pin what the classifier does if a
  // future producer ever hands one over: the figure is known exactly and is NOT the published one,
  // so a relation is owed and `≤` is the true one.
  const pinned = { lower: -5, upper: -5 } as unknown as LinearFigureBoundInterval
  assert.equal(classifyLinearFigureBound(pinned), 'upper')
  assert.equal(linearFigureBoundWidth(pinned), 5)
})

test('the EMPTY subset sums to the exact identity, not to a wide interval (o3d-la3n r2)', () => {
  const empty = sumLinearFigureBounds([])
  assert.deepEqual({ ...empty }, { lower: 0, upper: 0 })
  assert.equal(classifyLinearFigureBound(empty), 'exact')
  assert.equal(boundSuffix(classifyLinearFigureBound(empty)), '', 'an empty filter shows a £0.00 total with no mark')
  // And it really is the identity for the fold.
  const one = linearFigureBoundFromUnplacedCredit([{ total: 7, positive: 7 }])
  assert.deepEqual({ ...sumLinearFigureBounds([one, empty]) }, { ...one })
})

test('non-finite and inverted intervals establish nothing (o3d-la3n r2)', () => {
  assert.equal(classifyLinearFigureBound({ lower: Number.NaN, upper: 0 } as unknown as LinearFigureBoundInterval), 'indeterminate')
  assert.equal(classifyLinearFigureBound({ lower: -Infinity, upper: 0 } as unknown as LinearFigureBoundInterval), 'indeterminate')
  assert.equal(classifyLinearFigureBound({ lower: 5, upper: -5 } as unknown as LinearFigureBoundInterval), 'indeterminate')
})

/**
 * THE BRAND. Round 1's docstring said "a RATIO is not covered — do not reach for this function
 * there", which is enforcement by comment. `LinearFigureBoundInterval` is now nominal: the ratio
 * classifier's answer is a verdict and not an interval, and a structurally identical hand-rolled
 * pair carries no brand, so neither can reach the fold. The `@ts-expect-error` directives BELOW are
 * the assertion — `tsc --noEmit` fails if either line stops being an error.
 */
test('a RATIO bound cannot reach the linear fold, and the legitimate route still does (o3d-la3n r2)', () => {
  // A real ratio verdict, from the real classifier, on the worked case that makes margin move the
  // other way: revenue 100, COGS 150, £120 of unplaced credit.
  const ratioVerdict: DerivedFigureBound = marginFigureBound({ netRevenue: 100, cogs: 150, unplacedCredit: collapsed(120), basisComplete: false })
  assert.equal(ratioVerdict, 'indeterminate', 'the ratio really is bounded differently from the linear figures beside it')

  // @ts-expect-error a ratio's VERDICT is not an interval; it carries no endpoints to add
  const foldRatioVerdict = () => sumLinearFigureBounds([ratioVerdict])
  // @ts-expect-error a hand-rolled pair is structurally identical and still refused: it is unbranded
  const foldRawPair = () => sumLinearFigureBounds([{ lower: 0, upper: 5 }])
  assert.equal(typeof foldRatioVerdict, 'function', 'both stay uncalled — the compiler is the assertion')
  assert.equal(typeof foldRawPair, 'function')

  // The only public way in is a mint from credit PARTS, which a ratio has none of to offer.
  const legitimate = sumLinearFigureBounds([linearFigureBoundFromUnplacedCredit([{ total: 5, positive: 5 }])])
  assert.equal(classifyLinearFigureBound(legitimate), 'upper')
  assert.equal(linearFigureBoundWidth(legitimate), 5)
})

/**
 * DISPLAY ROUNDING IS PART OF THE CLAIM (o3d-l4zz, folded into this branch).
 *
 * A figure that carries a relation is rounded in the direction of that relation. Nearest-cent
 * rounding is not relation-preserving: £0.024 to the nearest cent is £0.02, and "at most £0.02" is
 * false of £0.024.
 */
test('a bounded amount rounds in the direction its relation allows (o3d-la3n r2)', () => {
  assert.equal(roundBoundedAmountForDisplay(0.024, 'upper'), 0.03, 'a ceiling rounds UP')
  assert.equal(roundBoundedAmountForDisplay(0.024, 'lower'), 0.02, 'a floor rounds DOWN')
  assert.equal(roundBoundedAmountForDisplay(0.024, 'exact'), 0.02, 'and an unrelated figure rounds to nearest')
  assert.equal(roundBoundedAmountForDisplay(0.024, 'indeterminate'), 0.02, 'as does one claiming no relation')

  // The relation actually holds afterwards, which is the whole point.
  assert.ok(roundBoundedAmountForDisplay(0.024, 'upper') >= 0.024)
  assert.ok(roundBoundedAmountForDisplay(0.024, 'lower') <= 0.024)

  // Binary floating point: 0.14 * 100 is 14.000000000000002, and a bare ceil would publish £0.15.
  assert.equal(roundBoundedAmountForDisplay(0.14, 'upper'), 0.14)
  assert.equal(roundBoundedAmountForDisplay(0.29, 'upper'), 0.29)
  assert.equal(roundBoundedAmountForDisplay(-0.145, 'lower'), -0.15)
  assert.equal(roundBoundedAmountForDisplay(100, 'upper'), 100, 'an exact-cent figure is not nudged')
})

/**
 * THE SAME RULE OVER DECIMAL, AT THE PRECISION A PRODUCER PUBLISHES (o3d-rv4a r2, Codex round 2).
 *
 * `roundBoundedAmountForDisplay` covers the client half at two decimal places. `boundedFigureString`
 * is the producer half, and it is where the CEIL-versus-UP distinction actually bites: this report
 * publishes NEGATIVE bounded figures routinely now (a fully credited line shows minus its own cost as
 * margin), and `ROUND_UP` in decimal.js is away from zero, which moves a negative ceiling DOWN.
 */
test('a bounded figure string rounds toward its bound, including below zero (o3d-rv4a r2)', () => {
  // Positive: a ceiling goes up, a floor goes down, an unrelated figure goes to nearest.
  assert.equal(boundedFigureString('100.0000004', 'upper', 6), '100.000001')
  assert.equal(boundedFigureString('100.0000004', 'lower', 6), '100.000000')
  assert.equal(boundedFigureString('100.0000004', 'exact', 6), '100.000000')
  assert.equal(boundedFigureString('100.0000006', 'indeterminate', 6), '100.000001')

  // BELOW ZERO IS WHERE ROUND_UP AND ROUND_CEIL PART COMPANY, and only one of them is a bound.
  // -40.0000004 is at most -40.000000 and is NOT at most -40.000001; ROUND_UP (away from zero) would
  // publish the latter, which excludes the truth. ROUND_CEIL goes toward +infinity and is correct.
  assert.equal(boundedFigureString('-40.0000004', 'upper', 6), '-40.000000', 'a negative ceiling rounds TOWARD ZERO')
  assert.equal(boundedFigureString('-40.0000004', 'lower', 6), '-40.000001', 'a negative floor rounds AWAY from zero')
  for (const [value, bound, compare] of [
    ['100.0000004', 'upper', 'gte'],
    ['-40.0000004', 'upper', 'gte'],
    ['100.0000004', 'lower', 'lte'],
    ['-40.0000004', 'lower', 'lte'],
  ] as const) {
    const published = toDecimal(boundedFigureString(value, bound, 6))
    assert.ok(published[compare](toDecimal(value)), `${value} published as ${published.toString()} breaks its ${bound} bound`)
  }

  // The trimmed shape the ratio columns use, and the sign normalisation: a ceiling applied to a tiny
  // negative leaves decimal.js holding -0, and "-0.000000" reads as a signed figure to an operator.
  assert.equal(boundedFigureString('60.001', 'upper', 2, false), '60.01')
  assert.equal(boundedFigureString('60', 'exact', 2, false), '60')
  assert.equal(boundedFigureString('-0.0000001', 'upper', 6), '0.000000')
})
