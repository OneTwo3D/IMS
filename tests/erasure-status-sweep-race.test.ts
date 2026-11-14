import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * AN ERASURE THAT COMMITS WHILE THE WAREHOUSE LOOKUP IS IN FLIGHT.
 *
 * The status sweep reads its orders, then makes a remote lookup that can take seconds, then persists what it fetched. If
 * the erasure commits during the lookup, the fetched tracking number, carrier and link must not be written and nothing
 * may be pushed to the storefront. The marker is therefore read again, under the order lock, in the transaction that
 * writes the snapshot. Here the lookup itself flips the marker (as an erasure committing mid-flight would), so a sweep
 * that trusted the value it read before the lookup would store the tracking number and push.
 */

const state = { erased: false, eraseDuringLookup: false, snapshots: [] as Array<Record<string, unknown>>, pushes: 0, locks: 0, order: [] as string[] }

mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) } })
mock.module('@/lib/connectors/wms/types', { namedExports: { WMS_CONNECTOR_IDS: ['mintsoft'] } })
mock.module('@/lib/connectors/wms/order-lookup', { namedExports: { resolveWmsOrderLookupConnector: async () => ({ kind: 'one', connector: 'woocommerce' }) } })
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
    getWmsConnector: () => ({
      fetchOrderStatus: async () => {
        if (state.eraseDuringLookup) state.erased = true
        return {
          externalOrderId: 'm1', externalOrderNumber: 'SO-1', status: 'Despatched', statusLabel: 'Despatched', isSplit: false, partCount: null,
          isMerged: false, mergedOrderNumbers: [], deepLinkUrl: 'https://wms.example.test/o/m1',
          tracking: [{ trackingNumber: 'TRK-RACE-1', carrier: 'Royal Mail' }],
        }
      },
    }),
  },
})
mock.module('@/lib/shopping', { namedExports: { pushWmsOrderStatusToShopping: async () => { state.pushes += 1; return { success: true } }, listRunnableShoppingConnectorIds: async () => ['woocommerce'] } })
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => { state.locks += 1; state.order.push('lock') } },
})
const dbMock = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
  setting: { upsert: async () => ({}) },
  salesOrder: {
    count: async () => 0,
    findMany: async () => [{ id: 'order-1', shoppingLinks: [{ externalOrderNumber: 'SO-1' }], wmsOrderStatus: null }],
    findUnique: async () => { state.order.push('read-marker'); return { erasedAt: state.erased ? new Date() : null } },
  },
  wmsOrderPushLink: { updateMany: async () => ({ count: 0 }) },
  wmsOrderStatusSnapshot: {
    findUnique: async () => null,
    update: async () => ({}),
    upsert: async ({ create }: { create: Record<string, unknown> }) => { state.order.push('write'); state.snapshots.push(create); return create },
  },
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })

async function sweep() {
  state.snapshots = []; state.pushes = 0; state.locks = 0; state.order = []
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  await runWmsOrderStatusSweep()
}

test('control: an order that is not erased stores the fetched tracking and pushes the status', async () => {
  state.erased = false; state.eraseDuringLookup = false
  await sweep()
  assert.equal(state.snapshots[0]?.trackingNumber, 'TRK-RACE-1')
  assert.equal(state.snapshots[0]?.carrier, 'Royal Mail')
  assert.equal(state.pushes, 1)
})

test('an erasure committing DURING the lookup: tracking, carrier and link are not stored and nothing is pushed', async () => {
  state.erased = false; state.eraseDuringLookup = true
  await sweep()
  assert.equal(state.snapshots.length, 1, 'the status itself is still cached')
  assert.deepEqual([state.snapshots[0]!.trackingNumber, state.snapshots[0]!.carrier, state.snapshots[0]!.deepLinkUrl], [null, null, null])
  assert.equal(state.snapshots[0]!.status, 'Despatched')
  assert.equal(state.pushes, 0, 'no storefront push for an erased order')
})

test('the marker is read after the order lock and before the snapshot write', async () => {
  state.erased = false; state.eraseDuringLookup = false
  await sweep()
  const i = state.order.indexOf('lock'), j = state.order.indexOf('read-marker'), k = state.order.indexOf('write')
  assert.ok(i >= 0 && i < j && j < k, state.order.join(','))
})
