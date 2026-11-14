import assert from 'node:assert/strict'
import { cursorRaw } from './helpers/cursor-raw'
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
  /** Orders the store holds in a withdrawal status (returned only to a status-scoped read with no modified_after). */
  withdrawalOrders: [] as Array<Record<string, unknown>>,
  /** Error answered to the next status-scoped recovery read. */
  recoveryError: null as string | null,
  /** When true the recovery read never reaches an empty page. */
  recoveryEndless: false,
  /** Ids of every order the sweep passed through the import path. */
  imported: [] as string[],
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
        const registeredAtCall = state.registered
        if (state.pauseOrders) {
          const gate = state.pauseOrders
          state.pauseOrders = null
          state.ordersReached?.()
          await gate
        }
        state.modifiedAfter.push(params.modified_after)
        state.statusParams.push(params.status)
        // WooCommerce rejects the whole call when a status slug is not registered.
        if (Array.isArray(registeredAtCall) && params.status.split(',').some((slug) => !registeredAtCall.includes(slug))) {
          return { data: null, totalPages: 0, totalItems: 0, error: 'WC API error: 400 rest_invalid_param' }
        }
        const isRecoveryRead = params.modified_after === undefined && params.status.split(',').every((slug) => slug === 'pending-wdraw' || slug === 'withdrawn')
        if (isRecoveryRead) {
          if (state.recoveryError) {
            const error = state.recoveryError
            state.recoveryError = null
            return { data: null, totalPages: 0, totalItems: 0, error }
          }
          if (state.recoveryEndless) return { data: [{ id: 1000 + Number(params.page), number: String(params.page), status: 'withdrawn' }], totalPages: 1, totalItems: 0 }
          return { data: params.page === '1' ? state.withdrawalOrders : [], totalPages: 1, totalItems: 0 }
        }
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

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (order: { id: number }) => {
      state.imported.push(String(order.id))
      return { outcome: 'skipped-withdrawal' }
    },
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
      $executeRaw: cursorRaw((key, value) => { state.upserts.push({ key, value }); state.settings.set(key, value) }),
      // The sweep writes the cursor and its fingerprint as ONE fact, in one interactive transaction.
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(sweepDb),
    }),
  },
})

const CURSOR_KEY = 'last_wc_order_sync_at'
const CURSOR_STATUSES_KEY = 'last_wc_order_sync_at_statuses'
const REFUSED_SINCE_KEY = 'wc_order_admission_refused_since'
const DROPPED_KEY = 'last_wc_order_sync_at_withdrawal_dropped'
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
  state.withdrawalOrders = []
  state.recoveryError = null
  state.recoveryEndless = false
  state.imported = []
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

const WDRAW_ORDER = { id: 7, number: '7', status: 'withdrawn', date_modified: '2026-08-15T00:00:00' }
const isRecoveryRead = (index: number) => state.statusParams[index] === 'pending-wdraw,withdrawn' && state.modifiedAfter[index] === undefined

test('a drop records only that it happened, and the fingerprint does not churn while the plugin stays off', async () => {
  await reset({ [CURSOR_STATUSES_KEY]: JSON.stringify(['processing', 'pending-wdraw', 'withdrawn']) })

  await sweep()
  const first = state.settings.get(CURSOR_STATUSES_KEY)
  assert.equal(first, JSON.stringify(['processing']), 'withdrawal statuses were not asked for, so not recorded')
  assert.ok(state.settings.has(DROPPED_KEY), 'the marker records that a withdrawal status was dropped')
  const marker = state.settings.get(DROPPED_KEY)

  await sweep()

  assert.equal(state.settings.get(CURSOR_STATUSES_KEY), first)
  assert.equal(state.settings.get(DROPPED_KEY), marker, 'the marker keeps its first value')
  assert.equal(state.activity.some((entry) => entry.action === 'wc_order_sync_cursor_rewound'), false, 'narrowing and steady state never rewind')
})

test('re-registering the plugin runs a one-off status-scoped read with no date bound, then clears the marker', async () => {
  await reset()
  await sweep()
  assert.ok(state.settings.has(DROPPED_KEY))
  state.statusParams = []
  state.modifiedAfter = []
  state.registered = WITH_PLUGIN
  state.withdrawalOrders = [WDRAW_ORDER]

  const result = await sweep()

  assert.deepEqual(result.errors, [])
  assert.ok(isRecoveryRead(0), 'the recovery read comes first: only the withdrawal statuses, no modified_after')
  assert.deepEqual(state.imported, ['7'], 'its orders go through the normal import path')
  assert.equal(state.statusParams.at(-1), 'processing,pending-wdraw,withdrawn', 'then the ordinary sweep')
  assert.notEqual(state.modifiedAfter.at(-1), undefined, 'which keeps its cursor')
  assert.equal(state.settings.has(DROPPED_KEY), false, 'cleared after the read ended cleanly')

  state.statusParams = []
  await sweep()
  assert.equal(state.statusParams.length, 1, 'and the next run is an ordinary sweep')
})

test('a withdrawal that happened before the first dropped sweep, with no cursor at all, is fetched after re-registration', async () => {
  await reset()
  state.settings.delete(CURSOR_KEY)
  await sweep()
  assert.ok(state.settings.has(DROPPED_KEY))
  state.statusParams = []
  state.modifiedAfter = []
  state.registered = WITH_PLUGIN
  state.withdrawalOrders = [WDRAW_ORDER]

  await sweep()

  assert.ok(isRecoveryRead(0))
  assert.deepEqual(state.imported, ['7'])
})

test('a missed withdrawal webhook followed by an unrelated webhook advancing the cursor is still fetched', async () => {
  // The cursor was moved to 08-20 by an unrelated webhook after a withdrawal at 08-15 whose webhook was missed.
  await reset({ [CURSOR_KEY]: '2026-08-20T00:00:00.000Z', [CURSOR_STATUSES_KEY]: JSON.stringify(['pending-wdraw', 'processing', 'withdrawn']) })
  await sweep()
  state.statusParams = []
  state.modifiedAfter = []
  state.registered = WITH_PLUGIN
  state.withdrawalOrders = [WDRAW_ORDER]

  await sweep()

  assert.ok(isRecoveryRead(0), 'no position is consulted, so no cursor movement can hide the order')
  assert.deepEqual(state.imported, ['7'])
})

test('a stale admission refusal does not rewind a withdrawal-only re-registration', async () => {
  await reset({ [REFUSED_SINCE_KEY]: '2026-01-01T00:00:00.000Z' })
  await sweep()
  const cursorAfterDrop = state.settings.get(CURSOR_KEY)
  state.statusParams = []
  state.modifiedAfter = []
  state.registered = WITH_PLUGIN

  await sweep()

  assert.equal(state.modifiedAfter.at(-1), cursorAfterDrop, 'the ordinary sweep keeps its cursor')
  assert.equal(state.activity.some((entry) => entry.action === 'wc_order_sync_cursor_rewound'), false)
})

test('a selection widening still rewinds to the refusal watermark', async () => {
  await reset({
    wc_sync_order_statuses: JSON.stringify(['processing', 'pending']),
    [CURSOR_STATUSES_KEY]: JSON.stringify(['processing']),
    [REFUSED_SINCE_KEY]: '2026-08-01T00:00:00.000Z',
  })
  state.registered = WITH_PLUGIN

  await sweep()

  assert.deepEqual(state.modifiedAfter, ['2026-08-01T00:00:00.000Z'])
})

test('a recovery read that errors leaves the marker set, holds the run, and retries next run', async () => {
  await reset()
  await sweep()
  const marker = state.settings.get(DROPPED_KEY)
  assert.ok(marker)
  state.registered = WITH_PLUGIN
  state.withdrawalOrders = [WDRAW_ORDER]
  state.recoveryError = 'WC API error: 500 boom'
  state.statusParams = []
  state.modifiedAfter = []
  const cursorBefore = state.settings.get(CURSOR_KEY)

  const failed = await sweep()

  assert.equal(failed.errors.length, 1)
  assert.equal(state.settings.get(DROPPED_KEY), marker, 'marker still set')
  assert.equal(state.settings.get(CURSOR_KEY), cursorBefore, 'cursor not advanced')
  assert.equal(state.statusParams.length, 1, 'the ordinary sweep did not run after a failed recovery')
  assert.ok(isRecoveryRead(0))

  state.statusParams = []
  state.modifiedAfter = []
  const retried = await sweep()

  assert.deepEqual(retried.errors, [])
  assert.ok(isRecoveryRead(0), 'retried')
  assert.deepEqual(state.imported, ['7'])
  assert.equal(state.settings.has(DROPPED_KEY), false)
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
  assert.equal(state.settings.get(CURSOR_STATUSES_KEY), JSON.stringify(['processing']))
  assert.ok(state.settings.has(DROPPED_KEY))
  const afterB = new Map(state.settings)

  // Run A now finishes and tries to commit.
  state.activity = []
  release()
  await runA

  assert.deepEqual([...state.settings.entries()], [...afterB.entries()], 'the superseded run wrote nothing at all')
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_superseded'))

  // Re-registration still recovers.
  state.registered = WITH_PLUGIN
  state.withdrawalOrders = [WDRAW_ORDER]
  state.statusParams = []
  state.modifiedAfter = []
  state.imported = []
  await sweep()
  assert.ok(isRecoveryRead(0))
  assert.deepEqual(state.imported, ['7'])
})

test('a status the operator ticked that is a withdrawal slug widens the selection like any other', async () => {
  await reset({
    wc_sync_order_statuses: JSON.stringify(['processing', 'withdrawn']),
    [CURSOR_STATUSES_KEY]: JSON.stringify(['processing']),
    [REFUSED_SINCE_KEY]: '2026-08-01T00:00:00.000Z',
  })
  state.registered = WITH_PLUGIN

  await sweep()

  assert.equal(state.modifiedAfter.at(-1), '2026-08-01T00:00:00.000Z', 'a ticked status that was not being read rewinds to the refusal watermark')
})

test('a recovery read that never reaches an empty page is refused loudly and leaves the marker set', async () => {
  await reset()
  await sweep()
  const marker = state.settings.get(DROPPED_KEY)
  const cursorBefore = state.settings.get(CURSOR_KEY)
  state.registered = WITH_PLUGIN
  state.recoveryEndless = true

  const result = await sweep()

  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /did not reach an empty page/)
  assert.equal(state.settings.get(DROPPED_KEY), marker)
  assert.equal(state.settings.get(CURSOR_KEY), cursorBefore, 'the cursor is held')
})

async function overlapWithSecondRun(overrides: Record<string, string>, registeredForA: string[], prepareB: () => void) {
  await reset(overrides)
  state.registered = registeredForA
  let release!: () => void
  state.pauseOrders = new Promise<void>((resolve) => { release = resolve })
  const reached = new Promise<void>((resolve) => { state.ordersReached = resolve })
  const runA = sweep()
  await reached
  prepareB()
  await sweep()
  const afterB = new Map(state.settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  state.activity = []
  release()
  await runA
  return { afterB }
}

test('overlap: a run whose FINGERPRINT alone was changed by another sweep writes nothing', async () => {
  const { afterB } = await overlapWithSecondRun(
    { [CURSOR_STATUSES_KEY]: JSON.stringify(['pending-wdraw', 'processing', 'withdrawn']) },
    WITH_PLUGIN,
    () => { state.settings.set('wc_sync_order_statuses', JSON.stringify(['processing', 'pending'])) },
  )

  assert.deepEqual([...state.settings.entries()], [...afterB.entries()])
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_superseded'))
})

test('overlap: a run whose MARKER alone was changed by another sweep writes nothing', async () => {
  const { afterB } = await overlapWithSecondRun(
    { [CURSOR_STATUSES_KEY]: JSON.stringify(['processing']) },
    NO_PLUGIN,
    () => { /* B runs with the same list and sets the marker */ },
  )

  assert.ok(state.settings.has(DROPPED_KEY))
  assert.deepEqual([...state.settings.entries()], [...afterB.entries()])
  assert.ok(state.activity.some((entry) => entry.action === 'wc_order_sync_superseded'))
})

test('with a cursor in use and no success stamp, a drop is still allowed (no floor is needed)', async () => {
  await reset()

  const result = await sweep()

  assert.deepEqual(result.errors, [])
  assert.deepEqual(state.statusParams, ['processing'])
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
