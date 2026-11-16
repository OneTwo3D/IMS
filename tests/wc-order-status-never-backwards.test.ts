import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.81: the WooCommerce status is applied through the full transition bypass, so the state machine is asked
 * BEFORE it. A SHIPPED / COMPLETED / DELIVERED order never goes backwards because a stale retry, an unrelated plugin
 * save or an admin edit still carries `processing` / `on-hold` / `pending`; fulfilment progress (ALLOCATED / PICKING /
 * PACKING) is not undone by an unchanged `processing`. These drive the REAL `syncWcOrderStatus`.
 */
type Row = Record<string, unknown>
const state = { imsStatus: 'SHIPPED', transitions: [] as Array<{ orderId: string; status: string }>, activity: [] as Row[] }

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: Row) => { state.activity.push(e) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingOrderLink: { findUnique: async () => ({ order: { id: 'so-1', externalOrderNumber: '5001', status: state.imsStatus, withdrawalHoldAt: null, withdrawalApprovedAt: null } }) },
      shoppingStatusMapping: { findMany: async () => [] },
    },
  },
})
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', { namedExports: { handleWcWithdrawalStatus: async () => ({ kind: 'not-a-withdrawal' as const }) } })
mock.module('@/lib/connectors/woocommerce/sync/completion-flow', { namedExports: { processWcCompletion: async () => ({ kind: 'fulfilled' as const }) } })
mock.module('@/app/actions/sales', {
  namedExports: { applySalesOrderStatusTransition: async (orderId: string, status: string) => { state.transitions.push({ orderId, status }); return { success: true } } },
})

async function sync(ims: string, wc: string) {
  state.imsStatus = ims
  state.transitions = []
  state.activity = []
  const { syncWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/order-status')
  return syncWcOrderStatus({ id: 5001, number: '5001', status: wc } as never)
}

for (const ims of ['SHIPPED', 'COMPLETED', 'DELIVERED']) {
  for (const wc of ['processing', 'on-hold', 'pending']) {
    test(`a ${ims} order is NOT moved backwards by a WooCommerce ${wc}`, async () => {
      const result = await sync(ims, wc)
      assert.equal(result.success, true, 'acknowledged: a redelivery would meet the same rule')
      assert.deepEqual(state.transitions, [], 'no transition is applied')
      assert.equal(state.activity.filter((a) => a.action === 'status_sync_skipped_backwards').length, 1, 'and the skip is recorded')
    })
  }
}

test('an ALLOCATED / PICKING / PACKING order keeps its progress when WooCommerce still says processing', async () => {
  for (const ims of ['ALLOCATED', 'PICKING', 'PACKING']) {
    await sync(ims, 'processing')
    assert.deepEqual(state.transitions, [], `${ims} stays`)
  }
})

test('forward moves are still applied: PROCESSING -> ON_HOLD, ON_HOLD -> PROCESSING, PROCESSING/ALLOCATED -> CANCELLED', async () => {
  await sync('PROCESSING', 'on-hold')
  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'ON_HOLD' }])
  await sync('ON_HOLD', 'processing')
  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'PROCESSING' }])
  await sync('PROCESSING', 'cancelled')
  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'CANCELLED' }])
  await sync('ALLOCATED', 'cancelled')
  assert.deepEqual(state.transitions, [{ orderId: 'so-1', status: 'CANCELLED' }])
})

test('a SHIPPED order still completes through the completion flow (forward)', async () => {
  const result = await sync('SHIPPED', 'completed')
  assert.equal(result.success, true)
})

test('wcStatusSyncRefusal: the machine decides', async () => {
  const { wcStatusSyncRefusal } = await import('@/lib/connectors/woocommerce/sync/order-status')
  assert.equal(wcStatusSyncRefusal('SHIPPED', 'COMPLETED'), null)
  assert.match(String(wcStatusSyncRefusal('DELIVERED', 'PROCESSING')), /does not allow/)
  assert.match(String(wcStatusSyncRefusal('PACKING', 'PROCESSING')), /does not allow|further along/)
  assert.equal(wcStatusSyncRefusal('PROCESSING', 'PROCESSING'), null)
})
