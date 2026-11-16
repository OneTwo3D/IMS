import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.82: a cancellation (or trash) WooCommerce holds but no delivery brought is applied by the sweep. Orders IMS
 * does not hold are never imported by it, an already-cancelled order is left alone, and a failed read or apply holds the
 * cursor (an error on the run) while a failed best-effort `trash` read does not.
 */
type Row = Record<string, unknown>
const state = {
  pages: {} as Record<string, Row[][]>, // status -> pages (an empty page ends the walk)
  fetchError: {} as Record<string, string>,
  linked: {} as Record<string, string>, // wc id -> IMS status
  applied: [] as Array<{ id: unknown; status: unknown }>,
  syncResult: { success: true } as { success: boolean; error?: string; permanent?: boolean },
  asked: [] as Array<Record<string, string>>,
  activity: [] as Row[],
  settings: new Map<string, string>(),
  // A live store for the keyset backfill: status -> orders. `onFetch` runs after every read (to mutate the store between reads).
  store: {} as Record<string, Array<{ id: number; status: string; date_created_gmt: string }>>,
  onFetch: null as null | ((n: number) => void),
  fetches: 0,
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: Row) => { state.activity.push(e) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (state.settings.has(where.key) ? { key: where.key, value: state.settings.get(where.key) } : null),
        upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value?: string } }) => { state.settings.set(where.key, state.settings.has(where.key) && update.value !== undefined ? update.value : (state.settings.get(where.key) ?? create.value)); return {} },
      },
      shoppingOrderLink: {
        findUnique: async ({ where }: { where: { connector_externalOrderId: { externalOrderId: string } } }) => {
          const status = state.linked[where.connector_externalOrderId.externalOrderId]
          return status ? { order: { status } } : null
        },
      },
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    MAX_WC_PAGE_WALK_PAGES: 3,
    describeWcPageWalkCeilingStall: (c: string, k: string) => `ceiling ${c} ${k}`,
    wcFetch: async (_p: string, params: Record<string, string>) => {
      state.asked.push(params)
      if (state.fetchError[params.status]) return { data: null, error: state.fetchError[params.status] }
      if (state.store[params.status] && params.orderby === 'date' && !params.modified_after) {
        const after = params.after ? Date.parse(params.after) : -Infinity
        const rows = state.store[params.status]
          .filter((o) => Date.parse(`${o.date_created_gmt}Z`) > after)
          .sort((a, b) => Date.parse(`${a.date_created_gmt}Z`) - Date.parse(`${b.date_created_gmt}Z`) || a.id - b.id)
        const per = Number(params.per_page)
        const out = rows.slice((Number(params.page) - 1) * per, Number(params.page) * per)
        state.fetches++
        const hook = state.onFetch
        if (hook) hook(state.fetches)
        return { data: out, error: null }
      }
      return { data: state.pages[params.status]?.[Number(params.page) - 1] ?? [], error: null }
    },
    wcPut: async () => ({ data: null }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { syncWcOrderStatus: async (o: Row) => { state.applied.push({ id: o.id, status: o.status }); return state.syncResult } },
})

function reset() {
  state.pages = {}; state.fetchError = {}; state.linked = {}; state.applied = []; state.syncResult = { success: true }; state.asked = []; state.activity = []; state.settings = new Map(); state.store = {}; state.onFetch = null; state.fetches = 0
}
async function run() {
  const { sweepWcCancellations } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const result = { synced: 0, skipped: 0, errors: [] as string[] }
  await sweepWcCancellations('2026-11-01T00:00:00.000Z', result, 'reconcile')
  return result
}

test('a cancelled order IMS holds is applied; one IMS never saw is not imported; an already-cancelled one is left', async () => {
  reset()
  state.pages.cancelled = [[{ id: 1, status: 'cancelled' }, { id: 2, status: 'cancelled' }, { id: 3, status: 'cancelled' }]]
  state.linked = { '1': 'ALLOCATED', '3': 'CANCELLED' }
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(state.applied, [{ id: 1, status: 'cancelled' }])
  assert.ok(state.asked.every((p) => p.modified_after === '2026-11-01T00:00:00.000Z'), 'bounded by the sweep window')
})

test('a trashed order is applied as a cancellation', async () => {
  reset()
  state.pages.trash = [[{ id: 9, status: 'trash' }]]
  state.linked = { '9': 'PROCESSING' }
  await run()
  assert.deepEqual(state.applied, [{ id: 9, status: 'cancelled' }])
})

test('a failed cancelled read is an error (the cursor is held)', async () => {
  reset()
  state.fetchError.cancelled = 'WC API error: 500 boom'
  assert.equal((await run()).errors.length, 1)
})

test('a TRANSIENT trash read failure (5xx, timeout, network, 429) also holds the cursor and is not remembered', async () => {
  for (const error of ['WC API error: 503 Service Unavailable', 'WC API error: 429 Too Many Requests', 'fetch failed: network timeout', 'WC API returned non-JSON response (text/html). The server may have timed out.']) {
    reset()
    state.fetchError.trash = error
    const result = await run()
    assert.equal(result.errors.length, 1, error)
    assert.equal(state.settings.size, 0, 'nothing is remembered')
  }
})

test('a CONFIRMED unsupported-status refusal of trash is logged once, remembered, and not asked again', async () => {
  reset()
  state.fetchError.trash = 'WC API error: 400 {"code":"rest_invalid_param","message":"Invalid parameter(s): status"}'
  const first = await run()
  assert.deepEqual(first.errors, [], 'the cursor is not held for it')
  assert.equal(state.activity.filter((a) => a.action === 'wc_order_trash_read_unsupported').length, 1)
  const askedFirst = state.asked.filter((p) => p.status === 'trash').length
  assert.equal(askedFirst, 1)
  state.asked = []
  state.activity = []
  const second = await run()
  assert.deepEqual(second.errors, [])
  assert.equal(state.asked.filter((p) => p.status === 'trash').length, 0, 'later sweeps do not ask for trash')
  assert.equal(state.activity.filter((a) => a.action === 'wc_order_trash_read_unsupported').length, 0, 'and do not log it again')
})

test('isWcUnsupportedStatusRefusal: only a 4xx that names status as invalid', async () => {
  const { isWcUnsupportedStatusRefusal } = await import('@/lib/connectors/woocommerce/sync/order-import')
  assert.equal(isWcUnsupportedStatusRefusal('WC API error: 400 Invalid parameter(s): status'), true)
  assert.equal(isWcUnsupportedStatusRefusal('WC API error: 401 Invalid signature'), false)
  assert.equal(isWcUnsupportedStatusRefusal('WC API error: 500 Invalid parameter(s): status'), false)
  assert.equal(isWcUnsupportedStatusRefusal('network timeout'), false)
})

test('a cancellation that fails to apply holds the cursor; a permanent refusal does not', async () => {
  reset()
  state.pages.cancelled = [[{ id: 1, status: 'cancelled' }]]
  state.linked = { '1': 'PROCESSING' }
  state.syncResult = { success: false, error: 'transient' }
  assert.equal((await run()).errors.length, 1)
  state.syncResult = { success: false, error: 'rule', permanent: true }
  assert.equal((await run()).errors.length, 0)
})

test('a walk that never reaches an empty page is escalated, not trusted', async () => {
  reset()
  const page = [{ id: 7, status: 'cancelled' }]
  state.pages.cancelled = [page, page, page, page]
  const result = await run()
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /ceiling/)
})

const CURSOR = 'wc_cancellation_backstop_cursor'
async function job(limits?: { maxPages: number; budgetMs: number }) {
  const { runWcCancellationBackstop } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return runWcCancellationBackstop(limits)
}
const BACKFILL = 'wc_cancellation_backstop_backfill'

test('backstop job: does nothing before the initial import is complete (no read, no cursor)', async () => {
  reset()
  const result = await job()
  assert.deepEqual(result.errors, [])
  assert.equal(state.asked.length, 0)
  assert.equal(state.settings.has(CURSOR), false)
})

test('backstop job, FIRST run (no cursor): reads cancelled and trash with NO modified_after, applies only to orders IMS holds, then sets its own cursor', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.pages.cancelled = [[{ id: 1, status: 'cancelled' }, { id: 2, status: 'cancelled' }]]
  state.linked = { '1': 'ALLOCATED' }
  const result = await job()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(state.applied, [{ id: 1, status: 'cancelled' }], 'an order IMS never imported is left alone')
  assert.ok(state.asked.length >= 2 && state.asked.every((p) => !('modified_after' in p)), 'an unbounded read of both statuses')
  assert.ok(Number.isFinite(Date.parse(state.settings.get(CURSOR) ?? '')), 'its own cursor is set')
})

test('backstop job, later run: bounded by its own cursor; a failed read holds the cursor', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.settings.set(CURSOR, '2026-11-10T00:00:00.000Z')
  state.fetchError.cancelled = 'WC API error: 503 down'
  const result = await job()
  assert.equal(result.errors.length, 1)
  assert.ok(state.asked.every((p) => p.modified_after === '2026-11-10T00:00:00.000Z'))
  assert.equal(state.settings.get(CURSOR), '2026-11-10T00:00:00.000Z', 'held')
  state.fetchError = {}
  state.asked = []
  assert.deepEqual((await job()).errors, [])
  assert.ok(Date.parse(state.settings.get(CURSOR)!) > Date.parse('2026-11-10T00:00:00.000Z'), 'advanced after a clean run')
})

test('the order sweep cursors are never read or written by the backstop job', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.settings.set('last_wc_order_reconcile_at', '2026-11-01T00:00:00.000Z')
  state.settings.set('last_wc_order_sync_at', '2026-11-02T00:00:00.000Z')
  await job()
  assert.equal(state.settings.get('last_wc_order_reconcile_at'), '2026-11-01T00:00:00.000Z')
  assert.equal(state.settings.get('last_wc_order_sync_at'), '2026-11-02T00:00:00.000Z')
})

const SLICE = { maxPages: 2, budgetMs: 60_000 }
// Orders created one minute apart, ids ascending with age.
function stored(ids: number[], status = 'cancelled') {
  return ids.map((id) => ({ id, status, date_created_gmt: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString().slice(0, 19) }))
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const appliedIds = () => [...new Set(state.applied.map((a) => Number(a.id)))].sort((a, b) => a - b)

test('backfill: bounded per run, resumes from the saved keyset position, and only the run that covers both statuses sets the cursor', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = stored(range(1, 250))
  state.store.trash = stored([251], 'trash')
  state.linked = Object.fromEntries(range(1, 251).map((i) => [String(i), 'ALLOCATED']))
  assert.deepEqual((await job(SLICE)).errors, [])
  assert.equal(state.asked.length, 2, 'at most maxPages reads per run')
  assert.equal(state.asked.every((p) => p.page === '1'), true, 'always page 1 (a keyset, not an offset)')
  assert.equal(state.settings.has(CURSOR), false, 'not complete yet: no cursor')
  const saved = JSON.parse(state.settings.get(BACKFILL)!)
  assert.equal(saved.status, 'cancelled')
  assert.ok(saved.after, 'a keyset position is saved')
  const startedAt = saved.startedAt
  await job(SLICE) // the short third page ends cancelled; trash is read
  state.asked = []
  const last = await job(SLICE)
  assert.deepEqual(last.errors, [])
  assert.ok(Number.isFinite(Date.parse(state.settings.get(CURSOR) ?? '')), 'cursor set once both statuses are covered')
  assert.ok(Date.parse(state.settings.get(CURSOR)!) <= Date.parse(startedAt), 'cursor is taken from when the backfill began')
  assert.deepEqual(appliedIds(), range(1, 251))
  state.asked = []
  await job(SLICE)
  assert.ok(state.asked.every((p) => 'modified_after' in p), 'later runs are in cursor mode with the window')
})

test('backfill: an order leaving the status between reads does not hide the order behind it (the page-shift skip)', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = stored(range(1, 150))
  state.linked = Object.fromEntries(range(1, 150).map((i) => [String(i), 'ALLOCATED']))
  // After page 1 is read, order 1 (already read) leaves `cancelled`. With page numbers, order 101 would slide onto page 1 and never be read.
  state.onFetch = (n) => { if (n === 1) state.store.cancelled = state.store.cancelled.filter((o) => o.id !== 1) }
  assert.deepEqual((await job({ maxPages: 50, budgetMs: 60_000 })).errors, [])
  assert.deepEqual(appliedIds(), range(1, 150), 'order 101 was applied')
  assert.ok(state.settings.has(CURSOR))
})

test('backfill: a full page that cannot advance the keyset (100 orders in one second) is an error, never a skip', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = range(1, 120).map((id) => ({ id, status: 'cancelled', date_created_gmt: '2026-01-01T00:00:00' }))
  const r = await job({ maxPages: 50, budgetMs: 60_000 })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /did not advance/)
  assert.equal(state.settings.has(CURSOR), false)
})

test('backfill: a full page without creation times cannot advance and is an error', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = range(1, 120).map((id) => ({ id, status: 'cancelled', date_created_gmt: '' }))
  state.store.cancelled = state.store.cancelled.map((o, i) => ({ ...o, date_created_gmt: i === 0 ? '' : '2026-01-01T00:00:00' }))
  const r = await job({ maxPages: 50, budgetMs: 60_000 })
  assert.equal(r.errors.length >= 1, true)
  assert.equal(state.settings.has(CURSOR), false)
})

test('backfill: a failed read holds the position (never skipped) and sets no cursor; the next run retries the same read', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = stored(range(1, 250))
  await job({ maxPages: 1, budgetMs: 60_000 })
  const held = JSON.parse(state.settings.get(BACKFILL)!)
  assert.ok(held.after)
  state.fetchError.cancelled = 'WC API error: 503 down'
  const failed = await job(SLICE)
  assert.equal(failed.errors.length, 1)
  assert.deepEqual(JSON.parse(state.settings.get(BACKFILL)!), held, 'position unchanged by the failure')
  assert.equal(state.settings.has(CURSOR), false)
  state.fetchError = {}
  state.asked = []
  assert.deepEqual((await job(SLICE)).errors, [])
  assert.equal(state.asked[0].after, held.after, 'resumes from the held position')
})

test('backfill: a page whose cancellation fails to apply is not passed', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = stored(range(1, 150))
  state.linked = { '1': 'ALLOCATED' }
  state.syncResult = { success: false, error: 'transient' }
  const r = await job(SLICE)
  assert.equal(r.errors.length, 1)
  assert.equal(JSON.parse(state.settings.get(BACKFILL)!).after, null, 'stays on the failed page')
  assert.equal(state.settings.has(CURSOR), false)
})

test('backfill: a position saved by the old page-numbered walk restarts that status from its beginning', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.settings.set(BACKFILL, JSON.stringify({ startedAt: '2026-11-01T00:00:00.000Z', status: 'cancelled', nextPage: 7 }))
  state.store.cancelled = stored([1])
  await job(SLICE)
  assert.equal(state.asked[0].after, undefined)
})

test('backfill: the time budget also ends a run, without an error', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.store.cancelled = stored([1, 2])
  const r = await job({ maxPages: 50, budgetMs: 0 })
  assert.deepEqual(r.errors, [])
  assert.equal(state.asked.length, 0)
  assert.equal(state.settings.has(CURSOR), false)
})

test('transaction reset: the reset clears the backstop cursor and backfill, and the next run backfills from the start', async () => {
  const { readFile } = await import('node:fs/promises')
  const { WC_CANCELLATION_BACKSTOP_CURSOR_KEY, WC_CANCELLATION_BACKFILL_KEY } = await import('@/lib/connectors/woocommerce/sync/order-import')
  assert.equal(WC_CANCELLATION_BACKSTOP_CURSOR_KEY, CURSOR)
  assert.equal(WC_CANCELLATION_BACKFILL_KEY, BACKFILL)
  const source = await readFile(new URL('../app/actions/reset.ts', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf('const WC_ORDER_SYNC_STATE_KEYS'), source.indexOf('] as const', source.indexOf('const WC_ORDER_SYNC_STATE_KEYS')))
  const cleared = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assert.ok(cleared.includes(CURSOR) && cleared.includes(BACKFILL), 'both keys are in the reset\'s cleared intake-state keys')

  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.settings.set(CURSOR, '2026-11-10T00:00:00.000Z')
  state.settings.set(BACKFILL, JSON.stringify({ status: 'trash', after: '2026-11-01T00:00:00.000Z', startedAt: '2026-11-09T00:00:00.000Z' }))
  for (const key of cleared) state.settings.delete(key) // what clearSettingKeys does
  state.settings.set('wc_initial_import_completed', 'true') // the re-import after the reset
  state.pages.cancelled = [[{ id: 1, status: 'cancelled' }]]
  state.linked = { '1': 'ALLOCATED' }
  const r = await job()
  assert.deepEqual(r.errors, [])
  assert.ok(state.asked.length >= 2 && state.asked.every((p) => !('modified_after' in p)), 'backfill from the start, not the old cursor window')
  assert.deepEqual(state.applied, [{ id: 1, status: 'cancelled' }], 're-imported order older than the old cursor is re-checked')
})
