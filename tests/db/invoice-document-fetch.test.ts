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

async function seedOrder(db: Awaited<ReturnType<typeof setup>>['db'], withCreditNote = false, options: { invoiceNumber?: string; status?: string } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `IDOC-${suffix}`,
      invoiceNumber: options.invoiceNumber ?? `INV-${suffix}`,
      status: (options.status ?? 'SHIPPED') as never,
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
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

/** What the ledger says about a document that really is this order's. */
function ledgerClaim(order: { orderNumber: string }, number: string, over: Record<string, unknown> = {}) {
  return { documentId: 'xero-1', documentNumber: number, status: 'AUTHORISED', total: 100, currencyCode: 'GBP', dateString: new Date().toISOString(), reference: order.orderNumber, ...over }
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
    assert.equal(row.invoicePdfPath, `invoice-pdfs/${order.id}.pdf`)
    const { loadInvoicePdf } = await import('../../lib/invoice-pdf')
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
    assert.deepEqual(await loadInvoicePdf(order.id), bytes, 'the flat pointer follows the current version')
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

function depsFor(order: { orderNumber: string }, over: Partial<Deps> & { claim?: Record<string, unknown>; bytes?: () => Buffer; downloads?: { n: number } } = {}): Deps {
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
      ['right total but reference, customer and date all disagree', { reference: 'someone-else', dateString: '2020-01-01T00:00:00' }],
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
    const { loadInvoicePdf } = await import('../../lib/invoice-pdf')
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
    const { loadInvoicePdf } = await import('../../lib/invoice-pdf')
    assert.deepEqual(await loadInvoicePdf(order.id), bytes)
    const lease = await db.invoiceDocumentFetchState.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(lease.leaseUntil, null, 'the lease is released')
  } finally {
    await cleanup(db, order.id)
  }
})
