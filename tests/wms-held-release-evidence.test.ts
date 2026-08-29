import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushLinkRef,
  type WmsPushReleasableLink,
} from '../lib/domain/wms/order-push-sweep.ts'
import { decideWmsHeldRelease } from '../lib/domain/wms/create-replay-policy.ts'
import type { WmsOrderCancelResult, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
import type { WmsMutationEventInput } from '../lib/domain/wms/mutation-audit.ts'

/**
 * o3d-2k5r r6 — THE HELD RELEASE RE-OPENS A CREATE, AND IT USED TO DO SO ON NO EVIDENCE.
 *
 * The release pass clears `externalOrderId` and the dispatch stamp, which puts the order straight
 * back into a create queue that selects on state alone. It did that for EVERY HELD link, on the
 * stated reasoning that "its WMS order was cancelled when it was held".
 *
 * The hold pass does not establish that. It parks a link HELD when `cancelOrder` answers
 * `cancelled: true` AND when it answers `NOT_FOUND` — and on ShipHero NOT_FOUND is only a lookup
 * result. `order_cancel` there is a mutation over an order the connector first has to FIND; a
 * renumbering, a client-scope change or an eventually-consistent index makes the lookup miss an
 * order that is alive and being picked. Release it, re-create it, and ShipHero's `order_create`
 * does not refuse the duplicate: two warehouse orders under one reference, both picked. The state
 * compare-and-set the release already had prevents a stale LOCAL write and says nothing about the
 * warehouse.
 *
 * So the release takes the two keys the rest of the branch takes, and this suite is the ShipHero
 * regression Codex asked for plus the shape of both keys.
 */

const NOW = () => new Date('2026-08-27T10:00:00.000Z')
const CONFIRMED_AT = new Date('2026-08-26T09:00:00.000Z')
const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]

function heldLink(over: Partial<WmsPushReleasableLink> = {}): WmsPushReleasableLink {
  return {
    id: 'link-1',
    orderId: 'so-1',
    externalOrderId: 'wms-7',
    // The affirmative evidence, on by default: the WMS said it cancelled the order.
    cancelledAt: CONFIRMED_AT,
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
    ...over,
  }
}

type Seed = {
  releasable?: WmsPushReleasableLink[]
  holdable?: WmsPushLinkRef[]
  cancelOrder?: () => Promise<WmsOrderCancelResult>
  probeOrderPresence?: (reference: string) => Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'>
}

function harness(seed: Seed) {
  const updates: Array<{ id: string; data: Record<string, unknown>; ifState?: string }> = []
  const events: WmsMutationEventInput[] = []
  const probed: string[] = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => seed.releasable ?? [],
    createCandidates: async () => [],
    claimForCreate: async () => 'SKIPPED',
    recordValidationFailure: async () => true,
    updatableLinks: async () => [],
    holdableLinks: async () => seed.holdable ?? [],
    cancellableLinks: async () => [],
    upsertByOrder: async () => {},
    updateLink: async (id, data) => { updates.push({ id, data: data as Record<string, unknown> }) },
    updateLinkIfState: async (id, fromState, data) => {
      updates.push({ id, data: data as Record<string, unknown>, ifState: fromState })
      return true
    },
    recordEvent: async (event) => { events.push(event) },
  }
  const connector = {
    pushOrder: async (): Promise<WmsOrderPushResult> => ({ externalOrderId: 'x', externalOrderNumber: 'x', status: 'NEW' }),
    cancelOrder: seed.cancelOrder ?? (async (): Promise<WmsOrderCancelResult> => ({ cancelled: true, status: 'CANCELLED' })),
    probeOrderPresence: seed.probeOrderPresence
      ? async (reference: string) => { probed.push(reference); return seed.probeOrderPresence!(reference) }
      : undefined,
  }
  return { port, connector, updates, events, probed }
}

const release = (updates: Array<{ id: string; data: Record<string, unknown> }>) =>
  updates.find((u) => u.data.state === 'PENDING_CREATE')

// --- the ShipHero regression: NOT_FOUND is not a cancellation -----------------------------

test('o3d-2k5r r6 release: a ShipHero hold whose cancellation was NEVER confirmed is not re-created', async () => {
  // THE REGRESSION. Route: releasableHeldOrders returns a HELD link with NO cancellation stamp ->
  // decideWmsHeldRelease finds neither key (no confirmed cancellation; shiphero is
  // client-side-dedupe-only) -> the link is PARKED, not released.
  //
  // Mutation: make decideWmsHeldRelease return `{ release: true }` for the unconfirmed case, or
  // delete the `if (!gate.release)` branch from the release pass, and this fails on the
  // PENDING_CREATE assertion — the pre-fix behaviour, which clears the id of an order ShipHero may
  // still be picking and hands it back to the create pass.
  const h = harness({ releasable: [heldLink({ cancelledAt: null })] })
  const result = await runWmsOrderPushSweepCore(h.connector, 'shiphero', h.port, { now: NOW })

  assert.equal(release(h.updates), undefined, 'nothing was re-queued for create')
  assert.equal(result.released, 0)
  const parked = h.updates.find((u) => u.data.state === 'DEAD_LETTER')
  assert.ok(parked, 'and it is PARKED where the exception inbox can show it, not left HELD in silence')
  assert.equal(parked!.ifState, 'HELD', 'guarded, so it cannot land on a link another worker moved')
  assert.match(String(parked!.data.lastError), /did not CONFIRM cancelling/)
  assert.match(String(parked!.data.lastError), /does not refuse a duplicate/)
  // The id is NOT cleared: it is the only pointer IMS has to an order that may exist.
  assert.equal(parked!.data.externalOrderId, undefined)
})

test('o3d-2k5r r6 hold: a ShipHero NOT_FOUND is parked at the HOLD, and stamps no cancellation', async () => {
  // The same rule, asked where the ambiguity is CREATED. Route: holdableLinks -> cancelOrder
  // answers NOT_FOUND -> decideWmsHeldRelease refuses -> DEAD_LETTER with the guidance.
  //
  // Mutation: restore `{ state: 'HELD', cancelledAt: ts }` for the NOT_FOUND branch and this fails
  // twice over — on the state, and on `cancelledAt`, which is the persisted evidence the release
  // reads. Stamping "cancelled at 09:04" for an order nobody confirmed was cancelled is the whole
  // defect, written into a column.
  const h = harness({
    holdable: [{ id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-7' }],
    cancelOrder: async () => ({ cancelled: false, status: 'NOT_FOUND' }),
  })
  const result = await runWmsOrderPushSweepCore(h.connector, 'shiphero', h.port, { now: NOW })

  assert.equal(result.held, 0)
  const write = h.updates.find((u) => u.id === 'link-1')!
  assert.equal(write.data.state, 'DEAD_LETTER')
  assert.equal(write.data.cancelledAt, null)
  const audit = h.events.find((e) => e.action === 'order_hold')!
  assert.equal(audit.outcome, 'FAILED')
  assert.equal((audit.after as Record<string, unknown>).remoteCancellationConfirmed, false)
})

test('o3d-2k5r r6 hold: a CONFIRMED ShipHero cancellation still parks HELD and stamps the evidence', async () => {
  // The legitimate cycle has to keep working, or the fix is a different outage. Route: cancelOrder
  // answers `cancelled: true` -> key 1 -> HELD with the stamp.
  //
  // Mutation: gate the hold on the connector policy alone (drop the `remoteCancellationConfirmed`
  // arm from decideWmsHeldRelease) and this fails — every ShipHero hold would dead-letter, and an
  // operator holding an order would be told to reconcile it by hand.
  const h = harness({
    holdable: [{ id: 'link-1', orderId: 'so-1', externalOrderId: 'wms-7' }],
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
  })
  const result = await runWmsOrderPushSweepCore(h.connector, 'shiphero', h.port, { now: NOW })

  assert.equal(result.held, 1)
  const write = h.updates.find((u) => u.id === 'link-1')!
  assert.equal(write.data.state, 'HELD')
  assert.deepEqual(write.data.cancelledAt, NOW())
})

test('o3d-2k5r r6 release: a CONFIRMED cancellation releases on ShipHero, and spends no probe', async () => {
  // Route: cancelledAt present -> evidence `remote-cancellation-confirmed` -> probeRequired false
  // -> released.
  //
  // Mutation: make the probe unconditional (`probeRequired: true` on the confirmed arm) and this
  // fails on the probe count. It would also be wrong in production: a cancelled order that the WMS
  // still LISTS answers FOUND, so an unconditional probe blocks every legitimate release for ever.
  const h = harness({ releasable: [heldLink()], probeOrderPresence: async () => 'FOUND' })
  const result = await runWmsOrderPushSweepCore(h.connector, 'shiphero', h.port, { now: NOW })

  assert.equal(result.released, 1)
  assert.deepEqual(h.probed, [])
  const write = release(h.updates)!
  assert.equal(write.data.externalOrderId, null)
  assert.equal(write.data.lastAttemptAt, null, 'the dispatch stamp is cleared, so the claim rule grants rather than parks')
  const audit = h.events.find((e) => e.action === 'order_release')!
  assert.equal((audit.after as Record<string, unknown>).releaseEvidence, 'remote-cancellation-confirmed')
})

// --- key 2: the connector's own create contract, plus a probe that can only refuse -------

test('o3d-2k5r r6 release: an unconfirmed Mintsoft hold is released only once the warehouse says MISSING', async () => {
  // Route: no cancellation stamp -> mintsoft refuses a duplicate create, so key 2 turns ->
  // probeRequired -> probeOrderPresence('SO-1') === MISSING -> released.
  //
  // Mutation: drop the probe call and this still passes — so the assertion that MATTERS is the
  // FOUND case below; this one exists to prove the path is reachable at all and that the reference
  // asked about is the one a re-create would use, not the WMS id.
  const h = harness({ releasable: [heldLink({ cancelledAt: null })], probeOrderPresence: async () => 'MISSING' })
  const result = await runWmsOrderPushSweepCore(h.connector, 'mintsoft', h.port, { now: NOW })

  assert.equal(result.released, 1)
  assert.deepEqual(h.probed, ['SO-1'])
  const audit = h.events.find((e) => e.action === 'order_release')!
  assert.equal((audit.after as Record<string, unknown>).releaseEvidence, 'create-refused-remotely')
})

test('o3d-2k5r r6 release: the warehouse FINDING the order refuses the release and says why', async () => {
  // Route: unconfirmed + mintsoft -> probe -> FOUND -> no write of PENDING_CREATE, no park either
  // (the link may still release once the warehouse agrees), the reason recorded on the link.
  //
  // Mutation: treat the probe as advisory (release regardless of `absence.absent`) and this fails
  // on `released` — IMS would re-create an order that is sitting in the warehouse right now, and
  // even where a remote duplicate-refusal stops a second pick it would bind the link to an order
  // that was supposed to be held.
  const h = harness({ releasable: [heldLink({ cancelledAt: null })], probeOrderPresence: async () => 'FOUND' })
  const result = await runWmsOrderPushSweepCore(h.connector, 'mintsoft', h.port, { now: NOW })

  assert.equal(result.released, 0)
  assert.equal(release(h.updates), undefined)
  const note = h.updates.find((u) => u.ifState === 'HELD')!
  assert.match(String(note.data.lastError), /ALREADY holds an order/)
  assert.equal(note.data.state, undefined, 'and the link stays HELD — this is a delay, not a disposition')
})

test('o3d-2k5r r6 release: a connector that cannot probe is not an absent order', async () => {
  // Route: unconfirmed + mintsoft -> probeRequired -> no probeOrderPresence at all -> `absent`
  // false -> refused.
  //
  // Mutation: default the probe's answer to absent when the connector has none (the shape this
  // repository keeps finding) and this fails on `released` — "we could not ask" would license the
  // create that the asking was supposed to authorise.
  const h = harness({ releasable: [heldLink({ cancelledAt: null })] })
  const result = await runWmsOrderPushSweepCore(h.connector, 'mintsoft', h.port, { now: NOW })

  assert.equal(result.released, 0)
  const note = h.updates.find((u) => u.ifState === 'HELD')!
  assert.match(String(note.data.lastError), /cannot check whether such an order exists/)
})

test('o3d-2k5r r6 release: an AMBIGUOUS match is not absence either', async () => {
  // Route: as above, probe answers AMBIGUOUS.
  //
  // Mutation: fold AMBIGUOUS in with MISSING in probeWarehouseAbsence and this fails on
  // `released` — a merged or duplicated warehouse record is the LEAST safe thing to re-create over.
  const h = harness({ releasable: [heldLink({ cancelledAt: null })], probeOrderPresence: async () => 'AMBIGUOUS' })
  const result = await runWmsOrderPushSweepCore(h.connector, 'mintsoft', h.port, { now: NOW })

  assert.equal(result.released, 0)
})

// --- the rule itself ----------------------------------------------------------------------

test('o3d-2k5r r6 rule: the two keys, and an unknown connector supplies neither', async () => {
  // Route: decideWmsHeldRelease, directly.
  //
  // Mutation: make the unknown-connector case fall through to `release: true` (i.e. treat "we have
  // never heard of this connector" as replay-safe) and the last assertion fails. A link can outlive
  // the connector that wrote it — a renamed plugin, a row restored from a backup — and that is not
  // a reason to believe its warehouse refuses duplicates.
  assert.deepEqual(
    decideWmsHeldRelease({ connector: 'shiphero', remoteCancellationConfirmed: true, reference: 'SO-1' }),
    { release: true, evidence: 'remote-cancellation-confirmed', probeRequired: false },
  )
  assert.deepEqual(
    decideWmsHeldRelease({ connector: 'mintsoft', remoteCancellationConfirmed: false, reference: 'SO-1' }),
    { release: true, evidence: 'create-refused-remotely', probeRequired: true },
  )
  const refused = decideWmsHeldRelease({ connector: 'shiphero', remoteCancellationConfirmed: false, reference: 'SO-1' })
  assert.equal(refused.release, false)
  assert.match(refused.release === false ? refused.guidance : '', /search for SO-1/)
  assert.equal(
    decideWmsHeldRelease({ connector: 'warehouse-of-the-future', remoteCancellationConfirmed: false, reference: 'SO-1' }).release,
    false,
  )
})
