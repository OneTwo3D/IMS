import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'

/**
 * EVERY WOOCOMMERCE WRITE PATH, DRIVEN WITH THE SWITCH ON AND THE TRANSPORT ALLOWED.
 *
 * The worst posture for the hold: PRODUCER_HOLD_ENFORCED_DESTINATIONS names woocommerce, the outbound-write grant for the
 * store IS set (so the transport hold would let a write through), and no live-from instant is set. Only the producer hold
 * stands between a trigger and the store. Each trigger below is driven through the real code (database faked, every
 * connector module real) and the transport boundary (@/lib/security/connector-fetch) is a COUNTER, so "no write" is an
 * observed zero and the CONTROL arm (switch off, same trigger) observes a non-zero: the counter can see a write.
 *
 * Two layers stop a write, and a test of the outer layer cannot tell you the inner one is alive (two sufficient fixes mask
 * each other's mutation). So every arm names the signal ONLY ITS LAYER produces: the SEAM leaves a shadow record and never
 * reaches the connector function; the BARRIER (tests/connectors/woocommerce-egress-control.test.ts) is what the transport
 * counter proves on its own.
 *
 * Named mutations: see the header of woocommerce-producer-seam.test.ts (a to f); this file kills a, b, d, e and f.
 */

const ORIGIN = 'https://shop.example.com'
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce, PRODUCER_CUTOFF_ENV.woocommerce]
const SEAM_ON = { [PRODUCER_HOLD_ENFORCED_ENV]: 'woocommerce', [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  try { return await fn() } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ───────────────────────── a recording database that answers "nothing here" ─────────────────────────

const calls: string[] = []
const shadows: Array<{ operation: string; subjectType: string; subjectId: string }> = []
const settings = new Map<string, string>()
const transport: string[] = []

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_target, method: string) => async (args?: { where?: { key?: string }; data?: Record<string, unknown> }) => {
      calls.push(`${name}.${method}`)
      if (name === 'setting' && (method === 'findUnique' || method === 'findFirst')) {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      switch (method) {
        case 'findMany': return []
        case 'findUnique': case 'findFirst': return null
        case 'count': return 0
        case 'updateMany': return { count: 1 }
        case 'deleteMany': return { count: 0 }
        case 'create': return { id: `${name}-1`, ...(args?.data ?? {}) }
        default: return {}
      }
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$queryRaw') {
      return async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const text = (query.strings ?? []).join('?')
        calls.push('$queryRaw')
        if (!text.includes('outbound_shadow_writes')) return []
        const values = query.values ?? []
        shadows.push({ operation: String(values[1]), subjectType: String(values[2]), subjectId: String(values[3]) })
        return [{ id: `shadow-${shadows.length}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
      }
    }
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$executeRawUnsafe') return undefined
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => ({ woocommerce: true }), isIntegrationPluginEnabled: async () => true },
})
const settingValues = async (keys: string[]) => new Map(keys.flatMap((key) => (settings.has(key) ? [[key, settings.get(key)!] as const] : [])))
mock.module('@/lib/settings-store', {
  namedExports: { getSettingValues: settingValues, getSettingValue: async (key: string) => settings.get(key) ?? null },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    // The counter at the transport boundary. It answers with a refusal-shaped 500 so nothing downstream parses a body.
    connectorFetch: async (url: string, init?: { method?: string }) => {
      transport.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
  },
})

// One mock of the product-sync module for the whole file (a module can be mocked once): the product push delegates to a handler the
// tests swap, and the reconcile's two reads are inert.
let productPush: (id: string) => Promise<{ success: boolean }> = async () => ({ success: true })
mock.module('@/lib/connectors/woocommerce/sync/product-sync', {
  namedExports: {
    pushImsProductToWc: (id: string) => productPush(id),
    isWcProductWebhookPrimaryActive: async () => true,
    syncAllWcProducts: async () => ({}),
  },
})

function reset() {
  calls.length = 0
  shadows.length = 0
  transport.length = 0
  settings.clear()
  for (const [key, value] of Object.entries({
    wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_webhook_secret: 's', wc_fx_push_enabled: 'true',
    wc_stock_sync_enabled: 'true',
  })) settings.set(key, value)
}
const writes = () => transport.filter((entry) => !entry.startsWith('GET '))

// ───────────────────────── facade: the directs ─────────────────────────

test('FACADE, product metadata: OFF reaches the connector; ON leaves a shadow and never reaches it', async () => {
  const connectorCalls: string[] = []
  productPush = async (id: string) => { connectorCalls.push(id); return { success: true } }
  const { pushProductMetadata } = await import('@/lib/shopping')
  reset()
  await withEnv({}, async () => {
    assert.deepEqual(await pushProductMetadata('p-1'), { success: true })
    assert.deepEqual(connectorCalls, ['p-1'], 'CONTROL: switch off, the connector is reached')
    assert.equal(shadows.length, 0)
  })
  connectorCalls.length = 0
  await withEnv(SEAM_ON, async () => {
    const result = await pushProductMetadata('p-1')
    console.log(`# product meta ON: ${JSON.stringify(result)} shadows=${JSON.stringify(shadows)}`)
    assert.equal(result.success, false)
    assert.equal(result.shadowed, true)
    assert.match(result.error ?? '', /^Not sent by IMS: writes to WooCommerce are held/)
    assert.deepEqual(connectorCalls, [], 'the connector function is never reached')
    assert.deepEqual(shadows, [{ operation: 'product.meta', subjectType: 'Product', subjectId: 'p-1' }])
  })
})

test('FACADE, tracking, partial shipment, WMS status, FX rates: each ON leaves its own shadow and reaches no connector; OFF reaches it', async () => {
  const hit: string[] = []
  mock.module('@/lib/connectors/woocommerce/sync/tracking-sync', { namedExports: { pushImsTrackingToWc: async () => { hit.push('tracking'); return { success: true } } } })
  mock.module('@/lib/connectors/woocommerce/sync/partial-shipment', { namedExports: { pushPartialShipmentToWc: async () => { hit.push('partial'); return { supported: true, ok: true } } } })
  mock.module('@/lib/connectors/woocommerce/sync/wms-status', { namedExports: { pushWmsOrderStatusToWc: async () => { hit.push('wms'); return { success: true } } } })
  mock.module('@/lib/connectors/woocommerce/fx-rates', { namedExports: { pushCurrentFxRatesToWc: async () => { hit.push('fx'); return { supported: true, pushed: 2, errors: [] } } } })
  const shopping = await import('@/lib/shopping')
  const drive = async () => ({
    tracking: await shopping.pushOrderDeliveryMetadata('o-1'),
    partial: await shopping.pushPartialShipmentToShopping('o-1', { part: 1, totalParts: 2, items: [{ sku: 'A', qty: 1 }] }),
    wms: await shopping.pushWmsOrderStatusToShopping('o-1', { status: 'PROCESSING', statusLabel: 'Processing', connectorLabel: 'Mintsoft', deepLinkUrl: null }),
    fx: await shopping.pushFxRatesToConnectors(),
  })
  reset()
  await withEnv({}, async () => {
    const out = await drive()
    assert.deepEqual(hit.sort(), ['fx', 'partial', 'tracking', 'wms'], 'CONTROL: switch off, all four connectors are reached')
    assert.equal(out.tracking.success, true)
    assert.equal(out.fx[0]!.pushed, 2)
    assert.equal(shadows.length, 0)
  })
  hit.length = 0
  reset()
  await withEnv(SEAM_ON, async () => {
    const out = await drive()
    console.log(`# facade ON: ${JSON.stringify(out)} shadows=${JSON.stringify(shadows.map((s) => s.operation))}`)
    assert.deepEqual(hit, [], 'no connector function is reached')
    assert.deepEqual(shadows.map((s) => s.operation).sort(), ['fx-rates', 'order.partial-shipment', 'order.tracking', 'order.wms-status-meta'])
    // Not success, not skipped, and shadow-marked: a caller that stamps "pushed" on success is never told it was.
    for (const result of [out.tracking, out.partial, out.wms]) {
      assert.equal(result.success, false)
      assert.equal(result.shadowed, true)
      assert.equal(result.skipped, undefined)
    }
    assert.deepEqual(out.fx, [{ connector: 'woocommerce', supported: true, pushed: 0, errors: [], shadowed: true }], 'not a failure either: no FAILED log row, no errors')
    assert.ok(!calls.includes('fxRatePushLog.create'), 'no fx push log row (neither OK nor FAILED)')
  })
})

test('FACADE, sales order status (the drain): ON hands back unsent with the queued wording and records no new shadow; OFF reaches the connector', async () => {
  const hit: string[] = []
  mock.module('@/lib/connectors/woocommerce/sync/order-status', { namedExports: { pushImsStatusToWc: async () => { hit.push('status'); return { kind: 'pushed' } } } })
  const { pushSalesOrderStatus } = await import('@/lib/shopping')
  reset()
  await withEnv({}, async () => {
    const result = await pushSalesOrderStatus('o-1', 'SHIPPED')
    assert.equal(result.success, true)
    assert.deepEqual(hit, ['status'])
  })
  hit.length = 0
  await withEnv(SEAM_ON, async () => {
    const result = await pushSalesOrderStatus('o-1', 'SHIPPED')
    assert.equal(result.success, false)
    assert.equal(result.shadowed, true)
    assert.match(result.error ?? '', /This queued entry was handed back unsent/)
    assert.deepEqual(hit, [])
    assert.equal(shadows.length, 0, 'the queued row is the work: nothing new is recorded')
  })
})

// ───────────────────────── stock: the enqueue, the writer, the drain, the reconcile ─────────────────────────

test('STOCK, every trigger below the import: enqueueStockSync queues nothing and pushes nothing when ON; the writer and the drain stand down', async () => {
  const { enqueueStockSync } = await import('@/lib/shopping')
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const { processQueuedWcStockSyncJobs } = await import('@/lib/connectors/woocommerce/sync/stock-sync-jobs')

  // CONTROL: switch off. The facade enqueues (an outbox create) and the immediate processing claims it (a findMany).
  reset()
  await withEnv({ [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }, async () => {
    await enqueueStockSync(['p-1'], 'IMS_CHANGE')
  })
  console.log(`# stock control (switch off): ${JSON.stringify(calls.filter((c) => c.startsWith('integrationOutbox')))}`)
  assert.ok(calls.includes('integrationOutbox.create'), 'CONTROL: the enqueue creates a queued row when the switch is off')
  assert.ok(calls.includes('integrationOutbox.findMany'), 'CONTROL: the immediate processing claims it')

  // ON: nothing created, nothing claimed, nothing sent, one shadow per product.
  reset()
  await withEnv(SEAM_ON, async () => {
    await enqueueStockSync(['p-1', 'p-2'], 'IMS_CHANGE')
    await enqueueStockSync(['p-3'], 'WC_WEBHOOK', { force: true, webhookQty: 4 })
  })
  console.log(`# stock ON: outbox calls=${JSON.stringify(calls.filter((c) => c.startsWith('integrationOutbox')))} shadows=${JSON.stringify(shadows.map((s) => s.subjectId))} transport=${transport.length}`)
  assert.deepEqual(shadows.map((s) => s.subjectId).sort(), ['p-1', 'p-2', 'p-3'], 'precondition: the seam ran and recorded each product')
  assert.ok(shadows.every((s) => s.operation === 'stock' && s.subjectType === 'Product'))
  assert.ok(!calls.includes('integrationOutbox.create'), 'no queued row')
  assert.ok(!calls.includes('integrationOutbox.findMany'), 'nothing claimed: the immediate processing found no scope')
  assert.equal(writes().length, 0)

  // The writer called DIRECTLY (the manual push, the reconcile, a webhook correction): a shadow, not a push.
  reset()
  await withEnv(SEAM_ON, async () => {
    const result = await pushStockToWc({ forceAll: true, source: 'MANUAL' })
    assert.equal(result.shadowed, true)
    assert.equal(result.aborted, true, 'a caller that does not know about shadows reads it as "not pushed"')
    assert.equal(result.pushed, false)
    assert.match(result.message, /^Not sent by IMS/)
    assert.deepEqual(shadows.map((s) => [s.operation, s.subjectType]), [['stock', 'StockPush']])
    assert.ok(!calls.includes('warehouse.findMany'), 'the writer stopped before it read anything to push')
  })
  // The setting still decides first: with the stock-sync setting off there is no shadow (IMS would not have pushed anyway).
  reset()
  settings.set('wc_stock_sync_enabled', 'false')
  await withEnv(SEAM_ON, async () => {
    const result = await pushStockToWc({ forceAll: true, source: 'MANUAL' })
    assert.equal(result.shadowed, undefined)
    assert.equal(result.message, 'Stock sync is disabled in settings')
    assert.equal(shadows.length, 0)
  })

  // The drain: a queued row from before enforcement stays untouched.
  reset()
  await withEnv(SEAM_ON, async () => {
    const summary = await processQueuedWcStockSyncJobs({ limit: 100 })
    assert.deepEqual(summary, { processed: 0, synced: 0, failed: 0, errors: [], held: true })
    assert.ok(!calls.includes('integrationOutbox.findMany'), 'nothing claimed')
    assert.ok(!calls.includes('stockSyncJob.findMany'), 'nothing migrated')
  })
  reset()
  await withEnv({ [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }, async () => {
    await processQueuedWcStockSyncJobs({ limit: 100 })
    assert.ok(calls.includes('integrationOutbox.findMany'), 'CONTROL: the same drain claims when the switch is off')
  })
})

test('STOCK, the daily reconcile: a push the hold shadowed does NOT stamp last_wc_stock_daily_reconcile_at; a push that ran does', async () => {
  mock.module('@/lib/connectors/woocommerce/sync/order-import', {
    namedExports: {
      isWcOrderWebhookPrimaryActive: async () => true,
      retryHeldWcSalesInvoiceReleases: async () => ({}),
      syncNewWcOrders: async () => ({}),
    },
  })
  const { runWcReconcile } = await import('@/lib/connectors/woocommerce/sync/reconcile')
  const stamped = () => calls.filter((c) => c === 'setting.upsert').length
  // CONTROL: switch off. The push runs (it ends at the credentials gate with the fake database) and the stamp is written.
  reset()
  settings.set('last_wc_order_reconcile_at', new Date().toISOString())
  await withEnv({}, async () => {
    const results = await runWcReconcile()
    console.log(`# reconcile control: ${JSON.stringify(results.stock)}`)
    assert.equal(stamped(), 1, 'CONTROL: the reconcile stamps when the push ran')
  })
  reset()
  settings.set('last_wc_order_reconcile_at', new Date().toISOString())
  await withEnv(SEAM_ON, async () => {
    const results = await runWcReconcile()
    const stock = results.stock as { reason?: string; reconciliationDue?: boolean; sync?: { shadowed?: boolean }; queued?: { held?: boolean } }
    console.log(`# reconcile ON: ${JSON.stringify(stock)} upserts=${stamped()}`)
    assert.equal(stamped(), 0, 'no stamp')
    assert.equal(stock.reason, 'producer_hold_shadowed')
    assert.equal(stock.reconciliationDue, true)
    assert.equal(stock.sync?.shadowed, true)
    assert.equal(stock.queued?.held, true)
    assert.equal(shadows.length, 1)
  })
})

// ───────────────────────── orders: the in-transaction schedule and the drains ─────────────────────────

test('ORDER JOBS: shipping, cancelling or holding an order commits with a shadow and NO job when ON; OFF creates the job', async () => {
  const { scheduleWcOrderCompletion } = await import('@/lib/connectors/woocommerce/sync/order-completion-jobs')
  const { scheduleWcOrderCancel, scheduleWcOrderHold } = await import('@/lib/connectors/woocommerce/sync/order-status-jobs')
  const tx = fakeDb as never
  const link = { id: 'link-1' }
  const txWithLink = new Proxy(fakeDb, { get: (target, prop) => (prop === 'shoppingOrderLink' ? { findFirst: async () => link } : (target as never)[prop as never]) }) as never
  void tx
  reset()
  await withEnv({}, async () => {
    const key = await scheduleWcOrderCompletion(txWithLink, { orderId: 'o-1', shippedAt: new Date('2026-06-01T00:00:00Z') })
    assert.match(String(key), /^woocommerce:order\.complete:o-1:/, 'CONTROL: OFF returns the job key')
    assert.ok(calls.includes('integrationOutbox.create'))
    const cancel = await scheduleWcOrderCancel(txWithLink, { orderId: 'o-1', flippedAt: new Date('2026-06-01T00:00:00Z') })
    assert.equal(cancel?.operation, 'order.cancel')
  })
  reset()
  await withEnv(SEAM_ON, async () => {
    const shipped = await scheduleWcOrderCompletion(txWithLink, { orderId: 'o-1', shippedAt: new Date('2026-06-01T00:00:00Z') })
    const cancelled = await scheduleWcOrderCancel(txWithLink, { orderId: 'o-1', flippedAt: new Date('2026-06-01T00:00:00Z') })
    const held = await scheduleWcOrderHold(txWithLink, { orderId: 'o-1', flippedAt: new Date('2026-06-01T00:00:00Z') })
    console.log(`# order jobs ON: ${JSON.stringify([shipped, cancelled, held])} shadows=${JSON.stringify(shadows.map((s) => [s.operation, s.subjectId]))}`)
    assert.deepEqual([shipped, cancelled, held], [null, null, null], 'no durable job exists, which is what null means to every caller')
    assert.ok(!calls.includes('integrationOutbox.create'))
    assert.equal(shadows.length, 3)
    assert.ok(shadows.every((s) => s.operation === 'order.status' && s.subjectType === 'SalesOrder' && s.subjectId === 'o-1'))
  })
})

test('ORDER JOB DRAINS: the completion and the cancel/hold drains claim nothing while held; OFF they claim', async () => {
  const { processWcOrderCompletionJobs } = await import('@/lib/connectors/woocommerce/sync/order-completion-jobs')
  const { processWcOrderStatusJobs } = await import('@/lib/connectors/woocommerce/sync/order-status-jobs')
  reset()
  await withEnv({ [OUTBOUND_GRANT_ENV.woocommerce]: ORIGIN }, async () => {
    await processWcOrderCompletionJobs({ idempotencyKeys: ['k'] })
    await processWcOrderStatusJobs({ idempotencyKeys: ['k'] })
    assert.ok(calls.filter((c) => c === 'integrationOutbox.findMany').length >= 3, 'CONTROL: the drains read the queue when the switch is off')
  })
  reset()
  await withEnv(SEAM_ON, async () => {
    const completion = await processWcOrderCompletionJobs({ idempotencyKeys: ['k'] })
    const status = await processWcOrderStatusJobs({ idempotencyKeys: ['k'] })
    assert.deepEqual(completion, { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] })
    assert.deepEqual(status, { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, skipped: 0, errors: [] })
    assert.ok(!calls.includes('integrationOutbox.findMany'), 'nothing claimed, no attempt spent')
    assert.ok(!calls.includes('integrationOutbox.updateMany'))
  })
})

// ───────────────────────── operator actions ─────────────────────────

test('OPERATOR ACTIONS: register webhooks, push FX now and the FX probe each leave a shadow when ON and nothing when OFF', async () => {
  const seam = await import('@/lib/connectors/woocommerce/operator-action-seam')
  reset()
  await withEnv({}, async () => {
    assert.equal(await seam.wooWebhookRegistrationShadow(), null)
    assert.equal(await seam.wooFxRatePushShadow(), null)
    assert.equal(await seam.wooFxHelperProbeShadow(), null)
    assert.equal(shadows.length, 0)
  })
  await withEnv(SEAM_ON, async () => {
    const results = [await seam.wooWebhookRegistrationShadow(), await seam.wooFxRatePushShadow(), await seam.wooFxHelperProbeShadow()]
    for (const result of results) assert.match(result?.notice ?? '', /^Not sent by IMS: writes to WooCommerce are held/)
    assert.deepEqual(shadows.map((s) => [s.operation, s.subjectType]), [['webhooks', 'WebhookRegistration'], ['fx-rates', 'FxRates'], ['fx-rates', 'FxHelperProbe']])
  })
})

// ───────────────────────── the dispatch sweep reads a shadowed partial shipment as neither a failure nor a push ─────────────────────────

test('DISPATCH: a split order whose part push was shadowed is pending and unresolved: no error counted, no dead-letter streak, the order is NOT completed', async () => {
  const { runWmsDispatchSweepCore } = await import('@/lib/domain/wms/dispatch-sweep')
  const base = {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => ({
      externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: 1,
      isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null,
    }),
    partsSupported: true,
    fetchOrderParts: async () => [{ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'TN-A', carrier: 'DPD', despatchedAt: '2026-06-01T10:00:00Z' }] }],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    repointLink: async () => {},
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
  }
  const run = async (push: (input: { despatchedAt?: Date | null }) => Promise<{ ok: boolean; error?: string; shadowed?: boolean }>) => {
    const recorded: string[] = []
    let applied = 0
    const out = await runWmsDispatchSweepCore({
      ...base,
      applyDispatch: async () => { applied += 1; return { success: true } },
      pushPartialShipment: async (_orderId: string, input: { despatchedAt?: Date | null }) => push(input),
      recordDispatchError: async (_c: unknown, reason: string) => { recorded.push(reason); return { deadLettered: false } },
    } as never)
    return { out, recorded, applied }
  }
  const shadowed = await run(async () => ({ ok: false, shadowed: true, error: 'Not sent by IMS: writes to WooCommerce are held' }))
  console.log(`# dispatch shadowed: counters=${JSON.stringify(shadowed.out.counters)} recorded=${JSON.stringify(shadowed.recorded)} applied=${shadowed.applied}`)
  assert.equal(shadowed.out.counters.errors, 0)
  assert.equal(shadowed.out.counters.dispatched, 0)
  assert.equal(shadowed.out.counters.pending, 1)
  assert.deepEqual(shadowed.recorded, [], 'no failure is recorded, so no streak and no dead-letter however long the hold lasts')
  assert.equal(shadowed.applied, 0, 'the IMS order is not completed off a part nobody recorded')
  // CONTROL: an ordinary failed push IS an error and records a failure (so the arm above distinguishes the two).
  const failed = await run(async () => ({ ok: false, error: 'WC unreachable' }))
  assert.equal(failed.out.counters.errors, 1)
  assert.deepEqual(failed.recorded, ['WC unreachable'])
  // The business-event time reaches the push: the latest tracking despatch time of the part.
  let seen: Date | null | undefined
  await run(async (input) => { seen = input.despatchedAt; return { ok: true } })
  assert.equal(seen?.toISOString(), '2026-06-01T10:00:00.000Z')
})
