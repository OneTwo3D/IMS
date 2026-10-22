import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { createReturnExpectationTx, settleReturnExpectationTx, ReturnExpectationError } from '../../lib/domain/sales/return-expectation'
import { recordRefundTransitFromSync } from '../../lib/domain/sales/refund-service'
import { sumTransitSubledgerMovement } from '../../lib/domain/accounting/transit-gl-reconciliation'

/**
 * THE RETURN-EXPECTATION DOCUMENT AGAINST A REAL DATABASE.
 *
 * The unit tests run the refund service over an in-memory double. What a double cannot show is the schema: that the
 * migration's CHECKs refuse a document that over-accounts a line or half-records its ledger link, that the foreign
 * keys and unique keys hold, that creating the document twice leaves one, and that the transit sub-ledger row the
 * refund records is the one the daily transit reconciliation sums. Every test runs inside a transaction that is ROLLED
 * BACK, ALWAYS.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/return-expectation.test.ts would have been skipped. Fix the invocation (npm run test:db).')
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

async function violates(tx: Tx, constraint: string, run: () => Promise<unknown>): Promise<void> {
  await tx.$executeRaw`SAVEPOINT probe`
  let message = ''
  try {
    await run()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT probe`
  assert.ok(message.includes(constraint), `expected ${constraint} to refuse the write, got: ${message.slice(0, 200) || 'no error'}`)
}

test('[db] the migration is additive: an existing-shaped refund reads return_in_transit = false', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    // A refund inserted the way the PREVIOUS build did (column omitted) reads false: the default is the legacy behaviour.
    const legacy = await tx.$queryRaw<Array<{ return_in_transit: boolean }>>`
      INSERT INTO sales_order_refunds (id, "orderId", "totalForeign", "totalBase")
      VALUES (${randomUUID()}, ${fx.orderId}, 1, 1) RETURNING return_in_transit`
    assert.equal(legacy[0].return_in_transit, false)
  })
})

test('[db] createReturnExpectationTx writes the document once; a second call returns it and changes nothing', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const rows = [
      { productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[0], unitCostBase: '10', sourceCostLayerId: null, poLineId: null },
      { productId: fx.product.id, qty: 2, refundLineId: refund.lineIds[1], unitCostBase: '11.5', sourceCostLayerId: null, poLineId: null },
    ]
    const first = await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, creditNoteNumber: 'CN-1', expectedWarehouseId: fx.warehouseId, rows, transit: { journalKey: `k-${refund.id}`, debitBase: '33' } })
    assert.equal(first.outcome, 'created')
    const second = await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, creditNoteNumber: 'CN-1', expectedWarehouseId: fx.warehouseId, rows: [{ ...rows[0], qty: 5 }], transit: { journalKey: `k-${refund.id}`, debitBase: '33' } })
    assert.deepEqual(second, { outcome: 'existing', expectationId: first.expectationId })

    const stored = await tx.returnExpectation.findUnique({ where: { refundId: refund.id }, include: { lines: { orderBy: { qty: 'asc' } } } })
    assert.equal(stored.status, 'IN_TRANSIT')
    assert.equal(stored.reference, 'RX-CN-1')
    assert.equal(stored.transitDebitBase.toFixed(6), '33.000000')
    assert.deepEqual(stored.lines.map((line: { qty: Prisma.Decimal; transitValueBase: Prisma.Decimal; qtyReceived: Prisma.Decimal; qtyWrittenOff: Prisma.Decimal }) => [line.qty.toFixed(6), line.transitValueBase.toFixed(6), line.qtyReceived.toFixed(6), line.qtyWrittenOff.toFixed(6)]), [
      ['1.000000', '10.000000', '0.000000', '0.000000'],
      ['2.000000', '23.000000', '0.000000', '0.000000'],
    ], 'the first write wins: the second call (qty 5) changed nothing')
    // Nothing became stock.
    assert.equal(await tx.stockMovement.count({ where: { productId: fx.product.id } }), 0)
    assert.equal(await tx.stockLevel.count({ where: { productId: fx.product.id } }), 0)
    assert.equal(await tx.costLayer.count({ where: { productId: fx.product.id } }), 0)
  })
})

test('[db] an empty return creates no document', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const result = await createReturnExpectationTx(tx, { valued: true, refundId: fx.refunds[0].id, orderId: fx.orderId, rows: [{ productId: fx.product.id, qty: 0, refundLineId: fx.refunds[0].lineIds[0] }] })
    assert.deepEqual(result, { outcome: 'none', expectationId: null })
    assert.equal(await tx.returnExpectation.count(), 0)
  })
})

test('[db] a refund line belonging to ANOTHER refund is refused (the foreign key alone would accept it)', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx, { refunds: 2 })
    await assert.rejects(
      () => createReturnExpectationTx(tx, { valued: true, refundId: fx.refunds[0].id, orderId: fx.orderId, rows: [{ productId: fx.product.id, qty: 1, refundLineId: fx.refunds[1].lineIds[0], unitCostBase: 1 }] }),
      (error: unknown) => error instanceof ReturnExpectationError && error.code === 'refund_line_not_on_refund',
    )
  })
})

test('[db] the ledger link: a missing one is learned once, a recorded one is never changed, a different one is refused', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const rows = [{ productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[0], unitCostBase: '10' }]
    await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows })
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: refund.id } })).transitJournalKey, null)

    await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows, transit: { journalKey: 'k-1', debitBase: '10' } })
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: refund.id } })).transitJournalKey, 'k-1', 'learned')
    await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows, transit: { journalKey: 'k-1', debitBase: '10.000000' } }) // same: fine
    for (const transit of [{ journalKey: 'k-2', debitBase: '10' }, { journalKey: 'k-1', debitBase: '10.000001' }]) {
      await assert.rejects(
        () => createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows, transit }),
        (error: unknown) => error instanceof ReturnExpectationError && error.code === 'transit_link_conflict',
      )
    }
    await assert.rejects(
      () => createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows, transit: { journalKey: 'k-3', debitBase: '0' } }),
      (error: unknown) => error instanceof ReturnExpectationError && error.code === 'transit_value_not_positive',
    )
  })
})

test('[db] a value that differs from the journal it should equal is recorded, in closed-code text with counts only', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    await createReturnExpectationTx(tx, { valued: true,
      refundId: refund.id,
      orderId: fx.orderId,
      rows: [{ productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[0], unitCostBase: '10' }, { productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[1] }],
      transit: { journalKey: 'k-mm', debitBase: '12' },
    })
    const logs = await tx.activityLog.findMany({ where: { entityId: fx.orderId, action: 'return_expectation_value_mismatch' } })
    assert.equal(logs.length, 1)
    assert.equal(logs[0].description, 'A return expectation was created whose value differs from its Stock in Transit debit.')
    assert.deepEqual(logs[0].metadata, { lines: 2, unpricedEntries: 1 })
    assert.equal(JSON.stringify(logs[0]).includes(fx.product.sku), false, 'no SKU in the text')
  })
})

test('[db] the CHECKs hold the invariants the writers rely on', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows: [{ productId: fx.product.id, qty: 2, refundLineId: refund.lineIds[0], unitCostBase: '5' }], transit: { journalKey: 'k-c', debitBase: '10' } })
    const line = await tx.returnExpectationLine.findFirst({ where: { expectation: { refundId: refund.id } } })
    const setLine = (data: Record<string, unknown>) => tx.returnExpectationLine.update({ where: { id: line.id }, data })

    await setLine({ qtyReceived: '1', qtyWrittenOff: '1' }) // exactly consumed: allowed
    await violates(tx, 'return_expectation_lines_qty_accounted_check', () => setLine({ qtyReceived: '2', qtyWrittenOff: '1' }))
    await violates(tx, 'return_expectation_lines_qty_accounted_check', () => setLine({ qtyReceived: '1.000001' }))
    await violates(tx, 'return_expectation_lines_qty_received_check', () => setLine({ qtyReceived: '-1' }))
    await violates(tx, 'return_expectation_lines_qty_written_off_check', () => setLine({ qtyWrittenOff: '-1' }))
    await violates(tx, 'return_expectation_lines_qty_positive_check', () => setLine({ qty: '0', qtyReceived: '0', qtyWrittenOff: '0' }))
    await violates(tx, 'return_expectation_lines_transit_value_check', () => setLine({ transitValueBase: '-0.000001' }))

    const header = (data: Record<string, unknown>) => tx.returnExpectation.update({ where: { refundId: refund.id }, data })
    await violates(tx, 'return_expectations_transit_link_check', () => header({ transitJournalKey: null }))
    await violates(tx, 'return_expectations_transit_link_check', () => header({ transitDebitBase: null }))
    await violates(tx, 'return_expectations_transit_debit_check', () => header({ transitDebitBase: '0' }))
  })
})

test('[db] one document per refund and one line per (refund line, product): a duplicate is refused by the database', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const created = await createReturnExpectationTx(tx, { valued: true, refundId: refund.id, orderId: fx.orderId, rows: [{ productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[0], unitCostBase: '1' }] })
    await violates(tx, 'return_expectations_refund_id_key', () => tx.returnExpectation.create({ data: { reference: `RX-dup-${randomUUID()}`, orderId: fx.orderId, refundId: refund.id } }))
    await violates(tx, 'return_expectation_lines_refund_line_id_product_id_key', () => tx.returnExpectationLine.create({
      data: { expectationId: created.expectationId, refundLineId: refund.lineIds[0], productId: fx.product.id, sku: fx.product.sku, qty: '1', costSnapshot: [] },
    }))
  })
})

test('[db] the refund records its transit sub-ledger row and the daily transit reconciliation sums it', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const key = `sales-order-refund:${refund.id}:cogs-reversal`
    const sync = { type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refund.id, idempotencyKey: key, payload: { date: '2099-01-02', _cogsReversalBase: 33.123456, _returnInTransit: true, lines: [] } } as never
    await recordRefundTransitFromSync(tx, sync, { queued: true })
    await recordRefundTransitFromSync(tx, sync, { queued: true }) // the retry: still one row
    const window = await sumTransitSubledgerMovement(new Date('2099-01-01T00:00:00Z'), new Date('2099-01-02T00:00:00Z'), tx)
    assert.equal(window, 33.123456)
    const rows = await tx.transitSubledgerMovement.findMany({ where: { idempotencyKey: key } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sourceType, 'CUSTOMER_RETURN_IN_TRANSIT')
    // Without the row the same window reads zero: the reconciliation would FLAG a posted journal with no sub-ledger.
    await tx.transitSubledgerMovement.deleteMany({ where: { idempotencyKey: key } })
    assert.equal(await sumTransitSubledgerMovement(new Date('2099-01-01T00:00:00Z'), new Date('2099-01-02T00:00:00Z'), tx), 0)
  })
})

test('[db] created unvalued in the refund transaction, then valued by the staging: lines re-stated, link recorded, valued_at set once', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const wide = [
      { productId: fx.product.id, qty: 2, refundLineId: refund.lineIds[0] },
      { productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[1] },
    ]
    const made = await createReturnExpectationTx(tx, { valued: false, refundId: refund.id, orderId: fx.orderId, rows: wide })
    assert.equal(made.outcome, 'created')
    assert.equal((await tx.returnExpectation.findUnique({ where: { refundId: refund.id } })).valuedAt, null)
    // The creating step repeated (a replay) changes nothing and does not value it.
    assert.equal((await createReturnExpectationTx(tx, { valued: false, refundId: refund.id, orderId: fx.orderId, rows: wide })).outcome, 'existing')

    const staged = [{ productId: fx.product.id, qty: 1, refundLineId: refund.lineIds[0], unitCostBase: '10' }]
    const valued = await settleReturnExpectationTx(tx, { refundId: refund.id, orderId: fx.orderId, rows: staged, transit: { journalKey: 'k-v', debitBase: '10' } })
    assert.deepEqual(valued, { outcome: 'valued', expectationId: made.expectationId })
    const stored = await tx.returnExpectation.findUnique({ where: { refundId: refund.id }, include: { lines: true } })
    assert.ok(stored.valuedAt)
    assert.equal(stored.transitJournalKey, 'k-v')
    assert.deepEqual(stored.lines.map((line: { refundLineId: string; qty: Prisma.Decimal; transitValueBase: Prisma.Decimal }) => [line.refundLineId, line.qty.toFixed(6), line.transitValueBase.toFixed(6)]), [[refund.lineIds[0], '1.000000', '10.000000']])
    // Once valued, a second settle is a no-op.
    assert.equal((await settleReturnExpectationTx(tx, { refundId: refund.id, orderId: fx.orderId, rows: [{ ...staged[0], qty: 9 }], transit: { journalKey: 'k-v', debitBase: '10' } })).outcome, 'existing')
    assert.equal((await tx.returnExpectationLine.findMany({ where: { expectationId: made.expectationId } })).length, 1)
  })
})

test('[db] settling an unvalued document that has accounted quantity is refused, and settle creates a missing document', { skip }, async () => {
  await withRollback(async (tx) => {
    const fx = await seed(tx)
    const refund = fx.refunds[0]
    const rows = [{ productId: fx.product.id, qty: 2, refundLineId: refund.lineIds[0], unitCostBase: '5' }]
    await createReturnExpectationTx(tx, { valued: false, refundId: refund.id, orderId: fx.orderId, rows })
    await tx.returnExpectationLine.updateMany({ where: { expectation: { refundId: refund.id } }, data: { qtyReceived: '1' } })
    await assert.rejects(
      () => settleReturnExpectationTx(tx, { refundId: refund.id, orderId: fx.orderId, rows }),
      (error: unknown) => error instanceof ReturnExpectationError && error.code === 'unvalued_document_has_accounted_quantity',
    )
    const other = await seed(tx)
    const created = await settleReturnExpectationTx(tx, { refundId: other.refunds[0].id, orderId: other.orderId, rows: [{ productId: other.product.id, qty: 1, refundLineId: other.refunds[0].lineIds[0], unitCostBase: '3' }] })
    assert.equal(created.outcome, 'created')
    assert.ok((await tx.returnExpectation.findUnique({ where: { refundId: other.refunds[0].id } })).valuedAt)
  })
})
