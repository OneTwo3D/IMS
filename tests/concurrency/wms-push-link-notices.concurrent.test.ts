import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE OUTBOUND-ORDER HIGHS AGAINST A REAL DATABASE AND THE REAL ORDER-PUSH PORT.
 *
 *  - Two sweeps that both read the same AMBIGUOUS_CREATE link and both find the order the warehouse already holds BIND IT ONCE: the
 *    adoption is a compare-and-set on the parked state, so the loser sees the link moved on and does nothing.
 *  - The real hold / cancel selection reaches MERGED links, and skips a link whose hold / cancel the warehouse already refused.
 *  - A hold past NEW is ONE attempt: the second sweep makes no second warehouse call. The link stays SYNCED.
 *  - The dispatch sweep's candidate set includes an IMS-CANCELLED order only while its link carries a cancel notice.
 *
 * MINTSOFT IS LIVE AND IS NEVER CONTACTED: the connector is a double, and tests/no-outbound-network.cjs fails a test that tried to leave.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, sweep, dispatch] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/domain/wms/order-push-sweep'),
    import('@/lib/domain/wms/dispatch-sweep'),
  ])
  return { db, sweep, dispatch }
}
type Deps = Awaited<ReturnType<typeof deps>>

type Seed = { warehouseId: string; connectionId: string; bindingId: string; orderId: string }

async function seed(d: Deps, tag: string, status: 'PROCESSING' | 'ON_HOLD' | 'CANCELLED' = 'PROCESSING'): Promise<Seed> {
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const binding = await d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() },
    select: { id: true },
  })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `MSO-${tag}`, status, paidAt: new Date('2026-06-10T00:00:00Z'), shipFromWarehouseId: warehouse.id,
      customerName: 'Pat Example', customerEmail: 'pat@example.com', currency: 'GBP',
      shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `SKU-${tag}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  return { warehouseId: warehouse.id, connectionId: connection.id, bindingId: binding.id, orderId: order.id }
}

async function cleanup(d: Deps, s: Seed) {
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: s.orderId } })
  await d.db.wmsMutationEvent.deleteMany({ where: { entityId: s.orderId } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrder.deleteMany({ where: { id: s.orderId } })
  await d.db.externalWmsBinding.deleteMany({ where: { id: s.bindingId } })
  await d.db.wmsConnection.deleteMany({ where: { id: s.connectionId } })
  await d.db.warehouse.deleteMany({ where: { id: s.warehouseId } })
}

function connector(options: { cancel?: () => Promise<{ cancelled: boolean; status: string }>; onReconcile?: () => Promise<unknown> } = {}) {
  const calls = { push: 0, cancel: 0, comment: 0, reconcile: 0 }
  return {
    calls,
    connector: {
      pushOrder: async () => { calls.push += 1; return { externalOrderId: 'must-not-create', externalOrderNumber: 'X', status: 'NEW' } },
      updateOrder: async () => ({ updated: true, status: 'NEW' }),
      cancelOrder: async () => { calls.cancel += 1; return (options.cancel ?? (async () => ({ cancelled: true, status: 'CANCELLED' })))() },
      addOrderComment: async () => { calls.comment += 1 },
      verifyPushedOrder: async () => 'unknown' as const,
      probeOrderPresence: async () => 'FOUND' as const,
      reconcileAmbiguousCreate: async () => { calls.reconcile += 1; return { kind: 'ADOPT' as const, externalOrderId: '555', externalOrderNumber: 'WN-555' } },
    },
  }
}

test('CONCURRENT adoption of one parked create: bound exactly once, nothing created, the loser does nothing', { skip }, async (t) => {
  const d = await deps()
  const tag = `ada${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag)
  t.after(() => cleanup(d, s))
  await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'AMBIGUOUS_CREATE', attempts: 1, lastError: 'parked' } })

  const a = connector()
  const b = connector()
  const [ra, rb] = await Promise.all([
    d.sweep.runWmsOrderPushSweepCore(a.connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 50 }),
    d.sweep.runWmsOrderPushSweepCore(b.connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 50 }),
  ])
  const link = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  console.log(`# adopted a=${ra.ambiguousCreateAdopted ?? 0} b=${rb.ambiguousCreateAdopted ?? 0} state=${link.state} id=${link.externalOrderId}`)
  assert.equal((ra.ambiguousCreateAdopted ?? 0) + (rb.ambiguousCreateAdopted ?? 0), 1, 'exactly one sweep bound it')
  assert.equal(link.state, 'PENDING_VERIFY')
  assert.equal(link.externalOrderId, '555')
  assert.equal(link.externalOrderNumber, 'WN-555')
  assert.ok(link.attempts <= 2, 'the create attempt count was reset (the verify pass in the same sweep may spend one verification)')
  assert.ok(link.pushedAt)
  assert.equal(a.calls.push + b.calls.push, 0, 'no order was created')
})

test('REAL PORT: hold / cancel selection reaches MERGED links and skips a link whose hold / cancel was already refused', { skip }, async (t) => {
  const d = await deps()
  const tag = `sel${randomUUID().slice(0, 8)}`
  const held = await seed(d, `${tag}h`, 'ON_HOLD')
  const cancelled = await seed(d, `${tag}c`, 'CANCELLED')
  const refusedHold = await seed(d, `${tag}x`, 'ON_HOLD')
  const refusedCancel = await seed(d, `${tag}y`, 'CANCELLED')
  t.after(async () => { for (const s of [held, cancelled, refusedHold, refusedCancel]) await cleanup(d, s) })
  const base = { connector: 'mintsoft', externalOrderNumber: 'MS-1' }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: held.orderId, state: 'MERGED', externalOrderId: 'surv-1' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: cancelled.orderId, state: 'MERGED', externalOrderId: 'surv-2' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refusedHold.orderId, state: 'SYNCED', externalOrderId: 'x-1', holdNoticeAt: new Date() } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refusedCancel.orderId, state: 'SYNCED', externalOrderId: 'x-2', cancelNoticeAt: new Date() } })

  const port = d.sweep.createPrismaWmsOrderPushPort()
  const holdable = (await port.holdableLinks('mintsoft', 500)).filter((l) => [held.orderId, refusedHold.orderId].includes(l.orderId))
  const cancellable = (await port.cancellableLinks('mintsoft', 500)).filter((l) => [cancelled.orderId, refusedCancel.orderId].includes(l.orderId))
  assert.deepEqual(holdable.map((l) => [l.orderId, l.state]), [[held.orderId, 'MERGED']])
  assert.deepEqual(cancellable.map((l) => [l.orderId, l.state]), [[cancelled.orderId, 'MERGED']])
})

test('REAL PORT: a hold past NEW is ONE attempt - the link stays SYNCED with a notice and the second sweep calls nothing', { skip }, async (t) => {
  const d = await deps()
  const tag = `pst${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'ON_HOLD')
  t.after(() => cleanup(d, s))
  await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'p-1', externalOrderNumber: 'MS-P1', pushedAt: new Date() } })
  const double = connector({ cancel: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) })

  const first = await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  const second = await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  const link = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  console.log(`# first notices=${first.operatorNotices} second notices=${second.operatorNotices ?? 0} cancel calls=${double.calls.cancel} comments=${double.calls.comment} state=${link.state}`)
  assert.equal(first.operatorNotices, 1)
  assert.equal(second.operatorNotices ?? 0, 0)
  assert.equal(double.calls.cancel, 1, 'one warehouse call for the whole life of the notice')
  assert.equal(double.calls.comment, 1, 'one warehouse note')
  assert.equal(link.state, 'SYNCED', 'NOT dead-lettered: dispatch polling carries on')
  assert.ok(link.holdNoticeAt)
  assert.match(String(link.lastError), /past NEW/)

  // ...and the dispatch sweep still polls it (the order is ON_HOLD, which was never excluded).
  const polled = await d.db.wmsOrderPushLink.findMany({ where: { ...d.dispatch.dispatchCandidateWhere('mintsoft'), orderId: s.orderId }, select: { id: true } })
  assert.equal(polled.length, 1)
})

test('REAL PORT: the dispatch candidate set includes an IMS-CANCELLED order only while its link carries a cancel notice', { skip }, async (t) => {
  const d = await deps()
  const tag = `dsp${randomUUID().slice(0, 8)}`
  const withNotice = await seed(d, `${tag}a`, 'CANCELLED')
  const withoutNotice = await seed(d, `${tag}b`, 'CANCELLED')
  t.after(async () => { for (const s of [withNotice, withoutNotice]) await cleanup(d, s) })
  const base = { connector: 'mintsoft', state: 'SYNCED' as const, externalOrderNumber: 'MS-D' }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: withNotice.orderId, externalOrderId: 'd-1', cancelNoticeAt: new Date() } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: withoutNotice.orderId, externalOrderId: 'd-2' } })
  const where = d.dispatch.dispatchCandidateWhere('mintsoft')
  const polled = await d.db.wmsOrderPushLink.findMany({ where: { ...where, orderId: { in: [withNotice.orderId, withoutNotice.orderId] } }, select: { orderId: true } })
  assert.deepEqual(polled.map((l) => l.orderId), [withNotice.orderId])
})

test('REAL DISPATCH DEPS: a despatch is NEVER applied to an order IMS has cancelled - refused, no shipment, order left CANCELLED', { skip }, async (t) => {
  const d = await deps()
  const tag = `apc${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'CANCELLED')
  t.after(() => cleanup(d, s))
  const deps2 = d.dispatch.createPrismaDispatchDeps('mintsoft', connector().connector as never)
  const result = await deps2.applyDispatch(s.orderId, [{ trackingNumber: 'TRK-1', shippingService: 'DPD' }] as never)
  assert.equal(result.success, false)
  assert.match(String((result as { error?: string }).error), /despatched order .* after IMS cancelled or fully refunded it/)
  assert.equal((await d.db.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'CANCELLED')
  assert.equal(await d.db.shipment.count({ where: { orderId: s.orderId } }), 0)
})

test('REAL PORT: every link the cancel pass notices is listed by the inbox predicate - including a FULLY REFUNDED, still-active order', { skip }, async (t) => {
  const d = await deps()
  const tag = `inb${randomUUID().slice(0, 8)}`
  const refunded = await seed(d, `${tag}r`, 'PROCESSING')
  const plain = await seed(d, `${tag}p`, 'PROCESSING')
  const cancelled = await seed(d, `${tag}c`, 'CANCELLED')
  t.after(async () => { for (const s of [refunded, plain, cancelled]) await cleanup(d, s) })
  await d.db.salesOrder.update({ where: { id: refunded.orderId }, data: { refundStatus: 'FULL' } })
  const base = { connector: 'mintsoft', state: 'SYNCED' as const, externalOrderNumber: 'MS-I', cancelNoticeAt: new Date() }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refunded.orderId, externalOrderId: 'i-1' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: plain.orderId, externalOrderId: 'i-2' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: cancelled.orderId, externalOrderId: 'i-3' } })
  const noticed = await d.db.wmsOrderPushLink.findMany({
    where: { orderId: { in: [refunded.orderId, plain.orderId, cancelled.orderId] }, cancelNoticeAt: { not: null }, order: d.sweep.WMS_CANCELLABLE_ORDER_WHERE },
    select: { orderId: true },
  })
  assert.deepEqual(noticed.map((l) => l.orderId).sort(), [refunded.orderId, cancelled.orderId].sort(), 'the plain active order is not cancellable, so never noticed')
  // ...and the cancel pass selects exactly the same orders.
  const cancellable = (await d.sweep.createPrismaWmsOrderPushPort().cancellableLinks('mintsoft', 500)).filter((l) => [refunded.orderId, plain.orderId, cancelled.orderId].includes(l.orderId))
  assert.equal(cancellable.length, 0, 'already noticed, so the pass does not retry them')
})

test('REAL PORT: release then RE-HOLD - the stale hold notice is cleared, and the second hold is sent and noticed again', { skip }, async (t) => {
  const d = await deps()
  const tag = `rhd${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'ON_HOLD')
  t.after(() => cleanup(d, s))
  await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'r-1', externalOrderNumber: 'MS-R1', pushedAt: new Date() } })
  const double = connector({ cancel: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) })
  const run = () => d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })

  assert.equal((await run()).operatorNotices, 1)
  assert.equal(double.calls.cancel, 1)
  assert.equal((await run()).operatorNotices, undefined, 'still the same hold: one attempt')

  await d.db.salesOrder.update({ where: { id: s.orderId }, data: { status: 'PROCESSING' } })
  await run()
  const cleared = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  assert.equal(cleared.holdNoticeAt, null, 'the hold was released: the old notice no longer looks current')
  assert.equal(cleared.holdNoticeCommentAt, null)

  await d.db.salesOrder.update({ where: { id: s.orderId }, data: { status: 'ON_HOLD' } })
  const again = await run()
  assert.equal(again.operatorNotices, 1, 'the second hold is noticed afresh')
  assert.equal(double.calls.cancel, 2, 'and sent to the warehouse again')
  assert.ok((await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })).holdNoticeAt)
})

test('REAL PORT: a failed warehouse note is retried on a later sweep and then stamped delivered; the notice stays throughout', { skip }, async (t) => {
  const d = await deps()
  const tag = `ncm${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'ON_HOLD')
  t.after(() => cleanup(d, s))
  await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'n-1', externalOrderNumber: 'MS-N1', pushedAt: new Date() } })
  const double = connector({ cancel: async () => ({ cancelled: false, status: 'NOT_CANCELLABLE' }) })
  let commentOk = false
  const flaky = { ...double.connector, addOrderComment: async () => { double.calls.comment += 1; if (!commentOk) throw new Error('comments endpoint down') } }
  const run = () => d.sweep.runWmsOrderPushSweepCore(flaky as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })

  await run()
  let link = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  assert.ok(link.holdNoticeAt)
  assert.equal(link.holdNoticeCommentAt, null, 'the note failed: not delivered')
  commentOk = true
  const second = await run()
  assert.equal(second.noticeCommentsRetried, 1)
  link = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  assert.ok(link.holdNoticeAt, 'the notice is still there')
  assert.ok(link.holdNoticeCommentAt, 'and the note is now stamped delivered')
  await run()
  assert.equal(double.calls.comment, 2, 'one failed attempt, one delivery, nothing after')
  assert.equal(double.calls.cancel, 1)
})

test('REAL DISPATCH DEPS: a FULLY REFUNDED, still-active order whose cancel was refused is never fulfilled - the guard reads the cancel intent', { skip }, async (t) => {
  const d = await deps()
  const tag = `rfd${randomUUID().slice(0, 8)}`
  const refunded = await seed(d, `${tag}r`, 'PROCESSING')
  const plain = await seed(d, `${tag}p`, 'PROCESSING')
  t.after(async () => { for (const s of [refunded, plain]) await cleanup(d, s) })
  await d.db.salesOrder.update({ where: { id: refunded.orderId }, data: { refundStatus: 'FULL' } })
  const base = { connector: 'mintsoft', state: 'SYNCED' as const, externalOrderNumber: 'MS-F' }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refunded.orderId, externalOrderId: 'f-1', cancelNoticeAt: new Date() } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: plain.orderId, externalOrderId: 'f-2' } })
  const deps2 = d.dispatch.createPrismaDispatchDeps('mintsoft', connector().connector as never)
  assert.equal(await deps2.cancelIntendedForOrder!(refunded.orderId), true)
  assert.equal(await deps2.cancelIntendedForOrder!(plain.orderId), false, 'control: an ordinary active order is still fulfilled')
  const result = await deps2.applyDispatch(refunded.orderId, [{ trackingNumber: 'TRK-9', shippingService: 'DPD' }] as never)
  assert.equal(result.success, false)
  assert.match(String((result as { error?: string }).error), /after IMS cancelled or fully refunded it/)
  assert.equal(await d.db.shipment.count({ where: { orderId: refunded.orderId } }), 0, 'no shipment, so no stock movement')
  assert.equal((await d.db.salesOrder.findUniqueOrThrow({ where: { id: refunded.orderId } })).status, 'PROCESSING')
})

test('REAL PORT: the delivery stamp is a compare-and-set on the notice, the state and the warehouse order', { skip }, async (t) => {
  const d = await deps()
  const tag = `cas${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'ON_HOLD')
  t.after(() => cleanup(d, s))
  const noticeAt = new Date('2026-06-25T00:00:00.000Z')
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'c-1', externalOrderNumber: 'MS-C1', holdNoticeAt: noticeAt } })
  const port = d.sweep.createPrismaWmsOrderPushPort()
  const stamp = new Date()
  assert.equal(await port.updateLinkIfLinked!(link.id, { state: 'SYNCED', externalOrderId: 'c-1', holdNoticeAt: new Date('2026-06-26T00:00:00.000Z') }, { holdNoticeCommentAt: stamp }), false, 'another notice')
  assert.equal(await port.updateLinkIfLinked!(link.id, { state: 'MERGED', externalOrderId: 'c-1', holdNoticeAt: noticeAt }, { holdNoticeCommentAt: stamp }), false, 'another state')
  assert.equal(await port.updateLinkIfLinked!(link.id, { state: 'SYNCED', externalOrderId: 'other', holdNoticeAt: noticeAt }, { holdNoticeCommentAt: stamp }), false, 'another warehouse order')
  assert.equal((await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })).holdNoticeCommentAt, null)
  assert.equal(await port.updateLinkIfLinked!(link.id, { state: 'SYNCED', externalOrderId: 'c-1', holdNoticeAt: noticeAt }, { holdNoticeCommentAt: stamp }), true)
  assert.ok((await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })).holdNoticeCommentAt)
})

test('REAL DISPATCH DEPS: the guard reads the order\'s CURRENT state - a cancel that was reversed leaves a stale notice that must not refuse a real shipment', { skip }, async (t) => {
  const d = await deps()
  const tag = `rev${randomUUID().slice(0, 8)}`
  const reversed = await seed(d, `${tag}c`, 'CANCELLED')
  const refundOnly = await seed(d, `${tag}f`, 'PROCESSING')
  const refundReversed = await seed(d, `${tag}r`, 'PROCESSING')
  t.after(async () => { for (const s of [reversed, refundOnly, refundReversed]) await cleanup(d, s) })
  await d.db.salesOrder.update({ where: { id: refundOnly.orderId }, data: { refundStatus: 'FULL' } })
  const base = { connector: 'mintsoft', state: 'SYNCED' as const, externalOrderNumber: 'MS-V', cancelNoticeAt: new Date() }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: reversed.orderId, externalOrderId: 'v-1' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refundOnly.orderId, externalOrderId: 'v-2' } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: refundReversed.orderId, externalOrderId: 'v-3' } })
  const deps2 = d.dispatch.createPrismaDispatchDeps('mintsoft', connector().connector as never)
  assert.equal(await deps2.cancelIntendedForOrder!(reversed.orderId), true, 'cancelled now: refused')
  assert.equal(await deps2.cancelIntendedForOrder!(refundOnly.orderId), true, 'fully refunded and undespatched: refused')
  // The cancel is REVERSED (the order is live again) while the push sweep has not yet cleared the notice.
  await d.db.salesOrder.update({ where: { id: reversed.orderId }, data: { status: 'PROCESSING' } })
  assert.equal(await deps2.cancelIntendedForOrder!(reversed.orderId), false, 'the stale notice no longer refuses a shipment')
  const applied = await deps2.applyDispatch(reversed.orderId, [{ trackingNumber: 'TRK-V', shippingService: 'DPD' }] as never)
  assert.doesNotMatch(String((applied as { error?: string }).error ?? ''), /cancelled or fully refunded/, 'the dispatch reaches the ordinary path instead of the cancel refusal')
  // A full refund that was reversed behaves the same.
  assert.equal(await deps2.cancelIntendedForOrder!(refundReversed.orderId), false)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The warehouse line ids recorded for a pushed order, and the removal of a cancelled merged order's lines (REAL PORT, REAL DATABASE).

test('REAL PORT: the line ids read back after a create are recorded, an amendment replaces the set, and they go with the link', { skip }, async (t) => {
  const d = await deps()
  const tag = `itm${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag)
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'o-1', externalOrderNumber: 'MS-I1', pushedAt: new Date() } })
  const port = d.sweep.createPrismaWmsOrderPushPort()

  assert.deepEqual(await port.readOrderItems!(link.id), [], 'an order pushed before the ids were recorded has none')
  const first = [{ externalItemId: '11', sku: 'A', quantity: 2 }, { externalItemId: '12', sku: 'A', quantity: 1 }]
  await port.replaceOrderItems!(s.orderId, 'o-1', first)
  assert.deepEqual((await port.readOrderItems!(link.id)).sort((a, b) => a.externalItemId.localeCompare(b.externalItemId)), first, 'a shared SKU stays two rows')
  // A second call with overlapping ids neither duplicates nor fails (the unique key), and REPLACES the set.
  await port.replaceOrderItems!(s.orderId, 'o-1', [{ externalItemId: '12', sku: 'A', quantity: 1 }, { externalItemId: '13', sku: 'B', quantity: 4 }])
  assert.deepEqual((await port.readOrderItems!(link.id)).map((r) => r.externalItemId).sort(), ['12', '13'])
  await port.dropOrderItems!(link.id, ['12'])
  assert.deepEqual((await port.readOrderItems!(link.id)).map((r) => r.externalItemId), ['13'])
  await port.replaceOrderItems!(s.orderId, 'o-1', [])
  assert.deepEqual(await port.readOrderItems!(link.id), [], 'an empty set clears')
  // An order with no link writes nothing and does not throw.
  await port.replaceOrderItems!(`missing-${tag}`, 'o-9', first)

  await port.replaceOrderItems!(s.orderId, 'o-1', first)
  await d.db.wmsOrderPushLink.delete({ where: { id: link.id } })
  assert.equal(await d.db.wmsOrderPushItem.count({ where: { linkId: link.id } }), 0, 'the rows are deleted with the link')
})

test('REAL PORT: a cancelled order merged into a survivor has ITS recorded lines removed, the link becomes CANCELLED, and the survivor is not cancelled', { skip }, async (t) => {
  const d = await deps()
  const tag = `rem${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'CANCELLED')
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'MERGED', externalOrderId: 'surv-1', externalOrderNumber: 'MS-E+MS-D', pushedAt: new Date() } })
  const stored = [{ externalItemId: '3603106', sku: '243632999', quantity: 2 }, { externalItemId: '3603107', sku: '923663020', quantity: 1 }]
  await d.db.wmsOrderPushItem.createMany({ data: stored.map((i) => ({ linkId: link.id, externalOrderId: 'o-1', ...i })) })

  const seen: { removed?: unknown; cancelled: string[]; comments: string[] } = { cancelled: [], comments: [] }
  const double = {
    pushOrder: async () => { throw new Error('must not create') },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async (id: string) => { seen.cancelled.push(id); return { cancelled: true, status: 'CANCELLED' } },
    addOrderComment: async (_id: string, comment: string) => { seen.comments.push(comment) },
    cancelMergedOrder: async (id: string) => { seen.cancelled.push(id); return { cancelled: true, status: 'CANCELLED' } },
    removeOrderItems: async (id: string, items: unknown) => { seen.removed = { id, items }; return { kind: 'REMOVED' as const, removed: items as typeof stored } },
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'FOUND' as const,
  }
  const result = await d.sweep.runWmsOrderPushSweepCore(double as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  const after = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  console.log(`# state=${after.state} cancelled=${result.cancelled} comments=${seen.comments.length}`)
  assert.deepEqual((seen.removed as { id: string; items: unknown[] }).id, 'surv-1')
  assert.deepEqual((seen.removed as { items: unknown[] }).items, stored)
  assert.deepEqual(seen.cancelled, [], 'the survivor was never cancelled')
  assert.equal(after.state, 'CANCELLED')
  assert.ok(after.cancelledAt)
  assert.equal(after.cancelNoticeAt, null, 'no notice')
  assert.equal(seen.comments.length, 1)
  assert.match(seen.comments[0], new RegExp(`MSO-${tag}`), 'the note names the IMS order')
  assert.match(seen.comments[0], /2 x 243632999 \(line 3603106\), 1 x 923663020 \(line 3603107\)/)
})

test('REAL PORT: a refused removal raises the notice with what was removed and what remains, forgets the removed line and keeps the link live', { skip }, async (t) => {
  const d = await deps()
  const tag = `ref${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'CANCELLED')
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'MERGED', externalOrderId: 'surv-2', externalOrderNumber: 'MS-E+MS-D', pushedAt: new Date() } })
  const a = { externalItemId: '1', sku: 'A', quantity: 2 }
  const b = { externalItemId: '2', sku: 'B', quantity: 1 }
  await d.db.wmsOrderPushItem.createMany({ data: [a, b].map((i) => ({ linkId: link.id, externalOrderId: 'o-2', ...i })) })
  const double = {
    pushOrder: async () => { throw new Error('must not create') },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async () => { throw new Error('the survivor must not be cancelled') },
    cancelMergedOrder: async () => { throw new Error('the survivor must not be cancelled') },
    addOrderComment: async () => {},
    removeOrderItems: async () => ({ kind: 'REFUSED' as const, reason: 'deleting 1 x B (line 2) failed (boom)', removed: [a], remaining: [b] }),
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'FOUND' as const,
  }
  const result = await d.sweep.runWmsOrderPushSweepCore(double as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  const after = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { orderId: s.orderId } })
  assert.equal(result.operatorNotices, 1)
  assert.equal(after.state, 'MERGED', 'the link stays live and polled')
  assert.ok(after.cancelNoticeAt)
  assert.match(String(after.lastError), /REMOVED so far: 2 x A \(line 1\)/)
  assert.match(String(after.lastError), /STILL ON THE MERGED ORDER[^]*1 x B \(line 2\)/)
  assert.deepEqual((await d.db.wmsOrderPushItem.findMany({ where: { linkId: link.id } })).map((r) => r.externalItemId), ['2'], 'the removed line is forgotten')
})

test('REAL PORT: ids marked untrustworthy read as none until a verified replacement clears the mark in the same write', { skip }, async (t) => {
  const d = await deps()
  const tag = `uns${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag)
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'o-u', pushedAt: new Date() } })
  const port = d.sweep.createPrismaWmsOrderPushPort()
  const ids = [{ externalItemId: '71', sku: 'A', quantity: 1 }]
  await port.replaceOrderItems!(s.orderId, 'o-u', ids)
  assert.deepEqual(await port.readOrderItems!(link.id), ids)
  await port.setLineIdsUnsafe!(link.id, true)
  assert.deepEqual(await port.readOrderItems!(link.id), [], 'marked: the stored rows are not trusted')
  assert.equal(await d.db.wmsOrderPushItem.count({ where: { linkId: link.id } }), 1, 'the rows are still there; only the trust is gone')
  await port.replaceOrderItems!(s.orderId, 'o-u', [{ externalItemId: '72', sku: 'B', quantity: 2 }])
  assert.deepEqual((await port.readOrderItems!(link.id)).map((r) => r.externalItemId), ['72'])
  assert.equal((await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })).lineSnapshotUnsafeAt, null)
})

test('REAL INBOX SELECTION: a live link with an amendment notice is listed, and is gone once the notice is cleared', { skip }, async (t) => {
  const d = await deps()
  const { WMS_PUSH_INBOX_WHERE } = await import('@/lib/domain/wms/push-recovery-affordance')
  const tag = `inb${randomUUID().slice(0, 8)}`
  const withNotice = await seed(d, `${tag}a`)
  const without = await seed(d, `${tag}b`)
  t.after(async () => { for (const s of [withNotice, without]) await cleanup(d, s) })
  const base = { connector: 'mintsoft', state: 'MERGED' as const, externalOrderId: 'surv-i' }
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: withNotice.orderId, amendNoticeAt: new Date() } })
  await d.db.wmsOrderPushLink.create({ data: { ...base, orderId: without.orderId } })
  const listed = async () => (await d.db.wmsOrderPushLink.findMany({ where: { AND: [WMS_PUSH_INBOX_WHERE, { orderId: { in: [withNotice.orderId, without.orderId] } }] } })).map((l) => l.orderId)
  assert.deepEqual(await listed(), [withNotice.orderId])
  await d.db.wmsOrderPushLink.updateMany({ where: { orderId: withNotice.orderId, amendNoticeAt: { not: null } }, data: { amendNoticeAt: null } })
  assert.deepEqual(await listed(), [])
})

test('REAL PORT, TWO AMENDMENTS OVERLAP: the older one finishing late cannot store its snapshot or clear the mark; the merged removal still refuses', { skip }, async (t) => {
  const d = await deps()
  for (const bCleansUp of [false, true]) {
    const tag = `gen${bCleansUp ? 'c' : 'n'}${randomUUID().slice(0, 8)}`
    const s = await seed(d, tag, 'CANCELLED')
    t.after(() => cleanup(d, s))
    const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'MERGED', externalOrderId: 'surv-g', externalOrderNumber: 'MS-E+MS-D', pushedAt: new Date() } })
    const port = d.sweep.createPrismaWmsOrderPushPort()
    const old = [{ externalItemId: '1', sku: 'A', quantity: 1 }]
    await port.replaceOrderItems!(s.orderId, 'o-g', old)
    // A starts and verifies its read-back; B starts after it, changes lines and fails partway.
    const tokenA = (await port.setLineIdsUnsafe!(link.id, true))?.token
    await d.db.wmsOrderPushLink.update({ where: { id: link.id }, data: { amendLeaseExpiresAt: new Date(Date.now() - 1000) } }) // A's lease expired (it stalled)
    const tokenB = (await port.setLineIdsUnsafe!(link.id, true))?.token
    assert.ok(tokenA && tokenB && tokenA !== tokenB)
    assert.equal(await port.setLineIdsUnsafe!(link.id, true), null, 'a live lease refuses a third owner')
    if (bCleansUp) await port.replaceOrderItems!(s.orderId, "o-g", [], tokenB!) // B's cleanup succeeds: no snapshot
    // A now finishes with its OLDER snapshot and tries to clear the mark.
    await port.replaceOrderItems!(s.orderId, "o-g", old, tokenA!)
    await port.setLineIdsUnsafe!(link.id, false, tokenA!)
    const row = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
    if (bCleansUp) {
      assert.equal(await d.db.wmsOrderPushItem.count({ where: { linkId: link.id } }), 0, 'A\'s older snapshot was NOT stored')
    } else {
      assert.ok(row.lineSnapshotUnsafeAt, 'the mark is still set')
      assert.equal(row.lineSnapshotToken, tokenB)
    }
    assert.deepEqual(await port.readOrderItems!(link.id), [], 'no trusted ids')
    // The cancel of the merged order therefore removes nothing and raises the notice.
    const calls = { removed: 0, cancelled: 0 }
    const double = {
      pushOrder: async () => { throw new Error('must not create') },
      updateOrder: async () => ({ updated: true, status: 'NEW' }),
      cancelOrder: async () => { calls.cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
      cancelMergedOrder: async () => { calls.cancelled += 1; return { cancelled: true, status: 'CANCELLED' } },
      removeOrderItems: async () => { calls.removed += 1; return { kind: 'REMOVED' as const, removed: old } },
      addOrderComment: async () => {},
      verifyPushedOrder: async () => 'ours' as const,
      probeOrderPresence: async () => 'FOUND' as const,
    }
    const result = await d.sweep.runWmsOrderPushSweepCore(double as never, 'mintsoft', port, { batchSize: 500 })
    assert.equal(calls.removed + calls.cancelled, 0)
    assert.ok((result.operatorNotices ?? 0) >= 1)
  }
})

test('REAL PORT, LEASE: a second sweep cannot amend a link while the first holds the lease (its remote write delayed); a merged cancel meanwhile cannot settle; an expired lease is taken over with the mark still set', { skip }, async (t) => {
  const d = await deps()
  const tag = `lse${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag, 'PROCESSING')
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'o-l', externalOrderNumber: 'MS-L', pushedAt: new Date('2026-01-01T00:00:00Z') } })
  const old = [{ externalItemId: '1', sku: 'A', quantity: 1 }]
  const port = d.sweep.createPrismaWmsOrderPushPort()
  await port.replaceOrderItems!(s.orderId, 'o-l', old)

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls = { a: 0, b: 0 }
  const mk = (who: 'a' | 'b', delay: boolean) => ({
    pushOrder: async () => { throw new Error('must not create') },
    updateOrder: async () => { calls[who] += 1; if (delay) await gate; return { updated: true, status: 'NEW', items: [{ externalItemId: who === 'a' ? '2' : '3', sku: 'A', quantity: 1 }] } },
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
    addOrderComment: async () => {},
    verifyPushedOrder: async () => 'ours' as const,
    probeOrderPresence: async () => 'FOUND' as const,
  })
  // Sweep A starts its amendment and its remote write is delayed.
  const runA = d.sweep.runWmsOrderPushSweepCore(mk('a', true) as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  for (let i = 0; i < 100 && calls.a === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls.a, 1, 'A is inside its remote amendment')
  // Sweep B runs now: the link is leased, so it is skipped.
  await d.sweep.runWmsOrderPushSweepCore(mk('b', false) as never, 'mintsoft', d.sweep.createPrismaWmsOrderPushPort(), { batchSize: 500 })
  assert.equal(calls.b, 0, 'B never amended the leased link')
  assert.deepEqual(await port.readOrderItems!(link.id), [], 'while the lease is live no ids are trusted: a merged removal cannot settle')
  release()
  await runA
  const after = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
  assert.equal(after.amendLeaseOwner, null, 'the lease was released with the snapshot write')
  assert.deepEqual((await port.readOrderItems!(link.id)).map((r) => r.externalItemId), ['2'])

  // An EXPIRED lease is taken over: the mark is set again for the new owner, and the old owner's late write is a no-op.
  const tokenOld = (await port.setLineIdsUnsafe!(link.id, true))?.token
  assert.ok(tokenOld)
  await d.db.wmsOrderPushLink.update({ where: { id: link.id }, data: { amendLeaseExpiresAt: new Date(Date.now() - 1000) } })
  const tokenNew = (await port.setLineIdsUnsafe!(link.id, true))?.token
  assert.ok(tokenNew && tokenNew !== tokenOld)
  await port.replaceOrderItems!(s.orderId, 'o-l', old, tokenOld!)
  assert.deepEqual(await port.readOrderItems!(link.id), [], 'the stale owner changed nothing; the new owner\'s mark stands')
  assert.ok((await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })).lineSnapshotUnsafeAt)
})

test('REAL PORT: a second acquisition reports that the mark was ALREADY set; the first reports it was not', { skip }, async (t) => {
  const d = await deps()
  const tag = `was${randomUUID().slice(0, 8)}`
  const s = await seed(d, tag)
  t.after(() => cleanup(d, s))
  const link = await d.db.wmsOrderPushLink.create({ data: { orderId: s.orderId, connector: 'mintsoft', state: 'SYNCED', externalOrderId: 'o-w', pushedAt: new Date() } })
  const port = d.sweep.createPrismaWmsOrderPushPort()
  const first = await port.setLineIdsUnsafe!(link.id, true)
  assert.equal(first!.wasUnsafe, false)
  // The first amendment is interrupted: its lease expires with the mark still set.
  await d.db.wmsOrderPushLink.update({ where: { id: link.id }, data: { amendLeaseExpiresAt: new Date(Date.now() - 1000) } })
  const second = await port.setLineIdsUnsafe!(link.id, true)
  assert.equal(second!.wasUnsafe, true, 'the earlier mark is reported, so a no-op retry must not clear it')
  await port.releaseAmendLease!(link.id, second!.token)
  const row = await d.db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
  assert.ok(row.lineSnapshotUnsafeAt, 'releasing the lease leaves the mark set')
  assert.equal(row.amendLeaseOwner, null)
  assert.deepEqual(await port.readOrderItems!(link.id), [])
})
