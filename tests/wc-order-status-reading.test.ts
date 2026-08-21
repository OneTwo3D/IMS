import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-tj6v r5, finding 4: the THIRD reader of "what status is this?" — `syncWcOrderStatus` — reads
 * it the same way admission and creation do.
 *
 * The two readers used to fail in opposite directions on the same input. With no mapping row for a
 * status, `importWcOrder` invented PROCESSING (creating the order, allocating its stock and
 * queueing its accounting invoice) and this function invented "ignore" — so the very statuses
 * WooCommerce ships with became unreadable the moment an operator deleted a seeded row, and the
 * two paths then disagreed about the same order.
 *
 * These drive the REAL `syncWcOrderStatus`.
 */

type Row = Record<string, unknown>

const state = {
  /** The shopping_status_mappings rows a store holds. Empty models a deleted seed row. */
  mappings: [] as Array<{ externalStatus: string; imsStatus: string }>,
  imsStatus: 'PROCESSING',
  completionsRun: [] as string[],
  transitions: [] as Array<{ orderId: string; status: string }>,
  activity: [] as Row[],
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: {
        findUnique: async () => ({
          order: {
            id: 'so-1', externalOrderNumber: '5001', status: state.imsStatus,
            withdrawalHoldAt: null, withdrawalApprovedAt: null,
          },
        }),
      },
      shoppingStatusMapping: {
        findMany: async ({ where }: { where: { OR?: Array<{ externalStatus?: { equals?: string } }> } }) => {
          const wanted = (where.OR ?? [])
            .map((clause) => String(clause.externalStatus?.equals ?? '').toLowerCase())
          return state.mappings.filter((row) => wanted.includes(row.externalStatus.toLowerCase()))
        },
      },
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    handleWcWithdrawalStatus: async () => ({ kind: 'not-a-withdrawal' as const }),
  },
})

mock.module('@/lib/connectors/woocommerce/sync/completion-flow', {
  namedExports: {
    processWcCompletion: async (orderId: string) => { state.completionsRun.push(orderId) },
  },
})

mock.module('@/app/actions/sales', {
  namedExports: {
    applySalesOrderStatusTransition: async (orderId: string, status: string) => {
      state.transitions.push({ orderId, status })
      return { success: true }
    },
  },
})

function reset() {
  state.mappings = []
  state.imsStatus = 'PROCESSING'
  state.completionsRun = []
  state.transitions = []
  state.activity = []
}

function wcOrder(status: string) {
  return { id: 5001, number: '5001', status }
}

async function sync(status: string) {
  const { syncWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return syncWcOrderStatus(wcOrder(status) as never)
}

test('with NO mapping rows, a completed order still runs the completion flow', async () => {
  // The `!mapping` bail sits BEFORE the completed special case, so a deleted seed row silently
  // disabled fulfilment for every completed WooCommerce order — while `importWcOrder` was busy
  // creating the same orders as PROCESSING.
  reset()

  const result = await sync('completed')

  assert.equal(result.success, true)
  assert.deepEqual(state.completionsRun, ['so-1'])
})

test('with NO mapping rows, an on-hold order transitions to the built-in reading', async () => {
  reset()

  await sync('on-hold')

  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'ON_HOLD' }])
})

test('a status IMS has no reading of is IGNORED here — the same answer creation now gives', async () => {
  // Neither reader may invent one. Creation refuses to create; this one refuses to transition.
  reset()
  state.mappings = [{ externalStatus: 'processing', imsStatus: 'PROCESSING' }]

  const result = await sync('awaiting-parts')

  assert.equal(result.success, true, 'acknowledged — a redelivery would re-hit the same rule')
  assert.deepEqual(state.transitions, [], 'and nothing is forced onto the order')
  assert.deepEqual(state.completionsRun, [])
})

test('an operator mapping still OUTRANKS the built-in reading here too', async () => {
  // Paired with the built-in tests: defaults that could not be overridden would be the same class
  // of defect — a control the UI offers and nothing reads.
  reset()
  state.mappings = [{ externalStatus: 'wc-on-hold', imsStatus: 'CANCELLED' }]

  await sync('on-hold')

  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'CANCELLED' }])
})

test('an order already in the target status is still a no-op', async () => {
  reset()
  state.imsStatus = 'ON_HOLD'

  await sync('on-hold')

  assert.deepEqual(state.transitions, [], 'the built-in reading must not re-apply a status IMS already has')
})
