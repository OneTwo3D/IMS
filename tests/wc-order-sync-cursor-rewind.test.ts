import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v r4: an acknowledged admission refusal must not leave the order permanently behind the
 * pull cursors.
 *
 * Round 3 deliberately did NOT advance the cursor on a refusal, and that was right as far as it
 * went — but the cursor is advanced by everything else. The very next admitted delivery stamps
 * `last_wc_order_sync_at` at `now`, and the refused order's `date_modified` is behind it from then
 * on. While its status stays unticked that is exactly what the operator asked for. The moment they
 * TICK it, nothing brings the order back: WooCommerce fires no webhook because IMS changed its own
 * setting, and `?modified_after=<cursor>` will not reach back for it. The order the operator has
 * just asked for is invisible for good.
 *
 * Two stored facts decide it, rather than a check bolted onto the sweep: the selection the cursor
 * was last advanced UNDER, and the earliest thing the boundary has ever turned away.
 */

type Row = Record<string, unknown>

const state = {
  settings: new Map<string, string>(),
  upserts: [] as Array<{ key: string; value: string }>,
  /** Every `?modified_after=` the sweep actually asked WooCommerce for. */
  modifiedAfter: [] as Array<string | undefined>,
  statusParams: [] as string[],
  activity: [] as Row[],
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
      if (path === '/orders') {
        state.modifiedAfter.push(params.modified_after)
        state.statusParams.push(params.status)
      }
      return { data: [], totalPages: 1, totalItems: 0 }
    },
    wcPut: async () => ({ data: null }),
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          const value = state.settings.get(where.key)
          return value === undefined ? null : { key: where.key, value }
        },
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
          state.upserts.push({ key: where.key, value: create.value })
          state.settings.set(where.key, create.value)
          return {}
        },
      },
      salesOrder: { findFirst: async () => ({ id: 'so-any' }) },
      // The sweep writes the cursor and its fingerprint as ONE fact; the double runs the batch.
      $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
    },
  },
})

const CURSOR_KEY = 'last_wc_order_sync_at'
const CURSOR_STATUSES_KEY = 'last_wc_order_sync_at_statuses'
const REFUSED_SINCE_KEY = 'wc_order_admission_refused_since'

const CURSOR_AT = '2026-08-10T00:00:00.000Z'
const REFUSED_AT = '2026-08-01T10:00:00.000Z'

function reset(overrides: Record<string, string> = {}) {
  state.settings = new Map<string, string>([
    ['wc_initial_import_completed', 'true'],
    ['wc_sync_order_statuses', JSON.stringify(['processing'])],
    [CURSOR_KEY, CURSOR_AT],
    [CURSOR_STATUSES_KEY, JSON.stringify(['processing', 'pending-wdraw', 'withdrawn'])],
    ...Object.entries(overrides),
  ])
  state.upserts = []
  state.modifiedAfter = []
  state.statusParams = []
  state.activity = []
}

async function poll() {
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'poll' })
}

test('a WIDENED selection rewinds the cursor to the earliest order the boundary turned away', async () => {
  reset({
    wc_sync_order_statuses: JSON.stringify(['processing', 'pending']),
    [REFUSED_SINCE_KEY]: REFUSED_AT,
  })

  await poll()

  assert.deepEqual(
    state.modifiedAfter,
    [REFUSED_AT],
    'the orders refused while `pending` was unticked are older than the cursor and must be re-read',
  )
  assert.match(state.statusParams[0], /pending/)
  const rewind = state.activity.find((entry) => entry.action === 'wc_order_sync_cursor_rewound')
  assert.ok(rewind, 'a re-read of history must be visible, not silent')
})

test('an UNCHANGED selection does not rewind, so an ordinary sweep stays incremental', async () => {
  reset({ [REFUSED_SINCE_KEY]: REFUSED_AT })

  await poll()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT], 'nothing became newly wanted, so nothing is re-read')
  assert.equal(state.activity.some((entry) => entry.action === 'wc_order_sync_cursor_rewound'), false)
})

test('a NARROWED selection does not rewind either — nothing excluded has become wanted', async () => {
  reset({
    wc_sync_order_statuses: JSON.stringify(['processing']),
    [CURSOR_STATUSES_KEY]: JSON.stringify(['processing', 'pending', 'pending-wdraw', 'withdrawn']),
    [REFUSED_SINCE_KEY]: REFUSED_AT,
  })

  await poll()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT])
})

test('a widening with NOTHING ever refused does not re-read the store', async () => {
  // The fingerprint alone would drag the whole history back on every settings change. The watermark
  // is what bounds it — and when the boundary never turned anything away there is nothing behind
  // the cursor to recover.
  reset({ wc_sync_order_statuses: JSON.stringify(['processing', 'pending']) })

  await poll()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT])
})

test('a refusal NEWER than the cursor does not drag the cursor forward', async () => {
  reset({
    wc_sync_order_statuses: JSON.stringify(['processing', 'pending']),
    [REFUSED_SINCE_KEY]: '2026-08-20T00:00:00.000Z',
  })

  await poll()

  assert.deepEqual(state.modifiedAfter, [CURSOR_AT], 'a rewind may only ever move the window backwards')
})

test('the cursor and the selection it was earned under are written together', async () => {
  reset({ wc_sync_order_statuses: JSON.stringify(['processing', 'pending']), [REFUSED_SINCE_KEY]: REFUSED_AT })

  await poll()

  const keys = state.upserts.map((entry) => entry.key)
  assert.ok(keys.includes(CURSOR_KEY), 'a clean run advances the cursor')
  assert.ok(
    keys.includes(CURSOR_STATUSES_KEY),
    'a cursor advanced without its fingerprint makes the NEXT widening undetectable',
  )
  const fingerprint = state.upserts.find((entry) => entry.key === CURSOR_STATUSES_KEY)
  assert.deepEqual(
    JSON.parse(fingerprint!.value),
    ['pending', 'pending-wdraw', 'processing', 'withdrawn'],
    'the RESOLVED list, sorted, so an ordering difference is not read as a change',
  )
})

test('the refusal watermark is a monotonic MINIMUM, never moved forward', async () => {
  // A refusal swept past under a wider selection is no proof that some OTHER excluded status has
  // nothing behind the cursor — and those orders are never refused a second time, because nothing
  // redelivers them. Keeping the oldest refusal ever seen is what lets the next widening reach
  // them, and it is still bounded by that refusal rather than by the store's whole history.
  reset({ [REFUSED_SINCE_KEY]: REFUSED_AT })
  const { noteWcOrderAdmissionRefusal } = await import('@/lib/connectors/woocommerce/sync/order-import')

  await noteWcOrderAdmissionRefusal('2026-08-15T00:00:00')
  assert.equal(state.settings.get(REFUSED_SINCE_KEY), REFUSED_AT, 'a newer refusal must not move it')

  await noteWcOrderAdmissionRefusal('2026-07-01T00:00:00')
  assert.equal(state.settings.get(REFUSED_SINCE_KEY), '2026-07-01T00:00:00.000Z', 'an older one must')
})

test('an unreadable refusal timestamp falls back to NOW, not to the beginning of time', async () => {
  reset()
  const { noteWcOrderAdmissionRefusal } = await import('@/lib/connectors/woocommerce/sync/order-import')

  await noteWcOrderAdmissionRefusal('not-a-date')

  const stored = state.settings.get(REFUSED_SINCE_KEY)
  assert.ok(stored, 'a refusal always records a watermark')
  const age = Date.now() - Date.parse(stored)
  assert.ok(age >= 0 && age < 60_000, `expected a fresh watermark, got ${stored}`)
})
