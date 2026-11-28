import assert from 'node:assert/strict'
import test from 'node:test'
import {
  combineWmsWriteOffRoutes,
  wmsUnsellableRefundRefusal,
  wmsUnsellableReturnRefusal,
  wmsUnsellableWriteOffAdvice,
  wmsWriteOffRoute,
  type WmsBindingWriteOffFacts,
} from '@/lib/domain/inventory/wms-unsellable-advice'
import { routeForBinding, stockSyncCronSlug, thresholdsConfigured, type WriteOffRouteContext } from '@/lib/domain/inventory/wms-write-off-route'

/**
 * The write-off route for an unsellable unit held at the 3PL. ALIGNED only when align-down can really write it off; aligned but blocked is
 * ALIGNED_MANUAL (adjust in IMS too) naming why; notification-only, disabled or inactive is IMS_MASTER; nothing known, or disagreeing
 * bindings, is UNKNOWN.
 */

const READY: WmsBindingWriteOffFacts = {
  stockSyncMode: 'ALIGN_TO_WMS',
  active: true,
  connectionActive: true,
  alignmentConfirmed: true,
  alignDownReason: { active: true, accountCode: '5150' },
  thresholdsConfigured: true,
  inventoryAccountMissing: false,
  stockSyncScheduled: true,
}

test('aligned only when align-down can run; otherwise ALIGNED_MANUAL with the reason', () => {
  assert.deepEqual(wmsWriteOffRoute(READY), { mode: 'ALIGNED' })
  const cases: Array<[Partial<WmsBindingWriteOffFacts>, RegExp]> = [
    [{ stockSyncScheduled: false }, /its stock sync is not scheduled/],
    [{ alignmentConfirmed: false }, /not confirmed/],
    [{ alignDownReason: null }, /no align-down reason/],
    [{ alignDownReason: { active: false, accountCode: '5150' } }, /reason is inactive/],
    [{ alignDownReason: { active: true, accountCode: null } }, /reason has no account/],
    [{ thresholdsConfigured: false }, /no discrepancy thresholds/],
    [{ inventoryAccountMissing: true }, /no inventory account/],
  ]
  for (const [patch, why] of cases) {
    const route = wmsWriteOffRoute({ ...READY, ...patch })
    assert.equal(route.mode, 'ALIGNED_MANUAL', JSON.stringify(patch))
    assert.match(route.why ?? '', why)
  }
})

test('notification only, disabled or an inactive binding or connection: IMS_MASTER; nothing known: UNKNOWN', () => {
  assert.equal(wmsWriteOffRoute({ ...READY, stockSyncMode: 'NOTIFICATION_ONLY' }).mode, 'IMS_MASTER')
  assert.equal(wmsWriteOffRoute({ ...READY, stockSyncMode: 'DISABLED' }).mode, 'IMS_MASTER')
  assert.equal(wmsWriteOffRoute({ ...READY, active: false }).mode, 'IMS_MASTER', 'an inactive binding aligns nothing')
  assert.equal(wmsWriteOffRoute({ ...READY, connectionActive: false }).mode, 'IMS_MASTER', 'an inactive connection aligns nothing')
  assert.equal(wmsWriteOffRoute(null).mode, 'UNKNOWN')
  assert.equal(wmsWriteOffRoute({ ...READY, stockSyncMode: 'something_else' }).mode, 'UNKNOWN')
})

test('several bindings: their route when they agree, UNKNOWN when they disagree or none', () => {
  assert.deepEqual(combineWmsWriteOffRoutes([{ mode: 'ALIGNED' }, { mode: 'ALIGNED' }]), { mode: 'ALIGNED' })
  assert.deepEqual(combineWmsWriteOffRoutes([{ mode: 'ALIGNED' }, { mode: 'IMS_MASTER' }]), { mode: 'UNKNOWN' })
  assert.deepEqual(combineWmsWriteOffRoutes([{ mode: 'ALIGNED_MANUAL', why: 'a' }, { mode: 'ALIGNED_MANUAL', why: 'b' }]), { mode: 'UNKNOWN' })
  assert.deepEqual(combineWmsWriteOffRoutes([]), { mode: 'UNKNOWN' })
})

test('the server facts: a binding of a disabled connector counts as inactive; the cron must be on; thresholds need a number', () => {
  const row = { connector: 'wms-x', active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date(), discrepancyThresholds: { absoluteDelta: 5 }, alignDownReason: { active: true, accountCode: '5150' }, connection: { active: true } }
  const ctx = (over: Partial<WriteOffRouteContext> = {}): WriteOffRouteContext => ({ enabledConnectors: ['wms-x'], inventoryAccountMissing: false, stockSyncScheduled: { 'wms-x': true }, ...over })
  assert.equal(routeForBinding(row, ctx()).mode, 'ALIGNED')
  assert.equal(routeForBinding(row, ctx({ enabledConnectors: [] })).mode, 'IMS_MASTER')
  assert.equal(routeForBinding({ ...row, connection: { active: false } }, ctx()).mode, 'IMS_MASTER')
  assert.deepEqual(routeForBinding(row, ctx({ stockSyncScheduled: {} })), { mode: 'ALIGNED_MANUAL', why: 'its stock sync is not scheduled' }, 'a cron that is off (or not registered) aligns nothing')
  assert.equal(stockSyncCronSlug('wms-x'), 'wms-x-stock-sync')
  assert.equal(thresholdsConfigured({ absoluteDelta: 5 }), true)
  assert.equal(thresholdsConfigured({ percentDelta: '2.5' }), true)
  for (const value of [null, {}, { absoluteDelta: null, percentDelta: null }, [], 'x']) assert.equal(thresholdsConfigured(value as never), false)
})

test('ALIGNED: the 3PL writes it off, a later sync books it; no IMS adjustment (it would be booked back as a gain); holds are named', () => {
  const advice = wmsUnsellableWriteOffAdvice({ mode: 'ALIGNED' })
  assert.match(advice, /once it has seen the same difference twice/)
  assert.match(advice, /align-down reason/)
  assert.match(advice, /Do not also make a stock adjustment in IMS: the next sync would book it back as a stock gain/)
  assert.match(advice, /check the open discrepancies/)
  assert.match(advice, /or confirm the warehouse system does not count it/)
  assert.doesNotMatch(advice, /write it off in IMS with a stock adjustment/)
  assert.doesNotMatch(advice, /hold it out of sellable stock/)
})

test('ALIGNED_MANUAL and IMS_MASTER: a real write-off at the 3PL and an IMS stock adjustment', () => {
  const manual = wmsUnsellableWriteOffAdvice({ mode: 'ALIGNED_MANUAL', why: 'it has no align-down reason' })
  assert.match(manual, /cannot write the unit off by itself \(it has no align-down reason\)/)
  assert.match(manual, /write it off in IMS with a stock adjustment/)
  assert.match(manual, /clears the discrepancy/)
  const master = wmsUnsellableWriteOffAdvice({ mode: 'IMS_MASTER' })
  assert.match(master, /a real write-off/)
  assert.match(master, /write it off in IMS with a stock adjustment/)
  assert.doesNotMatch(master, /align-down/)
  for (const advice of [manual, master]) assert.doesNotMatch(advice, /hold it out of sellable stock/)
})

test('UNKNOWN gives both routes; every route says FIFO, "not necessarily", and promptly', () => {
  const unknown = wmsUnsellableWriteOffAdvice({ mode: 'UNKNOWN' })
  assert.match(unknown, /if its stock is aligned/)
  assert.match(unknown, /do not also adjust in IMS/)
  for (const mode of ['ALIGNED', 'ALIGNED_MANUAL', 'IMS_MASTER', 'UNKNOWN'] as const) {
    const advice = wmsUnsellableWriteOffAdvice({ mode })
    assert.match(advice, /FIFO/)
    assert.match(advice, /not necessarily at the returned unit's own layer/)
    assert.match(advice, /promptly/)
  }
})

test('both refusals carry the route\'s advice after restocking as Sellable', () => {
  for (const route of [{ mode: 'ALIGNED' }, { mode: 'ALIGNED_MANUAL', why: 'x' }, { mode: 'IMS_MASTER' }, { mode: 'UNKNOWN' }] as const) {
    const inbox = wmsUnsellableReturnRefusal(route)
    const refund = wmsUnsellableRefundRefusal(route)
    assert.ok(inbox.includes(wmsUnsellableWriteOffAdvice(route)))
    assert.ok(refund.includes(wmsUnsellableWriteOffAdvice(route)))
    assert.match(inbox, /Restock it as Sellable into the bound warehouse/)
    assert.match(refund, /Record the refund as Sellable/)
    assert.match(inbox, /Nothing was recorded\.$/)
  }
})
