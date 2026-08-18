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
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['b', 'a'], firstSeenAt: null }),
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['a', 'b'], firstSeenAt: null }),
  )
  // ...and the same cohort on a different connector is a different decision.
  assert.notEqual(
    driftDecisionVersion({ connector: 'mintsoft', cohortKey: 'k', linkIds: ['a'], firstSeenAt: null }),
    driftDecisionVersion({ connector: 'shiphero', cohortKey: 'k', linkIds: ['a'], firstSeenAt: null }),
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

/* ------------------------------------------------------------------ *
 * o3d-0gzr / o3d-51du — the post-merge Codex findings on o3d-bjc.12.
 * ------------------------------------------------------------------ */

test('[o3d-0gzr] a cohort that changes away and BACK is a different decision (ABA)', () => {
  // Hashing membership alone cannot distinguish "never changed" from
  // "changed and changed back": A -> B -> A rehashes to A. A page rendered
  // against the first occurrence would then isolate the second one — a
  // different incident, with its own start time and reason. firstSeenAt is the
  // generation marker that separates them.
  const first = toIncident('mintsoft', { ...LIVE, firstSeenAt: '2026-07-26T08:00:00.000Z' }, undefined, NOW)
  const readBack = toIncident('mintsoft', { ...LIVE, firstSeenAt: '2026-07-26T09:00:00.000Z' }, undefined, NOW)
  assert.ok(first && readBack)
  assert.equal(first.linkIds.join(), readBack.linkIds.join(), 'same membership — this is the ABA case')
  assert.notEqual(first.version, readBack.version, 'a re-formed cohort must not reuse the old decision token')
})

test('[o3d-0gzr] counter-only ticks still do NOT invalidate an open page', () => {
  // The ABA fix must not cost what the digest was designed to buy: an operator
  // reading the page must survive the sweep rewriting counters underneath them.
  const original = toIncident('mintsoft', LIVE, undefined, NOW)
  const ticked = toIncident(
    'mintsoft',
    { ...LIVE, consecutive: 11, stableFor: 11, touched: 99, lastSeenAt: NOW.toISOString() },
    undefined,
    NOW,
  )
  assert.equal(ticked?.version, original?.version)
})

test('[o3d-0gzr] a FUTURE confirmation fails closed, not open', async () => {
  const { DRIFT_INCIDENT_MAX_CLOCK_SKEW_MS } = await import('../lib/domain/wms/unresolved-drift.ts')
  // The sweep and the host serving this action need not share a clock. If the
  // sweep's runs ahead, `now - lastSeen` goes NEGATIVE — which a bare
  // "> MAX_AGE" test reads as maximally fresh, keeping a dead incident
  // actionable for the skew plus the whole expiry window.
  const wayAhead = {
    ...LIVE,
    lastSeenAt: new Date(NOW.getTime() + DRIFT_INCIDENT_MAX_CLOCK_SKEW_MS + 60_000).toISOString(),
  }
  assert.equal(toIncident('mintsoft', wayAhead, undefined, NOW), null, 'a future stamp is not evidence')
  // Ordinary jitter must NOT retract a live offer.
  const slightlyAhead = { ...LIVE, lastSeenAt: new Date(NOW.getTime() + 5_000).toISOString() }
  assert.ok(toIncident('mintsoft', slightlyAhead, undefined, NOW), 'NTP jitter must not kill a real incident')
})

test('[o3d-0gzr] isolate eligibility IS the sweep predicate, not a copy of it', async () => {
  const { isolatableLinkWhere } = await import('../lib/domain/wms/unresolved-drift.ts')
  const { dispatchCandidateWhere } = await import('../lib/domain/wms/dispatch-sweep.ts')
  const incident = toIncident('mintsoft', LIVE, undefined, NOW)
  assert.ok(incident)
  const shared = dispatchCandidateWhere('mintsoft')
  const isolate = isolatableLinkWhere(incident)
  // Structural, not a source-text scan: every key the sweep filters on must be
  // present here with the SAME value, so the two cannot drift apart silently.
  for (const [key, value] of Object.entries(shared)) {
    assert.deepEqual(
      (isolate as Record<string, unknown>)[key],
      value,
      `isolate must filter on ${key} exactly as the sweep does`,
    )
  }
  // ...and it additionally narrows to the reviewed cohort.
  assert.deepEqual(isolate.id, { in: incident.linkIds })
})

test('[o3d-0gzr r2] freshness prefers the store row stamp over the sweep stamp', async () => {
  const { DRIFT_INCIDENT_MAX_AGE_MS } = await import('../lib/domain/wms/unresolved-drift.ts')
  // Prefer Setting.updatedAt over the sweep's own lastSeenAt: it advances on
  // every write, including one whose JSON compares equal, so a stable cohort
  // cannot expire while the sweep is still confirming it.
  //
  // NOT because it is a database clock — it is not. Prisma's @updatedAt is
  // ORM-level, generated on the writing host, which is why the production
  // comment names that residual instead of claiming a single clock.
  const skewedIntoTheFuture = { ...LIVE, lastSeenAt: new Date(NOW.getTime() + 45 * 60_000).toISOString() }
  const confirmedRecently = new Date(NOW.getTime() - 60_000)
  assert.ok(
    toIncident('mintsoft', skewedIntoTheFuture, undefined, NOW, confirmedRecently),
    'a skewed sweep stamp must not suppress an incident the store row says is fresh',
  )
  // ...and the database clock is what expires it, too.
  const confirmedLongAgo = new Date(NOW.getTime() - DRIFT_INCIDENT_MAX_AGE_MS - 1000)
  assert.equal(
    toIncident('mintsoft', { ...LIVE, lastSeenAt: NOW.toISOString() }, undefined, NOW, confirmedLongAgo),
    null,
    'a recent sweep stamp must not resurrect a row the store says is stale',
  )
})

test('[o3d-0gzr r2] the eligible digest tracks the SET, not its order or size alone', async () => {
  const { eligibleCohortDigest } = await import('../lib/domain/wms/unresolved-drift.ts')
  assert.equal(eligibleCohortDigest(['b', 'a']), eligibleCohortDigest(['a', 'b']), 'order is not identity')
  assert.notEqual(eligibleCohortDigest(['a', 'b']), eligibleCohortDigest(['a', 'c']), 'membership is')
  // Same size, wholly different set — the case a count-based guard misses.
  assert.notEqual(eligibleCohortDigest(['a', 'b']), eligibleCohortDigest(['c', 'd']))
  // An empty eligible set is its own distinct value, not a wildcard.
  assert.notEqual(eligibleCohortDigest([]), eligibleCohortDigest(['a']))
})
