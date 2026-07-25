import assert from 'node:assert/strict'
import test from 'node:test'

import { planCorrection } from '../../scripts/backfill-wc-coupon-order-discount'

/**
 * The o3d-y14 backfill clears a duplicated coupon off legacy WooCommerce orders. Every decision it makes
 * destroys money if it is wrong — a discount cleared that was genuine, or a queued invoice left carrying
 * the duplicate — so the decisions are a pure function and these are the cases that matter.
 *
 * What is NOT decided here, deliberately: WHICH orders are legacy. planCorrection assumes its input is a
 * pre-fix row, because on a corrected row the same arithmetic would subtract the line discounts a second
 * time (10 -> 6 -> 2 -> 0 over three runs). That is the caller's job, and it uses two independent guards:
 * a REQUIRED --before cutoff and an ActivityLog marker per corrected order.
 */

test('a fully allocated coupon is cleared from the order-level slot', () => {
  // The classic: £10 coupon, all £10 of it already on the lines. The order-level copy is pure duplicate.
  const plan = planCorrection({ couponTotal: 10, lineDiscountTotal: 10, jobs: [] })
  assert.ok(plan)
  assert.equal(plan.keptOrderLevel, 0)
  assert.equal(plan.clearedBy, 10)
})

test('a partially allocated coupon keeps its residual', () => {
  // Only £4 reached the lines, so £6 is genuine order-level money and must survive.
  const plan = planCorrection({ couponTotal: 10, lineDiscountTotal: 4, jobs: [] })
  assert.ok(plan)
  assert.equal(plan.keptOrderLevel, 6)
  assert.equal(plan.clearedBy, 4)
})

test('an order the lines carry nothing of is left completely alone', () => {
  // Nothing is duplicated here — this is what a native-shaped order-level discount looks like, and
  // touching it would erase a real discount.
  assert.equal(planCorrection({ couponTotal: 10, lineDiscountTotal: 0, jobs: [] }), null)
})

test('a rerun over an ALREADY-CORRECTED order would eat the residual — which is why the caller must exclude it', () => {
  // Run 1 leaves 6. Feeding that 6 back in produces 2, then 0: the erosion the marker and the cutoff
  // exist to prevent. Pinned here so nobody "simplifies" those guards away believing the arithmetic is
  // self-correcting.
  const first = planCorrection({ couponTotal: 10, lineDiscountTotal: 4, jobs: [] })
  assert.equal(first?.keptOrderLevel, 6)
  const second = planCorrection({ couponTotal: 6, lineDiscountTotal: 4, jobs: [] })
  assert.equal(second?.keptOrderLevel, 2, 'NOT idempotent by arithmetic — idempotence comes from the marker')
})

test('queued SALES_INVOICE payloads are collected for patching', () => {
  // The processors post from the payload SNAPSHOT and never re-read the order, so a PENDING or retryable
  // FAILED job would still post the duplicated coupon after the order itself was corrected.
  const plan = planCorrection({
    couponTotal: 10,
    lineDiscountTotal: 10,
    jobs: [{ id: 'job-pending', status: 'PENDING' }, { id: 'job-failed', status: 'FAILED' }],
  })
  assert.ok(plan)
  assert.deepEqual(plan.staleJobIds, ['job-pending', 'job-failed'])
  assert.equal(plan.blockedByProcessing, false)
})

test('an order with a job mid-post is BLOCKED, not corrected', () => {
  // A worker is posting right now and the outcome is unknowable from here: it may already have read the
  // old payload. Correcting the order would report success over an invoice about to be understated.
  const plan = planCorrection({
    couponTotal: 10,
    lineDiscountTotal: 10,
    jobs: [{ id: 'job-live', status: 'PROCESSING' }, { id: 'job-pending', status: 'PENDING' }],
  })
  assert.ok(plan)
  assert.equal(plan.blockedByProcessing, true)
  assert.deepEqual(plan.staleJobIds, ['job-pending'], 'the PROCESSING one is never patched underneath its worker')
})
