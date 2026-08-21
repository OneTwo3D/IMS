import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz — the OPERATOR half of the attempt fence: the per-row "retry this failed sync" action.
 *
 * Before this, the retry was a compare-and-swap on `(id, status: 'FAILED')` alone. Status is not an
 * identity: the same row goes FAILED -> PENDING -> FAILED, so the reset could land on a LATER failure
 * than the one the operator judged — including a failure of an attempt that posted a real document.
 */

let store: SyncLogStore = createSyncLogStore([])
const activity: Array<{ action: string; level?: string; description: string; metadata?: Record<string, unknown> }> = []

const accountingSyncLog = new Proxy({}, {
  get: (_target, prop: string) => (args: never) => (store.delegate[prop] as (a: never) => Promise<unknown>)(args),
})

mock.module('@/lib/db', { namedExports: { db: { accountingSyncLog } } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push(entry)
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ id: 'user-1' }),
    requireFreshPermission: async () => ({ id: 'user-1' }),
    requireAuth: async () => ({ id: 'user-1' }),
    requireRole: async () => ({ id: 'user-1' }),
    freshAuthFailureResult: () => ({ success: false, error: 'stale' }),
  },
})

async function loadRetry() {
  return (await import('@/app/actions/xero-sync')).retryFailedXeroSync
}

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  activity.length = 0
}

const FAILED_ROW = {
  id: 'log-1',
  status: 'FAILED',
  type: 'SALES_INVOICE',
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
  retryCount: 3,
  errorMessage: 'Xero rejected the invoice',
}

test('a per-row retry about the attempt on screen lands, and advances the attempt as it lands', async () => {
  reset([syncLogRow({ ...FAILED_ROW, attemptRevision: 4 })])

  const result = await (await loadRetry())('log-1', 4)

  assert.deepEqual(result, { success: true, reset: 1 })
  const row = store.get('log-1')
  assert.equal(row?.status, 'PENDING')
  assert.equal(row?.retryCount, 0)
  assert.equal(row?.errorMessage, null)
  assert.equal(row?.attemptRevision, 5, 'the decision must move the row on, so an in-flight worker is fenced out')
})

test('a per-row retry about an EARLIER failure is refused, not applied to the later one', async () => {
  // The stale-request race: the operator judged the FAILED row at attempt 4; it was retried and failed
  // again (attempt 6) before their click arrived. `(id, status: FAILED)` matches both — the fence does not.
  reset([syncLogRow({ ...FAILED_ROW, attemptRevision: 6, retryCount: 2, errorMessage: 'A different, later failure' })])

  const result = await (await loadRetry())('log-1', 4)

  assert.equal(result.success, false)
  assert.equal(result.reset, 0)
  assert.match(result.error ?? '', /moved on to attempt 6/)
  assert.match(result.error ?? '', /NOT recorded/)
  const row = store.get('log-1')
  assert.equal(row?.status, 'FAILED', 'the later failure must be left exactly as it is')
  assert.equal(row?.retryCount, 2)
  assert.equal(row?.errorMessage, 'A different, later failure')
  assert.ok(activity.some((entry) => entry.action === 'xero_retry_failed_refused' && entry.level === 'WARNING'))
})

test('a per-row retry about a row that has since reached another status is refused', async () => {
  reset([syncLogRow({ ...FAILED_ROW, status: 'SYNCED', attemptRevision: 4, externalTransactionId: 'XERO-9' })])

  const result = await (await loadRetry())('log-1', 4)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /is now SYNCED/)
  assert.equal(store.get('log-1')?.status, 'SYNCED')
  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-9', 'a posted document must not be re-queued')
})

test('a per-row retry on a row no processor has ever fenced is refused, not guessed at', async () => {
  reset([syncLogRow({ ...FAILED_ROW, attemptRevision: 0 })])

  const result = await (await loadRetry())('log-1', 0)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /carries no attempt revision/)
  // A row that predates the fence can never be retried per-row; the refusal must not read as a dead end.
  assert.match(result.error ?? '', /"Retry All" is deliberately unfenced and still re-queues it/)
  assert.equal(store.get('log-1')?.status, 'FAILED')
})

test('a per-row retry that names no attempt at all is refused rather than run unfenced', async () => {
  reset([syncLogRow({ ...FAILED_ROW, attemptRevision: 4 })])

  const result = await (await loadRetry())('log-1')

  assert.equal(result.success, false)
  assert.equal(result.reset, 0)
  assert.match(result.error ?? '', /needs the attempt it was requested about/)
  assert.equal(store.get('log-1')?.status, 'FAILED', 'nothing may be reset by a request that cannot be tied to an attempt')
})

test('a per-row retry naming another connector’s row is refused before the fence is consulted', async () => {
  reset([syncLogRow({ ...FAILED_ROW, connector: 'quickbooks', attemptRevision: 4 })])

  const result = await (await loadRetry())('log-1', 4)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /belongs to the quickbooks connector/)
  assert.equal(store.get('log-1')?.status, 'FAILED')
})

test('a per-row retry naming a row that no longer exists is refused', async () => {
  reset([])

  const result = await (await loadRetry())('log-1', 4)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /no longer exists/)
})

test('the bulk "Retry All" stays unfenced: it is not a judgement about any one attempt', async () => {
  reset([
    syncLogRow({ ...FAILED_ROW, id: 'log-1', attemptRevision: 4 }),
    syncLogRow({ ...FAILED_ROW, id: 'log-2', attemptRevision: 7 }),
    syncLogRow({ ...FAILED_ROW, id: 'log-3', status: 'SYNCED', attemptRevision: 2 }),
    syncLogRow({ ...FAILED_ROW, id: 'qbo-1', connector: 'quickbooks', attemptRevision: 0 }),
  ])

  const result = await (await loadRetry())()

  assert.deepEqual(result, { success: true, reset: 2 })
  assert.equal(store.get('log-1')?.status, 'PENDING')
  assert.equal(store.get('log-2')?.status, 'PENDING')
  assert.equal(store.get('log-3')?.status, 'SYNCED', 'only FAILED rows are re-queued')
  assert.equal(store.get('qbo-1')?.status, 'FAILED', 'only this connector’s rows are re-queued')
  // FAILED -> PENDING is itself a status change, which a later fenced decision detects as STATUS_MOVED,
  // and getting back to FAILED needs a claim, which mints a new revision. So the bulk form needs no bump.
  assert.equal(store.get('log-1')?.attemptRevision, 4)
})

// o3d-e2mz r6 (MEDIUM, FILED as o3d-psvi rather than fixed): a fence-loss row held at CANCELLED
// because the sale could not be read has NO operator path back. Pinned here so the filed issue rests
// on observed behaviour, and so whoever implements the release affordance sees both entry points.
test('o3d-e2mz r6: a CANCELLED unreadable-sale row is refused by BOTH retry entry points (o3d-psvi)', async () => {
  const UNREADABLE_ROW = {
    id: 'log-1',
    status: 'CANCELLED',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    retryCount: 0,
    externalTransactionId: 'XERO-INV-1',
    errorMessage: 'Posted to Xero as XERO-INV-1 ... while the sale could not be read.',
  }
  reset([syncLogRow({ ...UNREADABLE_ROW, attemptRevision: 4 })])

  // Per-row, quoting exactly the attempt the sync log shows.
  const perRow = await (await loadRetry())('log-1', 4)
  assert.equal(perRow.success, false)
  assert.match(perRow.error ?? '', /is now CANCELLED/, 'the fence refuses it on status, not on the attempt')
  assert.equal(store.get('log-1')?.status, 'CANCELLED')

  // And the bulk sweep, which is FAILED-only, does not reach it either.
  const bulk = await (await loadRetry())()
  assert.deepEqual(bulk, { success: true, reset: 0 }, 'Retry All re-queues FAILED rows only')
  assert.equal(store.get('log-1')?.status, 'CANCELLED')
  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-INV-1', 'and the document it names is untouched')
})
