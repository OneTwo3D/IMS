import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * WooCommerce ORDER-EDIT FOLLOW-UPS ON A REAL DATABASE (o3d-0ged2).
 *
 *   MED-1  an order on which IMS holds only a DEPOSIT (a receipt, `paidAt` empty) is not "paid in WooCommerce": the task carries its own wording (IMS holds payments of P against a total of Y;
 *          WooCommerce now shows X; decide), with no gateway text; refund payment rows and a receipt a chargeback took back to nothing do not count as a payment held
 *   MED-2  a new WC_PAID_INCREASE task closes the order's earlier open ones (done by the system); a state the order RETURNS to after a Done task raises a fresh task; the same state again raises nothing
 *
 * Every row is this test's own (fresh ids) and every read is scoped by order id, so rows other files leave behind change nothing here. Nothing reaches a network.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

async function world() {
  loadEnv()
  const [{ db }, amend, tasks] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/connectors/woocommerce/sync/order-amendment'),
    import('@/lib/domain/wms/operator-tasks'),
  ])
  return { db, amend, tasks }
}
type World = Awaited<ReturnType<typeof world>>

async function order(w: World, tag: string, over: { paidAt?: Date | null } = {}) {
  const id = `${tag}${randomUUID().slice(0, 8)}`
  await w.db.salesOrder.create({
    data: {
      id, orderNumber: `IMSTEST-${id}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 120, subtotalBase: 100, totalBase: 120, paidAt: over.paidAt ?? null,
      lines: { create: [{ description: 'Red', sku: 'RED', externalLineItemId: 77, qty: 4, unitPriceForeign: 25, unitPriceBase: 25, totalForeign: 100, totalBase: 100 }] },
    },
  })
  return id
}
const cleanup = (w: World, id: string) => async () => {
  await w.db.activityLog.deleteMany({ where: { entityId: id } })
  await w.db.payment.deleteMany({ where: { orderId: id } })
  await w.db.salesOrderRefund.deleteMany({ where: { orderId: id } })
  await w.db.salesOrderLine.deleteMany({ where: { orderId: id } })
  await w.db.salesOrder.deleteMany({ where: { id } })
}

function wcPayload(qty: number, total: string, paid: boolean) {
  return { id: 9, number: '1009', date_modified_gmt: '2026-11-21T10:00:00', date_paid_gmt: paid ? '2026-11-18T10:00:00' : null, total, line_items: [{ id: 77, quantity: qty, sku: 'RED' }] } as never
}
const qtyDiff = (qty: number) => [{ field: 'LINE_QUANTITY' as const, label: 'Quantity of RED changed in WooCommerce', woocommerce: String(qty), ims: '4' }]

/** The real facts, locks, task table and gate-free flow; only the pieces that need a divergence row or a warehouse are replaced. */
function deps(w: World) {
  return {
    ...w.amend.defaultAmendmentDeps,
    isEnabled: async () => true,
    isUnpaidRewriteEnabled: async () => false,
    claim: async () => true,
    releaseClaim: async () => undefined,
    warehouseLink: async () => ({ connector: 'mintsoft', externalOrderId: `EXT-${randomUUID().slice(0, 6)}`, externalOrderNumber: 'W-1' }),
    warehouseGate: async () => ({ ok: true as const, externalOrderId: null }),
  }
}

test('MED-1: loadFacts counts receipts only (a deposit counts; refund payment rows and a charged-back receipt do not)', SKIP, async (t) => {
  const w = await world()
  const none = await order(w, 'm1n')
  const refundOnly = await order(w, 'm1r')
  const chargedBack = await order(w, 'm1c')
  const deposit = await order(w, 'm1d')
  const paid = await order(w, 'm1p', { paidAt: new Date() })
  for (const id of [none, refundOnly, chargedBack, deposit, paid]) t.after(cleanup(w, id))
  const refund = await w.db.salesOrderRefund.create({ data: { orderId: refundOnly, totalForeign: 10, totalBase: 10 } })
  await w.db.payment.create({ data: { orderId: refundOnly, refundId: refund.id, amount: -10, currency: 'GBP' } })
  await w.db.payment.createMany({ data: [{ orderId: chargedBack, amount: 50, currency: 'GBP' }, { orderId: chargedBack, amount: -50, currency: 'GBP' }] })
  await w.db.payment.create({ data: { orderId: deposit, amount: 50, currency: 'GBP' } })
  await w.db.payment.create({ data: { orderId: paid, amount: 120, currency: 'GBP' } })

  const facts = async (id: string) => (await w.amend.defaultAmendmentDeps.loadFacts(id))!
  assert.equal((await facts(none)).imsPaymentUnrecorded, false)
  assert.equal((await facts(refundOnly)).imsPaymentUnrecorded, false, 'a credit-note payment row is not money the customer paid')
  assert.equal((await facts(chargedBack)).imsPaymentUnrecorded, false, 'a receipt taken back to nothing is not a payment held')
  const dep = await facts(deposit)
  assert.equal(dep.imsPaymentUnrecorded, true)
  assert.equal(Number(dep.imsReceiptTotal), 50)
  assert.equal((await facts(paid)).imsPaymentUnrecorded, false, 'an order IMS already holds as paid is not "unrecorded"')
})

test('MED-1: a DEPOSIT order changed in WooCommerce gets the part-payment wording, not the gateway text, with WooCommerce\'s total as the total and IMS\'s receipts as the payment', SKIP, async (t) => {
  const w = await world()
  const id = await order(w, 'm1o')
  t.after(cleanup(w, id))
  await w.db.payment.create({ data: { orderId: id, amount: 50, currency: 'GBP' } })
  const out = await w.amend.applyWcOrderAmendment(id, wcPayload(6, '170.00', false), qtyDiff(6), 'fp', deps(w))
  assert.equal(out.kind, 'applied')
  const tasks = await w.db.wmsOperatorTask.findMany({ where: { orderId: id, reason: 'WC_PAID_INCREASE' } })
  assert.equal(tasks.length, 1)
  const text = tasks[0]!.queryText
  assert.match(text, /IMS holds payments of 50\.00 GBP against a total of 120\.00 GBP; WooCommerce now shows 170\.00 GBP/)
  assert.match(text, /collect the difference.*refund.*edit the IMS order/)
  assert.doesNotMatch(text, /gateway/i, 'there is no gateway charge to check on a deposit')
  assert.doesNotMatch(text, /WooCommerce shows it paid/)
})

test('MED-2: a new paid-increase task closes the earlier open one (by the system); returning to a Done state raises a fresh task; the same state again raises nothing', SKIP, async (t) => {
  const w = await world()
  const id = await order(w, 'm2o')
  t.after(cleanup(w, id))
  const d = deps(w)
  const open = async () => (await w.db.wmsOperatorTask.findMany({ where: { orderId: id, reason: 'WC_PAID_INCREASE', status: 'OPEN' } })).length
  const all = () => w.db.wmsOperatorTask.findMany({ where: { orderId: id, reason: 'WC_PAID_INCREASE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const A = () => w.amend.applyWcOrderAmendment(id, wcPayload(6, '170.00', true), qtyDiff(6), 'fpA', d) // 2 more
  const B = () => w.amend.applyWcOrderAmendment(id, wcPayload(2, '70.00', true), qtyDiff(2), 'fpB', d) // 2 fewer

  assert.equal((await A()).kind, 'applied')
  assert.equal(await open(), 1)
  assert.equal((await B()).kind, 'applied')
  let rows = await all()
  assert.equal(rows.length, 2)
  assert.equal(await open(), 1, 'only the newest task is open: "2 more, collect" and "2 fewer, refund" are never both open')
  assert.equal(rows[0]!.status, 'DONE')
  assert.equal(rows[0]!.doneBy, w.tasks.WC_PAID_INCREASE_SUPERSEDED_ACTOR)
  assert.notEqual(rows[0]!.doneAt, null)
  assert.equal(rows[1]!.status, 'OPEN')
  assert.match(rows[1]!.queryText, /2 fewer/)

  // BACK TO THE FIRST STATE, whose task is Done: a fresh task, and the second one is closed.
  assert.equal((await A()).kind, 'applied')
  rows = await all()
  assert.equal(rows.length, 3, 'a state with a Done task raises a fresh one when the order returns to it')
  assert.equal(await open(), 1)
  const newest = rows.filter((r) => r.status === 'OPEN')[0]!
  assert.match(newest.queryText, /2 more/)
  assert.equal(rows.find((r) => r.id === newest.id)!.contentHash !== rows[0]!.contentHash, true, 'its own dedupe key')

  // The SAME state delivered again, and again after a person marks it Done: still one task per state.
  await A()
  assert.equal((await all()).length, 3)
  await w.db.wmsOperatorTask.update({ where: { id: newest.id }, data: { status: 'DONE', doneAt: new Date(), doneBy: 'someone' } })
  await A()
  assert.equal((await all()).length, 3, 'a Done task for the order\'s newest state is not re-raised by the same delivery')
  assert.equal(await open(), 0)
})

test('MED-2: the supersede touches only this order\'s paid-increase tasks (other orders and other reasons stay open)', SKIP, async (t) => {
  const w = await world()
  const a = await order(w, 'm2a')
  const b = await order(w, 'm2b')
  t.after(cleanup(w, a))
  t.after(cleanup(w, b))
  const base = { connector: 'mintsoft', externalOrderId: 'EXT-1', queryText: 'x' }
  await w.tasks.raiseWmsOperatorTask(w.db, { ...base, orderId: a, reason: 'WC_EDIT_AFTER_PICKING', dedupeBasis: 'k' })
  await w.tasks.raiseWcPaidIncreaseTask(w.db, { ...base, orderId: b, dedupeBasis: 'b1' })
  await w.tasks.raiseWcPaidIncreaseTask(w.db, { ...base, orderId: a, dedupeBasis: 'a1' })
  await w.tasks.raiseWcPaidIncreaseTask(w.db, { ...base, orderId: a, dedupeBasis: 'a2' })
  const status = async (orderId: string, reason: 'WC_PAID_INCREASE' | 'WC_EDIT_AFTER_PICKING') => (await w.db.wmsOperatorTask.findMany({ where: { orderId, reason }, select: { status: true } })).map((r) => r.status).sort()
  assert.deepEqual(await status(a, 'WC_PAID_INCREASE'), ['DONE', 'OPEN'])
  assert.deepEqual(await status(a, 'WC_EDIT_AFTER_PICKING'), ['OPEN'])
  assert.deepEqual(await status(b, 'WC_PAID_INCREASE'), ['OPEN'])
})
