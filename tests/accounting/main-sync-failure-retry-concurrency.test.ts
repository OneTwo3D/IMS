import assert from 'node:assert/strict'
import test from 'node:test'

import { applyMainSyncFailureRetry } from '@/lib/connectors/xero/sync-processor'
import { claimHeldFrom } from '@/lib/domain/accounting/sync-claim-fence'

// o3d-550x: every call now carries the instant the caller stamped its claim, and the update lands only
// while the row still bears it. A re-claim does NOT advance retryCount, so the guard this file was
// written about could not tell a displaced owner from the worker that actually holds the row. The
// BEHAVIOURAL proof lives in tests/accounting/xero-claim-fence.test.ts, against a store that honours
// its where clause — the double below returns a canned count and cannot observe a fence at all.
const CLAIMED_AT = new Date('2026-03-01T09:00:00.000Z')

// o3d-e2mz: the same where also carries the claimed attemptRevision, so a failure
// from one attempt can never reopen a row an operator settled while it was in flight.
//
// audit-om4e: the inline MAIN-sync failure retry updates must advance retryCount
// optimistically (where: { id, retryCount }) like markSyncLogForFollowUpRetry, so
// two workers on the same row can't double-write the failure transition / mirrored
// event. On a lost race the persisted state drives finalFailure (and the outbox
// permanent/retry decision), and the mirrored-event write the winner already did
// is skipped.

/**
 * Stand-in for the mirror-table delegates `updateMirroredEventForSyncLog` reaches for. It answers
 * a ROW, not `undefined`.
 *
 * It used to answer `undefined`, and that worked only by accident: before o3d-nf9i (batch-settle)
 * `updateMirroredAccountingEventStatus` ended `if (!event) return`, so a delegate that produced
 * nothing was indistinguishable from "this row has no mirrored event" and the function bailed out
 * silently — i.e. the mirror write this test's own name asserts was never actually exercised. That
 * branch is now an explicit outcome (`'updated' | 'not_found' | 'refused'`) and the found path
 * reads `event.id`, so `undefined` is no longer a value any real Prisma client can return here.
 *
 * A row is the honest answer for what this test models: the sync log HAS a mirrored event, the
 * update finds it, and the winning path writes it. "No mirrored event" would be the other honest
 * fixture — but it is not this one, and it would make the assertion vacuous.
 */
const mirroredEventRow = { id: 'mirror-event-1' }
const mirrorDelegateCall = async () => mirroredEventRow
function makeTx(stub: { updateCount: number; current?: { retryCount: number; status: string } | null }) {
  const calls: { updateMany: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>; findUnique: number } = {
    updateMany: [],
    findUnique: 0,
  }
  const accountingSyncLog = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      calls.updateMany.push({ where, data })
      return { count: stub.updateCount }
    },
    findUnique: async () => {
      calls.findUnique += 1
      return stub.current ?? null
    },
  }
  const tx = new Proxy(
    { accountingSyncLog },
    {
      get(target, prop: string) {
        if (prop === 'accountingSyncLog') return accountingSyncLog
        // Any other delegate (mirror tables) → object of no-op async methods.
        return new Proxy({}, { get: () => mirrorDelegateCall })
      },
    },
  )
  return { tx: tx as never, calls }
}

const attempt = { id: 'log-1', attemptRevision: 4 }
const entry = { retryCount: 2, type: 'SALES_INVOICE' as const, referenceType: 'SalesOrder', referenceId: 'so-1' }

test('optimistic update keys on the observed retryCount; non-terminal stays PENDING', async () => {
  const { tx, calls } = makeTx({ updateCount: 1 })
  const result = await applyMainSyncFailureRetry(tx, attempt, entry, 'boom', {}, claimHeldFrom(CLAIMED_AT))
  // BOTH fences on one where (o3d-550x + o3d-e2mz): the held claim proves this worker still owns
  // the row, the attempt revision proves the failure belongs to the attempt it claimed.
  assert.deepEqual(calls.updateMany[0].where, {
    id: 'log-1',
    status: 'PROCESSING',
    processingStartedAt: CLAIMED_AT,
    attemptRevision: 4,
    retryCount: 2,
  })
  assert.equal(calls.updateMany[0].data.retryCount, 3)
  assert.equal(calls.updateMany[0].data.status, 'PENDING')
  assert.equal(calls.findUnique, 0) // won the race → no re-read
  assert.equal(result.finalFailure, false)
})

test('reaching MAX_RETRIES marks FAILED (and writes the mirror on the winning path)', async () => {
  const { tx } = makeTx({ updateCount: 1 })
  const result = await applyMainSyncFailureRetry(tx, attempt, { ...entry, retryCount: 4 }, 'boom', {}, claimHeldFrom(CLAIMED_AT))
  assert.equal(result.finalFailure, true)
})

test('lost race (count 0) reports the PERSISTED terminal state, not the stale view', async () => {
  const { tx, calls } = makeTx({ updateCount: 0, current: { retryCount: 5, status: 'FAILED' } })
  const result = await applyMainSyncFailureRetry(tx, attempt, { ...entry, retryCount: 1 }, 'boom', {}, claimHeldFrom(CLAIMED_AT))
  assert.equal(calls.findUnique, 1)
  assert.equal(result.finalFailure, true)
})

test('lost race where the winner left the row retryable reports finalFailure=false', async () => {
  const { tx } = makeTx({ updateCount: 0, current: { retryCount: 2, status: 'PENDING' } })
  const result = await applyMainSyncFailureRetry(tx, attempt, { ...entry, retryCount: 1 }, 'boom', {}, claimHeldFrom(CLAIMED_AT))
  assert.equal(result.finalFailure, false)
})

test('lost race with a vanished row falls back to the computed view', async () => {
  const { tx } = makeTx({ updateCount: 0, current: null })
  const result = await applyMainSyncFailureRetry(tx, attempt, { ...entry, retryCount: 4 }, 'boom', {}, claimHeldFrom(CLAIMED_AT))
  assert.equal(result.finalFailure, true) // 4 → 5 == MAX
})

test('o3d-a3wx r6: the write is keyed on the CLAIM INSTANT, not merely on the row being PROCESSING', async () => {
  // The replacement's row is PROCESSING too — that is what re-claiming a stale row produces — so a
  // status-only fence would still let the displaced owner through. Only the worker that stamped this
  // exact timestamp owns the row.
  const { tx, calls } = makeTx({ updateCount: 0, current: { retryCount: 2, status: 'PROCESSING' } })
  const result = await applyMainSyncFailureRetry(tx, attempt, entry, 'boom', {}, claimHeldFrom(CLAIMED_AT))

  assert.equal(calls.updateMany[0].where.processingStartedAt, CLAIMED_AT)
  assert.equal(calls.updateMany[0].where.status, 'PROCESSING')
  // o3d-e2mz: and the revision beside it. The two answer different questions — "do I still own
  // this row" and "is this still the attempt I claimed" — and neither implies the other, since
  // two claims inside one millisecond share a `processingStartedAt`.
  assert.equal(calls.updateMany[0].where.attemptRevision, 4)
  // Displaced: nothing was written, and the row is reported as it actually stands — still claimed and
  // still retryable — so the caller retries the outbox job instead of marking it permanently failed.
  assert.equal(calls.findUnique, 1)
  assert.equal(result.finalFailure, false)
})
