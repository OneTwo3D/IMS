import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A daily batch that finds its advisory lock held by another run does nothing, by design: the cron answers 200 (skipped), where a
 * genuine batch error answers 500. The real producer is driven with the lock taken, and the real route answers for its result.
 */

let lockHeldElsewhere = true
let batchResult: unknown = null

mock.module('@/lib/db/pinned-advisory-lock', { namedExports: { acquirePinnedAdvisoryLockOrNull: async () => (lockHeldElsewhere ? null : { release: async () => undefined }) } })
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })

test('the producer reports lock contention as a skip with a reason, and no error', async () => {
  lockHeldElsewhere = true
  const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
  const result = await runDailyBatchSync()
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'already-running')
  assert.deepEqual(result.errors, [])
  batchResult = result
})

test('the cron route answers 200 for the skip and 500 for a genuine batch error', async () => {
  mock.module('@/lib/connectors/xero/daily-sync', { namedExports: { runDailyBatchSync: async () => batchResult } })
  mock.module('@/lib/db', {
    namedExports: {
      db: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ cronRun: { create: async () => undefined }, activityLog: { create: async () => ({}) } }),
      },
    },
  })
  mock.module('@/lib/domain/accounting/daily-batch-sweep-schedule', { namedExports: { resolveScheduledDailyBatchSweep: async () => ({ connector: 'xero' }) } })
  const { GET } = await import('@/app/api/cron/accounting-daily-batch/route')
  const request = new Request('http://localhost/api/cron/accounting-daily-batch')
  assert.equal((await GET(request)).status, 200)
  batchResult = { groupA1: 0, groupA2: 0, groupB: 0, batchLimit: 50, hasMore: {}, errors: ['Journal rejected'] }
  assert.equal((await GET(request)).status, 500)
  assert.equal(lockHeldElsewhere, true)
})
