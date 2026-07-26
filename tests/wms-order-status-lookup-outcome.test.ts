import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-x9nc: fetchOrderStatus returns null for BOTH "no such order" and "several candidates match
// this reference" (merged/split). Those are OPPOSITE conclusions for anything acting on the
// snapshot — the delete guard treats an authoritative MISSING as safe to delete on, and must fail
// closed on anything else — but the sweep recorded them identically as not-found.
//
// probeOrderPresence already reports FOUND/MISSING/AMBIGUOUS on both connectors, so the null path
// resolves the distinction and records it. These tests pin which marker each outcome writes,
// because the guard's decision is derived from exactly that string.

type Snapshot = { orderId: string; externalOrderId: string; lastError: string | null }

const upserts: Snapshot[] = []
let presenceResult: 'FOUND' | 'MISSING' | 'AMBIGUOUS' = 'MISSING'
let presenceThrows: Error | null = null
let hasProbe = true
let existingSnapshot: { externalOrderId: string; lastError: string | null } | null = null
/** Counts remote presence probes, so the no-reprobe test measures the thing it claims. */
let probeCalls = 0

mock.module('@/lib/integration-plugins', {
  namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) },
})

mock.module('@/lib/connectors/wms/types', {
  namedExports: { WMS_CONNECTOR_IDS: ['mintsoft'] },
})

mock.module('@/lib/connectors/wms/order-lookup', {
  namedExports: { resolveWmsOrderLookupConnector: async () => 'woocommerce' },
})

mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
    getWmsConnector: () => ({
      // Always null: the branch under test is "no single status could be read".
      fetchOrderStatus: async () => null,
      ...(hasProbe
        ? {
          probeOrderPresence: async () => {
            probeCalls += 1
            if (presenceThrows) throw presenceThrows
            return presenceResult
          },
        }
        : {}),
    }),
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async () => [{
          id: 'order-1',
          orderNumber: 'SO-1',
          externalOrderNumber: 'SO-1',
          shoppingLinks: [{ externalOrderNumber: 'SO-1' }],
        }],
      },
      wmsOrderStatusSnapshot: {
        // The sweep reads any existing verdict before probing, so a stable already-absent order
        // is not re-probed every cycle (o3d-eu0r). Default null = nothing known yet.
        findUnique: async () => existingSnapshot,
        upsert: async ({ create }: { create: Snapshot }) => {
          upserts.push(create)
          return create
        },
      },
    },
  },
})

async function runSweep() {
  upserts.length = 0
  probeCalls = 0
  existingSnapshot = existingSnapshot ?? null
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  await runWmsOrderStatusSweep()
  return upserts[0]
}

test('an authoritative MISSING records the CONFIRMED-ABSENT marker (o3d-x9nc)', async () => {
  const { WMS_LOOKUP_CONFIRMED_ABSENT: WMS_LOOKUP_NOT_FOUND } = await import('@/lib/domain/wms/order-status-sweep')
  hasProbe = true
  presenceThrows = null
  presenceResult = 'MISSING'

  const snapshot = await runSweep()

  assert.equal(snapshot?.lastError, WMS_LOOKUP_NOT_FOUND)
  assert.equal(snapshot?.externalOrderId, '', 'still a placeholder — there is no order to name')
})

test('an AMBIGUOUS lookup records a DISTINCT marker, so the guard fails closed (o3d-x9nc)', async () => {
  const { WMS_LOOKUP_AMBIGUOUS, WMS_LOOKUP_CONFIRMED_ABSENT: WMS_LOOKUP_NOT_FOUND } = await import('@/lib/domain/wms/order-status-sweep')
  hasProbe = true
  presenceThrows = null
  presenceResult = 'AMBIGUOUS'

  const snapshot = await runSweep()

  assert.equal(snapshot?.lastError, WMS_LOOKUP_AMBIGUOUS)
  assert.notEqual(
    snapshot?.lastError,
    WMS_LOOKUP_NOT_FOUND,
    'recording ambiguity as not-found is what let a real warehouse order be deleted',
  )
})

test('a FOUND probe after a null fetch is a contradiction, not an absence (o3d-x9nc)', async () => {
  const { WMS_LOOKUP_PRESENT_NO_STATUS, WMS_LOOKUP_CONFIRMED_ABSENT: WMS_LOOKUP_NOT_FOUND } = await import('@/lib/domain/wms/order-status-sweep')
  hasProbe = true
  presenceThrows = null
  presenceResult = 'FOUND'

  const snapshot = await runSweep()

  assert.equal(snapshot?.lastError, WMS_LOOKUP_PRESENT_NO_STATUS)
  assert.notEqual(snapshot?.lastError, WMS_LOOKUP_NOT_FOUND)
})

test('a FAILING probe does not degrade to confirmed-absent (o3d-x9nc)', async () => {
  const { WMS_LOOKUP_CONFIRMED_ABSENT: WMS_LOOKUP_NOT_FOUND } = await import('@/lib/domain/wms/order-status-sweep')
  hasProbe = true
  presenceThrows = new Error('ETIMEDOUT')

  const snapshot = await runSweep()

  assert.notEqual(snapshot?.lastError, WMS_LOOKUP_NOT_FOUND, 'an unanswered probe proves nothing')
  assert.match(String(snapshot?.lastError), /probe failed/)
  assert.match(String(snapshot?.lastError), /ETIMEDOUT/)
})

test('a connector with NO probe stays on the conservative reading (o3d-x9nc)', async () => {
  const { WMS_LOOKUP_CONFIRMED_ABSENT: WMS_LOOKUP_NOT_FOUND } = await import('@/lib/domain/wms/order-status-sweep')
  hasProbe = false
  presenceThrows = null

  const snapshot = await runSweep()

  assert.notEqual(
    snapshot?.lastError,
    WMS_LOOKUP_NOT_FOUND,
    'without a probe the sweep cannot claim the order is absent',
  )
  assert.match(String(snapshot?.lastError), /cannot probe presence/)
})

test('a LEGACY not-found row is not accepted as confirmed absence (o3d-eu0r)', async () => {
  const { WMS_LOOKUP_NOT_FOUND, WMS_LOOKUP_CONFIRMED_ABSENT } = await import('@/lib/domain/wms/order-status-sweep')

  // Rows written before the presence probe existed recorded EVERY null fetch as the legacy
  // literal, including AMBIGUOUS ones. Accepting that string would keep letting a genuine
  // warehouse order be deleted on a snapshot that never made the distinction. The marker the
  // guard trusts is new, so no legacy row can carry it.
  assert.notEqual(WMS_LOOKUP_CONFIRMED_ABSENT, WMS_LOOKUP_NOT_FOUND)

  hasProbe = true
  presenceThrows = null
  presenceResult = 'MISSING'
  existingSnapshot = { externalOrderId: '', lastError: WMS_LOOKUP_NOT_FOUND }

  const snapshot = await runSweep()
  existingSnapshot = null

  assert.equal(
    snapshot?.lastError,
    WMS_LOOKUP_CONFIRMED_ABSENT,
    'a legacy row IS re-probed and upgraded — it was never trusted in the first place',
  )
})

test('an already CONFIRMED-absent order is not re-probed every sweep (o3d-eu0r)', async () => {
  const { WMS_LOOKUP_CONFIRMED_ABSENT } = await import('@/lib/domain/wms/order-status-sweep')

  // Both connectors re-run the same underlying search inside the probe — Mintsoft repeats
  // Order/Search, ShipHero repeats a credit-consuming GraphQL query — so a batch of missing
  // orders would otherwise double its remote requests every cycle, against a quota.
  hasProbe = true
  presenceThrows = null
  presenceResult = 'MISSING'

  // Control: with nothing known, the sweep DOES probe.
  existingSnapshot = null
  await runSweep()
  assert.equal(probeCalls, 1, 'precondition — an unknown order is probed')

  // Already confirmed absent and still absent: nothing new to learn, so no remote call.
  existingSnapshot = { externalOrderId: '', lastError: WMS_LOOKUP_CONFIRMED_ABSENT }
  const snapshot = await runSweep()
  existingSnapshot = null

  assert.equal(probeCalls, 0, 'no probe was issued for an order already confirmed absent')
  assert.equal(snapshot?.lastError, WMS_LOOKUP_CONFIRMED_ABSENT, 'and the verdict is preserved')
})
