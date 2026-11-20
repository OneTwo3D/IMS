import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DESPATCH_BACKDATE_MAX_DAYS,
  describeDespatchAdjustment,
  instantAfterLockDay,
  resolveDespatchInstant,
} from '../lib/domain/sales/despatch-instant.ts'
import { bookableDespatchInstant, reconcileOneOrder, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import type { WmsOrderPart, WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * o3d-hqvrp.114: a warehouse despatch is dated with the warehouse's own despatch time, not the moment the sweep applied it. The resolver is
 * pure; the sweep sends an exact instant only when EVERY despatch entry is one. No database, no network.
 */
const NOW = new Date('2026-11-20T10:00:00Z')
const at = (iso: string) => new Date(iso)

test('a reported time inside the open window is booked exactly as reported', () => {
  const r = resolveDespatchInstant({ requested: at('2026-11-19T23:50:00Z'), now: NOW })
  assert.equal(r.instant.toISOString(), '2026-11-19T23:50:00.000Z')
  assert.equal(r.adjustedFor, null)
})

test('no reported time: booked now, as before', () => {
  assert.deepEqual(resolveDespatchInstant({ requested: null, now: NOW }), { instant: NOW, requested: null, adjustedFor: null })
})

test('a future time is clamped to now; skew inside five minutes is clamped quietly', () => {
  const far = resolveDespatchInstant({ requested: at('2026-11-21T10:00:00Z'), now: NOW })
  assert.equal(far.instant.getTime(), NOW.getTime())
  assert.equal(far.adjustedFor, 'FUTURE')
  const skew = resolveDespatchInstant({ requested: at('2026-11-20T10:03:00Z'), now: NOW })
  assert.equal(skew.instant.getTime(), NOW.getTime())
  assert.equal(skew.adjustedFor, null)
})

test('an implausibly old time is not backdated: booked now and named', () => {
  const r = resolveDespatchInstant({ requested: new Date(NOW.getTime() - (DESPATCH_BACKDATE_MAX_DAYS + 1) * 86_400_000), now: NOW })
  assert.equal(r.instant.getTime(), NOW.getTime())
  assert.equal(r.adjustedFor, 'TOO_OLD')
})

test('a day that already has an inventory snapshot is not rewritten: moved to the first instant after it', () => {
  const r = resolveDespatchInstant({ requested: at('2026-11-18T14:00:00Z'), now: NOW, floors: { afterSnapshot: at('2026-11-19T00:00:00Z') } })
  assert.equal(r.instant.toISOString(), '2026-11-19T00:00:00.000Z')
  assert.equal(r.adjustedFor, 'SNAPSHOTTED_DAY')
})

test('a locked accounting period is not re-opened: moved to the first instant after the lock', () => {
  const afterLock = instantAfterLockDay('2026-11-15')
  assert.equal(afterLock?.toISOString(), '2026-11-16T00:00:00.000Z')
  const r = resolveDespatchInstant({ requested: at('2026-11-14T10:00:00Z'), now: NOW, floors: { afterLock } })
  assert.equal(r.instant.toISOString(), '2026-11-16T00:00:00.000Z')
  assert.equal(r.adjustedFor, 'LOCKED_PERIOD')
})

test('BST: the lock day ends at London midnight, 23:00Z', () => {
  assert.equal(instantAfterLockDay('2026-07-14')?.toISOString(), '2026-07-14T23:00:00.000Z')
})

test('never before the stock was allocated (Group B must not be dated before Group A2), nor before the order existed', () => {
  const a = resolveDespatchInstant({ requested: at('2026-11-19T10:00:00Z'), now: NOW, floors: { allocatedAt: at('2026-11-20T09:00:00Z') } })
  assert.equal(a.instant.toISOString(), '2026-11-20T09:00:00.000Z')
  assert.equal(a.adjustedFor, 'BEFORE_ALLOCATION')
  const o = resolveDespatchInstant({ requested: at('2026-11-19T10:00:00Z'), now: NOW, floors: { orderCreatedAt: at('2026-11-19T12:00:00Z') } })
  assert.equal(o.adjustedFor, 'BEFORE_ORDER')
})

test('a floor ahead of now (a lock that reaches today) never produces a future booking', () => {
  const r = resolveDespatchInstant({ requested: at('2026-11-19T10:00:00Z'), now: NOW, floors: { afterLock: at('2026-11-21T00:00:00Z') } })
  assert.equal(r.instant.getTime(), NOW.getTime())
})

test('the adjustment is described with both instants; an unmoved booking is not described', () => {
  const moved = resolveDespatchInstant({ requested: at('2026-11-21T10:00:00Z'), now: NOW })
  assert.match(describeDespatchAdjustment(moved) ?? '', /2026-11-21T10:00:00.000Z.*2026-11-20T10:00:00.000Z/)
  assert.equal(describeDespatchAdjustment(resolveDespatchInstant({ requested: at('2026-11-19T10:00:00Z'), now: NOW })), null)
})

const LONDON = 'europe-london' as const
const t = (despatchedAt: string | null) => ({ trackingNumber: 'TN', carrier: 'DPD', despatchedAt })

test('Mintsoft zone-less time is read as UK local time: 23:50 BST on the 31st is 22:50Z, still the 31st', () => {
  assert.equal(bookableDespatchInstant([[t('2026-07-31T23:50:00')]], LONDON)?.toISOString(), '2026-07-31T22:50:00.000Z')
})

test('an undated entry, a part with no tracking, a date-only value or an ambiguous local time gives NO instant (the apply time is used)', () => {
  assert.equal(bookableDespatchInstant([[t(null)]], LONDON), undefined)
  assert.equal(bookableDespatchInstant([[t('2026-07-31T23:50:00')], []], LONDON), undefined, 'an empty part must not inherit the other part\'s date')
  assert.equal(bookableDespatchInstant([[t('2026-07-31T23:50:00')], [t(null)]], LONDON), undefined, 'an undated part must not inherit the other part\'s date')
  assert.equal(bookableDespatchInstant([[t('2026-07-31')]], LONDON), undefined)
  assert.equal(bookableDespatchInstant([[t('2026-10-25T01:30:00')]], LONDON), undefined)
  assert.equal(bookableDespatchInstant([[t('2026-07-31T23:50:00')]], undefined), undefined, 'a zone-less value with no known zone is not an instant')
})

test('the latest of several parts is used', () => {
  assert.equal(bookableDespatchInstant([[t('2026-11-18T10:00:00')], [t('2026-11-19T09:00:00')]], LONDON)?.toISOString(), '2026-11-19T09:00:00.000Z')
})

function status(overrides: Partial<WmsOrderStatus>): WmsOrderStatus {
  return {
    externalOrderId: 'M-1', externalOrderNumber: 'WC-1001', status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null, isMerged: false,
    mergedOrderNumbers: [], deepLinkUrl: null, tracking: [t('2026-07-31T23:50:00')], dispatched: true, raw: null, ...overrides,
  }
}

function deps(applied: Array<{ options: unknown }>, overrides: Partial<WmsDispatchSweepDeps> = {}): WmsDispatchSweepDeps {
  return {
    listCandidates: async () => [],
    fetchOrderStatus: async () => null,
    applyDispatch: async (_orderId, _tracking, options) => { applied.push({ options }); return { success: true } },
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async () => ({ deadLettered: false }),
    clearDispatchFailures: async () => {},
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    zonelessDespatchReading: LONDON,
    passDespatchFacts: true,
    ...overrides,
  }
}
const candidate = { linkId: 'l1', orderId: 'o1', externalOrderNumber: 'WC-1001' }

test('the sweep hands the apply the exact despatch instant of an ordinary order', async () => {
  const applied: Array<{ options: unknown }> = []
  const outcome = await reconcileOneOrder(deps(applied), candidate, status({}))
  assert.equal(outcome.action, 'dispatched')
  assert.equal((applied[0].options as { despatchedAt?: Date }).despatchedAt?.toISOString(), '2026-07-31T22:50:00.000Z')
})

test('an undated ordinary order is applied with no instant (the apply time stands)', async () => {
  const applied: Array<{ options: unknown }> = []
  await reconcileOneOrder(deps(applied), candidate, status({ tracking: [t(null)] }))
  assert.equal((applied[0].options as { despatchedAt?: Date } | undefined)?.despatchedAt, undefined)
})

function part(n: number, tracking: ReturnType<typeof t>[]): WmsOrderPart {
  return { externalId: `P${n}`, partNumber: n, status: 'DESPATCHED', dispatched: true, tracking }
}

test('a split order is dated by its LATEST part, and a part with no date gives no instant at all', async () => {
  const split = status({ isSplit: true, partCount: 2, isMerged: false })
  const dated: Array<{ options: unknown }> = []
  await reconcileOneOrder(deps(dated, { fetchOrderParts: async () => [part(1, [t('2026-07-30T10:00:00')]), part(2, [t('2026-07-31T23:50:00')])], fetchPartItems: async () => [{ sku: 'A', qty: 1 }] }), candidate, split)
  assert.equal((dated[0].options as { despatchedAt?: Date }).despatchedAt?.toISOString(), '2026-07-31T22:50:00.000Z')

  const undated: Array<{ options: unknown }> = []
  await reconcileOneOrder(deps(undated, { fetchOrderParts: async () => [part(1, [t('2026-07-30T10:00:00')]), part(2, [t(null)])], fetchPartItems: async () => [{ sku: 'A', qty: 1 }] }), candidate, split)
  assert.equal((undated[0].options as { despatchedAt?: Date } | undefined)?.despatchedAt, undefined, 'part 2 has no date: part 1\'s must not be inherited')
})
