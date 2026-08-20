import assert from 'node:assert/strict'
import test from 'node:test'

import {
  netOfRefunds,
  refundLineBucket,
  refundPctOfSale,
  refundSetBasis,
  refundTotalsBasis,
} from '../../../lib/domain/sales/refund-basis-analytics.ts'

/**
 * o3d-lvk (analytics half). The sales-stats reports subtracted refund totals from order totals
 * without asking what basis either was on. These tests pin the four cases the issue names —
 * taxable full refund, legacy gross, mixed, unknown — as SPECIFIC figures, because the failure
 * mode is a plausible-looking wrong number, not an exception.
 *
 * The worked example throughout is a £120 taxable order at 20%: £100 net + £20 VAT.
 */
const TAXABLE_ORDER = { totalBase: '120.00', taxBase: '20.00' }

// --- % of sale ------------------------------------------------------------------------------

test('a FULL net refund of a taxable order is 100% of the sale, not 83.3% (o3d-lvk)', () => {
  // £100 is the whole of that order's net value. Divided by the £120 GROSS total it reads as a
  // partial refund of something that was in fact refunded in full.
  assert.equal(refundPctOfSale('100.00', TAXABLE_ORDER, 'NET'), 100)
})

test('a legacy GROSS refund is measured against the GROSS order total (o3d-lvk)', () => {
  assert.equal(refundPctOfSale('120.00', TAXABLE_ORDER, 'GROSS'), 100)
  // ...and a half of it is a half, on its own basis.
  assert.equal(refundPctOfSale('60.00', TAXABLE_ORDER, 'GROSS'), 50)
})

test('an unproven basis yields NO percentage, not zero (o3d-lvk)', () => {
  // Zero would be read as "nothing was refunded" — the opposite of "we cannot say".
  assert.equal(refundPctOfSale('100.00', TAXABLE_ORDER, null), null)
})

test('a non-positive comparable total yields no percentage (o3d-lvk)', () => {
  assert.equal(refundPctOfSale('10.00', { totalBase: '0', taxBase: '0' }, 'NET'), null)
  // A fully-VAT order has no net value to take a proportion of.
  assert.equal(refundPctOfSale('10.00', { totalBase: '20.00', taxBase: '20.00' }, 'NET'), null)
})

// --- set basis ------------------------------------------------------------------------------

test('an unrecognised basis marker is UNKNOWN, never assumed NET (o3d-lvk)', () => {
  assert.equal(refundTotalsBasis('net'), 'UNKNOWN', 'case matters — this is a stored literal, not a guess')
  assert.equal(refundTotalsBasis(undefined), 'UNKNOWN')
  assert.equal(refundTotalsBasis('NET'), 'NET')
  assert.equal(refundTotalsBasis('GROSS'), 'GROSS')
})

test('an EXACTLY-zero refund carries no basis and does not spoil an otherwise unanimous set (o3d-lvk)', () => {
  assert.equal(
    refundSetBasis([{ totalsBasis: 'NET', totalBase: '100.00' }, { totalsBasis: null, totalBase: '0' }]),
    'NET',
  )
})

test('a SUB-PENNY unstamped refund does make the set unknown — dust is still value (o3d-lvk)', () => {
  // The mirror of classifyRefundBasis's own rule: an epsilon here would let unstamped fractions
  // accumulate into a material amount while the set still reported a clean basis.
  assert.equal(
    refundSetBasis([{ totalsBasis: 'NET', totalBase: '100.00' }, { totalsBasis: null, totalBase: '0.004' }]),
    'UNKNOWN',
  )
})

test('no refunds at all is NONE, which is not UNKNOWN (o3d-lvk)', () => {
  assert.equal(refundSetBasis([]), 'NONE')
})

// --- net of refunds (customer aging) ---------------------------------------------------------

test('aging: a full NET refund leaves nothing net of credits (o3d-lvk)', () => {
  // Under the old gross-minus-net subtraction this order still showed £20 of value after being
  // refunded in full — exactly the VAT.
  const result = netOfRefunds(TAXABLE_ORDER, [{ totalsBasis: 'NET', totalBase: '100.00' }])
  assert.equal(result.basis, 'NET')
  assert.equal(result.refundsTotal, 100)
  assert.equal(result.netTotal, 0)
})

test('aging: a legacy GROSS refund nets off the GROSS total (o3d-lvk)', () => {
  const result = netOfRefunds(TAXABLE_ORDER, [{ totalsBasis: 'GROSS', totalBase: '120.00' }])
  assert.equal(result.basis, 'GROSS')
  assert.equal(result.netTotal, 0)
})

test('aging: MIXED net and gross refunds make the net figure uncomputable, not approximate (o3d-lvk)', () => {
  // The o3d-w00 hazard in reporting form: £60 legacy gross + £60 new net is not £120 of anything.
  const result = netOfRefunds(TAXABLE_ORDER, [
    { totalsBasis: 'GROSS', totalBase: '60.00' },
    { totalsBasis: 'NET', totalBase: '60.00' },
  ])
  assert.equal(result.basis, 'UNKNOWN')
  assert.equal(result.netTotal, null, 'no number is offered')
  assert.equal(result.refundsTotal, 120, 'but the credit that exists is still reported')
})

test('aging: an UNPROVEN basis is uncomputable too (o3d-lvk)', () => {
  const result = netOfRefunds(TAXABLE_ORDER, [{ totalsBasis: null, totalBase: '100.00' }])
  assert.equal(result.basis, 'UNKNOWN')
  assert.equal(result.netTotal, null)
  assert.equal(result.refundsTotal, 100, 'the credit still exists, and how much of it there is was never in doubt')
})

/**
 * o3d-lvk round 2 proposed the opposite of the two assertions below: that a mixed or unproven set
 * should report `refundsTotal: null` too, with the money split into a `byBasis` triple, on the
 * grounds that 60 gross + 60 net is not 120 of any unit.
 *
 * o3d-iigc (PR #633) had already settled this the other way on `development`, and its rule stands:
 * a figure that cannot be stated on a consistent basis PUBLISHES NOTHING — which `netTotal` above
 * does — WHILE STILL SHOWING THE CREDIT TOTAL, because how much credit exists is not in doubt. Only
 * the *comparison* with the sale is unavailable, and withholding the credit total too would hide a
 * real, known, wholly unambiguous sum of money from the operator looking for it.
 *
 * The two tests below are round 2's, rewritten to that rule. What they were really pinning — that
 * a unanimous set is unaffected, and that dust is still value — is untouched by the disagreement,
 * so it is kept rather than lost with the design it arrived in.
 */
test('aging: a unanimous set is unaffected — the null is scoped to sets with no single basis (o3d-lvk)', () => {
  // This is what stops the rule degrading every ordinary refunded order to "unknown".
  const net = netOfRefunds(TAXABLE_ORDER, [
    { totalsBasis: 'NET', totalBase: '40.00' },
    { totalsBasis: 'NET', totalBase: '35.00' },
  ])
  assert.equal(net.basis, 'NET')
  assert.equal(net.refundsTotal, 75)
  assert.equal(net.netTotal, 25, 'the EX-VAT total (120 - 20) less 75')

  const gross = netOfRefunds(TAXABLE_ORDER, [{ totalsBasis: 'GROSS', totalBase: '12.00' }])
  assert.equal(gross.basis, 'GROSS')
  assert.equal(gross.refundsTotal, 12)
  assert.equal(gross.netTotal, 108, 'the VAT-inclusive total less 12')
})

test('aging: a zero row vetoes nothing, but sub-penny dust still unknowns the NET figure (o3d-lvk)', () => {
  // refundSetBasis skips exactly-zero rows — zero is the same amount on either basis, so it carries
  // no basis information. Its sub-penny sibling is not zero, and must not be treated as though it
  // were: an epsilon here would let unstamped dust accumulate into a material amount while the set
  // still reported a clean basis.
  const zero = netOfRefunds(TAXABLE_ORDER, [
    { totalsBasis: 'NET', totalBase: '100.00' },
    { totalsBasis: null, totalBase: '0' },
  ])
  assert.equal(zero.basis, 'NET')
  assert.equal(zero.refundsTotal, 100, 'a zero row carries no basis information and vetoes nothing')
  assert.equal(zero.netTotal, 0, 'and the net-of-credits figure is still computable')

  const dust = netOfRefunds(TAXABLE_ORDER, [
    { totalsBasis: 'NET', totalBase: '100.00' },
    { totalsBasis: null, totalBase: '0.004' },
  ])
  assert.equal(dust.basis, 'UNKNOWN', 'four tenths of a penny on an unproven basis is still value')
  assert.equal(dust.netTotal, null, 'so the figure that mixes bases is withheld')
  assert.equal(dust.refundsTotal, 100, 'while the credit itself is reported, rounded once at the end')
})

test('aging: an order with no refunds is untouched by any of this (o3d-lvk)', () => {
  const result = netOfRefunds(TAXABLE_ORDER, [])
  assert.equal(result.basis, 'NONE')
  assert.equal(result.refundsTotal, 0)
  assert.equal(result.netTotal, 120, 'the gross invoice total, unchanged')
})

test('aging: refund totals are summed in Decimal, so a half-penny rounds up (o3d-lvk)', () => {
  // Float would compute 1.005 * 100 as 100.49999999999999 and round the credit DOWN to 1.00.
  const result = netOfRefunds({ totalBase: '10.00', taxBase: '0' }, [
    { totalsBasis: 'NET', totalBase: '1.005' },
  ])
  assert.equal(result.refundsTotal, 1.01)
  // 10.00 - 1.005 = 8.995, rounded ONCE at the end = 9.00. Rounding the credit first and then
  // subtracting would give 8.99 — the two differ by a penny, which is the whole point of rounding
  // last rather than per intermediate.
  assert.equal(result.netTotal, 9)
})

// --- product sales stats bucketing -----------------------------------------------------------

test('products: only a NET refund line is subtracted from net revenue (o3d-lvk)', () => {
  // Product revenue is built from ex-VAT line totals, so this is the only comparable unit.
  assert.deepEqual(
    refundLineBucket('NET', '12.50'),
    { bucket: 'net', placeableOnNetBasis: true },
  )
})

test('products: a GROSS refund line is bucketed apart and marks the row incomplete (o3d-lvk)', () => {
  // Folding it into `refunds` would over-subtract by its VAT; folding it in silently is what the
  // report used to do.
  assert.deepEqual(
    refundLineBucket('GROSS', '15.00'),
    { bucket: 'gross', placeableOnNetBasis: false },
  )
})

test('products: an unproven basis is bucketed as unknown, never as net (o3d-lvk)', () => {
  assert.deepEqual(
    refundLineBucket(null, '12.50'),
    { bucket: 'unknown', placeableOnNetBasis: false },
  )
})

test('products: an exactly-zero line of unknown basis does not mark the row incomplete (o3d-lvk)', () => {
  // Zero is identical on both bases, so it cannot bias net revenue in either direction.
  assert.deepEqual(
    refundLineBucket(null, '0'),
    { bucket: 'unknown', placeableOnNetBasis: true },
  )
  // ...but a sub-penny one can, and does.
  assert.equal(refundLineBucket(null, '0.004').placeableOnNetBasis, false)
})
