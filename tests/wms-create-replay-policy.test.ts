import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WMS_CREATE_REPLAY_POLICY,
  wmsAmbiguousCreateMayBeReplayed,
  wmsAmbiguousCreateRefusal,
  wmsCreateReplayPolicy,
} from '../lib/domain/wms/create-replay-policy.ts'
import { WMS_CONNECTOR_IDS } from '../lib/connectors/wms/types.ts'

/**
 * o3d-2k5r r4 — the table that decides whether a create whose outcome is UNKNOWN may be sent again.
 *
 * It is the only evidence that speaks to the in-flight half of the question, so getting it wrong is
 * not a cosmetic error: `remote-refuses-duplicate` on a connector that does not refuse duplicates
 * re-enables the exact duplicate-fulfilment this round exists to stop.
 */

test('replay policy: every registered WMS connector has an answer', () => {
  // `tsc` already enforces this (the table is a Record over WmsConnectorId), but a runtime
  // assertion is what catches an id added to WMS_CONNECTOR_IDS with an `as` cast somewhere.
  for (const id of WMS_CONNECTOR_IDS) {
    assert.ok(WMS_CREATE_REPLAY_POLICY[id], `${id} has no create-replay policy`)
  }
  assert.equal(Object.keys(WMS_CREATE_REPLAY_POLICY).length, WMS_CONNECTOR_IDS.length)
})

test('replay policy: Mintsoft refuses duplicates remotely, ShipHero only client-side', () => {
  // Mintsoft: PUT /api/Order answers {Success:false, Message:'Order already exists'} and
  // pushMintsoftOrder resolves the existing order through a ClientId-scoped Order/Search.
  assert.equal(wmsCreateReplayPolicy('mintsoft'), 'remote-refuses-duplicate')
  assert.equal(wmsAmbiguousCreateMayBeReplayed('mintsoft'), true)
  // ShipHero: order_create does not enforce partner_order_id uniqueness, so
  // findShipheroOrderByPartnerId is a preflight, and a preflight cannot see a request on the wire.
  assert.equal(wmsCreateReplayPolicy('shiphero'), 'client-side-dedupe-only')
  assert.equal(wmsAmbiguousCreateMayBeReplayed('shiphero'), false)
})

test('replay policy: an unknown connector id FAILS CLOSED', () => {
  // A link outlives the connector that wrote it — a renamed plugin, a row restored from a backup.
  // "We have never heard of this connector" is not a reason to believe its warehouse refuses
  // duplicates, and the default must not be the permissive one.
  assert.equal(wmsCreateReplayPolicy('mintsoft-legacy'), null)
  assert.equal(wmsAmbiguousCreateMayBeReplayed('mintsoft-legacy'), false)
  assert.equal(wmsAmbiguousCreateMayBeReplayed(''), false)
})

test('replay policy: the refusal names the reference and an action that can be performed', () => {
  const message = wmsAmbiguousCreateRefusal('shiphero', 'SO-1234')
  assert.match(message, /SO-1234/, 'the operator is told what to search the WMS for')
  assert.match(message, /Open the WMS/i)
  // Both branches are WMS-side on purpose: neither needs an IMS control, so neither can become a
  // remedy that does not exist. And neither asks IMS to accept the operator's word as evidence.
  assert.match(message, /cancel any duplicate/i)
  assert.match(message, /if no order is there/i)
  assert.doesNotMatch(message, /press|button|click/i)
})
