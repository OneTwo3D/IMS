import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createSyncLogStore, syncLogRow, type SyncLogStore } from '../fixtures/accounting-sync-log-store.ts'

/**
 * o3d-e2mz — the OUTBOX variant of the Xero processor loop.
 *
 * `isXeroAccountingOutboxEnabled` defaults ON, so this is the path production runs. It is a second
 * copy of the claim/writeback sequence, so it needs its own proof that the fence is wired into it
 * — a fence present in only one of the two loops proves nothing about the row.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'true'

let store: SyncLogStore = createSyncLogStore([])
let interleave: (() => void) | null = null
const activity: Array<{ action: string; level?: string; metadata?: Record<string, unknown> }> = []
const outboxCalls: string[] = []

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

const JOB = {
  id: 'job-1',
  connector: 'xero',
  operation: 'post_accounting_event',
  idempotencyKey: 'k',
  payloadJson: { accountingSyncLogId: 'log-1' },
  status: 'PROCESSING',
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  lockedAt: new Date('2026-08-19T09:30:00.000Z'),
  lockedBy: 'xero-accounting-sync',
  createdAt: new Date('2026-08-19T09:00:00.000Z'),
  updatedAt: new Date('2026-08-19T09:30:00.000Z'),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; level?: string; metadata?: Record<string, unknown> }) => { activity.push(entry) },
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async () => {},
    voidMirroredAccountingEventsForOrder: async () => {},
  },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    XERO_OUTBOX_CONNECTOR: 'xero',
    XERO_ACCOUNTING_POST_OPERATION: 'post_accounting_event',
    scheduleXeroAccountingOutbox: async () => JOB,
    parseXeroAccountingOutboxPayload: (row: { payloadJson: { accountingSyncLogId: string } }) => row.payloadJson,
  },
})
mock.module('@/lib/domain/integrations/outbox', {
  namedExports: {
    INTEGRATION_OUTBOX_STATUS: {
      PENDING: 'PENDING',
      PROCESSING: 'PROCESSING',
      SUCCEEDED: 'SUCCEEDED',
      RETRYABLE_FAILED: 'RETRYABLE_FAILED',
      PERMANENT_FAILED: 'PERMANENT_FAILED',
    },
    claimIntegrationOutboxWork: async () => [JOB],
    markIntegrationOutboxSuccess: async () => { outboxCalls.push('success') },
    markIntegrationOutboxRetryableFailure: async () => { outboxCalls.push('retry') },
    markIntegrationOutboxPermanentFailure: async () => { outboxCalls.push('permanent') },
  },
})

async function loadProcessor() {
  return (await import('@/lib/connectors/xero/sync-processor')).processPendingXeroSync
}

function reset(rows: Parameters<typeof createSyncLogStore>[0]) {
  store = createSyncLogStore(rows)
  interleave = null
  activity.length = 0
  outboxCalls.length = 0
}

const POSTED_ROW = {
  id: 'log-1',
  type: 'COGS_JOURNAL',
  referenceType: 'CogsEntry',
  referenceId: 'cogs-1',
  externalTransactionId: 'XERO-1',
}

test('the outbox loop claims onto a new attempt, CASing on the revision it read', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])

  const result = await (await loadProcessor())()

  assert.equal(result.processed, 1)
  const claimWhere = store.updateManyWheres[0]
  assert.equal(claimWhere.attemptRevision, 3)
  assert.equal(store.get('log-1')?.attemptRevision, 4)
  assert.equal(store.get('log-1')?.status, 'SYNCED')
  assert.deepEqual(outboxCalls, ['success'])
})

test('the outbox loop does not overwrite a decision that landed on its attempt', async () => {
  reset([syncLogRow({ ...POSTED_ROW, status: 'PENDING', attemptRevision: 3 })])
  interleave = () => {
    Object.assign(store.get('log-1')!, {
      status: 'CANCELLED',
      attemptRevision: 5,
      externalTransactionId: 'XERO-OPERATOR-VERIFIED',
      errorMessage: 'Operator verified: posted',
    })
  }

  const result = await (await loadProcessor())()

  assert.equal(store.get('log-1')?.status, 'CANCELLED')
  assert.equal(store.get('log-1')?.externalTransactionId, 'XERO-OPERATOR-VERIFIED')
  assert.equal(result.failed, 1)
  assert.ok(activity.some((entry) => entry.action === 'xero_sync_post_fenced_out' && entry.level === 'ERROR'))
  // The remote work is done, so the job must complete rather than churn a re-post.
  assert.deepEqual(outboxCalls, ['success'])
})
