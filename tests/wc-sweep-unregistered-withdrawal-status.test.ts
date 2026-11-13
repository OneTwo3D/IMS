import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * WooCommerce rejects a whole `/orders?status=` call (400 rest_invalid_param) when one slug is not
 * registered. The EU withdrawal statuses are added to every live sweep, so a store without the
 * withdrawal plugin could not be swept at all. The sweep resolves its list against the registered
 * statuses (GET /reports/orders/totals), once per run.
 */

type Row = Record<string, unknown>

const state = {
  settings: new Map<string, string>(),
  upserts: [] as Array<{ key: string; value: string }>,
  /** Every `?modified_after=` the sweep actually asked WooCommerce for. */
  modifiedAfter: [] as Array<string | undefined>,
  statusParams: [] as string[],
  activity: [] as Row[],
  /** What the registered-status read answers: a slug list, or 'error'. */
  registered: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as string[] | 'error' | 'empty',
  totalsCalls: 0,
  /** When set, the next /orders fetch waits for this promise (lets a second run commit in between). */
  pauseOrders: null as Promise<void> | null,
  ordersReached: null as (() => void) | null,
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => state.settings.get(key) ?? null,
    getSettingValues: async (keys: string[]) => new Map(keys.map((key) => [key, state.settings.get(key)])),
  },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string> = {}) => {
      if (path === '/reports/orders/totals') {
        state.totalsCalls++
        if (state.registered === 'error') return { data: null, totalPages: 0, totalItems: 0, error: 'WC API error: 500 boom' }
        if (state.registered === 'empty') return { data: [], totalPages: 1, totalItems: 0 }
        return { data: state.registered.map((slug) => ({ slug, name: slug, total: 1 })), totalPages: 1, totalItems: 0 }
      }
      if (path === '/orders') {
        if (state.pauseOrders) {
          const gate = state.pauseOrders
          state.pauseOrders = null
          state.ordersReached?.()
          await gate
        }
        state.modifiedAfter.push(params.modified_after)
        state.statusParams.push(params.status)
      }
      return { data: [], totalPages: 1, totalItems: 0 }
    },
    wcPut: async () => ({ data: null }),
    // o3d-xnwu: see the note in wc-product-sync-type-preservation.test.ts. The store above already
    // answers every page with an empty list, which is what now ends the walk.
    MAX_WC_PAGE_WALK_PAGES: 1000,
    describeUnendedWcPageWalk: (collection: string, pagesRead: number) =>
      `The WooCommerce ${collection} walk did not reach an empty page within ${pagesRead} page(s).`,
  },
})

const sweepDb: Record<string, unknown> = {}
mock.module('@/lib/db', {
  namedExports: {
    db: Object.assign(sweepDb, {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.flatMap((key) => (state.settings.has(key) ? [{ key, value: state.settings.get(key)! }] : [])),
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
          state.upserts.push({ key: where.key, value: create.value })
          state.settings.set(where.key, create.value)
          return {}
        },
        deleteMany: async ({ where }: { where: { key: string } }) => {
          state.settings.delete(where.key)
          return { count: 1 }
        },
      },
      salesOrder: { findFirst: async () => ({ id: 'so-any' }) },
      $queryRaw: async () => [],
      // The sweep writes the cursor and its fingerprint as ONE fact, in one interactive transaction.
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(sweepDb),
    }),
  },
})

const CURSOR_KEY = 'last_wc_order_sync_at'
const CURSOR_STATUSES_KEY = 'last_wc_order_sync_at_statuses'
const CLEAN_AT_KEY = 'last_wc_order_sync_at_sweep_clean_at'
const REFUSED_SINCE_KEY = 'wc_order_admission_refused_since'
const DROPPED_KEY = 'last_wc_order_sync_at_withdrawal_dropped_since'
const CURSOR_AT = '2026-08-10T00:00:00.000Z'
const WARN = 'wc_order_sync_withdrawal_status_unregistered'

const NO_PLUGIN = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']
const WITH_PLUGIN = [...NO_PLUGIN, 'pending-wdraw', 'withdrawn']

async function reset(overrides: Record<string, string> = {}) {
  state.settings = new Map<string, string>([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
    [CURSOR_KEY, CURSOR_AT],
    ...Object.entries(overrides),
  ])
  state.upserts = []
  state.modifiedAfter = []
  state.statusParams = []
  state.activity = []
  state.registered = NO_PLUGIN
  state.totalsCalls = 0
  const { resetWcWithdrawalUnregisteredWarnings } = await import('@/lib/connectors/woocommerce/sync/order-import')
  resetWcWithdrawalUnregisteredWarnings()
}

async function sweep(mode: 'poll' | 'reconcile' = 'poll') {
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode })
}

test('an unregistered withdrawal status is dropped with a WARNING, and the sweep proceeds', async () => {
  await reset()

  const result = await sweep()

  assert.deepEqual(result.errors, [])
  assert.deepEqual(state.statusParams, ['processing'], 'the query carries only registered statuses')
  const warning = state.activity.filter((entry) => entry.action === WARN)
  assert.equal(warning.length, 1)
  assert.equal(warning[0].level, 'WARNING')
  assert.match(String(warning[0].description), /pending-wdraw, withdrawn/)
  assert.match(String(warning[0].description), /plugin/i)
  assert.match(String(warning[0].description), /not seen until the plugin is active/)
  assert.ok(state.upserts.some((entry) => entry.key === CURSOR_KEY), 'a clean run still advances the cursor')
  assert.equal(state.totalsCalls, 1, 'registered statuses are read once per run, not per page')
})

test('the reconcile route is resolved the same way and keeps `completed`', async () => {
  await reset()

  const result = await sweep('reconcile')

  assert.deepEqual(result.errors, [])
  assert.deepEqual(state.statusParams, ['processing,completed'])
})

test('the warning is written once per interval, not on every run', async () => {
  await reset()

  await sweep()
  await sweep()

  assert.equal(state.activity.filter((entry) => entry.action === WARN).length, 1)
})

test('an unregistered CORE status refuses the run loudly and asks WooCommerce for nothing', async () => {
  await reset({ wc_sync_order_statuses: JSON.stringify(['processing', 'partial-shipped']) })

  const result = await sweep()

  assert.equal(result.synced, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /partial-shipped/)
  assert.deepEqual(state.statusParams, [], 'no /orders request is made')
  assert.equal(state.upserts.length, 0, 'the cursor is not advanced')
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_status_unregistered' && entry.level === 'ERROR'))
})

test('a status the operator ticked is core even when it is a withdrawal slug', async () => {
  await reset({ wc_sync_order_statuses: JSON.stringify(['processing', 'withdrawn']) })

  const result = await sweep()

  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /withdrawn/)
  assert.deepEqual(state.statusParams, [])
})

for (const failure of ['error', 'empty'] as const) {
  test(`a failed registered-status read (${failure}) fails closed: nothing is dropped`, async () => {
    await reset()
    state.registered = failure

    const result = await sweep()

    assert.deepEqual(state.statusParams, ['processing,pending-wdraw,withdrawn'], 'behaves exactly as before')
    assert.deepEqual(result.errors, [])
    assert.equal(state.activity.some((entry) => entry.action === WARN), false)
  })
}

test('a store with the plugin registered is swept with the withdrawal statuses, no warning', async () => {
  await reset()
  state.registered = WITH_PLUGIN

  await sweep()

  assert.deepEqual(state.statusParams, ['processing,pending-wdraw,withdrawn'])
  assert.equal(state.activity.some((entry) => entry.action === WARN), false)
})

test('the fingerprint is the RESOLVED list and does not churn while the plugin stays off', async () => {
  await reset({ [CURSOR_STATUSES_KEY]: JSON.stringify(['processing', 'pending-wdraw', 'withdrawn']) })

  await sweep()
  const first = state.settings.get(CURSOR_STATUSES_KEY)
  assert.equal(first, JSON.stringify(['processing']), 'withdrawal statuses were not asked for, so not recorded')
  assert.equal(state.settings.get(DROPPED_KEY), CURSOR_AT, 'the position the outage started from is kept')

  await sweep()

  assert.equal(state.settings.get(CURSOR_STATUSES_KEY), first)
  assert.equal(state.modifiedAfter.length, 2)
  assert.equal(state.activity.some((entry) => entry.action === 'wc_order_sync_cursor_rewound'), false, 'narrowing and steady state never rewind')
  assert.equal(state.settings.get(DROPPED_KEY), CURSOR_AT, 'the marker keeps its earliest value')
})

test('re-registering the plugin is a WIDENING: the sweep re-reads from the start of the outage', async () => {
  await reset()
  await sweep()
  assert.equal(state.settings.get(DROPPED_KEY), CURSOR_AT)
  // Time passes: the cursor moves on during the outage.
  state.settings.set(CURSOR_KEY, '2026-08-20T00:00:00.000Z')
  state.modifiedAfter = []
  state.activity = []
  state.registered = WITH_PLUGIN

  await sweep()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT], 'orders already sitting in a withdrawal status are not skipped')
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_cursor_rewound'))
  assert.deepEqual(JSON.parse(state.settings.get(CURSOR_STATUSES_KEY)!), ['pending-wdraw', 'processing', 'withdrawn'])
  assert.equal(state.settings.has(DROPPED_KEY), false, 'the marker is cleared once the widening has been served')

  state.modifiedAfter = []
  await sweep()
  assert.notEqual(state.modifiedAfter[0], CURSOR_AT, 'and the next run is incremental again')
})

test('a webhook advancing the cursor after a missed withdrawal does not move the rewind floor', async () => {
  // The last CLEAN sweep (plugin active) ran at 08-10. A withdrawal happened at 08-15 but its
  // webhook was missed; an unrelated order webhook then advanced the shared cursor to 08-20, all
  // before the first dropped-status sweep.
  const LAST_CLEAN = '2026-08-10T00:00:00.000Z'
  await reset({
    [CLEAN_AT_KEY]: LAST_CLEAN,
    [CURSOR_KEY]: '2026-08-20T00:00:00.000Z',
    [CURSOR_STATUSES_KEY]: JSON.stringify(['pending-wdraw', 'processing', 'withdrawn']),
  })

  await sweep()
  assert.equal(state.settings.get(DROPPED_KEY), LAST_CLEAN, 'the floor is the last clean sweep, not the webhook-advanced cursor')

  state.modifiedAfter = []
  state.registered = WITH_PLUGIN
  await sweep()

  assert.deepEqual(state.modifiedAfter, [LAST_CLEAN], 'the withdrawal order modified at 08-15 is inside the re-fetch window')
})

test('a stale admission refusal does not widen a withdrawal-only re-registration', async () => {
  const STALE_REFUSAL = '2026-01-01T00:00:00.000Z'
  await reset({ [REFUSED_SINCE_KEY]: STALE_REFUSAL })
  await sweep()
  assert.equal(state.settings.get(DROPPED_KEY), CURSOR_AT)

  state.modifiedAfter = []
  state.registered = WITH_PLUGIN
  await sweep()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT], 'only the withdrawal marker applies; the refusal watermark is for selection widenings')
})

test('overlapping sweeps: a slow run that read the full fingerprint writes nothing after a narrowed run committed', async () => {
  const FULL = JSON.stringify(['pending-wdraw', 'processing', 'withdrawn'])
  await reset({ [CURSOR_STATUSES_KEY]: FULL })
  state.registered = WITH_PLUGIN

  // Run A (plugin active) reads its state, then stalls in its first fetch.
  let release!: () => void
  state.pauseOrders = new Promise<void>((resolve) => { release = resolve })
  const reached = new Promise<void>((resolve) => { state.ordersReached = resolve })
  const runA = sweep()
  await reached

  // Run B (plugin inactive) runs to completion meanwhile and commits the narrowed fingerprint and the marker.
  state.registered = NO_PLUGIN
  await sweep()
  const narrowed = JSON.stringify(['processing'])
  assert.equal(state.settings.get(CURSOR_STATUSES_KEY), narrowed)
  const marker = state.settings.get(DROPPED_KEY)
  assert.equal(marker, CURSOR_AT)
  const afterB = new Map(state.settings)

  // Run A now finishes and tries to commit.
  state.activity = []
  release()
  await runA

  assert.deepEqual([...state.settings.entries()], [...afterB.entries()], 'the superseded run wrote nothing at all')
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_superseded'))

  // Re-registration still rewinds to the marker.
  state.registered = WITH_PLUGIN
  state.modifiedAfter = []
  await sweep()
  assert.deepEqual(state.modifiedAfter, [CURSOR_AT])
})

test('reconcileWcPullStatusesWithRegistered: null registered list changes nothing', async () => {
  const { reconcileWcPullStatusesWithRegistered } = await import('@/lib/connectors/woocommerce/order-status-filter')
  const wd = { submitted: 'pending-wdraw', approved: 'withdrawn' }
  assert.deepEqual(
    reconcileWcPullStatusesWithRegistered(['processing', 'pending-wdraw', 'withdrawn'], ['processing'], wd, null),
    { statuses: ['processing', 'pending-wdraw', 'withdrawn'], droppedWithdrawal: [], missingCore: [] },
  )
  assert.deepEqual(
    reconcileWcPullStatusesWithRegistered(['processing', 'pending-wdraw', 'withdrawn'], ['processing'], wd, ['processing', 'wc-withdrawn']),
    { statuses: ['processing', 'withdrawn'], droppedWithdrawal: ['pending-wdraw'], missingCore: [] },
  )
})
