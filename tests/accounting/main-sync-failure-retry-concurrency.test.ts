import assert from 'node:assert/strict'
import test from 'node:test'

import { applyMainSyncFailureRetry } from '@/lib/connectors/xero/sync-processor'

// audit-om4e: the inline MAIN-sync failure retry updates must advance retryCount
// optimistically (where: { id, retryCount }) like markSyncLogForFollowUpRetry, so
// two workers on the same row can't double-write the failure transition / mirrored
// event. On a lost race the persisted state drives finalFailure (and the outbox
// permanent/retry decision), and the mirrored-event write the winner already did
// is skipped.

const noop = async () => undefined
// Permissive stand-in for the mirror-table delegates updateMirroredEventForSyncLog
// reaches for; the unit under test only asserts the accountingSyncLog behaviour.
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
        return new Proxy({}, { get: () => noop })
      },
    },
  )
  return { tx: tx as never, calls }
}

const entry = { id: 'log-1', retryCount: 2, type: 'SALES_INVOICE' as const, referenceType: 'SalesOrder', referenceId: 'so-1' }

test('optimistic update keys on the observed retryCount; non-terminal stays PENDING', async () => {
  const { tx, calls } = makeTx({ updateCount: 1 })
  const result = await applyMainSyncFailureRetry(tx, entry, 'boom', {})
  assert.deepEqual(calls.updateMany[0].where, { id: 'log-1', retryCount: 2 })
  assert.equal(calls.updateMany[0].data.retryCount, 3)
  assert.equal(calls.updateMany[0].data.status, 'PENDING')
  assert.equal(calls.findUnique, 0) // won the race → no re-read
  assert.equal(result.finalFailure, false)
})

test('reaching MAX_RETRIES marks FAILED (and writes the mirror on the winning path)', async () => {
  const { tx } = makeTx({ updateCount: 1 })
  const result = await applyMainSyncFailureRetry(tx, { ...entry, retryCount: 4 }, 'boom', {})
  assert.equal(result.finalFailure, true)
})

test('lost race (count 0) reports the PERSISTED terminal state, not the stale view', async () => {
  const { tx, calls } = makeTx({ updateCount: 0, current: { retryCount: 5, status: 'FAILED' } })
  const result = await applyMainSyncFailureRetry(tx, { ...entry, retryCount: 1 }, 'boom', {})
  assert.equal(calls.findUnique, 1)
  assert.equal(result.finalFailure, true)
})

test('lost race where the winner left the row retryable reports finalFailure=false', async () => {
  const { tx } = makeTx({ updateCount: 0, current: { retryCount: 2, status: 'PENDING' } })
  const result = await applyMainSyncFailureRetry(tx, { ...entry, retryCount: 1 }, 'boom', {})
  assert.equal(result.finalFailure, false)
})

test('lost race with a vanished row falls back to the computed view', async () => {
  const { tx } = makeTx({ updateCount: 0, current: null })
  const result = await applyMainSyncFailureRetry(tx, { ...entry, retryCount: 4 }, 'boom', {})
  assert.equal(result.finalFailure, true) // 4 → 5 == MAX
})
