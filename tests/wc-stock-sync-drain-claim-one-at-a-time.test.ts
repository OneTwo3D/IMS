import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-l0nml: the WooCommerce stock.push drain claims ONE job when its attempt starts (claimLimit 1 + excludeIds), never a batch of 25 up
 * front sharing one lockedAt, and stops claiming when its wall-clock budget is spent. Outbox, WooCommerce push and DB are doubled; nothing
 * touches the network.
 * Named mutation (shown red): the claim reverted to one batch call with `limit` and no claimLimit.
 */
type Job = { id: string; lockedAt: Date | null; updatedAt: Date; attempts: number; payloadJson: unknown }
let nowMs = 0
const claimCalls: Array<{ claimLimit?: number; limit?: number; excludeIds?: string[]; lockedAt: number }> = []
const pushed: string[] = []
let queue: string[] = []

mock.module('@/lib/db', {
  namedExports: { db: { integrationOutbox: { updateMany: async () => ({ count: 1 }), findUnique: async () => null }, stockSyncState: { upsert: async () => ({}) }, productComponent: { findMany: async () => [] } } },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/connectors/woocommerce/producer-egress', { namedExports: { wooDrainHold: () => ({ held: false }) } })
mock.module('@/lib/connectors/woocommerce/sync/stock-sync', {
  namedExports: {
    pushStockToWc: async (o: { productIds: string[] }) => {
      pushed.push(o.productIds[0])
      nowMs += 60_000 // each push takes a minute of the fake clock
      return { synced: 1, errors: [], message: 'ok' }
    },
  },
})
mock.module('@/lib/domain/integrations/outbox', {
  namedExports: {
    buildOutboxIdempotencyKey: (...p: string[]) => p.join(':'),
    INTEGRATION_OUTBOX_STATUS: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCEEDED: 'SUCCEEDED' },
    enqueueIntegrationOutbox: async () => ({}),
    isOutboxEnqueueShadowed: () => false,
    markIntegrationOutboxPermanentFailure: async () => undefined,
    markIntegrationOutboxRetryableFailure: async () => undefined,
    currentOutboxRowBeforeCutoff: async () => null,
    outboxRowBeforeCutoff: async () => null,
    refuseClaimedJobBeforeCutoff: async () => null,
    claimIntegrationOutboxWork: async (o: { claimLimit?: number; limit?: number; excludeIds?: string[] }) => {
      claimCalls.push({ claimLimit: o.claimLimit, limit: o.limit, excludeIds: o.excludeIds ? [...o.excludeIds] : undefined, lockedAt: nowMs })
      const take = o.claimLimit ?? o.limit ?? 25
      const ids = queue.filter((id) => !(o.excludeIds ?? []).includes(id)).slice(0, take)
      queue = queue.filter((id) => !ids.includes(id))
      return ids.map((id): Job => ({
        id, lockedAt: new Date(nowMs), updatedAt: new Date(nowMs), attempts: 0,
        payloadJson: { productId: `p-${id}`, reason: 'IMS_CHANGE', force: false, webhookQty: null },
      }))
    },
  },
})

test('claims one job at a time, each stamped when its own attempt starts', async () => {
  nowMs = 0; claimCalls.length = 0; pushed.length = 0; queue = ['a', 'b', 'c']
  const { processQueuedWcStockSyncJobs } = await import('../lib/connectors/woocommerce/sync/stock-sync-jobs.ts')
  const summary = await processQueuedWcStockSyncJobs({ migrateLegacy: false, clock: () => new Date(nowMs) })
  assert.equal(summary.processed, 3)
  assert.equal(summary.errors.length, 0, summary.errors.join('|'))
  assert.ok(claimCalls.every((c) => c.claimLimit === 1), 'every claim asks for exactly one job')
  assert.deepEqual(claimCalls.slice(0, 3).map((c) => c.lockedAt), [0, 60_000, 120_000], 'each job is locked when its attempt starts, not all at t0')
  assert.deepEqual(claimCalls[2].excludeIds, ['a', 'b'])
})

test('stops claiming once the wall-clock budget is spent', async () => {
  nowMs = 0; claimCalls.length = 0; pushed.length = 0; queue = ['a', 'b', 'c', 'd', 'e']
  const { processQueuedWcStockSyncJobs } = await import('../lib/connectors/woocommerce/sync/stock-sync-jobs.ts')
  const summary = await processQueuedWcStockSyncJobs({ migrateLegacy: false, clock: () => new Date(nowMs), drainBudgetMs: 90_000 })
  assert.equal(summary.processed, 2, 'jobs started at t=0 and t=60s; the drain stops at t=120s > 90s')
  assert.equal(queue.length, 3, 'the rest stay queued, unclaimed')
})
