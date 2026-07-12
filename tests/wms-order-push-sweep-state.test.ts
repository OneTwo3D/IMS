import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushCandidate,
  type WmsPushLinkRef,
  type WmsPushUpdateLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderCancelResult, WmsOrderPushResult, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'
import type { WmsMutationEventInput } from '../lib/domain/wms/mutation-audit.ts'

const NOW = () => new Date('2026-06-26T00:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    currency: 'GBP',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    customerVatNumber: null,
    shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' },
    shippingService: 'Royal Mail',
    subtotalForeign: 10,
    shippingForeign: 0,
    taxForeign: 0,
    taxRatePercent: null,
    pricesIncludeVat: false,
    discountAmount: 0,
    totalForeign: 10,
    shipFromWarehouseId: 'wh-1',
    pushAttempts: 0,
    lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
    ...overrides,
  }
}

type Seed = {
  bindings?: Array<{ warehouseId: string; externalWarehouseId: string }>
  releasable?: WmsPushLinkRef[]
  createCandidates?: WmsPushCandidate[]
  updatable?: WmsPushUpdateLink[]
  holdable?: WmsPushLinkRef[]
  cancellable?: WmsPushLinkRef[]
}

function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const events: WmsMutationEventInput[] = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => seed.bindings ?? BINDINGS,
    releasableHeldOrders: async () => seed.releasable ?? [],
    createCandidates: async () => seed.createCandidates ?? [],
    updatableLinks: async () => seed.updatable ?? [],
    holdableLinks: async () => seed.holdable ?? [],
    cancellableLinks: async () => seed.cancellable ?? [],
    upsertByOrder: async (orderId, create, update) => { upserts.push({ orderId, create, update }) },
    updateLink: async (id, data) => { updates.push({ id, data }) },
    recordEvent: async (event) => { events.push(event) },
  }
  return { port, upserts, updates, events }
}

const okPush = async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' })
function connector(overrides: {
  pushOrder?: () => Promise<WmsOrderPushResult>
  updateOrder?: () => Promise<WmsOrderUpdateResult>
  cancelOrder?: () => Promise<WmsOrderCancelResult>
  comments?: Array<{ externalOrderId: string; comment: string }>
  addOrderComment?: () => Promise<void>
} = {}) {
  return {
    pushOrder: overrides.pushOrder ?? okPush,
    updateOrder: overrides.updateOrder ?? (async () => ({ updated: true, status: 'NEW' })),
    cancelOrder: overrides.cancelOrder ?? (async () => ({ cancelled: true, status: 'CANCELLED' })),
    addOrderComment: overrides.addOrderComment
      ?? (overrides.comments
        ? async (externalOrderId: string, comment: string) => { overrides.comments!.push({ externalOrderId, comment }) }
        : undefined),
  }
}

test('skips when the connector has no push support', async () => {
  const r = await runWmsOrderPushSweepCore({ pushOrder: undefined }, 'mintsoft', makePort({}).port, { now: NOW })
  assert.match(r.skipped ?? '', /no order-push support/)
})

test('create: a bound, eligible order is pushed and marked SYNCED', async () => {
  const { port, upserts } = makePort({ createCandidates: [candidate()] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0].create.state, 'SYNCED')
  assert.equal(upserts[0].create.externalOrderId, 'wms-1')
  // G6: a reconciled, mapped-courier order carries no review flags.
  assert.equal(upserts[0].create.courierPending, false)
  assert.equal(upserts[0].create.totalMismatchPence, null)
})

test('create: a courier-fallback push posts a warehouse-visible verify-courier comment (G6c)', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const fallbackPush = connector({
    pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', courierFallback: true }),
    comments,
  })
  const { port, upserts } = makePort({ createCandidates: [candidate()] })
  const r = await runWmsOrderPushSweepCore(fallbackPush, 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].externalOrderId, 'wms-1')
  assert.match(comments[0].comment, /default courier/i)
  // G6: the courier-pending flag is persisted on the link for the operator view.
  assert.equal(upserts[0].create.courierPending, true)
})

test('create: a mis-totalled order is pushed but flagged for review (G6, non-blocking)', async () => {
  // subtotal 100 + tax 20 = 120 but total says 118 → 200p drift; still SYNCED (never blocks).
  const { port, upserts } = makePort({
    createCandidates: [candidate({ subtotalForeign: 100, taxForeign: 20, totalForeign: 118, lines: [{ sku: 'A', qty: 1, taxForeign: 20, totalForeign: 100, description: 'Widget' }] })],
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.equal(upserts[0].create.state, 'SYNCED')
  assert.equal(upserts[0].create.totalMismatchPence, 200)
})

test('create: a normal (no-fallback) push posts no courier comment', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port } = makePort({ createCandidates: [candidate()] })
  const r = await runWmsOrderPushSweepCore(connector({ comments }), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.equal(comments.length, 0)
})

test('create: a candidate whose warehouse is not bound is skipped (no write)', async () => {
  const { port, upserts } = makePort({ createCandidates: [candidate({ shipFromWarehouseId: 'wh-OTHER' })] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 0)
  assert.equal(upserts.length, 0)
})

test('create: a push failure increments attempts and stays PENDING_CREATE', async () => {
  const failing = connector({ pushOrder: async () => { throw new Error('boom') } })
  const { port, upserts } = makePort({ createCandidates: [candidate({ pushAttempts: 1 })] })
  const r = await runWmsOrderPushSweepCore(failing, 'mintsoft', port, { now: NOW })
  assert.equal(r.failed, 1)
  assert.equal(r.deadLettered, 0)
  assert.equal(upserts[0].update.state, 'PENDING_CREATE')
  assert.equal(upserts[0].update.attempts, 2)
  assert.equal(upserts[0].update.lastError, 'boom')
})

test('create: the 5th consecutive failure dead-letters', async () => {
  const failing = connector({ pushOrder: async () => { throw new Error('still down') } })
  const { port, upserts } = makePort({ createCandidates: [candidate({ pushAttempts: 4 })] })
  const r = await runWmsOrderPushSweepCore(failing, 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 1)
  assert.equal(r.failed, 0)
  assert.equal(upserts[0].update.state, 'DEAD_LETTER')
  assert.equal(upserts[0].update.attempts, 5)
})

test('create: a line with no SKU dead-paths the order (caught, not silently pushed)', async () => {
  const { port, upserts } = makePort({
    createCandidates: [candidate({ pushAttempts: 4, lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] })],
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 1)
  assert.match(String(upserts[0].update.lastError), /no SKU/i)
})

test('release: a HELD link is reset to PENDING_CREATE (external id cleared)', async () => {
  const { port, updates } = makePort({ releasable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-old' }] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.released, 1)
  assert.equal(updates[0].id, 'link-1')
  assert.equal(updates[0].data.state, 'PENDING_CREATE')
  assert.equal(updates[0].data.externalOrderId, null)
  assert.equal(updates[0].data.cancelledAt, null)
})

test('update: a changed order is amended; pushedAt bumped, error cleared', async () => {
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', order: { ...candidate(), shipFromWarehouseId: 'wh-1' } }
  const { port, updates } = makePort({ updatable: [link] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.updated, 1)
  assert.equal(updates[0].data.lastError, null)
  assert.equal((updates[0].data.pushedAt as Date).toISOString(), NOW().toISOString())
})

test('update: a past-NEW order is not amended but pushedAt is bumped (no futile retries)', async () => {
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', order: { ...candidate(), shipFromWarehouseId: 'wh-1' } }
  const notNew = connector({ updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }) })
  const { port, updates } = makePort({ updatable: [link] })
  const r = await runWmsOrderPushSweepCore(notNew, 'mintsoft', port, { now: NOW })
  assert.equal(r.updated, 0)
  assert.match(String(updates[0].data.lastError), /not propagated.*NOT_NEW/)
  assert.ok(updates[0].data.pushedAt) // still bumped
})

test('hold: an ON_HOLD pushed order is cancelled in the WMS and parked HELD', async () => {
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.held, 1)
  assert.equal(updates[0].data.state, 'HELD')
})

test('hold: a no-longer-cancellable WMS order becomes a dead-letter conflict + posts a warehouse comment', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const dispatched = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }), comments })
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(dispatched, 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 1)
  assert.equal(r.held, 0)
  assert.equal(updates[0].data.state, 'DEAD_LETTER')
  assert.equal(comments.length, 1)
  assert.equal(comments[0].externalOrderId, 'wms-1')
  assert.match(comments[0].comment, /ON HOLD/)
})

test('hold: a successful (NEW) cancel does not post a warehouse comment', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const { port } = makePort({ holdable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(connector({ comments }), 'mintsoft', port, { now: NOW })
  assert.equal(r.held, 1)
  assert.equal(comments.length, 0)
})

test('hold: a thrown addOrderComment does not break the dead-letter path', async () => {
  const dispatched = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }),
    addOrderComment: async () => { throw new Error('comments endpoint down') },
  })
  const { port, updates } = makePort({ holdable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(dispatched, 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 1)
  assert.equal(updates[0].data.state, 'DEAD_LETTER')
})

test('cancel: an IMS-cancelled pushed order is cancelled in the WMS', async () => {
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.cancelled, 1)
  assert.equal(updates[0].data.state, 'CANCELLED')
})

test('cancel: a WMS order already gone (NOT_FOUND) is treated as cancelled', async () => {
  const gone = connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }) })
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(gone, 'mintsoft', port, { now: NOW })
  assert.equal(r.cancelled, 1)
  assert.equal(updates[0].data.state, 'CANCELLED')
})

test('cancel: a past-NEW order (full refund or IMS cancel) dead-letters with a raise-a-query signal + warehouse comment', async () => {
  const comments: Array<{ externalOrderId: string; comment: string }> = []
  const dispatched = connector({ cancelOrder: async () => ({ cancelled: false, status: 'PROCESSING' }), comments })
  const { port, updates } = makePort({ cancellable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  const r = await runWmsOrderPushSweepCore(dispatched, 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 1)
  assert.equal(r.cancelled, 0)
  assert.equal(updates[0].data.state, 'DEAD_LETTER')
  assert.match(String(updates[0].data.lastError), /raise a cancellation query/i)
  assert.equal(comments.length, 1)
  assert.match(comments[0].comment, /cancelled \/ fully refunded/i)
})

// --- q66in.4.6: audit-grade mutation events -------------------------------

test('audit: a successful create records an order_create event with before/after + PII-free intent', async () => {
  const { port, events } = makePort({ createCandidates: [candidate({ pushAttempts: 1 })] })
  await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  const event = events.find((entry) => entry.action === 'order_create')
  assert.ok(event)
  assert.equal(event.outcome, 'SUCCEEDED')
  assert.equal(event.direction, 'OUTBOUND')
  assert.equal(event.connector, 'mintsoft')
  assert.equal(event.entityId, 'so-1')
  assert.equal(event.externalId, 'wms-1')
  assert.deepEqual(event.before, { state: 'PENDING_CREATE', attempts: 1 })
  const after = event.after as { state: string; intent: { lines: unknown[]; shippingAddress?: unknown; email?: unknown } }
  assert.equal(after.state, 'SYNCED')
  assert.equal(after.intent.lines.length, 1)
  // The intent projection must never carry the address/email of the order.
  assert.equal('shippingAddress' in after.intent, false)
  assert.equal('email' in after.intent, false)
})

test('audit: a failed create records a FAILED order_create event with the attempt state', async () => {
  const failing = connector({ pushOrder: async () => { throw new Error('boom') } })
  const { port, events } = makePort({ createCandidates: [candidate({ pushAttempts: 4 })] })
  await runWmsOrderPushSweepCore(failing, 'mintsoft', port, { now: NOW })
  const event = events.find((entry) => entry.action === 'order_create')
  assert.ok(event)
  assert.equal(event.outcome, 'FAILED')
  assert.equal(event.error, 'boom')
  assert.deepEqual(event.after, { state: 'DEAD_LETTER', attempts: 5 })
})

test('audit: release / hold / cancel each record their state transition', async () => {
  const { port, events } = makePort({
    releasable: [{ id: 'link-r', orderId: 'o-r', externalOrderId: 'wms-r' }],
    holdable: [{ id: 'link-h', orderId: 'o-h', externalOrderId: 'wms-h' }],
    cancellable: [{ id: 'link-c', orderId: 'o-c', externalOrderId: 'wms-c' }],
  })
  await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  const release = events.find((entry) => entry.action === 'order_release')
  assert.ok(release)
  assert.deepEqual(release.before, { state: 'HELD', externalOrderId: 'wms-r' })
  assert.deepEqual(release.after, { state: 'PENDING_CREATE', externalOrderId: null })
  const hold = events.find((entry) => entry.action === 'order_hold')
  assert.ok(hold)
  assert.equal(hold.outcome, 'SUCCEEDED')
  assert.equal(hold.entityId, 'o-h')
  const cancel = events.find((entry) => entry.action === 'order_cancel')
  assert.ok(cancel)
  assert.equal(cancel.outcome, 'SUCCEEDED')
  assert.equal((cancel.after as { state: string }).state, 'CANCELLED')
})

test('audit: a past-NEW cancel conflict records a FAILED order_cancel + an order_comment event', async () => {
  const conflicted = connector({
    cancelOrder: async () => ({ cancelled: false, status: 'PICKING' }),
    comments: [],
  })
  const { port, events } = makePort({ cancellable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  await runWmsOrderPushSweepCore(conflicted, 'mintsoft', port, { now: NOW })
  const cancel = events.find((entry) => entry.action === 'order_cancel')
  assert.ok(cancel)
  assert.equal(cancel.outcome, 'FAILED')
  assert.match(cancel.error ?? '', /past NEW/)
  const comment = events.find((entry) => entry.action === 'order_comment')
  assert.ok(comment)
  assert.equal(comment.outcome, 'SUCCEEDED')
  assert.equal(comment.entityId, 'o1')
})

test('audit: an update no-op (past NEW) records a FAILED order_update with the WMS status', async () => {
  const noop = connector({ updateOrder: async () => ({ updated: false, status: 'DESPATCHED' }) })
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', order: { ...candidate(), shipFromWarehouseId: 'wh-1' } }
  const { port, events } = makePort({ updatable: [link] })
  await runWmsOrderPushSweepCore(noop, 'mintsoft', port, { now: NOW })
  const event = events.find((entry) => entry.action === 'order_update')
  assert.ok(event)
  assert.equal(event.outcome, 'FAILED')
  assert.equal((event.after as { wmsStatus: string }).wmsStatus, 'DESPATCHED')
})

test('audit: a recordEvent failure never fails the sweep', async () => {
  const { port, upserts } = makePort({ createCandidates: [candidate()] })
  port.recordEvent = async () => { throw new Error('audit sink down') }
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.equal(upserts[0].create.state, 'SYNCED')
})

test('audit: remote create succeeds but the link write fails → event stays SUCCEEDED with linkPersistFailed (Codex r1)', async () => {
  const { port, events } = makePort({ createCandidates: [candidate()] })
  port.upsertByOrder = async () => { throw new Error('db down') }
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 0)
  const event = events.find((entry) => entry.action === 'order_create')
  assert.ok(event)
  assert.equal(event.outcome, 'SUCCEEDED')
  assert.equal(event.externalId, 'wms-1')
  assert.equal((event.after as { linkPersistFailed?: boolean }).linkPersistFailed, true)
  assert.match(event.error ?? '', /db down/)
})

test('audit: a failed release records no event and does not count (Codex r1)', async () => {
  const { port, events } = makePort({ releasable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-old' }] })
  port.updateLink = async () => { throw new Error('db down') }
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.released, 0)
  assert.equal(events.filter((entry) => entry.action === 'order_release').length, 0)
})

test('audit: remote cancel succeeds but the link write fails → SUCCEEDED with linkPersistFailed (Codex r1)', async () => {
  const { port, events } = makePort({ cancellable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-1' }] })
  port.updateLink = async () => { throw new Error('db down') }
  await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  const event = events.find((entry) => entry.action === 'order_cancel')
  assert.ok(event)
  assert.equal(event.outcome, 'SUCCEEDED')
  assert.equal((event.after as { linkPersistFailed?: boolean }).linkPersistFailed, true)
})
