import assert from 'node:assert/strict'
import test from 'node:test'

import { marginFigureBound, marginFigureBoundDecimal, netLinearFigureBound, netLinearFigureBoundDecimal, shareFigureBound, boundSuffix } from '@/lib/domain/sales/refund-basis-analytics'

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

// ---------------------------------------------------------------------------
// The figures that move one-for-one — the argument rounds 1-3 made, which holds for these
// ---------------------------------------------------------------------------

test('linear figures: a complete basis is exact, an incomplete one is a genuine upper bound (o3d-iigc r4)', () => {
  assert.equal(netLinearFigureBound({ basisComplete: true, unplacedCredit: 0 }), 'exact')
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: 120 }), 'upper')
})

test('linear figures: EXISTENCE comes from the flag, not the amount — a sub-penny credit still bounds (o3d-iigc r4)', () => {
  // The producers round their reported bucket totals to 2dp, so a £0.004 unstamped credit reports
  // as £0.00 while `refundBasisComplete` stays false. Reading existence off the amount would
  // publish that row as EXACT — a claim about a figure we just said we could not place.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: 0 }), 'upper')
  assert.equal(
    marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: 0, basisComplete: false }),
    'upper',
  )
})

test('linear figures: a NEGATIVE unplaced credit would bound the other way, so it is not marked ≤ (o3d-iigc r4)', () => {
  // Not reachable today — the buckets are fed only by refund lines carrying a productId, and the one
  // refund line that is negative by construction (the mirrored order-discount line) carries none —
  // but the classification does not depend on that holding.
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: -5 }), 'indeterminate')
  assert.equal(
    marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: -5, basisComplete: false }),
    'indeterminate',
  )
})

// ---------------------------------------------------------------------------
// Margin — the four branches
// ---------------------------------------------------------------------------

test('margin: a complete basis is exact and carries NO mark (o3d-iigc r4 control)', () => {
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: 0, basisComplete: true }), 'exact')
  // And the control is not vacuous: the SAME numbers with the flag flipped are marked.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: 0, basisComplete: false }), 'upper')
})

test('margin case 3: the whole interval of possible revenues stays positive, so ≤ holds (o3d-iigc r4)', () => {
  // £1,000 net revenue, £400 COGS, £120 of credit that could not be placed. The true revenue is
  // somewhere in [880, 1000], all positive, and m rises with t when COGS is positive:
  //   m(1000) = 100*(1 - 400/1000) = 60.0%   <- published
  //   m(880)  = 100*(1 - 400/880)  = 54.5%   <- the loosest the truth can be
  // 54.5 <= 60.0, so the published figure really is a ceiling.
  assert.equal(marginFigureBound({ netRevenue: 1000, cogs: 400, unplacedCredit: 120, basisComplete: false }), 'upper')
})

test('margin case 4a: the interval straddles zero but the published margin is positive — still ≤ (o3d-iigc r4)', () => {
  // £100 net revenue, £40 COGS, a £120 gross credit. The true revenue could be as low as -£20, where
  // the report's own guard prints 0%. Published is 100*(1 - 40/100) = 60%, and every reachable value
  // — 0% from the guard, and everything below 60% for a positive revenue — is at most that.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: 120, basisComplete: false }), 'upper')
})

test('margin case 4b: COGS above net revenue makes ≤ A FALSE CLAIM — the finding (o3d-iigc r4)', () => {
  // THE COUNTEREXAMPLE. £100 net revenue (ex-VAT), £150 COGS, and a £120 gross-basis credit that
  // could not be placed.
  //   published: m(100) = 100*(1 - 150/100) = -50.0%
  //   place the credit at its £100 ex-VAT value and net revenue is 0, where the guard prints 0.0%
  //   0.0% is NOT "at most -50.0%".
  // Round 3 marked this `≤`. It is not a bound in that direction at all.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 150, unplacedCredit: 120, basisComplete: false }), 'indeterminate')

  // And the boundary is exactly `netRevenue >= cogs`, not a hand-wave: at COGS 100 the published
  // margin is 0%, which the guard's 0% ties rather than exceeds.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 100, unplacedCredit: 120, basisComplete: false }), 'upper')
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 100.01, unplacedCredit: 120, basisComplete: false }), 'indeterminate')
})

test('margin case 1: a NEGATIVE COGS inverts the direction entirely (o3d-iigc r4)', () => {
  // m'(t) = c/t², so with c < 0 the margin RISES as revenue falls: at revenue 1000 and COGS -100,
  //   m(1000) = 100*(1 + 100/1000) = 110.0%   <- published
  //   m(900)  = 100*(1 + 100/900)  = 111.1%   <- higher than the "upper bound"
  // The published figure is a LOWER bound here, so `≤` is again the wrong relation.
  assert.equal(marginFigureBound({ netRevenue: 1000, cogs: -100, unplacedCredit: 120, basisComplete: false }), 'indeterminate')
})

test('margin case 2: a non-positive net revenue pins both readings to the guard, so it is EXACT (o3d-iigc r4)', () => {
  // The true revenue can only be lower than the published one, and the guard already prints 0% for
  // everything at or below zero. Both readings are 0%, so marking this would OVERSTATE the
  // uncertainty — the failure mode in the other direction.
  assert.equal(marginFigureBound({ netRevenue: 0, cogs: 40, unplacedCredit: 120, basisComplete: false }), 'exact')
  assert.equal(marginFigureBound({ netRevenue: -30, cogs: 40, unplacedCredit: 120, basisComplete: false }), 'exact')
})

test('a non-finite CREDIT is never silently classified as a bound (o3d-iigc r4)', () => {
  // The load-bearing input is the credit, not the revenue: a NaN or infinite revenue already fails
  // every comparison below and lands on `indeterminate` anyway, whereas a NaN credit makes
  // `netRevenue - unplacedCredit > 0` merely FALSE, which without the guard falls through to the
  // case-4 test and publishes `upper` — a bound asserted from an amount that is not a number.
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: Number.NaN, basisComplete: false }), 'indeterminate')
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: Number.POSITIVE_INFINITY, basisComplete: false }), 'indeterminate')
  assert.equal(netLinearFigureBound({ basisComplete: false, unplacedCredit: Number.NaN }), 'indeterminate')

  // And with a real credit the same shape IS a bound, so the assertion is not merely "always refuse".
  assert.equal(marginFigureBound({ netRevenue: 100, cogs: 40, unplacedCredit: 120, basisComplete: false }), 'upper')
})

// ---------------------------------------------------------------------------
// The mark itself
// ---------------------------------------------------------------------------

test('the suffix distinguishes the three claims, and ? is deliberately not ≤ (o3d-iigc r4)', () => {
  assert.equal(boundSuffix('exact'), '')
  assert.equal(boundSuffix('upper'), ' ≤')
  assert.equal(boundSuffix('indeterminate'), ' ?')
  assert.notEqual(boundSuffix('indeterminate'), boundSuffix('upper'))
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
    const linearNumber = netLinearFigureBound({ basisComplete: input.basisComplete, unplacedCredit: input.unplacedCredit })
    const linearDecimal = netLinearFigureBoundDecimal({ basisComplete: input.basisComplete, unplacedCredit: input.unplacedCredit })
    assert.equal(linearDecimal, linearNumber, `linear disagreed on ${JSON.stringify(input)}`)
    linear.add(linearNumber)
    const marginNumber = marginFigureBound(input)
    const marginDecimal = marginFigureBoundDecimal(input)
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
