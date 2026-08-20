import assert from 'node:assert/strict'
import test from 'node:test'

import { runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderStatus, WmsOrderPart } from '../lib/connectors/wms/types.ts'

/**
 * o3d-rbyg [wdraw]: THE FIFTH FULFILMENT PATH.
 *
 * The withdrawal fence guards the four moments at which an order is PUSHED to the warehouse. None
 * of them looks at an order again once its link is SYNCED — and the dispatch sweep is what carries a
 * SYNCED link the rest of the way: `applyDispatch` marks the IMS shipment SHIPPED, relieves stock
 * and sends the storefront's despatch email. An order withdrawn AFTER it was pushed, with its
 * webhook missed (which is the premise of the whole fence), was therefore fulfilled in full with
 * nothing having asked.
 */

function status(partial: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1',
    externalOrderNumber: 'WC-1001',
    status: 'DESPATCHED',
    statusLabel: 'Despatched',
    isSplit: false,
    partCount: null,
    isMerged: false,
    mergedOrderNumbers: [],
    deepLinkUrl: null,
    tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-08-19T10:00:00Z' }],
    dispatched: true,
    raw: null,
    ...partial,
  }
}

function part(partial: Partial<WmsOrderPart>): WmsOrderPart {
  return { externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [], ...partial }
}

function deps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    ...overrides,
  }
}

test('dispatch: a DESPATCHED WMS order for a WITHDRAWN order is not marked shipped (o3d-rbyg)', async () => {
  const applied: string[] = []
  const parked: Array<{ linkId: string; reason: string }> = []
  const screened: string[][] = []

  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({}),
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async (orderIds) => { screened.push(orderIds); return new Set(['o1']) },
    parkWithdrawn: async (candidate, reason) => { parked.push({ linkId: candidate.linkId, reason }); return { parked: true } },
  }))

  assert.deepEqual(screened, [['o1']], 'the batch was screened once, before anything was reconciled')
  assert.deepEqual(applied, [], 'no shipment, no stock relief, no despatch email')
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.withheld, 1, 'and the refusal is counted rather than being an invisible skip')
  assert.equal(counters.totalChecked, 1)
  assert.deepEqual(parked.map((entry) => entry.linkId), ['l1'], 'the link was parked out of the sweep')
  assert.match(parked[0].reason, /withdrawal request stands against this order/)
  assert.equal(logs[0].action, 'withheld')
})

test('dispatch: the fence is PER ORDER — a clean order in the same batch still ships (o3d-rbyg)', async () => {
  // The fence must not become a batch-wide halt. This is the difference between refusing one
  // withdrawn order and stopping the warehouse.
  const applied: string[] = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (number) => status({ externalOrderNumber: number }),
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async () => new Set(['o1']),
    parkWithdrawn: async () => ({ parked: true }),
  }))

  assert.deepEqual(applied, ['o2'], 'only the withdrawn order was refused')
  assert.equal(counters.dispatched, 1)
  assert.equal(counters.withheld, 1)
})

test('dispatch: a withdrawn SPLIT order pushes no partial shipments either (o3d-rbyg)', async () => {
  // A split order never reaches applyDispatch — it dispatches through pushPartialShipment. A fence
  // placed next to applyDispatch alone would leave every split order unfenced.
  const partials: string[] = []
  const applied: string[] = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [part({ externalId: 'M-1a', partNumber: 1 }), part({ externalId: 'M-1b', partNumber: 2 })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async () => new Set(['o1']),
    parkWithdrawn: async () => ({ parked: true }),
  }))

  assert.deepEqual(partials, [], 'no part of a withdrawn order was pushed to the storefront')
  assert.deepEqual(applied, [])
  assert.equal(counters.withheld, 1)
})

test('dispatch: a park that does not commit holds the delta watermark (o3d-rbyg)', async () => {
  // A park that failed leaves the link a candidate again next tick, so this pass has NOT decided it.
  // Advancing past it would age the change out of the window and the refusal would be forgotten.
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    listActiveByExternalOrderIds: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    listReconcileCandidates: async () => [],
    fetchDelta: async () => [status({})],
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
    saveDeltaState: async (state) => { saved.push(state) },
    screenWithdrawnOrders: async () => new Set(['o1']),
    parkWithdrawn: async () => ({ parked: false }),
  }))

  assert.equal(counters.withheld, 1, 'it was still refused — the park failing does not fulfil it')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].watermark, undefined, 'the watermark did NOT advance past an undecided link')
})

test('dispatch: a park that COMMITS lets the watermark advance (o3d-rbyg)', async () => {
  // The other side of the same rule: a parked link is out of the candidate set for good, so holding
  // the watermark for it would pin the delta on an order that can never be re-read.
  const saved: Array<{ watermark?: string; lastReconcile?: string }> = []
  await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    listActiveByExternalOrderIds: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    listReconcileCandidates: async () => [],
    fetchDelta: async () => [status({})],
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
    saveDeltaState: async (state) => { saved.push(state) },
    screenWithdrawnOrders: async () => new Set(['o1']),
    parkWithdrawn: async () => ({ parked: true }),
  }))

  assert.equal(saved.length, 1)
  assert.ok(saved[0].watermark, 'a decided link does not pin the delta')
})

test('dispatch: a screen that THROWS holds the watermark rather than passing silently (o3d-rbyg)', async () => {
  // The screen is a LOCAL read: its failure means the database is in trouble, not the storefront, so
  // there is no honest "leave them as they were". Refusing every candidate would halt dispatch
  // reconciliation shop-wide on one bad query, so the pass proceeds — but it must not then claim to
  // have covered the window it could not screen.
  const applied: string[] = []
  const saved: Array<{ watermark?: string }> = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    listActiveByExternalOrderIds: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    listReconcileCandidates: async () => [],
    fetchDelta: async () => [status({})],
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
    saveDeltaState: async (state) => { saved.push(state) },
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async () => { throw new Error('connection terminated') },
    parkWithdrawn: async () => ({ parked: true }),
  }))

  assert.deepEqual(applied, ['o1'], 'the pass does not halt — one bad query must not stop the warehouse')
  assert.equal(counters.withheld, 0)
  assert.equal(saved[0]?.watermark, undefined, 'but the watermark is held, so the pass cannot claim it screened')
})

test('dispatch: a connector with no screen behaves exactly as before (o3d-rbyg)', async () => {
  // The dep is optional so a WMS or a test that predates the fence is untouched.
  const applied: string[] = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => status({}),
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
  }))

  assert.deepEqual(applied, ['o1'])
  assert.equal(counters.withheld, 0)
})
