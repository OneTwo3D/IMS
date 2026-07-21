import assert from 'node:assert/strict'
import test from 'node:test'

import { releaseReservationsAfterRefund, type PostRefundReleaseDeps } from '@/lib/domain/sales/post-refund-release'

type LoggedWarning = Parameters<PostRefundReleaseDeps['log']>[0]

function makeDeps(overrides: Partial<PostRefundReleaseDeps> = {}) {
  const warnings: LoggedWarning[] = []
  const deps: PostRefundReleaseDeps = {
    allocate: async () => ({ success: true }),
    log: async (params) => { warnings.push(params); return undefined },
    onError: () => {},
    ...overrides,
  }
  return { deps, warnings }
}

test('a successful release warns nobody (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: true }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-1', status: 'ALLOCATED' }, deps)
  assert.deepEqual(outcome, { released: true, warned: false })
  assert.equal(warnings.length, 0)
})

test('a THROWN reallocation records a resolvable WARNING instead of stranding the reservation silently (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => { throw new Error('lock timeout') } })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-2', refundId: 'r-2', status: 'PROCESSING' }, deps)

  assert.deepEqual(outcome, { released: false, warned: true })
  assert.equal(warnings.length, 1, 'the failure is durable + visible, not a discarded console line')
  const w = warnings[0]
  assert.equal(w.level, 'WARNING')
  assert.equal(w.entityType, 'SALES_ORDER')
  assert.equal(w.entityId, 'so-2')
  assert.equal(w.action, 'refund_reservation_release_failed')
  assert.match(w.description, /so-2/)
  assert.match(w.description, /lock timeout/)
  assert.deepEqual(w.metadata, { orderId: 'so-2', refundId: 'r-2', error: 'Error: lock timeout' })
})

test('a genuine transaction FAILURE (failed:true) warns (o3d-67y)', async () => {
  // autoAllocateOrder sets failed:true only when its transaction threw and rolled back — reservations are
  // stale, so this is the real stranding case that must be surfaced.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, failed: true, error: 'deadlock detected' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-3', status: 'ALLOCATED' }, deps)

  assert.deepEqual(outcome, { released: false, warned: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].description, /deadlock detected/)
})

test('a committed backorder/shortage (success:false, NOT failed) does NOT warn — reservations are consistent (o3d-67y)', async () => {
  // The allocation transaction committed (it released the refunded units, just could not re-reserve every
  // remaining non-oversell unit). Reservations are correct, so a stale-reservation warning would be a false
  // alarm telling the operator to re-run allocation pointlessly.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, error: 'insufficient stock' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-3b', status: 'ALLOCATED' }, deps)

  assert.deepEqual(outcome, { released: false, warned: false })
  assert.equal(warnings.length, 0, 'a committed shortage is not a stranded reservation')
})

test('an expected refuseIfShipmentsExist no-op (success:false, NOT failed) does NOT warn (o3d-67y)', async () => {
  // A refund on an allocated order that already has shipments: the caller passes refuseIfShipmentsExist, so
  // autoAllocateOrder returns success:false WITHOUT failed. The shipment build caps shippable qty net of
  // refunds, so nothing is stranded.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-4', status: 'PROCESSING' }, deps)
  assert.deepEqual(outcome, { released: false, warned: false })
  assert.equal(warnings.length, 0)
})

test('non-eligible statuses are a no-op — a refund never promotes DRAFT/PENDING_PAYMENT (o3d-67y)', async () => {
  for (const status of ['DRAFT', 'PENDING_PAYMENT', 'SHIPPED', 'CANCELLED']) {
    let allocateCalls = 0
    const { deps, warnings } = makeDeps({ allocate: async () => { allocateCalls++; return { success: true } } })
    const outcome = await releaseReservationsAfterRefund({ orderId: 'so-x', status }, deps)
    assert.deepEqual(outcome, { released: false, warned: false }, `status ${status} is a no-op`)
    assert.equal(allocateCalls, 0, `status ${status} does not re-run allocation`)
    assert.equal(warnings.length, 0)
  }
})

test('a failure to WRITE the warning never throws — a committed refund must not be reverted (o3d-67y)', async () => {
  const { deps } = makeDeps({
    allocate: async () => { throw new Error('boom') },
    log: async () => { throw new Error('activity log DB down') },
  })
  // Must resolve (warned:true), NOT reject — the caller's outer catch would otherwise mis-handle a committed
  // refund as failed.
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-5', status: 'ALLOCATED' }, deps)
  assert.deepEqual(outcome, { released: false, warned: true })
})
