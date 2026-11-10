import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushAmbiguousCreateLink,
  type WmsPushCandidate,
  type WmsPushLinkRef,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsAmbiguousCreateResolution, WmsOrderCancelResult, WmsOrderPushInput, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
import type { WmsMutationEventInput } from '../lib/domain/wms/mutation-audit.ts'

/**
 * Three outbound-order defects, one regression block each. EVERYTHING HERE IS A DOUBLE: no Mintsoft request of any kind is made.
 *
 *  H1  a create that landed (timed out / link write lost) is parked AMBIGUOUS_CREATE for good.
 *  H2  hold / cancel never reached a MERGED link, and a 404 was recorded as a successful cancel.
 *  H4  a hold / cancel past NEW dead-lettered the link, so a later despatch was never recorded.
 */

const NOW = () => new Date('2026-06-26T00:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com',
    customerVatNumber: null, shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
    subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
    shipFromWarehouseId: 'wh-1', pushAttempts: 0, lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
    ...overrides,
  }
}

type Seed = {
  ambiguous?: WmsPushAmbiguousCreateLink[]
  createCandidates?: WmsPushCandidate[]
  holdable?: WmsPushLinkRef[]
  cancellable?: WmsPushLinkRef[]
  /** The Nth (1-based) upsertByOrder call throws, as a database fault between the remote create and the writeback would. */
  failUpsertCall?: number
}

function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const updates: Array<{ id: string; data: Record<string, unknown>; ifState?: string }> = []
  const events: WmsMutationEventInput[] = []
  let upsertCalls = 0
  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async () => seed.createCandidates ?? [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: seed.ambiguous ?? [], total: (seed.ambiguous ?? []).length }),
    recordValidationFailure: async () => true,
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => seed.holdable ?? [],
    cancellableLinks: async () => seed.cancellable ?? [],
    upsertByOrder: async (orderId, create, update) => {
      upsertCalls += 1
      if (seed.failUpsertCall === upsertCalls) throw new Error('database unavailable')
      upserts.push({ orderId, create, update })
    },
    updateLink: async (id, data) => { updates.push({ id, data }) },
    updateLinkIfState: async (id, fromState, data) => { updates.push({ id, data, ifState: fromState }); return true },
    recordEvent: async (event) => { events.push(event) },
  }
  return { port, upserts, updates, events }
}

function ambiguousLink(overrides: Partial<WmsPushAmbiguousCreateLink> = {}): WmsPushAmbiguousCreateLink {
  return {
    id: 'link-1', orderId: 'so-1', lastError: 'parked', attempts: 1, pushedAt: null, externalOrderId: null,
    order: { ...candidate(), shipFromWarehouseId: 'wh-1' },
    ...overrides,
  }
}

function connector(overrides: {
  pushOrder?: (input: WmsOrderPushInput) => Promise<WmsOrderPushResult>
  cancelOrder?: (id: string) => Promise<WmsOrderCancelResult>
  reconcile?: (reference: { orderNumber: string; externalReference: string }) => Promise<WmsAmbiguousCreateResolution>
  probe?: () => Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'>
  comments?: Array<{ externalOrderId: string; comment: string }>
} = {}) {
  const calls = { push: 0, cancel: [] as string[], reconcile: [] as Array<{ orderNumber: string; externalReference: string }> }
  return {
    calls,
    connector: {
      pushOrder: async (input: WmsOrderPushInput) => { calls.push += 1; return (overrides.pushOrder ?? (async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' })))(input) },
      updateOrder: async () => ({ updated: true, status: 'NEW' }),
      cancelOrder: async (id: string) => { calls.cancel.push(id); return (overrides.cancelOrder ?? (async () => ({ cancelled: true, status: 'CANCELLED' })))(id) },
      addOrderComment: overrides.comments
        ? async (externalOrderId: string, comment: string) => { overrides.comments!.push({ externalOrderId, comment }) }
        : undefined,
      verifyPushedOrder: async () => 'ours' as const,
      probeOrderPresence: overrides.probe ?? (async () => 'FOUND' as const),
      ...(overrides.reconcile
        ? { reconcileAmbiguousCreate: async (reference: { orderNumber: string; externalReference: string }) => { calls.reconcile.push(reference); return overrides.reconcile!(reference) } }
        : {}),
    },
  }
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try { return await run() } finally { console.warn = warn; console.error = error }
}

// ---------------------------------------------------------------- H1 -------------------------------------------------------------

test('H1: a parked create the warehouse already holds under THIS order\'s reference is bound (PENDING_VERIFY), not left parked and not re-created', async () => {
  const { port, updates, events } = makePort({ ambiguous: [ambiguousLink()] })
  const wms = connector({ reconcile: async () => ({ kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'SO-1' }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.ambiguousCreateAdopted, 1)
  assert.equal(r.created, 0)
  assert.equal(wms.calls.push, 0, 'nothing was created')
  assert.deepEqual(wms.calls.reconcile, [{ orderNumber: 'SO-1', externalReference: 'so-1' }], 'asked by the order\'s own number and its own reference')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].ifState, 'AMBIGUOUS_CREATE', 'compare-and-set on the parked state')
  assert.equal(updates[0].data.state, 'PENDING_VERIFY', 'bound as an UNVERIFIED id: the verify pass proves it before anything acts on it')
  assert.equal(updates[0].data.externalOrderId, '555')
  assert.equal(updates[0].data.attempts, 0)
  assert.ok(updates[0].data.pushedAt)
  assert.equal(events.filter((e) => e.action === 'order_create' && e.outcome === 'SUCCEEDED').length, 1)
})

test('H1: a match that is NOT provably this order stays parked with the reason, and nothing is bound or created', async () => {
  const { port, updates, events } = makePort({ ambiguous: [ambiguousLink()] })
  const wms = connector({ reconcile: async () => ({ kind: 'UNRESOLVED', reason: 'Mintsoft holds 2 orders that match (SO-1, SO-1)' }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.ambiguousCreateAdopted, undefined)
  assert.equal(wms.calls.push, 0)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.state, undefined, 'still AMBIGUOUS_CREATE')
  assert.equal(updates[0].data.externalOrderId, undefined)
  assert.match(String(updates[0].data.lastError), /not provably this order: Mintsoft holds 2 orders/)
  assert.equal(events.filter((e) => e.outcome === 'FAILED').length, 1, 'audited once, so the operator is not told every sweep')
})

test('H1: a reconcile that cannot be asked falls through to the ordinary parked-link handling (no bind)', async () => {
  const { port, updates } = makePort({ ambiguous: [ambiguousLink()] })
  const wms = connector({ reconcile: async () => { throw new Error('WMS unreachable') }, probe: async () => 'FOUND' })
  await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.ok(updates.every((u) => u.data.state === undefined), 'nothing promoted')
  assert.equal(wms.calls.push, 0)
})

test('H1: a link already carrying a warehouse id is never touched by the reconcile', async () => {
  const { port, updates } = makePort({ ambiguous: [ambiguousLink({ externalOrderId: 'ms-9' })] })
  const wms = connector({ reconcile: async () => ({ kind: 'ADOPT', externalOrderId: '555', externalOrderNumber: 'SO-1' }) })
  await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(wms.calls.reconcile, [])
  assert.deepEqual(updates, [])
})

test('H1: a create that LANDED but whose link write failed keeps the id it was just given (PENDING_VERIFY), not PENDING_CREATE with none', async () => {
  const { port, upserts } = makePort({ createCandidates: [candidate()], failUpsertCall: 1 })
  const wms = connector({ pushOrder: async () => ({ externalOrderId: '555', externalOrderNumber: 'WN-555', status: 'NEW', needsVerification: true }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.created, 0)
  assert.equal(upserts.length, 1, 'the failure write landed')
  assert.equal(upserts[0].create.state, 'PENDING_VERIFY')
  assert.equal(upserts[0].create.externalOrderId, '555')
  assert.equal(upserts[0].update.externalOrderId, '555')
})

// ---------------------------------------------------------------- H2 -------------------------------------------------------------

test('H2: a hold for a MERGED link never cancels the surviving order; a person is told and a note is left for the warehouse', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'survivor-9', state: 'MERGED' }] })
  const wms = connector({ comments })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(wms.calls.cancel, [], 'the survivor holds other orders\' goods and is never cancelled for one of them')
  assert.equal(r.held, 0)
  assert.equal(r.operatorNotices, 1)
  assert.equal(updates.length, 1)
  assert.ok(updates[0].data.holdNoticeAt)
  assert.equal(updates[0].data.state, undefined, 'the link is not moved')
  assert.match(String(updates[0].data.lastError), /MERGED order/)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].externalOrderId, 'survivor-9')
})

test('H2: a cancel for a MERGED link never cancels the surviving order and does not record the order cancelled in the WMS', async () => {
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'survivor-9', state: 'MERGED' }] })
  const wms = connector({ comments: [] })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(wms.calls.cancel, [])
  assert.equal(r.cancelled, 0)
  assert.equal(r.operatorNotices, 1)
  assert.ok(updates[0].data.cancelNoticeAt)
  assert.notEqual(updates[0].data.state, 'CANCELLED')
})

test('H2: a 404 on cancel is NOT a successful cancel: the link is not CANCELLED, the order is surfaced', async () => {
  const { port, updates, events } = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'gone-1' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.cancelled, 0)
  assert.equal(r.operatorNotices, 1)
  assert.equal(updates.length, 1)
  assert.notEqual(updates[0].data.state, 'CANCELLED')
  assert.ok(updates[0].data.cancelNoticeAt)
  assert.match(String(updates[0].data.lastError), /was not found[\s\S]*merged[\s\S]*NOT recorded it as cancelled/)
  assert.equal(events.find((e) => e.action === 'order_cancel')?.outcome, 'FAILED')
})

test('H2: a 404 on hold is NOT recorded as held (a held order is later re-created, and the goods picked twice)', async () => {
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'gone-1' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.held, 0)
  assert.equal(r.operatorNotices, 1)
  assert.notEqual(updates[0].data.state, 'HELD')
  assert.equal(updates[0].data.cancelledAt, undefined, 'no cancellation stamp: nobody confirmed one')
  assert.ok(updates[0].data.holdNoticeAt)
})

// ---------------------------------------------------------------- H4 -------------------------------------------------------------

test('H4: a hold past NEW keeps the link LIVE (not DEAD_LETTER), records the notice and posts one warehouse note', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }), comments })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.deadLettered, 0)
  assert.equal(r.operatorNotices, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.state, undefined, 'the link stays SYNCED, so dispatch polling carries on and the despatch is recorded')
  assert.ok(updates[0].data.holdNoticeAt)
  assert.match(String(updates[0].data.lastError), /past NEW .*NOT_CANCELLABLE/)
  assert.equal(comments.length, 1)
  assert.match(comments[0].comment, /ON HOLD/)
})

test('H4: a cancel past NEW keeps the link LIVE (not DEAD_LETTER) and records the cancel notice', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }), comments })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.deadLettered, 0)
  assert.equal(r.cancelled, 0)
  assert.equal(updates[0].data.state, undefined)
  assert.ok(updates[0].data.cancelNoticeAt)
  assert.equal(comments.length, 1)
  assert.match(comments[0].comment, /cancelled \/ fully refunded/i)
})

test('H1/H2/H4: the happy paths are unchanged (a NEW order is still cancelled and held)', async () => {
  const held = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const a = await runWmsOrderPushSweepCore(connector().connector, 'mintsoft', held.port, { now: NOW })
  assert.equal(a.held, 1)
  assert.equal(held.updates[0].data.state, 'HELD')
  const cancelled = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const b = await runWmsOrderPushSweepCore(connector().connector, 'mintsoft', cancelled.port, { now: NOW })
  assert.equal(b.cancelled, 1)
  assert.equal(cancelled.updates[0].data.state, 'CANCELLED')
})

// ---------------------------------------------------------------- the inbox row -------------------------------------------------

test('H4/H2: a live link carrying a hold or cancel notice reaches the inbox as what it is, with the instruction instead of a Replay', async () => {
  const { buildBlockedWmsPushRow } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const base = {
    orderId: 'so-1', connector: 'mintsoft', state: 'SYNCED', attempts: 0, externalOrderId: 'wms-1', pushedAt: new Date(),
    lastError: 'past NEW', lastAttemptAt: new Date(), order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  }
  const hold = buildBlockedWmsPushRow({ ...base, holdNoticeAt: new Date() })
  assert.equal(hold.why, 'Hold not honoured by the warehouse')
  assert.equal(hold.replayable, false)
  assert.match(hold.replayRefusal!, /still live, so a despatch is still recorded/)
  const cancel = buildBlockedWmsPushRow({ ...base, state: 'MERGED', cancelNoticeAt: new Date() })
  assert.equal(cancel.why, 'Cancel not honoured by the warehouse')
  assert.match(cancel.replayRefusal!, /never applied to the cancelled order/)
  // A dead letter that carries an id is still the unverified-link row it always was.
  const dead = buildBlockedWmsPushRow({ ...base, state: 'DEAD_LETTER' })
  assert.equal(dead.why, 'Linked, unverified')
})
