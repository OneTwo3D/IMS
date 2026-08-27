import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AMBIGUOUS_ATTEMPTS,
  runWmsOrderPushSweepCore,
  shouldGrantCreateClaim,
  type WmsOrderPushPort,
  type WmsPushCandidate,
  type WmsPushLinkRef,
  type WmsPushUpdateLink,
  type WmsPushRevalidateLink,
  type WmsPushVerifyLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderCancelResult, WmsOrderPushInput, WmsOrderPushResult, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'
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

/**
 * o3d-2k5r r2. A revalidation candidate defaults to the columns that say NO WMS ORDER EXISTS,
 * because that is the only shape the production port's where-clause can return — a test that
 * wants the other shape has to ask for it, and then it is testing the re-queue guard.
 */
function revalidateLink(overrides: Partial<WmsPushRevalidateLink> = {}): WmsPushRevalidateLink {
  return {
    id: 'link-1',
    orderId: 'so-1',
    lastError: null,
    attempts: 0,
    pushedAt: null,
    externalOrderId: null,
    order: { ...candidate(), shipFromWarehouseId: 'wh-1' },
    ...overrides,
  }
}

type Seed = {
  bindings?: Array<{ warehouseId: string; externalWarehouseId: string }>
  releasable?: WmsPushLinkRef[]
  /**
   * o3d-2k5r r3: a FUNCTION is evaluated when the CREATE pass asks, i.e. AFTER the revalidation
   * pass has written. That ordering is the whole point — it is the only way one sweep can show a
   * re-queue turning into a second warehouse order, which is what the pre-fix rule did.
   */
  createCandidates?: WmsPushCandidate[] | (() => WmsPushCandidate[])
  updatable?: WmsPushUpdateLink[]
  holdable?: WmsPushLinkRef[]
  cancellable?: WmsPushLinkRef[]
  /** o3d-bjc.8: links created but not yet proved ours. */
  verifiable?: WmsPushVerifyLink[]
  /** o3d-5r8: false simulates "order deleted / already owned" — the push must be skipped. */
  claimForCreate?: (orderId: string) => Promise<boolean>
  /** o3d-92fu: VALIDATION_FAILED links the revalidation pass re-checks, plus the TRUE total. */
  revalidatable?: { links: WmsPushRevalidateLink[]; total: number }
  /** o3d-92fu: false simulates "order deleted / another worker owns the link" under the lock. */
  recordValidationFailure?: (orderId: string) => Promise<boolean>
  /**
   * o3d-2k5r r3: EVERY link write throws — which is what a killed worker looks like from the
   * row's point of view. The create path's own failure write is `.catch(() => {})`-swallowed, so
   * the claim written before the remote call is all that survives.
   */
  failLinkWrites?: boolean
  /**
   * o3d-2k5r r2: what an OVERLAPPING worker has left the link in by the time a state-guarded
   * write lands. Default: still the state this pass read, so the compare-and-set matches.
   */
  stateAtWrite?: (id: string) => string
}

function makePort(seed: Seed) {
  const upserts: Array<{ orderId: string; create: Record<string, unknown>; update: Record<string, unknown> }> = []
  const validationFailures: Array<{ orderId: string; connector: string; error: string; attemptedAt: Date }> = []
  const updates: Array<{ id: string; data: Record<string, unknown>; ifState?: string }> = []
  const guardMisses: Array<{ id: string; fromState: string; actual: string }> = []
  const events: WmsMutationEventInput[] = []
  const claims: string[] = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => seed.bindings ?? BINDINGS,
    releasableHeldOrders: async () => seed.releasable ?? [],
    createCandidates: async () => (typeof seed.createCandidates === 'function' ? seed.createCandidates() : seed.createCandidates ?? []),
    revalidatableLinks: async () => seed.revalidatable ?? { links: [], total: 0 },
    recordValidationFailure: async (orderId, connector, error, attemptedAt) => {
      validationFailures.push({ orderId, connector, error, attemptedAt })
      return seed.recordValidationFailure ? seed.recordValidationFailure(orderId) : true
    },
    claimForCreate: async (orderId) => {
      claims.push(orderId)
      return seed.claimForCreate ? seed.claimForCreate(orderId) : true
    },
    verifiableLinks: async () => seed.verifiable ?? [],
    updatableLinks: async () => seed.updatable ?? [],
    holdableLinks: async () => seed.holdable ?? [],
    cancellableLinks: async () => seed.cancellable ?? [],
    upsertByOrder: async (orderId, create, update) => {
      upserts.push({ orderId, create, update })
      if (seed.failLinkWrites) throw new Error('worker died before the writeback')
    },
    updateLink: async (id, data) => { updates.push({ id, data }) },
    updateLinkIfState: async (id, fromState, data) => {
      // The CAS, modelled the way the Prisma port implements it: the write applies only if the
      // link is STILL in `fromState` at the moment it lands. `stateAtWrite` is how a test says
      // "another worker moved this link in between".
      const actual = seed.stateAtWrite ? seed.stateAtWrite(id) : fromState
      if (actual !== fromState) { guardMisses.push({ id, fromState, actual }); return false }
      updates.push({ id, data, ifState: fromState })
      return true
    },
    recordEvent: async (event) => { events.push(event) },
  }
  return { port, upserts, updates, events, claims, validationFailures, guardMisses }
}

const okPush = async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' })
function connector(overrides: {
  // Takes the INPUT, so a double can answer a later presence probe from what it was actually
  // asked to create rather than from a flag the test sets by hand (o3d-2k5r r3).
  pushOrder?: (input: WmsOrderPushInput) => Promise<WmsOrderPushResult>
  updateOrder?: () => Promise<WmsOrderUpdateResult>
  cancelOrder?: () => Promise<WmsOrderCancelResult>
  comments?: Array<{ externalOrderId: string; comment: string }>
  addOrderComment?: () => Promise<void>
  verifyPushedOrder?: (
    externalOrderId: string,
    reference: { orderNumber: string | null; externalReference: string | null },
  ) => Promise<'ours' | 'foreign' | 'unknown'>
  /** o3d-2k5r r3: the connector-AUTHORITATIVE absence check. Undefined models a connector that
   *  cannot probe, which must never be read as "absent". */
  probeOrderPresence?: (orderNumber: string) => Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'>
} = {}) {
  return {
    verifyPushedOrder: overrides.verifyPushedOrder,
    probeOrderPresence: overrides.probeOrderPresence,
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

// --- o3d-5r8: claim-under-lock before the remote create ---

test('create: the order is claimed BEFORE the WMS is called', async () => {
  const order: string[] = []
  const { port, claims } = makePort({ createCandidates: [candidate()] })
  const originalClaim = port.claimForCreate
  port.claimForCreate = async (orderId, connectorId, ts) => { order.push('claim'); return originalClaim(orderId, connectorId, ts) }
  const tracked = connector({ pushOrder: async () => { order.push('push'); return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } } })
  const r = await runWmsOrderPushSweepCore(tracked, 'mintsoft', port, { now: NOW })
  assert.equal(r.created, 1)
  assert.deepEqual(claims, ['so-1'])
  assert.deepEqual(order, ['claim', 'push'])
})

test('create: a refused claim (order deleted / owned elsewhere) never reaches the WMS', async () => {
  let pushed = 0
  const tracked = connector({ pushOrder: async () => { pushed += 1; return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } } })
  const { port, upserts, events } = makePort({ createCandidates: [candidate()], claimForCreate: async () => false })
  const r = await runWmsOrderPushSweepCore(tracked, 'mintsoft', port, { now: NOW })
  assert.equal(pushed, 0)
  assert.equal(r.created, 0)
  assert.equal(r.failed, 0)
  assert.equal(r.deadLettered, 0)
  // A refused claim is not the order's fault: no link write, no attempt burned, no audit noise.
  assert.equal(upserts.length, 0)
  assert.equal(events.length, 0)
})

test('create: a claim error skips the order without calling the WMS or burning an attempt', async () => {
  let pushed = 0
  const tracked = connector({ pushOrder: async () => { pushed += 1; return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } } })
  const { port, upserts } = makePort({
    createCandidates: [candidate({ pushAttempts: 4 })],
    claimForCreate: async () => { throw new Error('db down') },
  })
  const r = await runWmsOrderPushSweepCore(tracked, 'mintsoft', port, { now: NOW })
  assert.equal(pushed, 0)
  assert.equal(r.created, 0)
  assert.equal(r.deadLettered, 0)
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

test('o3d-92fu create: a line with no SKU parks VALIDATION_FAILED — no claim, no remote call, no dead letter', async () => {
  // This test used to assert the order was DEAD_LETTERED. That was the bug: buildPushInput ran
  // after the claim, so a purely LOCAL failure left a PENDING_CREATE claim that aged into
  // DEAD_LETTER — and the delete guard blocks on every link, so the order became permanently
  // undeletable for an error that never touched the WMS.
  let pushed = 0
  const { port, upserts, claims, events, validationFailures } = makePort({
    createCandidates: [candidate({ lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] })],
  })
  const r = await runWmsOrderPushSweepCore(
    connector({ pushOrder: async () => { pushed += 1; return okPush() } }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.validationFailed, 1)
  assert.equal(r.deadLettered, 0)
  // NOT counted as a push failure: `failed` means "we talked to the WMS and it did not work",
  // and reporting one that never happened sends an operator to the connector.
  assert.equal(r.failed, 0)
  assert.equal(pushed, 0, 'the connector must never be called for a payload that could not be built')
  assert.deepEqual(claims, [], 'no claim may be taken before the payload is known to build')
  assert.equal(validationFailures.length, 1)
  assert.equal(validationFailures[0].orderId, 'so-1')
  assert.match(validationFailures[0].error, /no SKU/i)
  // The disposition goes through the LOCK-GUARDED write, never the plain upsert: the candidate
  // list was read earlier, so an unconditional write could stamp this over a link another worker
  // has already pushed and SYNCED.
  assert.deepEqual(upserts, [])
  const audited = events.filter((e) => e.action === 'order_validate')
  assert.equal(audited.length, 1)
  assert.equal(audited[0].outcome, 'FAILED')
  assert.deepEqual((audited[0].after as { remoteCallMade: boolean }).remoteCallMade, false)
})

test('o3d-92fu create: a disposition REFUSED under the lock is skipped, not audited', async () => {
  // recordValidationFailure returns false when the order was deleted or the link has moved on
  // (another worker claimed and pushed it between the candidate read and here). Recording an
  // outcome for an order this pass no longer owns would be a fabricated timeline entry.
  const { port, events, upserts } = makePort({
    createCandidates: [candidate({ lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] })],
    recordValidationFailure: async () => false,
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.validationFailed, 0)
  assert.equal(r.failed, 0)
  assert.equal(r.deadLettered, 0)
  assert.deepEqual(upserts, [])
  assert.deepEqual(events.filter((e) => e.action === 'order_validate'), [])
})

test('o3d-92fu create: a validation failure spends NO push attempt and never dead-letters', async () => {
  // `attempts` is the delete guard's evidence: 0 means "provably never reached the WMS", and
  // anything above it means earlier calls happened and may have partially succeeded. Counting this
  // failure against the retry ladder would forge remote history — and at 4 attempts it dead-letters
  // the order on this very sweep, which is exactly what the old shared catch did.
  //
  // The value itself is preserved by the lock-guarded write (which re-reads it under the lock
  // rather than trusting the candidate snapshot), so what is pinned here is that the SWEEP writes
  // no attempt bookkeeping of its own on this path.
  const { port, upserts, validationFailures } = makePort({
    createCandidates: [candidate({ pushAttempts: 4, lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] })],
  })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.validationFailed, 1)
  assert.equal(r.deadLettered, 0)
  assert.equal(r.failed, 0)
  assert.equal(validationFailures.length, 1)
  assert.deepEqual(upserts, [], 'no attempts/state bookkeeping may be written outside the lock')
})

test('o3d-92fu create: a whole batch of malformed orders does NOT starve the valid one behind them', async () => {
  // The regression test for the fix that was TRIED AND REVERTED (e5b57e1a). Persisting nothing
  // for a local validation failure made the order deletable again but left it eligible forever:
  // createCandidates selects `no link OR PENDING_CREATE` ordered by updatedAt ASC, take
  // batchSize — so batchSize malformed orders are re-selected every sweep and no later VALID
  // order is ever pushed to the warehouse.
  //
  // The port below applies that REAL selection rule against a tiny in-memory catalogue, so the
  // starvation can actually arise rather than being assumed away by a fixed candidate list.
  const BATCH = 3
  const links = new Map<string, { state: string; attempts: number }>()
  const orders = [
    ...Array.from({ length: BATCH }, (_, i) => candidate({
      id: `bad-${i}`, orderNumber: `SO-BAD-${i}`,
      lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }],
    })),
    candidate({ id: 'good-1', orderNumber: 'SO-GOOD' }),
  ]
  const pushedOrders: string[] = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async (_c, _w, limit) => orders
      .filter((o) => { const link = links.get(o.id); return !link || link.state === 'PENDING_CREATE' })
      .slice(0, limit)
      .map((o) => ({ ...o, pushAttempts: links.get(o.id)?.attempts ?? 0 })),
    // Deliberately absent: this test is about the CREATE queue, and a revalidation pass that
    // re-queued the bad orders would mask the very starvation being pinned.
    claimForCreate: async () => true,
    // Models the production write: refuses unless the link is still absent or PENDING_CREATE.
    recordValidationFailure: async (orderId) => {
      const existing = links.get(orderId)
      if (existing && existing.state !== 'PENDING_CREATE') return false
      links.set(orderId, { state: 'VALIDATION_FAILED', attempts: existing?.attempts ?? 0 })
      return true
    },
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    upsertByOrder: async (orderId, _create, update) => {
      const existing = links.get(orderId) ?? { state: 'PENDING_CREATE', attempts: 0 }
      links.set(orderId, {
        state: (update.state as string) ?? existing.state,
        attempts: (update.attempts as number) ?? existing.attempts,
      })
    },
    updateLink: async () => {},
    updateLinkIfState: async () => true,
    recordEvent: async () => {},
  }
  const conn = connector({ pushOrder: async () => { pushedOrders.push('push'); return okPush() } })

  const first = await runWmsOrderPushSweepCore(conn, 'mintsoft', port, { batchSize: BATCH, now: NOW })
  assert.equal(first.validationFailed, BATCH)
  assert.equal(first.created, 0, 'the valid order is behind the batch boundary on the first sweep')

  const second = await runWmsOrderPushSweepCore(conn, 'mintsoft', port, { batchSize: BATCH, now: NOW })
  assert.equal(second.created, 1, 'the valid order must be reachable once the malformed ones leave the queue')
  assert.equal(second.validationFailed, 0)
  assert.equal(links.get('good-1')?.state, 'SYNCED')
})

test('o3d-92fu revalidate: a link whose payload builds again is re-queued for create, attempts intact', async () => {
  // o3d-2k5r r3: attempts 2 makes this an AMBIGUOUS claim, so the re-queue now rests on the
  // warehouse's own word rather than on IMS's. MISSING is the only answer that grants it.
  const link = revalidateLink({ lastError: 'Sales order has a line with no SKU; cannot push to WMS', attempts: 2 })
  const { port, updates, events } = makePort({ revalidatable: { links: [link], total: 1 } })
  const r = await runWmsOrderPushSweepCore(
    connector({ probeOrderPresence: async () => 'MISSING' }), 'mintsoft', port, { now: NOW },
  )
  assert.equal(r.revalidated, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].id, 'link-1')
  assert.equal(updates[0].data.state, 'PENDING_CREATE')
  assert.equal(updates[0].data.lastError, null)
  // o3d-2k5r r2. The lease clear is STILL intended — without it the rotation stamp written a
  // moment ago makes claimForCreate refuse the re-queued order for a full five minutes — but it
  // is only safe because the write is a COMPARE-AND-SET on VALIDATION_FAILED. That predicate is
  // the load-bearing half of this assertion, not an implementation detail: it is what proves
  // the column being cleared is this pass's own rotation stamp and never another worker's LIVE
  // create lease (a claim can only be granted from PENDING_CREATE, so no claim can exist while
  // the CAS matches). Assert the two together, or the next reader deletes the guard and keeps
  // the wipe.
  assert.equal(updates[0].ifState, 'VALIDATION_FAILED', 'the promote must be state-guarded')
  assert.equal(updates[0].data.lastAttemptAt, null)
  // attempts is NOT reset: remote attempts already spent still count against MAX_ATTEMPTS, or a
  // broken order could ride the retry ladder forever by failing validation in between.
  assert.equal(updates[0].data.attempts, undefined)
  const audited = events.filter((e) => e.action === 'order_validate')
  assert.equal(audited.length, 1)
  assert.equal(audited[0].outcome, 'SUCCEEDED')
  // The audit must say WHICH licence the promote rested on. An auditor should never have to
  // infer "we asked the warehouse" from the absence of anything saying we did not.
  assert.equal((audited[0].after as Record<string, unknown>).warehouseAbsenceProved, true)
})

test('o3d-2k5r r3 revalidate: a disposition that PROVES no call was dispatched is re-queued with no probe at all', async () => {
  // The bottom rung, and the only shape re-queued on IMS's own authority: attempts 0, minted by
  // recordValidationFailure's create branch from an ABSENT link. It must not cost a remote call —
  // this pass runs every sweep, and the whole design rests on it being local.
  const probes: string[] = []
  const link = revalidateLink({ lastError: 'Sales order has a line with no SKU; cannot push to WMS', attempts: 0 })
  const { port, updates, events } = makePort({ revalidatable: { links: [link], total: 1 } })
  const r = await runWmsOrderPushSweepCore(
    connector({ probeOrderPresence: async (n) => { probes.push(n); return 'MISSING' } }), 'mintsoft', port, { now: NOW },
  )
  assert.equal(r.revalidated, 1)
  assert.equal(r.revalidateAmbiguous, 0)
  assert.deepEqual(probes, [], 'a provably pre-call disposition costs no WMS request')
  assert.equal(updates[0].data.state, 'PENDING_CREATE')
  const audited = events.filter((e) => e.action === 'order_validate')
  assert.equal((audited[0].after as Record<string, unknown>).warehouseAbsenceProved, false)
})

test('o3d-92fu revalidate: still-failing for the SAME reason re-stamps the rotation and audits NOTHING', async () => {
  // The issue is explicit that the disposition must be recorded ONCE. The old behaviour audited
  // FAILED and incremented `failed` on every single sweep for the same unpushable order.
  const message = 'Sales order has a line with no SKU; cannot push to WMS'
  const link = revalidateLink({
    lastError: message,
    order: { ...candidate({ lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] }), shipFromWarehouseId: 'wh-1' },
  })
  const { port, updates, events } = makePort({ revalidatable: { links: [link], total: 1 } })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.revalidated, 0)
  assert.equal(r.validationFailed, 0)
  assert.equal(r.failed, 0)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.state, undefined, 'it stays VALIDATION_FAILED')
  assert.deepEqual(updates[0].data.lastAttemptAt, NOW(), 'restamped so the rotation moves on')
  assert.deepEqual(events.filter((e) => e.action === 'order_validate'), [])
})

test('o3d-92fu revalidate: a CHANGED reason is audited, because it is new information', async () => {
  const link = revalidateLink({
    lastError: 'some older reason',
    order: { ...candidate({ lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] }), shipFromWarehouseId: 'wh-1' },
  })
  const { port, events } = makePort({ revalidatable: { links: [link], total: 1 } })
  await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  const audited = events.filter((e) => e.action === 'order_validate')
  assert.equal(audited.length, 1)
  assert.equal(audited[0].outcome, 'FAILED')
  assert.match(String(audited[0].error), /no SKU/i)
})

test('o3d-92fu revalidate: the bounded pass SAYS what it did not get to', async () => {
  // A bounded sweep that reports only what it processed reads as "covered everything".
  const link = revalidateLink()
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const { port } = makePort({ revalidatable: { links: [link], total: 40 } })
    await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { batchSize: 1, now: NOW })
  } finally {
    console.warn = originalWarn
  }
  const notice = warnings.find((line) => line.includes('VALIDATION_FAILED'))
  assert.ok(notice, 'the overflow must be logged')
  assert.match(notice!, /40 orders are parked/)
  assert.match(notice!, /remaining 39/)
  assert.match(notice!, /NOT dropped/)
})

test('o3d-2k5r r2 revalidate: a link that LEFT VALIDATION_FAILED before the write is not re-queued', async () => {
  // The hazard this closes. Two sweeps read the same VALIDATION_FAILED link. A promotes it,
  // claims it under the order row lock and is inside pushOrder; B then reaches this write. The
  // old bare `update({ where: { id } })` had no predicate, so B stamped PENDING_CREATE back over
  // A's claim AND nulled A's live lease — and B's own claim check hits
  // `if (!existing.lastAttemptAt) return true`, so B pushed the same order again. Two warehouse
  // orders, goods shipped twice.
  // attempts 0 deliberately: this test is about the COMPARE-AND-SET on the promote, and at
  // attempts > 0 the ambiguity gate (o3d-2k5r r3) refuses before the write is ever attempted, so
  // the CAS would never be exercised and the test would pass for the wrong reason.
  const link = revalidateLink({ lastError: 'Sales order has a line with no SKU; cannot push to WMS', attempts: 0 })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let r
  let guardMisses
  try {
    const port = makePort({
      revalidatable: { links: [link], total: 1 },
      // Worker A got there first: by the time this write lands the link is A's live claim.
      stateAtWrite: () => 'PENDING_CREATE',
    })
    guardMisses = port.guardMisses
    r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port.port, { now: NOW })
    assert.deepEqual(port.updates, [], 'nothing may be written over the other worker')
    assert.deepEqual(port.events.filter((e) => e.action === 'order_validate'), [], 'and nothing audited')
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 0, 'a write that did not apply is not a revalidation')
  assert.deepEqual(guardMisses, [{ id: 'link-1', fromState: 'VALIDATION_FAILED', actual: 'PENDING_CREATE' }])
  assert.ok(warnings.some((w) => w.includes('left VALIDATION_FAILED')), 'and the operator is told')
})

test('o3d-2k5r r2 revalidate: the RE-STAMP is state-guarded too, and a lost race audits nothing', async () => {
  // The same read-then-write window on the still-failing branch. Unguarded, this moved the
  // winning worker's lease clock forward and stamped a stale lastError onto a link that had
  // left this pass's jurisdiction.
  const link = revalidateLink({
    lastError: 'some older reason',
    order: { ...candidate({ lines: [{ sku: null, qty: 1, taxForeign: 0, totalForeign: 10, description: 'x' }] }), shipFromWarehouseId: 'wh-1' },
  })
  const { port, updates, events } = makePort({
    revalidatable: { links: [link], total: 1 },
    stateAtWrite: () => 'PENDING_CREATE',
  })
  await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.deepEqual(updates, [])
  // The reason CHANGED, so the un-guarded version would have audited FAILED here.
  assert.deepEqual(events.filter((e) => e.action === 'order_validate'), [])
})

test('o3d-2k5r r2 revalidate: a link carrying a WMS ORDER ID is NOT re-queued — the re-queue reads the delete guard\'s rule', async () => {
  // The MEDIUM. `revalidatableLinks` filtered on state and order eligibility only, so a link the
  // hard-delete guard REFUSES to let go of ("a call may have been dispatched") was promoted
  // straight back into createCandidates — which selects on state alone — and re-pushed with no
  // verification. The comment on the guard says such a link can carry a REAL external id, so
  // that re-push mints a second warehouse order and overwrites the first id.
  const link = revalidateLink({ attempts: 1, externalOrderId: 'wms-77' })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let r
  try {
    const { port, updates, events } = makePort({ revalidatable: { links: [link], total: 1 } })
    r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
    assert.deepEqual(updates, [], 'not promoted, and not re-stamped either')
    assert.deepEqual(events.filter((e) => e.action === 'order_validate'), [])
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 0)
  const notice = warnings.find((w) => w.includes('NOT re-queued'))
  assert.ok(notice, 'an unpromotable parked link must be surfaced, not silently skipped')
  assert.match(notice!, /wms-77/)
})

test('o3d-2k5r r2 revalidate: a PUSH STAMP with no id blocks the re-queue as well', async () => {
  // The other half of the same rule. A released HELD link keeps its pushedAt, and can then be
  // converted to VALIDATION_FAILED — so this shape is reachable, unlike the attempts-0 variant
  // the old predicate comment claimed to catch.
  const link = revalidateLink({ attempts: 1, pushedAt: new Date('2026-06-01T00:00:00.000Z') })
  const originalWarn = console.warn
  console.warn = () => {}
  let r
  try {
    const { port, updates } = makePort({ revalidatable: { links: [link], total: 1 } })
    r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
    assert.deepEqual(updates, [])
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 0)
})

/**
 * o3d-2k5r r3 — a WMS that REMEMBERS what it was asked to create.
 *
 * The point of the double: "would this re-queue put a second order in the warehouse?" is then
 * answered BY THE WAREHOUSE, from what it was actually told, rather than asserted by the test. A
 * double whose presence probe returned a value the test hard-coded would agree with whichever rule
 * it was pointed at, and could not falsify either.
 */
function fakeWarehouse() {
  const created: string[] = []
  return {
    created,
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => {
      created.push(input.orderNumber)
      return { externalOrderId: `wms-${created.length}`, externalOrderNumber: `WN-${created.length}`, status: 'NEW' }
    },
    probeOrderPresence: async (orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> =>
      (created.includes(orderNumber) ? 'FOUND' : 'MISSING'),
  }
}

test('o3d-2k5r r3 revalidate: a create that LANDED before the worker died is NOT re-queued — the second create is a second warehouse order', async () => {
  // THE SCENARIO, end to end, and the one the r2 rule got wrong.
  //
  // Sweep 1 — the create reaches the WMS and the worker dies before ANY writeback. Modelled by a
  // port whose link writes all throw, because that is what a killed process looks like from the
  // row's point of view: the create path's own failure write is `.catch(() => {})`-swallowed, so
  // the only thing left on the link is the claim claimForCreate wrote BEFORE the remote call —
  // PENDING_CREATE at attempts 0.
  const wms = fakeWarehouse()
  const conn = connector({ pushOrder: wms.pushOrder, probeOrderPresence: wms.probeOrderPresence })
  const dying = makePort({ createCandidates: [candidate()], failLinkWrites: true })
  const first = await runWmsOrderPushSweepCore(conn, 'mintsoft', dying.port, { now: NOW })
  assert.equal(wms.created.length, 1, 'the create DID reach the warehouse')
  assert.equal(first.created, 0, 'and IMS recorded nothing about it')

  // The lease then expires and the order stops building a payload (someone clears a SKU), so
  // recordValidationFailure CONVERTS the expired claim: attempts raised to AMBIGUOUS_ATTEMPTS,
  // externalOrderId and pushedAt still null. That the real port writes exactly this shape is
  // proved in tests/wms-order-push-validation-disposition-port.test.ts.
  const converted = revalidateLink({
    attempts: AMBIGUOUS_ATTEMPTS,
    lastError: 'Sales order has a line with no SKU; cannot push to WMS',
  })

  // Sweep 2 — the data is fixed, so the payload builds again. `createCandidates` selects on STATE
  // alone, exactly as the production query does, so a promote is picked up by the create pass on
  // this same tick. Under the r2 rule that is precisely what happened.
  let second: ReturnType<typeof makePort>
  // eslint-disable-next-line prefer-const
  second = makePort({
    revalidatable: { links: [converted], total: 1 },
    createCandidates: () => (second.updates.some((u) => u.data.state === 'PENDING_CREATE') ? [candidate()] : []),
  })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let r
  try {
    r = await runWmsOrderPushSweepCore(conn, 'mintsoft', second.port, { now: NOW })
  } finally {
    console.warn = originalWarn
  }

  // THE ASSERTION THAT MATTERS: the warehouse was not told to fulfil the same sale twice.
  assert.equal(wms.created.length, 1)
  assert.equal(r.created, 0)
  assert.equal(r.revalidated, 0)
  assert.equal(r.revalidateAmbiguous, 1)
  // Not silently dropped either: the rotation stamp moves so it does not wedge the head of the
  // batch, and the reason is persisted where the sync-exceptions inbox reads it.
  assert.equal(second.updates.length, 1)
  assert.equal(second.updates[0].ifState, 'VALIDATION_FAILED')
  assert.equal(second.updates[0].data.state, undefined, 'it stays VALIDATION_FAILED')
  assert.deepEqual(second.updates[0].data.lastAttemptAt, NOW())
  assert.match(String(second.updates[0].data.lastError), /may already have been dispatched/i)
  assert.match(String(second.updates[0].data.lastError), /ALREADY holds an order/i)
  const audited = second.events.filter((e) => e.action === 'order_validate')
  assert.equal(audited.length, 1)
  assert.equal(audited[0].outcome, 'FAILED')
  assert.equal((audited[0].after as Record<string, unknown>).remoteOutcomeAmbiguous, true)
  assert.ok(warnings.some((w) => w.includes('NOT re-queued')), 'and the operator is told')
})

test('o3d-2k5r r3 revalidate: the same ambiguous link IS re-queued once the warehouse says the order never arrived', async () => {
  // The guard has to be able to LET GO, or the previous test passes for a rule that simply never
  // re-queues anything. Identical link, identical connector — the only difference is that this
  // warehouse was never told to create it, so its own probe answers MISSING.
  const wms = fakeWarehouse()
  const conn = connector({ pushOrder: wms.pushOrder, probeOrderPresence: wms.probeOrderPresence })
  const converted = revalidateLink({ attempts: AMBIGUOUS_ATTEMPTS, lastError: 'Sales order has a line with no SKU; cannot push to WMS' })
  let harness: ReturnType<typeof makePort>
  // eslint-disable-next-line prefer-const
  harness = makePort({
    revalidatable: { links: [converted], total: 1 },
    createCandidates: () => (harness.updates.some((u) => u.data.state === 'PENDING_CREATE') ? [candidate()] : []),
  })
  const r = await runWmsOrderPushSweepCore(conn, 'mintsoft', harness.port, { now: NOW })
  assert.equal(r.revalidated, 1)
  assert.equal(r.revalidateAmbiguous, 0)
  assert.equal(r.created, 1)
  assert.deepEqual(wms.created, ['SO-1'], 'and the order the warehouse never had is now there, once')
  assert.equal(harness.updates[0].data.state, 'PENDING_CREATE')
})

test('o3d-2k5r r3 revalidate: a connector that CANNOT prove absence never gets the benefit of the doubt', async () => {
  // No probe is not "no order". A connector without probeOrderPresence must leave the link parked
  // for a human, not fall back to the r2 behaviour of promoting on spent attempts alone.
  const wms = fakeWarehouse()
  const converted = revalidateLink({ attempts: AMBIGUOUS_ATTEMPTS })
  let harness: ReturnType<typeof makePort>
  // eslint-disable-next-line prefer-const
  harness = makePort({
    revalidatable: { links: [converted], total: 1 },
    createCandidates: () => (harness.updates.some((u) => u.data.state === 'PENDING_CREATE') ? [candidate()] : []),
  })
  const originalWarn = console.warn
  console.warn = () => {}
  let r
  try {
    r = await runWmsOrderPushSweepCore(connector({ pushOrder: wms.pushOrder }), 'mintsoft', harness.port, { now: NOW })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 0)
  assert.equal(r.revalidateAmbiguous, 1)
  assert.deepEqual(wms.created, [])
  assert.match(String(harness.updates[0].data.lastError), /cannot check whether such an order exists/i)
})

test('o3d-2k5r r3 revalidate: a THROWN presence probe is not absence either, and does not fail the sweep', async () => {
  const converted = revalidateLink({ attempts: AMBIGUOUS_ATTEMPTS })
  const { port, updates } = makePort({ revalidatable: { links: [converted], total: 1 } })
  const originalWarn = console.warn
  console.warn = () => {}
  let r
  try {
    r = await runWmsOrderPushSweepCore(
      connector({ probeOrderPresence: async () => { throw new Error('WMS unreachable') } }),
      'mintsoft', port, { now: NOW },
    )
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 0)
  assert.equal(r.revalidateAmbiguous, 1)
  assert.equal(r.failed, 0, 'nothing was sent, so this is not a push failure')
  assert.match(String(updates[0].data.lastError), /presence check failed/i)
})

test('o3d-2k5r r3 revalidate: the probe budget DELAYS a decision, it never makes one', async () => {
  // The pass is otherwise local, so the probe is bounded per sweep. Over budget must park the
  // link with a reason that says "later", not re-queue it and not close it out.
  const wms = fakeWarehouse()
  const conn = connector({ pushOrder: wms.pushOrder, probeOrderPresence: wms.probeOrderPresence })
  const links = Array.from({ length: 6 }, (_, i) => revalidateLink({
    id: `link-${i}`,
    orderId: `so-${i}`,
    attempts: AMBIGUOUS_ATTEMPTS,
    order: { ...candidate({ id: `so-${i}`, orderNumber: `SO-${i}` }), shipFromWarehouseId: 'wh-1' },
  }))
  const { port, updates } = makePort({ revalidatable: { links, total: 6 } })
  const originalWarn = console.warn
  console.warn = () => {}
  let r
  try {
    r = await runWmsOrderPushSweepCore(conn, 'mintsoft', port, { batchSize: 6, now: NOW })
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.revalidated, 5, 'five probes were affordable')
  assert.equal(r.revalidateAmbiguous, 1, 'and the sixth waits rather than being decided without one')
  const parked = updates.find((u) => u.data.state === undefined)
  assert.match(String(parked!.data.lastError), /budget \(5\) is spent/)
  assert.match(String(parked!.data.lastError), /re-checked on a later sweep/)
})

test('o3d-2k5r r2 release: the HELD reset is state-guarded — a link that moved on keeps its new id', async () => {
  // The THIRD write in this sweep that re-opens a create, and the same hazard: this one nulls
  // externalOrderId. A releases the link, claims it and pushes it to SYNCED under a FRESH WMS
  // id; B's unguarded release then stamped PENDING_CREATE back over that and DISCARDED the new
  // id, so the next sweep created a second warehouse order and IMS no longer held a reference
  // to the first.
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let r
  try {
    const { port, updates, events } = makePort({
      releasable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-old' }],
      stateAtWrite: () => 'SYNCED',
    })
    r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
    assert.deepEqual(updates, [])
    assert.deepEqual(events.filter((e) => e.action === 'order_release'), [])
  } finally {
    console.warn = originalWarn
  }
  assert.equal(r.released, 0)
  assert.ok(warnings.some((w) => w.includes('left HELD')))
})

test('o3d-2k5r r2 release: the winning worker DOES release, guarded on HELD', async () => {
  // The negative above is only worth anything if the guarded write applies in the normal case.
  const { port, updates } = makePort({ releasable: [{ id: 'link-1', orderId: 'o1', externalOrderId: 'wms-old' }] })
  const r = await runWmsOrderPushSweepCore(connector(), 'mintsoft', port, { now: NOW })
  assert.equal(r.released, 1)
  assert.equal(updates[0].ifState, 'HELD')
  assert.equal(updates[0].data.externalOrderId, null)
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
  // o3d-2k5r r2: the release write is the STATE-GUARDED one now, so that is the write to break.
  port.updateLinkIfState = async () => { throw new Error('db down') }
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

// --- o3d-38gl: PENDING_CREATE is a lease, not merely a state ------------------

test('claim: a link that has never been pushed is claimable (o3d-38gl)', () => {
  assert.equal(shouldGrantCreateClaim(null, new Date('2026-07-20T12:00:00Z')), true)
})

test('claim: a FRESH PENDING_CREATE is refused — another worker holds it (o3d-38gl)', () => {
  // The defect: worker A wrote PENDING_CREATE and committed; worker B then acquired the order
  // lock, saw PENDING_CREATE, passed the check and also called pushOrder. Worst on ShipHero,
  // where preflight and create are separate and partner_order_id is not unique — two winners
  // can create and then fulfil DUPLICATE warehouse orders.
  const held = { state: 'PENDING_CREATE', lastAttemptAt: new Date('2026-07-20T12:00:00Z') }
  assert.equal(
    shouldGrantCreateClaim(held, new Date('2026-07-20T12:00:30Z')),
    false,
    '30 seconds later the first worker is still talking to the WMS',
  )
})

test('claim: an EXPIRED PENDING_CREATE is reclaimable — a crashed worker must not strand it (o3d-38gl)', () => {
  const stale = { state: 'PENDING_CREATE', lastAttemptAt: new Date('2026-07-20T12:00:00Z') }
  assert.equal(shouldGrantCreateClaim(stale, new Date('2026-07-20T12:06:00Z')), true)
})

test('claim: the lease boundary is inclusive, so a claim cannot wedge forever (o3d-38gl)', () => {
  const at = new Date('2026-07-20T12:00:00Z')
  const link = { state: 'PENDING_CREATE', lastAttemptAt: at }
  assert.equal(shouldGrantCreateClaim(link, new Date(at.getTime() + 1000), 1000), true)
})

test('claim: a link in any OTHER state is never claimable by the create pass (o3d-38gl)', () => {
  for (const state of ['SYNCED', 'CANCELLED', 'DEAD_LETTER', 'HELD', 'PENDING_CANCEL']) {
    assert.equal(
      shouldGrantCreateClaim({ state, lastAttemptAt: null }, new Date()),
      false,
      `${state} belongs to another pass`,
    )
  }
})

test('claim: a PENDING_CREATE with no attempt stamp is claimable (o3d-38gl)', () => {
  // A link written by a path that did not stamp it must not be permanently unclaimable.
  assert.equal(shouldGrantCreateClaim({ state: 'PENDING_CREATE', lastAttemptAt: null }, new Date()), true)
})

// --- o3d-bjc.8: created but not yet proved ours -----------------------------

const VERIFY_LINK: WmsPushVerifyLink = {
  id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-1',
  orderNumber: 'SO-1', externalReference: 'so-1', verifyAttempts: 0,
  courierPending: false, shippingService: null,
}

test('[o3d-bjc.8] a minted-but-unverified id lands PENDING_VERIFY, not SYNCED', async () => {
  const { port, upserts } = makePort({ createCandidates: [candidate()] })
  const r = await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', needsVerification: true }),
      verifyPushedOrder: async () => 'unknown',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.created, 1)
  assert.equal(upserts[0].create.state, 'PENDING_VERIFY')
  assert.equal(upserts[0].create.externalOrderId, 'wms-1', 'the minted id is KEPT — the order exists')
})

test('[o3d-bjc.8] a connector that cannot verify still gets the old behaviour', async () => {
  // Otherwise enabling the state machine would park every order a
  // non-verifying connector creates, forever.
  const { port, upserts } = makePort({ createCandidates: [candidate()] })
  await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', needsVerification: true }),
      verifyPushedOrder: undefined,
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(upserts[0].create.state, 'SYNCED')
})

test('[o3d-bjc.8] verification promotes to SYNCED and never re-pushes', async () => {
  const pushes: number[] = []
  const { port, updates } = makePort({ verifiable: [VERIFY_LINK] })
  const r = await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => { pushes.push(1); return { externalOrderId: 'wms-2', externalOrderNumber: 'WN-2', status: 'NEW' } },
      verifyPushedOrder: async () => 'ours',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.verified, 1)
  assert.deepEqual(updates, [{ id: 'link-1', data: { state: 'SYNCED', lastError: null } }])
  assert.deepEqual(pushes, [], 'the order already exists in the warehouse — a second create ships two parcels')
})

test('[o3d-bjc.8] an UNKNOWN verdict leaves it PENDING_VERIFY, untouched', async () => {
  const { port, updates } = makePort({ verifiable: [VERIFY_LINK] })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => 'unknown' }), 'mintsoft', port, { now: NOW },
  )
  assert.equal(r.verified, 0)
  assert.equal(r.verifyQuarantined, 0)
  assert.equal(r.verifyUnresolved, 1, 'an unknown is counted, never silent')
  assert.equal(updates[0].data.state, undefined, 'the STATE is untouched — guessing duplicates or orphans')
  assert.equal(updates[0].data.attempts, 1, 'but the attempt is stamped, so the batch rotates')
})

test('[o3d-bjc.8] a verification that THROWS is also just unknown', async () => {
  const { port, updates } = makePort({ verifiable: [VERIFY_LINK] })
  const r = await runWmsOrderPushSweepCore(
    connector({ verifyPushedOrder: async () => { throw new Error('Mintsoft timeout') } }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.verified, 0)
  assert.equal(r.verifyUnresolved, 1)
  assert.equal(updates[0].data.state, undefined)
  assert.match(String(updates[0].data.lastError), /timeout/)
})

test('[o3d-bjc.8] a FOREIGN id is quarantined, and still never re-pushed', async () => {
  const pushes: number[] = []
  const { port, updates, events } = makePort({ verifiable: [VERIFY_LINK] })
  const r = await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => { pushes.push(1); return { externalOrderId: 'wms-2', externalOrderNumber: 'WN-2', status: 'NEW' } },
      verifyPushedOrder: async () => 'foreign',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.verifyQuarantined, 1)
  assert.equal(updates[0].data.state, 'DEAD_LETTER')
  assert.match(String(updates[0].data.lastError), /another tenant/)
  assert.deepEqual(pushes, [], 'our create DID happen — a second one would ship the customer two parcels')
  assert.ok(events.some((e) => e.outcome === 'FAILED' && /another tenant/.test(e.summary ?? '')),
    'and it reaches the operator rather than being retried silently')
})

test('[o3d-bjc.8] verification is given OUR identifiers, never the create response\'s', async () => {
  // A create that answered with some OTHER order of ours would verify perfectly
  // against itself — same tenant, same id — and the link would go SYNCED
  // pointing at another customer's order while ours stayed orphaned.
  const seen: Array<{ id: string; reference: unknown }> = []
  const { port } = makePort({ verifiable: [VERIFY_LINK] })
  await runWmsOrderPushSweepCore(
    connector({
      verifyPushedOrder: async (externalOrderId, reference) => {
        seen.push({ id: externalOrderId, reference })
        return 'ours'
      },
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.deepEqual(seen, [{ id: 'wms-1', reference: { orderNumber: 'SO-1', externalReference: 'so-1' } }])
})

test('[o3d-bjc.8] an unknown that never resolves is escalated, not retried forever', async () => {
  const pushes: number[] = []
  const { port, updates, events } = makePort({
    verifiable: [{ ...VERIFY_LINK, verifyAttempts: 4 }],   // one short of the bound
  })
  const r = await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => { pushes.push(1); return { externalOrderId: 'wms-2', externalOrderNumber: 'WN-2', status: 'NEW' } },
      verifyPushedOrder: async () => 'unknown',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(r.verifyQuarantined, 1)
  assert.equal(updates[0].data.state, 'DEAD_LETTER')
  assert.match(String(updates[0].data.lastError), /could not be verified after 5 attempts/)
  assert.deepEqual(pushes, [], 'an order nobody can resolve is an operator decision, not a second create')
  assert.ok(events.some((e) => e.outcome === 'FAILED'))
})

test('[o3d-bjc.8] the courier-fallback note waits until the id is proven ours', async () => {
  // The comment guard proves the row is under our tenant, not that it is OUR
  // order — so a same-client wrong id would get a misleading IMS note about a
  // shipping method that has nothing to do with it.
  type Note = { externalOrderId: string; comment: string }
  const beforeVerify: Note[] = []
  const { port } = makePort({ createCandidates: [candidate({ shippingService: 'Royal Mail' })] })
  await runWmsOrderPushSweepCore(
    connector({
      comments: beforeVerify,
      pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', courierFallback: true, needsVerification: true }),
      verifyPushedOrder: async () => 'unknown',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(beforeVerify.length, 0, 'nothing is written to an unproven order')

  // ...and it lands once verification promotes the link.
  const promoted = makePort({
    verifiable: [{ ...VERIFY_LINK, courierPending: true, shippingService: 'Royal Mail' }],
  })
  const afterVerify: Note[] = []
  await runWmsOrderPushSweepCore(
    connector({ comments: afterVerify, verifyPushedOrder: async () => 'ours' }),
    'mintsoft', promoted.port, { now: NOW },
  )
  assert.equal(afterVerify.length, 1)
  const note = afterVerify[0]!
  assert.match(note.comment, /Royal Mail/)
  assert.equal(note.externalOrderId, 'wms-1')
})

test('[o3d-bjc.8] a create that succeeds after failures gets a FULL verification budget', async () => {
  // claimForCreate has already created the link, so the update side of the
  // upsert is what runs — and the verification budget reads that counter.
  // Carrying four failed create attempts into it would quarantine a live WMS
  // order on its first transient unknown.
  const { port, upserts } = makePort({ createCandidates: [candidate({ pushAttempts: 4 })] })
  await runWmsOrderPushSweepCore(
    connector({
      pushOrder: async () => ({ externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW', needsVerification: true }),
      verifyPushedOrder: async () => 'unknown',
    }),
    'mintsoft', port, { now: NOW },
  )
  assert.equal(upserts[0].update.attempts, 0)
  assert.equal(upserts[0].create.attempts, 0)
})
