import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { isMintsoftLoginForbidden } from '../../lib/connectors/mintsoft/api/auth-no-login'

/**
 * Every scheduled Mintsoft READ job runs inside withMintsoftNoLogin, so in username/password mode none of them can
 * reach POST /api/Auth (which mints a new tenant key and invalidates the old one for every integration).
 * Each stand-in below records whether the no-login scope was active at the moment the real job body would run.
 */
const seen: Record<string, boolean> = {}
const record = (name: string) => { seen[name] = isMintsoftLoginForbidden() }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/ops/cron-response', {
  namedExports: { cronResultResponse: (body: unknown) => body, cronSkippedResponse: (r: string) => ({ skipped: r }) },
})
mock.module('@/lib/ops/cron-outcomes', { namedExports: { cronOutcome: () => 'ok' } })
mock.module('@/lib/db', {
  namedExports: { db: { externalWmsBinding: { findMany: async () => [{ id: 'b1', lastStockSyncAt: null, syncFrequencyMinutes: 5 }] } } },
})
mock.module('@/lib/connectors/mintsoft/sync/stock-sync-helpers', { namedExports: { isMintsoftBindingDue: () => true } })
mock.module('@/lib/connectors/mintsoft/sync/stock-sync', {
  namedExports: { runStockSyncForBinding: async () => { record('mintsoft-stock-sync'); return { bindingId: 'b1', errors: [] } } },
})
mock.module('@/lib/connectors/mintsoft/sync/returns-sync', {
  namedExports: { runMintsoftReturnsSync: async () => { record('mintsoft-returns-sync'); return {} } },
})
mock.module('@/lib/connectors/mintsoft/sync/product-sync', {
  namedExports: { runMintsoftProductVerify: async () => { record('mintsoft-product-verify'); return {} } },
})
mock.module('@/lib/connectors/mintsoft/sync/bundle-sync', {
  namedExports: { runMintsoftBundleVerify: async () => { record('mintsoft-bundle-verify'); return {} } },
})
mock.module('@/lib/domain/wms/order-status-sweep', {
  namedExports: { runWmsOrderStatusSweep: async () => { record('wms-order-status'); return {} } },
})
mock.module('@/lib/domain/wms/order-reconcile-sweep', {
  namedExports: { runWmsOrderReconcileSweep: async () => { record('wms-order-reconcile'); return {} } },
})
mock.module('@/lib/jobs/wms/process-mintsoft-booked-in-event', {
  namedExports: {
    enqueueMintsoftBookedInRecheckForAsn: async () => undefined,
    sweepUnprocessedMintsoftBookedInEvents: async () => { record('mintsoft-webhook-sweeper'); return {} },
  },
})
mock.module('@/lib/domain/wms/post-maintenance-recheck', {
  namedExports: { runPostMaintenanceBookedInRecheck: async () => { record('mintsoft-webhook-sweeper:recheck'); return {} } },
})

const ROUTES = [
  'mintsoft-stock-sync', 'mintsoft-returns-sync', 'mintsoft-product-verify', 'mintsoft-bundle-verify',
  'wms-order-status', 'wms-order-reconcile', 'mintsoft-webhook-sweeper',
] as const

for (const name of ROUTES) {
  test(`cron ${name} runs with Mintsoft login forbidden`, async () => {
    const mod = await import(`@/app/api/cron/${name}/route`)
    await mod.GET(new Request('http://localhost/'))
    assert.equal(seen[name], true, `${name} body ran outside withMintsoftNoLogin`)
    if (name === 'mintsoft-webhook-sweeper') assert.equal(seen[`${name}:recheck`], true)
  })
}

test('the no-login scope does not leak outside the cron run', () => {
  assert.equal(isMintsoftLoginForbidden(), false)
})
