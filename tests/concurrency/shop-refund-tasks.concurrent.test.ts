import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zvec.19 ON A REAL POSTGRES: "REFUND IN WOOCOMMERCE".
 *
 *   arm 1  an IMS refund on a WooCommerce order raises ONE task (gross, currency, credit note), once however often the writer's path is
 *          re-entered; a refund WITH a storefront refund id (WOO_SYNC) raises none, and an order with no WooCommerce link raises none
 *   arm 2  the person's later WooCommerce refund of the same amount is LINKED: no second credit note, the task resolved; ten concurrent
 *          deliveries of it still link it once and raise nothing
 *   arm 3  a refund of a different amount is NOT guessed: no credit note, no link, a QUARANTINED park with the figures, the task still open
 *   arm 4  a refund that began in WooCommerce (no open task) is imported exactly as before: the writer is called once
 *
 * WooCommerce and Xero are never contacted: the sync's writer is an injected double, and nothing here reaches the network.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

async function world() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ Prisma, PrismaClient }, { PrismaPg }, refunds, sync] = await Promise.all([
    import('@/app/generated/prisma/client'),
    import('@prisma/adapter-pg'),
    import('@/lib/domain/sales/refund-service'),
    import('@/lib/connectors/woocommerce/sync/refund-sync'),
  ])
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 12 }) })
  return { Prisma, db, createSalesOrderRefund: refunds.createSalesOrderRefund, syncWcRefund: sync.syncWcRefund }
}
type World = Awaited<ReturnType<typeof world>>

async function seedOrder(w: World, opts: { wc: boolean }) {
  const suffix = randomUUID().slice(0, 8)
  const taxRate = await w.db.taxRate.create({ data: { name: `SR-VAT-${suffix}`, rate: new w.Prisma.Decimal('0.2'), accountingTaxType: 'OUTPUT2', reverseCharge: false }, select: { id: true } })
  const wcOrderId = String(Number.parseInt(randomUUID().replace(/\D/g, '').slice(0, 8), 10))
  const order = await w.db.salesOrder.create({
    data: {
      orderNumber: `SR-${suffix}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: new w.Prisma.Decimal('1'),
      subtotalForeign: new w.Prisma.Decimal('200'), totalForeign: new w.Prisma.Decimal('240'), subtotalBase: new w.Prisma.Decimal('200'),
      taxForeign: new w.Prisma.Decimal('40'), taxBase: new w.Prisma.Decimal('40'), shippingForeign: new w.Prisma.Decimal('0'), totalBase: new w.Prisma.Decimal('240'),
      pricesIncludeVat: false, taxRatePercent: new w.Prisma.Decimal('0.2'),
      lines: { create: [
        { description: 'Widget', qty: new w.Prisma.Decimal('1'), unitPriceForeign: new w.Prisma.Decimal('100'), unitPriceBase: new w.Prisma.Decimal('100'), taxForeign: new w.Prisma.Decimal('20'), taxBase: new w.Prisma.Decimal('20'), totalForeign: new w.Prisma.Decimal('100'), totalBase: new w.Prisma.Decimal('100'), taxRateId: taxRate.id },
        { description: 'Gadget', qty: new w.Prisma.Decimal('1'), unitPriceForeign: new w.Prisma.Decimal('100'), unitPriceBase: new w.Prisma.Decimal('100'), taxForeign: new w.Prisma.Decimal('20'), taxBase: new w.Prisma.Decimal('20'), totalForeign: new w.Prisma.Decimal('100'), totalBase: new w.Prisma.Decimal('100'), taxRateId: taxRate.id },
      ] },
      ...(opts.wc ? { shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: wcOrderId } } } : {}),
    },
    select: { id: true, lines: { select: { id: true, description: true }, orderBy: { description: 'asc' } } },
  })
  return { suffix, taxRateId: taxRate.id, orderId: order.id, wcOrderId: Number(wcOrderId), widget: order.lines.find((l) => l.description === 'Widget')!.id, gadget: order.lines.find((l) => l.description === 'Gadget')!.id }
}
type Seed = Awaited<ReturnType<typeof seedOrder>>

async function cleanup(w: World, seed: Seed) {
  await w.db.shoppingSyncLog.deleteMany({ where: { entityId: seed.orderId } }).catch(() => {})
  await w.db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: seed.orderId } } }).catch(() => {})
  await w.db.salesOrderRefund.deleteMany({ where: { orderId: seed.orderId } }).catch(() => {})
  await w.db.salesOrder.deleteMany({ where: { id: seed.orderId } }).catch(() => {}) // tasks and links cascade
  await w.db.taxRate.deleteMany({ where: { id: seed.taxRateId } }).catch(() => {})
}

/** An IMS-recorded refund of ONE £100 net line (gross £120 at 20%). */
function imsRefund(w: World, seed: Seed, line: string, externalRefundId?: number) {
  return w.createSalesOrderRefund(w.db, {
    orderId: seed.orderId,
    lines: [{ lineId: line, productId: null, description: 'Refund', qty: 0, totalForeign: 100, totalBase: 100, lineKind: 'sale' }],
    reason: 'typed by a person: Jane Doe asked',
    creditNotePrefix: `CNSR${seed.suffix}-`,
    ...(externalRefundId !== undefined ? { externalRefundId } : {}),
  })
}

function wcRefund(id: number, amount: string) {
  return { id, parent_id: 1, date_created: '2026-11-17T10:00:00', date_created_gmt: '2026-11-17T10:00:00', amount, reason: '', refunded_by: 1, refunded_payment: true, meta_data: [], line_items: [], shipping_lines: [], fee_lines: [] } as never
}

function syncDeps(w: World) {
  const calls = { createRefund: 0, replays: 0 }
  const deps = {
    db: w.db as never,
    // Stands in for the refund writer. Like the real one (createSalesOrderRefund's replay, under the per-refund lock) it answers a storefront
    // refund id an IMS refund already holds with that refund and creates nothing; `createRefund` counts only a credit note it would CREATE.
    async createRefund(_orderId: string, _lines: unknown, _reason: string, _warehouse: unknown, options?: { externalRefundId?: number }) {
      const held = options?.externalRefundId != null ? await w.db.salesOrderRefund.findFirst({ where: { externalRefundId: options.externalRefundId }, select: { id: true } }) : null
      if (held) { calls.replays += 1; return { success: true as const } }
      calls.createRefund += 1
      return { success: true as const }
    },
    async logActivity() { /* not under test */ },
  }
  return { deps: deps as never, calls }
}

test('an IMS refund on a WooCommerce order raises ONE task; other refunds and non-WooCommerce orders raise none', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const w = await world()
  const wc = await seedOrder(w, { wc: true })
  const plain = await seedOrder(w, { wc: false })
  t.after(async () => { await cleanup(w, wc); await cleanup(w, plain); await w.db.$disconnect() })
  const made = await imsRefund(w, wc, wc.widget)
  assert.equal(made.success, true)
  const tasks = await w.db.wmsOperatorTask.findMany({ where: { orderId: wc.orderId } })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].reason, 'SHOP_REFUND_DUE')
  assert.equal(tasks[0].connector, 'woocommerce')
  assert.equal(tasks[0].status, 'OPEN')
  const payload = tasks[0].payload as { shopRefund: { grossForeign: string; currency: string; creditNoteNumber: string; reasonKind: string } }
  assert.equal(payload.shopRefund.grossForeign, '120.00')
  assert.equal(payload.shopRefund.currency, 'GBP')
  assert.equal(payload.shopRefund.creditNoteNumber, made.success ? made.creditNoteNumber : '')
  assert.doesNotMatch(tasks[0].queryText + JSON.stringify(tasks[0].payload), /Jane|Doe|typed by a person/, 'the free-text reason is not copied into the task')
  // a refund that carries a storefront refund id (it is already paid) raises none
  const woo = await imsRefund(w, wc, wc.gadget, 880000 + Math.floor(Math.random() * 9000))
  assert.equal(woo.success, true)
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: wc.orderId } }), 1, 'a storefront refund raises no task')
  // an order with no WooCommerce link raises none
  assert.equal((await imsRefund(w, plain, plain.widget)).success, true)
  assert.equal(await w.db.wmsOperatorTask.count({ where: { orderId: plain.orderId } }), 0)
})

test('the matching WooCommerce refund is LINKED, once, with no second credit note; ten concurrent deliveries still link it once', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const w = await world()
  const seed = await seedOrder(w, { wc: true })
  t.after(async () => { await cleanup(w, seed); await w.db.$disconnect() })
  const made = await imsRefund(w, seed, seed.widget)
  assert.equal(made.success, true)
  const { deps, calls } = syncDeps(w)
  const wcId = 770000 + Math.floor(Math.random() * 9000)
  const results = await Promise.all(Array.from({ length: 10 }, () => w.syncWcRefund(seed.wcOrderId, wcRefund(wcId, '120.00'), deps)))
  assert.equal(calls.createRefund, 0, 'NO second credit note is created (a late delivery is answered by the writer\'s replay of the linked refund)')
  assert.ok(results.every((r) => r.outcome === 'already-applied' || r.outcome === 'retryable-failure'), JSON.stringify(results))
  assert.ok(results.some((r) => r.outcome === 'already-applied'))
  // a settled re-delivery is the plain already-applied
  assert.equal((await w.syncWcRefund(seed.wcOrderId, wcRefund(wcId, '120.00'), deps)).outcome, 'already-applied')
  const refunds = await w.db.salesOrderRefund.findMany({ where: { orderId: seed.orderId }, select: { externalRefundId: true, creditNoteNumber: true, source: true } })
  assert.equal(refunds.length, 1, 'still the one credit note')
  assert.equal(refunds[0].externalRefundId, wcId)
  assert.equal(refunds[0].source, 'MANUAL_UI', 'the IMS refund is linked, not replaced')
  const task = await w.db.wmsOperatorTask.findFirstOrThrow({ where: { orderId: seed.orderId } })
  assert.equal(task.status, 'DONE')
  assert.equal(task.doneBy, 'system:woocommerce-refund-import')
})

test('a different amount is NOT guessed: no credit note, no link, a QUARANTINED park with both figures, the task stays open', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const w = await world()
  const seed = await seedOrder(w, { wc: true })
  t.after(async () => { await cleanup(w, seed); await w.db.$disconnect() })
  assert.equal((await imsRefund(w, seed, seed.widget)).success, true)
  const { deps, calls } = syncDeps(w)
  const wcId = 660000 + Math.floor(Math.random() * 9000)
  assert.equal((await w.syncWcRefund(seed.wcOrderId, wcRefund(wcId, '100.00'), deps)).outcome, 'quarantined-refusal')
  assert.equal(calls.createRefund, 0)
  const refunds = await w.db.salesOrderRefund.findMany({ where: { orderId: seed.orderId }, select: { externalRefundId: true } })
  assert.deepEqual(refunds.map((r) => r.externalRefundId), [null])
  const park = await w.db.shoppingSyncLog.findFirstOrThrow({ where: { entityId: seed.orderId, externalId: String(wcId) } })
  assert.equal(park.status, 'QUARANTINED')
  assert.match(park.errorMessage ?? '', /100\.00 GBP/)
  assert.match(park.errorMessage ?? '', /120\.00 GBP/)
  assert.equal((await w.db.wmsOperatorTask.findFirstOrThrow({ where: { orderId: seed.orderId } })).status, 'OPEN')
  // the next delivery is the held park, not a second look: still nothing created
  assert.equal((await w.syncWcRefund(seed.wcOrderId, wcRefund(wcId, '100.00'), deps)).outcome, 'handled-unapplied-resolvable')
  assert.equal(calls.createRefund, 0)
})

test('a refund that began in WooCommerce (no open task) is imported exactly as before: the writer is called once', { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' }, async (t) => {
  const w = await world()
  const seed = await seedOrder(w, { wc: true })
  t.after(async () => { await cleanup(w, seed); await w.db.$disconnect() })
  const { deps, calls } = syncDeps(w)
  const result = await w.syncWcRefund(seed.wcOrderId, wcRefund(550000 + Math.floor(Math.random() * 9000), '120.00'), deps)
  assert.equal(calls.createRefund, 1, `the import ran: ${JSON.stringify(result)}`)
})
