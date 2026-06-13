import assert from 'node:assert/strict'
import test from 'node:test'

import { markSyncLogForFollowUpRetry } from '@/lib/connectors/xero/sync-processor'

// audit-dzm9: markSyncLogForFollowUpRetry must advance retryCount optimistically
// (where: { id, retryCount }) so two workers handling the same AccountingSyncLog
// can't both increment from a stale value and double-write the failure
// transition. On a lost race it must report the PERSISTED state, not its stale
// view, so the caller's outbox permanent/retry decision is correct.

type Captured = { where: Record<string, unknown>; data: Record<string, unknown> }

function fakeClient(opts: {
  updateCount: number
  current?: { retryCount: number; status: string } | null
}) {
  const calls: { updateMany: Captured[]; findUnique: unknown[] } = { updateMany: [], findUnique: [] }
  const client = {
    accountingSyncLog: {
      updateMany: async ({ where, data }: Captured) => {
        calls.updateMany.push({ where, data })
        return { count: opts.updateCount }
      },
      findUnique: async (args: unknown) => {
        calls.findUnique.push(args)
        return opts.current ?? null
      },
    },
  } as never
  return { client, calls }
}

test('optimistic update keys on the observed retryCount and reports the applied transition', async () => {
  const { client, calls } = fakeClient({ updateCount: 1 })
  const result = await markSyncLogForFollowUpRetry({ id: 'log-1', retryCount: 2 }, new Error('boom'), client)

  // Compound where prevents a stale double-write.
  assert.deepEqual(calls.updateMany[0].where, { id: 'log-1', retryCount: 2 })
  assert.equal(calls.updateMany[0].data.retryCount, 3)
  assert.equal(calls.updateMany[0].data.status, 'PENDING')
  // Won the race → no re-read needed.
  assert.equal(calls.findUnique.length, 0)
  assert.equal(result.finalFailure, false)
})

test('reaching MAX_RETRIES marks the row FAILED', async () => {
  const { client } = fakeClient({ updateCount: 1 })
  // retryCount 4 → 5 == MAX_RETRIES → terminal.
  const result = await markSyncLogForFollowUpRetry({ id: 'log-2', retryCount: 4 }, new Error('boom'), client)
  assert.equal(result.finalFailure, true)
})

test('lost race (count 0) reflects the PERSISTED terminal state, not the stale view', async () => {
  // Our stale view says retryCount 1 → 2 (not final), but the winning worker
  // already drove the row to FAILED. We must report finalFailure=true so the
  // caller marks the outbox job permanently failed, not for retry.
  const { client, calls } = fakeClient({ updateCount: 0, current: { retryCount: 5, status: 'FAILED' } })
  const result = await markSyncLogForFollowUpRetry({ id: 'log-3', retryCount: 1 }, new Error('boom'), client)

  assert.equal(calls.findUnique.length, 1)
  assert.equal(result.finalFailure, true)
})

test('lost race where the winner left the row retryable reports finalFailure=false', async () => {
  const { client } = fakeClient({ updateCount: 0, current: { retryCount: 2, status: 'PENDING' } })
  const result = await markSyncLogForFollowUpRetry({ id: 'log-4', retryCount: 1 }, new Error('boom'), client)
  assert.equal(result.finalFailure, false)
})

test('lost race with a vanished row falls back to the computed view', async () => {
  const { client } = fakeClient({ updateCount: 0, current: null })
  const result = await markSyncLogForFollowUpRetry({ id: 'log-5', retryCount: 4 }, new Error('boom'), client)
  // No persisted row to consult → use our computed finalFailure (4 → 5 == MAX).
  assert.equal(result.finalFailure, true)
})
