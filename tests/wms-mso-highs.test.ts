import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushAmbiguousCreateLink,
  type WmsPushCandidate,
  type WmsPushLinkRef,
} from '../lib/domain/wms/order-push-sweep.ts'
import { runWmsDispatchSweepCore, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderPart, WmsOrderStatus } from '../lib/connectors/wms/types.ts'
import type { WmsMergedSurvivorLookup, WmsAmbiguousCreateResolution, WmsOrderCancelResult, WmsOrderPushInput, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
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
  /** The link as it is NOW, for the conditional notice write: a link that moved on since it was read matches nothing. */
  linkNow?: { state: string; externalOrderId: string; holdNoticeAt?: Date; cancelNoticeAt?: Date }
  /** Notices whose warehouse note was never delivered, as the real port would list them. */
  /** The recorded warehouse line ids of the link's order (default: the order's one line). */
  storedItems?: Array<{ externalItemId: string; sku: string; quantity: number }>
  pendingNotices?: Array<{ id: string; orderId: string; externalOrderId: string; state: 'SYNCED' | 'MERGED'; intent: 'HOLD' | 'CANCEL'; noticeAt: Date }>
}

function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const updates: Array<{ id: string; data: Record<string, unknown>; ifState?: string }> = []
  const events: WmsMutationEventInput[] = []
  let upsertCalls = 0
  const cleared = { count: 0 }
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
    clearStaleNotices: async () => { cleared.count += 1; return 0 },
    noticesAwaitingComment: async () => seed.pendingNotices ?? [],
    readOrderItems: async () => seed.storedItems === undefined ? ORIGINAL_LINES : seed.storedItems,
    ...(seed.linkNow
      ? {
        updateLinkIfLinked: async (id: string, expect: { state: string; externalOrderId: string; holdNoticeAt?: Date; cancelNoticeAt?: Date }, data: Record<string, unknown>) => {
          if (seed.linkNow!.state !== expect.state || seed.linkNow!.externalOrderId !== expect.externalOrderId) return false
          if (expect.holdNoticeAt && seed.linkNow!.holdNoticeAt?.getTime() !== expect.holdNoticeAt.getTime()) return false
          if (expect.cancelNoticeAt && seed.linkNow!.cancelNoticeAt?.getTime() !== expect.cancelNoticeAt.getTime()) return false
          updates.push({ id, data })
          // The write lands, so the link now IS what it was written as.
          if (typeof data.state === 'string') seed.linkNow!.state = data.state
          if (typeof data.externalOrderId === 'string') seed.linkNow!.externalOrderId = data.externalOrderId
          return true
        },
      }
      : {}),
    recordEvent: async (event) => { events.push(event) },
  }
  return { port, upserts, updates, events, cleared }
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
  findMergedSurvivor?: (orderNumber: string) => Promise<WmsMergedSurvivorLookup>
  /** The candidate survivor's lines (default: it holds the order's recorded line, i.e. a genuine merge). */
  itemRefs?: () => Promise<Array<{ externalItemId: string; sku: string; quantity: number }>>
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
      ...(overrides.findMergedSurvivor ? { findMergedSurvivor: overrides.findMergedSurvivor } : {}),
      fetchOrderItemRefs: overrides.itemRefs ?? (async () => [...ORIGINAL_LINES, { externalItemId: '900', sku: 'OTHER', quantity: 2 }]),
      ...(overrides.reconcile
        ? { reconcileAmbiguousCreate: async (reference: { orderNumber: string; externalReference: string }) => { calls.reconcile.push(reference); return overrides.reconcile!(reference) } }
        : {}),
    },
  }
}

/** The order's recorded line, and what a genuine survivor then holds. */
const ORIGINAL_LINES = [{ externalItemId: '501', sku: 'A', quantity: 1 }]

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
  assert.equal(updates.length, 2, 'the notice, then the delivery stamp of its note')
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
  assert.match(String(updates[0].data.lastError), /was not found/, 'and it says WHY: a 404, not a past-NEW order')
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
  assert.equal(updates.length, 2, 'the notice, then the delivery stamp of its note')
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

// ---------------------------------------------------------------- review round: cancelled split, inbox predicate, stale notice ----

const dstatus = (partial: Partial<WmsOrderStatus>): WmsOrderStatus => ({
  externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
  mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-08-19T10:00:00Z' }], dispatched: true, raw: null,
  ...partial,
})
const dpart = (partial: Partial<WmsOrderPart>): WmsOrderPart => ({ externalId: 'M-1', partNumber: 1, status: 'DESPATCHED', dispatched: true, tracking: [], ...partial })
function dispatchDeps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, 1])),
    ...overrides,
  }
}

test('R1: a despatched SPLIT order IMS has cancelled makes NO partial-shipment (storefront) call and no apply: it is a dispatch error', async () => {
  const partials: string[] = []
  const applied: string[] = []
  const errors: string[] = []
  const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [dpart({ externalId: 'a', partNumber: 1 }), dpart({ externalId: 'b', partNumber: 2, dispatched: false })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    cancelIntendedForOrder: async () => true,
    recordDispatchError: async (_c, reason) => { errors.push(reason); return { deadLettered: false } },
  }))
  assert.deepEqual(partials, [], 'no WooCommerce write for a cancelled order')
  assert.deepEqual(applied, [])
  assert.equal(counters.errors, 1)
  assert.match(errors[0], /after IMS cancelled or fully refunded it/)
})

test('R1: a cancelled order that is not despatched stays pending (no error, no write)', async () => {
  const partials: string[] = []
  const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2, dispatched: false, status: 'PICKED' }),
    fetchOrderParts: async () => [dpart({ dispatched: false }), dpart({ externalId: 'b', partNumber: 2, dispatched: false })],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    cancelIntendedForOrder: async () => true,
  }))
  assert.deepEqual(partials, [])
  assert.equal(counters.errors, 0)
  assert.equal(counters.pending, 1)
})

test('R1 control: the same split order for a live (not cancelled) IMS order still pushes its parts', async () => {
  const partials: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [dpart({ externalId: 'a', partNumber: 1 }), dpart({ externalId: 'b', partNumber: 2 })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    cancelIntendedForOrder: async () => false,
  }))
  assert.ok(partials.length >= 1)
})

test('R3: a notice is written only while the link is still the state and warehouse order that was read', async () => {
  const stale = makePort({
    cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1' }],
    linkNow: { state: 'MERGED', externalOrderId: 'survivor-9' },
  })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments: [] })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', stale.port, { now: NOW }))
  assert.equal(r.operatorNotices, undefined, 'the link was re-pointed between the read and the write: nothing is recorded')
  assert.deepEqual(stale.updates, [])
  const live = makePort({
    cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1' }],
    linkNow: { state: 'SYNCED', externalOrderId: 'old-1' },
  })
  const r2 = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', live.port, { now: NOW }))
  assert.equal(r2.operatorNotices, 1)
})

test('R3: NOT_FOUND, then the dispatch sweep re-points the link to the survivor: the old notice is cleared so the survivor is judged afresh', async () => {
  // The re-point is the real dispatch dependency; this pins that it writes both notice columns to null.
  const source = (await import('node:fs')).readFileSync(new URL('../lib/domain/wms/dispatch-sweep.ts', import.meta.url), 'utf8')
  const repoint = source.slice(source.indexOf('async repointLink('), source.indexOf('async screenWithdrawnOrders'))
  assert.match(repoint, /holdNoticeAt: null/)
  assert.match(repoint, /cancelNoticeAt: null/)
})

test('R4: the warehouse note and the notice texts carry no status or error text from the warehouse', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'ZZ-SENTINEL-STATUS' }), comments })
  await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(comments.length, 1)
  assert.equal(comments[0].comment.includes('ZZ-SENTINEL-STATUS'), false)
  assert.equal(updates.length, 2, 'the notice, then the delivery stamp of its note')
})

test('R2: the exception inbox lists a cancel notice by the cancel pass\'s OWN order predicate, not a copy of it', async () => {
  const { readFileSync } = await import('node:fs')
  const inbox = readFileSync(new URL('../lib/domain/wms/push-recovery-affordance.ts', import.meta.url), 'utf8')
  assert.match(inbox, /cancelNoticeAt: \{ not: null \}, order: WMS_CANCELLABLE_ORDER_WHERE/)
  assert.doesNotMatch(inbox, /cancelNoticeAt: \{ not: null \}, order: \{ status: 'CANCELLED'/)
  const sweep = readFileSync(new URL('../lib/domain/wms/order-push-sweep.ts', import.meta.url), 'utf8')
  assert.match(sweep, /order: WMS_CANCELLABLE_ORDER_WHERE,/, 'and the port selects on the same constant')
})

test('R1: a cancelled split order whose PRIMARY row reads not-despatched but whose part HAS shipped is still an error, with no storefront write', async () => {
  const partials: string[] = []
  const errors: string[] = []
  const { counters } = await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2, dispatched: false, status: 'PART_DESPATCHED' }),
    fetchOrderParts: async () => [dpart({ externalId: 'a', partNumber: 1 }), dpart({ externalId: 'b', partNumber: 2, dispatched: false })],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    cancelIntendedForOrder: async () => true,
    recordDispatchError: async (_c, reason) => { errors.push(reason); return { deadLettered: false } },
  }))
  assert.deepEqual(partials, [])
  assert.equal(counters.errors, 1)
  assert.match(errors[0], /after IMS cancelled or fully refunded it/)
})

// ---------------------------------------------------------------- round 2: stale notices, note delivery -----------------------

test('R2-1: stale notices are cleared at the start of every hold pass, so a later re-hold is attempted afresh', async () => {
  const { port, cleared } = makePort({})
  await quiet(() => runWmsOrderPushSweepCore(connector().connector, 'mintsoft', port, { now: NOW }))
  assert.equal(cleared.count, 1)
})

test('R2-2: a warehouse note that FAILED leaves the notice in place and undelivered', async () => {
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) })
  const failing = { ...wms.connector, addOrderComment: async () => { throw new Error('comments endpoint down') } }
  const r = await quiet(() => runWmsOrderPushSweepCore(failing, 'mintsoft', port, { now: NOW }))
  assert.equal(r.operatorNotices, 1, 'the notice stays')
  assert.equal(updates.length, 1, 'and nothing stamps the note as delivered')
  assert.ok(updates[0].data.holdNoticeAt)
  assert.equal(updates[0].data.holdNoticeCommentAt, null)
})

test('R2-2: a delivered note is stamped; a 404 notice (no note) is delivered by definition', async () => {
  const delivered = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  await quiet(() => runWmsOrderPushSweepCore(connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }), comments: [] }).connector, 'mintsoft', delivered.port, { now: NOW }))
  assert.equal(delivered.updates.length, 2)
  assert.ok(delivered.updates[1].data.holdNoticeCommentAt, 'stamped after the note posted')
  const notFound = makePort({ holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }] })
  await quiet(() => runWmsOrderPushSweepCore(connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }) }).connector, 'mintsoft', notFound.port, { now: NOW }))
  assert.ok(notFound.updates[0].data.holdNoticeCommentAt)
})

test('R2-2: an undelivered note is RETRIED on a later sweep with the same text, and stamped once posted', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const pending = [
    { id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3', state: 'SYNCED' as const, intent: 'HOLD' as const, noticeAt: new Date('2026-06-25T00:00:00.000Z') },
    { id: 'link-2', orderId: 'so-4', externalOrderId: 'surv-4', state: 'MERGED' as const, intent: 'CANCEL' as const, noticeAt: new Date('2026-06-25T00:00:00.000Z') },
  ]
  const { port, updates } = makePort({ pendingNotices: pending })
  const r = await quiet(() => runWmsOrderPushSweepCore(connector({ comments }).connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.noticeCommentsRetried, 2)
  assert.deepEqual(comments.map((c) => c.externalOrderId), ['wms-3', 'surv-4'])
  assert.match(comments[0].comment, /ON HOLD/)
  assert.match(comments[1].comment, /merged into this one has been CANCELLED/)
  assert.ok(updates.find((u) => u.id === 'link-1')!.data.holdNoticeCommentAt)
  assert.ok(updates.find((u) => u.id === 'link-2')!.data.cancelNoticeCommentAt)
  // ...and one that fails again is simply left for the next sweep.
  const again = makePort({ pendingNotices: [pending[0]] })
  const failing = { ...connector().connector, addOrderComment: async () => { throw new Error('down') } }
  const r2 = await quiet(() => runWmsOrderPushSweepCore(failing, 'mintsoft', again.port, { now: NOW }))
  assert.equal(r2.noticeCommentsRetried, undefined)
  assert.deepEqual(again.updates, [])
})

test('live: an ALREADY_CANCELLED Mintsoft order satisfies the cancel pass (CANCELLED), but is a hold-pass notice (it keeps its number, so it cannot be re-created)', async () => {
  const cancel = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'c-1' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'ALREADY_CANCELLED' }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', cancel.port, { now: NOW }))
  assert.equal(r.cancelled, 1)
  assert.equal(cancel.updates[0].data.state, 'CANCELLED')
  assert.match(String(cancel.events.find((e) => e.action === 'order_cancel')?.summary), /already cancelled/)
  const hold = makePort({ holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'c-1' }] })
  const r2 = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', hold.port, { now: NOW }))
  assert.equal(r2.held, 0)
  assert.equal(r2.operatorNotices, 1)
  assert.notEqual(hold.updates[0].data.state, 'HELD')
  assert.equal(hold.updates[0].data.cancelledAt, undefined)
})

// ---------------------------------------------------------------- live merge: a 404 that is really a merge -------------------------

test('merge: a hold that 404s but whose number sits inside a merged survivor re-points the link (MERGED) and raises the MERGED notice', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const asked: string[] = []
  const { port, updates } = makePort({
    holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }],
    linkNow: { state: 'SYNCED', externalOrderId: 'old-1' },
  })
  const wms = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments,
    findMergedSurvivor: async (number) => { asked.push(number); return { kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-C+ORD-B' } },
  })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(asked, ['ORD-B'])
  assert.equal(r.held, 0)
  assert.equal(r.operatorNotices, 1)
  assert.equal(updates[0].data.state, 'MERGED')
  assert.equal(updates[0].data.externalOrderId, 'surv-1')
  assert.equal(updates[0].data.externalOrderNumber, 'ORD-C+ORD-B')
  assert.match(String(updates[1].data.lastError), /MERGED order that also holds other orders' goods/)
  assert.ok(updates[1].data.holdNoticeAt)
  assert.deepEqual(comments.map((c) => c.externalOrderId), ['surv-1'], 'the note goes to the SURVIVOR')
  assert.deepEqual(wms.calls.cancel, ['old-1'], 'the survivor itself is never cancelled')
})

test('merge: the same for a cancel; and with no survivor (a deletion) the plain not-found notice is raised and the link is not moved', async () => {
  const merged = makePort({
    cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }],
    linkNow: { state: 'SYNCED', externalOrderId: 'old-1' },
  })
  const m = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments: [],
    findMergedSurvivor: async () => ({ kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-B+ORD-C' }),
  })
  await quiet(() => runWmsOrderPushSweepCore(m.connector, 'mintsoft', merged.port, { now: NOW }))
  assert.equal(merged.updates[0].data.state, 'MERGED')
  assert.ok(merged.updates[1].data.cancelNoticeAt)
  assert.notEqual(merged.updates[1].data.state, 'CANCELLED')

  const gone = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }] })
  const g = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), findMergedSurvivor: async () => ({ kind: 'ABSENT' as const }) })
  await quiet(() => runWmsOrderPushSweepCore(g.connector, 'mintsoft', gone.port, { now: NOW }))
  assert.equal(gone.updates.length, 1)
  assert.equal(gone.updates[0].data.state, undefined)
  assert.match(String(gone.updates[0].data.lastError), /was not found/)
})

test('merge: a link that moved on before the re-point matches nothing - no notice, no note', async () => {
  const { port, updates } = makePort({
    holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }],
    linkNow: { state: 'MERGED', externalOrderId: 'surv-1' },
  })
  const wms = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments: [],
    findMergedSurvivor: async () => ({ kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-C+ORD-B' }),
  })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.operatorNotices, undefined)
  assert.deepEqual(updates, [])
})

// ---------------------------------------------------------------- round 3: delivery stamp is a compare-and-set ----------------------

test('R3-2: a retried note posted for a link that was re-pointed since it was selected stamps NOTHING (the new notice\'s note is still owed)', async () => {
  const NOTICE_AT = new Date('2026-06-25T00:00:00.000Z')
  const { port, updates } = makePort({
    pendingNotices: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'old-1', state: 'SYNCED', intent: 'HOLD', noticeAt: NOTICE_AT }],
    // Re-pointed at a survivor, with a NEW notice, between the selection and the stamp.
    linkNow: { state: 'MERGED', externalOrderId: 'surv-1', holdNoticeAt: new Date('2026-06-26T00:00:00.000Z') },
  })
  const r = await quiet(() => runWmsOrderPushSweepCore(connector({ comments: [] }).connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(updates, [])
  assert.equal(r.noticeCommentsRetried, 1, 'the (old) note was posted; only its stamp is refused')
})

test('R3-2: the stamp also requires the SAME notice timestamp (a re-raised notice on the same order is a different notice)', async () => {
  const { port, updates } = makePort({
    pendingNotices: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3', state: 'SYNCED', intent: 'HOLD', noticeAt: new Date('2026-06-25T00:00:00.000Z') }],
    linkNow: { state: 'SYNCED', externalOrderId: 'wms-3', holdNoticeAt: new Date('2026-06-26T12:00:00.000Z') },
  })
  await quiet(() => runWmsOrderPushSweepCore(connector({ comments: [] }).connector, 'mintsoft', port, { now: NOW }))
  assert.deepEqual(updates, [])
  const same = makePort({
    pendingNotices: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3', state: 'SYNCED', intent: 'HOLD', noticeAt: new Date('2026-06-25T00:00:00.000Z') }],
    linkNow: { state: 'SYNCED', externalOrderId: 'wms-3', holdNoticeAt: new Date('2026-06-25T00:00:00.000Z') },
  })
  await quiet(() => runWmsOrderPushSweepCore(connector({ comments: [] }).connector, 'mintsoft', same.port, { now: NOW }))
  assert.ok(same.updates[0].data.holdNoticeCommentAt, 'control: the same notice on the same order is stamped')
})

test('R3-2: the INITIAL post is guarded the same way - a link re-pointed while the note was in flight is not stamped by this worker', async () => {
  const seed = {
    holdable: [{ id: 'link-1', orderId: 'so-3', externalOrderId: 'wms-3' }],
    linkNow: { state: 'SYNCED', externalOrderId: 'wms-3' } as { state: string; externalOrderId: string; holdNoticeAt?: Date },
  }
  const { port, updates } = makePort(seed)
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) })
  const racing = {
    ...wms.connector,
    // While the note posts, the dispatch sweep re-points the link at a merged survivor.
    addOrderComment: async () => { seed.linkNow.state = 'MERGED'; seed.linkNow.externalOrderId = 'surv-1' },
  }
  await quiet(() => runWmsOrderPushSweepCore(racing, 'mintsoft', port, { now: NOW }))
  assert.equal(updates.length, 1, 'the notice itself; no delivery stamp')
  assert.ok(updates[0].data.holdNoticeAt)
})

test('R3-1: the dispatch guard is the CANCEL intent, not the CANCELLED status - a fully refunded active order despatched after a refused cancel is an error with no storefront write', async () => {
  const partials: string[] = []
  const applied: string[] = []
  const errors: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [dpart({ externalId: 'a', partNumber: 1 }), dpart({ externalId: 'b', partNumber: 2 })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    applyDispatch: async (orderId) => { applied.push(orderId); return { success: true } },
    cancelIntendedForOrder: async () => true,
    recordDispatchError: async (_c, reason) => { errors.push(reason); return { deadLettered: false } },
  }))
  assert.deepEqual([partials, applied], [[], []])
  assert.match(errors[0], /after IMS cancelled or fully refunded it/)
})

test('R4: the cancel intent is re-read before EACH split-part storefront write - a cancel that lands after the first part stops the rest', async () => {
  const partials: string[] = []
  let reads = 0
  const errors: string[] = []
  await runWmsDispatchSweepCore(dispatchDeps({
    fetchOrderStatus: async () => dstatus({ isSplit: true, partCount: 2 }),
    fetchOrderParts: async () => [dpart({ externalId: 'a', partNumber: 1 }), dpart({ externalId: 'b', partNumber: 2 })],
    fetchPartItems: async () => [{ sku: 'A', qty: 1 }],
    pushPartialShipment: async (orderId) => { partials.push(orderId); return { ok: true } },
    // Live at the top-of-order check and before part 1; the cancel commits before part 2.
    cancelIntendedForOrder: async () => { reads += 1; return reads >= 3 },
    recordDispatchError: async (_c, reason) => { errors.push(reason); return { deadLettered: false } },
  }))
  assert.equal(partials.length, 1, 'only the part pushed before the cancel')
  assert.match(errors[0], /after IMS cancelled or fully refunded it/)
})

test('R6: a merge lookup that FAILS leaves the link retryable (no final not-found stamp); a later lookup that finds the survivor re-points it', async () => {
  let lookups = 0
  const seed = {
    holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }],
    linkNow: { state: 'SYNCED', externalOrderId: 'old-1' },
  }
  const { port, updates } = makePort(seed)
  const wms = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments: [],
    findMergedSurvivor: async () => { lookups += 1; if (lookups === 1) throw new Error('search unavailable'); return { kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-C+ORD-B' } },
  })
  const first = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(first.operatorNotices, undefined, 'no notice yet')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.holdNoticeAt, undefined, 'NOT stamped: the link stays in the hold pass')
  assert.match(String(updates[0].data.lastError), /will be retried on the next sweep/)
  const second = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(second.operatorNotices, 1)
  assert.equal(updates.find((u) => u.data.state === 'MERGED')?.data.externalOrderId, 'surv-1')
  assert.equal(lookups, 2)
})

test('R6: only a lookup that SUCCEEDS and finds nothing raises the final not-found notice', async () => {
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B' }] })
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), findMergedSurvivor: async () => ({ kind: 'ABSENT' as const }) })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(r.operatorNotices, 1)
  assert.ok(updates[0].data.cancelNoticeAt)
})

test('R7: an INCONCLUSIVE merge lookup (full page, several candidates) never stamps the final not-found notice', async () => {
  for (const reason of ['the search returned a full page of results, which may be incomplete', '2 merged orders contain this number']) {
    const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B', attempts: 0 }] })
    const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), findMergedSurvivor: async () => ({ kind: 'INCONCLUSIVE' as const, reason }) })
    const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
    assert.equal(r.operatorNotices, undefined)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].data.holdNoticeAt, undefined, 'stays in the hold pass')
    assert.equal(updates[0].data.attempts, 1, 'the retry is counted on the link')
    assert.match(String(updates[0].data.lastError), /inconclusive \(1 of 5\)/)
  }
})

test('R7: after the retry budget an inconclusive merge check raises the operator notice, so it is not retried in silence for ever', async () => {
  const wms = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), comments: [], findMergedSurvivor: async () => ({ kind: 'INCONCLUSIVE' as const, reason: 'the search returned a full page of results, which may be incomplete' }) })
  for (const attempts of [0, 1, 2, 3]) {
    const { port } = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B', attempts }] })
    const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
    assert.equal(r.operatorNotices, undefined, `try ${attempts + 1}: still retrying`)
  }
  const last = makePort({ cancellable: [{ id: 'link-1', orderId: 'so-2', externalOrderId: 'old-1', externalOrderNumber: 'ORD-B', attempts: 4 }] })
  const r = await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', last.port, { now: NOW }))
  assert.equal(r.operatorNotices, 1)
  const notice = last.updates.find((u) => u.data.cancelNoticeAt)!
  assert.match(String(notice.data.lastError), /merge stayed inconclusive after 5 sweeps/)
  assert.ok(last.updates.some((u) => u.data.attempts === 0), 'the counter is reset')
  assert.notEqual(last.updates.find((u) => u.data.state)?.data.state, 'CANCELLED')
})

test('R12: the merged-order guidance reaches the parked link verbatim, and the generic cancel-it text is not used', async () => {
  const reason = "Mintsoft merged this order with another into order WC-1001+WC-1002 (id 777), which also holds the other order's goods, so IMS did not link it. Do not cancel that order on this order's behalf"
  const { port, updates } = makePort({ ambiguous: [ambiguousLink()] })
  const wms = connector({ reconcile: async () => ({ kind: 'UNRESOLVED', reason }), probe: async () => 'FOUND' })
  await quiet(() => runWmsOrderPushSweepCore(wms.connector, 'mintsoft', port, { now: NOW }))
  assert.equal(updates.length, 1)
  assert.match(String(updates[0].data.lastError), /merged this order with another into order WC-1001\+WC-1002 \(id 777\)/)
  assert.doesNotMatch(String(updates[0].data.lastError), /cancel it in the WMS/i)
})

// ---------------------------------------------------------------- R17: a combined number is a candidate filter, never proof ----

test('R17: B 404s, a survivor "A+B+C" (an unrelated merge that merely lists B) is found by the number search, but it does NOT hold B\'s recorded line ids: no re-point, the link is left as it was and a notice is raised', async () => {
  for (const intent of ['cancel', 'hold'] as const) {
    const ref = { id: 'link-1', orderId: 'so-b', externalOrderId: 'b-gone', externalOrderNumber: 'ORD-B', state: 'SYNCED' as const }
    const { port, updates } = makePort({ [intent === 'cancel' ? 'cancellable' : 'holdable']: [ref], linkNow: { state: 'SYNCED', externalOrderId: 'b-gone' } })
    const comments: Array<{ externalOrderId: string; comment: string }> = []
    const g = connector({
      cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }),
      findMergedSurvivor: async () => ({ kind: 'FOUND' as const, externalOrderId: 'surv-abc', externalOrderNumber: 'ORD-A+ORD-B+ORD-C' }),
      itemRefs: async () => [{ externalItemId: '1', sku: 'A', quantity: 1 }, { externalItemId: '2', sku: 'C', quantity: 3 }], // A's and C's lines; B's line 501 is NOT there
      comments,
    })
    const result = await runWmsOrderPushSweepCore(g.connector as never, 'mintsoft', port, { now: NOW })
    assert.equal(updates.some((u) => u.data.state === 'MERGED' || u.data.externalOrderId === 'surv-abc'), false, `${intent}: the link was NOT re-pointed`)
    assert.equal(result.operatorNotices, 1)
    assert.match(String(updates.find((u) => typeof u.data.lastError === 'string')!.data.lastError), /possible merge into WMS order surv-abc could not be proven.*does not hold this order's recorded lines.*check it in the WMS/)
    assert.deepEqual(comments, [], 'no note is posted on the unproven survivor')
  }
})

test('R17: with no trustworthy record of the order\'s line ids (legacy push, or untrusted) a candidate survivor is never adopted either', async () => {
  const ref = { id: 'link-1', orderId: 'so-b', externalOrderId: 'b-gone', externalOrderNumber: 'ORD-B', state: 'SYNCED' as const }
  const { port, updates } = makePort({ cancellable: [ref], linkNow: { state: 'SYNCED', externalOrderId: 'b-gone' }, storedItems: [] })
  const g = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), findMergedSurvivor: async () => ({ kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-C+ORD-B' }) })
  const result = await runWmsOrderPushSweepCore(g.connector as never, 'mintsoft', port, { now: NOW })
  assert.equal(updates.some((u) => u.data.state === 'MERGED'), false)
  assert.equal(result.operatorNotices, 1)
  assert.match(String(updates.find((u) => typeof u.data.lastError === 'string')!.data.lastError), /no trustworthy record of this order's WMS line ids/)
})

test('R17: an unreadable candidate (its lines cannot be read) is not adopted', async () => {
  const ref = { id: 'link-1', orderId: 'so-b', externalOrderId: 'b-gone', externalOrderNumber: 'ORD-B', state: 'SYNCED' as const }
  const { port, updates } = makePort({ cancellable: [ref], linkNow: { state: 'SYNCED', externalOrderId: 'b-gone' } })
  const g = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }), findMergedSurvivor: async () => ({ kind: 'FOUND' as const, externalOrderId: 'surv-1', externalOrderNumber: 'ORD-C+ORD-B' }), itemRefs: async () => { throw new Error('boom') } })
  await runWmsOrderPushSweepCore(g.connector as never, 'mintsoft', port, { now: NOW })
  assert.equal(updates.some((u) => u.data.state === 'MERGED'), false)
})

test('R17: the dispatch sweep does not re-point a link at a survivor that lists its number but does not hold its lines (and applies no despatch from it)', async () => {
  const repoints: string[] = []
  const status = { externalOrderId: 'surv-abc', externalOrderNumber: 'ORD-A+ORD-B+ORD-C', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: true, mergedOrderNumbers: ['ORD-A', 'ORD-B', 'ORD-C'], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }
  const applied: string[] = []
  const run = async (proven: boolean) => runWmsDispatchSweepCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'ORD-B' }],
    fetchOrderStatus: async () => status as never,
    applyDispatch: async () => { applied.push('applied'); return { success: true } },
    repointLink: async (_id: string, to: { externalOrderId: string }) => { repoints.push(to.externalOrderId) },
    proveMergeLineage: async () => (proven ? { proven: true as const } : { proven: false as const, reason: 'the candidate merged order surv-abc does not hold this order\'s recorded lines' }),
  } as never)
  await run(false)
  assert.deepEqual(repoints, [], 'not re-pointed')
  assert.deepEqual(applied, [], 'no despatch applied from the unproven survivor')
  await run(true)
  assert.deepEqual(repoints, ['surv-abc'], 'CONTROL: a proven survivor is adopted')
})

test('R18: the dispatch sweep\'s re-point is a compare-and-set: the proof passes, a cancel marks the link CANCELLED, the re-point is REFUSED, nothing is applied and the link is not flipped back', async () => {
  const status = { externalOrderId: 'surv-1', externalOrderNumber: 'ORD-A+ORD-B', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: true, mergedOrderNumbers: ['ORD-A', 'ORD-B'], deepLinkUrl: null, tracking: [], dispatched: true, raw: null }
  const applied: string[] = []
  const calls: string[] = []
  await runWmsDispatchSweepCore({
    listCandidates: async () => [{ linkId: 'l1', orderId: 'o1', externalOrderNumber: 'ORD-B', externalOrderId: 'b-old' }],
    fetchOrderStatus: async () => status as never,
    applyDispatch: async () => { applied.push('applied'); return { success: true } },
    proveMergeLineage: async () => { calls.push('proof'); return { proven: true as const } },
    // The link was cancelled after the candidate was read: the compare-and-set matches nothing.
    repointLink: async () => { calls.push('repoint'); return false },
  } as never)
  assert.deepEqual(calls, ['proof', 'repoint'])
  assert.deepEqual(applied, [], 'no despatch applied')
})
