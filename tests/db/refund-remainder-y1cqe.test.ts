import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * Refund-remainder tasks against a real database (review of #1077, round 2):
 *  - the refund totals exclude SOFT-DELETED refunds, so a deleted refund of returned units raises (or keeps raising) no "send the remainder" task;
 *  - a new remainder task SUPERSEDES an open earlier one for the same order, so an open "send 1" plus a later "send 2" never lets an operator ask for 3.
 * Rows are committed (the code under test uses the shared client) and removed again in `after`. Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/refund-remainder-y1cqe.test.ts would have been skipped.')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const mod = await import('../../lib/domain/wms/refund-remainder')
  return { db, mod }
}

async function seed(db: Awaited<ReturnType<typeof load>>['db']) {
  const suffix = randomUUID().slice(0, 8)
  const product = await db.product.create({ data: { sku: `Y1-${suffix}`, name: 'y1', type: 'SIMPLE' }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `Y1-${suffix}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: '100', totalForeign: '100', subtotalBase: '100', taxBase: '0', totalBase: '100',
      lines: { create: [{ productId: product.id, sku: `Y1-${suffix}`, description: 'l', qty: '10', unitPriceForeign: '10', unitPriceBase: '10', taxForeign: '0', taxBase: '0', totalForeign: '100', totalBase: '100' }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  return { productId: product.id, orderId: order.id, lineId: order.lines[0]!.id, sku: `Y1-${suffix}` }
}

async function cleanup(db: Awaited<ReturnType<typeof load>>['db'], fx: { productId: string; orderId: string }) {
  await db.wmsOperatorTask.deleteMany({ where: { orderId: fx.orderId } })
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } })
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } })
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } })
  await db.salesOrder.deleteMany({ where: { id: fx.orderId } })
  await db.product.deleteMany({ where: { id: fx.productId } })
}

test('[db] y1cqe 6: refundTotals excludes a soft-deleted refund (gross and netted); a live refund still counts', { skip }, async (t) => {
  const { db, mod } = await load()
  const fx = await seed(db)
  t.after(() => cleanup(db, fx))
  const wh = await db.warehouse.create({ data: { code: `Y1${randomUUID().slice(0, 6)}`, name: 'y1' }, select: { id: true } })
  t.after(async () => { await db.warehouse.deleteMany({ where: { id: wh.id } }) })
  const mk = async (qty: string, deletedAt: Date | null) => db.salesOrderRefund.create({
    data: {
      orderId: fx.orderId, totalForeign: '10', totalBase: '10', returnWarehouseId: wh.id, deletedAt,
      lines: { create: [{ salesOrderLineId: fx.lineId, productId: fx.productId, description: 'r', qty, unitPriceBase: '10', totalBase: '10' }] },
    },
  })
  await mk('2', new Date())
  const deletedOnly = await mod.defaultRefundRemainderDeps.refundTotals(fx.orderId)
  assert.equal(Number(deletedOnly.gross.get(fx.lineId) ?? 0), 0, 'a deleted refund adds no gross refunded units')
  assert.equal(Number(deletedOnly.netted.get(fx.lineId) ?? 0), 0, 'a deleted refund adds no netted units')
  await mk('1', null)
  const withLive = await mod.defaultRefundRemainderDeps.refundTotals(fx.orderId)
  assert.equal(Number(withLive.gross.get(fx.lineId)), 1, 'only the live refund counts')
})

test('[db] y1cqe 7: a new remainder task supersedes the open earlier one for the order: "send 1" then "send 2" leaves ONE open task', { skip }, async (t) => {
  const { db, mod } = await load()
  const fx = await seed(db)
  t.after(() => cleanup(db, fx))
  const connector = `y1cqe-${randomUUID().slice(0, 6)}`
  let returned = 1
  const deps: import('../../lib/domain/wms/refund-remainder').RefundRemainderDeps = {
    ...mod.defaultRefundRemainderDeps,
    isEnabled: async () => true,
    readCursor: undefined,
    writeCursor: undefined,
    candidates: async () => [{
      orderId: fx.orderId, orderNumber: 'Y1', externalOrderId: 'MS-Y1', externalOrderNumber: 'W-Y1',
      lines: [{ id: fx.lineId, sku: fx.sku, productId: fx.productId, qty: 10 }],
    }],
    // 10 ordered, 5 shipped; `returned` of the shipped units were returned and refunded (gross = netted + returned).
    refundTotals: async () => ({ gross: new Map([[fx.lineId, returned]]), netted: new Map([[fx.lineId, 0]]) }),
    shipped: async () => new Map([[fx.lineId, 5]]),
  }
  assert.deepEqual(await mod.raiseRefundRemainderTasks(connector, 50, deps), { raised: 1, failed: 0 })
  const open = () => db.wmsOperatorTask.findMany({ where: { orderId: fx.orderId, connector, status: 'OPEN' }, select: { queryText: true } })
  assert.equal((await open()).length, 1)
  assert.match((await open())[0]!.queryText, new RegExp(`1 x ${fx.sku}`))

  // A repeat of the same fact raises nothing and closes nothing.
  assert.deepEqual(await mod.raiseRefundRemainderTasks(connector, 50, deps), { raised: 0, failed: 0 })
  assert.equal((await open()).length, 1)

  returned = 2
  assert.deepEqual(await mod.raiseRefundRemainderTasks(connector, 50, deps), { raised: 1, failed: 0 })
  const stillOpen = await open()
  assert.equal(stillOpen.length, 1, 'the earlier "send 1" is closed, so the operator is not asked for 3')
  assert.match(stillOpen[0]!.queryText, new RegExp(`2 x ${fx.sku}`))
  const superseded = await db.wmsOperatorTask.findMany({ where: { orderId: fx.orderId, connector, status: 'DONE' }, select: { doneBy: true, queryText: true } })
  assert.equal(superseded.length, 1)
  assert.equal(superseded[0]!.doneBy, mod.REFUND_REMAINDER_SUPERSEDED_ACTOR)
  assert.match(superseded[0]!.queryText, new RegExp(`1 x ${fx.sku}`))
})
