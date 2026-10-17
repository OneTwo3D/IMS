import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '../lib/security/outbound-write-hold-constants.ts'
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '../lib/security/producer-disposition-constants.ts'
import type {
  WmsOrderPushPort,
  WmsPushCandidate,
  WmsPushLinkRef,
  WmsPushUpdateLink,
  WmsPushVerifyLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderCancelResult, WmsOrderPushInput, WmsOrderPushResult, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'

/**
 * THE ORDER-PUSH SWEEP UNDER THE PRODUCER-SIDE HOLD: THE DIFFERENTIAL, AND "NOTHING IS CLAIMED, NOTHING IS WRITTEN, NOTHING IS REVIVED".
 *
 * Every arm drives the REAL sweep (runWmsOrderPushSweepCore) with a recording port and a recording connector double, with the
 * switch OFF (the default: the legacy behaviour, the control that proves the doubles can see a write) and ON with no grant (the
 * posture that must write nothing to Mintsoft on ANY pass). Mintsoft is LIVE: the connector is a double, nothing here can reach it,
 * and tests/no-outbound-network.cjs fails the file if anything tried to leave the box. The shadow store is a recording fake.
 *
 * The named signals are the ones ONLY the seam produces: a shadow record per piece of work, and a port that was never called. The
 * transport barrier behind it has its own counter in tests/connectors/mintsoft-egress-control.test.ts.
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  claim-then-shadow       the create pass claims the order and only then asks the seam: the "no claim" arm goes red
 *  b  obligation-dropped      the create pass stops passing the order's paid time: the "paid before the live-from instant" arm goes red
 *  c  reopen-passes-run       the release / revalidation / ambiguous passes ignore the hold: the "nothing is revived" arm goes red
 *  d  cancel-by-method        the hold and cancel passes shadow by HTTP method instead of by operation: the P2 arm goes red
 *  e  verify-converts         a withdrawn PENDING_VERIFY link is cancelled/parked while held: the verify arm goes red
 */

const ORIGIN = 'https://wms.example.test'
const GRANT = `${ORIGIN}|89`
const ENV_KEYS = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.mintsoft, PRODUCER_CUTOFF_ENV.mintsoft]
const CUTOFF = '2026-06-01T00:00:00Z'
const OFF = {}
const HELD = { [PRODUCER_HOLD_ENFORCED_ENV]: 'mintsoft' }
const LIVE = { ...HELD, [OUTBOUND_GRANT_ENV.mintsoft]: GRANT, [PRODUCER_CUTOFF_ENV.mintsoft]: CUTOFF }
const NOW = () => new Date('2026-06-26T00:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]
const BEFORE_CUTOFF = new Date('2026-05-20T00:00:00.000Z')
const AFTER_CUTOFF = new Date('2026-06-10T00:00:00.000Z')

// A recording shadow store in place of the database. Created before the sweep module is imported.
const shadows: Array<{ operation: string; subjectType: string; subjectId: string; reason: string }> = []
const fakeDb = {
  $queryRaw: async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
    const text = (query.strings ?? []).join('?')
    if (!text.includes('outbound_shadow_writes')) return []
    const values = query.values ?? []
    const existing = shadows.filter((shadow) => shadow.operation === String(values[1]) && shadow.subjectId === String(values[3])).length
    shadows.push({ operation: String(values[1]), subjectType: String(values[2]), subjectId: String(values[3]), reason: String(values[6]) })
    return [{ id: `shadow-${shadows.length}`, inserted: existing === 0, occurrences: existing + 1, accounting_sync_log_id: null, sync_row_exists: false }]
  },
  $executeRaw: async () => 1,
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  shadows.length = 0
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

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
    paidAt: AFTER_CUTOFF,
    createdAt: AFTER_CUTOFF,
    ...overrides,
  }
}

type Seed = {
  releasable?: Parameters<NonNullable<WmsOrderPushPort['releasableHeldOrders']>>[0] extends never ? never : Awaited<ReturnType<WmsOrderPushPort['releasableHeldOrders']>>
  createCandidates?: WmsPushCandidate[]
  updatable?: WmsPushUpdateLink[]
  holdable?: WmsPushLinkRef[]
  cancellable?: WmsPushLinkRef[]
  verifiable?: WmsPushVerifyLink[]
  revalidatable?: Awaited<ReturnType<NonNullable<WmsOrderPushPort['revalidatableLinks']>>>
  ambiguous?: Awaited<ReturnType<NonNullable<WmsOrderPushPort['ambiguousCreateLinks']>>>
  withdrawn?: boolean
}

function makePort(seed: Seed) {
  const reads: string[] = []
  const writes: string[] = []
  const events: string[] = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => { reads.push('releasableHeldOrders'); return seed.releasable ?? [] },
    createCandidates: async () => { reads.push('createCandidates'); return seed.createCandidates ?? [] },
    revalidatableLinks: async () => { reads.push('revalidatableLinks'); return seed.revalidatable ?? { links: [], total: 0 } },
    ambiguousCreateLinks: async () => { reads.push('ambiguousCreateLinks'); return seed.ambiguous ?? { links: [], total: 0 } },
    recordValidationFailure: async (orderId) => { writes.push(`recordValidationFailure:${orderId}`); return true },
    claimForCreate: async (orderId) => { writes.push(`claimForCreate:${orderId}`); return 'CLAIMED' },
    verifiableLinks: async () => { reads.push('verifiableLinks'); return seed.verifiable ?? [] },
    updatableLinks: async () => { reads.push('updatableLinks'); return seed.updatable ?? [] },
    holdableLinks: async () => { reads.push('holdableLinks'); return seed.holdable ?? [] },
    cancellableLinks: async () => { reads.push('cancellableLinks'); return seed.cancellable ?? [] },
    upsertByOrder: async (orderId, create) => { writes.push(`upsertByOrder:${orderId}:${String(create.state)}`) },
    updateLink: async (id, data) => { writes.push(`updateLink:${id}:${String(data.state ?? '-')}`) },
    updateLinkByOrder: async (orderId, data) => { writes.push(`updateLinkByOrder:${orderId}:${String(data.state ?? '-')}`) },
    updateLinkIfState: async (id, fromState, data) => { writes.push(`updateLinkIfState:${id}:${fromState}->${String(data.state ?? '-')}`); return true },
    updateLinkIfCreateClaimOwned: async (orderId) => { writes.push(`updateLinkIfCreateClaimOwned:${orderId}`); return true },
    readWithdrawalState: async () => (seed.withdrawn ? { withdrawalHoldAt: new Date(), withdrawalApprovedAt: null } : { withdrawalHoldAt: null, withdrawalApprovedAt: null }),
    screenLiveWithdrawals: async () => { reads.push('screenLiveWithdrawals'); return new Set<string>() },
    verifyWithdrawalFence: async () => { reads.push('verifyWithdrawalFence'); return true },
    recordEvent: async (event) => { events.push(String(event.action)) },
  }
  return { port, reads, writes, events }
}

function makeConnector(options: { cancelStatus?: string; verdict?: 'ours' | 'foreign' | 'unknown' } = {}) {
  const calls: string[] = []
  const clearances: unknown[] = []
  const connector = {
    pushOrder: async (input: WmsOrderPushInput, clearance: unknown): Promise<WmsOrderPushResult> => { calls.push(`pushOrder:${input.orderNumber}`); clearances.push(clearance); return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } },
    updateOrder: async (id: string, _input: WmsOrderPushInput, clearance: unknown): Promise<WmsOrderUpdateResult> => { calls.push(`updateOrder:${id}`); clearances.push(clearance); return { updated: true, status: 'NEW' } },
    cancelOrder: async (id: string, clearance: unknown): Promise<WmsOrderCancelResult> => {
      calls.push(`cancelOrder:${id}`); clearances.push(clearance)
      return options.cancelStatus === 'NOT_CANCELLABLE' ? { cancelled: false, status: 'NOT_CANCELLABLE' } : { cancelled: true, status: 'CANCELLED' }
    },
    addOrderComment: async (id: string, _comment: string, clearance: unknown): Promise<void> => { calls.push(`addOrderComment:${id}`); clearances.push(clearance) },
    verifyPushedOrder: async (id: string) => { calls.push(`verifyPushedOrder:${id}`); return options.verdict ?? 'ours' },
    probeOrderPresence: async (reference: string) => { calls.push(`probeOrderPresence:${reference}`); return 'MISSING' as const },
  }
  return { connector, calls, clearances }
}

const verifyLink = (overrides: Partial<WmsPushVerifyLink> = {}): WmsPushVerifyLink => ({
  id: 'link-v', orderId: 'so-v', externalOrderId: 'wms-v', orderNumber: 'SO-V', externalReference: 'so-v', verifyAttempts: 0, courierPending: false, shippingService: null, ...overrides,
})
const updateLink = (overrides: Partial<WmsPushUpdateLink> = {}): WmsPushUpdateLink => ({
  id: 'link-u', externalOrderId: 'wms-u', order: { ...candidate({ id: 'so-u', orderNumber: 'SO-U' }), shipFromWarehouseId: 'wh-1' }, ...overrides,
})
const ref = (id: string): WmsPushLinkRef => ({ id: `link-${id}`, orderId: id, externalOrderId: `wms-${id}` })
const heldLink = () => ({
  id: 'link-h', orderId: 'so-h', externalOrderId: 'wms-h', cancelledAt: new Date('2026-06-25T00:00:00.000Z'), order: { id: 'so-h', orderNumber: 'SO-H', externalOrderNumber: null },
})

async function sweep(seed: Seed, connectorOptions: Parameters<typeof makeConnector>[0] = {}, connectorId = 'mintsoft') {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const harness = makePort(seed)
  const double = makeConnector(connectorOptions)
  const result = await runWmsOrderPushSweepCore(double.connector, connectorId, harness.port, { now: NOW })
  return { result, ...harness, ...double }
}

// ───────────────────────── 1. the differential ─────────────────────────

test('CONTROL / DIFFERENTIAL: switch OFF is the legacy sweep: the order is claimed, pushed with a clearance, linked, and the result has no `shadowed` key', async () => {
  await withEnv(OFF, async () => {
    const run = await sweep({ createCandidates: [candidate()], updatable: [updateLink()], holdable: [ref('so-h2')], cancellable: [ref('so-c')] })
    console.log(`# OFF: calls=${JSON.stringify(run.calls)} writes=${JSON.stringify(run.writes)} shadows=${shadows.length}`)
    assert.deepEqual(run.calls, ['pushOrder:SO-1', 'updateOrder:wms-u', 'cancelOrder:wms-so-h2', 'cancelOrder:wms-so-c'])
    assert.ok(run.clearances.every((clearance) => clearance !== undefined && clearance !== null), 'every write received a clearance')
    assert.deepEqual(run.writes.slice(0, 2), ['claimForCreate:so-1', 'upsertByOrder:so-1:SYNCED'])
    assert.equal(run.result.created, 1)
    assert.equal(run.result.updated, 1)
    assert.equal(run.result.held, 1)
    assert.equal(run.result.cancelled, 1)
    assert.equal('shadowed' in run.result, false, 'byte-identical result: the key is absent, not zero')
    assert.equal(shadows.length, 0)
    assert.ok(run.reads.includes('screenLiveWithdrawals') && run.reads.includes('releasableHeldOrders') && run.reads.includes('revalidatableLinks') && run.reads.includes('ambiguousCreateLinks'))
  })
})

test('OFF for another destination only: the sweep is the legacy sweep too', async () => {
  await withEnv({ [PRODUCER_HOLD_ENFORCED_ENV]: 'xero,woocommerce' }, async () => {
    const run = await sweep({ createCandidates: [candidate()] })
    assert.deepEqual(run.calls, ['pushOrder:SO-1'])
    assert.equal(run.result.created, 1)
    assert.equal(shadows.length, 0)
  })
})

// ───────────────────────── 2. ON, no grant: the create pass ─────────────────────────

test('ON and no grant: the create pass claims NOTHING, writes no link, calls no connector, screens nothing, and records one shadow per order', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ createCandidates: [candidate({ id: 'so-1' }), candidate({ id: 'so-2', orderNumber: 'SO-2' })] })
    console.log(`# ON create: calls=${JSON.stringify(run.calls)} writes=${JSON.stringify(run.writes)} shadows=${JSON.stringify(shadows)}`)
    assert.deepEqual(run.calls, [], 'no connector method of any kind was called')
    assert.deepEqual(run.writes, [], 'no claim, no link write, no attempt, no validation failure, no audit')
    assert.deepEqual(run.events, [])
    assert.equal(run.reads.includes('screenLiveWithdrawals'), false, 'the storefront is not even asked: nothing in the batch can be pushed')
    assert.equal(run.reads.includes('verifyWithdrawalFence'), false)
    assert.equal(run.result.shadowed, 2)
    assert.equal(run.result.created, 0)
    assert.equal(run.result.failed, 0)
    assert.equal(run.result.deadLettered, 0)
    assert.deepEqual(shadows.map((shadow) => [shadow.operation, shadow.subjectType, shadow.subjectId, shadow.reason]), [
      ['order.create', 'SalesOrder', 'so-1', 'no_grant'],
      ['order.create', 'SalesOrder', 'so-2', 'no_grant'],
    ])
  })
})

test('ON: a repeat tick offers the same orders again and counts them again (nothing was consumed, nothing is revived)', async () => {
  await withEnv(HELD, async () => {
    const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
    const { port, writes } = makePort({ createCandidates: [candidate()] })
    const { connector, calls } = makeConnector()
    const first = await runWmsOrderPushSweepCore(connector, 'mintsoft', port, { now: NOW })
    const second = await runWmsOrderPushSweepCore(connector, 'mintsoft', port, { now: NOW })
    assert.equal(first.shadowed, 1)
    assert.equal(second.shadowed, 1)
    assert.equal(shadows.length, 2, 'two productions of the same work (the table counts them as occurrences of one row)')
    assert.deepEqual(calls, [])
    assert.deepEqual(writes, [])
  })
})

test('ON: an order whose payload cannot be built is a shadow too, with NO validation-failed link (a local data error does not change state while held)', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ createCandidates: [candidate({ shippingAddress: {}, billingAddress: {} } as Partial<WmsPushCandidate>)] })
    assert.equal(run.result.shadowed, 1)
    assert.equal(run.result.validationFailed, 0)
    assert.deepEqual(run.writes, [], 'recordValidationFailure was not called')
    assert.equal(shadows.length, 1, 'the shadow still records that the order would have been pushed')
  })
  await withEnv(OFF, async () => {
    const run = await sweep({ createCandidates: [candidate({ shippingAddress: {}, billingAddress: {} } as Partial<WmsPushCandidate>)] })
    assert.equal(run.result.validationFailed, 1, 'CONTROL: the legacy path records the validation failure')
    assert.deepEqual(run.writes, ['recordValidationFailure:so-1'])
  })
})

// ───────────────────────── 3. ON: the passes that only re-open a create stand down ─────────────────────────

test('ON: the release, revalidation and ambiguous-create passes read nothing and change nothing; OFF they all run (the control)', async () => {
  const seed: Seed = {
    releasable: [heldLink()],
    revalidatable: { links: [], total: 3 },
    ambiguous: { links: [], total: 2 },
  }
  await withEnv(OFF, async () => {
    const run = await sweep(seed)
    for (const name of ['releasableHeldOrders', 'revalidatableLinks', 'ambiguousCreateLinks']) assert.ok(run.reads.includes(name), `CONTROL: ${name} runs when the hold is not enforced`)
  })
  await withEnv(HELD, async () => {
    const run = await sweep(seed)
    console.log(`# ON reads: ${JSON.stringify(run.reads)}`)
    for (const name of ['releasableHeldOrders', 'revalidatableLinks', 'ambiguousCreateLinks']) assert.equal(run.reads.includes(name), false, `${name} stood down`)
    assert.deepEqual(run.writes, [], 'a HELD link is neither released nor parked while the warehouse is held')
    assert.deepEqual(run.calls, [])
  })
})

// ───────────────────────── 4. ON: amend, hold and cancel ─────────────────────────

test('ON: the update, hold and cancel passes call no connector method and write no link; each piece of work is a shadow of its own operation', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ updatable: [updateLink()], holdable: [ref('so-h')], cancellable: [ref('so-c')] })
    console.log(`# ON amend/hold/cancel: ${JSON.stringify(shadows.map((s) => [s.operation, s.subjectId]))}`)
    assert.deepEqual(run.calls, [])
    assert.deepEqual(run.writes, [], 'not even the error note of a link: the same unchanged link is offered when the warehouse may be written')
    assert.equal(run.result.shadowed, 3)
    assert.equal(run.result.updated + run.result.held + run.result.cancelled + run.result.failed + run.result.deadLettered, 0)
    assert.deepEqual(shadows.map((s) => [s.operation, s.subjectId]), [['order.amend', 'so-u'], ['order.hold', 'so-h'], ['order.cancel', 'so-c']])
  })
})

test('ON: an amendment whose payload cannot be built is still a shadow and still touches no link', async () => {
  await withEnv(HELD, async () => {
    const broken = updateLink({ order: { ...candidate({ id: 'so-u', shippingAddress: {}, billingAddress: {} } as Partial<WmsPushCandidate>), shipFromWarehouseId: 'wh-1' } })
    const run = await sweep({ updatable: [broken] })
    assert.equal(run.result.shadowed, 1)
    assert.equal(run.result.failed, 0)
    assert.deepEqual(run.writes, [])
  })
  await withEnv(OFF, async () => {
    const broken = updateLink({ order: { ...candidate({ id: 'so-u', shippingAddress: {}, billingAddress: {} } as Partial<WmsPushCandidate>), shipFromWarehouseId: 'wh-1' } })
    const run = await sweep({ updatable: [broken] })
    assert.equal(run.result.failed, 1, 'CONTROL: the legacy path counts the failure and stamps the link')
    assert.equal(run.writes.length, 1)
  })
})

// ───────────────────────── 5. ON: the verify pass ─────────────────────────

test('ON: a PENDING_VERIFY link is still PROVED (a read) but is never converted: a withdrawn one is not cancelled and its link is left exactly as it is', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ verifiable: [verifyLink()], withdrawn: true }, { verdict: 'ours' })
    console.log(`# ON verify: calls=${JSON.stringify(run.calls)} writes=${JSON.stringify(run.writes)}`)
    assert.deepEqual(run.calls, ['verifyPushedOrder:wms-v'], 'the proof is a read and still happens; no cancel')
    assert.deepEqual(run.writes, [], 'the link stays PENDING_VERIFY: nothing is written, nothing becomes a shadow state')
    assert.equal(run.result.shadowed, 1)
    assert.deepEqual(shadows.map((s) => s.operation), ['order.hold'])
  })
  await withEnv(OFF, async () => {
    const run = await sweep({ verifiable: [verifyLink()], withdrawn: true }, { verdict: 'ours' })
    assert.deepEqual(run.calls, ['verifyPushedOrder:wms-v', 'cancelOrder:wms-v'], 'CONTROL: the legacy path cancels the withdrawn order')
    assert.equal(run.result.held, 1)
  })
})

test('ON: a verified link that is not withdrawn is promoted to SYNCED as before (a local write), and its courier note is a shadow', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ verifiable: [verifyLink({ courierPending: true })] }, { verdict: 'ours' })
    assert.deepEqual(run.calls, ['verifyPushedOrder:wms-v'], 'no comment was posted')
    assert.deepEqual(run.writes, ['updateLink:link-v:SYNCED'])
    assert.equal(run.result.verified, 1)
    assert.equal(run.result.shadowed, 1)
    assert.deepEqual(shadows.map((s) => s.operation), ['order.comment'])
  })
})

// ───────────────────────── 6. the live phase: the obligation time ─────────────────────────

test(`LIVE (grant and ${CUTOFF}): an order paid AFTER the instant is created; one paid BEFORE it is a shadow and is never claimed; one with no paid time is a shadow`, async () => {
  await withEnv(LIVE, async () => {
    const run = await sweep({
      createCandidates: [
        candidate({ id: 'so-after', orderNumber: 'SO-AFTER', paidAt: AFTER_CUTOFF }),
        candidate({ id: 'so-before', orderNumber: 'SO-BEFORE', paidAt: BEFORE_CUTOFF, createdAt: BEFORE_CUTOFF }),
        candidate({ id: 'so-none', orderNumber: 'SO-NONE', paidAt: null, createdAt: undefined }),
        candidate({ id: 'so-created', orderNumber: 'SO-CREATED', paidAt: null, createdAt: AFTER_CUTOFF }),
      ],
    })
    console.log(`# LIVE create: calls=${JSON.stringify(run.calls)} shadows=${JSON.stringify(shadows.map((s) => [s.subjectId, s.reason]))}`)
    assert.deepEqual(run.calls, ['pushOrder:SO-AFTER', 'pushOrder:SO-CREATED'])
    assert.deepEqual(run.writes.filter((w) => w.startsWith('claimForCreate')), ['claimForCreate:so-after', 'claimForCreate:so-created'], 'the pre-cutoff order was never claimed')
    assert.deepEqual(shadows.map((s) => [s.subjectId, s.reason]), [['so-before', 'obligation_before_cutoff'], ['so-none', 'obligation_time_required']])
    assert.equal(run.result.created, 2)
    assert.equal(run.result.shadowed, 2)
  })
})

test('LIVE: an amendment of an order paid before the instant is a shadow (the bridge owns that order); cancel and hold have no obligation time and go ahead', async () => {
  await withEnv(LIVE, async () => {
    const preCutoff = updateLink({ id: 'link-old', externalOrderId: 'wms-old', order: { ...candidate({ id: 'so-old', orderNumber: 'SO-OLD', paidAt: BEFORE_CUTOFF }), shipFromWarehouseId: 'wh-1' } })
    const postCutoff = updateLink({ id: 'link-new', externalOrderId: 'wms-new', order: { ...candidate({ id: 'so-new', orderNumber: 'SO-NEW', paidAt: AFTER_CUTOFF }), shipFromWarehouseId: 'wh-1' } })
    const run = await sweep({ updatable: [preCutoff, postCutoff], holdable: [ref('so-h')], cancellable: [ref('so-c')] })
    assert.deepEqual(run.calls, ['updateOrder:wms-new', 'cancelOrder:wms-so-h', 'cancelOrder:wms-so-c'])
    assert.deepEqual(shadows.map((s) => [s.operation, s.subjectId, s.reason]), [['order.amend', 'so-old', 'obligation_before_cutoff']])
    assert.equal(run.result.shadowed, 1)
  })
})

test('LIVE: a past-NEW cancellation posts its warehouse note (the comment is IMS-owned from the live phase); the re-open passes run', async () => {
  await withEnv(LIVE, async () => {
    const run = await sweep({ cancellable: [ref('so-c')], releasable: [heldLink()] }, { cancelStatus: 'NOT_CANCELLABLE' })
    assert.ok(run.calls.includes('cancelOrder:wms-so-c'))
    assert.ok(run.calls.includes('addOrderComment:wms-so-c'))
    assert.ok(run.reads.includes('releasableHeldOrders') && run.reads.includes('revalidatableLinks') && run.reads.includes('ambiguousCreateLinks'))
    assert.equal(shadows.length, 0)
  })
})

// ───────────────────────── 7. a connector this build does not register is not governed ─────────────────────────

test('ON: a connector id this build does not register has no ownership map: the sweep is the legacy sweep for it', async () => {
  await withEnv(HELD, async () => {
    const run = await sweep({ createCandidates: [candidate()] }, {}, 'acme-wms')
    assert.deepEqual(run.calls, ['pushOrder:SO-1'])
    assert.equal(run.result.created, 1)
    assert.equal(shadows.length, 0)
  })
})

test('PHASE CHANGES MID-SWEEP: the sweep starts held, the live-from instant passes before the create pass; an unscreened candidate with no suppression row is NOT created (deferred to the next tick)', async () => {
  await withEnv(HELD, async () => {
    const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
    const harness = makePort({ createCandidates: [candidate({ id: 'so-1' })] })
    const inner = harness.port.createCandidates
    harness.port.createCandidates = async (...args) => {
      Object.assign(process.env, { [OUTBOUND_GRANT_ENV.mintsoft]: GRANT, [PRODUCER_CUTOFF_ENV.mintsoft]: CUTOFF })
      return inner(...args)
    }
    const { connector, calls } = makeConnector()
    const result = await runWmsOrderPushSweepCore(connector, 'mintsoft', harness.port, { now: NOW })
    console.log(`# mid-sweep: calls=${JSON.stringify(calls)} writes=${JSON.stringify(harness.writes)} reads=${JSON.stringify(harness.reads)}`)
    assert.deepEqual(calls, [], 'no warehouse order was created for an unscreened candidate')
    assert.deepEqual(harness.writes, [], 'nothing claimed')
    assert.equal(result.created, 0)
    // the next tick (now live from its start) screens and creates
    const next = await runWmsOrderPushSweepCore(connector, 'mintsoft', harness.port, { now: NOW })
    assert.equal(next.created, 1)
    assert.ok(harness.reads.includes('screenLiveWithdrawals'))
  })
})

test('STARVATION: more shadowed pre-cutoff candidates than the batch size do not stop a post-cutoff candidate being created (the query leaves them out)', async () => {
  await withEnv(LIVE, async () => {
    const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
    const old = [1, 2, 3].map((n) => candidate({ id: `old-${n}`, orderNumber: `OLD-${n}`, paidAt: BEFORE_CUTOFF, createdAt: BEFORE_CUTOFF }))
    const fresh = candidate({ id: 'new-1', orderNumber: 'NEW-1' })
    const harness = makePort({})
    // A port that behaves like the real query: oldest first, bounded by the limit, and honouring the floor when it is given.
    harness.port.createCandidates = async (_connector, _bound, limit, paidNotBefore) => {
      return [...old, fresh].filter((row) => !paidNotBefore || (row.paidAt !== null && row.paidAt !== undefined && row.paidAt >= paidNotBefore)).slice(0, limit)
    }
    const { connector, calls } = makeConnector()
    const result = await runWmsOrderPushSweepCore(connector, 'mintsoft', harness.port, { now: NOW, batchSize: 2 })
    console.log(`# starvation: calls=${JSON.stringify(calls)} shadowed=${result.shadowed ?? 0}`)
    assert.deepEqual(calls, ['pushOrder:NEW-1'])
    assert.equal(result.created, 1)
  })
})
