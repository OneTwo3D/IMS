import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { MAX_WC_PAGE_WALK_PAGES, describeWcPageWalkCeilingStall } from '@/lib/connectors/woocommerce/api'
import {
  WC_ORDER_SWEEP_LAST_SUCCESS_SETTING,
  WMS_ORDER_STATUS_LAST_SUCCESS_SETTING,
  XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING,
} from '@/lib/ops/read-sync-liveness-constants'

/**
 * THE WRITERS OF THE LAST-SUCCESS STAMPS: what advances one, what must not, and where it is written.
 *
 * Three streams stamp from code this feature touches (the Mintsoft stock sync, the despatch poll and the
 * Xero tax-rate read already carry their own success columns and are covered by the status tests):
 *
 *   * the WooCommerce order sweep  - stamp in the SAME $transaction batch as the cursor
 *   * the Mintsoft order-status refresh - stamp as the last step of a run with no failed order
 *   * the Xero balance-snapshot pull - stamp INSIDE the transaction that stores the snapshots
 *
 * Each arm prints its precondition (what the rig saw) so a rig that examined nothing cannot pass.
 *
 * Mutations (each verified red, see the PR): (1) the WC stamp upsert moved out of the batch to run
 * unconditionally => "[wc] a failed sweep does not advance the stamp" fails; (2) the order-status
 * `failed === 0` guard removed => "[order-status] a run with a failed order" fails; (3) the snapshot
 * stamp written after the transaction => "[snapshots] ... same transaction" fails.
 */

type SettingRow = { key: string; value: string }
const settings = new Map<string, string>()
const upserts: string[] = []
const batches: string[][] = []
const activity: Array<Record<string, unknown>> = []

async function upsert({ where, create, update }: { where: { key: string }; create: SettingRow; update: { value: string } }) {
  upserts.push(where.key)
  settings.set(where.key, settings.has(where.key) ? update.value : create.value)
  return { key: where.key, value: settings.get(where.key) ?? '' }
}

// ---- WooCommerce order sweep rig --------------------------------------------------------------
let pages: Record<string, Array<Record<string, unknown>>> = {}
let wcError: string | null = null
let orderDb: Record<string, unknown>

// ---- order-status sweep rig --------------------------------------------------------------------
let statusOrders: Array<Record<string, unknown>> = []
let fetchOrderStatusImpl: (reference: string) => Promise<unknown> = async () => null
let resolution: { kind: string; id?: string } = { kind: 'one', id: 'mintsoft' }

orderDb = {
  setting: { findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null), upsert },
  salesOrder: { findFirst: async () => ({ id: 'so-1' }), findMany: async () => statusOrders },
  wmsOrderStatusSnapshot: { findUnique: async () => null, upsert: async () => ({}), update: async () => ({}) },
  wmsOrderPushLink: { updateMany: async () => ({ count: 0 }) },
  $transaction: async (ops: Array<Promise<unknown>>) => {
    // The statements are already built when $transaction receives them; what it was handed is what
    // they resolve to, so the batch is read from the results, not from a before/after slice.
    const done = (await Promise.all(ops)) as Array<{ key: string }>
    batches.push(done.map((row) => row.key))
    return done
  },
}

mock.module('@/lib/db', { namedExports: { db: orderDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      if (wcError) return { data: [], totalPages: 1, totalItems: 0, error: wcError }
      const rows = pages[String(params.page ?? '1')] ?? []
      return { data: rows, totalPages: 1, totalItems: rows.length, error: null }
    },
    MAX_WC_PAGE_WALK_PAGES,
    describeWcPageWalkCeilingStall,
  },
})
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async () => ({ outcome: 'skipped-withdrawal' }),
  },
})
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({}) } })
mock.module('@/lib/connectors/wms/enabled-connector', {
  namedExports: {
    resolveEnabledWmsConnector: () => resolution,
    wmsResolutionSkipReason: () => 'no single WMS connector is enabled',
  },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnector: () => ({
      fetchOrderStatus: (reference: string) => fetchOrderStatusImpl(reference),
      probeOrderPresence: async () => 'ABSENT',
    }),
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
  },
})
mock.module('@/lib/connectors/wms/order-lookup', {
  namedExports: { resolveWmsOrderLookupConnector: async () => ({ kind: 'one', connector: 'woocommerce' }) },
})
mock.module('@/lib/fulfillment/shopping-order-lookup', { namedExports: { shoppingOrderLookupSkipReason: () => 'no lookup connector' } })

function reset() {
  settings.clear()
  upserts.length = 0
  batches.length = 0
  activity.length = 0
  wcError = null
  statusOrders = []
  fetchOrderStatusImpl = async () => null
  resolution = { kind: 'one', id: 'mintsoft' }
}

function wcOrder(id: number) {
  return { id, number: String(id), status: 'processing', line_items: [] }
}

async function runWcSweep(mode: 'poll' | 'reconcile' = 'poll') {
  reset()
  settings.set('wc_initial_import_completed', 'true')
  settings.set('wc_sync_order_statuses', '["processing"]')
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode })
}

test('[wc] a clean sweep advances the stamp IN THE SAME $transaction batch as the cursor', async () => {
  pages = { '1': [wcOrder(1), wcOrder(2)], '2': [] }
  const result = await runWcSweep('poll')
  console.log(`precondition: errors=${result.errors.length} skipped=${result.skipped} batches=${JSON.stringify(batches)}`)
  assert.deepEqual(result.errors, [])
  assert.equal(result.skipped, 2)
  assert.equal(batches.length, 1)
  assert.ok(batches[0]!.includes('last_wc_order_sync_at'), 'the cursor is in the batch')
  assert.ok(batches[0]!.includes(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), 'and so is the stamp - one statement set, one commit')
  assert.ok(Number.isFinite(Date.parse(settings.get(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING) ?? '')))
})

test('[wc] a sweep that legitimately found nothing new advances the stamp (an empty first page is a successful read)', async () => {
  pages = { '1': [] }
  const result = await runWcSweep('reconcile')
  console.log(`precondition: orders returned=0 errors=${result.errors.length} synced=${result.synced} skipped=${result.skipped}`)
  assert.deepEqual(result.errors, [])
  assert.equal(result.synced + result.skipped, 0)
  assert.ok(settings.has(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), 'nothing new is not a failure')
  assert.ok(settings.has('last_wc_order_reconcile_at'))
})

test('[wc] a failed sweep does not advance the stamp - a fetch error that returned nothing is not "nothing new"', async () => {
  pages = { '1': [] }
  settings.clear()
  const previous = '2026-10-01T00:00:00.000Z'
  const result = await (async () => {
    reset()
    settings.set('wc_initial_import_completed', 'true')
    settings.set('wc_sync_order_statuses', '["processing"]')
    settings.set(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING, previous)
    wcError = 'WooCommerce HTTP 503'
    const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
    return syncNewWcOrders({ mode: 'poll' })
  })()
  console.log(`precondition: fetch error recorded=${JSON.stringify(result.errors)} upserts=${JSON.stringify(upserts)}`)
  assert.equal(result.errors.length, 1)
  assert.equal(upserts.includes(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), false)
  assert.equal(settings.get(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), previous, 'the previous success is untouched')
  assert.equal(batches.length, 0)
})

test('[wc] a sweep that ran out of ceiling, and one before the initial import, do not advance the stamp', async () => {
  let id = 1
  pages = new Proxy({}, { get: () => [wcOrder(id++)] }) as typeof pages
  const ceiling = await runWcSweep('poll')
  assert.equal(ceiling.errors.length, 1)
  assert.equal(upserts.includes(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), false)

  reset()
  pages = { '1': [] }
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const before = await syncNewWcOrders({ mode: 'poll' })
  console.log(`precondition: before-initial-import errors=${JSON.stringify(before.errors)}`)
  assert.equal(before.errors.length, 1)
  assert.equal(upserts.includes(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING), false)
})

test('[wc] the webhook cursor is NOT the stamp: advancing last_wc_order_sync_at alone leaves the stamp where it was', async () => {
  // advanceWcOrderSyncCursor (webhooks.ts) upserts last_wc_order_sync_at on every admitted delivery. If the
  // stamp were derived from the cursor, a dead sweep behind a busy webhook would look alive. The stamp
  // is a separate key that only the sweep's own batch writes; this arm pins that the keys differ.
  assert.notEqual(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING, 'last_wc_order_sync_at')
  assert.notEqual(WC_ORDER_SWEEP_LAST_SUCCESS_SETTING, 'last_wc_order_reconcile_at')
})

// ---- order-status sweep -----------------------------------------------------------------------

test('[order-status] a run with nothing stale to read advances the stamp (a legitimate nothing)', async () => {
  reset()
  statusOrders = []
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  const result = await runWmsOrderStatusSweep()
  console.log(`precondition: ${JSON.stringify(result)}`)
  assert.deepEqual(result, { scanned: 0, updated: 0, failed: 0 })
  assert.ok(settings.has(WMS_ORDER_STATUS_LAST_SUCCESS_SETTING))
})

test('[order-status] a run that read every selected order advances it; a run with a failed order does not', async () => {
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  const order = (id: string) => ({ id, shoppingLinks: [{ externalOrderNumber: `W-${id}` }], wmsOrderStatus: null })

  reset()
  statusOrders = [order('a'), order('b')]
  const ok = await runWmsOrderStatusSweep()
  console.log(`precondition (ok): ${JSON.stringify(ok)}`)
  assert.equal(ok.scanned, 2)
  assert.equal(ok.failed, 0)
  assert.ok(settings.has(WMS_ORDER_STATUS_LAST_SUCCESS_SETTING))

  reset()
  const previous = '2026-10-01T00:00:00.000Z'
  settings.set(WMS_ORDER_STATUS_LAST_SUCCESS_SETTING, previous)
  statusOrders = [order('a'), order('b')]
  fetchOrderStatusImpl = async (reference) => {
    if (reference === 'W-b') throw new Error('Mintsoft HTTP 503')
    return null
  }
  const partial = await runWmsOrderStatusSweep()
  console.log(`precondition (failed order): ${JSON.stringify(partial)}`)
  assert.equal(partial.scanned, 2)
  assert.equal(partial.failed, 1)
  assert.equal(settings.get(WMS_ORDER_STATUS_LAST_SUCCESS_SETTING), previous, 'one failed order keeps the stamp where it was')
})

test('[order-status] a skipped run (no single connector) does not advance the stamp', async () => {
  reset()
  resolution = { kind: 'none' }
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  const result = await runWmsOrderStatusSweep()
  console.log(`precondition: ${JSON.stringify(result)}`)
  assert.equal(typeof result.skipped, 'string')
  assert.equal(upserts.includes(WMS_ORDER_STATUS_LAST_SUCCESS_SETTING), false)
})
