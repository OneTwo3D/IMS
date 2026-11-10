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
  assert.ok(link.attempts <= 1, 'the create attempt count was reset (the verify pass in the same sweep may spend one verification)')
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
  assert.match(String((result as { error?: string }).error), /despatched order .* after IMS cancelled it/)
  assert.equal((await d.db.salesOrder.findUniqueOrThrow({ where: { id: s.orderId } })).status, 'CANCELLED')
  assert.equal(await d.db.shipment.count({ where: { orderId: s.orderId } }), 0)
})
