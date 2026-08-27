import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideWmsMissingRepush,
  decideWmsPushReplay,
  describeBlockedWmsPush,
} from '../lib/domain/wms/push-recovery-affordance.ts'

/**
 * o3d-2k5r r5 — THE CONTROL AND THE ACTION READ THE SAME ANSWER.
 *
 * The exception inbox rendered Replay for every blocked state except VALIDATION_FAILED, from a
 * condition written in the client. `replayWmsOrderPush` refuses on four things, and the client knew
 * about one of them — so a ShipHero AMBIGUOUS_CREATE row got a button the action refuses every
 * single time, under a label ("Push failed") naming the one thing that row is not. The order-detail
 * chip had its own third version of the same condition, which omitted the externalOrderId refusal.
 *
 * These assert the rule the surfaces are now built on: everything decidable from the link's own
 * columns is decided HERE, once.
 */

const AMBIGUOUS = { attempts: 3, externalOrderId: null, pushedAt: null }
const NOTHING_SENT = { attempts: 0, externalOrderId: null, pushedAt: null }

test('o3d-2k5r r5 affordance: a ShipHero park is NOT replayable — the row the inbox used to give a button', () => {
  const decision = decideWmsPushReplay({ connector: 'shiphero', state: 'AMBIGUOUS_CREATE', ...AMBIGUOUS }, 'SO-1')
  assert.equal(decision.replayable, false)
  assert.equal(decision.replayable === false && decision.reason, 'create-not-repeatable')
  // And the guidance is WMS-side work a person can actually perform, not "try again".
  assert.match(decision.replayable === false ? decision.guidance : '', /not safe to repeat/)
  assert.match(decision.replayable === false ? decision.guidance : '', /Open the WMS/)
})

test('o3d-2k5r r5 affordance: the same park on a connector whose create refuses a duplicate IS replayable', () => {
  // Or the rule above would pass for a function that never offers the control at all.
  assert.deepEqual(decideWmsPushReplay({ connector: 'mintsoft', state: 'AMBIGUOUS_CREATE', ...AMBIGUOUS }, 'SO-1'), { replayable: true })
})

test('o3d-2k5r r5 affordance: a dead letter carrying a warehouse id is refused — the chip used to offer it', () => {
  // `state === 'DEAD_LETTER' || …` was the chip's hand-written condition, and it agreed with the
  // action on the case it was written for. This is the case it did not know about: the link names a
  // warehouse order, so a re-queue is a SECOND one.
  const decision = decideWmsPushReplay(
    { connector: 'mintsoft', state: 'DEAD_LETTER', attempts: 5, externalOrderId: 'wms-9', pushedAt: null },
    'SO-1',
  )
  assert.equal(decision.replayable, false)
  assert.equal(decision.replayable === false && decision.reason, 'already-linked')
  assert.match(decision.replayable === false ? decision.guidance : '', /already linked to WMS order wms-9/)
})

test('o3d-2k5r r5 affordance: payload-invalid and not-blocked rows are refused', () => {
  const invalid = decideWmsPushReplay({ connector: 'mintsoft', state: 'VALIDATION_FAILED', ...NOTHING_SENT }, 'SO-1')
  assert.equal(invalid.replayable === false && invalid.reason, 'payload-invalid')
  for (const state of ['PENDING_CREATE', 'SYNCED', 'MERGED', 'HELD', 'CANCELLED', 'PENDING_VERIFY']) {
    const decision = decideWmsPushReplay({ connector: 'mintsoft', state, ...NOTHING_SENT }, 'SO-1')
    assert.equal(decision.replayable === false && decision.reason, 'not-a-blocked-push', `${state} offered a replay`)
  }
})

test('o3d-2k5r r5 affordance: an unknown connector fails CLOSED', () => {
  // A link can outlive the connector that wrote it (a renamed plugin, a restored row), and "we have
  // never heard of this connector" is not a reason to believe its warehouse refuses duplicates.
  const decision = decideWmsPushReplay({ connector: 'warehouse-of-the-future', state: 'AMBIGUOUS_CREATE', ...AMBIGUOUS }, 'SO-1')
  assert.equal(decision.replayable, false)
  assert.equal(decision.replayable === false && decision.reason, 'create-not-repeatable')
})

test('o3d-2k5r r5 affordance: the Why column is derived from the evidence, not the state name', () => {
  // "Push failed" on an AMBIGUOUS_CREATE row is precisely wrong: nothing is known to have failed,
  // and the hazard is that the create SUCCEEDED and IMS never heard.
  assert.equal(describeBlockedWmsPush({ connector: 'shiphero', state: 'AMBIGUOUS_CREATE', ...AMBIGUOUS }), 'Create outcome unknown')
  assert.equal(describeBlockedWmsPush({ connector: 'mintsoft', state: 'VALIDATION_FAILED', ...NOTHING_SENT }), 'Payload invalid')
  assert.equal(describeBlockedWmsPush({ connector: 'mintsoft', state: 'DEAD_LETTER', ...AMBIGUOUS }), 'Push failed')
  assert.equal(
    describeBlockedWmsPush({ connector: 'mintsoft', state: 'DEAD_LETTER', attempts: 5, externalOrderId: 'wms-9', pushedAt: null }),
    'Linked, unverified',
  )
})

test('o3d-2k5r r5 affordance: the MISSING_IN_WMS re-push takes the same connector contract', () => {
  // A lookup that came back empty is not proof the order is gone — it is the same lookup whose
  // answer is in doubt. Only the remote's own contract covers the case where it was wrong.
  const shiphero = decideWmsMissingRepush({ connector: 'shiphero', reference: 'SO-1', createEligible: true })
  assert.equal(shiphero.repushable, false)
  assert.match(shiphero.repushable === false ? shiphero.guidance : '', /does not refuse a duplicate/)
  assert.match(shiphero.repushable === false ? shiphero.guidance : '', /second order under the same reference/)
  assert.deepEqual(decideWmsMissingRepush({ connector: 'mintsoft', reference: 'SO-1', createEligible: true }), { repushable: true })
  // Fails closed on a connector this build does not know, like every other reader of the policy.
  assert.equal(decideWmsMissingRepush({ connector: '', reference: 'SO-1', createEligible: true }).repushable, false)
})

// --- the ROW the client receives -------------------------------------------------------

test('o3d-2k5r r5 row: a ShipHero park reaches the inbox with NO replay affordance and the guidance instead', async () => {
  // The finding, at the point it is observable: the client renders `replayable`, so if the row says
  // true the button is on screen whatever the action does. This is the row that used to get one.
  const { buildBlockedWmsPushRow } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const row = buildBlockedWmsPushRow({
    orderId: 'so-1',
    connector: 'shiphero',
    state: 'AMBIGUOUS_CREATE',
    attempts: 1,
    externalOrderId: null,
    pushedAt: null,
    lastError: null,
    lastAttemptAt: new Date('2026-08-20T09:00:00.000Z'),
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  })
  assert.equal(row.replayable, false)
  assert.match(row.replayRefusal!, /not safe to repeat/)
  assert.equal(row.why, 'Create outcome unknown', 'and it is not called an ordinary push failure')
})

test('o3d-2k5r r5 row: the same park on Mintsoft keeps its button', async () => {
  const { buildBlockedWmsPushRow } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const row = buildBlockedWmsPushRow({
    orderId: 'so-1',
    connector: 'mintsoft',
    state: 'AMBIGUOUS_CREATE',
    attempts: 1,
    externalOrderId: null,
    pushedAt: null,
    lastError: null,
    lastAttemptAt: null,
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
  })
  assert.equal(row.replayable, true)
  assert.equal(row.replayRefusal, null)
  assert.equal(row.lastAttemptAt, null)
})

test('o3d-2k5r r5 row: a MISSING_IN_WMS drift row carries the re-push affordance, other categories carry none', async () => {
  const { buildOrderReconcileDriftRow } = await import('../lib/domain/wms/push-recovery-affordance.ts')
  const base = {
    orderId: 'so-1',
    connector: 'shiphero',
    detail: null,
    externalOrderNumber: 'WMS-1',
    lastSeenAt: new Date('2026-08-20T09:00:00.000Z'),
    order: { id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null },
    createEligible: true,
  }
  const missing = buildOrderReconcileDriftRow({ ...base, category: 'MISSING_IN_WMS' })
  assert.equal(missing.repushable, false)
  assert.match(missing.repushRefusal!, /does not refuse a duplicate/)

  assert.equal(buildOrderReconcileDriftRow({ ...base, connector: 'mintsoft', category: 'MISSING_IN_WMS' }).repushable, true)

  // NOT_PUSHED and ACTIVE_AFTER_CANCEL are resolved at the order or in the WMS — no control, and
  // therefore no refusal text either, or the row would explain the absence of a button that was
  // never offered for this category in the first place.
  for (const category of ['NOT_PUSHED', 'ACTIVE_AFTER_CANCEL']) {
    const row = buildOrderReconcileDriftRow({ ...base, connector: 'mintsoft', category })
    assert.equal(row.repushable, false, category)
    assert.equal(row.repushRefusal, null, category)
  }
})
