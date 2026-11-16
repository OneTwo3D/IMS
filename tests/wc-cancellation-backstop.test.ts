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
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: Row) => { state.activity.push(e) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
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
  state.pages = {}; state.fetchError = {}; state.linked = {}; state.applied = []; state.syncResult = { success: true }; state.asked = []; state.activity = []
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

test('a failed cancelled read is an error (the cursor is held); a failed trash read is only a warning', async () => {
  reset()
  state.fetchError.cancelled = 'boom'
  assert.equal((await run()).errors.length, 1)
  reset()
  state.fetchError.trash = 'invalid status'
  const result = await run()
  assert.deepEqual(result.errors, [])
  assert.equal(state.activity.filter((a) => a.action === 'wc_order_trash_read_failed').length, 1)
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
