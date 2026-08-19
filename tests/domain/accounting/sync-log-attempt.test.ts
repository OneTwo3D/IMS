import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNCLAIMED_ATTEMPT_REVISION,
  applyFencedAttemptDecision,
  claimAttemptWhere,
  nextAttemptRevision,
  updateAtAttemptRevision,
} from '@/lib/domain/accounting/sync-log-attempt'
import { createSyncLogStore, syncLogRow } from '../../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz. An operator decision about an accounting sync row could not be tied to the attempt it
 * was made about, so a change landing between the read and the decision silently repurposed it.
 * These tests pin the fence that fixes it — against a store that really evaluates the where, so a
 * removed CAS shows up as a matched row rather than a canned count.
 */

function client(store: ReturnType<typeof createSyncLogStore>) {
  return { accountingSyncLog: store.delegate } as never
}

test('the claim where pins the revision that was read, so two workers cannot both claim it', async () => {
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', attemptRevision: 3 })])
  const where = claimAttemptWhere({ id: 'log-1', status: 'PENDING' }, 3)
  assert.equal(where.attemptRevision, 3)

  // Worker A claims first: the row moves to attempt 4.
  const first = await store.delegate.updateMany({ where, data: { status: 'PROCESSING', attemptRevision: nextAttemptRevision(3) } } as never) as { count: number }
  assert.equal(first.count, 1)
  // Worker B read the same row at revision 3 and claims with the same where. It must match nothing.
  const second = await store.delegate.updateMany({ where, data: { status: 'PROCESSING', attemptRevision: nextAttemptRevision(3) } } as never) as { count: number }
  assert.equal(second.count, 0, 'a second claim from the same observed revision must match no row')
  assert.equal(store.get('log-1')?.attemptRevision, 4)
})

test('updateAtAttemptRevision writes only while the attempt it names is still current', async () => {
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'PROCESSING', attemptRevision: 4 })])

  assert.equal(await updateAtAttemptRevision(client(store), { id: 'log-1', attemptRevision: 4 }, { status: 'SYNCED' }), true)
  assert.equal(store.get('log-1')?.status, 'SYNCED')

  // The attempt has moved on; the holder of attempt 4 must no longer be able to write.
  store.get('log-1')!.attemptRevision = 5
  store.get('log-1')!.status = 'CANCELLED'
  assert.equal(await updateAtAttemptRevision(client(store), { id: 'log-1', attemptRevision: 4 }, { status: 'SYNCED' }), false)
  assert.equal(store.get('log-1')?.status, 'CANCELLED', 'the later attempt must survive the stale write')
})

test('a decision about an attempt lands once and bumps the revision, fencing out the in-flight worker', async () => {
  // The o3d-osl8 case: a PROCESSING row an operator settles as "did not post" while a worker holds
  // attempt 4. The settlement lands, and the worker's own writeback must then find nothing.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'PROCESSING', attemptRevision: 4 })])

  const outcome = await applyFencedAttemptDecision(client(store), {
    id: 'log-1',
    expectedAttemptRevision: 4,
    expectedStatus: 'PROCESSING',
    data: { status: 'CANCELLED', errorMessage: 'Operator verified: never posted' },
  })
  assert.deepEqual(outcome, { ok: true, attemptRevision: 5 })
  assert.equal(store.get('log-1')?.status, 'CANCELLED')

  const workerWriteback = await updateAtAttemptRevision(client(store), { id: 'log-1', attemptRevision: 4 }, { status: 'SYNCED' })
  assert.equal(workerWriteback, false, 'the worker holding attempt 4 must discover the decision, not overwrite it')
  assert.equal(store.get('log-1')?.status, 'CANCELLED')
})

test('a decision replayed once the row is PROCESSING again lands on nothing, not on the new attempt', async () => {
  // PROCESSING -> ... -> PROCESSING is the other way status fails as an identity: a stale-claim
  // reclaim puts the row back into the status the decision was made about, on a different attempt.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'PROCESSING', attemptRevision: 4 })])
  const params = {
    id: 'log-1',
    expectedAttemptRevision: 4,
    expectedStatus: 'PROCESSING' as const,
    data: { status: 'CANCELLED' as const, errorMessage: 'Operator verified: never posted' },
  }
  assert.equal((await applyFencedAttemptDecision(client(store), params)).ok, true)

  // Revived and re-claimed since: PROCESSING again, two attempts later.
  Object.assign(store.get('log-1')!, { status: 'PROCESSING', attemptRevision: 7, errorMessage: null })

  const replay = await applyFencedAttemptDecision(client(store), params)
  assert.equal(replay.ok, false)
  assert.equal(replay.ok === false && replay.reason, 'ATTEMPT_MOVED')
  assert.match(replay.ok === false ? replay.message : '', /moved on to attempt 7/)
  assert.match(replay.ok === false ? replay.message : '', /made about attempt 4/)
  assert.equal(store.get('log-1')?.status, 'PROCESSING', 'the live attempt must not be cancelled by a stale decision')
})

test('a decision about an attempt that has since reached an outcome is refused as STATUS_MOVED', async () => {
  // Same attempt, different status: the worker finished attempt 4 and posted before the operator's
  // "did not post" reached the database. Nothing about the row moved except the fact being asserted.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'SYNCED', attemptRevision: 4, externalTransactionId: 'INV-9' })])
  const refusal = await applyFencedAttemptDecision(client(store), {
    id: 'log-1',
    expectedAttemptRevision: 4,
    expectedStatus: 'PROCESSING',
    data: { status: 'CANCELLED' },
  })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.ok === false && refusal.reason, 'STATUS_MOVED')
  assert.match(refusal.ok === false ? refusal.message : '', /is now SYNCED/)
  assert.equal(store.get('log-1')?.status, 'SYNCED', 'the posted outcome must not be overwritten')
})

test('a row that no processor has ever claimed under the fence is refused, not guessed at', async () => {
  // Rows written before the column existed — and rows of any connector whose processor does not
  // stamp one — stay at 0 forever. 0 identifies no attempt, so nothing can be fenced to it.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'PROCESSING', attemptRevision: UNCLAIMED_ATTEMPT_REVISION })])
  const refusal = await applyFencedAttemptDecision(client(store), {
    id: 'log-1',
    expectedAttemptRevision: UNCLAIMED_ATTEMPT_REVISION,
    expectedStatus: 'PROCESSING',
    data: { status: 'CANCELLED' },
  })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.ok === false && refusal.reason, 'UNFENCED_ATTEMPT')
  assert.equal(store.updateManyWheres.length, 0, 'an unfenceable row must not be written to at all')
  assert.equal(store.get('log-1')?.status, 'PROCESSING')
})

test('a decision naming a real attempt on a row that is still unfenced is refused as UNFENCED_ATTEMPT', async () => {
  // Guards the read-back branch: the CAS finds nothing and the row turns out to be at 0.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'PROCESSING', attemptRevision: UNCLAIMED_ATTEMPT_REVISION })])
  const refusal = await applyFencedAttemptDecision(client(store), {
    id: 'log-1',
    expectedAttemptRevision: 2,
    expectedStatus: 'PROCESSING',
    data: { status: 'CANCELLED' },
  })
  assert.equal(refusal.ok === false && refusal.reason, 'UNFENCED_ATTEMPT')
  assert.equal(store.get('log-1')?.status, 'PROCESSING')
})

test('a decision about a row that no longer exists is refused as ROW_MISSING', async () => {
  const store = createSyncLogStore([])
  const refusal = await applyFencedAttemptDecision(client(store), {
    id: 'log-gone',
    expectedAttemptRevision: 3,
    expectedStatus: 'FAILED',
    data: { status: 'CANCELLED' },
  })
  assert.equal(refusal.ok === false && refusal.reason, 'ROW_MISSING')
})

test('FAILED -> PENDING -> FAILED cannot be settled by a decision taken about the earlier FAILED', async () => {
  // The exact reason status is not an identity: retryFailedXeroSync revives a FAILED row, so it
  // returns to FAILED on a LATER attempt. A CAS on (id, status) would match; the fence must not.
  const store = createSyncLogStore([syncLogRow({ id: 'log-1', status: 'FAILED', attemptRevision: 4, retryCount: 5 })])

  // Operator reads the FAILED row at attempt 4. Meanwhile: retry (retryCount reset to 0, so
  // retryCount is no fence either), re-claim, re-fail.
  Object.assign(store.get('log-1')!, { status: 'PENDING', retryCount: 0 })
  Object.assign(store.get('log-1')!, { status: 'PROCESSING', attemptRevision: 5 })
  Object.assign(store.get('log-1')!, { status: 'FAILED', retryCount: 5 })

  const refusal = await applyFencedAttemptDecision(client(store), {
    id: 'log-1',
    expectedAttemptRevision: 4,
    expectedStatus: 'FAILED',
    data: { status: 'CANCELLED', errorMessage: 'Operator verified: never posted' },
  })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.ok === false && refusal.reason, 'ATTEMPT_MOVED')
  assert.equal(store.get('log-1')?.status, 'FAILED', 'the later attempt must be left for the operator to judge')
})
