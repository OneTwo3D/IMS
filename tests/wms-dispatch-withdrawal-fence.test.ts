import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDispatchJobOutcome, runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
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

test('dispatch: a screen that THROWS defers the dispatch instead of shipping unscreened (o3d-rbyg r2)', async () => {
  // ROUND 2, Codex finding 2. Round 1 let the pass proceed and merely held the watermark — the same
  // trade the PUSH screen makes. It is not the same trade. This screen is a read of our OWN
  // database, so its failure is the sweep going blind rather than somebody else's outage; and what
  // it guards is irreversible — a shipment marked SHIPPED, FIFO stock consumed, and a despatch
  // email the customer cannot be un-sent. Deferring costs one sweep interval.
  const applied: string[] = []
  const parked: string[] = []
  const errored: string[] = []
  const saved: Array<{ watermark?: string }> = []
  const { counters, logs } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    listActiveByExternalOrderIds: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    listReconcileCandidates: async () => [],
    fetchDelta: async () => [status({})],
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
    saveDeltaState: async (state) => { saved.push(state) },
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async () => { throw new Error('connection terminated') },
    parkWithdrawn: async (candidate) => { parked.push(candidate.linkId); return { parked: true } },
    recordDispatchError: async (candidate) => { errored.push(candidate.linkId); return { deadLettered: false } },
  }))

  assert.deepEqual(applied, [], 'nothing was shipped on evidence the pass could not read')
  assert.equal(counters.deferred, 1, 'the link was DEFERRED, and the pass says so')
  assert.equal(counters.dispatched, 0)
  assert.equal(counters.withheld, 0, 'a deferral is not a refusal — nothing is known against this order')
  assert.deepEqual(parked, [], 'and it is not a park: nothing durable was written')
  assert.deepEqual(errored, [], 'nor an error against the link, which has done nothing wrong')
  assert.equal(logs[0].action, 'deferred')
  assert.match(logs[0].reason, /withdrawal screen could not be read/)
  assert.match(logs[0].reason, /retried on the next sweep/)
  assert.equal(saved[0]?.watermark, undefined, 'the watermark is held, so nothing ages out unscreened')
})

test('dispatch: a deferral is retracted by a later pass that screens the same order cleanly (o3d-rbyg r2)', async () => {
  // The failure is remembered PER ORDER, not for the pass: the delta list and the reconcile list are
  // screened separately, so one bad query against the delta batch must not idle a candidate the
  // reconcile pass screens cleanly moments later, in the same tick.
  const applied: string[] = []
  let screens = 0
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    listActiveByExternalOrderIds: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    listReconcileCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001', externalOrderId: 'M-1' }],
    fetchDelta: async () => [status({})],
    fetchOrderStatus: async () => status({}),
    getDeltaState: async () => ({ watermark: null, lastReconcile: null }),
    saveDeltaState: async () => {},
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async () => {
      screens += 1
      if (screens === 1) throw new Error('statement timeout')
      return new Set<string>()
    },
    parkWithdrawn: async () => ({ parked: true }),
  }))

  assert.equal(screens, 2, 'the reconcile pass screened its own list rather than inheriting the delta failure')
  assert.deepEqual(applied, ['o1'], 'and once screened cleanly, the SAME tick dispatches it')
  assert.equal(counters.dispatched, 1)
  assert.equal(counters.deferred, 1, 'the delta pass did defer it — the recovery is a second screen, not a silent pass-through')
})

test('dispatch: a deferral does not stop the rest of the batch, only the unscreened orders (o3d-rbyg r2)', async () => {
  // Failing closed must not become a shop-wide halt by the back door. Only orders in the list that
  // could not be screened are deferred; a list that screened cleanly dispatches as normal.
  const applied: string[] = []
  const { counters } = await runWmsDispatchSweepCore(deps({
    listCandidates: async () => [
      { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' },
      { linkId: 'l2', orderId: 'o2', externalOrderNumber: 'WC-1002' },
    ],
    fetchOrderStatus: async (number) => status({ externalOrderNumber: number }),
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    screenWithdrawnOrders: async (orderIds) => {
      if (orderIds.includes('o1')) throw new Error('deadlock detected')
      return new Set<string>()
    },
    parkWithdrawn: async () => ({ parked: true }),
  }))

  // Both orders are in ONE candidate list here, so both are deferred — the point being that the
  // deferral is scoped to the list the screen actually failed on, and reports its size.
  assert.deepEqual(applied, [])
  assert.equal(counters.deferred, 2)
  assert.equal(counters.totalChecked, 2, 'the pass still SAW them — a deferral is not an invisible skip')
})

test('dispatch: a failed screen makes the job PARTIAL rather than a clean success (o3d-rbyg r2)', () => {
  // The deferral is safe. A deferral repeated every tick is a warehouse that has quietly stopped
  // reconciling, and it must not be reported as SUCCEEDED with zero errors.
  const clean = resolveDispatchJobOutcome(0, null, { withdrawalScreenFailures: 0 })
  assert.equal(clean.status, 'SUCCEEDED')
  const degraded = resolveDispatchJobOutcome(0, null, { withdrawalScreenFailures: 2 })
  assert.equal(degraded.status, 'PARTIAL')
  assert.equal(degraded.effectiveErrors, 2)
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
