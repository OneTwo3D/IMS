import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

/**
 * THE WOO FOOTPRINT OF A VERIFIED PRE-CUTOVER DISPATCH IS EXACTLY IMS'S STOCK-LEVEL SYNC.
 *
 * Driven through the production path: the dispatch sweep core -> the production `applyDispatch` dep (createPrismaDispatchDeps)
 * -> the real `applyExternalFulfillmentUpdate` -> the real `updateShipmentStatus` -> the real `reconcileOrderAfterShipment`
 * -> the real `@/lib/shopping` facade. Only storage (an in-memory database), the row-level shipment transition, and the
 * WooCommerce connector modules (recorders) are doubles, and the HTTP transport is a counter that also answers the ONE read the
 * verification makes (the fresh GET of the storefront order).
 *
 * THE CONTRACT being pinned: a dispatch whose storefront order the earlier writer already completed writes NO ORDER-LEVEL
 * storefront data - no completion job, no tracking, no status - and its only storefront effect is the ordinary stock-level
 * sync (IMS is the stock master after cutover; that push sets an absolute level). Every Woo job and request is counted BY KIND:
 *   outbox rows (order-scoped durable jobs), jobs (completion attempt, tracking push, status push, stock sync), requests.
 * The ordinary post-cutover dispatch is the control: it produces the order completion as well.
 */

type Order = { id: string; status: string; shippedAt?: Date | null; trackingNumber?: string | null }
const state = {
  order: { id: 'so-1', status: 'ALLOCATED' } as Order,
  shipments: [{ id: 'ship-1', orderId: 'so-1', status: 'PACKED', trackingNumber: 'T1' }],
  outbox: [] as string[],
  jobs: [] as string[],
  requests: [] as string[],
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'op-1' } }), requireInternalUser: async () => ({ user: { id: 'op-1' } }) } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityPersisted: async () => true } })
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/dispatch-email', { namedExports: { queueDispatchEmailIfEligible: async () => { state.jobs.push('dispatch-email') } } })
mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ woocommerce: true }), isIntegrationPluginEnabled: async () => true } })
const settings = new Map<string, string>([['wc_url', 'https://shop.example.com'], ['wc_consumer_key', 'ck'], ['wc_consumer_secret', 'cs'], ['wc_webhook_secret', 's']])
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async (keys: string[]) => new Map(keys.flatMap((k) => (settings.has(k) ? [[k, settings.get(k)!] as const] : []))),
    getSettingValue: async (key: string) => settings.get(key) ?? null,
    deserializeSettingValue: (_key: string, value: string) => value,
  },
})
// The Woo transport double: a counter, and the scripted answer to the order read.
let orderRead: () => Response = () => new Response('{}', { status: 500 })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init?: { method?: string }) => {
      state.requests.push(`${init?.method ?? 'GET'} ${url}`)
      if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/wp-json/wc/v3/orders/555')) return orderRead()
      return new Response('{}', { status: 500 })
    },
  },
})
const wcOrder = (over: Record<string, unknown> = {}) => () => new Response(JSON.stringify({
  id: 555, number: '1001', status: 'completed', date_completed: '2026-05-23T10:00:00', date_completed_gmt: '2026-05-23T09:00:00',
  date_modified_gmt: '2026-05-23T09:00:20', refunds: [], line_items: [{ id: 11, quantity: 1, sku: 'SKU-1' }],
  _links: { self: [{ href: 'https://shop.example.com/wp-json/wc/v3/orders/555' }] }, ...over,
}), { status: 200, headers: { 'content-type': 'application/json' } })
// The WooCommerce connector modules the facade reaches, as recorders (one per KIND of Woo effect).
mock.module('@/lib/connectors/woocommerce/sync/stock-sync-jobs', { namedExports: { enqueueAndProcessImmediateWcStockSync: async () => { state.jobs.push('stock-sync') } } })
mock.module('@/lib/connectors/woocommerce/sync/order-completion-jobs', {
  namedExports: {
    scheduleWcOrderCompletion: async (_tx: unknown, input: { orderId: string }) => { state.outbox.push('woocommerce/order.complete'); return `key-${input.orderId}` },
    processWcOrderCompletionJobs: async () => { state.jobs.push('order-completion-attempt'); return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0, skipped: 0, errors: [] } },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/tracking-sync', { namedExports: { pushImsTrackingToWc: async () => { state.jobs.push('order-tracking-push'); return { success: true } } } })
mock.module('@/lib/connectors/woocommerce/sync/order-status', { namedExports: { pushImsStatusToWc: async () => { state.jobs.push('order-status-push'); return { kind: 'pushed' } } } })
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    allocateSalesOrder: async () => ({}), applyAllocationReservationDelta: async () => {}, buildAvailableStockMap: () => new Map(),
    canonicalAllocationQty: (v: unknown) => v, clearDormantFulfillmentPinsInTx: async () => {}, lockAccountedRecordsForScope: async () => {},
    floorAvailableStockMapToCanonicalScale: () => new Map(), lockSalesOrder: async () => {}, lockStockLevels: async () => {},
    refileAccountedRecordsForScope: async () => {}, releaseOrderAllocationsForDeallocationInTx: async () => ({ allocs: [], deletedPendingShipmentCount: 0 }),
    resetAllocationAccountingIfStaged: async () => {}, validateAllocationIntegrity: async () => {}, ALLOCATION_TX_OPTIONS: { maxWait: 5000, timeout: 20000 },
  },
})

// One in-memory database for the external-fulfilment boundary AND the real order reconcile.
const models: Record<string, unknown> = {
  shoppingOrderLink: { findFirst: async () => ({ externalOrderId: '555', externalOrderNumber: '1001', createdAt: new Date('2026-04-01T00:00:00Z') }) },
  salesOrder: {
    findUnique: async () => ({ ...state.order, orderNumber: 'SO-1', externalOrderNumber: 'WC-1', createdAt: new Date('2026-04-01T00:00:00Z'), lines: [{ sku: 'SKU-1', qty: 1, wclcFeeKind: null, productId: 'prod-1', externalLineItemId: 11 }] }),
    update: async ({ data }: { data: Partial<Order> }) => { Object.assign(state.order, data); return state.order },
  },
  orderAllocation: { count: async () => 1 },
  shipment: {
    count: async () => state.shipments.length,
    findMany: async (args?: { where?: { status?: unknown } }) => (args?.where?.status ? state.shipments.filter((s) => s.status !== 'SHIPPED').map((s) => ({ id: s.id, status: s.status })) : state.shipments),
  },
  salesOrderLine: { findMany: async () => [{ id: 'line-1', productId: 'prod-1', qty: 1, sku: 'SKU-1', description: 'P', product: { type: 'SIMPLE' } }] },
  shipmentLine: { findMany: async () => [{ lineId: 'line-1', productId: 'prod-1', qty: 1 }] },
  salesOrderRefundLine: { findMany: async () => [] },
  product: { findMany: async () => [{ id: 'prod-1', type: 'SIMPLE', fulfillmentGraphVersion: 0, productComponents: [] }] },
  setting: { findMany: async (args?: { where?: { key?: { in?: string[] } } }) => (args?.where?.key?.in ?? []).filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)!, updatedAt: new Date('2026-04-01T00:00:00Z') })), findUnique: async (args?: { where?: { key?: string } }) => (settings.has(args?.where?.key ?? '') ? { key: args!.where!.key, value: settings.get(args!.where!.key!) } : null) },
}
const db: Record<string, unknown> = new Proxy({
  $queryRaw: async () => [],
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(Object.assign(Object.create(db), { isTransaction: true })),
}, {
  get: (target, prop: string) => {
    if (prop === 'then') return undefined
    if (prop in target) return (target as Record<string, unknown>)[prop]
    if (prop in models) return models[prop]
    return new Proxy({}, { get: () => async () => null })
  },
})
mock.module('@/lib/db', { namedExports: { db } })

let installed = false
async function install() {
  if (installed) return
  installed = true
  const real = await import('@/lib/domain/sales/shipment-service')
  mock.module('@/lib/domain/sales/shipment-service', {
    namedExports: {
      ...real,
      transitionShipmentStatus: async (_c: unknown, input: { shipmentId: string; targetStatus: string }) => {
        const row = state.shipments.find((s) => s.id === input.shipmentId)!
        const previousStatus = row.status
        row.status = input.targetStatus
        state.jobs.push('stock-movement-and-cogs')
        return {
          success: true, transitioned: previousStatus !== input.targetStatus, dispatched: false, previousStatus, targetStatus: input.targetStatus,
          stockSyncProductIds: ['prod-1'],
          shipment: { id: row.id, orderId: row.orderId, lines: [], warehouse: { code: 'WH1' }, order: { orderNumber: 'SO-1', externalOrderNumber: 'WC-1' } },
        }
      },
    },
  })
}

beforeEach(() => {
  state.order = { id: 'so-1', status: 'PACKING' }
  state.shipments = [{ id: 'ship-1', orderId: 'so-1', status: 'PACKED', trackingNumber: 'T1' }]
  state.outbox.length = 0
  state.jobs.length = 0
  state.requests.length = 0
  orderRead = wcOrder()
})

const PART = { externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'TN-1', carrier: 'DPD', despatchedAt: '2026-05-20T10:00:00Z' }] }

/** The production path: sweep core + the production applyDispatch dep; only the WMS reads and the push/verify verdicts are scripted. */
async function sweep(verdict: 'pre-cutover' | 'live') {
  await install()
  const { runWmsDispatchSweepCore, createPrismaDispatchDeps } = await import('@/lib/domain/wms/dispatch-sweep')
  // Only the production applyDispatch dep is wanted from the real deps: the candidate lists and the delta/reconcile reads are scripted below.
  const { applyDispatch, verifyPreCutoverCompletion } = createPrismaDispatchDeps('mintsoft' as never, {} as never)
  const out = await runWmsDispatchSweepCore({
    applyDispatch,
    listCandidates: async () => [{ linkId: 'l1', orderId: 'so-1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => ({ externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: true, partCount: 1, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }),
    partsSupported: true,
    fetchOrderParts: async () => [PART],
    fetchPartItems: async () => [{ sku: 'SKU-1', qty: 1 }],
    repointLink: async () => {}, clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers: string[]) => new Map(numbers.map((n) => [n, 1])),
    recordDispatchError: async () => ({ deadLettered: false }),
    pushPartialShipment: async () => (verdict === 'pre-cutover'
      ? { ok: false, shadowed: true, shadowReason: 'obligation_before_cutoff', error: 'held' }
      : { ok: true }),
    verifyPreCutoverCompletion,
    screenWithdrawnOrders: async () => new Set<string>(),
  } as never)
  await new Promise((resolve) => setImmediate(resolve))
  return out
}

const kinds = (list: string[]) => [...list].sort()

test('CONTROL: an ordinary post-cutover dispatch produces the order completion (outbox row + attempt) AND the stock sync', async () => {
  const out = await sweep('live')
  assert.equal(out.counters.dispatched, 1, 'PRECONDITION: the production path dispatched')
  assert.equal(state.order.status, 'SHIPPED')
  assert.deepEqual(state.outbox, ['woocommerce/order.complete'])
  assert.ok(state.jobs.includes('order-completion-attempt'))
  assert.ok(state.jobs.includes('stock-sync'))
})

const ORDER_READ = 'GET https://shop.example.com/wp-json/wc/v3/orders/555'

test('THE CONTRACT: a verified pre-cutover dispatch produces EXACTLY the stock-level sync: zero order-scoped outbox rows, jobs or writes (one GET of the order is its whole transport footprint)', async () => {
  const out = await sweep('pre-cutover')
  assert.equal(out.counters.dispatched, 1, 'PRECONDITION: the production path dispatched')
  assert.equal(state.order.status, 'SHIPPED', 'PRECONDITION: IMS completed its own side')
  assert.ok(state.jobs.includes('stock-movement-and-cogs'), 'PRECONDITION: IMS booked the shipment')
  const woo = state.jobs.filter((j) => j !== 'stock-movement-and-cogs' && j !== 'dispatch-email')
  assert.deepEqual(state.outbox, [], 'no order-scoped durable job')
  assert.deepEqual(kinds(woo), ['stock-sync'], 'the whole Woo job set is the stock-level sync and nothing else (no completion attempt, tracking, status)')
  assert.deepEqual(state.requests, [ORDER_READ], 'and the only request is the fresh READ of the order: no write of any kind reached the transport')
})

for (const [name, read] of [
  ['reopened (processing)', () => wcOrder({ status: 'processing' })],
  ['reopened (on-hold)', () => wcOrder({ status: 'on-hold' })],
  ['completed before the despatch', () => wcOrder({ date_completed_gmt: '2026-05-19T09:00:00' })],
  ['an unreadable completion date', () => wcOrder({ date_completed_gmt: 'soon' })],
  ['a different store', () => wcOrder({ _links: { self: [{ href: 'https://other.example.org/wp-json/wc/v3/orders/555' }] } })],
  ['a read error', () => () => new Response('{}', { status: 500 })],
  ['a 404', () => () => new Response('{"code":"woocommerce_rest_shop_order_invalid_id"}', { status: 404, headers: { 'content-type': 'application/json' } })],
] as const) {
  test(`NOT VERIFIED (${name}): the order stays pending and NOTHING is written, in IMS or at the storefront`, async () => {
    orderRead = read()
    const out = await sweep('pre-cutover')
    assert.equal(out.counters.dispatched, 0)
    assert.equal(out.counters.pending, 1)
    assert.equal(state.order.status, 'PACKING', 'the IMS order is untouched')
    assert.equal(state.shipments[0]!.status, 'PACKED', 'and so is the shipment')
    assert.deepEqual(state.outbox, [])
    assert.deepEqual(state.jobs, [], 'no stock movement, no stock sync, no job of any kind')
    assert.deepEqual(state.requests, [ORDER_READ], 'only the one read')
  })
}

test('a transport that THROWS (a timeout) keeps the order pending and writes nothing', async () => {
  orderRead = () => { throw new Error('WooCommerce request timed out after 120000ms.') }
  const out = await sweep('pre-cutover')
  assert.equal(out.counters.pending, 1)
  assert.equal(state.order.status, 'PACKING')
  assert.deepEqual(state.jobs, [])
})
