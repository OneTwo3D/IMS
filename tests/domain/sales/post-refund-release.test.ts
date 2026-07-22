import assert from 'node:assert/strict'
import test from 'node:test'

import { releaseReservationsAfterRefund, type PostRefundReleaseDeps } from '@/lib/domain/sales/post-refund-release'

type LoggedWarning = Parameters<PostRefundReleaseDeps['log']>[0]

function makeDeps(overrides: Partial<PostRefundReleaseDeps> = {}) {
  const warnings: LoggedWarning[] = []
  const deps: PostRefundReleaseDeps = {
    allocate: async () => ({ success: true, committed: true }),
    log: async (params) => { warnings.push(params); return undefined },
    onError: () => {},
    ...overrides,
  }
  return { deps, warnings }
}

test('a committed release warns nobody and is reconciled (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: true, committed: true }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-1', eligible: true }, deps)
  assert.deepEqual(outcome, { released: true, warned: false, refused: false, reconciled: true })
  assert.equal(warnings.length, 0)
})

test('an ineligible order (no allocations) is a no-op — allocation never re-runs (o3d-67y r3)', async () => {
  let allocateCalls = 0
  const { deps, warnings } = makeDeps({ allocate: async () => { allocateCalls++; return { success: true, committed: true } } })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-0', eligible: false }, deps)
  assert.deepEqual(outcome, { released: false, warned: false, refused: false, reconciled: false })
  assert.equal(allocateCalls, 0)
  assert.equal(warnings.length, 0)
})

test('a THROWN reallocation records a WARNING and is NOT reconciled — the backstop stays pending (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => { throw new Error('lock timeout') } })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-2', refundId: 'r-2', eligible: true }, deps)

  assert.deepEqual(outcome, { released: false, warned: true, refused: false, reconciled: false })
  assert.equal(warnings.length, 1, 'the failure is visible, not a discarded console line')
  const w = warnings[0]
  assert.equal(w.level, 'WARNING')
  assert.equal(w.entityId, 'so-2')
  assert.equal(w.action, 'refund_reservation_release_failed')
  assert.match(w.description, /lock timeout/)
})

test('a genuine transaction FAILURE (failed:true) warns and is NOT reconciled (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, failed: true, error: 'deadlock detected' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-3', eligible: true }, deps)

  assert.deepEqual(outcome, { released: false, warned: true, refused: false, reconciled: false })
  assert.match(warnings[0].description, /deadlock detected/)
})

test('a committed backorder (success:false, committed:true) does NOT warn and IS reconciled (o3d-67y)', async () => {
  // The allocation transaction committed (released the refunded units, could not re-reserve every remaining
  // non-oversell unit). reservedQty is correct, so no warning and the backstop can be resolved.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, committed: true, error: 'insufficient stock' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-3b', eligible: true }, deps)

  assert.deepEqual(outcome, { released: false, warned: false, refused: false, reconciled: true })
  assert.equal(warnings.length, 0)
})

test('a shipment refuse (refused:true) surfaces a deferral WARNING but IS reconciled (o3d-67y r2)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, refused: true, committed: false }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-4', refundId: 'r-4', eligible: true }, deps)
  assert.deepEqual(outcome, { released: false, warned: true, refused: true, reconciled: true })
  assert.equal(warnings[0].action, 'refund_reservation_release_deferred')
  assert.match(warnings[0].description, /shipment/i)
})

test('a pre-transaction bail (not committed/refused/failed) warns and is NOT reconciled — the backstop retries (o3d-67y r3)', async () => {
  // e.g. no eligible warehouse: allocation returns success:false without committing. reservedQty is untouched,
  // so this must NOT be treated as a completed release — surface it and leave the backstop pending.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, committed: false, error: 'No stock available for allocation' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-6', refundId: 'r-6', eligible: true }, deps)
  assert.deepEqual(outcome, { released: false, warned: true, refused: false, reconciled: false })
  assert.equal(warnings[0].action, 'refund_reservation_release_failed')
  assert.match(warnings[0].description, /could not run|bailed/i)
})

test('a failure to WRITE the warning never throws — a committed refund must not be reverted (o3d-67y)', async () => {
  const { deps } = makeDeps({
    allocate: async () => { throw new Error('boom') },
    log: async () => { throw new Error('activity log DB down') },
  })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-5', eligible: true }, deps)
  assert.deepEqual(outcome, { released: false, warned: true, refused: false, reconciled: false })
})
