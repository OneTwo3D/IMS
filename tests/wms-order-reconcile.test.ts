import assert from 'node:assert/strict'
import test from 'node:test'
import type { WmsOrderStatus } from '../lib/connectors/wms/types.ts'
import * as reconcileNs from '../lib/domain/wms/order-reconcile-sweep.ts'

const reconcile = 'default' in reconcileNs
  ? reconcileNs.default as typeof import('../lib/domain/wms/order-reconcile-sweep.ts')
  : reconcileNs

function status(partial: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1',
    externalOrderNumber: 'WC-1',
    status: 'PROCESSING',
    statusLabel: 'Processing',
    isSplit: false,
    partCount: null,
    isMerged: false,
    mergedOrderNumbers: [],
    dispatched: false,
    tracking: [],
    deepLinkUrl: null,
    ...partial,
  }
}

// Default no-op deps; each test overrides what it exercises.
function deps(overrides: Partial<reconcileNs.WmsOrderReconcileDeps>): reconcileNs.WmsOrderReconcileDeps {
  return {
    listUnpushedIntentOrders: async () => [],
    listSyncedLinksToVerify: async () => [],
    listCancelledLinksToVerify: async () => [],
    fetchOrderStatus: async () => null,
    partsSupported: true,
    fetchOrderParts: async () => [],
    probeOrderPresence: async () => 'FOUND' as const,
    ...overrides,
  }
}

test('isLikelyCancelledWmsStatus: cancel-ish statuses in either field count', () => {
  assert.equal(reconcile.isLikelyCancelledWmsStatus({ status: 'Cancelled', statusLabel: '' }), true)
  assert.equal(reconcile.isLikelyCancelledWmsStatus({ status: 'CANCEL REQUESTED', statusLabel: '' }), true)
  assert.equal(reconcile.isLikelyCancelledWmsStatus({ status: '', statusLabel: 'Cancelled by user' }), true)
  assert.equal(reconcile.isLikelyCancelledWmsStatus({ status: 'PROCESSING', statusLabel: 'Processing' }), false)
})

test('reconcile core: eligible-but-unpushed orders become NOT_PUSHED findings', async () => {
  const { findings, counters } = await reconcile.runWmsOrderReconcileCore(deps({
    listUnpushedIntentOrders: async () => [{ orderId: 'o1', orderNumber: 'SO-1' }],
  }))
  assert.equal(counters.findings, 1)
  assert.equal(findings[0].category, 'NOT_PUSHED')
  assert.equal(findings[0].orderId, 'o1')
})

test('reconcile core: a verifiably missing WMS order is MISSING_IN_WMS; found and AMBIGUOUS are not', async () => {
  const { findings, counters, verifiedOrderIds } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
      { orderId: 'o3', orderNumber: 'SO-3', externalOrderNumber: 'WC-3' },
    ],
    probeOrderPresence: async (orderNumber) => (
      orderNumber === 'WC-1' ? 'MISSING' : orderNumber === 'WC-3' ? 'AMBIGUOUS' : 'FOUND'
    ),
  }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'MISSING_IN_WMS')
  assert.equal(findings[0].externalOrderNumber, 'WC-1')
  // AMBIGUOUS fails closed: an error, neither a finding nor a clean verification
  // (a re-push of an ambiguous-but-live order would DUPLICATE it in the WMS).
  assert.equal(counters.errors, 1)
  assert.equal(verifiedOrderIds.includes('o3'), false)
})

test('reconcile core: check B is skipped entirely without a tri-state probe', async () => {
  let listed = false
  const { counters } = await reconcile.runWmsOrderReconcileCore(deps({
    probeOrderPresence: null,
    listSyncedLinksToVerify: async () => { listed = true; return [] },
  }))
  assert.equal(listed, false)
  assert.equal(counters.linksVerified, 0)
})

test('reconcile core: a cancelled link still active in the WMS is ACTIVE_AFTER_CANCEL', async () => {
  const { findings, counters, verifiedOrderIds } = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },   // still active → finding
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },   // cancelled in WMS → clean
      { orderId: 'o3', orderNumber: 'SO-3', externalOrderNumber: 'WC-3' },   // verifiably gone from WMS → clean
      { orderId: 'o4', orderNumber: 'SO-4', externalOrderNumber: 'WC-4' },   // dispatched → goods gone, not a cancel question
      { orderId: 'o5', orderNumber: 'SO-5', externalOrderNumber: 'WC-5' },   // null status + AMBIGUOUS probe → fail closed
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1') return status({ status: 'PROCESSING', statusLabel: 'Processing' })
      if (orderNumber === 'WC-2') return status({ status: 'Cancelled', statusLabel: 'Cancelled' })
      if (orderNumber === 'WC-4') return status({ status: 'DESPATCHED', statusLabel: 'Despatched', dispatched: true })
      return null
    },
    probeOrderPresence: async (orderNumber) => (orderNumber === 'WC-3' ? 'MISSING' : 'AMBIGUOUS'),
  }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'ACTIVE_AFTER_CANCEL')
  assert.match(findings[0].detail, /Processing/)
  // WC-5's ambiguous null is an error — it must NOT count as verified-clean
  // (that would resolve a live ACTIVE_AFTER_CANCEL finding).
  assert.equal(counters.errors, 1)
  assert.equal(verifiedOrderIds.includes('o5'), false)
  assert.equal(verifiedOrderIds.includes('o3'), true)
})

test('reconcile core: lookup failures count as errors and never abort the run', async () => {
  const { findings, counters } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
    ],
    probeOrderPresence: async (orderNumber) => {
      if (orderNumber === 'WC-1') throw new Error('WMS API down')
      return 'MISSING'
    },
  }))
  assert.equal(counters.errors, 1)
  // WC-2 still verified and flagged despite WC-1 failing.
  assert.equal(findings.length, 1)
  assert.equal(findings[0].externalOrderNumber, 'WC-2')
})

test('reconcile core: C leads the budget but is floored at half so neither check starves', async () => {
  let syncedLimitSeen = -1
  const { counters } = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async (limit) => {
      // C's fetch is capped at half the run budget (Codex r11: full-priority C
      // let 200+ cancellations zero out check B).
      assert.equal(limit, 5)
      return Array.from({ length: 3 }, (_, index) => ({
        orderId: `c${index}`, orderNumber: `SO-C${index}`, externalOrderNumber: `WCC-${index}`,
      }))
    },
    listSyncedLinksToVerify: async (limit) => {
      syncedLimitSeen = limit
      return []
    },
    fetchOrderStatus: async () => status({ status: 'Cancelled', statusLabel: 'Cancelled' }),
  }), { lookupLimit: 10 })
  assert.equal(syncedLimitSeen, 7)
  assert.equal(counters.cancelledVerified, 3)
})

test('reconcile core: returns the ids it actually verified for rotation stamping', async () => {
  const { verifiedOrderIds } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
    ],
    probeOrderPresence: async (orderNumber) => {
      if (orderNumber === 'WC-1') throw new Error('down')
      return 'FOUND'
    },
  }))
  // The errored lookup is never VERIFIED (no finding resolution)…
  assert.deepEqual(verifiedOrderIds, ['o2'])
})

test('reconcile core: errored lookups still count as ATTEMPTED so they rotate to the back', async () => {
  const { attemptedSyncedOrderIds, verifiedSyncedOrderIds } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
    ],
    probeOrderPresence: async (orderNumber) => {
      if (orderNumber === 'WC-1') throw new Error('down')
      return 'FOUND'
    },
  }))
  // …but IS attempted (stamped), or persistent failures would pin the
  // nulls-first rotation and starve the rest of the corpus (Codex r19).
  assert.deepEqual(attemptedSyncedOrderIds, ['o1', 'o2'])
  assert.deepEqual(verifiedSyncedOrderIds, ['o2'])
})

test('reconcile core: fallback probes are charged against the WMS call budget', async () => {
  let syncedLimitSeen = -1
  await reconcile.runWmsOrderReconcileCore(deps({
    // 3 cancelled links, each null status + probe = 2 calls each = 6 calls.
    listCancelledLinksToVerify: async () => Array.from({ length: 3 }, (_, index) => ({
      orderId: `c${index}`, orderNumber: `SO-C${index}`, externalOrderNumber: `WCC-${index}`,
    })),
    fetchOrderStatus: async () => null,
    probeOrderPresence: async () => 'MISSING',
    listSyncedLinksToVerify: async (limit) => {
      syncedLimitSeen = limit
      return []
    },
  }), { lookupLimit: 10 })
  // B's budget reflects the 6 CALLS spent, not the 3 links listed.
  assert.equal(syncedLimitSeen, 4)
})

test('reconcile core: a split cancelled order is judged by ALL its parts, not the collapsed Part 1', async () => {
  const splitStatus = status({ isSplit: true, partCount: 2, status: 'Cancelled', statusLabel: 'Cancelled' })
  const partOf = (partNumber: number, partStatus: string, dispatched = false) => ({
    externalId: `M-${partNumber}`, partNumber, status: partStatus, dispatched, tracking: [],
  })

  // Part 1 cancelled but part 2 active → finding.
  const activeCase = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async () => [{ orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' }],
    fetchOrderStatus: async () => splitStatus,
    fetchOrderParts: async () => [partOf(1, 'Cancelled'), partOf(2, 'PROCESSING')],
  }))
  assert.equal(activeCase.findings.length, 1)
  assert.match(activeCase.findings[0].detail, /part 2: PROCESSING/)

  // Every part cancelled or dispatched → verified clean.
  const cleanCase = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async () => [{ orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' }],
    fetchOrderStatus: async () => splitStatus,
    fetchOrderParts: async () => [partOf(1, 'Cancelled'), partOf(2, 'DESPATCHED', true)],
  }))
  assert.equal(cleanCase.findings.length, 0)
  assert.equal(cleanCase.verifiedOrderIds.includes('o1'), true)

  // Split but parts not inspectable → fail closed (error, not verified).
  const opaqueCase = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async () => [{ orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' }],
    fetchOrderStatus: async () => splitStatus,
    fetchOrderParts: async () => [],
  }))
  assert.equal(opaqueCase.findings.length, 0)
  assert.equal(opaqueCase.counters.errors, 1)
  assert.equal(opaqueCase.verifiedOrderIds.includes('o1'), false)
})

test('reconcile core: a split order on a parts-less connector is judged by its whole-order status', async () => {
  // A connector without part support computes its top-level status for the
  // WHOLE order (no Part-1 collapse), so it remains authoritative.
  const { findings } = await reconcile.runWmsOrderReconcileCore(deps({
    partsSupported: false,
    listCancelledLinksToVerify: async () => [{ orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' }],
    fetchOrderStatus: async () => status({ isSplit: true, partCount: 2, status: 'PROCESSING', statusLabel: 'Processing' }),
  }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'ACTIVE_AFTER_CANCEL')
})
