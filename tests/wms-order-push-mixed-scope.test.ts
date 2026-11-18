import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPushInput,
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushCandidate,
  type WmsPushLinkRef,
  type WmsPushRevalidateLink,
  type WmsPushUpdateLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { MixedScope } from '../lib/domain/wms/mixed-scope.ts'
import type { RefusedActionInput } from '../lib/domain/refused-actions.ts'
import type { WmsOrderPushInput, WmsOrderPushResult, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'
import { recordingTaskPort } from './helpers/operator-task-port.ts'

const NOW = () => new Date('2026-11-18T10:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com', customerVatNumber: null,
    shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
    subtotalForeign: 30, shippingForeign: 5, taxForeign: 7, taxRatePercent: 20, pricesIncludeVat: false, discountAmount: 3, totalForeign: 39,
    shipFromWarehouseId: 'wh-1', pushAttempts: 0,
    lines: [
      { id: 'l1', sku: 'A', qty: 2, taxForeign: 4, totalForeign: 20, description: 'Widget' },
      { id: 'l2', sku: 'B', qty: 1, taxForeign: 2, totalForeign: 10, description: 'Gadget' },
    ],
    ...overrides,
  }
}

const MIXED: MixedScope = {
  mode: 'MIXED', shippingCarried: true, discountMinor: 200, shippingMinor: 500, vatMinor: 500, hash: 'h1',
  lines: [{ lineId: 'l1', sku: 'A', description: 'Widget', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2 }],
}

// ---- golden payload: a single-warehouse order is byte-identical whatever the flag says ----------------------------------------------------------------
const GOLDEN = '{"orderNumber":"SO-1","externalReference":"so-1","externalWarehouseId":"301","currency":"GBP","shippingAddress":{"firstName":"Jane","lastName":"Doe","company":"","address1":"1 St","address2":"","town":"Leeds","county":"","postCode":"LS1","country":"GB"},"email":"jane@example.com","phone":null,"vatNumber":null,"comments":null,"courierService":"Royal Mail","courierServiceAlternates":["Royal Mail"],"courierServiceLegacy":null,"totalVat":7,"shippingExVat":5,"shippingVat":0,"discountExVat":3,"discountVat":0,"lines":[{"sku":"A","quantity":2,"unitPriceExVat":10,"unitPriceVat":2,"description":"Widget"},{"sku":"B","quantity":1,"unitPriceExVat":10,"unitPriceVat":2,"description":"Gadget"}]}'

test('golden: the single-warehouse payload is byte-identical with no scope, a FULL scope, and the pinned snapshot', () => {
  const off = JSON.stringify(buildPushInput(candidate(), '301'))
  const on = JSON.stringify(buildPushInput(candidate(), '301', { mode: 'FULL' }))
  assert.equal(on, off)
  assert.equal(off, GOLDEN)
})

test('golden through the sweep: a flag-ON port that answers FULL pushes the same bytes as a port with no scope support', async () => {
  const sent: string[] = []
  const run = async (loadMixedScope?: WmsOrderPushPort['loadMixedScope']) => {
    const { port } = makePort({ createCandidates: [candidate()], loadMixedScope })
    await runWmsOrderPushSweepCore(connector({ pushOrder: async (input) => { sent.push(JSON.stringify(input)); return okPush() } }), 'mintsoft', port, { now: NOW })
  }
  await run(undefined)
  await run(async () => ({ mode: 'FULL' }))
  await run(async () => null)
  assert.equal(sent.length, 3)
  assert.equal(sent[0], GOLDEN)
  assert.deepEqual(sent, [sent[0], sent[0], sent[0]])
})

test('golden: an amendment of a single-warehouse order is the same payload with the flag on and off', async () => {
  const sent: string[] = []
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', order: { ...candidate(), shipFromWarehouseId: 'wh-1' } }
  for (const loadMixedScope of [undefined, async () => ({ mode: 'FULL' as const })]) {
    const { port } = makePort({ updatable: [link], loadMixedScope })
    await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sent.push(JSON.stringify(input)); return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  }
  assert.equal(sent.length, 2)
  assert.equal(sent[0], sent[1])
})

// ---- scoped create --------------------------------------------------------------------------------------------------------------------------------
test('create: a MIXED scope sends only the scoped lines and money, skips the whole-order total check, and records the scope sent', async () => {
  let sentInput: WmsOrderPushInput | null = null
  const { port, recorded, upserts } = makePort({ createCandidates: [candidate()], loadMixedScope: async () => MIXED })
  const r = await runWmsOrderPushSweepCore(connector({ pushOrder: async (input) => { sentInput = input; return okPush() } }), 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.deepEqual(sentInput!.lines, [{ sku: 'A', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2, description: 'Widget' }])
  assert.equal(sentInput!.shippingExVat, 5)
  assert.equal(sentInput!.discountExVat, 2)
  assert.equal(sentInput!.totalVat, 5)
  assert.equal(upserts[0].create.totalMismatchPence, null, 'a part of an order is not compared with the whole')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].orderId, 'so-1')
  assert.equal(recorded[0].scope.mode, 'MIXED')
})

test('create: a HOLD / REFUSED / EMPTY scope sends nothing: the order is parked as a local build failure with the reason', async () => {
  for (const scope of [
    { mode: 'HOLD', reason: 'units unallocated', unallocated: [] },
    { mode: 'REFUSED', reason: 'kit split', code: 'SPLIT_KIT', lineIds: ['l1'] },
    { mode: 'EMPTY', reason: 'nothing for this warehouse' },
  ] as MixedScope[]) {
    let pushed = 0
    const { port, validationFailures } = makePort({ createCandidates: [candidate()], loadMixedScope: async () => scope })
    const r = await runWmsOrderPushSweepCore(connector({ pushOrder: async () => { pushed += 1; return okPush() } }), 'mintsoft', port, { now: NOW })
    assert.equal(pushed, 0)
    assert.equal(r.created, 0)
    assert.equal(r.validationFailed, 1)
    assert.match(validationFailures[0].error, new RegExp((scope as { reason: string }).reason))
  }
})

test('create: a scope that cannot be READ sends nothing and counts a failure (never the whole of a possibly mixed order)', async () => {
  let pushed = 0
  const { port } = makePort({ createCandidates: [candidate()], loadMixedScope: async () => { throw new Error('db down') } })
  const original = console.error
  console.error = () => {}
  let r
  try { r = await runWmsOrderPushSweepCore(connector({ pushOrder: async () => { pushed += 1; return okPush() } }), 'mintsoft', port, { now: NOW }) } finally { console.error = original }
  assert.equal(pushed, 0)
  assert.equal(r.failed, 1)
})

// ---- scoped amend ---------------------------------------------------------------------------------------------------------------------------------
const dirtyLink = (over: Partial<WmsPushUpdateLink> = {}): WmsPushUpdateLink => ({
  id: 'link-1', externalOrderId: 'wms-1', pushWarehouseId: 'wh-1', scopeMode: 'MIXED', scopeHash: 'h0', scopeDirtyAt: new Date('2026-11-18T09:00:00.000Z'), pushedAt: new Date('2026-11-18T09:30:00.000Z'),
  order: { ...candidate(), shipFromWarehouseId: 'wh-1', updatedAt: new Date('2026-11-18T08:00:00.000Z') }, ...over,
})

test('amend: an allocation change (dirty, new hash) amends the warehouse order with the new scope and records it', async () => {
  let sentInput: WmsOrderPushInput | null = null
  const { port, recorded, updates } = makePort({ updatable: [dirtyLink()], loadMixedScope: async () => MIXED })
  const r = await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sentInput = input; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(r.updated, 1)
  assert.deepEqual(sentInput!.lines.map((l) => [l.sku, l.quantity]), [['A', 1]])
  assert.equal(recorded.length, 1)
  assert.equal(updates[0].data.pushWarehouseId, 'wh-1')
})

test('amend: dirty but the same part would be sent: nothing is sent, the check is recorded', async () => {
  let called = 0
  const { port, recorded, updates } = makePort({ updatable: [dirtyLink({ scopeHash: 'h1' })], loadMixedScope: async () => MIXED })
  const r = await runWmsOrderPushSweepCore(connector({ updateOrder: async () => { called += 1; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(called, 0)
  assert.equal(r.updated, 0)
  assert.equal(recorded.length, 1)
  assert.equal(updates.length, 0)
})

test('amend: a scope change on an order past NEW is not applied; the link is frozen (HIGH refused action), not retried', async () => {
  const { port, freezes, refusals } = makePort({ updatable: [dirtyLink()], loadMixedScope: async () => MIXED })
  const r = await runWmsOrderPushSweepCore(connector({ updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }) }), 'mintsoft', port, { now: NOW })
  assert.equal(r.updated, 0)
  assert.equal(freezes.length, 1, 'frozen through the fenced write (the dirty mark is cleared only when set before the read)')
  assert.equal(refusals.find((x) => x.gate === 'WMS_ORDER_NOT_NEW')?.severity, 'HIGH')
})

test('amend: any other refusal (NOT_FOUND) is NOT a freeze', async () => {
  const { port, freezes } = makePort({ updatable: [dirtyLink()], loadMixedScope: async () => MIXED })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async () => ({ updated: false, status: 'NOT_FOUND' }) }), 'mintsoft', port, { now: NOW })
  assert.equal(freezes.length, 0)
})

test('amend: a HOLD scope changes nothing in the warehouse and leaves the order due', async () => {
  let called = 0
  const { port, recorded, updates } = makePort({ updatable: [dirtyLink()], loadMixedScope: async () => ({ mode: 'HOLD', reason: 'units unallocated', unallocated: [] }) })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async () => { called += 1; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(called, 0)
  assert.equal(recorded.length, 1)
  assert.equal(updates.length, 0, 'not due by an order change: nothing to send')
})

test('amend: a split kit is escalated HIGH for a person and nothing is sent', async () => {
  let called = 0
  const { port, refusals } = makePort({ updatable: [dirtyLink()], loadMixedScope: async () => ({ mode: 'REFUSED', code: 'SPLIT_KIT', lineIds: ['l1'], reason: 'kit split' }) })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async () => { called += 1; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(called, 0)
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].gate, 'WMS_SCOPE_UNSENDABLE')
  assert.equal(refusals[0].severity, 'HIGH')
})

test('amend: the warehouse order is amended in the warehouse the link was pushed for, not the current ship-from', async () => {
  let sentInput: WmsOrderPushInput | null = null
  const link = dirtyLink({ pushWarehouseId: 'wh-2', order: { ...candidate(), shipFromWarehouseId: 'wh-1', updatedAt: new Date('2026-11-18T08:00:00.000Z') } })
  const { port } = makePort({ updatable: [link], bindings: [...BINDINGS, { warehouseId: 'wh-2', externalWarehouseId: '302' }], loadMixedScope: async () => MIXED })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sentInput = input; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(sentInput!.externalWarehouseId, '302')
})

const dueLink = (over: Partial<WmsPushUpdateLink> = {}): WmsPushUpdateLink => dirtyLink({ order: { ...candidate(), shipFromWarehouseId: 'wh-1', updatedAt: new Date('2026-11-18T09:45:00.000Z') }, ...over })
const HOLD: MixedScope = { mode: 'HOLD', reason: 'units unallocated', unallocated: [] }

test('amend (HIGH 1): an unsendable scope gates only the LINE SET: an address/service change still amends, on the lines the warehouse already holds', async () => {
  for (const scope of [HOLD, { mode: 'REFUSED', code: 'SPLIT_KIT', lineIds: ['l1'], reason: 'kit split' } as MixedScope]) {
    let sentInput: WmsOrderPushInput | null = null
    const { port, recorded, updates, refusals } = makePort({ updatable: [dueLink()], loadMixedScope: async () => scope, loadRecordedMixedScope: async () => MIXED })
    const r = await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sentInput = input; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
    assert.equal(r.updated, 1)
    assert.deepEqual(sentInput!.lines.map((l) => [l.sku, l.quantity]), [['A', 1]], 'the recorded part, not the whole order and not the new line set')
    assert.equal(sentInput!.shippingAddress.address1, '1 St')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].scope.mode, scope.mode, 'the unsendable check is recorded; the recorded part is NOT re-recorded as sent')
    assert.equal(updates[0].data.pushWarehouseId, 'wh-1')
    assert.equal(refusals.find((x) => x.gate === 'WMS_SCOPE_UNSENDABLE')?.severity, scope.mode === 'HOLD' ? 'MEDIUM' : 'HIGH', 'a standing row is written for HOLD too')
  }
})

test('amend: an unsendable scope with no recorded part to rebuild from sends nothing (never the whole order)', async () => {
  let called = 0
  const { port } = makePort({ updatable: [dueLink()], loadMixedScope: async () => HOLD, loadRecordedMixedScope: async () => null })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async () => { called += 1; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(called, 0)
})

test('amend: an EMPTY scope sends no amendment (the cancel pass pulls the New order back)', async () => {
  let called = 0
  const { port, refusals } = makePort({ updatable: [dueLink()], loadMixedScope: async () => ({ mode: 'EMPTY', reason: 'nothing for this warehouse' }) })
  await runWmsOrderPushSweepCore(connector({ updateOrder: async () => { called += 1; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.equal(called, 0)
  assert.equal(refusals[0].severity, 'HIGH')
  assert.match(String(refusals[0].detail), /cancelled while it is still New/)
})

test('cancel pass: an EMPTY-scope link is cancelled while the warehouse order is NEW, and is only ever effective then (past NEW: a notice, link stays live)', async () => {
  const link: WmsPushLinkRef = { id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', scopeEmpty: true }
  const cancelled = makePort({ cancellable: [link] })
  const r = await runWmsOrderPushSweepCore(connector({ cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }) }), 'mintsoft', cancelled.port, { now: NOW })
  assert.equal(r.cancelled, 1)
  const late = makePort({ cancellable: [link] })
  const r2 = await runWmsOrderPushSweepCore(connector({ cancelOrder: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) }), 'mintsoft', late.port, { now: NOW })
  assert.equal(r2.cancelled, 0)
  assert.equal(late.updates.some((u) => u.data.state === 'CANCELLED'), false, 'a past-NEW warehouse order is never marked cancelled')
})

test('flag turned OFF with a MIXED link: the scope is still read for it (the whole order is never sent)', async () => {
  const asked: boolean[] = []
  const { port } = makePort({ updatable: [dueLink()], loadMixedScope: async (_o: string, _w: string, linkIsMixed?: boolean) => { asked.push(linkIsMixed === true); return linkIsMixed ? MIXED : null } })
  let sentInput: WmsOrderPushInput | null = null
  await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sentInput = input; return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
  assert.deepEqual(asked, [true])
  assert.deepEqual(sentInput!.lines.map((l) => l.sku), ['A'])
})

test('golden (flag ON): a single-warehouse link amends exactly as development does, including a ship-from change (not the old pushWarehouseId)', async () => {
  const bindings = [...BINDINGS, { warehouseId: 'wh-old', externalWarehouseId: '399' }]
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', pushWarehouseId: 'wh-old', scopeMode: 'FULL', order: { ...candidate(), shipFromWarehouseId: 'wh-1' } }
  const sent: string[] = []
  const stamps: unknown[] = []
  for (const loadMixedScope of [undefined, async () => ({ mode: 'FULL' as const })]) {
    const { port, updates } = makePort({ updatable: [link], bindings, loadMixedScope })
    await runWmsOrderPushSweepCore(connector({ updateOrder: async (_id: string, input: WmsOrderPushInput) => { sent.push(JSON.stringify(input)); return { updated: true, status: 'NEW' } } }), 'mintsoft', port, { now: NOW })
    stamps.push(updates[0].data.pushWarehouseId)
  }
  assert.equal(sent[0], sent[1])
  assert.match(sent[0], /"externalWarehouseId":"301"/)
  assert.deepEqual(stamps, ['wh-1', 'wh-1'])
})

test('create: the scope is read AGAIN after the claim and the send uses that read', async () => {
  let reads = 0
  let sentInput: WmsOrderPushInput | null = null
  const second: MixedScope = { ...(MIXED as Extract<MixedScope, { mode: 'MIXED' }>), lines: [{ lineId: 'l2', sku: 'B', description: 'Gadget', quantity: 1, unitPriceExVat: 10, unitPriceVat: 2 }] }
  const { port, recorded } = makePort({ createCandidates: [candidate()], loadMixedScope: async () => (++reads === 1 ? MIXED : second) })
  ;(port as { reloadOrderForPush?: unknown }).reloadOrderForPush = async () => ({})
  await runWmsOrderPushSweepCore(connector({ pushOrder: async (input) => { sentInput = input; return okPush() } }), 'mintsoft', port, { now: NOW })
  assert.ok(reads >= 2)
  assert.deepEqual(sentInput!.lines.map((l) => l.sku), ['B'])
  assert.equal((recorded[0].scope as { lines: Array<{ sku: string }> }).lines[0].sku, 'B')
})

// ---- revalidation -----------------------------------------------------------------------------------------------------------------------------------
const parked = (): WmsPushRevalidateLink => ({ id: 'link-1', orderId: 'so-1', lastError: 'old', attempts: 0, pushedAt: null, externalOrderId: null, order: { ...candidate(), shipFromWarehouseId: 'wh-1' } })

test('revalidation: a parked order whose scope is still unsendable stays parked with the new reason (no re-queue, no remote call)', async () => {
  const { port, updates } = makePort({ revalidatable: { links: [parked()], total: 1 }, loadMixedScope: async () => ({ mode: 'HOLD', reason: 'units unallocated', unallocated: [] }) })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.revalidated, 0)
  assert.match(String(updates[0].data.lastError), /units unallocated/)
  assert.notEqual(updates[0].data.state, 'PENDING_CREATE')
})

test('revalidation: once the scope is sendable the order is re-queued for the create pass', async () => {
  const { port, updates } = makePort({ revalidatable: { links: [parked()], total: 1 }, loadMixedScope: async () => MIXED })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.revalidated, 1)
  assert.equal(updates.some((u) => u.data.state === 'PENDING_CREATE'), true)
})

// ---- harness ---------------------------------------------------------------------------------------------------------------------------------------
type Seed = {
  revalidatable?: { links: WmsPushRevalidateLink[]; total: number }
  bindings?: Array<{ warehouseId: string; externalWarehouseId: string }>
  createCandidates?: WmsPushCandidate[]
  updatable?: WmsPushUpdateLink[]
  loadMixedScope?: WmsOrderPushPort['loadMixedScope']
  loadRecordedMixedScope?: WmsOrderPushPort['loadRecordedMixedScope']
  cancellable?: WmsPushLinkRef[]
}
function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const validationFailures: Array<{ orderId: string; error: string }> = []
  const recorded: Array<{ orderId: string; scope: MixedScope; readAt: Date }> = []
  const refusals: RefusedActionInput[] = []
  const freezes: Array<{ orderId: string; readAt: Date }> = []
  const taskPort = recordingTaskPort()
  const port: WmsOrderPushPort = {
    activeBindings: async () => seed.bindings ?? BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async () => seed.createCandidates ?? [],
    revalidatableLinks: async () => seed.revalidatable ?? { links: [], total: 0 },
    recordValidationFailure: async (orderId, _connector, error) => { validationFailures.push({ orderId, error }); return true },
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: async () => [],
    updatableLinks: async () => seed.updatable ?? [],
    holdableLinks: async () => [],
    cancellableLinks: async () => seed.cancellable ?? [],
    upsertByOrder: async (orderId, create, update) => { upserts.push({ orderId, create, update }) },
    updateLink: async (id, data) => { updates.push({ id, data }) },
    updateLinkIfCreateClaimOwned: async () => true,
    updateLinkIfState: async (id, _from, data) => { updates.push({ id, data }); return true },
    raiseOperatorTask: taskPort.raiseOperatorTask,
    countOpenOperatorTasks: taskPort.countOpenOperatorTasks,
    recordEvent: async () => {},
    recordRefusedAction: async (input) => { refusals.push(input) },
    freezeMixedScope: async (orderId: string, readAt: Date) => { freezes.push({ orderId, readAt }) },
    ...(seed.loadRecordedMixedScope ? { loadRecordedMixedScope: seed.loadRecordedMixedScope } : {}),
    ...(seed.loadMixedScope ? { loadMixedScope: seed.loadMixedScope, recordMixedScope: async (orderId: string, scope: MixedScope, readAt: Date) => { recorded.push({ orderId, scope, readAt }) } } : {}),
  }
  return { port, upserts, updates, validationFailures, recorded, refusals, freezes }
}
const okPush = async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' })
function connector(overrides: { pushOrder?: (input: WmsOrderPushInput) => Promise<WmsOrderPushResult>; updateOrder?: (id: string, input: WmsOrderPushInput) => Promise<WmsOrderUpdateResult>; cancelOrder?: () => Promise<{ cancelled: boolean; status: string }> } = {}) {
  return {
    pushOrder: overrides.pushOrder ?? okPush,
    updateOrder: (overrides.updateOrder ?? (async () => ({ updated: true, status: 'NEW' }))) as never,
    cancelOrder: (overrides.cancelOrder ?? (async () => ({ cancelled: true, status: 'CANCELLED' }))) as never,
  }
}
