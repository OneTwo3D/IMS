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
      return { data: state.pages[params.status]?.[Number(params.page) - 1] ?? [], error: null }
    },
    wcPut: async () => ({ data: null }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-status', {
  namedExports: { syncWcOrderStatus: async (o: Row) => { state.applied.push({ id: o.id, status: o.status }); return state.syncResult } },
})

function reset() {
  state.pages = {}; state.fetchError = {}; state.linked = {}; state.applied = []; state.syncResult = { success: true }; state.asked = []; state.activity = []; state.settings = new Map()
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
function order(id: number, status = 'cancelled') { return { id, status } }

test('backfill: bounded per run, resumes from the saved position, and only the run that covers both statuses sets the cursor', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.pages.cancelled = [[order(1)], [order(2)], [order(3)], [order(4)]]
  state.pages.trash = [[order(5, 'trash')]]
  state.linked = { '1': 'ALLOCATED', '2': 'ALLOCATED', '3': 'ALLOCATED', '4': 'ALLOCATED', '5': 'ALLOCATED' }
  assert.deepEqual((await job(SLICE)).errors, [])
  assert.equal(state.asked.length, 2, 'at most maxPages reads per run')
  assert.equal(state.settings.has(CURSOR), false, 'not complete yet: no cursor')
  assert.deepEqual(JSON.parse(state.settings.get(BACKFILL)!), { startedAt: JSON.parse(state.settings.get(BACKFILL)!).startedAt, status: 'cancelled', nextPage: 3 })
  const startedAt = JSON.parse(state.settings.get(BACKFILL)!).startedAt
  // Resumes one page behind the saved position (page 2), reaches 3 and 4.
  state.asked = []
  await job(SLICE)
  assert.deepEqual(state.asked.map((p) => `${p.status}:${p.page}`), ['cancelled:2', 'cancelled:3'])
  assert.equal(state.settings.has(CURSOR), false)
  // Next: 4, the empty page 5 ends cancelled; trash is reached on the following run.
  state.asked = []
  await job(SLICE)
  assert.deepEqual(state.asked.map((p) => `${p.status}:${p.page}`), ['cancelled:3', 'cancelled:4'])
  state.asked = []
  await job(SLICE)
  assert.equal(state.settings.has(CURSOR), false)
  state.asked = []
  const last = await job(SLICE)
  assert.deepEqual(last.errors, [])
  assert.ok(state.asked.every((p) => !('modified_after' in p)))
  assert.ok(state.asked.some((p) => p.status === 'trash'))
  assert.ok(Number.isFinite(Date.parse(state.settings.get(CURSOR) ?? '')), 'cursor set once both statuses are covered')
  assert.ok(Date.parse(state.settings.get(CURSOR)!) <= Date.parse(startedAt), 'cursor is taken from when the backfill began')
  assert.ok(state.applied.some((a) => a.id === 5), 'trash order applied')
  assert.deepEqual([...new Set(state.applied.map((a) => a.id))].sort(), [1, 2, 3, 4, 5])
  // Later runs are in cursor mode with the window.
  state.asked = []
  await job(SLICE)
  assert.ok(state.asked.every((p) => 'modified_after' in p))
})

test('backfill: a failed read holds the position (never skipped) and sets no cursor; the next run retries the same page', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.pages.cancelled = [[order(1)], [order(2)], [order(3)]]
  await job({ maxPages: 1, budgetMs: 60_000 })
  const held = JSON.parse(state.settings.get(BACKFILL)!)
  assert.equal(held.nextPage, 2)
  state.fetchError.cancelled = 'WC API error: 503 down'
  const failed = await job(SLICE)
  assert.equal(failed.errors.length, 1)
  assert.deepEqual(JSON.parse(state.settings.get(BACKFILL)!), held, 'position unchanged by the failure')
  assert.equal(state.settings.has(CURSOR), false)
  state.fetchError = {}
  state.asked = []
  assert.deepEqual((await job(SLICE)).errors, [])
  assert.equal(state.asked[0].page, '1', 'resumes one page behind the held position')
})

test('backfill: a page whose cancellation fails to apply is not passed', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.pages.cancelled = [[order(1)], [order(2)]]
  state.linked = { '1': 'ALLOCATED' }
  state.syncResult = { success: false, error: 'transient' }
  const r = await job(SLICE)
  assert.equal(r.errors.length, 1)
  assert.equal(JSON.parse(state.settings.get(BACKFILL)!).nextPage, 1, 'stays on the failed page')
  assert.equal(state.settings.has(CURSOR), false)
})

test('backfill: the time budget also ends a run, without an error', async () => {
  reset()
  state.settings.set('wc_initial_import_completed', 'true')
  state.pages.cancelled = [[order(1)], [order(2)]]
  const r = await job({ maxPages: 50, budgetMs: 0 })
  assert.deepEqual(r.errors, [])
  assert.equal(state.asked.length, 0)
  assert.equal(state.settings.has(CURSOR), false)
})
