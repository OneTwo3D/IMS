import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The admission-refusal drain reports a failed by-id read or import as `failed` and keeps the expected unresolved states (the order is gone from
 * the store) apart. Queue-only run (the other sweeps empty): a failed read answers 500, a gone order answers 200.
 */

const state = { readError: 'WC API error: 500 boom' as string | null, orderStatus: 'processing' }
const rows = [{ id: 'r1', payload: { externalOrderId: '1001', attempts: 0 }, externalId: '1001' }]

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => ({ value: 'true' }) },
      shoppingSyncLog: { findMany: async () => rows, update: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        cronRun: { create: async () => undefined },
        activityLog: { create: async () => ({}) },
      }),
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: { wcFetch: async () => (state.readError ? { data: null, totalPages: 0, totalItems: 0, error: state.readError } : { data: { status: state.orderStatus }, totalPages: 1, totalItems: 1 }) },
})
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    sweepWithdrawalSuppressions: async () => ({ scanned: 0, imported: 0, stillWithdrawn: 0, unresolved: 0 }),
    sweepDispatchEligibleWithdrawals: async () => ({ scanned: 0, withdrawn: 0, applied: 0, retracted: 0, unresolved: 0, wrapped: false }),
    importWcOrderGuarded: async () => ({ outcome: 'unresolved' }),
  },
})
mock.module('@/lib/connectors/woocommerce/sync/order-import', { namedExports: { importWcOrder: async () => ({ success: true }) } })
mock.module('@/lib/connectors/woocommerce/sync/anonymisation-sweep', {
  namedExports: { runWithErasureSweepAlways: async (work: () => Promise<Record<string, unknown>>) => ({ ...(await work()), erasureSweep: { skipped: true, reason: 'not_due' } }) },
})

const request = (): Request => new Request('http://localhost/api/cron/wc-withdrawal-sweep')

test('queue-only: a failed by-id read answers 500; a gone order and a busy first-import lock answer 200', async () => {
  const { GET } = await import('@/app/api/cron/wc-withdrawal-sweep/route')
  state.readError = 'WC API error: 500 boom'
  const failed = await GET(request())
  assert.equal(failed.status, 500)
  const body = await failed.json() as { admissionRefusals: { failed: number; unresolved: number } }
  assert.equal(body.admissionRefusals.failed, 1)
  assert.equal(body.admissionRefusals.unresolved, 0)

  state.readError = 'WC API error: 404 No order found'
  const gone = await GET(request())
  assert.equal(gone.status, 200)
  assert.equal(((await gone.json()) as { admissionRefusals: { unresolved: number } }).admissionRefusals.unresolved, 1)

  // the order reads, and the guarded importer cannot decide (lock busy): expected, 200
  state.readError = null
  assert.equal((await GET(request())).status, 200)
})
