import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The Xero accounting.post drain claims each job when its attempt is about to start (claimLimit 1), not a whole batch up
 * front, and stops claiming once its wall-clock budget is spent. A batch claim stamps every job with one `lockedAt` while
 * the jobs are posted one after another, so a job at the back could age past the lease before its attempt began.
 */

process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = 'true'

type ClaimOptions = { limit?: number; claimLimit?: number; excludeIds?: string[]; wooAccountingJobIds?: readonly string[] }
let wooIdReads = 0
const claimCalls: ClaimOptions[] = []
const outboxCalls: string[] = []

const JOBS = ['job-1', 'job-2', 'job-3'].map((id, index) => ({
  id,
  connector: 'xero',
  operation: 'post_accounting_event',
  idempotencyKey: id,
  payloadJson: { accountingSyncLogId: `missing-log-${index}` },
  status: 'PROCESSING',
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  lockedAt: new Date('2026-08-19T09:30:00.000Z'),
  lockedBy: 'xero-accounting-sync',
  createdAt: new Date('2026-08-19T09:00:00.000Z'),
  updatedAt: new Date('2026-08-19T09:30:00.000Z'),
}))

const dbStub = {
  accountingSyncLog: { findUnique: async () => null, findMany: async () => [], count: async () => 0, updateMany: async () => ({ count: 0 }) },
  activityLog: { create: async () => ({ id: 'a' }), findFirst: async () => null },
  $executeRaw: async () => 1,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbStub),
}

mock.module('@/lib/db', { namedExports: { db: dbStub } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async () => {},
    logActivityPersisted: async () => true,
    redactActivityLogText: (value: string) => value,
    sanitizeActivityLogMetadata: (value: unknown) => value,
  },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: { updateMirroredAccountingEventStatus: async () => {}, voidMirroredAccountingEventsForOrder: async () => {} },
})
mock.module('@/lib/connectors/xero/outbox', {
  namedExports: {
    XERO_OUTBOX_CONNECTOR: 'xero',
    XERO_ACCOUNTING_POST_OPERATION: 'post_accounting_event',
    scheduleXeroAccountingOutbox: async () => JOBS[0],
    parseXeroAccountingOutboxPayload: (row: { payloadJson: { accountingSyncLogId: string } }) => row.payloadJson,
  },
})
mock.module('@/lib/domain/integrations/outbox', {
  namedExports: {
    INTEGRATION_OUTBOX_STATUS: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCEEDED: 'SUCCEEDED', RETRYABLE_FAILED: 'RETRYABLE_FAILED', PERMANENT_FAILED: 'PERMANENT_FAILED' },
    wooAccountingPostJobIds: async () => { wooIdReads++; return [] },
    claimIntegrationOutboxWork: async (options: ClaimOptions) => {
      claimCalls.push({ limit: options.limit, claimLimit: options.claimLimit, excludeIds: [...(options.excludeIds ?? [])] })
      // The real claim honours claimLimit and excludeIds; a stub that ignored them would hand out the whole batch.
      const due = JOBS.filter((job) => !(options.excludeIds ?? []).includes(job.id))
      return due.slice(0, options.claimLimit ?? due.length)
    },
    markIntegrationOutboxSuccess: async () => { outboxCalls.push('success') },
    markIntegrationOutboxRetryableFailure: async () => { outboxCalls.push('retry') },
    markIntegrationOutboxPermanentFailure: async () => { outboxCalls.push('permanent') },
  },
})

async function load() {
  return (await import('@/lib/connectors/xero/sync-processor')).processPendingXeroSyncViaOutbox
}

test('each job is claimed on its own, when its attempt begins', async () => {
  claimCalls.length = 0
  outboxCalls.length = 0
  wooIdReads = 0
  const drain = await load()

  const result = await drain()

  assert.equal(wooIdReads, 1, 'the unbounded WooCommerce-job-id query runs once per drain, not once per claim (o3d-jvup3)')

  assert.equal(result.failed, 3)
  assert.ok(claimCalls.length >= 3)
  assert.ok(claimCalls.every((call) => call.claimLimit === 1), 'a batch claim stamps every job with one lockedAt')
  assert.deepEqual(claimCalls.slice(0, 3).map((call) => call.excludeIds), [[], ['job-1'], ['job-1', 'job-2']])
  assert.deepEqual(outboxCalls, ['permanent', 'permanent', 'permanent'])
})

test('a drain whose wall-clock budget is spent stops claiming and leaves the rest queued', async () => {
  claimCalls.length = 0
  outboxCalls.length = 0
  const drain = await load()
  let tick = 0

  const result = await drain({ drainBudgetMs: 1500, now: () => (tick += 1000) })

  // Reads of the clock: start (1000), then 2000 > budget? elapsed 1000 -> claim job-1; 3000 elapsed 2000 -> stop.
  assert.equal(claimCalls.length, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(outboxCalls, ['permanent'])
})
