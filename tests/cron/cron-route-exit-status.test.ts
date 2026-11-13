import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ROUTE-LEVEL EXIT STATUS. Each route is called through its real GET with the sweep behind it doubled, and the HTTP status is what the
 * crontab wrapper's `curl -sf` (and Healthchecks behind it) sees. The shapes are the routes' own result types: an uppercase status
 * enum with a numeric error count, a count of failed items, a per-binding list.
 */

type Doubles = {
  reconcile: unknown
  dispatch: unknown
  stock: unknown
  returns: unknown
  push: unknown
  wc: unknown
  invoiceDocs: unknown
}
const recorded: string[] = []
const doubles: Doubles = { reconcile: null, dispatch: null, stock: null, returns: null, push: null, wc: null, invoiceDocs: null }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/integration-plugins', { namedExports: { isIntegrationPluginEnabled: async () => true } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => ({ value: 'true' }) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        cronRun: { create: async (args: { data: { status: string } }) => { recorded.push(args.data.status) } },
        activityLog: { create: async () => ({}) },
      }),
      externalWmsBinding: { findMany: async () => [{ id: 'b1', lastStockSyncAt: null, syncFrequencyMinutes: 15 }] } },
  },
})
mock.module('@/lib/domain/wms/order-reconcile-sweep', { namedExports: { runWmsOrderReconcileSweep: async () => doubles.reconcile } })
mock.module('@/lib/domain/wms/order-push-sweep', { namedExports: { runWmsOrderPushSweep: async () => doubles.push } })
mock.module('@/lib/connectors/mintsoft/sync/dispatch-poll', { namedExports: { runMintsoftDispatchPoll: async () => doubles.dispatch } })
mock.module('@/lib/connectors/mintsoft/sync/returns-sync', { namedExports: { runMintsoftReturnsSync: async () => doubles.returns } })
mock.module('@/lib/connectors/mintsoft/sync/stock-sync', { namedExports: { runStockSyncForBinding: async () => doubles.stock } })
mock.module('@/lib/connectors/mintsoft/sync/stock-sync-helpers', { namedExports: { isMintsoftBindingDue: () => true } })
mock.module('@/lib/connectors/woocommerce/sync/reconcile', { namedExports: { runWcReconcile: async () => doubles.wc } })
mock.module('@/lib/domain/invoice-documents/sweep', { namedExports: { runInvoiceDocumentSweep: async () => doubles.invoiceDocs } })
mock.module('@/lib/domain/invoice-documents/health', { namedExports: { getInvoiceDocumentHealth: async () => ({ needsAttention: 0, pending: 0, oldestPendingAt: null }) } })
mock.module('@/lib/connectors/xero/invoice-document-deps', { namedExports: { xeroInvoiceDocumentDeps: () => ({}) } })
mock.module('@/lib/domain/purchasing/product-lead-time', { namedExports: { recomputeProductObservedLeadTimes: async () => ({}) } })

const request = (): Request => new Request('http://localhost/api/cron/x')
const statusOf = async (load: () => Promise<{ GET: (request: Request) => Promise<Response> }>): Promise<number> => (await (await load()).GET(request())).status

const reconcileRoute = () => import('@/app/api/cron/wms-order-reconcile/route')
const dispatchRoute = () => import('@/app/api/cron/mintsoft-dispatch-sync/route')
const stockRoute = () => import('@/app/api/cron/mintsoft-stock-sync/route')
const pushRoute = () => import('@/app/api/cron/wms-order-push/route')
const returnsRoute = () => import('@/app/api/cron/mintsoft-returns-sync/route')

const counters = { intentChecked: 1, linksVerified: 1, cancelledVerified: 0, findings: 0, errors: 0 }

test('wms-order-reconcile: SUCCEEDED and SKIPPED answer 2xx, PARTIAL and FAILED answer 500', async () => {
  doubles.reconcile = { jobId: 'j', status: 'SUCCEEDED', counters }
  assert.equal(await statusOf(reconcileRoute), 200)
  doubles.reconcile = { jobId: null, status: 'SKIPPED', counters, skippedReason: 'No WMS connector is enabled' }
  assert.equal(await statusOf(reconcileRoute), 200)
  doubles.reconcile = { jobId: 'j', status: 'PARTIAL', counters: { ...counters, errors: 2 } }
  assert.equal(await statusOf(reconcileRoute), 500)
  doubles.reconcile = { jobId: 'j', status: 'FAILED', counters: { ...counters, errors: 1 } }
  assert.equal(await statusOf(reconcileRoute), 500)
})

test('mintsoft-dispatch-sync: the status enum and the held count decide', async () => {
  doubles.dispatch = { jobId: 'j', status: 'SUCCEEDED', totalChecked: 3, dispatched: 1, pending: 2, errors: 0 }
  assert.equal(await statusOf(dispatchRoute), 200)
  doubles.dispatch = { skipped: true, reason: 'Mintsoft poll authentication unavailable' }
  assert.equal(await statusOf(dispatchRoute), 200)
  doubles.dispatch = { jobId: 'j', status: 'PARTIAL', totalChecked: 3, dispatched: 1, pending: 0, errors: 2 }
  assert.equal(await statusOf(dispatchRoute), 500)
  doubles.dispatch = { jobId: 'j', status: 'FAILED', totalChecked: 3, dispatched: 0, pending: 0, errors: 1, skippedReason: 'boom' }
  assert.equal(await statusOf(dispatchRoute), 500)
  // Every error is a write the outbound-write hold refused: held, not failed.
  doubles.dispatch = { jobId: 'j', status: 'PARTIAL', totalChecked: 2, dispatched: 0, pending: 0, errors: 2, outboundHeld: 2 }
  assert.equal(await statusOf(dispatchRoute), 200)
  doubles.dispatch = { jobId: 'j', status: 'PARTIAL', totalChecked: 3, dispatched: 0, pending: 0, errors: 3, outboundHeld: 2 }
  assert.equal(await statusOf(dispatchRoute), 500)
})

test('mintsoft-stock-sync: one failing binding makes the run fail; skipped bindings do not', async () => {
  const base = { bindingId: 'b1', warehouseId: 'w', warehouseCode: 'W1', jobId: 'j', totalChecked: 5, matched: 5, mismatched: 0, corrected: 0, skipped: 0, notifiedUsers: 0 }
  doubles.stock = { ...base, status: 'SUCCEEDED', errors: 0 }
  assert.equal(await statusOf(stockRoute), 200)
  doubles.stock = { ...base, status: 'SKIPPED', errors: 0, skippedReason: 'Binding is not due' }
  assert.equal(await statusOf(stockRoute), 200)
  doubles.stock = { ...base, status: 'PARTIAL', errors: 2 }
  assert.equal(await statusOf(stockRoute), 500)
  doubles.stock = { ...base, status: 'FAILED', errors: 1 }
  assert.equal(await statusOf(stockRoute), 500)
})

test('mintsoft-returns-sync: the status enum decides', async () => {
  const base = { jobId: 'j', totalChecked: 1, matched: 1, mismatched: 0, corrected: 0, skipped: 0 }
  doubles.returns = { ...base, status: 'SUCCEEDED', errors: 0 }
  assert.equal(await statusOf(returnsRoute), 200)
  doubles.returns = { ...base, status: 'PARTIAL', errors: 1 }
  assert.equal(await statusOf(returnsRoute), 500)
})

test('wms-order-push: failed pushes answer 500; pushes the hold refused do not; a skip is 2xx', async () => {
  const base = { created: 0, verified: 0, verifyQuarantined: 0, verifyUnresolved: 0, updated: 0, cancelled: 0, held: 0, released: 0, failed: 0, deadLettered: 0, validationFailed: 0, revalidated: 0, revalidateAmbiguous: 0, createClaimParked: 0, ambiguousCreateRequeued: 0 }
  doubles.push = { ...base, created: 2 }
  assert.equal(await statusOf(pushRoute), 200)
  doubles.push = { skipped: 'No WMS connector is enabled', ...base }
  assert.equal(await statusOf(pushRoute), 200)
  doubles.push = { ...base, failed: 1 }
  assert.equal(await statusOf(pushRoute), 500)
  doubles.push = { ...base, deadLettered: 1 }
  assert.equal(await statusOf(pushRoute), 500)
  // Orders NEWLY parked this run (counted once, on entry): the payload could not be built; a dispatched create has no recorded outcome. Each is a failed run.
  doubles.push = { ...base, validationFailed: 1 }
  assert.equal(await statusOf(pushRoute), 500)
  doubles.push = { ...base, createClaimParked: 1 }
  assert.equal(await statusOf(pushRoute), 500)
  // A pre-existing backlog is not counted again: a later healthy sweep (nothing newly parked; parked links waiting on the warehouse or an operator) is green.
  doubles.push = { ...base, created: 3, verifyUnresolved: 2, revalidated: 1, revalidateAmbiguous: 2, ambiguousCreateRequeued: 1 }
  assert.equal(await statusOf(pushRoute), 200)
  // `held` here counts orders put on hold in the warehouse, which is not a hold on writes.
  doubles.push = { ...base, held: 3 }
  assert.equal(await statusOf(pushRoute), 200)
  // a held create whose only record could not be written was not handled at all: a failure, though it name-matches no failure counter
  doubles.push = { ...base, shadowUnrecorded: 1 }
  assert.equal(await statusOf(pushRoute), 500)
  doubles.push = { ...base, failed: 2, outboundHeld: 2 }
  assert.equal(await statusOf(pushRoute), 200)
  doubles.push = { ...base, failed: 3, outboundHeld: 2 }
  assert.equal(await statusOf(pushRoute), 500)
})

test('recompute-product-lead-times: failed > 0 answers 500 and is recorded failed; none answers 200', async () => {
  const { handleRecomputeProductLeadTimesCron } = await import('@/app/api/cron/recompute-product-lead-times/route')
  const run = async (result: { scanned: number; updated: number; cleared: number; failed: number }) => {
    const logs: Array<{ status: string }> = []
    const response = await handleRecomputeProductLeadTimesCron(request(), {
      recompute: async () => result,
      writeLog: async (log) => { logs.push(log) },
      checkCronRateLimit: async () => ({ allowed: true }) as never,
    })
    return { status: response.status, recorded: logs[0]?.status }
  }
  assert.deepEqual(await run({ scanned: 4, updated: 3, cleared: 1, failed: 0 }), { status: 200, recorded: 'completed' })
  assert.deepEqual(await run({ scanned: 4, updated: 2, cleared: 0, failed: 2 }), { status: 500, recorded: 'failed' })
})

test('wc-reconcile: permanent product conflicts with an empty errors list answer 500 and are recorded failed', async () => {
  const { GET } = await import('@/app/api/cron/wc-reconcile/route')
  doubles.wc = { orders: { synced: 1, skipped: 0, errors: [] }, products: { synced: 2, skipped: 0, errors: [], permanentErrors: ['SKU A-1: duplicate SKU'] } }
  const response = await GET(request())
  assert.equal(response.status, 500)
  assert.equal(recorded.at(-1), 'failed')
  doubles.wc = { orders: { synced: 1, skipped: 0, errors: [] }, products: { synced: 2, skipped: 0, errors: [], permanentErrors: [] } }
  assert.equal((await GET(request())).status, 200)
  assert.equal(recorded.at(-1), 'completed')
})

test('invoice-documents: a sweep that stores one document and then stops early answers 500 and is recorded failed; a finished one answers 200', async () => {
  const { GET } = await import('@/app/api/cron/invoice-documents/route')
  const base = { considered: 3, stored: 1, waiting: 0, needsAttention: 0, failed: 0, stoppedEarly: null as string | null }
  doubles.invoiceDocs = { ...base }
  assert.equal((await GET(request())).status, 200)
  assert.equal(recorded.at(-1), 'completed')
  doubles.invoiceDocs = { ...base, failed: 1, stoppedEarly: 'the ledger refused or is rate-limited: 429' }
  assert.equal((await GET(request())).status, 500)
  assert.equal(recorded.at(-1), 'failed', 'the recorded status agrees with the response')
  doubles.invoiceDocs = { ...base, stoppedEarly: 'unexpected error: boom' }
  assert.equal((await GET(request())).status, 500)
})
