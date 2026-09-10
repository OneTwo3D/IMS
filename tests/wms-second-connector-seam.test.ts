/**
 * THE SECOND-CONNECTOR SEAM (o3d-remove-shiphero).
 *
 * WHAT THIS FILE IS FOR. Until ShipHero was removed there were two WMS connectors, and
 * the generic WMS layer was kept honest by the ordinary fact that both had to work.
 * Mintsoft is now the only one. A one-implementation abstraction reads as ceremony:
 * the next person to touch `lib/connectors/wms/registry.ts`, `create-replay-policy.ts`
 * or `app/actions/wms-asn.ts` will be able to see, correctly, that every path there
 * currently resolves to Mintsoft — and inlining it will not break a single other test.
 *
 * So the second implementation is a FICTITIOUS one (tests/helpers/fictitious-wms-connector.ts),
 * and this file drives the generic layer through it end to end. It is deliberately not
 * "assert the registry map has two keys": every test below executes real generic code
 * — the push sweep, the dispatch sweep, the held-release rule, the ASN decoration, the
 * order-lookup resolver — against a warehouse that is not Mintsoft and does not behave
 * like Mintsoft.
 *
 * IF THIS FILE STOPS COMPILING, the abstraction collapsed. Do not delete it; the thing
 * that broke it is the change worth looking at.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACME_WMS_ID,
  ACME_WMS_LABEL,
  AcmeWmsConnector,
  acmeWmsConnectorDef,
  makeAcmeWarehouse,
  makeSeamRegistry,
} from './helpers/fictitious-wms-connector.ts'
import { createWmsConnectorRegistry } from '../lib/connectors/wms/registry.ts'
import {
  decideWmsHeldRelease,
  wmsAmbiguousCreateMayBeReplayed,
  wmsAmbiguousCreateRefusal,
  wmsCreateReplayPolicy,
} from '../lib/domain/wms/create-replay-policy.ts'
import { decideWmsMissingRepush, decideWmsPushReplay } from '../lib/domain/wms/push-recovery-affordance.ts'
import { decorateWmsAsnState, unsupportedWmsAsnState } from '../lib/connectors/wms/asn-types.ts'
import { isWmsUnresolvableRecordError, WmsUnresolvableRecordError } from '../lib/connectors/wms/errors.ts'
import { runWmsDispatchSweepCore } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsAsnRow } from '../lib/connectors/wms/asn-types.ts'
import type { WmsConnector } from '../lib/connectors/wms/types.ts'

// ---------------------------------------------------------------------------
// 1. REGISTRATION — a connector this build does not ship can still be registered
// ---------------------------------------------------------------------------

test('seam/registry: a fictitious connector registers and is constructed through the registry', () => {
  const warehouse = makeAcmeWarehouse()
  const registry = makeSeamRegistry(warehouse)

  assert.deepEqual(registry.ids(), ['mintsoft', ACME_WMS_ID])
  assert.equal(registry.has(ACME_WMS_ID), true)
  assert.equal(registry.has('no-such-wms'), false)

  // The registry DISPATCHES — it does not switch. What comes back is the fictitious
  // connector's own instance, built by its own factory, with no Mintsoft involvement.
  const connector = registry.getConnector(ACME_WMS_ID)
  assert.ok(connector instanceof AcmeWmsConnector)
  assert.equal(connector.id, ACME_WMS_ID)
  assert.equal(connector.name, ACME_WMS_LABEL)

  // And the metadata the generic layer reads comes from the definition, not a literal.
  assert.equal(registry.getDef(ACME_WMS_ID).label, ACME_WMS_LABEL)
  assert.equal(registry.getDef(ACME_WMS_ID).createReplayPolicy, 'client-side-dedupe-only')
})

test('seam/registry: an unregistered id is a null lookup, not a Mintsoft default', () => {
  const registry = makeSeamRegistry()
  assert.equal(registry.findDef('no-such-wms'), null)
  assert.throws(() => registry.getConnector('no-such-wms' as never), /Unknown WMS connector/)
})

test('seam/registry: registering the same id twice is refused', () => {
  assert.throws(
    () => createWmsConnectorRegistry([acmeWmsConnectorDef(), acmeWmsConnectorDef()]),
    /Duplicate WMS connector registration/,
  )
})

// ---------------------------------------------------------------------------
// 2. CREATE-REPLAY POLICY — the branch no shipped connector takes any more
// ---------------------------------------------------------------------------

/**
 * THE MEASUREMENT THIS EXISTS TO FIX. With ShipHero gone, every test that used the
 * literal `'shiphero'` to reach a `client-side-dedupe-only` path was reaching it via an
 * id the registry does not know — and `wmsCreateReplayPolicy` fails CLOSED on an
 * unknown id, returning null, which produces the identical refusal. Those tests would
 * therefore pass against a build in which `'client-side-dedupe-only'` had been deleted
 * outright. That is a proof of an adjacent property, not of the policy.
 *
 * Registering the fictitious connector separates the two: it is a KNOWN id whose
 * policy is the unsafe one, so the refusal is attributable to the policy and only to
 * the policy.
 */
test('seam/policy: a REGISTERED unsafe connector is distinguishable from an unknown id', () => {
  const registry = makeSeamRegistry()

  // Known, and known to be unsafe.
  assert.equal(wmsCreateReplayPolicy(ACME_WMS_ID, registry), 'client-side-dedupe-only')
  // Known, and safe.
  assert.equal(wmsCreateReplayPolicy('mintsoft', registry), 'remote-refuses-duplicate')
  // Unknown → null. A DIFFERENT state that happens to lead to the same refusal.
  assert.equal(wmsCreateReplayPolicy('no-such-wms', registry), null)

  // Both refuse a replay...
  assert.equal(wmsAmbiguousCreateMayBeReplayed(ACME_WMS_ID, registry), false)
  assert.equal(wmsAmbiguousCreateMayBeReplayed('no-such-wms', registry), false)
  // ...and only the policy lookup tells them apart. If someone deleted the
  // 'client-side-dedupe-only' arm as "unreachable", the first assertion above fails
  // while every `no-such-wms` assertion in this file keeps passing.
  assert.notEqual(wmsCreateReplayPolicy(ACME_WMS_ID, registry), wmsCreateReplayPolicy('no-such-wms', registry))
})

test('seam/policy: the SHIPPED registry does not know the fictitious connector', () => {
  // The seam is the registry parameter, not a hardcoded fixture id leaking into
  // production. If someone "helpfully" adds acme-wms to BUILT_IN_WMS_CONNECTORS,
  // this fails.
  assert.equal(wmsCreateReplayPolicy(ACME_WMS_ID), null)
})

test('seam/policy: a held order on the unsafe connector is PARKED, and the guidance names it', () => {
  const registry = makeSeamRegistry()

  // Key 1 present (the warehouse confirmed the cancellation) → release, no probe.
  assert.deepEqual(
    decideWmsHeldRelease({ connector: ACME_WMS_ID, registry, remoteCancellationConfirmed: true, reference: 'SO-1' }),
    { release: true, evidence: 'remote-cancellation-confirmed', probeRequired: false },
  )

  // Key 1 absent, key 2 absent (this connector's create does not refuse a duplicate)
  // → refuse. This is the whole reason the policy exists.
  const refused = decideWmsHeldRelease({
    connector: ACME_WMS_ID, registry, remoteCancellationConfirmed: false, reference: 'SO-1',
  })
  assert.equal(refused.release, false)
  assert.equal(refused.release === false ? refused.reason : '', 'cancellation-unconfirmed')
  const guidance = refused.release === false ? refused.guidance : ''
  assert.match(guidance, new RegExp(ACME_WMS_ID), 'the operator is told WHICH warehouse to open')
  assert.match(guidance, /does not refuse a duplicate/)
  assert.match(guidance, /SO-1/, 'and what to search for')

  // Contrast, same call, same registry: the safe connector releases on key 2 alone.
  const released = decideWmsHeldRelease({
    connector: 'mintsoft', registry, remoteCancellationConfirmed: false, reference: 'SO-1',
  })
  assert.deepEqual(released, { release: true, evidence: 'create-refused-remotely', probeRequired: true })
})

test('seam/policy: the ambiguous-create refusal is connector-specific text, not a template', () => {
  const registry = makeSeamRegistry()
  const unsafe = wmsAmbiguousCreateRefusal(ACME_WMS_ID, 'SO-9', registry)
  assert.match(unsafe, /is not safe to repeat/)
  assert.match(unsafe, /picked twice/)
  // The safe connector gets the OTHER message — no duplicate warning, because there is
  // no duplicate risk. A single templated string would fail this.
  const safe = wmsAmbiguousCreateRefusal('mintsoft', 'SO-9', registry)
  assert.doesNotMatch(safe, /picked twice/)
  assert.match(safe, /was not re-queued on this pass/)
})

test('seam/affordance: the exception inbox offers NO replay control for the unsafe connector', () => {
  const registry = makeSeamRegistry()
  const link = {
    connector: ACME_WMS_ID as string,
    state: 'AMBIGUOUS_CREATE',
    externalOrderId: null,
    attempts: 3,
    pushedAt: null,
  }
  const decision = decideWmsPushReplay(link, 'SO-1', registry)
  assert.equal(decision.replayable, false)
  assert.equal(decision.replayable === false ? decision.reason : '', 'create-not-repeatable')

  // And the MISSING_IN_WMS re-push takes the same answer from the same source.
  const repush = decideWmsMissingRepush({
    connector: ACME_WMS_ID, reference: 'SO-1', createEligible: true, registry,
  })
  assert.equal(repush.repushable, false)
  assert.equal(repush.repushable === false ? repush.reason : '', 'create-not-repeatable')

  // The safe connector, identical row, gets the control.
  assert.equal(decideWmsPushReplay({ ...link, connector: 'mintsoft' }, 'SO-1', registry).replayable, true)
})

// ---------------------------------------------------------------------------
// 3. THE CONNECTOR CONTRACT — capability negotiation, driven by absent methods
// ---------------------------------------------------------------------------

test('seam/contract: optional capabilities the fictitious connector omits report as absent', () => {
  const connector = makeSeamRegistry().getConnector(ACME_WMS_ID)

  // Present — declared by the fixture.
  assert.equal(typeof connector.fetchOrderStatus, 'function')
  assert.equal(typeof connector.pushOrder, 'function')
  assert.equal(typeof connector.cancelOrder, 'function')
  assert.equal(typeof connector.probeOrderPresence, 'function')

  // Absent — and absent means UNDEFINED, which is what every `connector.x?` capability
  // check in the generic layer tests. A connector that stubbed these with a throwing
  // implementation would pass a `typeof === 'function'` check and then blow up inside
  // a sweep; Mintsoft implements almost all of them, so nothing else covers this.
  assert.equal(connector.fetchOrderDelta, undefined, 'no bulk delta → the sweep must per-order poll')
  assert.equal(connector.fetchOrderParts, undefined, 'no split parts → the sweep must report unsupported')
  assert.equal(connector.fetchOrderPartItems, undefined)
  assert.equal(connector.verifyPushedOrder, undefined, 'no ownership proof → PENDING_VERIFY must not resolve')
  assert.equal(connector.updateOrder, undefined)
  assert.equal(connector.createBundle, undefined)
  assert.equal(connector.fetchBundle, undefined)
  assert.equal(connector.verifyWebhookSignature, undefined, 'poll-only WMS → no webhook ingress')
})

test('seam/contract: the fictitious create does NOT refuse a duplicate — the fixture earns its policy', async () => {
  // The policy value is only honest if the fixture actually behaves that way. Push the
  // same order number twice and get two warehouse orders — which is precisely the
  // outcome `client-side-dedupe-only` exists to keep IMS from causing.
  const warehouse = makeAcmeWarehouse()
  const connector = new AcmeWmsConnector(warehouse)
  const input = {
    orderNumber: 'SO-DUP', externalReference: 'ims-1', externalWarehouseId: 'ACME-WH-1', currency: 'GBP',
    shippingAddress: {
      firstName: 'A', lastName: 'B', company: '', address1: '1 St', address2: '',
      town: 'T', county: '', postCode: 'X', country: 'GB',
    },
    email: null, phone: null, vatNumber: null, comments: null, courierService: null,
    totalVat: 0, shippingExVat: 0, shippingVat: 0, discountExVat: 0, discountVat: 0, lines: [],
  }
  const first = await connector.pushOrder(input)
  const second = await connector.pushOrder(input)
  assert.notEqual(first.externalOrderId, second.externalOrderId, 'two creates, two warehouse orders')
  assert.deepEqual(warehouse.creates, ['SO-DUP', 'SO-DUP'])
})

// ---------------------------------------------------------------------------
// 4. ERROR MAPPING — a connector-agnostic error raised by a non-Mintsoft connector
// ---------------------------------------------------------------------------

function seamDispatchDeps(overrides: Partial<WmsDispatchSweepDeps>): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async () => ({ success: true }),
    // The fictitious connector has no fetchOrderParts, so the generic adapter would
    // set this false. Stated explicitly here for the same reason.
    partsSupported: false,
    fetchOrderParts: async () => {
      throw new Error('the fictitious connector does not support parts')
    },
    fetchPartItems: async () => {
      throw new Error('the fictitious connector does not support parts')
    },
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((n) => [n, 1])),
    ...overrides,
  }
}

test('seam/errors: an unusable record from the fictitious WMS is UNRESOLVED, not a link error', async () => {
  // o3d-6j8's rule, driven by a warehouse that is not Mintsoft. The connector raises
  // the SHARED WmsUnresolvableRecordError; the generic sweep must map it to unresolved
  // (hold the watermark, job PARTIAL) and NOT take a failure strike — because a strike
  // dead-letters the link, and under connector-wide drift that stops fulfilment
  // tenant-wide for a condition IMS did not cause.
  const warehouse = makeAcmeWarehouse()
  warehouse.orders.set('SO-BAD', {
    externalOrderId: 'ACME-1', externalOrderNumber: 'SO-BAD', status: 'DESPATCHED',
    dispatched: true, trackingNumber: null, unusable: true,
  })
  const connector = new AcmeWmsConnector(warehouse)

  const strikes: string[] = []
  const result = await runWmsDispatchSweepCore(seamDispatchDeps({
    listCandidates: async () => [{
      linkId: 'L1', orderId: 'O1', externalOrderNumber: 'SO-BAD', externalOrderId: 'ACME-1',
    }],
    // The only wiring between the connector and the sweep: the contract method.
    fetchOrderStatus: (orderNumber) => connector.fetchOrderStatus!(orderNumber),
    recordDispatchError: async (candidate, reason) => {
      strikes.push(`${candidate.linkId}:${reason}`)
      return { deadLettered: false }
    },
  }), { deltaEnabled: false })

  assert.equal(result.unresolved, 1, 'the pass must report the record it could not act on')
  assert.equal(result.counters.errors, 0, 'and must NOT count it as a per-link error')
  assert.deepEqual(strikes, [], 'no failure strike → the link stays eligible for automatic recovery')
})

test('seam/errors: an ORDINARY connector failure still strikes the link', async () => {
  // The contrast that makes the test above mean something. Same sweep, same fictitious
  // connector, a plain Error instead of the shared class → an error, and a strike.
  const result = await runWmsDispatchSweepCore(seamDispatchDeps({
    listCandidates: async () => [{
      linkId: 'L1', orderId: 'O1', externalOrderNumber: 'SO-BOOM', externalOrderId: 'ACME-1',
    }],
    fetchOrderStatus: async () => {
      throw new Error('Acme API 500')
    },
  }), { deltaEnabled: false })

  assert.equal(result.counters.errors, 1)
  assert.equal(result.unresolved, 0)
})

test('seam/errors: the error class is recognised by identity, not by connector name', () => {
  const error = new WmsUnresolvableRecordError('acme said despatched with no tracking')
  assert.equal(isWmsUnresolvableRecordError(error), true)
  assert.equal(isWmsUnresolvableRecordError(new Error('acme said despatched with no tracking')), false)
})

test('seam/dispatch: a WMS with no bulk delta still reconciles, per-order', async () => {
  // The `fetchOrderDelta?` capability check, exercised by a connector that genuinely
  // lacks it. Mintsoft implements it, so with one connector nothing reaches this.
  const warehouse = makeAcmeWarehouse()
  warehouse.orders.set('SO-OK', {
    externalOrderId: 'ACME-1', externalOrderNumber: 'SO-OK', status: 'DESPATCHED',
    dispatched: true, trackingNumber: 'ACME-TRACK-1',
  })
  const connector: WmsConnector<typeof ACME_WMS_ID> = new AcmeWmsConnector(warehouse)
  assert.equal(connector.fetchOrderDelta, undefined, 'precondition: this WMS has no delta endpoint')

  const applied: Array<{ orderId: string; tracking: string[] }> = []
  const result = await runWmsDispatchSweepCore(seamDispatchDeps({
    listCandidates: async () => [{
      linkId: 'L1', orderId: 'O1', externalOrderNumber: 'SO-OK', externalOrderId: 'ACME-1',
    }],
    fetchOrderStatus: (orderNumber) => connector.fetchOrderStatus!(orderNumber),
    applyDispatch: async (orderId, tracking) => {
      applied.push({ orderId, tracking: tracking.map((t) => t.trackingNumber) })
      return { success: true }
    },
  }), { deltaEnabled: false })

  assert.equal(result.counters.dispatched, 1)
  assert.equal(result.deltaRowCount, 0, 'no delta was consulted')
  assert.deepEqual(applied, [{ orderId: 'O1', tracking: ['ACME-TRACK-1'] }])
})

// ---------------------------------------------------------------------------
// 5. ASN TYPES — the label promise, driven by a connector whose label is not "Mintsoft"
// ---------------------------------------------------------------------------

test('seam/asn: the ASN view-model is labelled from the registry, not from a literal', () => {
  const registry = makeSeamRegistry()
  const label = registry.getDef(ACME_WMS_ID).label

  const rows: WmsAsnRow[] = [{
    id: 'a1', externalAsnId: 'ACME-ASN-PO-1', status: 'OPEN', createdAt: '2026-09-01T00:00:00.000Z',
    lastCallbackAt: null, closedAt: null, lineCount: 2, totalExpectedQty: '10', totalReceivedQty: '0',
  }]
  const decorated = decorateWmsAsnState({
    pluginEnabled: true, canCreate: true, canManage: true, blockedReason: null,
    destinationWarehouseCode: 'MAIN', bindingExternalWarehouseId: 'ACME-WH-1', existingAsns: rows,
  }, label)

  assert.equal(decorated.connectorLabel, ACME_WMS_LABEL)
  assert.doesNotMatch(JSON.stringify(decorated), /mintsoft/i, 'nothing Mintsoft-shaped survives the decoration')
  assert.deepEqual(decorated.existingAsns, rows, 'the core rows pass through untouched')
})

test('seam/asn: a registered connector with no ASN support is named, not anonymised', () => {
  // o3d-remove-shiphero: the facade used to hardcode 'WMS' on this arm, so an operator
  // running a registered connector that simply cannot do ASNs was told an unnamed
  // system was unavailable.
  const label = makeSeamRegistry().getDef(ACME_WMS_ID).label
  const state = unsupportedWmsAsnState(label)
  assert.equal(state.pluginEnabled, false)
  assert.equal(state.connectorLabel, ACME_WMS_LABEL)
  // And with NOTHING resolved at all, the generic label is still the fallback.
  assert.equal(unsupportedWmsAsnState(null).connectorLabel, 'WMS')
})

test('seam/asn: the fictitious connector produces a contract-shaped WmsAsnRef', async () => {
  const connector = new AcmeWmsConnector()
  const ref = await connector.createAsn({
    externalWarehouseId: 'ACME-WH-1',
    reference: 'PO-1',
    lines: [
      { sourceLineId: 'l1', externalProductId: 'p1', sku: 'SKU-1', quantity: 4 },
      { sourceLineId: 'l2', externalProductId: 'p2', sku: 'SKU-2', quantity: 6 },
    ],
  })
  assert.equal(ref.externalAsnId, 'ACME-ASN-PO-1')
  assert.equal(ref.lines.length, 2)
  // The generic reconciliation joins on sourceLineId — the field the CORE owns, not
  // one the WMS invented. A connector that echoed only its own ids would break it.
  assert.deepEqual(ref.lines.map((l) => l.sourceLineId), ['l1', 'l2'])
})

// ---------------------------------------------------------------------------
// 6. ORDER LOOKUP — the WMS→shopping-connector resolver, for a non-Mintsoft WMS
// ---------------------------------------------------------------------------

test('seam/order-lookup: the resolver reads the FICTITIOUS connector\'s own connection row', async () => {
  // resolveWmsOrderLookupConnector reads the WmsConnection row for the connector it is ASKED
  // about. Driving it with the fictitious id proves the query is parameterised rather than pinned
  // to Mintsoft — the failure mode being a resolver that quietly reads Mintsoft's row for every
  // WMS and links a second warehouse's fulfilments to the wrong storefront.
  const asked: string[] = []
  const rows: Record<string, string> = { [ACME_WMS_ID]: 'woocommerce', mintsoft: 'shopify' }
  const port = {
    findConnection: async (connector: string) => {
      asked.push(connector)
      return { orderLookupConnector: rows[connector] ?? null }
    },
  }

  const { resolveWmsOrderLookupConnector } = await import('../lib/connectors/wms/order-lookup.ts')
  assert.equal(await resolveWmsOrderLookupConnector(ACME_WMS_ID, port), 'woocommerce')
  assert.deepEqual(asked, [ACME_WMS_ID], 'the resolver must filter on the connector it was asked about')

  // THE CONTRAST THAT MAKES IT A TEST OF THE FILTER. Two connectors, two different configured
  // storefronts. A resolver pinned to Mintsoft's row would answer 'shopify' above — and would
  // link the fictitious warehouse's fulfilments to a shop that did not sell the order.
  assert.equal(await resolveWmsOrderLookupConnector('mintsoft', port), 'shopify')
  assert.deepEqual(asked, [ACME_WMS_ID, 'mintsoft'])
})

test('seam/order-lookup: the type guard accepts only registered ids', async () => {
  const { isWmsConnectorId } = await import('../lib/connectors/wms/types.ts')
  assert.equal(isWmsConnectorId('mintsoft'), true)
  // The fictitious connector is NOT in the shipped build, so the shipped guard rejects it — the
  // seam is the injected registry, never a fixture id leaking into production.
  assert.equal(isWmsConnectorId(ACME_WMS_ID), false)
  assert.equal(isWmsConnectorId(null), false)
})
