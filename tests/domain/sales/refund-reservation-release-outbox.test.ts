import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma } from '@/app/generated/prisma/client'
import {
  scheduleRefundReservationReleaseOutbox,
  scheduleRefundUnmatchedWarningOutbox,
  processRefundReservationReleaseOutbox,
  processRefundUnmatchedWarningOutbox,
  resolveRefundReservationReleaseOutbox,
  isRefundReleaseEligible,
  hasUnmatchedSaleRefund,
  writeRefundWarningOnce,
  DEFERRAL_WARNING_ACTION,
  UNMATCHED_WARNING_ACTION,
  REFUND_RESERVATION_RELEASE_OUTBOX_CONNECTOR,
  REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION,
  REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION,
  type RefundReservationReleaseDrainDeps,
  type RefundUnmatchedWarningDrainDeps,
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

// ---- eligibility: residual reservation AND demand-reducing --------------------

const saleLine = (qty: number) => ({ lineKind: 'sale', qty, lineId: 'line-1' })
const unmatchedSaleLine = (qty: number) => ({ lineKind: 'sale', qty, lineId: null })
const feeLine = (kind: string) => ({ lineKind: kind, qty: 0, lineId: null })

test('eligibility: needs a live residual reservation', () => {
  assert.equal(isRefundReleaseEligible({ residualReserved: 0, newStatus: 'REFUNDED', refundLines: [saleLine(2)] }), false)
  assert.equal(isRefundReleaseEligible({ residualReserved: 1e-9, newStatus: 'REFUNDED', refundLines: [saleLine(2)] }), false)
  assert.equal(isRefundReleaseEligible({ residualReserved: 3, newStatus: 'REFUNDED', refundLines: [saleLine(2)] }), true)
})

test('eligibility: a partial amount-only refund (no sale qty) is NOT eligible even with a residual (o3d-67y r7)', () => {
  for (const kind of ['shipping', 'discount', 'goodwill', 'fee']) {
    assert.equal(
      isRefundReleaseEligible({ residualReserved: 5, newStatus: 'PARTIALLY_REFUNDED', refundLines: [feeLine(kind)] }),
      false,
      `partial ${kind}-only refund must not enqueue release work`,
    )
  }
})

test('eligibility: a partial refund WITH a matched positive-qty sale line IS eligible', () => {
  assert.equal(
    isRefundReleaseEligible({ residualReserved: 5, newStatus: 'PARTIALLY_REFUNDED', refundLines: [saleLine(2), feeLine('shipping')] }),
    true,
  )
})

test('eligibility: a partial refund with an UNMATCHED sale line (lineId null) is NOT eligible (o3d-67y r8)', () => {
  // Allocation ignores refund rows with a null salesOrderLineId, so an unmatched external quantity line would
  // otherwise enqueue and be falsely resolved as successful while the reservation stays held.
  assert.equal(
    isRefundReleaseEligible({ residualReserved: 5, newStatus: 'PARTIALLY_REFUNDED', refundLines: [unmatchedSaleLine(2)] }),
    false,
  )
  assert.equal(hasUnmatchedSaleRefund([unmatchedSaleLine(2)]), true)
  assert.equal(hasUnmatchedSaleRefund([saleLine(2)]), false)
})

test('eligibility: a FULL refund is still eligible regardless of line links — released via refundStatus=FULL', () => {
  assert.equal(
    isRefundReleaseEligible({ residualReserved: 5, newStatus: 'REFUNDED', refundLines: [feeLine('shipping')] }),
    true,
  )
  assert.equal(
    isRefundReleaseEligible({ residualReserved: 5, newStatus: 'REFUNDED', refundLines: [unmatchedSaleLine(2)] }),
    true,
  )
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
  assert.equal(data.operation, REFUND_RESERVATION_RELEASE_OUTBOX_OPERATION)
  assert.deepEqual(data.payloadJson, { orderId: 'order-1', refundId: 'refund-1' })
  assert.match(String(data.idempotencyKey), /refund-1/)
  assert.ok(data.nextAttemptAt instanceof Date && (data.nextAttemptAt as Date).getTime() > new Date('2026-07-22T00:00:00.000Z').getTime())
})

test('release schedule is a no-op when the refund does not reduce matched demand (eligible:false)', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundReservationReleaseOutbox(tx, { orderId: 'order-1', refundId: 'refund-1', eligible: false })
  assert.equal(created.length, 0)
})

test('unmatched-warning schedule enqueues a SEPARATE row (distinct operation) so delivery never re-runs allocation (o3d-67y r10)', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundUnmatchedWarningOutbox(tx, { orderId: 'order-1', refundId: 'refund-1', unmatched: true, refundOrderRef: 'SO-9' })
  assert.equal(created.length, 1)
  assert.equal(created[0].data.operation, REFUND_UNMATCHED_WARNING_OUTBOX_OPERATION)
  assert.deepEqual(created[0].data.payloadJson, { orderId: 'order-1', refundId: 'refund-1', refundOrderRef: 'SO-9' })
})

test('unmatched-warning schedule is a no-op when there is no anomaly (unmatched:false)', async () => {
  const { tx, created } = fakeTx()
  await scheduleRefundUnmatchedWarningOutbox(tx, { orderId: 'order-1', refundId: 'refund-1', unmatched: false })
  assert.equal(created.length, 0)
})

// ---- drain classification ---------------------------------------------------

type Warn = { orderId: string; refundId: string }
type Recorded = { successIds: string[]; retryIds: string[]; deferrals: Warn[]; unmatched: Warn[] }

function drainDeps(
  jobs: Array<{ id: string; attempts: number; lockedAt: Date | null; payloadJson: unknown }>,
  allocate: (orderId: string) => Promise<ReleaseAllocationResult>,
  recorded: Recorded,
): RefundReservationReleaseDrainDeps {
  return {
    claimWork: (async () => jobs) as unknown as RefundReservationReleaseDrainDeps['claimWork'],
    // Simulate allocation invoking the in-tx resolve hook on the committed path (r12): the real allocation calls
    // onReconciledInTx inside its transaction just before commit, which is where the row is marked SUCCEEDED.
    allocate: async (orderId, opts) => {
      const result = await allocate(orderId)
      if (result.committed === true) await opts?.onReconciledInTx?.({} as never)
      return result
    },
    markSuccess: async ({ id }) => { recorded.successIds.push(id) },
    markRetry: async ({ id }) => { recorded.retryIds.push(id) },
    logDeferral: async ({ orderId, refundId }) => { recorded.deferrals.push({ orderId, refundId }); return 'written' },
  }
}

function unmatchedDrainDeps(
  jobs: Array<{ id: string; attempts: number; lockedAt: Date | null; payloadJson: unknown }>,
  recorded: Recorded,
  logUnmatched?: RefundUnmatchedWarningDrainDeps['logUnmatched'],
): RefundUnmatchedWarningDrainDeps {
  return {
    claimWork: (async () => jobs) as unknown as RefundUnmatchedWarningDrainDeps['claimWork'],
    markSuccess: async ({ id }) => { recorded.successIds.push(id) },
    markRetry: async ({ id }) => { recorded.retryIds.push(id) },
    logUnmatched: logUnmatched ?? (async ({ orderId, refundId }) => { recorded.unmatched.push({ orderId, refundId }); return 'written' }),
  }
}

const emptyRecorded = (): Recorded => ({ successIds: [], retryIds: [], deferrals: [], unmatched: [] })

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

test('drain: a committed release marks SUCCEEDED inside allocation tx (client passed), not a separate write (o3d-67y r12)', async () => {
  const recorded = emptyRecorded()
  let successClientSeen = false
  let markSuccessCalls = 0
  const base = drainDeps([job('a')], async () => ({ success: true, committed: true }), recorded)
  const deps: RefundReservationReleaseDrainDeps = {
    ...base,
    markSuccess: async (options) => { markSuccessCalls++; if (options.client) successClientSeen = true },
  }
  await processRefundReservationReleaseOutbox(deps)
  assert.equal(markSuccessCalls, 1, 'success is written exactly once')
  assert.equal(successClientSeen, true, 'the SUCCEEDED transition rides the allocation transaction client')
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

test('drain: a refuse delegates to logDeferral on EVERY attempt — once-only is enforced by persistence, not the counter (o3d-67y r6)', async () => {
  const first = emptyRecorded()
  const firstDeps = drainDeps([job('a', { attempts: 0 })], async () => ({ success: false, refused: true, committed: false }), first)
  await processRefundReservationReleaseOutbox(firstDeps)
  assert.deepEqual(first.retryIds, ['a'])
  assert.deepEqual(first.deferrals, [{ orderId: 'order-a', refundId: 'refund-a' }])

  // A retried refuse still delegates: a swallowed first-attempt write would otherwise be lost forever. The
  // default logDeferral dedups on persisted state, so this is at-most-once, not attempt-gated.
  const retried = emptyRecorded()
  const retriedDeps = drainDeps([job('a', { attempts: 3 })], async () => ({ success: false, refused: true, committed: false }), retried)
  await processRefundReservationReleaseOutbox(retriedDeps)
  assert.deepEqual(retried.deferrals, [{ orderId: 'order-a', refundId: 'refund-a' }])
})

test('a logging failure in the drain deferral path never derails the retry (o3d-67y r6)', async () => {
  const recorded = emptyRecorded()
  const deps: RefundReservationReleaseDrainDeps = {
    ...drainDeps([job('a')], async () => ({ success: false, refused: true, committed: false }), recorded),
    logDeferral: async () => { throw new Error('activity log DB down') },
  }
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'], 'the retry still happens even when the deferral WARNING write throws')
})

test('drain: a non-refuse failure does NOT write a deferral WARNING', async () => {
  const recorded = emptyRecorded()
  const deps = drainDeps([job('a')], async () => ({ success: false, failed: true, committed: false }), recorded)
  await processRefundReservationReleaseOutbox(deps)
  assert.deepEqual(recorded.deferrals, [])
})

// ---- dedicated unmatched-warning drain (o3d-67y r10) — never runs allocation ---

const warningJob = (id: string, over: Partial<{ attempts: number; lockedAt: Date | null }> = {}) => ({
  id,
  attempts: over.attempts ?? 0,
  lockedAt: 'lockedAt' in over ? (over.lockedAt as Date | null) : new Date('2026-07-22T00:00:00.000Z'),
  payloadJson: { orderId: `order-${id}`, refundId: `refund-${id}`, refundOrderRef: 'SO-1' },
})

test('unmatched drain: delivers the WARNING and completes — no allocation dep exists on this path (o3d-67y r10)', async () => {
  const recorded = emptyRecorded()
  const deps = unmatchedDrainDeps([warningJob('a')], recorded)
  const result = await processRefundUnmatchedWarningOutbox(deps)
  assert.deepEqual(recorded.unmatched, [{ orderId: 'order-a', refundId: 'refund-a' }])
  assert.deepEqual(recorded.successIds, ['a'])
  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0 })
})

test('unmatched drain: a WARNING delivery that throws RETRIES (durable delivery)', async () => {
  const recorded = emptyRecorded()
  const deps = unmatchedDrainDeps([warningJob('a')], recorded, async () => { throw new Error('activity log DB down') })
  await processRefundUnmatchedWarningOutbox(deps)
  assert.deepEqual(recorded.retryIds, ['a'], 'unconfirmed WARNING delivery keeps the job pending')
  assert.deepEqual(recorded.successIds, [])
})

test('unmatched drain: a job with no lock is skipped, never actioned', async () => {
  const recorded = emptyRecorded()
  const deps = unmatchedDrainDeps([warningJob('a', { lockedAt: null })], recorded)
  const result = await processRefundUnmatchedWarningOutbox(deps)
  assert.deepEqual(recorded.unmatched, [])
  assert.equal(result.failed, 1)
})

// ---- idempotent + retryable WARNING writer ----------------------------------

const warnArgs = (action: string) => ({ orderId: 'order-1', refundId: 'refund-1', action, description: 'x', reason: 'r' })

test('WARNING writer: writes when none is persisted, carrying the (action, refund) identity', async () => {
  const logged: Array<Record<string, unknown>> = []
  const outcome = await writeRefundWarningOnce(
    warnArgs(UNMATCHED_WARNING_ACTION),
    { findExisting: async () => false, log: async (p) => { logged.push(p); return undefined } },
  )
  assert.equal(outcome, 'written')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].action, UNMATCHED_WARNING_ACTION)
  assert.equal(logged[0].entityId, 'order-1')
  assert.equal(logged[0].level, 'WARNING')
  assert.deepEqual((logged[0].metadata as { refundId: string }).refundId, 'refund-1')
})

test('WARNING writer: dedups on (action, refundId) — findExisting receives the action', async () => {
  const seenActions: string[] = []
  const outcome = await writeRefundWarningOnce(
    warnArgs(DEFERRAL_WARNING_ACTION),
    { findExisting: async ({ action }) => { seenActions.push(action); return true }, log: async () => undefined },
  )
  assert.equal(outcome, 'skipped')
  assert.deepEqual(seenActions, [DEFERRAL_WARNING_ACTION], 'dedup is scoped to the specific warning action')
})

test('WARNING writer: a lost write (still not persisted next time) is retried, not permanently suppressed', async () => {
  let persisted = false
  const attempt = () => writeRefundWarningOnce(
    warnArgs(UNMATCHED_WARNING_ACTION),
    { findExisting: async () => persisted, log: async () => { /* swallowed: does not persist */ return undefined } },
  )
  assert.equal(await attempt(), 'written')
  assert.equal(await attempt(), 'written', 'a swallowed write is retried on the next attempt')
  persisted = true
  assert.equal(await attempt(), 'skipped', 'once it finally persists, no further duplicates')
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
