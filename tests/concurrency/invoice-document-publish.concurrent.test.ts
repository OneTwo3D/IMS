import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'

/**
 * THE PUBLISH SIDE OF THE CUSTOMER INVOICE AGAINST A REAL DATABASE: the outbox operation woocommerce/order.invoice-document, its
 * persisted markers and the split note / flag writers. The database, the outbox, the producer seam, the attempt fence and the
 * invoice-document reader are real; ONLY the two WooCommerce transport functions (wcPost, wcPut) are doubled, and they record every call.
 * Nothing contacts any vendor (tests/no-outbound-network.cjs fails a test that tried).
 *
 * Committing, with its own cleanup, so it lives in the SERIAL concurrency tier: it stores documents and the database-reset test in tests/db expects none to exist while it runs. GATED on RUN_DB_CONCURRENCY_TESTS (npm run test:concurrency).
 *
 * Arms: OFF by default (no scan, no row, no write, with or without the hold); the producer hold shadows (no row, a record, no write);
 * live: one write, marker saved, no repeat on a rescan or a replay; a held / rejected write is a retry and saves no marker; an order
 * older than the live-from instant is never queued; an unservable document is not published; the note is posted once per ledger invoice
 * id however often the meta fails; two concurrent drains write once (repeated, because one pass proves nothing about a race).
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

type WcResult = { data: unknown; error?: string; held?: true }
const transport = {
  puts: [] as Array<{ path: string; body: unknown }>,
  posts: [] as Array<{ path: string; body: unknown }>,
  putResult: (): WcResult => ({ data: {} }),
  postResult: (): WcResult => ({ data: { id: 9001 } }),
  /** The notes the (fake) storefront order holds; a successful or lost-response POST adds to it. */
  notes: [] as Array<{ id: number; note: string; customer_note: boolean }>,
  notesRead: (): { data: unknown; error?: string } => ({ data: transport.notes }),
}
function resetTransport() {
  transport.puts.length = 0
  transport.posts.length = 0
  transport.putResult = () => ({ data: {} })
  transport.postResult = () => ({ data: { id: 9001 } })
  transport.notes = []
  transport.notesRead = () => ({ data: transport.notes })
}
if (!skip) {
  mock.module('@/lib/connectors/woocommerce/api', {
    namedExports: {
      wcPut: async (p: string, body: unknown) => { transport.puts.push({ path: p, body }); return transport.putResult() },
      wcPost: async (p: string, body: unknown) => {
        transport.posts.push({ path: p, body })
        // The storefront keeps the note first; the answer (which a test may make throw) comes after.
        const note = (body as { note?: string }).note
        if (typeof note === 'string') transport.notes.push({ id: 9000 + transport.notes.length + 1, note, customer_note: false })
        return transport.postResult()
      },
      wcFetch: async () => ({ ...transport.notesRead(), totalPages: 1, totalItems: 0 }),
    },
  })
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM']
const DAY = 86_400_000
const iso = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z')
// Fixture orders are 30 days old and the storefront went live 60 days ago: another test file in the same database runs the invoice-document
// sweep with a floor of yesterday, and an order older than that floor is none of its business.
const FIXTURE_AGE_DAYS = 30
const LIVE = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: iso(new Date(Date.now() - 60 * DAY)) }
const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}

const LEDGER_DATE = new Date().toISOString()

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n${tag}${'x'.repeat(400)}\n%%EOF\n`, 'latin1')
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  process.env.INVOICE_PDF_STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'invpub-'))
  const [{ db }, service, jobs, writer, note] = await Promise.all([
    import('../../lib/db'),
    import('../../lib/domain/invoice-documents/fetch-service'),
    import('../../lib/connectors/woocommerce/sync/invoice-document-jobs'),
    import('../../lib/connectors/woocommerce/sync/invoice-document'),
    import('../../lib/connectors/woocommerce/sync/invoice-note'),
  ])
  return { db, service, jobs, writer, note }
}
type Deps = Awaited<ReturnType<typeof setup>>

async function setFlag(d: Deps, value: string | null) {
  if (value === null) await d.db.setting.deleteMany({ where: { key: 'wc_invoice_document_enabled' } })
  else await d.db.setting.upsert({ where: { key: 'wc_invoice_document_enabled' }, create: { key: 'wc_invoice_document_enabled', value }, update: { value } })
}

/** An order with a storefront link and (unless asked not to) a stored, servable invoice document. */
async function seedOrder(d: Deps, options: { stored?: boolean; ageDays?: number; accountingInvoiceId?: string } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const createdAt = new Date(Date.now() - (options.ageDays ?? FIXTURE_AGE_DAYS) * DAY)
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `IPUB-${suffix}`,
      invoiceNumber: `INV-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      createdAt,
      ...(options.accountingInvoiceId ? { accountingInvoiceId: options.accountingInvoiceId } : {}),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${suffix}`, externalOrderNumber: `${suffix}` } },
    },
    select: { id: true, orderNumber: true, invoiceNumber: true },
  })
  if (options.stored !== false) {
    const deps: import('../../lib/domain/invoice-documents/fetch-service').InvoiceDocumentDeps = {
      lookupInvoiceClaims: async (number) => ({ ok: true, claims: [{ documentId: `xero-${suffix}`, documentNumber: number, status: 'AUTHORISED', total: 100, currencyCode: 'GBP', dateString: LEDGER_DATE, reference: order.orderNumber ?? undefined }] }),
      lookupCreditNoteClaims: async () => ({ ok: true, claims: [] }),
      downloadPdf: async () => ({ ok: true, buffer: pdf(suffix) }),
      now: () => new Date(),
    }
    const stored = await d.service.ensureInvoiceDocument({ orderId: order.id, kind: 'INVOICE' }, deps)
    assert.equal(stored.status, 'stored', `the fixture document is stored through the real fetch service: ${JSON.stringify(stored)}`)
  }
  return order
}

async function cleanup(d: Deps, orderIds: string[]) {
  const keys = { OR: orderIds.map((id) => ({ idempotencyKey: { contains: id } })) }
  await d.db.integrationOutbox.deleteMany({ where: keys })
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { in: orderIds } } })
  // Retried: a test file running in parallel on the same database can create a fetch state for an order between these two deletes.
  for (let attempt = 0; ; attempt++) {
    try {
      await d.db.invoiceStorePublication.deleteMany({ where: { orderId: { in: orderIds } } })
      await d.db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: { in: orderIds } } })
      await d.db.invoiceDocumentFetchState.deleteMany({ where: { orderId: { in: orderIds } } })
      await d.db.shoppingOrderLink.deleteMany({ where: { orderId: { in: orderIds } } })
      await d.db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
      break
    } catch (error) {
      if (attempt >= 4) throw error
    }
  }
  await setFlag(d, null)
}

/** Scan and drain ONLY these orders: other test files share the database and run in parallel, so an unscoped pass would publish their orders too. */
async function tickFor(d: Deps, orderIds: string[]) {
  const scan = await d.jobs.enqueueInvoiceDocumentPublications({ orderIds })
  const docs = await d.db.salesOrderInvoiceDocument.findMany({ where: { orderId: { in: orderIds }, kind: 'INVOICE' }, select: { id: true, orderId: true } })
  const run = await d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: docs.map((doc) => d.jobs.wcInvoiceDocumentIdempotencyKey(doc.orderId, doc.id)) })
  return { scan, ...run }
}

const jobsFor = (d: Deps, orderId: string) => d.db.integrationOutbox.findMany({
  where: { connector: 'woocommerce', operation: 'order.invoice-document', payloadJson: { path: ['orderId'], equals: orderId } },
})

test('OFF BY DEFAULT: with the setting unset nothing is scanned, queued, claimed or written, hold or no hold', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, null)
  for (const env of [{}, HELD, LIVE]) {
    await withEnv(env, async () => {
      const tick = await d.jobs.processWcInvoiceDocumentPublications()
      assert.equal(tick.reason, 'wc_invoice_document_disabled')
      assert.deepEqual([tick.claimed, tick.succeeded, tick.retried], [0, 0, 0])
      assert.deepEqual(await d.jobs.enqueueInvoiceDocumentPublications(), { scanned: 0, queued: 0, shadowed: 0 })
      assert.deepEqual(await d.writer.publishInvoiceDocumentFlagToWc(order.id), { kind: 'disabled' })
    })
  }
  // Anything but an explicit true is off.
  await setFlag(d, 'yes')
  await withEnv(LIVE, async () => assert.deepEqual(await d.writer.publishInvoiceDocumentFlagToWc(order.id), { kind: 'disabled' }))
  assert.equal((await jobsFor(d, order.id)).length, 0)
  assert.equal(await d.db.outboundShadowWrite.count({ where: { subjectId: order.id } }), 0, 'off means no shadow record either')
  assert.equal(transport.puts.length + transport.posts.length, 0)
})

test('THE PRODUCER HOLD: switched on but held, the scan leaves a shadow and no row, the drain claims nothing, nothing is written', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  await withEnv(HELD, async () => {
    const scan = await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [order.id] })
    assert.ok(scan.shadowed === 1 && scan.queued === 0, JSON.stringify(scan))
    assert.equal((await jobsFor(d, order.id)).length, 0, 'a shadow writes no outbox row')
    assert.ok(await d.db.outboundShadowWrite.count({ where: { subjectId: order.id } }) >= 1, 'a shadow record is kept')
    const tick = await tickFor(d, [order.id])
    assert.equal(tick.claimed, 0)
  })
  assert.equal(transport.puts.length, 0)
})

test('LIVE: one write, the marker is saved, a rescan and a replay send nothing more', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  await withEnv(LIVE, async () => {
    const tick = await tickFor(d, [order.id])
    assert.equal(tick.scan.queued, 1, JSON.stringify(tick))
    assert.equal(tick.succeeded, 1, JSON.stringify(tick))
    assert.equal(transport.puts.length, 1)
    assert.deepEqual(transport.puts[0]!.body, { meta_data: [{ key: '_ims_invoice_pdf_available', value: 'yes' }] })
    assert.equal(transport.puts[0]!.path, `orders/wc-${order.orderNumber!.slice(5)}`)
    const marker = await d.db.invoiceStorePublication.findUniqueOrThrow({ where: { orderId: order.id } })
    const doc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
    assert.equal(marker.flagDocumentId, doc.id)
    assert.ok(marker.flagWrittenAt)
    assert.equal(marker.noteWrittenAt, null, 'the flag writer never touches the note marker')
    const [row] = await jobsFor(d, order.id)
    assert.equal(row!.status, 'SUCCEEDED')

    const again = await tickFor(d, [order.id])
    assert.equal(again.scan.queued, 0)
    assert.equal(again.claimed, 0)
    assert.deepEqual(await d.writer.publishInvoiceDocumentFlagToWc(order.id), { kind: 'already-published', documentId: doc.id })
    assert.equal(transport.puts.length, 1, 'nothing more was sent')
  })
})

test('A HELD OR REJECTED WRITE IS A RETRY: no marker is saved, the row stays retryable, and the next attempt writes once', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  await withEnv(LIVE, async () => {
    for (const failing of [{ data: null, error: 'Not sent by IMS: writes to WooCommerce are held', held: true as const }, { data: null, error: 'WC API PUT error: 400 nope' }]) {
      transport.putResult = () => failing
      const tick = await tickFor(d, [order.id])
      assert.equal(tick.succeeded, 0, JSON.stringify(tick))
      assert.equal(await d.db.invoiceStorePublication.count({ where: { orderId: order.id } }), 0, 'no marker for a write that did not land')
      const [row] = await jobsFor(d, order.id)
      assert.equal(row!.status, 'RETRYABLE_FAILED')
      await d.db.integrationOutbox.update({ where: { id: row!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    }
    transport.putResult = () => ({ data: {} })
    const tick = await tickFor(d, [order.id])
    assert.equal(tick.succeeded, 1, JSON.stringify(tick))
    assert.ok((await d.db.invoiceStorePublication.findUniqueOrThrow({ where: { orderId: order.id } })).flagWrittenAt)
  })
})

test('NOT IMS\'S TO PUBLISH: an order older than the live-from instant is never queued; a withdrawn document is not scanned and not published', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const old = await seedOrder(d, { ageDays: 90 })
  const withdrawn = await seedOrder(d)
  t.after(() => cleanup(d, [old.id, withdrawn.id]))
  await setFlag(d, 'true')
  await d.db.salesOrderInvoiceDocument.updateMany({ where: { orderId: withdrawn.id }, data: { withdrawnAt: new Date() } })
  await withEnv(LIVE, async () => {
    await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [old.id, withdrawn.id] })
    assert.equal((await jobsFor(d, old.id)).length, 0, 'created before the live-from instant (90 days old, live from 60): left out')
    assert.equal((await jobsFor(d, withdrawn.id)).length, 0, 'withdrawn: left out')
    // A document withdrawn AFTER it was queued: the attempt re-reads IMS and writes nothing.
    const later = await seedOrder(d)
    t.after(() => cleanup(d, [later.id]))
    await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [later.id] })
    assert.equal((await jobsFor(d, later.id)).length, 1)
    await d.db.salesOrderInvoiceDocument.updateMany({ where: { orderId: later.id }, data: { withdrawnAt: new Date() } })
    const laterDoc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: later.id } })
    const tick = await d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [d.jobs.wcInvoiceDocumentIdempotencyKey(later.id, laterDoc.id)] })
    assert.equal(tick.succeeded, 0, JSON.stringify(tick))
    assert.equal(transport.puts.filter((p) => p.path.includes(later.orderNumber!.slice(5))).length, 0)
    const [row] = await jobsFor(d, later.id)
    assert.equal(row!.status, 'RETRYABLE_FAILED')
    assert.equal(await d.db.invoiceStorePublication.count({ where: { orderId: later.id } }), 0)
  })
})

test('THE NOTE IS POSTED ONCE PER LEDGER INVOICE: a failing meta write retried any number of times adds no second note', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d, { stored: false, accountingInvoiceId: `acct-${randomUUID().slice(0, 8)}` })
  t.after(async () => { await d.db.setting.deleteMany({ where: { key: 'accounting_invoice_url_template' } }); await cleanup(d, [order.id]) })
  await d.db.setting.upsert({ where: { key: 'accounting_invoice_url_template' }, create: { key: 'accounting_invoice_url_template', value: 'https://acct.example.test/{id}' }, update: { value: 'https://acct.example.test/{id}' } })
  transport.putResult = () => ({ data: null, error: 'Not sent by IMS: writes to WooCommerce are held', held: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await d.note.pushInvoiceNoteToWc(order.id)
    assert.equal(result.success, false, 'the held meta write fails the call, as before')
  }
  assert.equal(transport.posts.length, 1, 'ONE note, not one per retry')
  const marker = await d.db.invoiceStorePublication.findUniqueOrThrow({ where: { orderId: order.id } })
  assert.ok(marker.noteWrittenAt)
  assert.equal(marker.noteStoreId, '9001')
  assert.equal(marker.flagWrittenAt, null)
  transport.putResult = () => ({ data: {} })
  assert.deepEqual(await d.note.pushInvoiceNoteToWc(order.id), { success: true })
  assert.equal(transport.posts.length, 1)
  assert.equal(transport.puts.at(-1)!.body && JSON.stringify(transport.puts.at(-1)!.body).includes('_accounting_invoice_url'), true)
  assert.equal(JSON.stringify(transport.puts).includes('_ims_invoice_pdf_available'), false, 'the note writer never writes the download flag')
})

test('A LOST RESPONSE DOES NOT DUPLICATE THE NOTE: the retry finds the note already on the order by its invoice link and adopts it; an unreadable notes list posts nothing', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d, { stored: false, accountingInvoiceId: `acct-${randomUUID().slice(0, 8)}` })
  t.after(async () => { await d.db.setting.deleteMany({ where: { key: 'accounting_invoice_url_template' } }); await cleanup(d, [order.id]) })
  await d.db.setting.upsert({ where: { key: 'accounting_invoice_url_template' }, create: { key: 'accounting_invoice_url_template', value: 'https://acct.example.test/{id}' }, update: { value: 'https://acct.example.test/{id}' } })
  // The storefront keeps the note but the response is lost: the writer sees a thrown error and saves no marker.
  transport.postResult = () => { throw new Error('socket hang up') }
  await d.note.pushInvoiceNoteToWc(order.id)
  assert.equal(transport.posts.length, 1)
  assert.equal(transport.notes.length, 1, 'the note landed')
  assert.equal(await d.db.invoiceStorePublication.count({ where: { orderId: order.id, noteWrittenAt: { not: null } } }), 0, 'no marker: the response was lost')
  // The retry reconciles first.
  transport.postResult = () => ({ data: { id: 9999 } })
  assert.deepEqual(await d.note.pushInvoiceNoteToWc(order.id), { success: true })
  assert.equal(transport.posts.length, 1, 'no second note was posted')
  const marker = await d.db.invoiceStorePublication.findUniqueOrThrow({ where: { orderId: order.id } })
  assert.equal(marker.noteStoreId, String(transport.notes[0]!.id), 'the existing note was adopted as the marker')
  // A fresh order whose notes cannot be read: nothing is posted at all.
  const other = await seedOrder(d, { stored: false, accountingInvoiceId: `acct-${randomUUID().slice(0, 8)}` })
  t.after(() => cleanup(d, [other.id]))
  transport.notesRead = () => ({ data: null, error: 'WC API error: 500' })
  const result = await d.note.pushInvoiceNoteToWc(other.id)
  assert.equal(result.success, false)
  assert.equal(transport.posts.length, 1, 'a blind post is how a duplicate is made')
})

test('NO STARVATION: 200+ documents whose jobs are parked or retrying do not keep a newer document from being queued', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const stuck: string[] = []
  const created: string[] = []
  t.after(() => cleanup(d, created))
  await setFlag(d, 'true')
  for (let i = 0; i < 205; i++) {
    const suffix = randomUUID().slice(0, 8)
    const order = await d.db.salesOrder.create({
      data: {
        orderNumber: `ISTK-${suffix}`, invoiceNumber: `INV-${suffix}`, status: 'SHIPPED', currency: 'GBP', fxRateToBase: new Prisma.Decimal('1'),
        subtotalForeign: new Prisma.Decimal('1'), totalForeign: new Prisma.Decimal('1'), subtotalBase: new Prisma.Decimal('1'), taxBase: new Prisma.Decimal('0'), totalBase: new Prisma.Decimal('1'),
        createdAt: new Date(Date.now() - 30 * DAY),
        shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `wc-${suffix}` } },
        invoiceDocuments: { create: { kind: 'INVOICE', connector: 'xero', externalDocumentId: `x-${suffix}`, documentNumber: `INV-${suffix}`, externalStatus: 'AUTHORISED', sha256: suffix.padEnd(64, '0'), byteSize: 500, storedPath: `invoice-pdfs/documents/x/${suffix}.pdf`, fetchedAt: new Date(Date.now() - 40 * DAY + i) } },
      },
      select: { id: true, invoiceDocuments: { select: { id: true } } },
    })
    created.push(order.id)
    stuck.push(order.id)
    await d.db.integrationOutbox.create({ data: {
      connector: 'woocommerce', operation: 'order.invoice-document', idempotencyKey: d.jobs.wcInvoiceDocumentIdempotencyKey(order.id, order.invoiceDocuments[0]!.id),
      payloadJson: { orderId: order.id, documentId: order.invoiceDocuments[0]!.id }, status: i % 2 ? 'PERMANENT_FAILED' : 'RETRYABLE_FAILED', attempts: 8,
    } })
  }
  const newer = await seedOrder(d)
  created.push(newer.id)
  await withEnv(LIVE, async () => {
    const scan = await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [...stuck, newer.id] })
    assert.equal(scan.queued, 1, JSON.stringify(scan))
    assert.equal((await jobsFor(d, newer.id)).length, 1, 'the newer document is queued although 205 older ones are unresolved')
  })
})

test('THE FLAG IS WRITTEN ONLY INSIDE A GUARDED ATTEMPT: a direct call refuses and sends nothing', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  const out = await withEnv(LIVE, () => d.writer.publishInvoiceDocumentFlagToWc(order.id))
  assert.equal(out.kind, 'failed')
  assert.equal(transport.puts.length, 0)
})

test('THE CUT-OFF: a job queued before the live-from instant is never sent, even though it is claimable by status', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  const doc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
  const key = d.jobs.wcInvoiceDocumentIdempotencyKey(order.id, doc.id)
  await d.db.integrationOutbox.create({ data: {
    connector: 'woocommerce', operation: 'order.invoice-document', idempotencyKey: key, payloadJson: { orderId: order.id, documentId: doc.id },
    status: 'PENDING', createdAt: new Date(Date.now() - 100 * DAY),
  } })
  await withEnv(LIVE, async () => {
    const run = await d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [key] })
    assert.equal(run.succeeded, 0, JSON.stringify(run))
  })
  assert.equal(transport.puts.length, 0, 'a job from before the storefront went live is its former writer\'s')
  assert.equal(await d.db.invoiceStorePublication.count({ where: { orderId: order.id } }), 0)
})

test('THE NOTE MARKER IS SAVED AT ONCE, and a held note write fails the call and saves nothing', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d, { stored: false, accountingInvoiceId: `acct-${randomUUID().slice(0, 8)}` })
  t.after(async () => { await d.db.setting.deleteMany({ where: { key: 'accounting_invoice_url_template' } }); await cleanup(d, [order.id]) })
  await d.db.setting.upsert({ where: { key: 'accounting_invoice_url_template' }, create: { key: 'accounting_invoice_url_template', value: 'https://acct.example.test/{id}' }, update: { value: 'https://acct.example.test/{id}' } })
  transport.postResult = () => ({ data: null, error: 'Not sent by IMS: writes to WooCommerce are held', held: true })
  const held = await d.note.pushInvoiceNoteToWc(order.id)
  assert.equal(held.success, false, 'a held note write is a failure the queue retries')
  assert.equal(await d.db.invoiceStorePublication.count({ where: { orderId: order.id } }), 0, 'nothing landed, so no marker')
  transport.postResult = () => ({ data: { id: 777 } })
  transport.notes = []
  assert.deepEqual(await d.note.pushInvoiceNoteToWc(order.id), { success: true })
  const marker = await d.db.invoiceStorePublication.findUniqueOrThrow({ where: { orderId: order.id } })
  assert.equal(marker.noteStoreId, '777', 'the marker comes from the POST answer itself, not from a later reconcile')
})

test('THE DRAIN STANDS DOWN UNDER THE HOLD: a queued job is neither claimed nor sent while the hold stands, and is sent once it is lifted', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setFlag(d, 'true')
  const doc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
  const key = d.jobs.wcInvoiceDocumentIdempotencyKey(order.id, doc.id)
  await withEnv(LIVE, () => d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [order.id] }))
  await withEnv(HELD, async () => {
    const run = await d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [key] })
    assert.equal(run.claimed, 0)
  })
  assert.equal(transport.puts.length, 0)
  assert.equal((await jobsFor(d, order.id))[0]!.status, 'PENDING', 'untouched, no attempt spent')
  await withEnv(LIVE, async () => assert.equal((await d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [key] })).succeeded, 1))
})

test('THE SCAN\'S FILTERS, one by one: superseded, already marked, before live-from and out-of-scope documents are not queued; the obligation time is the order\'s', { skip }, async (t) => {
  const d = await setup()
  resetTransport()
  const superseded = await seedOrder(d)
  const marked = await seedOrder(d)
  const old = await seedOrder(d, { ageDays: 90 })
  const inScope = await seedOrder(d)
  const outOfScope = await seedOrder(d)
  t.after(() => cleanup(d, [superseded.id, marked.id, old.id, inScope.id, outOfScope.id]))
  await setFlag(d, 'true')
  await d.db.salesOrderInvoiceDocument.updateMany({ where: { orderId: superseded.id }, data: { supersededAt: new Date() } })
  const markedDoc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: marked.id } })
  await d.db.invoiceStorePublication.create({ data: { orderId: marked.id, flagDocumentId: markedDoc.id, flagWrittenAt: new Date() } })
  await withEnv(LIVE, async () => {
    const none = await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [superseded.id, marked.id, old.id] })
    assert.deepEqual(none, { scanned: 0, queued: 0, shadowed: 0 }, 'not even looked at')
    const scoped = await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [inScope.id] })
    assert.equal(scoped.queued, 1)
    assert.equal((await jobsFor(d, outOfScope.id)).length, 0, 'an order outside the scope is left alone')
    // The obligation time decides whether a job is IMS's: an order from before the live-from instant is a shadow, a recent one a job.
    const oldDoc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: old.id } })
    assert.equal(await d.jobs.scheduleWcInvoiceDocument(d.db, { orderId: old.id, documentId: oldDoc.id, obligationAt: new Date(Date.now() - 90 * DAY) }), null)
    const recentDoc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: outOfScope.id } })
    assert.ok(await d.jobs.scheduleWcInvoiceDocument(d.db, { orderId: outOfScope.id, documentId: recentDoc.id, obligationAt: new Date() }))
  })
})

test('TWO CONCURRENT DRAINS WRITE ONCE (repeated: one pass proves nothing about a race)', { skip }, async (t) => {
  const d = await setup()
  await setFlag(d, 'true')
  const ids: string[] = []
  t.after(() => cleanup(d, ids))
  for (let round = 0; round < 5; round++) {
    resetTransport()
    const order = await seedOrder(d)
    ids.push(order.id)
    await withEnv(LIVE, async () => {
      await d.jobs.enqueueInvoiceDocumentPublications({ orderIds: [order.id] })
      transport.putResult = () => ({ data: {} })
      const doc = await d.db.salesOrderInvoiceDocument.findFirstOrThrow({ where: { orderId: order.id } })
      const keys = [d.jobs.wcInvoiceDocumentIdempotencyKey(order.id, doc.id)]
      const [a, b] = await Promise.all([d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: keys }), d.jobs.runWcInvoiceDocumentJobs({ idempotencyKeys: keys })])
      const mine = transport.puts.filter((p) => p.path.endsWith(order.orderNumber!.slice(5)))
      assert.equal(mine.length, 1, `round ${round}: exactly one write (${JSON.stringify([a.succeeded, b.succeeded])})`)
    })
  }
})
