import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import { createTempDirSync } from '../scripts/temp-dir'

/**
 * THE ON-DEMAND QUEUE (a customer's first click on a historic order), THE CREDIT NOTE READER AND THE INVOICE E-MAIL'S ATTACHMENT, against a
 * real database (committing, with its own cleanup). The ledger and the clock are doubled; the schema, the unique keys, the compare-and-set,
 * the caps, the sweep and the readers are real. Nothing here contacts any vendor.
 *
 * Lives in the SERIAL concurrency tier, not tests/db: it runs the whole sweep and sets the sweep's settings, which another file running in
 * parallel against the same database would collide with (and the database-reset test in tests/db expects no stored documents while it runs).
 * GATED on RUN_DB_CONCURRENCY_TESTS (npm run test:concurrency).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

const DAY = 86_400_000
const SETTINGS = [
  'invoice_documents_lazy_fetch_enabled', 'invoice_documents_credit_notes_enabled', 'invoice_documents_sweep_floor',
  'invoice_documents_lazy_daily_cap', 'invoice_documents_lazy_outstanding_cap', 'wc_invoice_document_enabled',
]

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${tag}${'x'.repeat(400)}\n%%EOF\n`, 'latin1')
}

let storageDir: string | undefined

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  storageDir ??= createTempDirSync('invod-')
  process.env.INVOICE_PDF_STORAGE_DIR = storageDir
  const { db } = await import('../../lib/db')
  const onDemand = await import('../../lib/domain/invoice-documents/on-demand')
  const sweep = await import('../../lib/domain/invoice-documents/sweep')
  const current = await import('../../lib/domain/invoice-documents/current-document')
  const service = await import('../../lib/domain/invoice-documents/fetch-service')
  return { db, onDemand, sweep, current, service }
}
type Ctx = Awaited<ReturnType<typeof setup>>

async function withSettings(ctx: Ctx, values: Record<string, string | null>, fn: () => Promise<void>) {
  const saved = await ctx.db.setting.findMany({ where: { key: { in: SETTINGS } } })
  try {
    await ctx.db.setting.deleteMany({ where: { key: { in: SETTINGS } } })
    for (const [key, value] of Object.entries(values)) if (value !== null) await ctx.db.setting.create({ data: { key, value } })
    await fn()
  } finally {
    await ctx.db.setting.deleteMany({ where: { key: { in: SETTINGS } } })
    for (const row of saved) await ctx.db.setting.create({ data: { key: row.key, value: row.value } })
  }
}

/** A HISTORIC order: a year old, with a storefront link and an invoice number, no stored document. */
async function seedOrder(ctx: Ctx, options: { refund?: boolean; customerEmail?: string } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const order = await ctx.db.salesOrder.create({
    data: {
      orderNumber: `IOD-${suffix}`,
      invoiceNumber: `INV-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      createdAt: new Date(Date.now() - 400 * DAY),
      ...(options.customerEmail ? { customerEmail: options.customerEmail } : {}),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${suffix}` } },
      ...(options.refund
        ? { refunds: { create: { creditNoteNumber: `CN-${suffix}`, externalRefundId: 7000000 + Math.floor(Math.random() * 1000000), totalForeign: new Prisma.Decimal('10'), totalBase: new Prisma.Decimal('10'), createdAt: new Date(Date.now() - 399 * DAY) } } }
        : {}),
    },
    select: { id: true, orderNumber: true, invoiceNumber: true, refunds: { select: { id: true, creditNoteNumber: true } } },
  })
  return order
}

async function cleanup(ctx: Ctx, ...orderIds: string[]) {
  for (const orderId of orderIds) {
    await ctx.db.salesOrderInvoiceDocument.deleteMany({ where: { orderId } })
    await ctx.db.invoiceDocumentFetchState.deleteMany({ where: { orderId } })
    await ctx.db.activityLog.deleteMany({ where: { entityId: orderId } })
    await ctx.db.shoppingOrderLink.deleteMany({ where: { orderId } })
    await ctx.db.salesOrderRefund.deleteMany({ where: { orderId } })
    await ctx.db.salesOrder.delete({ where: { id: orderId } })
  }
}

type Deps = import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps

function ledger(orders: Array<{ orderNumber: string | null; invoiceNumber: string | null; refunds?: Array<{ creditNoteNumber: string | null }> }>, over: { bytes?: Buffer; none?: boolean; now?: () => Date } = {}) {
  const calls = { lookups: [] as string[], creditLookups: [] as string[], downloads: 0 }
  const date = new Date().toISOString()
  const deps: Deps = {
    lookupInvoiceClaims: async (number) => {
      calls.lookups.push(number)
      const order = orders.find((o) => o.invoiceNumber === number)
      return { ok: true, claims: over.none || !order ? [] : [{ documentId: `xero-${number}`, documentNumber: number, status: 'AUTHORISED', total: 100, currencyCode: 'GBP', dateString: date, reference: order.orderNumber ?? undefined }] }
    },
    lookupCreditNoteClaims: async (number) => {
      calls.creditLookups.push(number)
      const order = orders.find((o) => o.refunds?.some((r) => r.creditNoteNumber === number))
      return { ok: true, claims: over.none || !order ? [] : [{ documentId: `xero-${number}`, documentNumber: number, status: 'AUTHORISED', total: 10, currencyCode: 'GBP', dateString: date, reference: order.orderNumber ?? undefined }] }
    },
    downloadPdf: async () => { calls.downloads++; return { ok: true, buffer: over.bytes ?? pdf('ledger') } },
    now: over.now ?? (() => new Date()),
  }
  return { deps, calls }
}

test('OFF: with the on-demand setting off (the default) nothing is queued, nothing is written, and the sweep still does nothing without a floor', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx)
  try {
    await withSettings(ctx, {}, async () => {
      const outcome = await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      assert.equal(outcome.status, 'unavailable')
      assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: order.id } }), 0, 'no row')
      const { deps, calls } = ledger([order])
      assert.equal((await ctx.sweep.runInvoiceDocumentSweep(deps)).skipped, 'no-floor')
      assert.equal(calls.lookups.length, 0)
    })
  } finally { await cleanup(ctx, order.id) }
})

test('ON: the first click QUEUES (one row, one activity row), repeats and concurrent clicks are de-duplicated, and the ledger is not asked by any of them', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx)
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      const first = await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      assert.deepEqual(first, { status: 'preparing', queued: true, retryAfterSeconds: 900 })
      const again = await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      assert.equal(again.status === 'preparing' && again.queued, false)
      const race = await Promise.all(Array.from({ length: 8 }, () => ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })))
      assert.ok(race.every((r) => r.status === 'preparing' && r.queued === false), 'a concurrent repeat never queues a second time')
      const states = await ctx.db.invoiceDocumentFetchState.findMany({ where: { orderId: order.id } })
      assert.equal(states.length, 1)
      assert.ok(states[0]!.customerRequestedAt)
      assert.equal(states[0]!.attempts, 0, 'nothing was attempted by the click')
      assert.equal(await ctx.db.activityLog.count({ where: { entityId: order.id, action: 'invoice_document_requested' } }), 1)
    })
  } finally { await cleanup(ctx, order.id) }
})

test('two concurrent FIRST clicks on a fresh order queue exactly once (repeated: one pass proves nothing about a race)', { skip }, async () => {
  const ctx = await setup()
  const orders = await Promise.all(Array.from({ length: 4 }, () => seedOrder(ctx)))
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      for (const order of orders) {
        const results = await Promise.all(Array.from({ length: 6 }, () => ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })))
        assert.equal(results.filter((r) => r.status === 'preparing' && r.queued).length, 1, 'exactly one click queued it')
        assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: order.id } }), 1)
      }
    })
  } finally { await cleanup(ctx, ...orders.map((o) => o.id)) }
})

test('the sweep fetches a queued historic order with NO floor set (read-only: lookup, download, re-read), and a LATER click is served the PDF', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx)
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      assert.equal(await ctx.current.loadCurrentInvoicePdf(order.id), null, 'nothing is served before the fetch has run')
      const bytes = pdf('historic')
      const { deps, calls } = ledger([order], { bytes })
      const result = await ctx.sweep.runInvoiceDocumentSweep(deps)
      assert.equal(result.skipped, undefined)
      assert.equal(result.stored, 1)
      assert.deepEqual(calls.lookups.filter((n) => n === order.invoiceNumber), [order.invoiceNumber, order.invoiceNumber], 'one lookup and the re-read of the same document')
      assert.deepEqual(await ctx.current.loadCurrentInvoicePdf(order.id), bytes, 'the later click is served the stored PDF')
      const stored = await ctx.db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true, accountingInvoiceId: true } })
      assert.ok(stored.invoicePdfPath, 'the route will see a stored PDF on the next click')
      assert.equal(stored.accountingInvoiceId, null, 'the ledger link column is never written')
      // Done: a second run asks the ledger about nothing for it.
      const second = ledger([order], { bytes })
      await ctx.sweep.runInvoiceDocumentSweep(second.deps)
      assert.deepEqual(second.calls.lookups.filter((n) => n === order.invoiceNumber), [])
    })
  } finally { await cleanup(ctx, order.id) }
})

test('a queued document the ledger does not hold yet WAITS with the fetch backoff; clicks meanwhile do not queue again or reach the ledger', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx)
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      const now = new Date()
      const { deps, calls } = ledger([order], { none: true, now: () => now })
      assert.equal((await ctx.sweep.runInvoiceDocumentSweep(deps)).waiting, 1)
      assert.equal(calls.lookups.length, 1)
      const click = await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE', now })
      assert.equal(click.status === 'preparing' && click.queued, false)
      assert.equal(click.status === 'preparing' && click.retryAfterSeconds, 600, 'told to come back when the retry is due (10 minutes)')
      await ctx.sweep.runInvoiceDocumentSweep(deps)
      assert.equal(calls.lookups.length, 1, 'inside the backoff window the sweep does not ask again')
    })
  } finally { await cleanup(ctx, order.id) }
})

test('the sweep takes at most LAZY_REQUESTS_PER_RUN customer requests per run, oldest first', { skip }, async () => {
  const ctx = await setup()
  const orders = await Promise.all(Array.from({ length: 8 }, () => seedOrder(ctx)))
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      for (const order of orders) await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })
      const { deps, calls } = ledger(orders, { none: true })
      const result = await ctx.sweep.runInvoiceDocumentSweep(deps)
      assert.equal(result.considered, ctx.onDemand.LAZY_REQUESTS_PER_RUN)
      assert.equal(calls.lookups.length, ctx.onDemand.LAZY_REQUESTS_PER_RUN)
    })
  } finally { await cleanup(ctx, ...orders.map((o) => o.id)) }
})

test('RATE LIMIT: the daily cap and the waiting cap stop new requests (nothing queued, a Retry-After given), and existing requests are unaffected', { skip }, async () => {
  const ctx = await setup()
  const [a, b, c] = await Promise.all([seedOrder(ctx), seedOrder(ctx), seedOrder(ctx)])
  try {
    const today = await ctx.db.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { gte: ctx.onDemand.startOfUtcDay(new Date()) } } })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_lazy_daily_cap: String(today + 1) }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: a.id, kind: 'INVOICE' })).status, 'preparing')
      const blocked = await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: b.id, kind: 'INVOICE' })
      assert.equal(blocked.status, 'throttled')
      assert.ok(blocked.status === 'throttled' && blocked.retryAfterSeconds >= 60 && blocked.retryAfterSeconds <= 3600)
      assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: b.id } }), 0, 'a throttled click queues nothing')
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: a.id, kind: 'INVOICE' })).status, 'preparing', 'the order already queued is still answered')
    })
    const waiting = await ctx.db.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { not: null }, status: 'PENDING' } })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_lazy_outstanding_cap: String(waiting) }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: c.id, kind: 'INVOICE' })).status, 'throttled')
      assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: c.id } }), 0)
    })
  } finally { await cleanup(ctx, a.id, b.id, c.id) }
})

test('CAPS ARE ATOMIC: a burst of first clicks on DIFFERENT documents never queues more than the daily cap or the waiting cap', { skip }, async () => {
  const ctx = await setup()
  const orders = await Promise.all(Array.from({ length: 12 }, () => seedOrder(ctx)))
  try {
    const today = await ctx.db.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { gte: ctx.onDemand.startOfUtcDay(new Date()) } } })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_lazy_daily_cap: String(today + 3) }, async () => {
      const results = await Promise.all(orders.map((o) => ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: o.id, kind: 'INVOICE' })))
      assert.equal(results.filter((r) => r.status === 'preparing' && r.queued).length, 3, 'exactly the daily cap was queued')
      assert.equal(results.filter((r) => r.status === 'throttled').length, 9)
      assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: { in: orders.map((o) => o.id) }, customerRequestedAt: { not: null } } }), 3)
    })
    await ctx.db.invoiceDocumentFetchState.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } })
    const waiting = await ctx.db.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { not: null }, status: 'PENDING' } })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_lazy_outstanding_cap: String(waiting + 2) }, async () => {
      const results = await Promise.all(orders.map((o) => ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: o.id, kind: 'INVOICE' })))
      assert.equal(results.filter((r) => r.status === 'preparing' && r.queued).length, 2, 'exactly the waiting cap was queued')
    })
  } finally { await cleanup(ctx, ...orders.map((o) => o.id)) }
})

test('THE DEFAULT CAP IS DERIVED FROM THE REAL 950-CALL LIMIT: worst case (3 reads each) is at most 20% of it', { skip }, async () => {
  const ctx = await setup()
  assert.ok(ctx.onDemand.DEFAULT_LAZY_DAILY_CAP * ctx.onDemand.LAZY_READS_PER_DOCUMENT <= ctx.onDemand.XERO_DAY_CALL_LIMIT * ctx.onDemand.LAZY_BUDGET_SHARE)
  assert.equal(ctx.onDemand.XERO_DAY_CALL_LIMIT, 950)
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('lib/connectors/xero/api.ts', 'utf8'), /const XERO_DAY_LIMIT = 950/, 'the constant the cap is derived from is the client\'s real one')
})

test('THE SWEEP DEFERS QUEUED REQUESTS WHILE THE SHARED LEDGER BUDGET IS LOW, and runs them (nothing lost) once it recovers', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx)
  try {
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })).status, 'preparing')
      const low = ledger([order])
      low.deps.dayCallsRemaining = () => ctx.sweep.LAZY_MIN_DAY_CALLS_REMAINING - 1
      const deferred = await ctx.sweep.runInvoiceDocumentSweep(low.deps)
      assert.equal(deferred.lazyDeferred, 'ledger-budget-low')
      assert.equal(deferred.considered, 0)
      assert.equal(low.calls.lookups.length, 0, 'the ledger was not asked')
      const ok = ledger([order])
      ok.deps.dayCallsRemaining = () => ctx.sweep.LAZY_MIN_DAY_CALLS_REMAINING
      const ran = await ctx.sweep.runInvoiceDocumentSweep(ok.deps)
      assert.equal(ran.stored, 1, 'the queued request is still there and runs once the budget allows')
      assert.equal(ran.lazyDeferred, undefined)
    })
  } finally { await cleanup(ctx, order.id) }
})

test('nothing is queued for a document that cannot be found, is already stored, or needs a person', { skip }, async () => {
  const ctx = await setup()
  const noNumber = await seedOrder(ctx)
  const stored = await seedOrder(ctx)
  const flagged = await seedOrder(ctx)
  try {
    await ctx.db.salesOrder.update({ where: { id: noNumber.id }, data: { invoiceNumber: null } })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: noNumber.id, kind: 'INVOICE' })).status, 'unavailable')
      assert.equal(await ctx.db.invoiceDocumentFetchState.count({ where: { orderId: noNumber.id } }), 0)

      const { deps } = ledger([stored])
      assert.equal((await ctx.service.ensureInvoiceDocument({ orderId: stored.id, kind: 'INVOICE' }, deps)).status, 'stored')
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: stored.id, kind: 'INVOICE' })).status, 'unavailable', 'a stored document is the recheck\'s job, not a click\'s')

      await ctx.db.invoiceDocumentFetchState.create({ data: { subjectKey: ctx.service.invoiceDocumentSubjectKey(flagged.id, 'INVOICE'), orderId: flagged.id, kind: 'INVOICE', status: 'NEEDS_ATTENTION', lastError: 'two live documents' } })
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: flagged.id, kind: 'INVOICE' })).status, 'unavailable')
      assert.equal((await ctx.db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: flagged.id } })).customerRequestedAt, null)
    })
  } finally { await cleanup(ctx, noNumber.id, stored.id, flagged.id) }
})

test('CREDIT NOTES: queued only with the credit note switch, fetched by the sweep, served only through the refund of that very order', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx, { refund: true })
  const other = await seedOrder(ctx, { refund: true })
  try {
    const refundId = order.refunds[0]!.id
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true' }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'CREDIT_NOTE', refundId })).status, 'unavailable', 'credit notes are their own switch')
    })
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_credit_notes_enabled: 'true' }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'CREDIT_NOTE', refundId: other.refunds[0]!.id })).status, 'unavailable', 'a refund of another order is never queued through this one')
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'CREDIT_NOTE', refundId })).status, 'preparing')
      assert.equal(await ctx.current.loadCurrentCreditNotePdf(order.id, refundId), null, 'not served before it is fetched')
      const bytes = pdf('credit-note')
      const { deps, calls } = ledger([order], { bytes })
      assert.equal((await ctx.sweep.runInvoiceDocumentSweep(deps)).stored, 1)
      assert.deepEqual(calls.creditLookups.filter((n) => n === order.refunds[0]!.creditNoteNumber).length > 0, true)
      assert.deepEqual(await ctx.current.loadCurrentCreditNotePdf(order.id, refundId), bytes, 'served, as its own document')
      assert.equal(await ctx.current.loadCurrentInvoicePdf(order.id), null, 'and it is not the invoice')

      // OWNERSHIP: the same refund through any other order, or another refund through this one, serves nothing.
      assert.equal(await ctx.current.loadCurrentCreditNotePdf(other.id, refundId), null)
      assert.equal(await ctx.current.loadCurrentCreditNotePdf(order.id, other.refunds[0]!.id), null)

      // Withdrawn, or the credit note number shared by another refund: refused.
      await ctx.db.salesOrderInvoiceDocument.updateMany({ where: { refundId }, data: { withdrawnAt: new Date() } })
      assert.equal(await ctx.current.loadCurrentCreditNotePdf(order.id, refundId), null)
      await ctx.db.salesOrderInvoiceDocument.updateMany({ where: { refundId }, data: { withdrawnAt: null } })
      assert.deepEqual(await ctx.current.loadCurrentCreditNotePdf(order.id, refundId), bytes)
      await ctx.db.salesOrderRefund.update({ where: { id: other.refunds[0]!.id }, data: { creditNoteNumber: order.refunds[0]!.creditNoteNumber } })
      assert.equal(await ctx.current.loadCurrentCreditNotePdf(order.id, refundId), null, 'a shared number is not this refund\'s document')
    })
  } finally { await cleanup(ctx, order.id, other.id) }
})

test('NO FLOOR: a queued credit note and a queued invoice that are stored (DONE) are rechecked when due, so an amended one is not served for ever', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx, { refund: true })
  try {
    const refundId = order.refunds[0]!.id
    await withSettings(ctx, { invoice_documents_lazy_fetch_enabled: 'true', invoice_documents_credit_notes_enabled: 'true' }, async () => {
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'CREDIT_NOTE', refundId })).status, 'preparing')
      assert.equal((await ctx.onDemand.requestInvoiceDocumentOnDemand({ orderId: order.id, kind: 'INVOICE' })).status, 'preparing')
      assert.equal((await ctx.sweep.runInvoiceDocumentSweep(ledger([order]).deps)).stored, 2, 'both stored by the first run (no floor is set)')
      // Nothing is due yet: the next run has nothing to do.
      assert.equal((await ctx.sweep.runInvoiceDocumentSweep(ledger([order]).deps)).considered, 0)
      // Both rechecks fall due.
      await ctx.db.invoiceDocumentFetchState.updateMany({ where: { orderId: order.id }, data: { nextAttemptAt: new Date(Date.now() - 60_000) } })
      const again = ledger([order])
      const run = await ctx.sweep.runInvoiceDocumentSweep(again.deps)
      assert.equal(run.considered, 2, 'a stored, queued document is looked at again when its recheck is due, with no floor set')
      assert.ok(again.calls.creditLookups.length > 0 && again.calls.lookups.length > 0, 'the ledger was asked about both')
    })
  } finally { await cleanup(ctx, order.id) }
})

test('THE INVOICE E-MAIL: flag off attaches what IMS renders itself, exactly as before; flag on attaches the stored ledger PDF; a stored document that cannot be served holds the mail back', { skip }, async () => {
  const ctx = await setup()
  const order = await seedOrder(ctx, { customerEmail: 'buyer@example.test' })
  const bare = await seedOrder(ctx, { customerEmail: 'buyer2@example.test' })
  try {
    const { prepareQueuedEmail } = await import('../../lib/order-email')
    const stored = pdf('ledger-original')
    const { deps } = ledger([order], { bytes: stored })
    assert.equal((await ctx.service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')

    await withSettings(ctx, {}, async () => {
      const off = await prepareQueuedEmail('INVOICE', 'SalesOrder', order.id)
      assert.ok(off)
      assert.ok(!off.attachments![0]!.content.equals(stored), 'flag off: IMS\'s own rendering, not the ledger PDF')
      assert.equal(off.attachments![0]!.content.subarray(0, 5).toString('latin1'), '%PDF-')
    })
    await withSettings(ctx, { wc_invoice_document_enabled: 'false' }, async () => {
      const off = await prepareQueuedEmail('INVOICE', 'SalesOrder', order.id)
      assert.ok(!off!.attachments![0]!.content.equals(stored))
    })
    await withSettings(ctx, { wc_invoice_document_enabled: 'true' }, async () => {
      const on = await prepareQueuedEmail('INVOICE', 'SalesOrder', order.id)
      assert.ok(on!.attachments![0]!.content.equals(stored), 'flag on: the stored ledger PDF')
      assert.match(on!.attachments![0]!.filename, /^Invoice-.*\.pdf$/)

      // An order with no stored document keeps the rendering it always had.
      const none = await prepareQueuedEmail('INVOICE', 'SalesOrder', bare.id)
      assert.equal(none!.attachments![0]!.content.subarray(0, 5).toString('latin1'), '%PDF-')

      // A stored document IMS will not serve right now holds the mail back instead of sending another rendering.
      await ctx.db.salesOrderInvoiceDocument.updateMany({ where: { orderId: order.id }, data: { withdrawnAt: new Date() } })
      await assert.rejects(() => prepareQueuedEmail('INVOICE', 'SalesOrder', order.id), /not available to send/)
    })
  } finally { await cleanup(ctx, order.id, bare.id) }
})
