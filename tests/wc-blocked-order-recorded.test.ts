import assert from 'node:assert/strict'
import { cursorRaw } from './helpers/cursor-raw'
import test, { mock } from 'node:test'

/**
 * AN ORDER A GUARD BLOCKS IS RECORDED, LISTED, AND IMPORTED BY ID ONCE THE CAUSE IS FIXED.
 *
 * The tax-rate fallback guard used to return a bare `{ success: false }`. The initial import and the
 * `modified_after` sweep carried on past it and moved their cursor beyond an order nothing would ever
 * read again. These drive the REAL `importWcOrder`, `drainWcOrderAdmissionRefusals`, the Exceptions
 * loader's queue predicate and the REAL `runInitialImport` against one in-memory store, with a line
 * whose WooCommerce tax rate is mapped only after the operator "fixes" it.
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
  taxMapped: false,
  notices: [] as Row[],
  outstandingRefunds: 0,
  refundReads: [] as number[],
  refundReadFails: false,
  /** WooCommerce order id -> refund ids the storefront holds. */
  wcRefunds: new Map<string, number[]>(),
  appliedRefunds: new Set<number>(),
  /** What the storefront lists for `/orders`. */
  listed: [] as Array<Record<string, unknown>>,
  /** Order ids whose live payload carries the unmapped-rate line. */
  blockedIds: new Set<string>(),
  /** Set to make every sync-log write fail, to prove an unrecorded block holds the pass. */
  failLogWrites: false,
  updatedOrderIds: [] as string[],
  /** Resolved when the parked delivery reaches its window; awaited by the test. */
  parkAt: null as null | { orderId: string; reached: () => void; release: Promise<void> },
}

let nextId = 1
const newId = (prefix: string) => `${prefix}-${nextId++}`

mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { store.activity.push(entry) } },
})
// The per-storefront-order first-import session lock needs a real database; the fake arbitrates with its unique constraint instead.
mock.module('@/lib/connectors/woocommerce/sync/first-import-lock', { namedExports: { acquireWcFirstImportLock: async () => async () => undefined, wcFirstImportLockHeld: () => false, withWcFirstImportLock: async (_id: unknown, fn: () => Promise<unknown>) => fn(), WcFirstImportLockUnavailable: class extends Error {} } })
mock.module('@/lib/connectors/woocommerce/sync/erasure-obligation', { namedExports: { recordWcErasureObligation: async () => undefined, hasOpenWcErasureObligation: async () => false, retireWcErasureObligation: async () => undefined, payloadCustomerTombstoned: async () => false } })
mock.module('@/lib/domain/erasure/customer-key-lock', { namedExports: { lockStorefrontCustomerKeys: async () => [] } })
mock.module('@/lib/notifications', { namedExports: { notify: (entry: Row) => { store.notices.push(entry) } } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    MAX_WC_PAGE_WALK_PAGES: 5,
    describeUnendedWcPageWalk: (what: string) => `${what} never reached an empty page`,
    describeUnreadWcPage: (what: string, page: number, error: string) => `${what}: page ${page} unreadable: ${error}`,
    wcFetch: async (path: string, params?: Record<string, string>) => {
      if (path === '/orders') {
        const rows = Number(params?.page ?? '1') === 1 ? store.listed : []
        return { data: rows, totalPages: 1, totalItems: store.listed.length, error: null }
      }
      if (path === '/reports/orders/totals') return { data: null, error: 'unreadable', totalPages: 0, totalItems: 0 }
      const id = path.replace('/orders/', '')
      const status = store.live.get(id)
      if (!store.liveReadable || !status) return { data: null, error: 'unreadable', totalPages: 0, totalItems: 0 }
      return { data: store.blockedIds.has(id) ? blockedOrder(Number(id), status) : wcOrder(Number(id), status), totalPages: 1, totalItems: 1 }
    },
    wcPut: async () => ({ data: null }),
  },
})

// --- the create path, modelled only as far as it takes to actually CREATE ------------------
mock.module('@/lib/connectors/woocommerce/sync/field-mapping', {
  namedExports: {
    mapWcAddress: () => ({}),
    upsertCustomer: async () => 'cust-1',
    // A line marked `blocked` carries WooCommerce rate id 5 (unmapped until the operator maps it); any other line carries rate 6 (always mapped).
    mapWcLineItems: async (items: Array<{ blocked?: boolean }>) => items.map((item, index) => ({
      productId: null, sku: item.blocked ? 'BLOCK-1' : 'OK-1', description: 'Line', qty: 1, unitPriceForeign: 10, discountAmount: 0,
      discountStr: null, taxForeign: 2, externalTaxRateId: item.blocked ? 5 : 6, externalLineItemId: index + 1,
    })),
    mapWcOrderDiscount: () => ({ discountStr: null, discountAmount: 0 }),
    mapWcFeeLines: () => [],
    readWclcOrderComponents: () => ({ dutyComponent: null, taxComponent: null, handlingComponent: null }),
    mapWcShipping: () => ({ shippingForeign: 0, shippingService: null }),
    // The WooCommerce rate id 5 is UNMAPPED until the operator maps it (`store.taxMapped`): unmapped, the
    // line falls through to the order default at 20%, which the guard refuses.
    resolveWcTaxRateById: async (id: number | null) => (id === 6
      ? { taxRateId: 'rate-20', taxRateName: 'Standard', taxRateValue: 0.2, accountingTaxType: 'OUTPUT2', reverseCharge: false, source: 'mapped' as const }
      : id === 5
      ? {
          taxRateId: store.taxMapped ? 'rate-20' : null, taxRateName: 'Standard', taxRateValue: 0.2,
          accountingTaxType: 'OUTPUT2', reverseCharge: false, source: store.taxMapped ? 'mapped' as const : 'default' as const,
        }
      : { taxRateId: null, taxRateName: null, taxRateValue: 0, accountingTaxType: null, reverseCharge: false }),
    getFxRateToBase: async () => 1,
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
    findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in
      .filter((key) => store.settings.has(key))
      .map((key) => ({ key, value: store.settings.get(key) as string })),
    deleteMany: async () => ({ count: 0 }),
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      // THE PARK. `wc_sync_order_statuses` is read between the pivot and the refusal, but the
      // read is what has to be delayed, not the write — see setting.findUnique above.
      store.settings.set(where.key, update.value)
      return {}
    },
  },
  salesOrder: {
    // The existing-order branch asks whether a sales invoice is still owed by the order: not in this store.
    findUnique: async () => ({ salesInvoiceOwedAt: null }),
    findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const some = (where as {
        shoppingLinks?: { some?: { connector?: string; externalOrderId?: string } }
      } | undefined)?.shoppingLinks?.some
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
  shoppingOrderLink: { updateMany: async () => ({ count: 1 }), findFirst: async () => null, findMany: async () => [] },
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
      if (store.failLogWrites && (data.payload as { queue?: string } | undefined)?.queue === 'wc_order_admission_refusal') {
        throw new Error('the sync log is unavailable')
      }
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
    findUnique: async ({ where }: { where: { id: string } }) => store.syncLogs.find((entry) => entry.id === where.id) ?? null,
    updateMany: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = store.syncLogs.find((entry) => entry.id === where.id)
      if (row) Object.assign(row, data)
      return { count: row ? 1 : 0 }
    },
    findMany: async ({ where }: { where: Row }) => matchLogs(where),
    count: async () => 0,
  },
  // The existing-order branch asks whether an invoice enqueue failure is on record with nothing behind it: none here.
  accountingSyncLog: { findFirst: async () => null },
  product: { findMany: async () => [] },
  taxRate: { findMany: async () => [], findFirst: async () => null, findUnique: async () => null },
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
    // The order row lock, the customer row lock (FOR UPDATE; the customer is not erased) and the erasure-marker read.
    $queryRaw: async () => [],
    $executeRaw: cursorRaw((key, value) => { store.settings.set(key, value) }),
    salesOrder: {
      ...base.salesOrder,
      findUnique: async () => ({ erasedAt: null }),
      updateMany: async () => ({ count: 1 }),
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
      $executeRaw: cursorRaw((key, value) => { store.settings.set(key, value) }),
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
    // Applies the refunds the storefront holds for the order, once each (the real sweep dedupes by WooCommerce refund id).
    syncRefundsForOrder: async (wcOrderId: number) => {
      store.refundReads.push(wcOrderId)
      if (store.refundReadFails) return { synced: 0, fetched: 0, unapplied: 0, outstanding: 0, complete: false, error: 'refund read failed' }
      for (const refundId of store.wcRefunds.get(String(wcOrderId)) ?? []) store.appliedRefunds.add(refundId)
      return { synced: 0, fetched: 0, unapplied: store.outstandingRefunds, outstanding: store.outstandingRefunds, complete: true }
    },
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
    line_items: [{}], fee_lines: [], tax_lines: [], shipping_lines: [], coupon_lines: [], meta_data: [],
  }
}

function reset() {
  store.orders.clear()
  store.links.clear()
  store.syncLogs.length = 0
  store.activity.length = 0
  store.live.clear()
  store.liveReadable = true
  store.taxMapped = false
  store.notices.length = 0
  store.outstandingRefunds = 0
  store.refundReads.length = 0
  store.refundReadFails = false
  store.wcRefunds.clear()
  store.appliedRefunds.clear()
  store.listed = []
  store.blockedIds.clear()
  store.failLogWrites = false
  store.updatedOrderIds.length = 0
  store.statusMappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]
  store.settings = new Map([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
  ])
}

/** The same order with one line on WooCommerce tax rate 5, which IMS cannot resolve until `store.taxMapped`. */
function blockedOrder(id: number, status = 'processing') {
  return { ...wcOrder(id, status), line_items: [{ blocked: true }] }
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


/** The queue rows Sync > Exceptions lists, evaluated from the REAL predicate the loader uses. */
async function listedAsBlocked() {
  const { wcBlockedOrderQueueWhere } = await import('@/lib/connectors/woocommerce/sync/order-admission')
  const where = wcBlockedOrderQueueWhere()
  const matches = (clause: Record<string, unknown>, row: Row): boolean => {
    for (const [key, expected] of Object.entries(clause)) {
      if (key === 'AND') { if (!(expected as Row[]).every((part) => matches(part, row))) return false; continue }
      if (key === 'OR') { if (!(expected as Row[]).some((part) => matches(part, row))) return false; continue }
      if (key === 'payload') {
        const spec = expected as { path: string[]; equals: unknown }
        if ((row.payload as Record<string, unknown> | undefined)?.[spec.path[0]] !== spec.equals) return false
        continue
      }
      if (row[key] !== expected) return false
    }
    return true
  }
  return store.syncLogs.filter((row) => matches(where as Record<string, unknown>, row))
}

function guardNotices() {
  return store.activity.filter((entry) => entry.action === 'tax_rate_fallback_blocked')
}

async function runInitial() {
  const { runInitialImport } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  store.settings.delete('wc_initial_import_completed')
  return runInitialImport({
    status: 'running', message: '', activeOrdersImported: 0, activeOrdersSkipped: 0,
    totalOrders: 0, currentPage: 0, totalPages: 0, errors: [],
  })
}

// --- a blocked order is recorded and noticed, never imported degraded -----------------------

test('a tax-guard block leaves a by-id queue row and one Exceptions notice, and imports nothing', async () => {
  reset()
  const result = await importOrder(blockedOrder(401))

  assert.equal(result.success, true, 'a RECORDED block is a resolved skip, not a failure')
  assert.equal(result.skipped, 'tax_rate_unmapped')
  assert.equal(store.links.has('401'), false, 'the order is NOT imported in a degraded way')

  const rows = await listedAsBlocked()
  assert.equal(rows.length, 1, 'the notice Sync > Exceptions lists is the queue row')
  const payload = rows[0].payload as Record<string, unknown>
  assert.equal(payload.externalOrderId, '401')
  assert.match(String(payload.detail), /would use the order default tax rate/)
  assert.match(String(rows[0].errorMessage), /Tax Rates tab/)
  assert.equal(guardNotices().length, 1)
})

test('re-blocking the same order refreshes its row and does not log the guard again', async () => {
  reset()
  await importOrder(blockedOrder(402))
  await importOrder(blockedOrder(402))
  await importOrder(blockedOrder(402))
  assert.equal((await listedAsBlocked()).length, 1, 'one row per order')
  assert.equal(guardNotices().length, 1, 'logged when first recorded, not on every re-check')
})

test('a block whose row cannot be written is NOT a recorded skip: it carries unrecordedRefusal', async () => {
  reset()
  store.failLogWrites = true
  const result = await importOrder(blockedOrder(403))
  assert.equal(result.success, false)
  assert.equal(result.skipped, undefined)
  assert.equal(result.unrecordedRefusal, 'tax_rate_unmapped')
  assert.equal(guardNotices().length, 1, 'the operator still sees the block')
})

// --- the initial import -----------------------------------------------------------------------

test('an initial import with blocked orders completes, and EACH blocked order has a record and a notice', async () => {
  reset()
  store.listed = [wcOrder(501, 'processing'), blockedOrder(502), blockedOrder(503), wcOrder(504, 'processing'), blockedOrder(505)]

  const run = await runInitial()

  // PRECONDITION: the run really is mixed, so completion is not a vacuous result.
  assert.equal(run.progress.activeOrdersImported, 2, 'two orders imported')
  assert.equal(run.progress.ordersBlocked, 3, 'three were blocked')
  assert.equal(store.links.has('502'), false)

  assert.equal(run.outcome, 'complete')
  assert.equal(run.stamped, true)
  assert.equal(store.settings.get('wc_initial_import_completed'), 'true')
  assert.ok(store.settings.get('last_wc_order_sync_at'), 'the cursor advances: the blocked orders are recorded, not lost')

  const ids = (await listedAsBlocked()).map((row) => String((row.payload as Record<string, unknown>).externalOrderId)).sort()
  assert.deepEqual(ids, ['502', '503', '505'], 'every blocked order has a queue row (the Exceptions notice)')
  assert.equal(guardNotices().length, 3, 'and an activity notice')
  assert.match(run.progress.message, /3 blocked/)
})

test('an initial import whose block cannot be recorded does NOT complete and does not advance the cursor', async () => {
  reset()
  store.failLogWrites = true
  store.listed = [wcOrder(511, 'processing'), blockedOrder(512)]

  const run = await runInitial()

  assert.equal(run.progress.activeOrdersImported, 1, 'the clean order did import')
  assert.equal(run.outcome, 'failed')
  assert.equal(run.stamped, false)
  assert.equal(run.unrecordedRefusals, 1)
  assert.equal(store.settings.get('wc_initial_import_completed'), undefined)
  assert.equal(store.settings.get('last_wc_order_sync_at'), undefined)
})

// --- the drain --------------------------------------------------------------------------------

test('the drain re-imports a blocked order by id once its tax rate is mapped, and clears the notice', async () => {
  reset()
  await importOrder(blockedOrder(601))
  store.blockedIds.add('601')
  store.live.set('601', 'processing')

  const before = await drain()
  assert.equal(before.stillRefused, 1, 'still blocked while the rate is unmapped')
  assert.equal((await listedAsBlocked()).length, 1)
  assert.equal(store.links.has('601'), false)

  store.taxMapped = true // the operator maps the tax rate
  const after = await drain()

  assert.equal(after.imported, 1, 'the drain imports it with no webhook and no cursor involved')
  assert.equal(store.links.has('601'), true)
  assert.equal((await listedAsBlocked()).length, 0, 'the Exceptions notice clears when the order imports')
  assert.equal(queued().length, 0)
})

// --- the sweep --------------------------------------------------------------------------------

test('the sweep does not fail forever on a recorded block: it advances its cursor and stays clean', async () => {
  reset()
  store.settings.set('last_wc_order_sync_at', '2026-01-01T00:00:00.000Z')
  store.listed = [wcOrder(701, 'processing'), blockedOrder(702)]
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')

  const first = await syncNewWcOrders()
  assert.deepEqual(first.errors, [], 'a recorded block is not a sweep error')
  assert.equal(first.synced, 1)
  assert.equal(first.skipped, 1)
  assert.notEqual(store.settings.get('last_wc_order_sync_at'), '2026-01-01T00:00:00.000Z', 'the cursor advanced past the block')

  // The order is fetched again (it is still in the window) and stays clean, with ONE row and ONE notice.
  store.settings.set('last_wc_order_sync_at', '2026-01-01T00:00:00.000Z')
  const second = await syncNewWcOrders()
  assert.deepEqual(second.errors, [])
  assert.equal((await listedAsBlocked()).length, 1)
  assert.equal(guardNotices().length, 1)
})

test('the sweep still holds its cursor when a block cannot be recorded', async () => {
  reset()
  store.failLogWrites = true
  store.settings.set('last_wc_order_sync_at', '2026-01-01T00:00:00.000Z')
  store.listed = [blockedOrder(711)]
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')

  const result = await syncNewWcOrders()

  assert.equal(result.errors.length, 1)
  assert.equal(store.settings.get('last_wc_order_sync_at'), '2026-01-01T00:00:00.000Z')
})

// --- refunds ride the drain ---------------------------------------------------------------------

test('a refund created while the order was blocked is applied by the drain, which then resolves the row', async () => {
  reset()
  await importOrder(blockedOrder(801))
  store.blockedIds.add('801')
  store.live.set('801', 'processing')
  store.wcRefunds.set('801', [9001]) // refunded in WooCommerce while IMS had refused the order

  store.taxMapped = true
  const result = await drain()

  assert.equal(result.imported, 1)
  assert.equal(store.links.has('801'), true)
  assert.deepEqual(store.refundReads, [801], 'the refunds were read for the imported order')
  assert.equal(store.appliedRefunds.has(9001), true, 'and the refund applied')
  assert.equal(queued().length, 0, 'the row is resolved only after that')
})

test('a refund read that fails keeps the row pending and counts it failed, then a later run resolves it', async () => {
  reset()
  await importOrder(blockedOrder(811))
  store.blockedIds.add('811')
  store.live.set('811', 'processing')
  store.wcRefunds.set('811', [9002])
  store.taxMapped = true
  store.refundReadFails = true

  const first = await drain()
  assert.equal(first.imported, 0)
  assert.equal(first.failed, 1, 'a refund READ failure is a genuine failure, which the cron answers non-2xx for')
  assert.equal(first.unresolved, 0)
  assert.equal(queued().length, 1, 'the row stays pending so the next run retries the refunds')
  assert.equal(store.appliedRefunds.has(9002), false)

  store.refundReadFails = false
  const second = await drain()
  assert.equal(second.imported, 1, 'the order already exists; the retry finishes the refunds and resolves the row')
  assert.equal(store.appliedRefunds.has(9002), true)
  assert.equal(queued().length, 0)
})

// --- survivors of the mutation pass -------------------------------------------------------------

/** A coupon of unknown type that left money off the lines: the coupon guard refuses it. */
function couponOrder(id: number) {
  return { ...wcOrder(id, 'processing'), coupon_lines: [{ id: 1, code: 'MYSTERY', discount: '5.00', discount_tax: '0.00', meta_data: [] }] }
}

test('a coupon-guard block is recorded and listed like a tax block', async () => {
  reset()
  const result = await importOrder(couponOrder(821) as never)

  assert.equal(result.skipped, 'coupon_refused')
  assert.equal(store.links.has('821'), false)
  const rows = await listedAsBlocked()
  assert.equal(rows.length, 1, 'the coupon block is on the Exceptions list')
  assert.equal((rows[0].payload as Record<string, unknown>).reason, 'coupon_refused')
})

test('a guard block does not move the selection-widening watermark, an admission refusal does', async () => {
  reset()
  await importOrder(blockedOrder(831))
  assert.equal(store.settings.get('wc_order_admission_refused_since'), undefined, 'a guard block says nothing about the selection')

  await importOrder(wcOrder(832, 'on-hold')) // not selected: an admission refusal
  assert.ok(store.settings.get('wc_order_admission_refused_since'), 'the control: an admission refusal does set it')
})

test('the initial import ends in a WARNING notice when orders were blocked and a success notice when none were', async () => {
  reset()
  store.listed = [wcOrder(841, 'processing'), blockedOrder(842)]
  await runInitial()
  assert.equal(store.notices.at(-1)?.type, 'warning')

  reset()
  store.listed = [wcOrder(851, 'processing')]
  await runInitial()
  assert.equal(store.notices.at(-1)?.type, 'success')
})

test('the reconcile sweep reads refunds for an imported order but not for one recorded as blocked', async () => {
  reset()
  store.settings.set('last_wc_order_reconcile_at', '2026-01-01T00:00:00.000Z')
  store.listed = [wcOrder(861, 'processing'), blockedOrder(862)]
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')

  const result = await syncNewWcOrders({ mode: 'reconcile' })

  assert.deepEqual(result.errors, [])
  assert.deepEqual(store.refundReads, [861], 'no order in IMS, so nothing for 862 refunds to attach to')
})

test('the drain keeps the row pending while a refund may still reach IMS', async () => {
  reset()
  await importOrder(blockedOrder(871))
  store.blockedIds.add('871')
  store.live.set('871', 'processing')
  store.taxMapped = true
  store.outstandingRefunds = 1

  const result = await drain()

  assert.equal(result.imported, 0)
  assert.equal(result.unresolved, 1, 'a still-pending refund is an expected state, not a failure')
  assert.equal(result.failed, 0)
  assert.equal(queued().length, 1)
})
