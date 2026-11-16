import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.81: the WooCommerce status is applied through the full transition bypass, so the state machine is asked
 * BEFORE it. A SHIPPED / COMPLETED / DELIVERED order never goes backwards because a stale retry, an unrelated plugin
 * save or an admin edit still carries `processing` / `on-hold` / `pending`; fulfilment progress (ALLOCATED / PICKING /
 * PACKING) is not undone by an unchanged `processing`. These drive the REAL `syncWcOrderStatus`.
 */
type Row = Record<string, unknown>
const state = {
  imsStatus: 'SHIPPED', transitions: [] as Array<{ orderId: string; status: string }>, activity: [] as Row[],
  guards: [] as Array<((current: string) => string | null) | undefined>,
  applyResult: { success: true } as { success: boolean; error?: string; permanent?: boolean },
}

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
  namedExports: { applySalesOrderStatusTransition: async (orderId: string, status: string, _x: unknown, options?: { guardUnderLock?: (c: string) => string | null }) => { state.transitions.push({ orderId, status }); state.guards.push(options?.guardUnderLock); return state.applyResult } },
})

async function sync(ims: string, wc: string) {
  state.imsStatus = ims
  state.transitions = []
  state.activity = []
  state.guards = []
  state.applyResult = { success: true }
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

test('the write carries a guard that re-asks the machine against the CURRENT status under the order lock', async () => {
  await sync('PROCESSING', 'on-hold')
  const guard = state.guards[0]
  assert.equal(typeof guard, 'function')
  assert.equal(guard!('PROCESSING'), null, 'still legal from the status that was read')
  assert.match(String(guard!('SHIPPED')), /does not allow/, 'refused once a dispatch has committed')
})

test('a refusal made under the lock is a skip (acknowledged, recorded), not a failure', async () => {
  const { STATUS_GUARD_REFUSAL_PREFIX } = await import('@/lib/domain/sales/status-transition-errors')
  state.imsStatus = 'PROCESSING'
  state.activity = []
  state.applyResult = { success: false, permanent: true, error: `${STATUS_GUARD_REFUSAL_PREFIX}IMS does not allow SHIPPED -> ON_HOLD` }
  const { syncWcOrderStatus } = await import('@/lib/connectors/woocommerce/sync/order-status')
  const result = await syncWcOrderStatus({ id: 5001, number: '5001', status: 'on-hold' } as never)
  assert.equal(result.success, true)
  assert.equal(state.activity.filter((a) => a.action === 'status_sync_skipped_backwards').length, 1)
  assert.equal(state.activity.filter((a) => a.action === 'status_sync_failed').length, 0)
})
