import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * THE INVOICE-DOCUMENT FETCH AGAINST A REAL DATABASE (committing, with its own cleanup: the service opens its own
 * transaction, so a rollback harness cannot wrap it). The ledger and the clock are doubled; the schema, the unique
 * keys, the supersede rule, the file store and the state machine are real.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/invoice-document-fetch.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${tag}${'x'.repeat(400)}\n%%EOF\n`, 'latin1')
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  process.env.INVOICE_PDF_STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'invdoc-'))
  const { db } = await import('../../lib/db')
  const service = await import('../../lib/domain/invoice-documents/fetch-service')
  const sweep = await import('../../lib/domain/invoice-documents/sweep')
  return { db, service, sweep }
}

async function seedOrder(db: Awaited<ReturnType<typeof setup>>['db'], withCreditNote = false, options: { invoiceNumber?: string; status?: string; customerName?: string; totalForeign?: string; storeCredit?: string; assessment?: 'ASSESSED' | 'REVIEW_REQUIRED' } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `IDOC-${suffix}`,
      ...(options.customerName ? { customerName: options.customerName } : {}),
      invoiceNumber: options.invoiceNumber ?? `INV-${suffix}`,
      status: (options.status ?? 'SHIPPED') as never,
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal(options.totalForeign ?? '100'),
      ...(options.storeCredit ? { storeCreditForeign: new Prisma.Decimal(options.storeCredit) } : {}),
      ...(options.assessment ? { storeCreditAssessment: options.assessment } : {}),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${suffix}` } },
      ...(withCreditNote
        ? { refunds: { create: { creditNoteNumber: `CN-${suffix}`, totalForeign: new Prisma.Decimal('10'), totalBase: new Prisma.Decimal('10') } } }
        : {}),
    },
    select: { id: true, invoiceNumber: true, orderNumber: true, refunds: { select: { id: true, creditNoteNumber: true } } },
  })
  return { suffix, order }
}

const LEDGER_DATE = new Date().toISOString()

/** What the ledger says about a document that really is this order's. */
function ledgerClaim(order: { orderNumber: string | null }, number: string, over: Record<string, unknown> = {}) {
  return { documentId: 'xero-1', documentNumber: number, status: 'AUTHORISED', total: 100, currencyCode: 'GBP', dateString: LEDGER_DATE, reference: order.orderNumber ?? undefined, ...over }
}

async function cleanup(db: Awaited<ReturnType<typeof setup>>['db'], orderId: string) {
  await db.salesOrderInvoiceDocument.deleteMany({ where: { orderId } })
  await db.invoiceDocumentFetchState.deleteMany({ where: { orderId } })
  await db.shoppingOrderLink.deleteMany({ where: { orderId } })
  await db.salesOrderRefund.deleteMany({ where: { orderId } })
  await db.salesOrder.delete({ where: { id: orderId } })
}

test('stores a version, is idempotent, supersedes an amended document, never touches accountingInvoiceId', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    let bytes = pdf('v1')
    let status = 'AUTHORISED'
    const calls = { lookup: 0, download: 0 }
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async (number) => { calls.lookup++; return { ok: true, claims: [ledgerClaim(order, number, { status })] } },
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => { calls.download++; return { ok: true, buffer: bytes } },
      now: () => new Date(),
    }
    const first = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(first.status, 'stored')
    assert.equal(first.status === 'stored' && first.created, true)

    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true, accountingInvoiceId: true } })
    assert.equal(row.accountingInvoiceId, null, 'the ledger link column is never written')
    const firstDoc = await db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(row.invoicePdfPath, firstDoc.storedPath, 'the compatibility pointer names the immutable file of the current version')
    const { loadCurrentInvoicePdf: loadInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    assert.deepEqual(await loadInvoicePdf(order.id), bytes)

    // The same bytes again: no new row, no new file.
    const again = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)
    assert.equal(again.status === 'stored' && again.created, false)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 1)

    // The ledger document changes: a NEW version, the old one superseded and still on disk.
    bytes = pdf('v2-amended')
    status = 'PAID'
    const amended = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)
    assert.equal(amended.status === 'stored' && amended.created, true)
    const rows = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id }, orderBy: { fetchedAt: 'asc' } })
    assert.equal(rows.length, 2)
    assert.equal(rows.filter((r) => r.supersededAt === null).length, 1, 'exactly one current version')
    assert.equal(rows[1].supersededAt, null)
    assert.equal(rows[1].externalStatus, 'PAID')
    for (const r of rows) {
      const file = path.join(process.env.INVOICE_PDF_STORAGE_DIR!, r.storedPath.replace(/^invoice-pdfs\//, ''))
      assert.ok(existsSync(file), `version file kept: ${r.storedPath}`)
      assert.match(readFileSync(file, 'latin1'), /^%PDF-/)
    }
    assert.deepEqual(await loadInvoicePdf(order.id), bytes, 'readers are served the current version')
  } finally {
    await cleanup(db, order.id)
  }
})

test('waits for a missing document with a widening backoff, and asks the ledger once while backing off', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    let lookups = 0
    const now = new Date('2026-11-09T10:00:00Z')
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async () => { lookups++; return { ok: true, claims: [] } },
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => { throw new Error('must not download') },
      now: () => now,
    }
    const first = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(first.status, 'waiting')
    const second = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(second.status, 'backoff', 'a second click inside the window does not reach the ledger')
    assert.equal(lookups, 1)
    const state = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(state.status, 'PENDING')
    assert.equal(state.attempts, 1)
    assert.equal(state.nextAttemptAt?.getTime(), now.getTime() + 600_000)
  } finally {
    await cleanup(db, order.id)
  }
})

test('an ambiguous ledger answer needs a person and is not retried', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    let lookups = 0
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async (number) => { lookups++; return { ok: true, claims: [{ documentId: 'a', documentNumber: number, status: 'AUTHORISED' }, { documentId: 'b', documentNumber: number, status: 'AUTHORISED' }] } },
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => { throw new Error('must not download') },
      now: () => new Date(),
    }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'needs-attention')
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)).status, 'needs-attention')
    assert.equal(lookups, 1, 'a document that needs a person is not asked about again')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a refused, truncated or non-PDF download stores nothing and is retried later', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number, { documentId: 'x' })] }),
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => ({ ok: true, buffer: Buffer.from('<html>login page</html>'.repeat(20)) }),
      now: () => new Date(),
    }
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(outcome.status, 'failed')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)

    const stop = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, { ...deps, downloadPdf: async () => ({ ok: false, error: 'HTTP 429', stop: true }) })
    assert.equal(stop.status === 'failed' && stop.stop, true)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a credit note is stored against its refund and does not become the order invoice pointer', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db, true)
  const refund = order.refunds[0]
  try {
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async () => ({ ok: true, claims: [] }),
      lookupCreditNoteClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number, { documentId: 'cn-1' })] }),
      downloadPdf: async (kind) => ({ ok: true, buffer: pdf(`kind-${kind}`) }),
      now: () => new Date(),
    }
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'CREDIT_NOTE', refundId: refund.id }, deps)
    assert.equal(outcome.status, 'stored')
    const doc = await db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(doc.kind, 'CREDIT_NOTE')
    assert.equal(doc.refundId, refund.id)
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'CREDIT_NOTE' }, deps)).status, 'not-applicable')
  } finally {
    await cleanup(db, order.id)
  }
})

test('the sweep does nothing without a floor, takes only recent WooCommerce orders, and honours the credit note switch', { skip }, async () => {
  const { db, sweep } = await setup()
  const { order } = await seedOrder(db, true)
  const keys = [sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING, sweep.INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING]
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  try {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async () => ({ ok: true, claims: [] }),
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => { throw new Error('unused') },
      now: () => new Date(),
    }
    assert.equal((await sweep.runInvoiceDocumentSweep(deps)).skipped, 'no-floor')
    await db.setting.create({ data: { key: sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING, value: 'not a date' } })
    assert.equal((await sweep.runInvoiceDocumentSweep(deps)).skipped, 'bad-floor')

    const future = new Date(Date.now() + 86_400_000)
    assert.deepEqual(await sweep.selectInvoiceDocumentCandidates(future, new Date(), 50, true), [], 'an order older than the floor is not swept')
    const past = new Date(Date.now() - 86_400_000)
    const invoicesOnly = (await sweep.selectInvoiceDocumentCandidates(past, new Date(), 500, false)).filter((c) => c.orderId === order.id)
    assert.deepEqual(invoicesOnly, [{ orderId: order.id, kind: 'INVOICE' }])
    const withCredit = (await sweep.selectInvoiceDocumentCandidates(past, new Date(), 500, true)).filter((c) => c.orderId === order.id)
    assert.equal(withCredit.length, 2)
  } finally {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of saved) await db.setting.create({ data: { key: row.key, value: row.value } })
    await cleanup(db, order.id)
  }
})

type Deps = import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps

function depsFor(order: { orderNumber: string | null }, over: Partial<Deps> & { claim?: Record<string, unknown>; bytes?: () => Buffer; downloads?: { n: number } } = {}): Deps {
  return {
    lookupInvoiceClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number, over.claim ?? {})] }),
    lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
    downloadPdf: async () => { if (over.downloads) over.downloads.n++; return { ok: true, buffer: (over.bytes ?? (() => pdf('doc')))() } },
    now: () => new Date(),
    ...over,
  }
}

test('an invoice number shared by two IMS orders is refused for both: nothing is fetched or stored', { skip }, async () => {
  const { db, service } = await setup()
  const shared = `INV-SHARED-${randomUUID().slice(0, 8)}`
  const a = await seedOrder(db, false, { invoiceNumber: shared })
  const b = await seedOrder(db, false, { invoiceNumber: shared })
  try {
    const downloads = { n: 0 }
    for (const o of [a.order, b.order]) {
      const outcome = await service.ensureInvoiceDocument({ orderId: o.id, kind: 'INVOICE' }, depsFor(o, { downloads }))
      assert.equal(outcome.status, 'needs-attention')
      assert.match(outcome.status === 'needs-attention' ? outcome.reason : '', /same number/)
    }
    assert.equal(downloads.n, 0)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: { in: [a.order.id, b.order.id] } } }), 0)
  } finally {
    await cleanup(db, a.order.id)
    await cleanup(db, b.order.id)
  }
})

test('a document whose independent keys disagree with the order is refused: wrong total, wrong currency, or nothing else agrees', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const downloads = { n: 0 }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['wrong total', { total: 250 }],
      ['no total reported', { total: undefined }],
      ['wrong currency', { currencyCode: 'EUR' }],
      ['right total but the reference names another order', { reference: 'someone-else', dateString: '2020-01-01T00:00:00' }],
      ['no currency reported', { currencyCode: undefined }],
      ['total and currency and date agree, nothing says whose it is', { reference: undefined }],
    ]
    for (const [name, claim] of cases) {
      await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: order.id } })
      const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, depsFor(order, { claim, downloads }))
      assert.equal(outcome.status, 'needs-attention', name)
    }
    assert.equal(downloads.n, 0, 'a mismatching document is never downloaded')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a voided invoice is stored only for a cancelled order; on an active order it is waited for', { skip }, async () => {
  const { db, service } = await setup()
  const active = await seedOrder(db)
  const cancelled = await seedOrder(db, false, { status: 'CANCELLED' })
  try {
    const onActive = await service.ensureInvoiceDocument({ orderId: active.order.id, kind: 'INVOICE' }, depsFor(active.order, { claim: { status: 'VOIDED' } }))
    assert.equal(onActive.status, 'waiting')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: active.order.id } }), 0)
    const onCancelled = await service.ensureInvoiceDocument({ orderId: cancelled.order.id, kind: 'INVOICE' }, depsFor(cancelled.order, { claim: { status: 'VOIDED' } }))
    assert.equal(onCancelled.status, 'stored')
    assert.equal((await db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: cancelled.order.id } })).externalStatus, 'VOIDED')
  } finally {
    await cleanup(db, active.order.id)
    await cleanup(db, cancelled.order.id)
  }
})

test('an amendment after first storage is picked up by the due recheck, and not before it is due', { skip }, async () => {
  const { db, service, sweep } = await setup()
  const { order } = await seedOrder(db)
  try {
    let bytes = pdf('first')
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    const deps: Deps = { ...depsFor(order, { bytes: () => bytes }), now: () => now }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')
    const state0 = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(state0.status, 'DONE')
    assert.equal(state0.nextAttemptAt?.getTime(), t0.getTime() + 24 * 3600_000, 'first recheck is due after a day')

    // The ledger amends the document. Before the recheck is due nobody asks.
    bytes = pdf('amended')
    now = new Date(t0.getTime() + 3600_000)
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'backoff')
    assert.equal((await sweep.selectInvoiceDocumentCandidates(new Date(0), now, 500, false)).filter((c) => c.orderId === order.id).length, 0)

    // Due: the sweep finds it as a recheck, the fetch promotes the new version.
    now = new Date(t0.getTime() + 25 * 3600_000)
    assert.deepEqual((await sweep.selectInvoiceDocumentCandidates(new Date(0), now, 500, false)).filter((c) => c.orderId === order.id), [{ orderId: order.id, kind: 'INVOICE' }])
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(outcome.status === 'stored' && outcome.created, true)
    const rows = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id }, orderBy: { fetchedAt: 'asc' } })
    assert.equal(rows.length, 2)
    assert.equal(rows.filter((r) => r.supersededAt === null).length, 1)
    const { loadCurrentInvoicePdf: loadInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    assert.deepEqual(await loadInvoicePdf(order.id), bytes)
    const state1 = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(state1.rechecks, 1)
    assert.equal(state1.nextAttemptAt?.getTime(), now.getTime() + 7 * 24 * 3600_000, 'then a week')
  } finally {
    await cleanup(db, order.id)
  }
})

test('overlapping fetches: the second does not run while the first holds the document, and the newest ledger version ends up current', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    let bytes = pdf('older')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const downloading = new Promise<void>((resolve) => { started = resolve })
    const slow: Deps = {
      ...depsFor(order),
      downloadPdf: async () => { const read = bytes; started(); await gate; return { ok: true, buffer: read } },
    }
    const first = service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, slow)
    await downloading // the first has read the ledger's OLDER version and is mid-download, holding the document

    bytes = pdf('newer') // the ledger moves on
    const overlapped = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, depsFor(order, { bytes: () => bytes }))
    assert.equal(overlapped.status, 'busy', 'a second fetch cannot run (or promote anything) while the first holds the document')

    release()
    assert.equal((await first).status, 'stored')
    // The next fetch reads the ledger as it now is, and the newer version wins.
    const next = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, depsFor(order, { bytes: () => bytes }))
    assert.equal(next.status === 'stored' && next.created, true)
    const current = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id, supersededAt: null } })
    assert.equal(current.length, 1)
    const { loadCurrentInvoicePdf: loadInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    assert.deepEqual(await loadInvoicePdf(order.id), bytes)
    const lease = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(lease.leaseUntil, null, 'the lease is released')
  } finally {
    await cleanup(db, order.id)
  }
})

test('same number, total, currency and date but an explicitly DIFFERENT customer: needs a person, nothing downloaded or stored', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db, false, { customerName: 'Ada Lovelace' })
  try {
    const downloads = { n: 0 }
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, depsFor(order, { claim: { contactName: 'Bob Builder' }, downloads }))
    assert.equal(outcome.status, 'needs-attention')
    assert.equal(downloads.n, 0)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
    // CONTROL: the same document for the right customer, with no reference at all, is stored (customer alone identifies it).
    await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: order.id } })
    const ok = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, depsFor(order, { claim: { contactName: 'ada lovelace', reference: undefined }, downloads }))
    assert.equal(ok.status, 'stored')
  } finally {
    await cleanup(db, order.id)
  }
})

test('a lease taken over while the first download is still running: the first worker writes nothing and the newer version stays current', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    let bytes = pdf('older')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const downloading = new Promise<void>((resolve) => { started = resolve })
    const slow: Deps = {
      ...depsFor(order),
      now: () => now,
      downloadPdf: async () => { const read = bytes; started(); await gate; return { ok: true, buffer: read } },
    }
    const first = service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, slow)
    await downloading

    // The first has stalled past its lease (the ledger retries outlasted it); the ledger has moved on; a second worker takes over.
    bytes = pdf('newer')
    now = new Date(t0.getTime() + service.INVOICE_DOCUMENT_LEASE_MS + 60_000)
    const second = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, { ...depsFor(order, { bytes: () => bytes }), now: () => now })
    assert.equal(second.status === 'stored' && second.created, true)

    release()
    const late = await first
    assert.equal(late.status, 'busy', 'the first fetch lost its lease and aborts')
    const current = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id, supersededAt: null } })
    assert.equal(current.length, 1)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 1, 'the older PDF was never promoted')
    const { loadCurrentInvoicePdf: loadInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    assert.deepEqual(await loadInvoicePdf(order.id), bytes)
    const state = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(state.status, 'DONE', 'the new holder\'s state was not overwritten')
    assert.equal(state.leaseHolder, null, 'the lease is released, and by its own holder')
  } finally {
    await cleanup(db, order.id)
  }
})

test('a lookup refusal carries the stop signal to the sweep, which stops at once', { skip }, async () => {
  const { db, service, sweep } = await setup()
  const a = await seedOrder(db)
  const b = await seedOrder(db)
  const keys = [sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING]
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  try {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.setting.create({ data: { key: sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING, value: new Date(Date.now() - 86_400_000).toISOString() } })
    let lookups = 0
    const deps: Deps = {
      lookupInvoiceClaims: async () => { lookups++; return { ok: false, error: 'HTTP 429 rate limited', stop: true } },
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => { throw new Error('unused') },
      now: () => new Date(),
    }
    const one = await service.ensureInvoiceDocument({ orderId: a.order.id, kind: 'INVOICE' }, deps)
    assert.equal(one.status === 'failed' && one.stop, true)
    await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: a.order.id } })
    lookups = 0
    const result = await sweep.runInvoiceDocumentSweep(deps)
    assert.equal(lookups, 1, 'the sweep did not move on to the next order')
    assert.match(result.stoppedEarly ?? '', /refused or is rate-limited/)
    assert.equal(b.order.id.length > 0, true)
  } finally {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of saved) await db.setting.create({ data: { key: row.key, value: row.value } })
    await cleanup(db, a.order.id)
    await cleanup(db, b.order.id)
  }
})

test('a crash between the file write and the promotion leaves nothing current; the next sweep recovers it', { skip }, async () => {
  const { db, service, sweep } = await setup()
  const { order } = await seedOrder(db)
  const keys = [sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING]
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  try {
    const { saveInvoiceDocumentFile } = await import('../../lib/invoice-pdf')
    const { loadCurrentInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    const { createHash } = await import('node:crypto')
    // The crash: the immutable file is on disk, the promotion never ran.
    const bytes = pdf('crashed-before-promotion')
    await saveInvoiceDocumentFile(order.id, createHash('sha256').update(bytes).digest('hex'), bytes)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0, 'no row, so nothing current')
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'and the orphan file is never served')
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)

    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.setting.create({ data: { key: sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING, value: new Date(Date.now() - 86_400_000).toISOString() } })
    const deps = depsFor(order, { bytes: () => bytes })
    const result = await sweep.runInvoiceDocumentSweep(deps)
    assert.ok(result.stored >= 1)
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes)
  } finally {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const row of saved) await db.setting.create({ data: { key: row.key, value: row.value } })
    await cleanup(db, order.id)
  }
})

test('an expired holder resuming after a newer promotion never publishes: the newer version is served, the older bytes never are', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const { loadCurrentInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    const older = pdf('older')
    const newer = pdf('newer')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started: () => void = () => {}
    const downloading = new Promise<void>((resolve) => { started = resolve })
    const slow: Deps = { ...depsFor(order), now: () => now, downloadPdf: async () => { started(); await gate; return { ok: true, buffer: older } } }
    const first = service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, slow)
    await downloading
    now = new Date(t0.getTime() + service.INVOICE_DOCUMENT_LEASE_MS + 60_000)
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, { ...depsFor(order, { bytes: () => newer }), now: () => now })).status, 'stored')
    // Mid-way: the newer one is what a reader gets.
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), newer)
    release()
    assert.equal((await first).status, 'busy')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), newer, 'after the late holder gave up, still the newer version')
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })
    const current = await db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id, supersededAt: null } })
    assert.equal(row.invoicePdfPath, current.storedPath, 'the compatibility pointer was written only by the fenced promotion')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 1, 'the older PDF has no row, so it can never be current')
  } finally {
    await cleanup(db, order.id)
  }
})

test('readers resolve the current hash-named file, not the flat file; a missing or altered file is not served and is repaired', { skip }, async () => {
  const { db, service, sweep } = await setup()
  const { order } = await seedOrder(db)
  const keys = [sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING]
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  try {
    const { loadCurrentInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    const { saveInvoicePdfFile, getInvoicePdfStorageDir } = await import('../../lib/invoice-pdf')
    const good = pdf('current')
    const deps = depsFor(order, { bytes: () => good })
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')
    // A stale flat file (the old publication path) must not be read once a document row exists.
    await saveInvoicePdfFile(order.id, pdf('STALE-FLAT-FILE'))
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), good)

    // Tamper with the immutable file: not served, document made due.
    const doc = await db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id, supersededAt: null } })
    const { writeFileSync, rmSync } = await import('node:fs')
    const file = path.join(getInvoicePdfStorageDir(), doc.storedPath.replace(/^invoice-pdfs\//, ''))
    writeFileSync(file, pdf('tampered'))
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'altered bytes are never served')
    const due = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.ok(due.nextAttemptAt && due.nextAttemptAt.getTime() <= Date.now(), 'and the document is due for a re-fetch')

    // The sweep re-fetches and rewrites the file.
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.setting.create({ data: { key: sweep.INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING, value: new Date(Date.now() - 86_400_000).toISOString() } })
    await sweep.runInvoiceDocumentSweep(deps)
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), good, 'repaired')

    // A file lost entirely is found by the integrity scan before anyone asks for it.
    rmSync(file)
    await db.setting.deleteMany({ where: { key: sweep.INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING } })
    assert.ok((await sweep.markDocumentsWithBadFilesDue(new Date(), 5000)) >= 1)
    await sweep.runInvoiceDocumentSweep(deps)
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), good, 'repaired from the scan')
  } finally {
    await db.setting.deleteMany({ where: { key: { in: [...keys, sweep.INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING] } } })
    for (const row of saved) await db.setting.create({ data: { key: row.key, value: row.value } })
    await cleanup(db, order.id)
  }
})

test('a store-credit order whose ledger invoice states the FULL goods value is stored; a mismatch or an unassessed credit is not', { skip }, async () => {
  const { db, service } = await setup()
  const credit = await seedOrder(db, false, { totalForeign: '80', storeCredit: '20', assessment: 'ASSESSED' })
  const unassessed = await seedOrder(db, false, { totalForeign: '80', storeCredit: '20' })
  const review = await seedOrder(db, false, { totalForeign: '80', storeCredit: '20', assessment: 'REVIEW_REQUIRED' })
  try {
    // The importer recorded 80 (paid); the invoice states 100 (goods) with the 20 settled as a payment: stored.
    assert.equal((await service.ensureInvoiceDocument({ orderId: credit.order.id, kind: 'INVOICE' }, depsFor(credit.order, { claim: { total: 100 } }))).status, 'stored')
    // CONTROL: the amount PAID is not the invoice gross for a credit order.
    await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: credit.order.id } })
    await db.salesOrderInvoiceDocument.updateMany({ where: { orderId: credit.order.id }, data: { supersededAt: new Date() } })
    assert.equal((await service.ensureInvoiceDocument({ orderId: credit.order.id, kind: 'INVOICE', ignoreBackoff: true }, depsFor(credit.order, { claim: { total: 80 } }))).status, 'needs-attention')
    // Credit the import never assessed, or an order held for review: no total IMS can vouch for.
    for (const o of [unassessed.order, review.order]) {
      const downloads = { n: 0 }
      const outcome = await service.ensureInvoiceDocument({ orderId: o.id, kind: 'INVOICE' }, depsFor(o, { claim: { total: 100 }, downloads }))
      assert.equal(outcome.status, 'needs-attention')
      assert.equal(downloads.n, 0)
    }
  } finally {
    await cleanup(db, credit.order.id)
    await cleanup(db, unassessed.order.id)
    await cleanup(db, review.order.id)
  }
})

test('the ledger document changes between the lookup and the download: the bytes are discarded and nothing is promoted', { skip }, async () => {
  const { db, service } = await setup()
  for (const [name, change] of [
    ['status', { status: 'VOIDED' }],
    ['total', { total: 120 }],
    ['customer', { contactName: 'Bob Builder' }],
    ['reference', { reference: 'another order' }],
    ['last-modified stamp', { updatedDateUtc: '/Date(2)/' }],
  ] as const) {
    const { order } = await seedOrder(db, false, { customerName: 'Ada Lovelace' })
    try {
      let lookups = 0
      const deps: Deps = {
        ...depsFor(order),
        lookupInvoiceClaims: async (number) => {
          lookups++
          const base = ledgerClaim(order, number, { contactName: 'Ada Lovelace', updatedDateUtc: '/Date(1)/' })
          return { ok: true, claims: [lookups === 1 ? base : { ...base, ...change }] }
        },
      }
      const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
      assert.notEqual(outcome.status, 'stored', name)
      assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0, `${name}: nothing promoted`)
      assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)
      assert.equal(lookups, 2, `${name}: the document was re-read after the download`)
    } finally {
      await cleanup(db, order.id)
    }
  }
})

test('the connection changes between the lookup and the re-read, or the download is refused for it: nothing is promoted', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const conn = (generation: string) => ({ tenantId: 'tenant-A', connectionGeneration: generation })
    let lookups = 0
    const seenByDownload: unknown[] = []
    const moved: Deps = {
      ...depsFor(order),
      lookupInvoiceClaims: async (number) => { lookups++; return { ok: true, claims: [ledgerClaim(order, number)], connection: conn(lookups === 1 ? 'gen-1' : 'gen-2') } },
      downloadPdf: async (_k, _id, connection) => { seenByDownload.push(connection); return { ok: true, buffer: pdf('x') } },
    }
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, moved)
    assert.equal(outcome.status, 'failed')
    assert.deepEqual(seenByDownload, [conn('gen-1')], 'the download was asked to run under the connection that answered the lookup')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)

    // The transport refuses a download whose connection changed (xeroGetRaw returns not-sent): nothing is promoted.
    await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: order.id } })
    const refused: Deps = {
      ...depsFor(order),
      lookupInvoiceClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number)], connection: conn('gen-1') }),
      downloadPdf: async () => ({ ok: false, error: 'The Xero connection changed after the document was looked up', stop: false }),
    }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, refused)).status, 'failed')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
  } finally {
    await cleanup(db, order.id)
  }
})

test('the importer corrects the order\'s invoice number: the old-number PDF is not served, and the one under the new number is fetched', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const { loadCurrentInvoicePdf } = await import('../../lib/domain/invoice-documents/current-document')
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    const bytesFor = (number: string) => pdf(`for-${number}`)
    const deps: Deps = {
      ...depsFor(order),
      now: () => now,
      lookupInvoiceClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number, { documentId: `doc-${number}` })] }),
      downloadPdf: async (_kind, id) => ({ ok: true, buffer: bytesFor(id.replace('doc-', '')) }),
    }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytesFor(order.invoiceNumber!))

    // The correction lands before the recheck is due.
    const corrected = `${order.invoiceNumber}-FIXED`
    await db.salesOrder.update({ where: { id: order.id }, data: { invoiceNumber: corrected } })
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'the old-number PDF is no longer this order\'s invoice')
    const due = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.ok(due.nextAttemptAt && due.nextAttemptAt.getTime() <= now.getTime(), 'and the document is due at once')

    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(outcome.status === 'stored' && outcome.created, true)
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytesFor(corrected))
    const rows = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id }, orderBy: { fetchedAt: 'asc' } })
    assert.equal(rows.length, 2)
    assert.equal(rows.filter((r) => r.supersededAt === null).length, 1)
  } finally {
    await cleanup(db, order.id)
  }
})

test('the invoice number is corrected DURING the three GETs: the old-number PDF is not promoted', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const deps: Deps = {
      ...depsFor(order),
      downloadPdf: async () => {
        // The importer's correction lands while the fetch is in flight.
        await db.salesOrder.update({ where: { id: order.id }, data: { invoiceNumber: `${order.invoiceNumber}-FIXED` } })
        return { ok: true, buffer: pdf('old-number') }
      },
    }
    const outcome = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.status === 'failed' ? outcome.reason : '', /order changed/)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0)
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a stored invoice later VOIDED on an order that is not cancelled is withdrawn from the customer, kept for staff, and a replacement is served', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  try {
    const { loadCurrentInvoicePdf, currentInvoiceIsWithdrawn } = await import('../../lib/domain/invoice-documents/current-document')
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    let claim: Record<string, unknown> = { documentId: 'doc-1' }
    let bytes = pdf('original')
    const deps: Deps = { ...depsFor(order), now: () => now, lookupInvoiceClaims: async (number) => ({ ok: true, claims: [ledgerClaim(order, number, claim)] }), downloadPdf: async () => ({ ok: true, buffer: bytes }) }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')
    const original = bytes

    // The ledger voids it (the replacement has not been issued yet); the recheck falls due.
    claim = { documentId: 'doc-1', status: 'VOIDED' }
    now = new Date(t0.getTime() + 25 * 3600_000)
    const waiting = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(waiting.status, 'waiting')
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'not served to the customer')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id, { includeWithdrawn: true }), original, 'but retained, and staff can still open it')
    assert.equal(await currentInvoiceIsWithdrawn(order.id), true)
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 1, 'bytes and history kept')

    // A valid replacement is issued: it is promoted and served.
    claim = { documentId: 'doc-2' }
    bytes = pdf('replacement')
    now = new Date(t0.getTime() + 60 * 3600_000)
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)).status, 'stored')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes)
    assert.equal(await currentInvoiceIsWithdrawn(order.id), false)
    const rows = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: order.id } })
    assert.equal(rows.length, 2)
    assert.equal(rows.filter((r) => r.supersededAt === null && r.withdrawnAt === null).length, 1)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a recheck that finds a POSITIVE ownership conflict withdraws the stored document; a transient failure does not; a person\'s review plus a valid answer serves it again', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db, false, { customerName: 'Ada Lovelace' })
  try {
    const { loadCurrentInvoicePdf, currentInvoiceIsWithdrawn } = await import('../../lib/domain/invoice-documents/current-document')
    const t0 = new Date('2026-11-09T10:00:00Z')
    let now = t0
    let answer: 'ok' | 'conflict' | 'down' | 'unstated' = 'ok'
    const bytes = pdf('stored')
    const deps: Deps = {
      ...depsFor(order),
      now: () => now,
      lookupInvoiceClaims: async (number) => {
        if (answer === 'down') return { ok: false, error: 'HTTP 503' }
        const claim = ledgerClaim(order, number, { contactName: answer === 'conflict' ? 'Bob Builder' : 'Ada Lovelace' })
        if (answer === 'unstated') return { ok: true, claims: [{ ...claim, currencyCode: undefined }] }
        return { ok: true, claims: [claim] }
      },
      downloadPdf: async () => ({ ok: true, buffer: bytes }),
    }
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'stored')

    // Unanswered, or information MISSING rather than contradicted: the stored PDF stays served.
    now = new Date(t0.getTime() + 25 * 3600_000)
    answer = 'down'
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'failed')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes, 'a transient failure keeps the stored PDF')
    now = new Date(now.getTime() + 8 * 24 * 3600_000)
    answer = 'unstated'
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'needs-attention')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes, 'missing information is not a conflict: still served')
    assert.equal(await currentInvoiceIsWithdrawn(order.id), false)
    assert.equal(await service.releaseInvoiceDocumentForReview({ orderId: order.id, kind: 'INVOICE' }), true)

    // The ledger now states a DIFFERENT customer: positive conflict. Withdrawn from the customer, kept, staff can open it.
    now = new Date(now.getTime() + 31 * 24 * 3600_000)
    answer = 'conflict'
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)).status, 'needs-attention')
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'no longer shown to the customer')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id, { includeWithdrawn: true }), bytes, 'retained, and staff can open it')
    assert.equal(await currentInvoiceIsWithdrawn(order.id), true)
    // Not retried on its own.
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)).status, 'needs-attention')

    // A person has looked; the next answer validates: served again.
    assert.equal(await service.releaseInvoiceDocumentForReview({ orderId: order.id, kind: 'INVOICE' }), true)
    answer = 'ok'
    now = new Date(now.getTime() + 3600_000)
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE', ignoreBackoff: true }, deps)).status, 'stored')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes)
    assert.equal(await currentInvoiceIsWithdrawn(order.id), false)
  } finally {
    await cleanup(db, order.id)
  }
})

test('a full backlog of new orders cannot starve a due recheck', { skip }, async () => {
  const { db, service, sweep } = await setup()
  const fresh: string[] = []
  const stored = await seedOrder(db)
  try {
    for (let i = 0; i < 12; i += 1) fresh.push((await seedOrder(db)).order.id)
    // One order already has a stored document whose recheck has fallen due.
    const t0 = new Date('2026-11-09T10:00:00Z')
    assert.equal((await service.ensureInvoiceDocument({ orderId: stored.order.id, kind: 'INVOICE' }, { ...depsFor(stored.order), now: () => t0 })).status, 'stored')
    const later = new Date(t0.getTime() + 25 * 3600_000)
    const limit = 8
    assert.equal(sweep.reservedRecheckSlots(limit), 2)
    const picked = await sweep.selectInvoiceDocumentCandidates(new Date(0), later, limit, false)
    assert.equal(picked.length, limit)
    assert.ok(picked.some((c) => c.orderId === stored.order.id), 'the due recheck runs although twelve new orders are waiting')
    // And the unused reserved slots roll over to new fetches when there is no recheck due.
    const none = await sweep.selectInvoiceDocumentCandidates(new Date(0), t0, limit, false)
    assert.equal(none.length, limit, 'no recheck due: all slots go to new orders')
    assert.ok(!none.some((c) => c.orderId === stored.order.id))
  } finally {
    await cleanup(db, stored.order.id)
    for (const id of fresh) await cleanup(db, id)
  }
})

test('another order is given the invoice number DURING the fetch: nothing is promoted; AFTER storage: not served to the customer, flagged, staff can still open it', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  let other: { order: { id: string } } | null = null
  try {
    const { loadCurrentInvoicePdf, currentInvoiceUnavailableReason } = await import('../../lib/domain/invoice-documents/current-document')
    const deps: Deps = {
      ...depsFor(order),
      downloadPdf: async () => {
        // Collision arriving mid-fetch: a second order takes the same number (different case, as the ledger would match it).
        other = await seedOrder(db, false, { invoiceNumber: order.invoiceNumber!.toLowerCase() })
        return { ok: true, buffer: pdf('collided') }
      },
    }
    const during = await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(during.status, 'needs-attention')
    assert.equal(await db.salesOrderInvoiceDocument.count({ where: { orderId: order.id } }), 0, 'not promoted')
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { invoicePdfPath: true } })).invoicePdfPath, null)

    // Clear the collision, store the document, then let the collision arrive AFTER storage.
    await cleanup(db, other!.order.id)
    other = null
    await db.invoiceDocumentFetchState.deleteMany({ where: { orderId: order.id } })
    const bytes = pdf('stored-first')
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, depsFor(order, { bytes: () => bytes }))).status, 'stored')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id), bytes)
    other = await seedOrder(db, false, { invoiceNumber: order.invoiceNumber! })
    assert.equal(await loadCurrentInvoicePdf(order.id), null, 'refused to the customer')
    assert.deepEqual(await loadCurrentInvoicePdf(order.id, { includeWithdrawn: true }), bytes, 'staff can still open it')
    assert.equal(await currentInvoiceUnavailableReason(order.id), 'number-shared')
    assert.equal((await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })).status, 'NEEDS_ATTENTION', 'and a person is asked')
  } finally {
    if (other) await cleanup(db, (other as { order: { id: string } }).order.id)
    await cleanup(db, order.id)
  }
})

test('the reset refuses BEFORE deleting anything when invoice documents are stored, unless the database is declared disposable', { skip }, async () => {
  const { db, service } = await setup()
  const { order } = await seedOrder(db)
  const { invoiceDocumentResetVerdict } = await import('../../lib/domain/invoice-documents/reset-guard')
  const { expectedDisposableDatabaseMarker } = await import('../../lib/disposable-database-marker')
  const dbName = (await db.$queryRaw<Array<{ n: string }>>`SELECT current_database()::text AS n`)[0]!.n
  const comment = (await db.$queryRaw<Array<{ c: string | null }>>`SELECT shobj_description(oid, 'pg_database') AS c FROM pg_database WHERE datname = current_database()`)[0]?.c ?? null
  const setComment = async (value: string | null) => { await db.$executeRawUnsafe(`COMMENT ON DATABASE "${dbName}" IS ${value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`}`) }
  try {
    await setComment(null)
    assert.deepEqual(await invoiceDocumentResetVerdict(), { ok: true, mayDeleteDocuments: false }, 'nothing stored: nothing in the way')
    assert.equal((await service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, depsFor(order))).status, 'stored')
    const refused = await invoiceDocumentResetVerdict()
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.reason, /Nothing was deleted/)
    assert.match(refused.ok ? '' : refused.reason, /db:stamp-scratch/)
    await setComment(expectedDisposableDatabaseMarker(dbName))
    assert.deepEqual(await invoiceDocumentResetVerdict(), { ok: true, mayDeleteDocuments: true })
  } finally {
    await setComment(comment)
    await cleanup(db, order.id)
  }
})
