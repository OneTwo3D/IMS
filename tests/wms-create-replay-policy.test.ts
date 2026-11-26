import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WMS_CREATE_REPLAY_POLICY,
  wmsAmbiguousCreateMayBeReplayed,
  wmsAmbiguousCreateRefusal,
  wmsCreateReplayPolicy,
} from '../lib/domain/wms/create-replay-policy.ts'
import { WMS_CONNECTOR_IDS } from '../lib/connectors/wms/types.ts'
import { BUILT_IN_WMS_CONNECTORS } from '../lib/connectors/wms/registry.ts'
import { ACME_WMS_ID, makeSeamRegistry } from './helpers/fictitious-wms-connector.ts'

/**
 * o3d-2k5r r4 — the table that decides whether a create whose outcome is UNKNOWN may be sent again.
 *
 * It is the only evidence that speaks to the in-flight half of the question, so getting it wrong is
 * not a cosmetic error: `remote-refuses-duplicate` on a connector that does not refuse duplicates
 * re-enables the exact duplicate-fulfilment this round exists to stop.
 *
 * o3d-remove-shiphero: the unsafe half of this table used to be covered by ShipHero. It is now
 * covered by a REGISTERED fictitious connector, because covering it with a bare unknown id would
 * not cover it at all — see the fail-closed test below for why those two are not the same thing.
 */

test('replay policy: every registered WMS connector has an answer', () => {
  // The policy is a required field on each registry definition, so `tsc` already enforces this. A
  // runtime assertion is what catches an id added to WMS_CONNECTOR_IDS with an `as` cast somewhere.
  for (const id of WMS_CONNECTOR_IDS) {
    assert.ok(WMS_CREATE_REPLAY_POLICY[id], `${id} has no create-replay policy`)
  }
  assert.equal(Object.keys(WMS_CREATE_REPLAY_POLICY).length, WMS_CONNECTOR_IDS.length)
})

test('replay policy: the shipped connector refuses duplicates remotely', () => {
  // Mintsoft: PUT /api/Order answers {Success:false, Message:'Order already exists'} and
  // pushMintsoftOrder resolves the existing order through a ClientId-scoped Order/Search.
  assert.equal(wmsCreateReplayPolicy('mintsoft'), 'remote-refuses-duplicate')
  assert.equal(wmsAmbiguousCreateMayBeReplayed('mintsoft'), true)
})

test('replay policy: a registered CLIENT-SIDE-DEDUPE-ONLY connector may never be replayed', () => {
  // The branch no shipped connector takes any more. Driven through a registry that really
  // contains such a connector so the refusal is attributable to the POLICY — see
  // tests/wms-second-connector-seam.test.ts for the full seam.
  const registry = makeSeamRegistry()
  assert.equal(wmsCreateReplayPolicy(ACME_WMS_ID, registry), 'client-side-dedupe-only')
  assert.equal(wmsAmbiguousCreateMayBeReplayed(ACME_WMS_ID, registry), false)
})

test('replay policy: an unknown connector id FAILS CLOSED — and that is NOT the same state', () => {
  // A link outlives the connector that wrote it — a renamed plugin, a row restored from a backup.
  // "We have never heard of this connector" is not a reason to believe its warehouse refuses
  // duplicates, and the default must not be the permissive one.
  assert.equal(wmsCreateReplayPolicy('mintsoft-legacy'), null)
  assert.equal(wmsAmbiguousCreateMayBeReplayed('mintsoft-legacy'), false)
  assert.equal(wmsAmbiguousCreateMayBeReplayed(''), false)

  // THE DISTINCTION THIS TEST EXISTS TO MAKE. Fail-closed and client-side-dedupe-only produce the
  // same REFUSAL, so a suite that only ever passed an unregistered id would pass unchanged against
  // a build in which 'client-side-dedupe-only' had been deleted as unreachable. `null` vs the
  // policy value is the only thing that separates them.
  const registry = makeSeamRegistry()
  assert.notEqual(wmsCreateReplayPolicy(ACME_WMS_ID, registry), wmsCreateReplayPolicy('mintsoft-legacy', registry))
})

test('replay policy: the refusal names the reference and an action that can be performed', () => {
  const message = wmsAmbiguousCreateRefusal(ACME_WMS_ID, 'SO-1234', makeSeamRegistry())
  assert.match(message, /SO-1234/, 'the operator is told what to search the WMS for')
  assert.match(message, /Open the WMS/i)
  // Both branches are WMS-side on purpose: neither needs an IMS control, so neither can become a
  // remedy that does not exist. And neither asks IMS to accept the operator's word as evidence.
  assert.match(message, /cancel any duplicate/i)
  assert.match(message, /if no order is there/i)
  assert.doesNotMatch(message, /press|button|click/i)
})

test('the shipped registry and this table agree — they are declared separately and must not drift', () => {
  // WHY THEY ARE SEPARATE. The policy belongs on the registry definition, because that is where a
  // REGISTERED connector's properties live and it is what a fictitious connector supplies. But
  // create-replay-policy.ts must not import the registry: several suites replace that module with
  // `mock.module`, and a module-load-time dereference of an export their mock does not declare
  // takes out every test in the file. So the default table is declared locally — and this is the
  // assertion that keeps the two from disagreeing, which is the only failure mode that split
  // introduces. A connector added to one and not the other fails here.
  assert.deepEqual(
    Object.fromEntries(BUILT_IN_WMS_CONNECTORS.map((def) => [def.id, def.createReplayPolicy])),
    WMS_CREATE_REPLAY_POLICY,
  )
  assert.ok(BUILT_IN_WMS_CONNECTORS.length > 0, 'and neither side is empty')
})
