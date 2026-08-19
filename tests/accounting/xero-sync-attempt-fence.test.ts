import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz — the Xero processor's half of the attempt fence, driven through the real
 * `processPendingXeroSync` loop.
 *
 * The row used here is a COGS_JOURNAL that already carries an externalTransactionId, so the loop
 * takes the "already posted, just record it" branch: no remote call, no back-reference, no
 * follow-ups. That leaves exactly the two writes under test — the claim, and the writeback.
 */

// Direct path: the outbox variant adds an IntegrationOutbox round-trip that says nothing about the
// sync-row fence.
process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'false'

let store: SyncLogStore = createSyncLogStore([])
/** Runs once, on the next db.$transaction — i.e. between the claim and the writeback. */
let interleave: (() => void) | null = null
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

const dbStub = {
  accountingSyncLog,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const hook = interleave
    interleave = null
    hook?.()
    return fn(dbStub)
  },
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
  },
})
// The mirrored accounting event is a separate table with its own tests; the fence is about the row.
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})

async function loadProcessor() {
  return (await import('@/lib/connectors/xero/sync-processor')).processPendingXeroSync
}

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  interleave = null
  activity.length = 0
}

const POSTED_ROW = {
  id: 'log-1',
  type: 'COGS_JOURNAL',
  referenceType: 'CogsEntry',
  referenceId: 'cogs-1',
  externalTransactionId: 'XERO-1',
}

test('claiming a row mints a new attempt: the claim CASes on the revision it read and bumps it', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  const claimWhere = store.updateManyWheres[0]
  assert.equal(claimWhere.attemptRevision, 3, 'the claim must be a compare-and-swap on the revision that was read')
  assert.equal(store.get('log-1')?.attemptRevision, 4, 'a claim must move the row to a new attempt')
  assert.equal(store.get('log-1')?.status, 'SYNCED')
})

test('a decision landing between the claim and the writeback is NOT overwritten, and is reported', async () => {
  // The o3d-osl8 race: the operator settles the PROCESSING row as "did not post" while this worker
  // holds the attempt. Settlement bumps the revision, so the worker's writeback must find nothing.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      errorMessage: 'Operator verified: never posted',
    })
  }

  const result = await (await loadProcessor())()

  assert.equal(store.get('log-1')?.status, 'CANCELLED', 'the settlement must survive the worker writeback')
  assert.equal(store.get('log-1')?.attemptRevision, 5)
  assert.equal(result.succeeded, 0)
  assert.equal(result.failed, 1)

  const escalation = activity.find((entry) => entry.action === 'xero_sync_post_fenced_out')
  assert.ok(escalation, 'losing the fence after a post must be reported, not swallowed')
  assert.equal(escalation.level, 'ERROR')
  assert.equal(escalation.metadata?.externalId, 'XERO-1')
  assert.equal(escalation.metadata?.claimedAttemptRevision, 4)
  assert.equal(escalation.metadata?.currentAttemptRevision, 5)
  assert.match(escalation.description, /XERO-1/)
})

test('a settled row whose document DID post gets the external id recorded, loudly', async () => {
  // Same race, but the operator's assertion is now known to be wrong and the row names no document.
  // The posted invoice must become visible to the order delete guard rather than being lost.
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      // The operator asserted "never posted", so they left no document id behind.
      externalTransactionId: null,
      errorMessage: 'Operator verified: never posted',
    })
  }

  await (await loadProcessor())()

  const row = store.get('log-1')
  assert.equal(row?.externalTransactionId, 'XERO-1', 'the document that exists must be named on the row')
  assert.equal(row?.status, 'SYNCED', 'the delete guard must see a posted document, not a cancelled row')
  assert.equal(row?.attemptRevision, 6, 'recording the correction must itself move the attempt on')
  assert.match(row?.errorMessage ?? '', /Posted to Xero as XERO-1 on attempt 4/)
  assert.ok(activity.some((entry) => entry.action === 'xero_sync_post_fenced_out' && entry.level === 'ERROR'))
})

test('a settled row that already names a document is left exactly as the decision left it', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'SYNCED',
      attemptRevision: 5,
      externalTransactionId: 'XERO-OPERATOR-VERIFIED',
      errorMessage: 'Operator verified: posted',
    })
  }

  await (await loadProcessor())()

  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-OPERATOR-VERIFIED', 'a recorded document id must never be renamed')
  assert.equal(store.get('log-1')?.attemptRevision, 5)
  assert.ok(activity.some((entry) => entry.action === 'xero_sync_post_fenced_out'))
})

test('a stale PROCESSING claim is reclaimed onto a new attempt, so the old holder cannot write', async () => {
  const stale = new Date(Date.now() - 60 * 60 * 1000)
  reset([syncLogRow({ ...POSTED_ROW, status: 'PROCESSING', attemptRevision: 3, processingStartedAt: stale })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  assert.equal(store.get('log-1')?.attemptRevision, 4, 'PROCESSING -> PROCESSING must still be a NEW attempt')
})

test('a failure from an attempt the row has moved past does not revive it — with the CLAIM still matching', async () => {
  // REWRITTEN ON THE REBASE, and the reason is worth stating. The original fixture put the row at
  // CANCELLED, which o3d-550x's `heldClaimWhere` (merged since) refuses on `status: 'PROCESSING'`
  // alone — the attempt revision would never have been consulted and the test would have passed
  // with the whole of o3d-e2mz reverted.
  //
  // So the row here is PROCESSING at THE VERY INSTANT this worker stamped: the held-claim fence
  // MATCHES and cannot be what refuses the write. Only the revision can. That is also the case the
  // claim instant genuinely cannot cover — two claims inside one millisecond carry the same
  // `processingStartedAt`, while the revision is a counter and cannot collide.
  const { applyMainSyncFailureRetry } = await import('@/lib/connectors/xero/sync-processor')
  const { claimHeldFrom } = await import('@/lib/domain/accounting/sync-claim-fence')
  const claimedAt = new Date('2026-08-20T09:00:00.000Z')
  const settledStore = createSyncLogStore([syncLogRow({
    ...POSTED_ROW,
    status: 'PROCESSING',
    processingStartedAt: claimedAt,
    attemptRevision: 5,
    retryCount: 2,
    errorMessage: 'Operator verified: never posted',
  })])
  const tx = { accountingSyncLog: settledStore.delegate } as never

  await applyMainSyncFailureRetry(
    tx,
    { id: 'log-1', attemptRevision: 4 },
    { retryCount: 2, type: 'COGS_JOURNAL', referenceType: 'CogsEntry', referenceId: 'cogs-1' },
    'Xero timed out',
    {},
    claimHeldFrom(claimedAt),
  )

  assert.equal(settledStore.get('log-1')?.status, 'PROCESSING', 'the write was refused on the REVISION')
  assert.equal(settledStore.get('log-1')?.retryCount, 2, 'the settled row must not be advanced by a stale attempt')
  assert.equal(settledStore.get('log-1')?.errorMessage, 'Operator verified: never posted')
})

test('a follow-up failure from an attempt that was settled mid-flight does not revive the row', async () => {
  const { markSyncLogForFollowUpRetry } = await import('@/lib/connectors/xero/sync-processor')
  const settledStore = createSyncLogStore([syncLogRow({
    ...POSTED_ROW,
    status: 'CANCELLED',
    attemptRevision: 5,
    retryCount: 2,
    errorMessage: 'Operator verified: never posted',
  })])
  const client = { accountingSyncLog: settledStore.delegate } as never

  const outcome = await markSyncLogForFollowUpRetry({ id: 'log-1', attemptRevision: 4 }, { retryCount: 2 }, new Error('pdf failed'), client)

  assert.equal(settledStore.get('log-1')?.status, 'CANCELLED')
  assert.equal(settledStore.get('log-1')?.retryCount, 2)
  // The caller's outbox decision must still be driven by what is PERSISTED, not by the stale view.
  assert.equal(outcome.finalFailure, false)
})
