import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from 'dotenv'
import { backendPid, waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * SalesOrder.invoicingState, against a real PostgreSQL: every place that creates, fails, retires, settles or links a sales
 * invoice moves the column, two invoices written at the same moment leave it right, a cancelled order keeps it, and the
 * repair is idempotent and heals a drifted row. The derivation itself is tests/domain/sales/invoicing-state.test.ts.
 * [mutation: drop the recompute from the row writer, the cancellation sweep, the operator decision fence or the repair: the matching test is red]
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}
type Db = Awaited<ReturnType<typeof loadDb>>

async function makeOrder(db: Db, t: TestContext, over: { status?: 'PROCESSING' | 'CANCELLED'; qty?: number; wooNumber?: string } = {}) {
  const id = `INV-${process.pid}-${randomUUID()}`
  t.after(async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
    await db.activityLog.deleteMany({ where: { entityId: id } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId: id } })
    await db.salesOrderLine.deleteMany({ where: { orderId: id } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  await db.salesOrder.create({
    data: {
      id, status: over.status ?? 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
      lines: { create: [{ description: 'Widget', qty: over.qty ?? 3, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 30, totalBase: 30 }] },
      ...(over.wooNumber ? { invoiceNumber: over.wooNumber, shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${id}`, externalOrderNumber: '1' } } } : {}),
    },
  })
  return id
}

const stateOf = async (db: Db, id: string) => (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { invoicingState: true } })).invoicingState
const payload = (qty: number, key: string) => ({ invoiceNumber: 'X', _idempotencyKey: key, lines: [{ quantity: qty, unitAmount: 10 }] })

async function queueInvoice(db: Db, orderId: string, qty = 3, key = randomUUID()) {
  const { createAccountingSyncLogRow } = await import('@/lib/domain/accounting/sync-log-row')
  return db.$transaction((tx) => createAccountingSyncLogRow(tx as never, {
    connector: 'xero', type: 'SALES_INVOICE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: orderId, payload: payload(qty, key),
  }))
}

test('[invoicing state] the row writer: an order with no invoice is NOT_INVOICED; queueing a covering invoice makes it FULLY_INVOICED', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t)
  assert.equal(await stateOf(db, id), 'NOT_INVOICED')
  const result = await queueInvoice(db, id)
  assert.ok(result.row, 'the invoice row was written live (the producer hold is not enforced on a scratch database)')
  assert.equal(await stateOf(db, id), 'FULLY_INVOICED')
})

test('[invoicing state] an invoice covering fewer units than the order holds is PARTIALLY_INVOICED', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t, { qty: 5 })
  const result = await queueInvoice(db, id, 2)
  assert.ok(result.row, 'the invoice row was written live, not shadowed')
  assert.equal(await stateOf(db, id), 'PARTIALLY_INVOICED')
})

test('[invoicing state] two invoices written at the same moment leave the column right, whichever commits first', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t, { qty: 4 })
  const [a, b] = await Promise.all([queueInvoice(db, id, 4), queueInvoice(db, id, 4)])
  assert.ok(a.row && b.row, 'both invoice rows were written live')
  assert.equal(await stateOf(db, id), 'FULLY_INVOICED')
  const { repairInvoicingStates } = await import('@/lib/domain/sales/invoicing-state')
  const page = await repairInvoicingStates(db as never, { limit: 5000 })
  assert.ok(page.examined > 0)
  assert.equal(await stateOf(db, id), 'FULLY_INVOICED', 'the repair agrees with what the racing writers left')
})

test('[invoicing state] a queued invoice retired by the cancellation sweep returns the order to NOT_INVOICED; the order keeps its CANCELLED status', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t)
  const queued = await queueInvoice(db, id)
  assert.ok(queued.row, 'the invoice row was written live, not shadowed')
  assert.equal(await stateOf(db, id), 'FULLY_INVOICED')
  const { cancelPendingSalesInvoiceSyncForOrder } = await import('@/lib/domain/accounting/cancel-order-invoice-sync')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    assert.equal(await cancelPendingSalesInvoiceSyncForOrder(tx, id, new Date()), 1)
  })
  assert.equal(await stateOf(db, id), 'NOT_INVOICED', 'the retired invoice was the only one')
})

test('[invoicing state] a POSTED invoice survives the cancellation: a cancelled order keeps FULLY_INVOICED', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t)
  const queued = await queueInvoice(db, id)
  assert.ok(queued.row, 'the invoice row was written live, not shadowed')
  await db.accountingSyncLog.update({ where: { id: queued.row.id }, data: { status: 'SYNCED', externalTransactionId: 'xero-inv-1' } })
  const { cancelPendingSalesInvoiceSyncForOrder } = await import('@/lib/domain/accounting/cancel-order-invoice-sync')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    await cancelPendingSalesInvoiceSyncForOrder(tx, id, new Date())
  })
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { status: true, invoicingState: true } })
  assert.deepEqual([row.status, row.invoicingState], ['CANCELLED', 'FULLY_INVOICED'])
})

test('[invoicing state] an operator decision (settled NOT_POSTED) on the invoice row moves the order; a credit note row never does', { skip }, async (t) => {
  const db = await loadDb()
  const id = await makeOrder(db, t)
  const queued = await queueInvoice(db, id)
  assert.ok(queued.row, 'the invoice row was written live, not shadowed')
  const credit = await db.accountingSyncLog.create({ data: { connector: 'xero', type: 'CREDIT_NOTE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: id, payload: {}, externalTransactionId: 'cn-1' } })
  assert.ok(credit.id)
  assert.equal(await stateOf(db, id), 'FULLY_INVOICED')
  const { applyFencedAttemptDecision } = await import('@/lib/domain/accounting/sync-log-attempt')
  const decided = await applyFencedAttemptDecision(db as never, { id: queued.row.id, expectedAttemptRevision: 0, expectedStatus: 'PENDING', adoptUnfencedAttempt: true, data: { status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' } })
  assert.equal(decided.ok, true)
  assert.equal(await stateOf(db, id), 'NOT_INVOICED', 'the credit note is not an invoice')
})

test('[invoicing state] the incumbent\'s number on a storefront-linked order is an invoice (recompute); the repair heals a drifted column and is idempotent', { skip }, async (t) => {
  const db = await loadDb()
  const { recomputeSalesOrderInvoicingState, repairInvoicingStates } = await import('@/lib/domain/sales/invoicing-state')
  const xeroom = await makeOrder(db, t, { wooNumber: 'INWC-1001' })
  const plain = await makeOrder(db, t)
  // Written by a path that does not know about the column (a script, psql, a restore): the repair must heal it.
  await db.$executeRaw`UPDATE "sales_orders" SET invoicing_state = 'FULLY_INVOICED' WHERE id = ${plain}`
  assert.equal(await stateOf(db, xeroom), 'NOT_INVOICED')
  assert.equal((await recomputeSalesOrderInvoicingState(db as never, xeroom)).state, 'FULLY_INVOICED')
  assert.equal(await stateOf(db, xeroom), 'FULLY_INVOICED')

  let after: string | null = null
  let changed = 0
  do {
    const page = await repairInvoicingStates(db as never, { limit: 200, after })
    changed += page.changed
    after = page.nextCursor
  } while (after)
  assert.ok(changed >= 1)
  assert.equal(await stateOf(db, plain), 'NOT_INVOICED')
  after = null
  let second = 0
  do {
    const page = await repairInvoicingStates(db as never, { limit: 200, after })
    second += page.changed
    after = page.nextCursor
  } while (after)
  assert.equal(second, 0, 'a second run changes nothing')
})

test('[invoicing state] the migration added the column with a NOT_INVOICED default, and the enum holds the three states', { skip }, async () => {
  const db = await loadDb()
  const [col] = await db.$queryRaw<{ column_default: string; is_nullable: string }[]>`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'sales_orders' AND column_name = 'invoicing_state'`
  assert.match(col.column_default, /NOT_INVOICED/)
  assert.equal(col.is_nullable, 'NO')
  const labels = await db.$queryRaw<{ enumlabel: string }[]>`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'InvoicingState' ORDER BY enumsortorder`
  assert.deepEqual(labels.map((l) => l.enumlabel), ['NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED'])
})

const FOR_UPDATE = /FOR UPDATE/i

test('[invoicing state] LOCK ORDER: a decision on an invoice row takes the order lock BEFORE writing the row, so a cancellation holding the order lock cannot deadlock with it', { skip }, async (t) => {
  const db = await loadDb()
  const { applyFencedAttemptDecision } = await import('@/lib/domain/accounting/sync-log-attempt')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const id = await makeOrder(db, t)
  const row = await db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', status: 'FAILED', referenceType: 'SalesOrder', referenceId: id, payload: payload(3, randomUUID()), attemptRevision: 1 } })
  let decision: Promise<{ ok: boolean }> | undefined
  let parked: { observedAfterMs: number } | undefined
  // The CANCELLATION holds the order lock, then writes the invoice row (the reference order). The retry's decision must queue behind the ORDER lock,
  // not take the row first: taking the row first is the reverse order and a deadlock (Postgres would abort one of the two).
  await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    const holder = await backendPid(tx)
    decision = db.$transaction((ctx) => applyFencedAttemptDecision(ctx as never, { id: row.id, expectedAttemptRevision: 1, expectedStatus: 'FAILED', data: { status: 'PENDING', retryCount: 0 } }))
    parked = await waitUntilParkedBehind(db, { holderPid: holder, waitingOn: FOR_UPDATE, describe: 'retry decision behind the cancellation\'s order lock' })
    await tx.accountingSyncLog.updateMany({ where: { id: row.id }, data: { status: 'CANCELLED', attemptRevision: { increment: 1 } } })
    await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
  })
  const result = await decision!
  assert.ok(parked, 'the decision parked behind the order lock before it wrote the row')
  assert.equal(result.ok, false, 'it then found the row already retired by the cancellation and wrote nothing')
  assert.equal((await db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id } })).status, 'CANCELLED')
  assert.equal(await stateOf(db, id), 'NOT_INVOICED')
})

test('[invoicing state] LOCK ORDER: the bulk-retry helper locks the orders of the rows being revived, in id order, before it returns', { skip }, async (t) => {
  const db = await loadDb()
  const { lockOrdersOfInvoiceRows } = await import('@/lib/domain/sales/invoicing-state')
  const { hasLockedSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const a = await makeOrder(db, t)
  const b = await makeOrder(db, t)
  const rows = await Promise.all([a, b].map((o) => db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', status: 'FAILED', referenceType: 'SalesOrder', referenceId: o, payload: payload(3, randomUUID()) } })))
  await db.$transaction(async (tx) => {
    await lockOrdersOfInvoiceRows(tx, { id: { in: rows.map((r) => r.id) } })
    assert.equal(hasLockedSalesOrder(tx as never, a), true)
    assert.equal(hasLockedSalesOrder(tx as never, b), true)
  })
})

test('[invoicing state] MIGRATION BACKFILL: the migration\'s own UPDATE marks exactly the orders with invoice evidence FULLY_INVOICED and leaves the rest alone, and is idempotent', { skip }, async (t) => {
  const db = await loadDb()
  const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261117233000_sales_order_invoicing_state/migration.sql'), 'utf8')
  const update = sql.slice(sql.indexOf('UPDATE "sales_orders"'))
  const mk = async (over: Parameters<typeof makeOrder>[2] = {}) => makeOrder(db, t, over)
  const none = await mk()
  const linked = await mk()
  await db.salesOrder.update({ where: { id: linked }, data: { accountingInvoiceId: `ext-${randomUUID()}` } })
  const queued = await mk()
  const synced = await mk()
  const failedNoId = await mk()
  const failedWithId = await mk()
  const shadow = await mk()
  const creditOnly = await mk()
  const xeroom = await mk({ wooNumber: 'INWC-77' })
  const row = (orderId: string, over: Record<string, unknown>) => db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: orderId, payload: payload(3, randomUUID()), ...over } as never })
  await row(queued, {})
  await row(synced, { status: 'SYNCED' })
  await row(failedNoId, { status: 'FAILED' })
  await row(failedWithId, { status: 'FAILED', externalTransactionId: 'doc-1' })
  await row(shadow, { status: 'CANCELLED', settlementBasis: 'HELD_SHADOW' })
  await row(creditOnly, { type: 'CREDIT_NOTE', status: 'SYNCED', externalTransactionId: 'cn-1' })
  // The column is at its default everywhere (the rows above were written with no recompute), which is the state a migration meets.
  const ids = [none, linked, queued, synced, failedNoId, failedWithId, shadow, creditOnly, xeroom]
  await db.$executeRaw`UPDATE "sales_orders" SET "invoicing_state" = 'NOT_INVOICED' WHERE id = ANY(${ids})`
  const run = async () => db.$executeRawUnsafe(update.replace('WHERE so."invoicing_state" = \'NOT_INVOICED\'', `WHERE so.id = ANY(ARRAY[${ids.map((i) => `'${i}'`).join(',')}]) AND so."invoicing_state" = 'NOT_INVOICED'`))
  await run()
  const states = Object.fromEntries(await Promise.all(Object.entries({ none, linked, queued, synced, failedNoId, failedWithId, shadow, creditOnly, xeroom }).map(async ([k, v]) => [k, await stateOf(db, v)])))
  assert.deepEqual(states, {
    none: 'NOT_INVOICED', linked: 'FULLY_INVOICED', queued: 'FULLY_INVOICED', synced: 'FULLY_INVOICED', failedNoId: 'NOT_INVOICED',
    failedWithId: 'FULLY_INVOICED', shadow: 'NOT_INVOICED', creditOnly: 'NOT_INVOICED', xeroom: 'FULLY_INVOICED',
  })
  assert.equal(await run(), 0, 'a second run changes nothing')
  // And the TypeScript derivation agrees with the SQL on every one of them (the repair finds nothing to change).
  const { recomputeSalesOrderInvoicingState } = await import('@/lib/domain/sales/invoicing-state')
  for (const id of ids) assert.equal((await recomputeSalesOrderInvoicingState(db as never, id)).changed, false, id)
})
