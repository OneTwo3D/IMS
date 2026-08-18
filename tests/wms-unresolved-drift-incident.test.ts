import assert from 'node:assert/strict'
import test from 'node:test'
import { toIncident, unresolvedDriftStateKey } from '../lib/domain/wms/unresolved-drift.ts'

/**
 * o3d-bjc.12 — the sweep will not mass-quarantine a cohort it cannot prove is
 * record-local (o3d-bjc.9), and that is correct: with no healthy control,
 * "these records are broken" and "this connector is broken" are the same
 * picture, and guessing takes a whole tenant out of sync for a fault one fix
 * would clear. The gap was that the decision was never OFFERED to anyone.
 * These pin the offer: what it says, when it appears, and when it retracts.
 */

const NOW = new Date('2026-07-26T09:30:00.000Z')

const LIVE = {
  consecutive: 4,
  lastSeenAt: '2026-07-26T09:29:00.000Z',
  cohortKey: 'L-1,L-2,L-3',
  stableFor: 4,
  firstSeenAt: '2026-07-26T09:12:00.000Z',
  linkIds: ['L-1', 'L-2', 'L-3'],
  touched: 3,
  reason: 'Split order has no parts visible in the WMS yet',
}

test('[o3d-bjc.12] a live cohort becomes an actionable incident', () => {
  const incident = toIncident('mintsoft', LIVE, undefined, NOW)
  assert.ok(incident)
  assert.equal(incident.linkCount, 3)
  assert.equal(incident.touched, 3)
  assert.equal(incident.consecutivePasses, 4)
  assert.equal(incident.firstSeenAt, '2026-07-26T09:12:00.000Z')
  assert.equal(incident.reason, 'Split order has no parts visible in the WMS yet')
  assert.deepEqual(incident.linkIds, ['L-1', 'L-2', 'L-3'])
})

test('[o3d-bjc.12] a cleared cohort retracts the offer', () => {
  // The sweep zeroes the state the moment a pass reads record-local (or clean).
  // An offer to isolate orders nobody is stuck on is worse than no offer: an
  // operator would quarantine three healthy links on stale evidence.
  assert.equal(toIncident('mintsoft', {
    consecutive: 0, cohortKey: null, stableFor: 0, firstSeenAt: null, linkIds: [], touched: 0, reason: null, lastSeenAt: null,
  }, undefined, NOW), null)
  assert.equal(toIncident('mintsoft', null, undefined, NOW), null)
})

test('[o3d-bjc.12] a cohort with no LINKS is not actionable, whatever the counter says', () => {
  // "Isolate 0 orders" is not a decision. A state carrying a streak but no ids
  // (an older row, or a partial write) must not render a button.
  assert.equal(toIncident('mintsoft', { ...LIVE, linkIds: [] }, undefined, NOW), null)
  assert.equal(toIncident('mintsoft', { ...LIVE, cohortKey: null }, undefined, NOW), null)
})

test('[o3d-bjc.12] the incident is read from the key the sweep writes', () => {
  // One key, two owners: the sweep persists its drift state here and the inbox
  // reads it. A mismatch would show an empty inbox next to a stalled sweep.
  assert.equal(unresolvedDriftStateKey('mintsoft'), 'wms_dispatch_unresolved_streak:mintsoft')
  assert.notEqual(unresolvedDriftStateKey('mintsoft'), unresolvedDriftStateKey('shiphero'))
})

test('[o3d-bjc.12] isolation eligibility is the SWEEP\'s predicate, not an approximation', async () => {
  const { isolatableLinkWhere } = await import('../lib/domain/wms/unresolved-drift.ts')
  const where = isolatableLinkWhere({
    connector: 'mintsoft', linkCount: 2, touched: 2, consecutivePasses: 3, stableFor: 3,
    firstSeenAt: null, reason: null, linkIds: ['L-1', 'L-2'], version: 'deadbeefdeadbeef',
  })
  // An order that shipped, completed or was cancelled since the incident was
  // recorded is no longer a dispatch candidate — quarantining it would invent
  // an exception for an order nobody is waiting on.
  assert.deepEqual(where.order, { status: { notIn: ['SHIPPED', 'COMPLETED', 'DELIVERED', 'CANCELLED'] } })
  assert.deepEqual(where.state, { in: ['SYNCED', 'MERGED'] })
  assert.deepEqual(where.externalOrderNumber, { not: null })
  assert.equal(where.dispatchUnresolvedAt, null, 'already-quarantined links are not re-quarantined')
  assert.equal(where.dispatchDeadLetteredAt, null)
  assert.deepEqual(where.id, { in: ['L-1', 'L-2'] })
  assert.equal(where.connector, 'mintsoft')
})

test('[o3d-bjc.12] the action token follows the COHORT, not the counters', async () => {
  const { driftDecisionVersion } = await import('../lib/domain/wms/unresolved-drift.ts')
  // Every drift pass rewrites the counters. If the token covered those, an
  // operator's open page would be invalidated on every sweep interval — reload,
  // re-read the same cohort, race the next tick. What must not change under
  // them is WHO gets isolated.
  const ticked = toIncident('mintsoft', { ...LIVE, consecutive: 9, stableFor: 9, lastSeenAt: NOW.toISOString() }, undefined, NOW)
  const original = toIncident('mintsoft', LIVE, undefined, NOW)
  assert.equal(ticked?.version, original?.version, 'counters ticking must not invalidate the decision')

  // Membership changing MUST invalidate it.
  const moved = toIncident('mintsoft', { ...LIVE, linkIds: ['L-1', 'L-9'], cohortKey: 'L-1,L-9' }, undefined, NOW)
  assert.notEqual(moved?.version, original?.version)
  // Order of the ids is not membership.
  assert.equal(
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['b', 'a'] }),
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['a', 'b'] }),
  )
  // ...and the same cohort on a different connector is a different decision.
  assert.notEqual(
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['a'] }),
    driftDecisionVersion({ connector: 'shiphero', cohortKey: 'k', linkIds: ['a'] }),
  )
})

test('[o3d-bjc.12] an incident nothing re-confirms EXPIRES', async () => {
  const { DRIFT_INCIDENT_MAX_AGE_MS } = await import('../lib/domain/wms/unresolved-drift.ts')
  // The sweep clears this state on a clean pass — but that write can fail, and
  // a stale incident would then invite someone to quarantine orders the sweep
  // has since read perfectly well. The offer expires on its own.
  const stale = { ...LIVE, lastSeenAt: new Date(NOW.getTime() - DRIFT_INCIDENT_MAX_AGE_MS - 1000).toISOString() }
  assert.equal(toIncident('mintsoft', stale, undefined, NOW), null)
  const fresh = { ...LIVE, lastSeenAt: new Date(NOW.getTime() - 60_000).toISOString() }
  assert.ok(toIncident('mintsoft', fresh, undefined, NOW))
  // A row with no confirmation at all is not evidence either.
  assert.equal(toIncident('mintsoft', { ...LIVE, lastSeenAt: null }, undefined, NOW), null)
})
