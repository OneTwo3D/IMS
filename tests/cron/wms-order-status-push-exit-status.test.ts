import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { cronOutcome } from '../../lib/ops/cron-outcomes.ts'
import { OutboundWriteHeldError } from '../../lib/security/outbound-write-grant.ts'

/**
 * The storefront status push of the WMS order status sweep: with no runnable storefront connector (plugin off, a state chosen on purpose) nothing is
 * pushed and nothing is an error; a runnable connector that fails is an error (500); a hold-refused push is held (200).
 */

process.env.SETTINGS_ENCRYPTION_KEY ||= 'a'.repeat(64)

const state = { runnable: [] as string[], pushError: null as string | null, pushes: 0 }

mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) } })
mock.module('@/lib/connectors/wms/types', { namedExports: { WMS_CONNECTOR_IDS: ['mintsoft'] } })
mock.module('@/lib/connectors/wms/order-lookup', { namedExports: { resolveWmsOrderLookupConnector: async () => ({ kind: 'one', connector: 'woocommerce' }) } })
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
    getWmsConnector: () => ({
      fetchOrderStatus: async () => ({
        externalOrderId: 'm1', externalOrderNumber: 'SO-1', status: 'Despatched', statusLabel: 'Despatched', isSplit: false, partCount: null,
        isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [],
      }),
    }),
  },
})
mock.module('@/lib/shopping', {
  namedExports: {
    listRunnableShoppingConnectorIds: async () => state.runnable,
    pushWmsOrderStatusToShopping: async () => {
      state.pushes += 1
      return state.pushError ? { success: false, error: state.pushError } : { success: true }
    },
  },
})
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => undefined } })
const dbMock = {
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock),
  setting: { upsert: async () => ({}) },
  salesOrder: {
    count: async () => 0,
    findMany: async () => [{ id: 'order-1', shoppingLinks: [{ externalOrderNumber: 'SO-1' }], wmsOrderStatus: null }],
    findUnique: async () => ({ erasedAt: null }),
  },
  wmsOrderPushLink: { updateMany: async () => ({ count: 0 }) },
  wmsOrderStatusSnapshot: { findUnique: async () => null, update: async () => ({}), upsert: async ({ create }: { create: Record<string, unknown> }) => create },
}
mock.module('@/lib/db', { namedExports: { db: dbMock } })

const run = async () => {
  state.pushes = 0
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  return runWmsOrderStatusSweep()
}

test('no runnable storefront connector: nothing is pushed, nothing is an error, the run is not a failure', async () => {
  state.runnable = []
  state.pushError = 'No runnable shopping connector configured'
  const result = await run()
  assert.equal(state.pushes, 0)
  assert.equal(result.errors, undefined)
  assert.equal(result.pushSkipped, 1)
  assert.equal(cronOutcome('wms-order-status', result as never), 'ok')
})

test('a runnable connector whose push fails is an error and fails the run; a hold-refused push is held', async () => {
  state.runnable = ['woocommerce']
  state.pushError = 'WooCommerce: WC API error: 500 boom'
  const failed = await run()
  assert.equal(state.pushes, 1)
  assert.deepEqual(failed.errors, ['WooCommerce: WC API error: 500 boom'])
  assert.equal(cronOutcome('wms-order-status', failed as never), 'failed')

  state.pushError = new OutboundWriteHeldError(
    { connector: 'woocommerce', code: 'no_grant', method: 'PUT', target: 'https://shop.example.test/wp-json/wc/v3/orders/1', granted: null, attempted: null, basis: 'test' },
    0,
  ).message
  assert.equal(cronOutcome('wms-order-status', (await run()) as never), 'held')

  state.pushError = null
  assert.equal(cronOutcome('wms-order-status', (await run()) as never), 'ok')
})
