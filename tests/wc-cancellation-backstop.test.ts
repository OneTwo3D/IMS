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
        upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { if (!state.settings.has(where.key)) state.settings.set(where.key, create.value); return {} },
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
