import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import {
  scheduleRefundReservationReleaseOutbox,
  processRefundReservationReleaseOutbox,
  resolveRefundReservationReleaseOutbox,
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

test('schedule enqueues a backstop row inside the tx when the order holds allocations', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundReservationReleaseOutbox(
    tx,
    { orderId: 'order-1', refundId: 'refund-1', eligible: true },
    { now: new Date('2026-07-22T00:00:00.000Z') },
  )
  assert.equal(created.length, 1)
  const { data } = created[0]
  assert.equal(data.connector, REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR)
  assert.equal(data.operation, REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION)
  assert.equal(data.status, 'PENDING')
  assert.deepEqual(data.payloadJson, { orderId: 'order-1', refundId: 'refund-1' })
  assert.match(String(data.idempotencyKey), /refund-1/)
  assert.ok(data.nextAttemptAt instanceof Date && (data.nextAttemptAt as Date).getTime() > new Date('2026-07-22T00:00:00.000Z').getTime())
})

test('schedule is a no-op when the order holds no allocations (eligible:false)', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundReservationReleaseOutbox(tx, { orderId: 'order-1', refundId: 'refund-1', eligible: false })
  assert.equal(created.length, 0)
})

// ---- drain classification ---------------------------------------------------

type Recorded = { successIds: string[]; retryIds: string[]; deferrals: Array<{ orderId: string; refundId: string }> }

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
    logDeferral: async ({ orderId, refundId }) => { recorded.deferrals.push({ orderId, refundId }) },
  }
}

const emptyRecorded = (): Recorded => ({ successIds: [], retryIds: [], deferrals: [] })

const job = (id: string, over: Partial<{ attempts: number; lockedAt: Date | null; payloadJson: unknown }> = {}) => ({
  id,
  attempts: over.attempts ?? 0,
  // Explicit 'in' check: `?? default` would coerce an intentional null lock back to a date.
  lockedAt: 'lockedAt' in over ? (over.lockedAt as Date | null) : new Date('2026-07-22T00:00:00.000Z'),
  payloadJson: over.payloadJson ?? { orderId: `order-${id}`, refundId: `refund-${id}` },
})

test('drain: a committed release marks the job SUCCEEDED', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: true, committed: true }), recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.successIds, ['a'])
  assert.deepEqual(recorded.retryIds, [])
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 })
})

test('drain: a committed backorder (success:false, committed:true) completes the job', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, committed: true }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.successIds, ['a'])
  assert.deepEqual(recorded.retryIds, [])
})

test('drain: a shipment refuse (refused:true, not committed) RETRIES — never silently succeeded (o3d-67y r4)', async () => {
  // Refuse does not reconcile reservedQty (stale allocation rows remain), so it must NOT be marked SUCCEEDED —
  // it retries and dead-letters visibly as a durable record for shipment reconciliation (o3d-339).
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, refused: true, committed: false }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
})

test('drain: a first-attempt refuse writes the order-scoped deferral WARNING (crash-bypass visibility, o3d-67y r5)', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a', { attempts: 0 })], async () => ({ success: false, refused: true, committed: false }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.deferrals, [{ orderId: 'order-a', refundId: 'refund-a' }])
})

test('drain: a retried refuse (attempts>0) does NOT re-log the deferral WARNING — logged once per refund', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a', { attempts: 2 })], async () => ({ success: false, refused: true, committed: false }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.deferrals, [])
})

test('drain: a non-refuse failure does NOT write a deferral WARNING', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, failed: true, committed: false }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.deferrals, [])
})

test('drain: a rolled-back allocation transaction (failed:true) retries with backoff', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, failed: true, committed: false, error: 'deadlock' }), recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
  assert.equal(result.failed, 1)
})

test('drain: a pre-transaction bail (not committed, not refused, not failed) RETRIES — never silently succeeded (o3d-67y r3)', async () => {
  // e.g. no eligible warehouse: allocation returns success:false without committing. reservedQty is untouched,
  // so this must not be marked SUCCEEDED — it retries and eventually dead-letters visibly.
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, committed: false, error: 'No stock available for allocation' }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
})

test('drain: a thrown allocate retries', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => { throw new Error('boom') }, recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
})

test('drain: a malformed payload retries, it is not silently marked succeeded', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps(
    [job('a', { payloadJson: { orderId: '' } })],
    async () => ({ success: true, committed: true }),
    recorded,
  )
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'])
  assert.deepEqual(recorded.successIds, [])
})

test('drain: a job with no lock is skipped, never actioned', async () => {
  const recorded = emptyRecorded()
  let allocateCalls = 0
  const deps = drainDeps([job('a', { lockedAt: null })], async () => { allocateCalls++; return { success: true, committed: true } }, recorded)
  const result = await processRefundReservationReleaseOutbox(deps)
  assert.equal(allocateCalls, 0)
  assert.deepEqual(recorded.successIds, [])
  assert.deepEqual(recorded.retryIds, [])
  assert.equal(result.failed, 1)
})
