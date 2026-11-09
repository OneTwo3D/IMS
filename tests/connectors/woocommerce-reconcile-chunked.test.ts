import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The daily forceAll stock reconcile works through the catalogue in id-ordered windows with a persisted cursor, so that one
 * cron request never reads the whole catalogue from WooCommerce. These tests drive runWcReconcile with a scripted stock push.
 */

const CURSOR_KEY = 'wc_stock_daily_reconcile_cursor'
const STAMP_KEY = 'last_wc_stock_daily_reconcile_at'

const settings = new Map<string, string>()
const upserts: string[] = []
const deletes: string[] = []

const fakeDb = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => (settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key) } : null),
    upsert: async (args: { where: { key: string }; update: { value: string } }) => {
      upserts.push(args.where.key)
      settings.set(args.where.key, args.update.value)
      return null
    },
    deleteMany: async (args: { where: { key: string } }) => {
      deletes.push(args.where.key)
      settings.delete(args.where.key)
      return { count: 1 }
    },
  },
}

type PushArgs = { forceAll?: boolean; chunk?: { afterId: string | null; limit: number } }
const pushCalls: PushArgs[] = []
let script: Array<Record<string, unknown>> = []

const activities: string[] = []
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: { level?: string; action?: string }) => { activities.push(`${e.level}:${e.action}`) }, logActivityPersisted: async () => true } })
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    isWcOrderWebhookPrimaryActive: async () => true,
    retryHeldWcSalesInvoiceReleases: async () => ({}),
    syncNewWcOrders: async () => ({}),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: { isWcProductWebhookPrimaryActive: async () => true, syncAllWcProducts: async () => ({}) },
})
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', { namedExports: { processQueuedWcStockSyncJobs: async () => ({ processed: 0 }) } })
mock.module('@/lib/connectors/woocommerce/sync/refund-stock-correction', { namedExports: { queueRefundStockCorrections: async () => ({}) } })
mock.module('@/lib/connectors/woocommerce/sync/stock-sync', {
  namedExports: {
    pushStockToWc: async (args: PushArgs) => {
      pushCalls.push(args)
      const next = script.shift()
      assert.ok(next, 'the push was called more often than scripted')
      return { synced: 0, skipped: 0, errors: [], candidates: 0, matched: 0, unmatched: 0, pushed: false, message: '', unmatchedSkuSample: [], ...next }
    },
  },
})

function reset(script_: Array<Record<string, unknown>>) {
  settings.clear()
  upserts.length = 0
  deletes.length = 0
  pushCalls.length = 0
  activities.length = 0
  script = script_
  settings.set('wc_stock_sync_enabled', 'true')
  settings.set('last_wc_order_reconcile_at', new Date().toISOString())
}

const done = (nextCursor: string | null) => ({ chunk: { nextCursor, totalCandidates: 400 }, synced: 3 })

test('a catalogue that fits in the request budget is reconciled in windows and stamped once, at the end', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([done('p-150'), done('p-300'), done(null)])
  const results = await runWcReconcile()
  assert.deepEqual(pushCalls.map((call) => call.chunk?.afterId), [null, 'p-150', 'p-300'])
  assert.ok(pushCalls.every((call) => call.forceAll === true && (call.chunk?.limit ?? 0) > 0))
  assert.equal(upserts.filter((key) => key === STAMP_KEY).length, 1, 'stamped exactly once')
  assert.deepEqual(upserts.filter((key) => key === CURSOR_KEY), [CURSOR_KEY, CURSOR_KEY], 'cursor saved after each window that left more')
  assert.ok(deletes.includes(CURSOR_KEY), 'cursor cleared at the end of the pass')
  assert.equal(settings.has(CURSOR_KEY), false)
  assert.equal((results.stock as { chunks?: number }).chunks, 3)
})

test('a request past its budget saves the cursor, does not stamp, and the next run resumes from it even though a day has not passed', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([done('p-150')])
  const realNow = Date.now
  let calls = 0
  // First read is the run start; every later read is 60 s on, i.e. past the budget.
  Date.now = () => (calls++ === 0 ? 1_000_000 : 1_060_000)
  try {
    const results = await runWcReconcile()
    const stock = results.stock as { reason?: string; resumeAfter?: string }
    assert.equal(stock.reason, 'reconciliation_continues_next_run')
    assert.equal(stock.resumeAfter, 'p-150')
  } finally {
    Date.now = realNow
  }
  assert.equal(pushCalls.length, 1, 'one window only')
  assert.equal(settings.get(CURSOR_KEY), 'p-150')
  assert.ok(!upserts.includes(STAMP_KEY), 'an unfinished pass is not stamped')

  // The next run: a stamp from an hour ago says "not due", but the cursor says the pass is unfinished.
  settings.set(STAMP_KEY, new Date(Date.now() - 3600_000).toISOString())
  script = [done(null)]
  pushCalls.length = 0
  await runWcReconcile()
  assert.equal(pushCalls[0].chunk?.afterId, 'p-150', 'resumes after the saved cursor')
  assert.equal(settings.has(CURSOR_KEY), false)
  assert.ok(upserts.includes(STAMP_KEY), 'stamped when the pass reaches the end')
})

test('with no cursor and a fresh stamp the reconcile does not run', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([])
  settings.set(STAMP_KEY, new Date().toISOString())
  const results = await runWcReconcile()
  assert.equal(pushCalls.length, 0)
  assert.equal((results.stock as { reason?: string }).reason, 'daily_reconciliation_not_due')
})

test('a window that did not finish keeps the cursor and the stamp where they were, and is retried', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([{ message: 'WooCommerce API unreachable during preflight' }])
  settings.set(CURSOR_KEY, 'p-150')
  const results = await runWcReconcile()
  assert.equal((results.stock as { reason?: string }).reason, 'reconciliation_window_incomplete')
  assert.equal(settings.get(CURSOR_KEY), 'p-150')
  assert.ok(!upserts.includes(STAMP_KEY))
})

test('a first window refused outright (setting, credentials) ends the pass and stamps exactly as before', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([{ aborted: true, message: 'WooCommerce credentials are not configured' }])
  await runWcReconcile()
  assert.ok(upserts.includes(STAMP_KEY))
})

test('a held or shadowed window stops the pass without stamping and leaves the cursor', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([done('p-150'), { held: true, aborted: true }])
  const results = await runWcReconcile()
  assert.equal((results.stock as { reason?: string }).reason, 'outbound_write_held')
  assert.equal(settings.get(CURSOR_KEY), 'p-150')
  assert.ok(!upserts.includes(STAMP_KEY))
})

test('a first window that did not finish (no cursor yet, not a gate refusal) is not stamped either, and says so in the activity log', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([{ message: 'partial failure', errors: ['lookup failure for SKU X: boom'] }])
  const results = await runWcReconcile()
  assert.equal((results.stock as { reason?: string }).reason, 'reconciliation_window_incomplete')
  assert.ok(!upserts.includes(STAMP_KEY), 'no stamp over a window with failed products')
  assert.ok(!upserts.includes(CURSOR_KEY), 'no cursor advance')
  assert.deepEqual(activities, ['WARNING:stock_reconcile_window'])
})

test('a later window with failed products holds the pass at that window: cursor stays, no stamp, a warning each run', async () => {
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  reset([done('p-150'), { errors: ['batch push 1: boom'] }])
  const results = await runWcReconcile()
  assert.equal((results.stock as { resumeAfter?: string }).resumeAfter, 'p-150')
  assert.equal(settings.get(CURSOR_KEY), 'p-150')
  assert.ok(!upserts.includes(STAMP_KEY))
  assert.equal(activities.length, 1)
})
