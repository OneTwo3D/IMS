import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import {
  scheduleRefundReservationReleaseOutbox,
  processRefundReservationReleaseOutbox,
  resolveRefundReservationReleaseOutbox,
  refundReleaseEligible,
  REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
  REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
  type RefundReservationReleaseDrainDeps,
  type ReleaseAllocationResult,
} from '@/lib/domain/sales/refund-reservation-release-outbox'

type CreatedRow = { data: Record<string, unknown> }

function fakeTx() {
  const created: CreatedRow[] = []
  const tx = {
    integrationOutbox: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push({ data: args.data })
        return args.data as never
      },
      findUnique: async () => null,
    },
  } as unknown as Prisma.TransactionClient
  return { tx, created }
}

test('refundReleaseEligible accepts every allocated, not-yet-shipped status (incl PICKING/PACKING)', () => {
  assert.equal(refundReleaseEligible('PROCESSING'), true)
  assert.equal(refundReleaseEligible('ALLOCATED'), true)
  assert.equal(refundReleaseEligible('PICKING'), true)
  assert.equal(refundReleaseEligible('PACKING'), true)
  assert.equal(refundReleaseEligible('DRAFT'), false)
  assert.equal(refundReleaseEligible('PENDING_PAYMENT'), false)
  assert.equal(refundReleaseEligible('ON_HOLD'), false)
  assert.equal(refundReleaseEligible('SHIPPED'), false)
  assert.equal(refundReleaseEligible('DELIVERED'), false)
  assert.equal(refundReleaseEligible('CANCELLED'), false)
})

test('resolve marks a still-open backstop row SUCCEEDED so the drain does not re-run allocation', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    integrationOutbox: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.push(args)
        return { count: 1 }
      },
    },
  }
  const count = await resolveRefundReservationReleaseOutbox('refund-9', { client })
  assert.equal(count, 1)
  assert.equal(calls.length, 1)
  const where = calls[0].where as Record<string, unknown>
  assert.equal(where.connector, REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR)
  assert.equal(where.operation, REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION)
  assert.match(String(where.idempotencyKey), /refund-9/)
  // Only PENDING / RETRYABLE_FAILED rows are resolved — never one the drain already claimed (PROCESSING).
  assert.deepEqual((where.status as { in: string[] }).in, ['PENDING', 'RETRYABLE_FAILED'])
  assert.equal((calls[0].data as Record<string, unknown>).status, 'SUCCEEDED')
})

test('schedule enqueues a backstop row inside the tx for an eligible order', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundReservationReleaseOutbox(
    tx,
    { orderId: 'order-1', refundId: 'refund-1', status: 'ALLOCATED' },
    { now: new Date('2026-07-22T00:00:00.000Z') },
  )
  assert.equal(created.length, 1)
  const { data } = created[0]
  assert.equal(data.connector, REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR)
  assert.equal(data.operation, REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION)
  assert.equal(data.status, 'PENDING')
  assert.deepEqual(data.payloadJson, { orderId: 'order-1', refundId: 'refund-1' })
  // Idempotency key is per-refund so a replayed refund dedups.
  assert.match(String(data.idempotencyKey), /refund-1/)
  // Grace delay pushes the first drain past the immediate release.
  assert.ok(data.nextAttemptAt instanceof Date && (data.nextAttemptAt as Date).getTime() > new Date('2026-07-22T00:00:00.000Z').getTime())
})

test('schedule is a no-op for a non-release-eligible order status', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundReservationReleaseOutbox(tx, { orderId: 'order-1', refundId: 'refund-1', status: 'DRAFT' })
  assert.equal(created.length, 0)
})

// ---- drain classification ---------------------------------------------------

type Recorded = { successIds: string[]; retryIds: string[] }

function drainDeps(
  jobs: Array<{ id: string; attempts: number; lockedAt: Date | null; payloadJson: unknown }>,
  allocate: (orderId: string) => Promise<ReleaseAllocationResult>,
  recorded: Recorded,
): RefundReservationReleaseDrainDeps {
  return {
    claimWork: (async () => jobs) as unknown as RefundReservationReleaseDrainDeps['claimWork'],
    allocate,
    markSuccess: async ({ id }) => { recorded.successIds.push(id) },
    markRetry: async ({ id }) => { recorded.retryIds.push(id) },
  }
}

const job = (id: string, over: Partial<{ attempts: number; lockedAt: Date | null; payloadJson: unknown }> = {}) => ({
  id,
  attempts: over.attempts ?? 0,
  // Explicit 'in' check: `?? default` would coerce an intentional null lock back to a date.
  lockedAt: 'lockedAt' in over ? (over.lockedAt as Date | null) : new Date('2026-07-22T00:00:00.000Z'),
  payloadJson: over.payloadJson ?? { orderId: `order-${id}`, refundId: `refund-${id}` },
})

test('drain: a successful release marks the job SUCCEEDED', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  const deps = drainDeps([job('a')], async () => ({ success: true }), recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.successIds, ['a'])
  assert.deepEqual(recorded.retryIds, [])
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 })
})

test('drain: a shipment refuse (success:false, not failed) completes the job — reservedQty is consistent', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  const deps = drainDeps(
    [job('a')],
    async () => ({ success: false, error: 'Order has existing shipments; reallocation refused' }),
    recorded,
  )
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.successIds, ['a'])
  assert.deepEqual(recorded.retryIds, [])
})

test('drain: a rolled-back allocation transaction (failed:true) retries with backoff', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  const deps = drainDeps([job('a')], async () => ({ success: false, failed: true, error: 'deadlock' }), recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
  assert.equal(result.failed, 1)
})

test('drain: a thrown allocate (or malformed payload) retries', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  const deps = drainDeps([job('a')], async () => { throw new Error('boom') }, recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
})

test('drain: a malformed payload retries, it is not silently marked succeeded', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  const deps = drainDeps(
    [job('a', { payloadJson: { orderId: '' } })],
    async () => ({ success: true }),
    recorded,
  )
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
})

test('drain: a job with no lock is skipped, never actioned', async () => {
  const recorded: Recorded = { successIds: [], retryIds: [] }
  let allocateCalls = 0
  const deps = drainDeps([job('a', { lockedAt: null })], async () => { allocateCalls++; return { success: true } }, recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.equal(allocateCalls, 0)
  assert.deepEqual(recorded.successIds, [])
  assert.deepEqual(recorded.retryIds, [])
  assert.equal(result.failed, 1)
})
