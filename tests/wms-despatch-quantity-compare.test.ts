import assert from 'node:assert/strict'
import test from 'node:test'
import { runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import { compareDespatchedQuantities, describeDespatchQuantityMismatch } from '../lib/domain/wms/despatch-quantity-compare.ts'
import type { WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/** o3d-hqvrp.115: what the warehouse despatched is compared with what IMS books; a difference is surfaced, never "fixed". All doubles: no request is made. */

test('compare: equal quantities (any order, split across lines) agree', () => {
  assert.deepEqual(compareDespatchedQuantities([{ sku: 'A', qty: 4 }, { sku: 'B', qty: 1 }], [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 3 }, { sku: 'A', qty: 1 }]), [])
})

test('compare: the audit scenario (4 despatched, IMS booked 3) is a mismatch, in both directions and for a SKU only one side has', () => {
  assert.deepEqual(compareDespatchedQuantities([{ sku: 'SKU-C', qty: 4 }], [{ sku: 'SKU-C', qty: 3 }]), [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }])
  assert.deepEqual(compareDespatchedQuantities([{ sku: 'A', qty: 1 }], [{ sku: 'A', qty: 2 }]), [{ sku: 'A', wmsQty: 1, imsQty: 2 }])
  assert.deepEqual(compareDespatchedQuantities([{ sku: 'X', qty: 1 }], [{ sku: 'Y', qty: 1 }]), [{ sku: 'X', wmsQty: 1, imsQty: 0 }, { sku: 'Y', wmsQty: 0, imsQty: 1 }])
})

test('compare: the description names the SKU, both quantities, and that nothing was changed', () => {
  const text = describeDespatchQuantityMismatch('mintsoft', 'SO-5001', [{ sku: 'SKU-C', wmsQty: 4, imsQty: 3 }])
  assert.match(text, /SKU-C: mintsoft despatched 4, IMS booked 3/)
  assert.match(text, /IMS changed nothing/)
})

function status(): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'WC-1', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, dispatched: true, raw: null,
    tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-06-25T10:00:00Z' }],
  }
}

function deps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1', externalOrderId: 'M-1' }],
    fetchOrderStatus: async () => status(),
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [{ sku: 'SKU-C', qty: 4 }],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    ...overrides,
  }
}

test('an applied non-split despatch hands the WMS quantities for the order to the comparison, after the booking', async () => {
  const order: string[] = []
  const seen: Array<{ orderId: string; items: unknown }> = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    applyDispatch: async () => { order.push('apply'); return { success: true } },
    recordDespatchQuantities: async (candidate, items) => { order.push('compare'); seen.push({ orderId: candidate.orderId, items }) },
  }))
  assert.equal(counters.dispatched, 1, 'precondition: the despatch was applied')
  assert.deepEqual(order, ['apply', 'compare'])
  assert.deepEqual(seen, [{ orderId: 'o1', items: [{ sku: 'SKU-C', qty: 4 }] }])
})

test('a failed despatch is not compared, and a comparison that throws never fails the despatch', async () => {
  const compared: string[] = []
  await runWmsDispatchSweepCore(deps({
    applyDispatch: async () => ({ success: false, error: 'refused' }),
    recordDespatchQuantities: async (candidate) => { compared.push(candidate.orderId) },
  }))
  assert.deepEqual(compared, [])
  const error = console.error
  console.error = () => {}
  try {
    const { counters } = await runWmsDispatchSweepCore(deps({
      recordDespatchQuantities: async () => { throw new Error('database unavailable') },
    }))
    assert.equal(counters.dispatched, 1)
    assert.equal(counters.errors, 0)
  } finally { console.error = error }
})

test('a WMS read failure for the items never fails the despatch', async () => {
  const error = console.error
  console.error = () => {}
  try {
    const { counters } = await runWmsDispatchSweepCore(deps({
      fetchPartItems: async () => { throw new Error('mintsoft 500') },
      recordDespatchQuantities: async () => { throw new Error('must not be reached') },
    }))
    assert.equal(counters.dispatched, 1)
    assert.equal(counters.errors, 0)
  } finally { console.error = error }
})

test('a split order compares the items of every despatched part once, after the completing despatch', async () => {
  const seen: Array<Array<{ sku: string; qty: number }>> = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    fetchOrderStatus: async () => ({ ...status(), isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [
      { externalId: 'P1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T1', carrier: 'DPD', despatchedAt: '2026-06-25T10:00:00Z' }] },
      { externalId: 'P2', partNumber: 2, status: 'DESPATCHED', dispatched: true, tracking: [{ trackingNumber: 'T2', carrier: 'DPD', despatchedAt: '2026-06-25T11:00:00Z' }] },
    ],
    fetchPartItems: async (id) => [{ sku: 'SKU-C', qty: id === 'P1' ? 3 : 1 }],
    recordDespatchQuantities: async (_candidate, items) => { seen.push(items) },
  }))
  assert.equal(counters.dispatched, 1, 'precondition: the split order completed')
  assert.deepEqual(seen, [[{ sku: 'SKU-C', qty: 3 }, { sku: 'SKU-C', qty: 1 }]])
})
