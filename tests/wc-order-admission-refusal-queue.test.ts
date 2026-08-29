import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v r5: AN ACKNOWLEDGED REFUSAL MUST STILL REACH THE ORDER.
 *
 * A refusal returns 200. WooCommerce's retries are finite and a redelivery re-hits the identical
 * rule, so acknowledging is right — and acknowledging means WooCommerce NEVER SENDS THAT ORDER
 * AGAIN. Round 4's recovery was entirely cursor-shaped: a refusal does not advance the pull cursor,
 * and a WIDENED selection rewinds it to a watermark. Both are real, and neither is a guarantee:
 *
 *   - the next ADMITTED delivery advances the cursor straight past the refused order;
 *   - the rewind fires only when a stored selection fingerprint proves a widening, so a refusal
 *     recorded before any sweep wrote one is never reached;
 *   - and a delivery refused because it LOST A RACE to a concurrent create was refused against an
 *     order IMS holds, which the design says is never gated — no read placed anywhere can fix that,
 *     because the create it raced commits after the read returns.
 *
 * So the refusal writes a durable row naming the ORDER, and the fifteen-minute sweep re-reads it BY
 * ID. These tests drive the real `importWcOrder` and the real `drainWcOrderAdmissionRefusals`
 * against one in-memory store with a real unique constraint on the order link, and the race test
 * INTERLEAVES TWO DELIVERIES rather than asserting a helper's return value.
 */

type Row = Record<string, unknown>

type OrderRow = { id: string; status: string }

const store = {
  orders: new Map<string, OrderRow>(),
  /** externalOrderId -> salesOrder id. The unique constraint that arbitrates a concurrent create. */
  links: new Map<string, string>(),
  syncLogs: [] as Array<Row & { id: string }>,
  settings: new Map<string, string>(),
  statusMappings: [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }] as Row[],
  activity: [] as Row[],
  /** Live storefront statuses the drain will read back, by order id. */
  live: new Map<string, string>(),
  liveReadable: true,
  updatedOrderIds: [] as string[],
  /** Resolved when the parked delivery reaches its window; awaited by the test. */
  parkAt: null as null | { orderId: string; reached: () => void; release: Promise<void> },
}

let nextId = 1
const newId = (prefix: string) => `${prefix}-${nextId++}`

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { store.activity.push(entry) } },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string) => {
      const id = path.replace('/orders/', '')
      const status = store.live.get(id)
      if (!store.liveReadable || !status) return { data: null, error: 'unreadable', totalPages: 0, totalItems: 0 }
      return { data: wcOrder(Number(id), status), totalPages: 1, totalItems: 1 }
    },
    wcPut: async () => ({ data: null }),
  },
})

// --- the create path, modelled only as far as it takes to actually CREATE ------------------
mock.module('@/lib/connectors/woocommerce/sync/field-mapping', {
  namedExports: {
    mapWcAddress: () => ({}),
    upsertCustomer: async () => 'cust-1',
    mapWcLineItems: async () => [],
    mapWcOrderDiscount: () => ({ discountStr: null, discountAmount: 0 }),
    mapWcFeeLines: () => [],
    mapWcShipping: () => ({ shippingForeign: 0, shippingService: null }),
    resolveWcTaxRateById: async () => ({
      taxRateId: null, taxRateName: null, taxRateValue: 0, accountingTaxType: null, reverseCharge: false,
    }),
    getFxRateToGbp: async () => 1,
    isMissingFxRateError: () => false,
    readWcCustomerVat: () => null,
    resolveWcOrderLevelDiscount: () => ({ orderLevelDiscount: 0, unallocated: 0 }),
  },
})
mock.module('@/lib/tax/resolve-rate', { namedExports: { resolveLineTaxRateBatch: async () => new Map() } })
mock.module('@/lib/connectors/shopping-registry', {
  namedExports: { getShoppingConnectorPrefixes: async () => ({ orderPrefix: 'WC-', invPrefix: 'WCI-' }) },
})
mock.module('@/app/actions/allocation', { namedExports: { autoAllocateOrder: async () => ({ success: true }) } })
mock.module('@/lib/accounting', {
  namedExports: {
    queueAccountingSync: async () => {},
    getAccountingSettings: async () => ({
      salesAccount: '200', shippingAccount: '', discountAccount: '', reverseChargeSalesTaxType: null,
    }),
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async () => null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, undefined])),
  },
})

/**
 * Every delegate the importer touches, built once so the top-level client and the TRANSACTION client
 * are the same store. Two divergent copies is how a create inside a transaction silently failed.
 */
function txDelegates() {
  return {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = store.settings.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      // THE PARK. `wc_sync_order_statuses` is read between the pivot and the refusal, but the
      // read is what has to be delayed, not the write — see setting.findUnique above.
      store.settings.set(where.key, update.value)
      return {}
    },
  },
  salesOrder: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const some = (where as {
        shoppingLinks?: { some?: { connector?: string; externalOrderId?: string } }
      }).shoppingLinks?.some
      if (!some) return { id: [...store.orders.keys()][0] ?? null } as never
      const orderId = store.links.get(String(some.externalOrderId))
      return orderId ? { id: orderId } : null
    },
    create: async ({ data }: { data: Row }) => {
      const externalOrderId = String(
        ((data.shoppingLinks as { create?: { externalOrderId?: string } })?.create)?.externalOrderId,
      )
      // The @@unique([connector, externalOrderId]) that arbitrates two concurrent creates.
      if (store.links.has(externalOrderId)) {
        const error = new Error('Unique constraint failed') as Error & { code?: string }
        error.code = 'P2002'
        throw error
      }
      const id = newId('so')
      store.orders.set(id, { id, status: String(data.status) })
      store.links.set(externalOrderId, id)
      return { id }
    },
    update: async () => ({}),
  },
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }) },
  shoppingStatusMapping: {
    findMany: async ({ where }: { where: { OR?: Array<{ externalStatus?: { equals?: string } }> } }) => {
      const wanted = (where.OR ?? [])
        .map((clause) => String(clause.externalStatus?.equals ?? '').toLowerCase())
      return store.statusMappings.filter(
        (row) => wanted.includes(String(row.externalStatus).toLowerCase()),
      )
    },
  },
  shoppingSyncLog: {
    create: async ({ data }: { data: Row }) => {
      const row = { ...data, id: newId('log'), createdAt: new Date() }
      store.syncLogs.push(row)
      return row
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = store.syncLogs.find((entry) => entry.id === where.id)
      if (row) Object.assign(row, data)
      return row ?? {}
    },
    findFirst: async ({ where }: { where: Row }) => matchLogs(where)[0] ?? null,
    findMany: async ({ where }: { where: Row }) => matchLogs(where),
    count: async () => 0,
  },
  product: { findMany: async () => [] },
  taxRate: { findMany: async () => [] },
  warehouse: { findMany: async () => [] },
  user: { findMany: async () => [] },
  }
}

/**
 * THE TRANSACTION CLIENT IS THE SAME STORE, not a two-delegate stub (merged since this file was
 * written: o3d-rbyg/o3d-lvk moved the order CREATE inside the transaction that also writes the
 * shopping link, so the unique constraint arbitrates a concurrent create atomically).
 *
 * A stub carrying only `salesOrder.update` made every create inside a transaction throw
 * "tx.salesOrder.create is not a function", which the importer records as an ordinary FAILED sync
 * row — so the drain reported `unresolved` and the tests below were about a run that never created
 * anything. The `update` override stays, because `updatedOrderIds` is what the status-application
 * assertions read.
 */
function txClient() {
  const base = txDelegates()
  return {
    ...base,
    salesOrder: {
      ...base.salesOrder,
      update: async ({ where }: { where: { id: string } }) => {
        store.updatedOrderIds.push(where.id)
        return {}
      },
    },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...txDelegates(),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient()),
    },
  },
})

function matchLogs(where: Row) {
  const path = (where.payload as { path?: string[]; equals?: unknown } | undefined)
  return store.syncLogs.filter((row) => {
    if (where.status && row.status !== where.status) return false
    if (where.externalId && row.externalId !== where.externalId) return false
    if (where.entityType && row.entityType !== where.entityType) return false
    if (path?.path) {
      const payload = row.payload as Record<string, unknown> | undefined
      if (!payload || payload[path.path[0]] !== path.equals) return false
    }
    return true
  })
}

const WDRAW = { submitted: 'pending-wdraw', approved: 'withdrawn' }

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => WDRAW,
    importWcOrderGuarded: async (
      order: { id: number },
      run: () => Promise<{ success: boolean; skipped?: string; orderId?: string }>,
    ) => {
      void order
      return { outcome: 'imported' as const, suppressionHandled: false, compensationFailed: false, result: await run() }
    },
    recordWithdrawalSuppressionIfWithdrawn: async () => {},
    applyWithdrawalToLinkedOrder: async () => false,
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { syncWcOrderStatus: async () => ({ success: true }) },
})
mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    // o3d-okbd/o3d-ecbj r5 (merged since): the sweep returns whether it read EVERY page, and the
    // webhook fails the delivery when it did not. A double answering `undefined` makes
    // `refundSweep.complete` throw, and the delivery 500s for a reason that has nothing to do
    // with the admission gate under test.
    syncRefundsForOrder: async () => ({ synced: 0, fetched: 0, unapplied: 0, outstanding: 0, complete: true }),
    syncWcRefund: async () => ({ outcome: 'applied' }),
    // o3d-xnwu r4: the webhook imports these two from the same module, so a double that replaces the
    // module must supply them or the handler calls `undefined`.
    refundIsInIms: (outcome: string) => outcome === 'applied' || outcome === 'already-applied',
    refundOutcomeFailed: (outcome: string) => outcome === 'retryable-failure' || outcome === 'quarantined-refusal' || outcome === 'permanent-failure',
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-webhook-echo', {
  namedExports: { shouldSuppressWcOrderWebhookEcho: async () => ({ suppress: false }) },
})

function wcOrder(id: number, status: string) {
  return {
    id,
    number: String(id),
    status,
    order_key: `wc_order_${id}`,
    currency: 'GBP',
    total: '0.00',
    prices_include_tax: false,
    date_created_gmt: '2026-08-01T09:00:00',
    date_modified_gmt: '2026-08-01T10:00:00',
    billing: {}, shipping: {},
    line_items: [], fee_lines: [], tax_lines: [], shipping_lines: [], coupon_lines: [], meta_data: [],
  }
}

function reset() {
  store.orders.clear()
  store.links.clear()
  store.syncLogs.length = 0
  store.activity.length = 0
  store.live.clear()
  store.liveReadable = true
  store.updatedOrderIds.length = 0
  store.statusMappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]
  store.settings = new Map([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
  ])
}

async function importOrder(order: ReturnType<typeof wcOrder>) {
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return importWcOrder(order as never)
}

async function drain() {
  const { drainWcOrderAdmissionRefusals } = await import('@/lib/connectors/woocommerce/sync/order-admission')
  return drainWcOrderAdmissionRefusals()
}

/** Rows still OUTSTANDING in the refusal queue. A resolved row keeps its payload but leaves PENDING. */
function queued() {
  return store.syncLogs.filter(
    (row) => (row.payload as { queue?: string } | undefined)?.queue === 'wc_order_admission_refusal'
      && row.status === 'PENDING',
  )
}

// --- the queue is what reaches an order the cursors have passed ------------------------------

test('an order refused behind the cursors is imported by the BY-ID drain once its status is ticked', async () => {
  reset()
  // Refused: `on-hold` is not selected. The cursor is irrelevant to what happens next, which is
  // the point — this drain reads by order id.
  const refused = await importOrder(wcOrder(301, 'on-hold'))
  assert.equal(refused.skipped, 'status_not_admitted')
  assert.equal(queued().length, 1, 'the refusal left a durable row naming the order')
  assert.equal(store.links.has('301'), false)

  // The operator ticks `on-hold`. WooCommerce fires nothing for a setting IMS changed, and the
  // delivery was acknowledged, so nothing will ever push this order again.
  store.settings.set('wc_sync_order_statuses', JSON.stringify(['processing', 'on-hold']))
  store.statusMappings.push({ externalStatus: 'on-hold', imsStatus: 'ON_HOLD' })
  store.live.set('301', 'on-hold')

  const result = await drain()

  assert.equal(result.imported, 1, 'the drain must import it, with no webhook and no cursor involved')
  assert.equal(store.links.get('301') !== undefined, true, 'IMS now holds the order')
  assert.equal(queued().length, 0, 'and the queue row is resolved, not left to be re-read forever')
})

test('an order whose status is STILL excluded stays queued rather than being imported or dropped', async () => {
  // The discriminating half. A drain that imported everything it found would be a bypass of the
  // very boundary it exists to serve, and one that deleted the row would strand the order.
  reset()
  await importOrder(wcOrder(302, 'on-hold'))
  store.live.set('302', 'on-hold')

  const result = await drain()

  assert.equal(result.imported, 0)
  assert.equal(result.stillRefused, 1)
  assert.equal(store.links.has('302'), false, 'the selection still excludes it')
  assert.equal(queued().length, 1, 'and it is still queued for the next sweep')
  assert.equal(queued()[0].status, 'PENDING')
})

test('an order that becomes MAPPABLE is imported by the same drain, on the same row', async () => {
  // The other refusal reason, recovered by the same route: the fix is a mapping rather than a tick.
  reset()
  store.settings.set('wc_sync_order_statuses', JSON.stringify(['processing', 'awaiting-parts']))
  const refused = await importOrder(wcOrder(303, 'awaiting-parts'))
  assert.equal(refused.skipped, 'status_not_mapped')

  store.statusMappings.push({ externalStatus: 'awaiting-parts', imsStatus: 'ON_HOLD' })
  store.live.set('303', 'awaiting-parts')

  const result = await drain()

  assert.equal(result.imported, 1)
  assert.equal(queued().length, 0)
})

test('an order that cannot be read stays queued and is reported unresolved, not retired', async () => {
  reset()
  await importOrder(wcOrder(304, 'on-hold'))
  store.liveReadable = false

  const result = await drain()

  assert.equal(result.unresolved, 1)
  assert.equal(result.retired, 0, 'an unreadable order must never be dropped from the queue')
  assert.equal(queued().length, 1)
})

test('re-refusing the same order updates its row instead of growing the queue', async () => {
  // A store that pushes the same excluded order on every edit would otherwise accumulate one row
  // per delivery, and the drain would re-read the same order once per row every fifteen minutes.
  reset()
  await importOrder(wcOrder(305, 'on-hold'))
  await importOrder(wcOrder(305, 'on-hold'))
  await importOrder(wcOrder(305, 'on-hold'))

  assert.equal(queued().length, 1, 'one row per ORDER, not one per delivery')
  const payload = queued()[0].payload as Record<string, unknown>
  assert.equal(payload.externalOrderId, '305')
})

// --- the interleave the pivot read cannot see ------------------------------------------------

/**
 * TWO DELIVERIES, RUN TOGETHER, against one store.
 *
 * The excluded delivery is parked at the settings read that sits between its pivot read and its
 * refusal — the real window, not a simulated one. While it is parked the admitted delivery runs to
 * completion and COMMITS THE CREATE. The excluded delivery then finishes on an answer that has
 * already stopped being true: it read "IMS does not hold this order", and IMS does.
 *
 * What is asserted is the END STATE, because that is the only thing that can be made correct here:
 * the refusal is acknowledged (it must be — WooCommerce's retries are finite), and the row it left
 * is what brings the order back.
 */
async function interleavedDeliveries(): Promise<void> {
  let releaseParked: () => void = () => {}
  const parked = new Promise<void>((resolve) => { releaseParked = resolve })
  let reachedResolve: () => void = () => {}
  const reached = new Promise<void>((resolve) => { reachedResolve = resolve })

  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { db } = await import('@/lib/db') as unknown as { db: { setting: { findUnique: (a: unknown) => Promise<unknown> } } }
  const realFindUnique = db.setting.findUnique
  let parkedOnce = false
  db.setting.findUnique = async (args: unknown) => {
    const key = (args as { where: { key: string } }).where.key
    if (key === 'wc_sync_order_statuses' && !parkedOnce) {
      parkedOnce = true
      reachedResolve()
      await parked
    }
    return realFindUnique(args)
  }

  // A is excluded and will be parked in its window; B is admitted and creates.
  const a = importWcOrder(wcOrder(310, 'on-hold') as never)
  await reached
  const b = await importWcOrder(wcOrder(310, 'processing') as never)
  assert.equal(b.orderId !== undefined, true, 'the admitted delivery created the order')

  releaseParked()
  const aResult = await a
  db.setting.findUnique = realFindUnique

  assert.equal(
    aResult.skipped,
    'status_not_admitted',
    'this is the defect being pinned: A refuses against an order IMS now holds',
  )
}

test('a refusal that LOST A RACE to a concurrent create is repaired by the queue, not lost', async () => {
  reset()

  await interleavedDeliveries()

  // The order exists — B created it — and A's refusal is queued against the same order id.
  assert.equal(store.links.has('310'), true)
  assert.equal(queued().length, 1, 'A left a durable row rather than an acknowledged silence')

  // The sweep re-reads it by id. IMS holds it now, so the importer takes the UPDATE branch, which
  // is never gated — the invariant A's stale read broke is restored without any status changing.
  store.live.set('310', 'on-hold')
  const result = await drain()

  assert.equal(result.imported, 1, 'the raced delivery is applied to the order IMS holds')
  assert.deepEqual(store.updatedOrderIds, [store.links.get('310')], 'as an UPDATE, not a second create')
  assert.equal(queued().length, 0)
})

test('the constraint still arbitrates two ADMITTED creates, and the loser becomes an update', async () => {
  // The other half of the race, and the one round 4 already settled. Kept next to the refusal case
  // so the two answers stay visibly different: a create that loses is turned into an update by the
  // P2002 handler; a REFUSAL that loses cannot be, which is why it needs the queue.
  reset()

  const [first, second] = await Promise.all([
    importOrder(wcOrder(311, 'processing')),
    importOrder(wcOrder(311, 'processing')),
  ])

  assert.equal(store.orders.size, 1, 'exactly one order exists')
  assert.equal(first.orderId, second.orderId, 'and both deliveries resolved to it')
  assert.equal(queued().length, 0, 'neither was refused')
})

// --- finding 1: the recovery routes obey the rule the rest of the pipeline obeys --------------

async function retryFx() {
  const { retryPendingWcOrdersWaitingForFx } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return retryPendingWcOrdersWaitingForFx()
}

function queueFxOrder(id: number, status: string) {
  store.syncLogs.push({
    id: newId('log'),
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    status: 'PENDING',
    entityType: 'SalesOrder',
    externalId: String(id),
    createdAt: new Date(),
    payload: {
      reason: 'missing_fx_rate',
      connector: 'woocommerce',
      externalOrderId: String(id),
      externalOrderNumber: String(id),
      currency: 'USD',
      asOf: null,
      order: wcOrder(id, status),
    },
  })
}

test('the pending-FX RETRY obeys the selection too — it was the route round 4 left open', async () => {
  // Round 3 gated the webhook and left `sweepWithdrawalSuppressions` open; round 4 gated that and
  // left THIS one open. It replays a stored snapshot by id: no `?status=` query, no cursor, nothing
  // upstream that filtered it — the identical shape, one file over. The fix is that the gate is the
  // DEFAULT, so the route did not have to be found for it to be covered.
  reset()
  queueFxOrder(320, 'on-hold')

  const result = await retryFx()

  assert.deepEqual(store.updatedOrderIds, [])
  assert.equal(store.links.has('320'), false, 'an excluded status must not enter IMS by the FX retry either')
  assert.equal(result.imported, 0, 'and it must not be COUNTED as imported, which a bare success would')
  assert.equal(result.failed, 1)
  assert.equal(queued().length, 1, 'it moves to the by-id refusal queue, which is where it is recoverable')
})

test('the FX retry DISCRIMINATES — a queued order in a selected status still imports', async () => {
  // Paired: "the FX retry does not import an excluded order" also passes if it imports nothing.
  reset()
  queueFxOrder(321, 'processing')

  const result = await retryFx()

  assert.equal(result.imported, 1)
  assert.equal(store.links.has('321'), true)
  assert.equal(queued().length, 0, 'nothing was refused, so nothing is queued')
})

test('a refused FX row is RETIRED, not left pending to be re-read on every FX refresh', async () => {
  reset()
  queueFxOrder(322, 'on-hold')

  await retryFx()
  const fxRows = store.syncLogs.filter(
    (row) => (row.payload as { reason?: string } | undefined)?.reason === 'missing_fx_rate',
  )

  assert.equal(fxRows.length, 1)
  assert.equal(fxRows[0].status, 'FAILED', 'the FX queue is not this order\'s problem any more')
  assert.match(String(fxRows[0].errorMessage), /Import order statuses/)
})
