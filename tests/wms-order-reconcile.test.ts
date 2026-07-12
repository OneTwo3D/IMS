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

test('reconcile core: a live link whose WMS order vanished is MISSING_IN_WMS; found orders are clean', async () => {
  const { findings } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
    ],
    fetchOrderStatus: async (orderNumber) => (orderNumber === 'WC-1' ? null : status({ externalOrderNumber: 'WC-2' })),
  }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'MISSING_IN_WMS')
  assert.equal(findings[0].externalOrderNumber, 'WC-1')
})

test('reconcile core: a cancelled link still active in the WMS is ACTIVE_AFTER_CANCEL', async () => {
  const { findings } = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },   // still active → finding
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },   // cancelled in WMS → clean
      { orderId: 'o3', orderNumber: 'SO-3', externalOrderNumber: 'WC-3' },   // gone from WMS → clean
      { orderId: 'o4', orderNumber: 'SO-4', externalOrderNumber: 'WC-4' },   // dispatched → goods gone, not a cancel question
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1') return status({ status: 'PROCESSING', statusLabel: 'Processing' })
      if (orderNumber === 'WC-2') return status({ status: 'Cancelled', statusLabel: 'Cancelled' })
      if (orderNumber === 'WC-4') return status({ status: 'DESPATCHED', statusLabel: 'Despatched', dispatched: true })
      return null
    },
  }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].category, 'ACTIVE_AFTER_CANCEL')
  assert.match(findings[0].detail, /Processing/)
})

test('reconcile core: lookup failures count as errors and never abort the run', async () => {
  const { findings, counters } = await reconcile.runWmsOrderReconcileCore(deps({
    listSyncedLinksToVerify: async () => [
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderNumber: 'WC-1' },
      { orderId: 'o2', orderNumber: 'SO-2', externalOrderNumber: 'WC-2' },
    ],
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1') throw new Error('WMS API down')
      return null
    },
  }))
  assert.equal(counters.errors, 1)
  // WC-2 still verified and flagged despite WC-1 failing.
  assert.equal(findings.length, 1)
  assert.equal(findings[0].externalOrderNumber, 'WC-2')
})

test('reconcile core: C is budgeted first so a live-link backlog cannot starve it', async () => {
  let syncedLimitSeen = -1
  const { counters } = await reconcile.runWmsOrderReconcileCore(deps({
    listCancelledLinksToVerify: async (limit) => {
      assert.equal(limit, 10)
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
    fetchOrderStatus: async (orderNumber) => {
      if (orderNumber === 'WC-1') throw new Error('down')
      return status({})
    },
  }))
  // The errored lookup must NOT be stamped as verified (it would dodge rotation).
  assert.deepEqual(verifiedOrderIds, ['o2'])
})
