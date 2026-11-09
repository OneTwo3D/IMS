import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { createReturnExpectationTx } from '../../lib/domain/sales/return-expectation'
import { applyReturnInboundStockTx } from '../../lib/domain/sales/refund-service'
import { receiveReturnAgainstExpectationsTx } from '../../lib/domain/sales/return-expectation-receipt'

/**
 * ARRIVAL CLEARING AGAINST A REAL DATABASE: the returns inbox clears return expectations, books stock at the refund's own cost, and closes the document.
 *
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/return-expectation-receipt.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

async function seed(tx: Tx, options: { refunds?: number } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const product = await tx.product.create({ data: { sku: `RX-${suffix}`, name: `rx ${suffix}`, type: 'SIMPLE' }, select: { id: true, sku: true } })
  const warehouse = await tx.warehouse.create({ data: { code: `RX${suffix}`, name: `rx ${suffix}` }, select: { id: true } })
  const order = await tx.salesOrder.create({
    data: {
      orderNumber: `RX-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
    },
    select: { id: true },
  })
  const refunds: Array<{ id: string; lineIds: string[] }> = []
  for (let index = 0; index < (options.refunds ?? 1); index += 1) {
    const refund = await tx.salesOrderRefund.create({
      data: {
        orderId: order.id,
        creditNoteNumber: `CN-RX-${suffix}-${index}`,
        totalForeign: new Prisma.Decimal('50'),
        totalBase: new Prisma.Decimal('50'),
        returnWarehouseId: warehouse.id,
        returnInTransit: true,
        lines: {
          create: [0, 1].map((n) => ({
            productId: product.id,
            description: `line ${n}`,
            qty: new Prisma.Decimal('2'),
            unitPriceBase: new Prisma.Decimal('25'),
            totalBase: new Prisma.Decimal('50'),
          })),
        },
      },
      select: { id: true, lines: { select: { id: true }, orderBy: { id: 'asc' } } },
    })
    refunds.push({ id: refund.id, lineIds: refund.lines.map((line: { id: string }) => line.id) })
  }
  return { product, warehouseId: warehouse.id, orderId: order.id, refunds }
}

const OFF = { connector: null, syncEnabled: false } as const

async function arrive(tx: Tx, fx: { orderId: string; product: { id: string }; warehouseId: string }, qty: number) {
  const inboxId = randomUUID()
  const result = await receiveReturnAgainstExpectationsTx(tx, { inboxId, orderId: fx.orderId, productId: fx.product.id, qty, arrivedAt: new Date('2026-11-03T10:00:00Z'), accounting: OFF })
  await applyReturnInboundStockTx(tx, { referenceType: 'WmsReturnsInbox', referenceId: inboxId, warehouseId: fx.warehouseId, rows: result.rows, note: 'test' })
  return result
}

test('[db] arrival books stock and layers at the refund cost, oldest refund first, and closes the document', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 2 })
    const [r1, r2] = fx.refunds
    await createReturnExpectationTx(tx, { valued: true, refundId: r1.id, orderId: fx.orderId, creditNoteNumber: 'A', rows: [{ productId: fx.product.id, qty: 2, refundLineId: r1.lineIds[0], unitCostBase: '10' }] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createReturnExpectationTx(tx, { valued: true, refundId: r2.id, orderId: fx.orderId, creditNoteNumber: 'B', rows: [{ productId: fx.product.id, qty: 2, refundLineId: r2.lineIds[0], unitCostBase: '20' }] })

    const first = await arrive(tx, fx, 3)
    assert.equal(first.remainder.toFixed(6), '0.000000')
    const docs = await tx.returnExpectation.findMany({ orderBy: { createdAt: 'asc' }, include: { lines: true } })
    assert.deepEqual(docs.map((d: { status: string }) => d.status), ['RECEIVED', 'PARTIALLY_RECEIVED'])
    assert.ok(docs[0].closedAt)
    assert.equal(docs[1].closedAt, null)
    const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: fx.product.id, warehouseId: fx.warehouseId } } })
    assert.equal(level.quantity.toFixed(6), '3.000000')
    const layers = await tx.costLayer.findMany({ where: { productId: fx.product.id }, orderBy: { unitCostBase: 'asc' } })
    assert.deepEqual(layers.map((l: { receivedQty: Prisma.Decimal; unitCostBase: Prisma.Decimal }) => [l.receivedQty.toFixed(0), l.unitCostBase.toFixed(2)]), [['2', '10.00'], ['1', '20.00']])

    // An over-return: one outstanding, two arrive; the second unit is a plain, cost-less restock.
    const second = await arrive(tx, fx, 2)
    assert.equal(second.remainder.toFixed(6), '1.000000')
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: r2.id } })).status, 'RECEIVED')
    // Nothing outstanding: a further arrival matches nothing.
    const third = await arrive(tx, fx, 1)
    assert.deepEqual(third.expectationIds, [])
  })
})

test('[db] an arrival is HELD while the oldest open document is unvalued (older unvalued beats newer valued), then clears once after valuation', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 2 })
    const [r1, r2] = fx.refunds
    await createReturnExpectationTx(tx, { valued: false, refundId: r1.id, orderId: fx.orderId, creditNoteNumber: 'A', rows: [{ productId: fx.product.id, qty: 2, refundLineId: r1.lineIds[0], unitCostBase: '10' }] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await createReturnExpectationTx(tx, { valued: true, refundId: r2.id, orderId: fx.orderId, creditNoteNumber: 'B', rows: [{ productId: fx.product.id, qty: 2, refundLineId: r2.lineIds[0], unitCostBase: '20' }] })

    await tx.$executeRaw`SAVEPOINT held`
    await assert.rejects(() => arrive(tx, fx, 2), /awaiting_refund_valuation/)
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT held`
    assert.equal(await tx.stockMovement.count({ where: { productId: fx.product.id } }), 0, 'held: no stock, not even a plain restock')
    assert.deepEqual((await tx.returnExpectationLine.findMany({})).map((l: { qtyReceived: Prisma.Decimal }) => l.qtyReceived.toFixed(0)), ['0', '0'])

    // Valuation lands: the same arrival now clears the OLDER document, once.
    await tx.returnExpectation.update({ where: { refundId: r1.id }, data: { valuedAt: new Date() } })
    const cleared = await arrive(tx, fx, 2)
    assert.equal(cleared.expectationIds.length, 1)
    assert.equal(cleared.remainder.toFixed(6), '0.000000')
    const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: fx.product.id, warehouseId: fx.warehouseId } } })
    assert.equal(level.quantity.toFixed(0), '2')
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: r1.id } })).status, 'RECEIVED')
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: r2.id } })).status, 'IN_TRANSIT')
  })
})

test('[db] a legacy refund and another order are never cleared', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 0 })
    const other = await seed(tx, { refunds: 0 })
    assert.deepEqual((await arrive(tx, fx, 1)).expectationIds, [], 'no document: plain')
    assert.deepEqual((await arrive(tx, { ...fx, orderId: other.orderId }, 1)).expectationIds, [], 'other order')
  })
})

async function withTransitDebit(tx: Tx, fx: { orderId: string; refunds: Array<{ id: string; lineIds: string[] }>; product: { id: string } }, status: string | null) {
  const refund = fx.refunds[0]
  await createReturnExpectationTx(tx, {
    valued: true, refundId: refund.id, orderId: fx.orderId, creditNoteNumber: 'T',
    rows: [{ productId: fx.product.id, qty: 2, refundLineId: refund.lineIds[0], unitCostBase: '10' }],
    transit: { journalKey: `sales-order-refund:${refund.id}:cogs-reversal`, debitBase: '20' },
  })
  if (status) {
    await tx.accountingSyncLog.create({
      data: {
        connector: 'xero', type: 'COGS_REVERSAL', status, referenceType: 'SalesOrderRefund', referenceId: refund.id,
        payload: { _idempotencyKey: `sales-order-refund:${refund.id}:cogs-reversal`, _returnInTransit: true },
      },
    })
  }
}

test('[db] the refund journal must be a queued row on its recorded key: absent holds, a different ledger holds, a cancelled one restocks with no clearing journal', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 1 })
    await withTransitDebit(tx, fx, null)
    await tx.$executeRaw`SAVEPOINT a`
    await assert.rejects(() => arrive(tx, fx, 2), /awaiting_refund_journal/)
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT a`

    // A sync row of the same refund under ANOTHER key must not be mistaken for the debit.
    await tx.accountingSyncLog.create({
      data: { connector: 'xero', type: 'COGS_REVERSAL', status: 'CANCELLED', settlementBasis: 'HELD_SHADOW', referenceType: 'SalesOrderRefund', referenceId: fx.refunds[0].id, payload: { _idempotencyKey: 'some-other-key' } },
    })
    const row = await tx.accountingSyncLog.create({
      data: { connector: 'xero', type: 'COGS_REVERSAL', status: 'SYNCED', referenceType: 'SalesOrderRefund', referenceId: fx.refunds[0].id, payload: { _idempotencyKey: `sales-order-refund:${fx.refunds[0].id}:cogs-reversal` } },
      select: { id: true },
    })
    await tx.$executeRaw`SAVEPOINT b`
    await assert.rejects(() => arrive(tx, fx, 2), /awaiting_accounting/) // accounting is off in this arrival
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT b`
    assert.equal(await tx.stockMovement.count({ where: { productId: fx.product.id } }), 0, 'held: no stock')
    assert.equal((await tx.returnExpectationLine.findFirst({})).qtyReceived.toFixed(0), '0')

    await tx.accountingSyncLog.update({ where: { id: row.id }, data: { status: 'CANCELLED', settlementBasis: 'HELD_SHADOW' } })
    const result = await arrive(tx, fx, 2)
    assert.equal(result.expectationIds.length, 1)
    const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId: fx.product.id, warehouseId: fx.warehouseId } } })
    assert.equal(level.quantity.toFixed(0), '2')
    assert.equal(await tx.activityLog.count({ where: { action: 'return_expectation_arrival_debit_not_posted' } }), 1)
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: fx.refunds[0].id } })).transitClearedAmount.toFixed(2), '0.00')
  })
})

test('[db] the journalled amount cannot go negative', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 1 })
    await withTransitDebit(tx, fx, null)
    await tx.$executeRaw`SAVEPOINT c`
    let message = ''
    try { await tx.returnExpectation.updateMany({ data: { transitClearedAmount: -1 } }) } catch (error) { message = String(error) }
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT c`
    assert.ok(message.includes('transit_cleared_amount_check'), message.slice(0, 200))
  })
})
