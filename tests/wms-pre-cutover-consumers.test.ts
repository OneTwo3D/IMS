import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNotPushedDriftWhere } from '../lib/domain/wms/order-reconcile-sweep.ts'
import { wmsCreateEligibleOrderWhere, wmsPaidBeforeCreateFloor, wmsPushIsPreCutover } from '../lib/domain/wms/create-eligibility.ts'

/**
 * Every consumer that derives state from "a paid, bound order with no push link" applies the SAME producer floor as the create query,
 * or shows an explicit disposition. The pure parts are asserted here; the real queries are in tests/db/mintsoft-producer-seam.test.ts.
 */
const FLOOR = new Date('2026-06-01T00:00:00Z')
const BEFORE = new Date('2026-05-01T00:00:00Z')
const AFTER = new Date('2026-06-10T00:00:00Z')
const base = { connectorId: 'mintsoft', boundWarehouseIds: ['w1'], cutoff: new Date('2026-06-20T00:00:00Z') }

test('NOT_PUSHED drift predicate: the floor adds paidAt >= floor to detection AND resolution (one builder); no floor is the legacy predicate', () => {
  const withFloor = buildNotPushedDriftWhere({ ...base, paidNotBefore: FLOOR }) as { paidAt: Record<string, unknown> }
  const legacy = buildNotPushedDriftWhere(base) as { paidAt: Record<string, unknown> }
  assert.deepEqual(withFloor.paidAt, { not: null, lt: base.cutoff, gte: FLOOR })
  assert.deepEqual(legacy.paidAt, { not: null, lt: base.cutoff })
  assert.equal('gte' in legacy.paidAt, false)
})

test('create-eligible predicate (inbox control, re-push re-proof): the floor is part of it, absent without a floor', () => {
  assert.deepEqual((wmsCreateEligibleOrderWhere(['w1'], FLOOR) as { paidAt: unknown }).paidAt, { not: null, gte: FLOOR })
  assert.deepEqual((wmsCreateEligibleOrderWhere(['w1']) as { paidAt: unknown }).paidAt, { not: null })
})

test('the single decision on a loaded order agrees with the query: before the floor, or no paid time, is refused; at/after is not; no floor never refuses', () => {
  assert.equal(wmsPaidBeforeCreateFloor(BEFORE, FLOOR), true)
  assert.equal(wmsPaidBeforeCreateFloor(null, FLOOR), true)
  assert.equal(wmsPaidBeforeCreateFloor(FLOOR, FLOOR), false)
  assert.equal(wmsPaidBeforeCreateFloor(AFTER, FLOOR), false)
  assert.equal(wmsPaidBeforeCreateFloor(BEFORE, null), false)
})

test('"Queued" display: only a never-attempted queue entry for a pre-cutover order is shown as pre-cutover; history is shown as it is; no floor never changes the display', () => {
  const queued = { state: 'PENDING_CREATE', attempts: 0, externalOrderId: null }
  assert.equal(wmsPushIsPreCutover(queued, { paidAt: BEFORE }, FLOOR), true)
  assert.equal(wmsPushIsPreCutover(queued, { paidAt: AFTER }, FLOOR), false)
  assert.equal(wmsPushIsPreCutover(queued, { paidAt: BEFORE }, null), false)
  assert.equal(wmsPushIsPreCutover({ ...queued, attempts: 2 }, { paidAt: BEFORE }, FLOOR), false)
  assert.equal(wmsPushIsPreCutover({ ...queued, externalOrderId: 'x' }, { paidAt: BEFORE }, FLOOR), false)
  assert.equal(wmsPushIsPreCutover({ ...queued, state: 'SYNCED' }, { paidAt: BEFORE }, FLOOR), false)
})
