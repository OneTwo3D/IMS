import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * THE STOCK CORRECTION A STOREFRONT REFUND OWES THE STORE, AGAINST A REAL DATABASE (committing, with its own cleanup:
 * the code under test opens its own transactions).
 *
 * Pins the three ways the correction used to be lost:
 *   1. an identical forced job enqueued while the first is PROCESSING was dropped as a duplicate;
 *   2. a lookup or queue failure was only logged and the redelivery found nothing owed;
 *   3. a refund whose commit was followed by a failing step came back `already-applied` and queued nothing.
 * The obligation is a column on the refund row, so (2) and (3) are one mechanism: whatever reads the row queues it.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/refund-stock-correction.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  const jobs = await import('../../lib/connectors/woocommerce/sync/stock-sync-jobs')
  const correction = await import('../../lib/connectors/woocommerce/sync/refund-stock-correction')
  return { db, jobs, correction }
}
type Ctx = Awaited<ReturnType<typeof load>>

async function seed(db: Ctx['db'], options: { qty?: number; required?: boolean } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const product = await db.product.create({ data: { sku: `RSC-${suffix}`, name: `rsc ${suffix}`, type: 'SIMPLE' }, select: { id: true } })
  const wcOrderId = `wc-${suffix}`
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `RSC-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: wcOrderId } },
    },
    select: { id: true },
  })
  const refund = await db.salesOrderRefund.create({
    data: {
      orderId: order.id,
      externalRefundId: Math.floor(Math.random() * 2_000_000_000),
      totalForeign: new Prisma.Decimal('10'),
      totalBase: new Prisma.Decimal('10'),
      stockCorrectionRequired: options.required ?? true,
      lines: { create: [{ productId: product.id, description: 'line', qty: new Prisma.Decimal(String(options.qty ?? 1)), unitPriceBase: new Prisma.Decimal('10'), totalBase: new Prisma.Decimal('10') }] },
    },
    select: { id: true },
  })
  return { productId: product.id, orderId: order.id, refundId: refund.id, wcOrderId }
}

async function cleanup(db: Ctx['db'], s: { productId: string; orderId: string }) {
  await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: s.productId } } })
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: s.orderId } } })
  await db.salesOrderRefund.deleteMany({ where: { orderId: s.orderId } })
  await db.shoppingOrderLink.deleteMany({ where: { orderId: s.orderId } })
  await db.salesOrder.delete({ where: { id: s.orderId } })
  await db.stockSyncState.deleteMany({ where: { productId: s.productId } }).catch(() => {})
  await db.product.delete({ where: { id: s.productId } })
}

async function stockJob(db: Ctx['db'], productId: string) {
  return db.integrationOutbox.findFirstOrThrow({ where: { connector: 'woocommerce', idempotencyKey: { contains: productId } } })
}

test('an identical forced job enqueued while the first is PROCESSING makes the worker take another pass', { skip }, async () => {
  const { db, jobs } = await load()
  const s = await seed(db)
  try {
    await jobs.enqueueWcStockSyncJobs([s.productId], 'IMS_CHANGE', { force: true })
    // A worker claims it and reads the stock.
    const claimed = await db.integrationOutbox.update({
      where: { id: (await stockJob(db, s.productId)).id },
      data: { status: 'PROCESSING', lockedBy: 'woocommerce-stock-sync', lockedAt: new Date() },
    })
    // The second refund's restock: the very same forced payload, while the worker holds the job.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await jobs.enqueueWcStockSyncJobs([s.productId], 'IMS_CHANGE', { force: true })
    assert.equal(await jobs.completeClaimedJob(claimed), 'requeued')
    assert.equal((await stockJob(db, s.productId)).status, 'PENDING', 'the job runs again')
  } finally {
    await cleanup(db, s)
  }
})

test('a reservation release committed after the worker read the stock and before it sent: the plain IMS_CHANGE it enqueues makes a second pass', { skip }, async () => {
  const { db, jobs } = await load()
  const s = await seed(db)
  try {
    // The refund's forced correction is the job; the worker has claimed it and read the (lower) stock.
    await jobs.enqueueWcStockSyncJobs([s.productId], 'IMS_CHANGE', { force: true })
    const claimed = await db.integrationOutbox.update({
      where: { id: (await stockJob(db, s.productId)).id },
      data: { status: 'PROCESSING', lockedBy: 'woocommerce-stock-sync', lockedAt: new Date() },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    // autoAllocateOrder's post-release push: an ordinary, non-forced IMS_CHANGE. The merged payload is IDENTICAL to the job's
    // (force is sticky), which is exactly the case that used to be swallowed.
    await jobs.enqueueWcStockSyncJobs([s.productId], 'IMS_CHANGE')
    const merged = await stockJob(db, s.productId)
    assert.deepEqual(merged.payloadJson, claimed.payloadJson, 'the payload really is identical')
    assert.equal(await jobs.completeClaimedJob(claimed), 'requeued', 'so the worker must not complete it: it re-reads and pushes the released quantity')
  } finally {
    await cleanup(db, s)
  }
})

test('a queue failure leaves the obligation open; the next attempt queues it; once recorded it is not queued again', { skip }, async () => {
  const { db, correction } = await load()
  const s = await seed(db)
  try {
    let calls = 0
    const failing = { enqueue: (async () => { calls++; throw new Error('queue down') }) as never }
    const scopeId = s.wcOrderId as unknown as number // the link's externalOrderId is the string we seeded
    const failed = await correction.queueRefundStockCorrections({ externalOrderId: scopeId }, failing)
    assert.deepEqual(failed, { open: 1, queued: 0, failed: 1 })
    assert.equal(calls, 1)
    assert.equal((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: s.refundId } })).stockCorrectionQueuedAt, null, 'still owed')

    const recorded: Array<{ ids: string[]; options: Record<string, unknown> }> = []
    const working = {
      enqueue: (async (ids: string[], _reason: string, options: { onEnqueued?: () => Promise<void> } & Record<string, unknown>) => {
        recorded.push({ ids, options })
        await options.onEnqueued?.()
      }) as never,
    }
    const second = await correction.queueRefundStockCorrections({ externalOrderId: scopeId }, working)
    assert.deepEqual(second, { open: 1, queued: 1, failed: 0 })
    assert.deepEqual(recorded[0].ids, [s.productId])
    assert.equal(recorded[0].options.force, true)
    assert.notEqual((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: s.refundId } })).stockCorrectionQueuedAt, null)

    const third = await correction.queueRefundStockCorrections({ externalOrderId: scopeId }, working)
    assert.deepEqual(third, { open: 0, queued: 0, failed: 0 })
    assert.equal(recorded.length, 1, 'once recorded it is not queued again')
  } finally {
    await cleanup(db, s)
  }
})

test('a committed refund whose later steps failed still owes its correction: the row alone decides, for any order, and money-only refunds owe nothing', { skip }, async () => {
  const { db, correction } = await load()
  const owed = await seed(db)
  const notOwed = await seed(db, { required: false })
  try {
    const seen: string[][] = []
    const deps = { enqueue: (async (ids: string[], _r: string, options: { onEnqueued?: () => Promise<void> }) => { seen.push(ids); await options.onEnqueued?.() }) as never }
    // The drain form: no order scope (the reconcile), so a refund the order sweep never revisits is still found.
    const result = await correction.queueRefundStockCorrections({ limit: 500 }, deps)
    assert.ok(result.queued >= 1)
    assert.ok(seen.some((ids) => ids.includes(owed.productId)))
    assert.ok(!seen.some((ids) => ids.includes(notOwed.productId)), 'a refund that owes nothing is never queued')
    assert.equal((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: notOwed.refundId } })).stockCorrectionQueuedAt, null)
  } finally {
    await cleanup(db, owed)
    await cleanup(db, notOwed)
  }
})

test('a job that fails to record is not the same as one a hold shadowed: only a thrown enqueue leaves the obligation open', { skip }, async () => {
  const { db, correction } = await load()
  const s = await seed(db)
  try {
    // enqueue returns normally without queueing anything (the producer hold shadowed it) but DOES call onEnqueued: discharged.
    const shadowed = { enqueue: (async (_ids: string[], _r: string, options: { onEnqueued?: () => Promise<void> }) => { await options.onEnqueued?.() }) as never }
    const result = await correction.queueRefundStockCorrections({ externalOrderId: s.wcOrderId as unknown as number }, shadowed)
    assert.equal(result.queued, 1)
  } finally {
    await cleanup(db, s)
  }
})

test('a scoped call queues only that order\'s corrections; the real enqueue path stamps the obligation and records the job', { skip }, async () => {
  const { db, correction } = await load()
  const mine = await seed(db)
  const other = await seed(db)
  try {
    // REAL dependencies: the stock job is recorded in the outbox and the obligation is stamped through `onEnqueued`.
    const result = await correction.queueRefundStockCorrections({ externalOrderId: mine.wcOrderId as unknown as number })
    assert.deepEqual(result, { open: 1, queued: 1, failed: 0 })
    assert.notEqual((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: mine.refundId } })).stockCorrectionQueuedAt, null)
    assert.equal((await stockJob(db, mine.productId)).connector, 'woocommerce', 'the stock job is durably recorded')
    assert.equal((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: other.refundId } })).stockCorrectionQueuedAt, null, 'another order\'s obligation is untouched')
  } finally {
    await cleanup(db, mine)
    await cleanup(db, other)
  }
})

test('the drain takes at most the limit it is given', { skip }, async () => {
  const { db, correction } = await load()
  const a = await seed(db)
  const b = await seed(db)
  try {
    const recorded: string[][] = []
    const deps = { enqueue: (async (ids: string[], _r: string, options: { onEnqueued?: () => Promise<void> }) => { recorded.push(ids); await options.onEnqueued?.() }) as never }
    const result = await correction.queueRefundStockCorrections({ limit: 1 }, deps)
    assert.equal(result.open, 1)
    assert.equal(recorded.length, 1)
  } finally {
    await cleanup(db, a)
    await cleanup(db, b)
  }
})
