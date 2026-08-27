import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushCandidate,
  type WmsPushVerifyLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderCancelResult, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
import type { WmsMutationEventInput } from '../lib/domain/wms/mutation-audit.ts'

/**
 * o3d-rbyg [wdraw]: the withdrawal fence used to guard ONE moment — the create claim — and only
 * for orders that already had a suppression row. These tests pin the three fulfilment decisions it
 * now covers, and the two places it deliberately does NOT fail closed.
 */

const NOW = () => new Date('2026-08-20T00:00:00.000Z')
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

function verifyLink(overrides: Partial<WmsPushVerifyLink> = {}): WmsPushVerifyLink {
  return {
    id: 'link-1',
    orderId: 'so-1',
    externalOrderId: 'wms-1',
    orderNumber: 'SO-1',
    externalReference: 'SO-1',
    verifyAttempts: 0,
    courierPending: false,
    shippingService: null,
    ...overrides,
  }
}

type Seed = {
  createCandidates?: WmsPushCandidate[]
  verifiable?: WmsPushVerifyLink[]
  /** o3d-rbyg: the batched storefront screen. `undefined` = the port does not offer one. */
  screenLiveWithdrawals?: (orderIds: string[]) => Promise<ReadonlySet<string>>
  readLiveWithdrawal?: (orderId: string) => Promise<{ withdrawn: boolean; approved: boolean } | null>
  readWithdrawalState?: (orderId: string) => Promise<{ withdrawalHoldAt: Date | null; withdrawalApprovedAt: Date | null } | null>
  /** o3d-rbyg: the DURABLE half — a local row an outage cannot change the answer of. */
  readWithdrawalTombstone?: (orderId: string) => Promise<{ standing: boolean } | null>
  verifyWithdrawalFence?: (orderId: string) => Promise<boolean>
}

function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const updatesByOrder: Array<{ orderId: string; data: Record<string, unknown> }> = []
  const events: WmsMutationEventInput[] = []
  const claims: string[] = []
  const screened: string[][] = []
  const liveReads: string[] = []
  const tombstoneReads: string[] = []

  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async () => seed.createCandidates ?? [],
    claimForCreate: async (orderId) => { claims.push(orderId); return true },
    // o3d-92fu: this suite's orders all build a valid payload, so this is never reached;
    // it throws rather than returning a value so a future seed that DOES fail to build
    // cannot silently pass through it unnoticed.
    recordValidationFailure: async () => { throw new Error('recordValidationFailure not expected in the withdrawal-fence suite') },
    verifiableLinks: async () => seed.verifiable ?? [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    upsertByOrder: async (orderId, create, update) => { upserts.push({ orderId, create, update }) },
    updateLink: async (id, data) => { updates.push({ id, data }) },
    // o3d-2k5r r2: this suite seeds no releasable or revalidatable links, so the only two
    // callers of the guarded write are unreachable here; it throws rather than recording, so a
    // future seed that DOES reach it cannot pass unnoticed with an unasserted write.
    updateLinkIfState: async () => { throw new Error('updateLinkIfState not expected in the withdrawal-fence suite') },
    updateLinkByOrder: async (orderId, data) => { updatesByOrder.push({ orderId, data }) },
    readWithdrawalState: seed.readWithdrawalState
      ?? (async () => ({ withdrawalHoldAt: null, withdrawalApprovedAt: null })),
    verifyWithdrawalFence: seed.verifyWithdrawalFence ?? (async () => true),
    recordEvent: async (event) => { events.push(event) },
  }
  if (seed.screenLiveWithdrawals) {
    port.screenLiveWithdrawals = async (orderIds) => { screened.push(orderIds); return seed.screenLiveWithdrawals!(orderIds) }
  }
  if (seed.readLiveWithdrawal) {
    port.readLiveWithdrawal = async (orderId) => { liveReads.push(orderId); return seed.readLiveWithdrawal!(orderId) }
  }
  if (seed.readWithdrawalTombstone) {
    port.readWithdrawalTombstone = async (orderId) => { tombstoneReads.push(orderId); return seed.readWithdrawalTombstone!(orderId) }
  }
  return { port, upserts, updates, updatesByOrder, events, claims, screened, liveReads, tombstoneReads }
}

const okPush = async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' })

function connector(overrides: {
  pushOrder?: () => Promise<WmsOrderPushResult>
  cancelOrder?: () => Promise<WmsOrderCancelResult>
  verifyPushedOrder?: () => Promise<'ours' | 'foreign' | 'unknown'>
} = {}) {
  return {
    verifyPushedOrder: overrides.verifyPushedOrder,
    pushOrder: overrides.pushOrder ?? okPush,
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: overrides.cancelOrder ?? (async () => ({ cancelled: true, status: 'CANCELLED' })),
    addOrderComment: undefined,
  }
}

// --- 1. the batched screen, for orders with NO withdrawal history --------------------------

test('create: an order the STOREFRONT reports withdrawn is not pushed, even with no IMS record (o3d-rbyg)', async () => {
  // The exact gap: no suppression row (so verifyWithdrawalFence passes) and no IMS marker (so
  // createCandidates and claimForCreate both let it through). Only the storefront knows.
  let pushed = 0
  const { port, claims, screened } = makePort({
    createCandidates: [candidate()],
    verifyWithdrawalFence: async () => true,
    screenLiveWithdrawals: async () => new Set(['so-1']),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ pushOrder: async () => { pushed += 1; return okPush() } }),
    'mintsoft', port, { now: NOW },
  )

  assert.equal(pushed, 0, 'the warehouse was never called')
  assert.deepEqual(claims, [], 'and the order was not even claimed')
  assert.equal(r.created, 0)
  assert.deepEqual(screened, [['so-1']], 'the screen was asked about the whole candidate batch')
})

test('create: the screen is ONE call for the whole batch, not one per order (o3d-rbyg)', async () => {
  const { port, screened, claims } = makePort({
    createCandidates: [candidate({ id: 'so-1' }), candidate({ id: 'so-2' }), candidate({ id: 'so-3' })],
    screenLiveWithdrawals: async () => new Set(['so-2']),
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })

  assert.equal(screened.length, 1, 'exactly one screening read for a three-order batch')
  assert.deepEqual(screened[0], ['so-1', 'so-2', 'so-3'])
  assert.deepEqual(claims, ['so-1', 'so-3'], 'only the withdrawn one was held back')
  assert.equal(r.created, 2)
})

test('create: a screen that THROWS leaves the batch with the fence it already had (o3d-rbyg)', async () => {
  // Deliberately not fail-closed: an unreachable storefront must not halt warehouse fulfilment
  // shop-wide. Orders that DO have a suppression row are still refused by verifyWithdrawalFence.
  const { port, claims } = makePort({
    createCandidates: [candidate({ id: 'so-1' }), candidate({ id: 'so-2' })],
    screenLiveWithdrawals: async () => { throw new Error('WC API error: 503') },
    verifyWithdrawalFence: async (orderId) => orderId !== 'so-2',
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })

  assert.deepEqual(claims, ['so-1'], 'the screen failing did not stop the un-suppressed order')
  assert.equal(r.created, 1)
})

test('create: a port with no screen at all still pushes (o3d-rbyg)', async () => {
  const { port, claims } = makePort({ createCandidates: [candidate()] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.deepEqual(claims, ['so-1'])
  assert.equal(r.created, 1)
})

// --- 2. post-create live recheck ------------------------------------------------------------

test('create: a withdrawal that lands DURING the push is pulled back on the storefront\'s word (o3d-rbyg)', async () => {
  // readWithdrawalState is clean — the webhook has not been processed yet — so before this the
  // order stayed live in the warehouse until the poll or the daily reconcile caught up.
  let cancelled = 0
  const { port, updatesByOrder, liveReads, events } = makePort({
    createCandidates: [candidate()],
    readWithdrawalState: async () => ({ withdrawalHoldAt: null, withdrawalApprovedAt: null }),
    readLiveWithdrawal: async () => ({ withdrawn: true, approved: false }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } } }),
    'mintsoft', port, { now: NOW },
  )

  assert.deepEqual(liveReads, ['so-1'], 'the storefront was read once, after the create')
  assert.equal(cancelled, 1, 'the just-created warehouse order was pulled straight back')
  assert.equal(r.held, 1, 'a SUBMITTED withdrawal parks the link HELD — an operator may still reject it')
  assert.equal(r.cancelled, 0)
  assert.equal(r.created, 0, 'and it is not counted as a create')
  assert.equal(updatesByOrder[0]?.data.state, 'HELD')
  assert.equal(events.some((e) => e.action === 'order_hold' && e.outcome === 'SUCCEEDED'), true)
})

test('create: an APPROVED live withdrawal parks the link CANCELLED, not HELD (o3d-rbyg)', async () => {
  const { port, updatesByOrder } = makePort({
    createCandidates: [candidate()],
    readLiveWithdrawal: async () => ({ withdrawn: true, approved: true }),
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })

  assert.equal(r.cancelled, 1, 'an approved withdrawal is terminal — there is nothing to release later')
  assert.equal(r.held, 0)
  assert.equal(updatesByOrder[0]?.data.state, 'CANCELLED')
})

test('create: an UNREADABLE storefront after the push does NOT cancel the new order (o3d-rbyg)', async () => {
  // The asymmetry that matters: acting on no evidence here would cancel a live warehouse order,
  // so `null` falls back to the IMS markers exactly as before.
  let cancelled = 0
  const { port, upserts } = makePort({
    createCandidates: [candidate()],
    readLiveWithdrawal: async () => null,
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } } }),
    'mintsoft', port, { now: NOW },
  )

  assert.equal(cancelled, 0, 'nothing was cancelled on an unreadable storefront')
  assert.equal(r.created, 1)
  assert.equal(upserts[0]?.update.state, 'SYNCED')
})

// --- 3. the verify pass's promotion to SYNCED ------------------------------------------------

test('verify: an order withdrawn while its ownership was being proved is NOT promoted to SYNCED (o3d-rbyg)', async () => {
  // Promotion is a fulfilment decision — the dispatch passes act on SYNCED links — and it used to
  // consult only the IMS markers.
  let cancelled = 0
  const { port, updates, liveReads } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalState: async () => ({ withdrawalHoldAt: null, withdrawalApprovedAt: null }),
    readLiveWithdrawal: async () => ({ withdrawn: true, approved: true }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({
      verifyPushedOrder: async () => 'ours',
      cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
    }),
    'mintsoft', port, { now: NOW },
  )

  assert.deepEqual(liveReads, ['so-1'])
  assert.equal(cancelled, 1)
  assert.equal(r.verified, 0, 'it was not promoted')
  assert.equal(r.cancelled, 1, 'it was cancelled at the WMS instead')
  assert.equal(updates[0]?.data.state, 'CANCELLED')
})

test('verify: a clean live read still promotes the link to SYNCED (o3d-rbyg)', async () => {
  const { port, updates } = makePort({
    verifiable: [verifyLink()],
    readLiveWithdrawal: async () => ({ withdrawn: false, approved: false }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.verified, 1)
  assert.equal(updates[0]?.data.state, 'SYNCED')
})

test('verify: an UNREADABLE storefront still promotes — it must not cancel a proved-ours order (o3d-rbyg)', async () => {
  let cancelled = 0
  const { port, updates } = makePort({
    verifiable: [verifyLink()],
    readLiveWithdrawal: async () => null,
  })
  const r = await runWmsOrderPushSweepCore(
    connector({
      verifyPushedOrder: async () => 'ours',
      cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
    }),
    'mintsoft', port, { now: NOW },
  )

  assert.equal(cancelled, 0)
  assert.equal(r.verified, 1)
  assert.equal(updates[0]?.data.state, 'SYNCED')
})

test('verify: an IMS marker alone still cancels, with no storefront read needed (o3d-rbyg)', async () => {
  // The pre-existing o3d-6x66 behaviour must survive: the live read is an ADDITIONAL trigger.
  const { port, liveReads } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalState: async () => ({ withdrawalHoldAt: new Date('2026-08-19T00:00:00.000Z'), withdrawalApprovedAt: null }),
    readLiveWithdrawal: async () => ({ withdrawn: false, approved: false }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.held, 1, 'the marker alone is still enough')
  assert.equal(r.verified, 0)
  assert.deepEqual(liveReads, [], 'and the storefront is not read when the markers already answer')
})


// --- 3b. the verify pass and the DURABLE tombstone -------------------------------------------

test('verify: a STANDING tombstone fences the promotion when the storefront cannot be read (o3d-rbyg)', async () => {
  // The outage case, which is the whole reason the tombstone is written. The live read returns null
  // and the markers are clean, so before this the link was promoted to SYNCED — and SYNCED is what
  // the dispatch passes act on.
  let cancelled = 0
  const { port, updates, tombstoneReads } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalState: async () => ({ withdrawalHoldAt: null, withdrawalApprovedAt: null }),
    readLiveWithdrawal: async () => null,
    readWithdrawalTombstone: async () => ({ standing: true }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({
      verifyPushedOrder: async () => 'ours',
      cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
    }),
    'mintsoft', port, { now: NOW },
  )

  assert.deepEqual(tombstoneReads, ['so-1'], 'the durable row was consulted')
  assert.equal(r.verified, 0, 'the link was NOT promoted to SYNCED')
  assert.equal(cancelled, 1, 'the warehouse order was pulled back')
  assert.equal(r.held, 1, 'and parked HELD — the reversible action')
  assert.equal(r.cancelled, 0, 'a tombstone says the order needs checking, never that it must be cancelled')
  assert.equal(updates[0]?.data.state, 'HELD')
})

test('verify: a standing tombstone outranks a CLEAN live read (o3d-rbyg)', async () => {
  // A tombstone is retired only after the storefront has reported the request rejected for a whole
  // quiescence window. One ad-hoc read that happens to come back clean is not that evidence — this
  // is the same refusal verifyWithdrawalFenceForPush makes for a non-retired row.
  const { port, updates } = makePort({
    verifiable: [verifyLink()],
    readLiveWithdrawal: async () => ({ withdrawn: false, approved: false }),
    readWithdrawalTombstone: async () => ({ standing: true }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.verified, 0)
  assert.equal(r.held, 1)
  assert.equal(updates[0]?.data.state, 'HELD')
})

test('verify: a RETIRED tombstone does not fence, and the link is promoted (o3d-rbyg)', async () => {
  // The bound on the rule. Retirement is reached only through the quiescence protocol, so a retired
  // row is spent — otherwise one withdrawal would fence the order forever.
  const { port, updates } = makePort({
    verifiable: [verifyLink()],
    readLiveWithdrawal: async () => ({ withdrawn: false, approved: false }),
    readWithdrawalTombstone: async () => ({ standing: false }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.verified, 1)
  assert.equal(updates[0]?.data.state, 'SYNCED')
})

test('verify: an APPROVED marker still CANCELS — the tombstone does not downgrade it to a hold (o3d-rbyg)', async () => {
  // The tombstone supplies the reversible action only when nothing better says what the customer
  // asked for. Where the markers DO say it, they decide.
  const { port, updates, tombstoneReads } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalState: async () => ({ withdrawalHoldAt: null, withdrawalApprovedAt: new Date('2026-08-19T00:00:00.000Z') }),
    readWithdrawalTombstone: async () => ({ standing: true }),
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.cancelled, 1, 'an approved withdrawal is terminal')
  assert.equal(r.held, 0)
  assert.equal(updates[0]?.data.state, 'CANCELLED')
  assert.deepEqual(tombstoneReads, [], 'and the tombstone is not read when the markers already answer')
})

test('verify: a tombstone read that THROWS does not cancel a proved-ours order (o3d-rbyg)', async () => {
  // Same asymmetry as the live read: acting on no evidence here means pulling back a warehouse order
  // we have just proved is ours. The failure is logged, and the markers remain the only trigger.
  let cancelled = 0
  const { port } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalTombstone: async () => { throw new Error('DB connection lost') },
  })
  const r = await runWmsOrderPushSweepCore(
    connector({
      verifyPushedOrder: async () => 'ours',
      cancelOrder: async () => { cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
    }),
    'mintsoft', port, { now: NOW },
  )

  assert.equal(cancelled, 0, 'nothing is pulled back on an unread row')
  assert.equal(r.cancelled, 0)
  assert.equal(r.held, 0)
})

test('verify: a tombstone read that THROWS does not PROMOTE the link either (o3d-rbyg r2)', async () => {
  // ROUND 2, Codex finding 4. The failure was swallowed and the link promoted to SYNCED anyway —
  // and SYNCED is exactly the state the dispatch sweep fulfils from, so one unreadable local row
  // moved an order into the dispatch set with its durable fence never consulted.
  //
  // Not promoting is cheap and reversible: the link stays PENDING_VERIFY, is re-read next sweep, and
  // nothing is cancelled or re-pushed in the meantime. Promoting is not: the next dispatch tick can
  // ship it, relieve the stock and email the customer.
  const { port, updates } = makePort({
    verifiable: [verifyLink()],
    readWithdrawalTombstone: async () => { throw new Error('DB connection lost') },
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.verified, 0, 'the link was NOT promoted into the dispatch set')
  assert.equal(r.verifyUnresolved, 1, 'it is counted as unresolved — the ordinary retry ladder, not a silent hold')
  assert.equal(updates[0]?.data.state, undefined, 'and it stays PENDING_VERIFY rather than being moved anywhere')
  assert.equal(updates[0]?.data.attempts, 1, 'the attempt is stamped so the batch rotates instead of re-selecting it forever')
  assert.match(
    String(updates[0]?.data.lastError),
    /withdrawal tombstone could not be read/,
    'and the reason names the unread evidence, not a generic verification failure',
  )
  assert.match(String(updates[0]?.data.lastError), /NOT promoted to SYNCED/)
})

test('verify: an unreadable tombstone ESCALATES at the attempt bound instead of retrying forever (o3d-rbyg r2)', async () => {
  // The bound on the hold. A local row that stays unreadable would otherwise leave the order doing
  // nothing, invisibly, for ever — the shape of permanent hold the quarantine exists to end. At the
  // fifth attempt it becomes an operator's problem in the exception inbox, and is never re-pushed.
  const { port, updates } = makePort({
    verifiable: [verifyLink({ verifyAttempts: 4 })],
    readWithdrawalTombstone: async () => { throw new Error('relation "wc_withdrawal_suppressions" does not exist') },
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'ours' }), 'mintsoft', port, { now: NOW },
  )

  assert.equal(r.verified, 0)
  assert.equal(r.verifyQuarantined, 1)
  assert.equal(updates[0]?.data.state, 'DEAD_LETTER')
  assert.match(String(updates[0]?.data.lastError), /NOT re-pushed/)
})
