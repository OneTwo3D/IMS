import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { originalSalesInvoiceDay, readCreditNoteDocumentDay } from '../../lib/domain/accounting/document-date'
import { readPostedSalesInvoiceDate } from '../../lib/domain/accounting/posted-invoice-date'

/**
 * THE DOCUMENT DATE AN UPDATE OR A RETRY CARRIES, READ FROM REAL ROWS.
 *
 *  - An update of a posted sales invoice reads its date from the payload of the SALES_INVOICE row that posted it (the row whose document id is the order's accounting invoice id),
 *    never from the clock; an order with nothing readable is refused (null).
 *  - A credit note is dated by its refund's own creation, so a retry run again (and again) carries the same day.
 *
 * Statements over `accounting_sync_logs` and the refund table, so database-backed. ROLLED BACK, ALWAYS. Gated on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire
 * (npm run test:db), for the reason written out in tests/db/reconciliation-unmirrored-sync-logs.test.ts.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/document-date-payload.test.ts would have been skipped '
    + 'in an environment that promised a migrated database. Fix the invocation (npm run test:db).',
  )
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

async function seedOrder(tx: Tx, run: string, over: { accountingInvoiceId: string | null; externalCreatedAt?: Date | null; invoicedAt?: Date | null }) {
  return tx.salesOrder.create({
    data: {
      orderNumber: `DDP-${run}-${randomUUID().slice(0, 6)}`, status: 'PROCESSING', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: '100', totalForeign: '120', subtotalBase: '100', taxBase: '20', totalBase: '120',
      accountingInvoiceId: over.accountingInvoiceId, externalCreatedAt: over.externalCreatedAt ?? null, invoicedAt: over.invoicedAt ?? null,
    },
    select: { id: true, accountingInvoiceId: true, externalCreatedAt: true, invoicedAt: true },
  })
}

const syncRow = (tx: Tx, orderId: string, over: { type?: string; status?: string; externalTransactionId: string | null; payload: unknown; id?: string }) =>
  tx.accountingSyncLog.create({
    data: {
      id: over.id ?? `ddp-${randomUUID()}`, connector: 'xero', type: over.type ?? 'SALES_INVOICE', status: over.status ?? 'SYNCED',
      referenceType: 'SalesOrder', referenceId: orderId, externalTransactionId: over.externalTransactionId, payload: over.payload,
    },
    select: { id: true },
  })

test('[db] an update reads the original date from the posted SALES_INVOICE payload, ignoring a shadow, another id and an UPDATE row; a legacy post-instant stamp is a day off', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    // A manual order: no storefront date, and an `invoicedAt` that holds the post INSTANT (00:30 BST on 1 Oct = the London day AFTER the payload date).
    const order = await seedOrder(tx, run, { accountingInvoiceId: `XI-${run}`, invoicedAt: new Date('2026-09-30T23:30:00Z') })
    await syncRow(tx, order.id, { status: 'CANCELLED', externalTransactionId: null, payload: { date: '2026-11-01' } }) // a shadow: names no document
    await syncRow(tx, order.id, { externalTransactionId: `OTHER-${run}`, payload: { date: '2026-01-01' } })
    await syncRow(tx, order.id, { type: 'SALES_INVOICE_UPDATE', externalTransactionId: `XI-${run}`, payload: { date: '2026-10-02' } })
    await syncRow(tx, order.id, { externalTransactionId: `XI-${run}`, payload: { date: '2026-09-30' } })
    const posted = await readPostedSalesInvoiceDate(tx, order.id, `XI-${run}`)
    const day = originalSalesInvoiceDay({ accountingInvoiceId: order.accountingInvoiceId, postedPayloadDate: posted, externalCreatedAt: order.externalCreatedAt, invoicedAt: order.invoicedAt, now: new Date('2026-10-05T10:00:00Z') })
    const stampOnly = originalSalesInvoiceDay({ accountingInvoiceId: order.accountingInvoiceId, postedPayloadDate: null, externalCreatedAt: order.externalCreatedAt, invoicedAt: order.invoicedAt })
    return { posted, day, stampOnly }
  })
  assert.equal(observed.posted?.toISOString(), '2026-09-30T00:00:00.000Z')
  assert.equal(observed.day, '2026-09-30', 'the payload day, not the update row, the shadow or the other invoice')
  assert.equal(observed.stampOnly, '2026-10-01', 'CONTROL: the stored stamp alone is the day after (what the update used to send)')
})

test('[db] an order with an invoice id but no invoicedAt and no posted payload is REFUSED (null), and a payload with no readable date reads as none', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    const order = await seedOrder(tx, run, { accountingInvoiceId: `XI-${run}` })
    const none = await readPostedSalesInvoiceDate(tx, order.id, `XI-${run}`)
    await syncRow(tx, order.id, { externalTransactionId: `XI-${run}`, payload: { invoiceNumber: 'x' } })
    const unreadable = await readPostedSalesInvoiceDate(tx, order.id, `XI-${run}`)
    const input = { accountingInvoiceId: order.accountingInvoiceId, externalCreatedAt: order.externalCreatedAt, invoicedAt: order.invoicedAt, now: new Date('2026-10-05T10:00:00Z') }
    return { none, unreadable, refused: originalSalesInvoiceDay({ ...input, postedPayloadDate: unreadable }) }
  })
  assert.equal(observed.none, null)
  assert.equal(observed.unreadable, null)
  assert.equal(observed.refused, null, 'refused, never today (2026-10-05)')
})

test('[db] a credit note run twice (a retry, long after) carries the refund\'s own day both times; an unknown refund reads as none', { skip }, async () => {
  const run = randomUUID().slice(0, 8)
  const observed = await withRollback(async (tx) => {
    const order = await seedOrder(tx, run, { accountingInvoiceId: null })
    // Raised 23:30 BST on 30 Sep (22:30Z): its day is 30 Sep, and today is November.
    const refund = await tx.salesOrderRefund.create({
      data: { orderId: order.id, totalForeign: '50', totalBase: '50', createdAt: new Date('2026-09-30T22:30:00Z') },
      select: { id: true },
    })
    const first = await readCreditNoteDocumentDay(tx, refund.id)
    const retry = await readCreditNoteDocumentDay(tx, refund.id)
    const unknown = await readCreditNoteDocumentDay(tx, `missing-${run}`)
    return { first, retry, unknown }
  })
  assert.equal(observed.first, '2026-09-30')
  assert.equal(observed.retry, '2026-09-30', 'the retry rebuilds the credit note with the same date')
  assert.equal(observed.unknown, null)
})
