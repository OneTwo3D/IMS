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

test('a { success:false } reallocation (the swallowed-failure case) also warns (o3d-67y)', async () => {
  // autoAllocateOrder converts its own failures to { success:false } — the exact result that used to be
  // discarded. It must be treated as a failure, not silent success.
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false, error: 'insufficient stock' }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-3', status: 'ALLOCATED' }, deps)

  assert.deepEqual(outcome, { released: false, warned: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].description, /insufficient stock/)
})

test('a { success:false } with no error message still warns with a fallback reason (o3d-67y)', async () => {
  const { deps, warnings } = makeDeps({ allocate: async () => ({ success: false }) })
  const outcome = await releaseReservationsAfterRefund({ orderId: 'so-4', status: 'PROCESSING' }, deps)
  assert.equal(outcome.warned, true)
  assert.match(warnings[0].description, /success:false/)
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
