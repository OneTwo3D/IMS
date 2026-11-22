import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, mock } from 'node:test'

import { loadEnv, uid } from './po-landed-fixtures'

/**
 * o3d-ngmt.21 — DELETE A SYNCED INVOICE OR BILL IN IMS AND XERO TOGETHER, against a real PostgreSQL.
 *
 * The request writes ONE deletion record and queues ONE accounting sync row, and changes nothing else; the ledger's confirmation unwinds
 * IMS in one transaction. These tests drive the real service, the real enqueue (so the producer hold, the document-provenance guards and the
 * sync-row primitive are the production ones) and the real unwind, with only the Xero reads doubled. The Xero side (suffix, then DELETED or
 * VOIDED, resumable) is in tests/accounting/xero-document-delete.test.ts.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

if (RUN) loadEnv()

const SETTINGS: Array<[string, string]> = [
  ['plugin_xero_enabled', 'true'],
  ['xero_sync_enabled', 'true'],
  ['xero_transit_account', '631'],
  ['xero_document_delete_enabled', 'true'],
  ['xero_books_lock_date', ''],
]
const fixtureRateIds: string[] = []
let priorSettings: Array<{ key: string; value: string }> | null = null

async function applySettings(overrides: Record<string, string> = {}) {
  const { db } = await import('@/lib/db')
  if (priorSettings === null) priorSettings = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } }, select: { key: true, value: true } })
  for (const [key, value] of SETTINGS) {
    const v = overrides[key] ?? value
    await db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } })
  }
}

after(async () => {
  if (!RUN) return
  const { db } = await import('@/lib/db')
  for (const [key] of SETTINGS) {
    const was = priorSettings?.find((row) => row.key === key)
    if (was) await db.setting.update({ where: { key }, data: { value: was.value } })
    else await db.setting.deleteMany({ where: { key } })
  }
  if (fixtureRateIds.length > 0) {
    await db.supplier.updateMany({ where: { taxRateId: { in: fixtureRateIds } }, data: { taxRateId: null } })
    await db.taxRate.deleteMany({ where: { id: { in: fixtureRateIds } } })
  }
})

type Db = typeof import('@/lib/db').db

const claimFor = (invoiceId: string, invoiceNumber: string) => ({ ok: true as const, tenantId: 'tenant-1', claims: [{ invoiceId, invoiceNumber, status: 'AUTHORISED', type: 'ACCREC' }] })

async function service() {
  return import('@/lib/domain/accounting/document-delete-service')
}

type SalesFixture = { orderId: string; xeroId: string; number: string; tag: string }

/** An order whose invoice IMS pushed to Xero: the link, the SYNCED create row that proves IMS made it, a POSTED mirror event and a stored invoice PDF record. */
async function seedSalesInvoice(db: Db, label: string, over: { createdByIms?: boolean; invoicedAt?: Date } = {}): Promise<SalesFixture> {
  const tag = `${label}-${uid()}`
  const orderId = `DEL-${tag}`
  const xeroId = `xero-inv-${tag}`
  const number = `INV-${tag}`
  await db.salesOrder.create({
    data: {
      id: orderId, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, totalBase: 100,
      invoiceNumber: number, invoicedAt: over.invoicedAt ?? new Date('2026-11-10T00:00:00Z'), accountingInvoiceId: xeroId, accountingInvoiceConnector: 'xero',
    },
  })
  await db.accountingSyncLog.create({
    data: {
      type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: orderId, externalTransactionId: xeroId, syncedAt: new Date(),
      payload: { date: '2026-11-10', invoiceNumber: number, reference: `SO-${tag}`, _idempotencyKey: `seed-${tag}` },
      ...(over.createdByIms === false ? { settlementBasis: 'OPERATOR_ASSERTION' } : {}),
    },
  })
  await db.accountingEvent.create({
    data: { type: 'SALES_INVOICE', sourceEntityType: 'SalesOrder', sourceEntityId: orderId, businessDate: new Date('2026-11-10'), status: 'POSTED', idempotencyKey: `evt-${tag}`, linesJson: [], currency: 'GBP', externalSystem: 'xero', externalId: xeroId },
  })
  await db.salesOrderInvoiceDocument.create({
    data: { orderId, kind: 'INVOICE', connector: 'xero', externalDocumentId: xeroId, documentNumber: number, externalStatus: 'AUTHORISED', sha256: `sha-${tag}`, byteSize: 10, storedPath: `${tag}.pdf` },
  })
  return { orderId, xeroId, number, tag }
}

async function cleanSales(db: Db, f: SalesFixture) {
  await db.accountingEventLog.deleteMany({ where: { accountingEvent: { idempotencyKey: `evt-${f.tag}` } } })
  await db.accountingEvent.deleteMany({ where: { idempotencyKey: `evt-${f.tag}` } })
  await db.accountingDocumentDeletion.deleteMany({ where: { externalDocumentId: f.xeroId } })
  await db.accountingSyncLog.deleteMany({ where: { referenceId: f.orderId } })
  await db.activityLog.deleteMany({ where: { entityId: f.orderId } })
  await db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: f.orderId } })
  await db.payment.deleteMany({ where: { orderId: f.orderId } })
  await db.salesOrderRefund.deleteMany({ where: { orderId: f.orderId } })
  await db.salesOrder.deleteMany({ where: { id: f.orderId } })
}

const deps = (f: { xeroId: string; number: string }, over: Partial<import('@/lib/domain/accounting/document-delete-service').DocumentDeleteRequestDeps> = {}) => ({
  lookupInvoiceNumber: async () => claimFor(f.xeroId, f.number),
  activeConnector: async () => 'xero',
  newToken: () => 'K7M2QX',
  ...over,
})

// ---------------------------------------------------------------------------------------------------------------------------
// SALES INVOICE
// ---------------------------------------------------------------------------------------------------------------------------

test('eligible sales invoice: the request changes nothing in IMS, the confirmation unwinds exactly what the push recorded, and the number is released', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedSalesInvoice(db, 'ok')
  try {
    const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion } = await service()
    const requested = await requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f))
    assert.ok(requested.ok, JSON.stringify(requested))
    assert.equal(requested.releasedNumber, `${f.number}-DEL-K7M2QX`)

    // ONE deletion record and ONE queued sync row; IMS itself is untouched until the ledger confirms.
    const deletion = await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })
    assert.equal(deletion.state, 'PENDING')
    assert.equal(deletion.originalNumber, f.number)
    assert.equal(deletion.releasedNumber, `${f.number}-DEL-K7M2QX`)
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId: f.orderId, type: 'SALES_INVOICE_DELETE' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, 'PENDING')
    const payload = rows[0]!.payload as Record<string, unknown>
    assert.equal(payload.accountingInvoiceId, f.xeroId)
    assert.equal(payload.releasedNumber, `${f.number}-DEL-K7M2QX`)
    assert.equal(payload.date, '2026-11-10')
    const before = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })
    assert.equal(before.invoiceNumber, f.number, 'IMS still holds the invoice until Xero confirms')
    assert.equal(before.accountingInvoiceId, f.xeroId)

    // A second request while the first is queued is refused, and queues nothing.
    const again = await requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f))
    assert.ok(!again.ok && again.code === 'DELETE_IN_PROGRESS')
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId: f.orderId, type: 'SALES_INVOICE_DELETE' } }), 1)

    // An edit aimed at a document that is being deleted is refused by the processor's guard.
    const { pendingDocumentDeletionRefusal } = await service()
    assert.match(String(await pendingDocumentDeletionRefusal(f.xeroId, 'update')), /is being deleted/)
    assert.equal(await pendingDocumentDeletionRefusal('another-doc', 'update'), null)

    // The ledger confirms: IMS unwinds in one transaction.
    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'completed')
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })
    assert.equal(order.accountingInvoiceId, null)
    assert.equal(order.accountingInvoiceConnector, null)
    assert.equal(order.invoiceNumber, null, 'the order no longer holds the number')
    assert.equal(order.invoicedAt, null)
    assert.equal(order.paymentDueAt, null)
    const events = await db.accountingEvent.findMany({ where: { idempotencyKey: `evt-${f.tag}` } })
    assert.deepEqual(events.map((e) => [e.status, e.voidBasis, e.externalId]), [['VOID', 'document_deleted', null]])
    assert.equal(await db.accountingEventLog.count({ where: { accountingEventId: events[0]!.id, action: 'voided_document_deleted' } }), 1)
    const docs = await db.salesOrderInvoiceDocument.findMany({ where: { orderId: f.orderId } })
    assert.ok(docs.every((d) => d.withdrawnAt !== null), 'the stored PDF is withdrawn (kept, not deleted)')
    const done = await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })
    assert.equal(done.state, 'COMPLETED')
    assert.ok(done.completedAt)
    assert.equal((done.snapshot as { unwound: { orderLinkCleared: boolean } }).unwound.orderLinkCleared, true)
    const audit = await db.activityLog.findMany({ where: { entityId: f.orderId, action: { in: ['accounting_document_delete_requested', 'accounting_document_deleted'] } }, orderBy: { createdAt: 'asc' } })
    assert.deepEqual(audit.map((a) => a.action).sort(), ['accounting_document_delete_requested', 'accounting_document_deleted'])

    // Idempotent: the follow-up retry that re-runs it finds the work done.
    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'already-complete')
    assert.equal(await completeAccountingDocumentDeletion('no-such-document'), 'no-record')

    // THE REFERENCE IS REUSABLE: nothing in IMS holds the original number any more, and a replacement can carry it.
    assert.equal(await db.salesOrder.count({ where: { invoiceNumber: f.number } }), 0)
    const replacement = await db.salesOrder.create({
      data: { id: `DEL-repl-${f.tag}`, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1, invoiceNumber: f.number },
    })
    assert.equal(replacement.invoiceNumber, f.number)
    await db.salesOrder.delete({ where: { id: replacement.id } })
  } finally {
    await cleanSales(db, f)
  }
})

test('refusals: payments, refunds and credit notes, the Xero lock date, a document IMS did not create, the switch off, an unconfirmed ledger holder, a queued posting', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { requestAccountingDocumentDelete } = await service()
  const request = (f: SalesFixture, over: Partial<import('@/lib/domain/accounting/document-delete-service').DocumentDeleteRequestDeps> = {}) =>
    requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f, over))
  const fixtures: SalesFixture[] = []
  try {
    await applySettings()

    const paid = await seedSalesInvoice(db, 'paid'); fixtures.push(paid)
    await db.payment.create({ data: { orderId: paid.orderId, amount: 100, currency: 'GBP' } })
    const paidResult = await request(paid)
    assert.ok(!paidResult.ok && paidResult.code === 'HAS_PAYMENTS')
    assert.match(paidResult.error, /Remove the blocking items in the accounting system first/)

    const credited = await seedSalesInvoice(db, 'cn'); fixtures.push(credited)
    await db.salesOrderRefund.create({ data: { orderId: credited.orderId, totalForeign: 10, totalBase: 10 } })
    const creditedResult = await request(credited)
    assert.ok(!creditedResult.ok && creditedResult.code === 'HAS_CREDIT_NOTES')
    assert.match(creditedResult.error, /Remove the blocking items in the accounting system first/)

    const heldPaid = await seedSalesInvoice(db, 'paidflag'); fixtures.push(heldPaid)
    await db.salesOrder.update({ where: { id: heldPaid.orderId }, data: { paidAt: new Date() } })
    const paidFlag = await request(heldPaid)
    assert.ok(!paidFlag.ok && paidFlag.code === 'HAS_PAYMENTS', 'an order held as paid (the ledger said so) is refused too')

    const foreign = await seedSalesInvoice(db, 'foreign', { createdByIms: false }); fixtures.push(foreign)
    const foreignResult = await request(foreign)
    assert.ok(!foreignResult.ok && foreignResult.code === 'NOT_IMS_OWNED', 'a hand-asserted link is not IMS\'s own document')

    const xeroom = await seedSalesInvoice(db, 'xeroom'); fixtures.push(xeroom)
    const xeroomResult = await request(xeroom, { lookupInvoiceNumber: async () => claimFor('document-xeroom-raised', xeroom.number) })
    assert.ok(!xeroomResult.ok && xeroomResult.code === 'LEDGER_OWNERSHIP', 'the ledger holds the number under another system\'s document')
    const unanswered = await request(xeroom, { lookupInvoiceNumber: async () => ({ ok: false as const, error: 'HTTP 503' }) })
    assert.ok(!unanswered.ok && unanswered.code === 'LEDGER_OWNERSHIP')

    const inFlight = await seedSalesInvoice(db, 'flight'); fixtures.push(inFlight)
    await db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE_UPDATE', status: 'PENDING', referenceType: 'SalesOrder', referenceId: inFlight.orderId, payload: { accountingInvoiceId: inFlight.xeroId, _idempotencyKey: `u-${inFlight.tag}` } } })
    const inFlightResult = await request(inFlight)
    assert.ok(!inFlightResult.ok && inFlightResult.code === 'POSTING_IN_FLIGHT')

    const locked = await seedSalesInvoice(db, 'locked'); fixtures.push(locked)
    await applySettings({ xero_books_lock_date: '2026-11-10' })
    const lockedResult = await request(locked)
    assert.ok(!lockedResult.ok && lockedResult.code === 'PERIOD_LOCKED')
    assert.match(lockedResult.error, /2026-11-10/)
    await applySettings({ xero_books_lock_date: '2026-11-09' })
    assert.ok((await request(locked)).ok, 'a lock date before the document date does not refuse')
    await db.accountingDocumentDeletion.deleteMany({ where: { externalDocumentId: locked.xeroId } })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: locked.orderId, type: 'SALES_INVOICE_DELETE' } })

    await applySettings({ xero_document_delete_enabled: 'false' })
    const off = await request(locked)
    assert.ok(!off.ok && off.code === 'FEATURE_OFF')

    // None of the refusals queued or recorded anything.
    assert.equal(await db.accountingDocumentDeletion.count({ where: { externalDocumentId: { in: fixtures.map((x) => x.xeroId) } } }), 0)
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId: { in: fixtures.map((x) => x.orderId) }, type: 'SALES_INVOICE_DELETE' } }), 0)
  } finally {
    for (const f of fixtures) await cleanSales(db, f)
  }
})

test('HELD: under the producer hold the delete is recorded as a shadow, nothing is queued or recorded, and IMS is untouched', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedSalesInvoice(db, 'held')
  const { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } = await import('@/lib/security/producer-disposition-constants')
  const { OUTBOUND_GRANT_ENV } = await import('@/lib/security/outbound-write-hold-constants')
  const touched = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.xero, PRODUCER_CUTOFF_ENV.xero]
  const prior = Object.fromEntries(touched.map((key) => [key, process.env[key]]))
  process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'xero'
  process.env[OUTBOUND_GRANT_ENV.xero] = '4f7f0c6e-1111-4222-8333-944455556666'
  process.env[PRODUCER_CUTOFF_ENV.xero] = '2026-01-01T00:00:00Z'
  try {
    const { requestAccountingDocumentDelete } = await service()
    const result = await requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f))
    assert.ok(!result.ok && result.held === true && result.code === 'HELD', JSON.stringify(result))
    assert.match(result.error, /Nothing was changed in IMS or in Xero/)
    assert.equal(await db.accountingDocumentDeletion.count({ where: { externalDocumentId: f.xeroId } }), 0, 'no deletion record')
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId: f.orderId, type: 'SALES_INVOICE_DELETE', status: { in: ['PENDING', 'PROCESSING'] } } }), 0, 'nothing queued for the drain')
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })
    assert.equal(order.invoiceNumber, f.number)
    assert.equal(order.accountingInvoiceId, f.xeroId)
  } finally {
    for (const key of touched) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
    await cleanSales(db, f)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------
// SUPPLIER BILL
// ---------------------------------------------------------------------------------------------------------------------------

async function seedBill(db: Db, label: string) {
  const { createPurchaseOrder, createInvoice } = await import('@/app/actions/purchase-orders')
  const tag = `${uid()}-${label}`
  const product = await db.product.create({ data: { sku: tag, name: label, type: 'SIMPLE' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const zeroRate = await db.taxRate.create({ data: { name: `${tag} zero`, rate: '0', usedFor: 'PURCHASE', accountingTaxType: 'ZERORATEDINPUT', active: true }, select: { id: true } })
  fixtureRateIds.push(zeroRate.id)
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP', prepaid: true, taxRateId: zeroRate.id }, select: { id: true } })
  const created = await createPurchaseOrder({
    reference: tag, supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0,
    lines: [{ productId: product.id, sku: tag, productName: label, qty: 10, unitCostForeign: 12 }],
  } as never)
  assert.equal(created.success, true, String(created.error))
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: tag }, select: { id: true, lines: { select: { id: true } } } })
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const number = `SUP-${tag}`
  const bill = await createInvoice(po.id, { invoiceDate: '2026-11-12', invoiceNumber: number, lines: [{ kind: 'product', poLineId: po.lines[0]!.id, qtyBilled: 10, unitCostForeign: 12 }] } as never)
  assert.equal(bill.success, true, String(bill.error))
  const invoice = await db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true } })
  // The push: Xero answered, the sync row is SYNCED and the link was written back by IMS's own sync, exactly as the drain does it.
  const xeroId = `xero-bill-${tag}`
  await db.purchaseInvoice.update({ where: { id: invoice.id }, data: { accountingInvoiceId: xeroId, accountingInvoiceConnector: 'xero', accountingInvoiceIdSource: 'BILL_KEYED_SYNC' } })
  await db.accountingSyncLog.updateMany({ where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: invoice.id }, data: { status: 'SYNCED', externalTransactionId: xeroId, syncedAt: new Date() } })
  await db.accountingEvent.create({
    data: { type: 'PURCHASE_INVOICE', sourceEntityType: 'PurchaseInvoice', sourceEntityId: invoice.id, businessDate: new Date('2026-11-12'), status: 'POSTED', idempotencyKey: `evt-bill-${tag}`, linesJson: [], currency: 'GBP', externalSystem: 'xero', externalId: xeroId },
  })
  return { tag, poId: po.id, billId: invoice.id, xeroId, number }
}

type BillFixture = Awaited<ReturnType<typeof seedBill>>

async function cleanBill(db: Db, f: BillFixture) {
  await db.accountingEventLog.deleteMany({ where: { accountingEvent: { idempotencyKey: `evt-bill-${f.tag}` } } })
  await db.accountingEvent.deleteMany({ where: { idempotencyKey: `evt-bill-${f.tag}` } })
  await db.accountingDocumentDeletion.deleteMany({ where: { externalDocumentId: f.xeroId } })
  await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: f.billId }, { referenceId: f.poId }] } })
  await db.activityLog.deleteMany({ where: { entityId: f.poId } })
  await db.supplierCreditNote.deleteMany({ where: { poId: f.poId } })
  await db.transitSubledgerMovement.deleteMany({ where: { sourceRef: f.poId } })
}

const billDeps = { lookupInvoiceNumber: async () => ({ ok: false as const, error: 'bills are not looked up by number' }), activeConnector: async () => 'xero', newToken: () => 'B1LL42' }

test('eligible supplier bill: the unwind removes the bill, clears the PO\'s invoiced marker and reverses the transit sub-ledger movement the push recorded', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'bill')
  try {
    const transitFor = async () => (await db.transitSubledgerMovement.findMany({ where: { sourceRef: f.poId } })).reduce((sum, row) => sum + Number(row.baseDelta), 0)
    assert.equal(await transitFor(), 120, 'the push debited Stock in Transit by the bill\'s net subtotal')
    const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion } = await service()
    const requested = await requestAccountingDocumentDelete({ kind: 'PURCHASE_BILL', documentId: f.billId, requestedById: null }, billDeps)
    assert.ok(requested.ok, JSON.stringify(requested))
    assert.equal(requested.releasedNumber, `${f.number}-DEL-B1LL42`)
    assert.equal(await db.accountingSyncLog.count({ where: { type: 'PURCHASE_INVOICE_DELETE', referenceType: 'PurchaseInvoice', referenceId: f.billId, status: 'PENDING' } }), 1)
    assert.ok(await db.purchaseInvoice.findUnique({ where: { id: f.billId } }), 'the bill stands until Xero confirms')
    assert.equal(await transitFor(), 120)

    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'completed')
    assert.equal(await db.purchaseInvoice.findUnique({ where: { id: f.billId } }), null)
    assert.equal(await db.purchaseInvoiceLine.count({ where: { invoiceId: f.billId } }), 0)
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: f.poId } })).invoicedAt, null)
    assert.equal(await transitFor(), 0, 'the sub-ledger is back to nothing in transit for this bill')
    const reversal = await db.transitSubledgerMovement.findFirstOrThrow({ where: { sourceRef: f.poId, sourceType: 'PURCHASE_BILL_UPDATE' } })
    assert.equal(Number(reversal.baseDelta), -120)
    const events = await db.accountingEvent.findMany({ where: { idempotencyKey: `evt-bill-${f.tag}` } })
    assert.deepEqual(events.map((e) => [e.status, e.voidBasis]), [['VOID', 'document_deleted']])
    const deletion = await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })
    assert.equal(deletion.state, 'COMPLETED')
    const snapshot = deletion.snapshot as { unwound: { billDeleted: boolean; poInvoicedMarkerCleared: boolean; bill: { lines: unknown[] } } }
    assert.equal(snapshot.unwound.billDeleted, true)
    assert.equal(snapshot.unwound.poInvoicedMarkerCleared, true)
    assert.equal(snapshot.unwound.bill.lines.length, 1, 'the bill is kept as a snapshot on the deletion record')
    assert.equal(await db.activityLog.count({ where: { entityId: f.poId, action: 'accounting_document_deleted' } }), 1)
    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'already-complete')
    assert.equal(await transitFor(), 0, 'running it twice does not reverse twice')
  } finally {
    await cleanBill(db, f)
  }
})

test('bill refusals: a payment, a supplier credit note, a bill IMS did not create, a bill dated in a locked period', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const { requestAccountingDocumentDelete } = await service()
  const request = (id: string) => requestAccountingDocumentDelete({ kind: 'PURCHASE_BILL', documentId: id, requestedById: null }, billDeps)
  const fixtures: BillFixture[] = []
  try {
    const paid = await seedBill(db, 'bpaid'); fixtures.push(paid)
    await db.purchaseInvoice.update({ where: { id: paid.billId }, data: { paidAt: new Date() } })
    const paidResult = await request(paid.billId)
    assert.ok(!paidResult.ok && paidResult.code === 'HAS_PAYMENTS')
    assert.match(paidResult.error, /Remove the blocking items in the accounting system first/)

    const credited = await seedBill(db, 'bcn'); fixtures.push(credited)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: credited.poId }, select: { supplierId: true } })
    await db.supplierCreditNote.create({ data: { poId: credited.poId, purchaseInvoiceId: credited.billId, supplierId: po.supplierId, amountForeign: 5, amountBase: 5, currency: 'GBP', fxRateToBase: 1 } })
    const creditedResult = await request(credited.billId)
    assert.ok(!creditedResult.ok && creditedResult.code === 'HAS_CREDIT_NOTES')

    const qoblex = await seedBill(db, 'bforeign'); fixtures.push(qoblex)
    // Created by the incumbent writer and linked by hand: no SYNCED create row of IMS's, and a MANUAL link.
    await db.accountingSyncLog.deleteMany({ where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: qoblex.billId } })
    await db.purchaseInvoice.update({ where: { id: qoblex.billId }, data: { accountingInvoiceIdSource: 'MANUAL' } })
    const foreign = await request(qoblex.billId)
    assert.ok(!foreign.ok && foreign.code === 'NOT_IMS_OWNED')

    const locked = await seedBill(db, 'block'); fixtures.push(locked)
    await applySettings({ xero_books_lock_date: '2026-11-12' })
    const lockedResult = await request(locked.billId)
    assert.ok(!lockedResult.ok && lockedResult.code === 'PERIOD_LOCKED')

    assert.equal(await db.accountingDocumentDeletion.count({ where: { externalDocumentId: { in: fixtures.map((x) => x.xeroId) } } }), 0)
    for (const f of fixtures) assert.ok(await db.purchaseInvoice.findUnique({ where: { id: f.billId } }), 'no bill was touched')
  } finally {
    await applySettings()
    for (const f of fixtures) await cleanBill(db, f)
  }
})

test('the delete types never collide with a replacement: two deletes of two documents on one order are two obligations', SKIP, async () => {
  const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
  const a = accountingPostingKey({ type: 'SALES_INVOICE_DELETE', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { accountingInvoiceId: `A-${randomUUID()}` } })
  const b = accountingPostingKey({ type: 'SALES_INVOICE_DELETE', referenceType: 'SalesOrder', referenceId: 'so-1', payload: { accountingInvoiceId: `B-${randomUUID()}` } })
  assert.notEqual(a.scope, b.scope)
})

test('what the page shows: nothing with the switch off or without the permission; the button when eligible; the reason when not; nothing for a document that never reached Xero', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { documentDeleteUiStates } = await service()
  const ok = await seedSalesInvoice(db, 'ui-ok')
  const paid = await seedSalesInvoice(db, 'ui-paid')
  const unpushed = await seedSalesInvoice(db, 'ui-unpushed')
  try {
    await db.payment.create({ data: { orderId: paid.orderId, amount: 100, currency: 'GBP' } })
    await db.salesOrder.update({ where: { id: unpushed.orderId }, data: { accountingInvoiceId: null, accountingInvoiceConnector: null } })
    const ids = [ok.orderId, paid.orderId, unpushed.orderId]

    await applySettings({ xero_document_delete_enabled: 'false' })
    assert.deepEqual(Object.values(await documentDeleteUiStates('SALES_INVOICE', ids, true)).map((s) => s.show), [false, false, false], 'switch off: nothing is shown')

    await applySettings()
    assert.deepEqual(Object.values(await documentDeleteUiStates('SALES_INVOICE', ids, false)).map((s) => s.show), [false, false, false], 'no permission to edit: nothing is shown')
    const states = await documentDeleteUiStates('SALES_INVOICE', ids, true)
    assert.deepEqual(states[ok.orderId], { show: true, eligible: true, label: `invoice ${ok.number}` })
    const refused = states[paid.orderId]!
    assert.ok(refused.show && !refused.eligible && /Remove the blocking items in the accounting system first/.test(refused.reason))
    assert.deepEqual(states[unpushed.orderId], { show: false })
  } finally {
    for (const f of [ok, paid, unpushed]) await cleanSales(db, f)
  }
})

test('NEW ACTIVITY AFTER THE REQUEST: a receipt is refused while the delete is pending; one that slips in anyway stops the unwind, flags the document, and resuming re-checks', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedSalesInvoice(db, 'late')
  try {
    const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion, resumeAccountingDocumentDeletion, documentDeleteUiStates } = await service()
    const { pendingDeletionError } = await import('@/lib/domain/accounting/document-delete-pending')
    assert.ok((await requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f))).ok)

    // (a) BLOCK FIRST: the real receipt action refuses against the pending delete, and writes nothing.
    assert.match(String(await pendingDeletionError(f.orderId)), /is being deleted in IMS and Xero/)
    const { addPayment } = await import('@/app/actions/sales')
    const refused = await addPayment({ orderId: f.orderId, amount: 10, currency: 'GBP' })
    assert.equal(refused.success, false)
    assert.match(String(refused.error), /is being deleted in IMS and Xero/)
    assert.equal(await db.payment.count({ where: { orderId: f.orderId } }), 0)

    // (b) THEN RE-CHECK: a receipt that nevertheless got in (written straight to the table, as a race would) stops the unwind.
    await db.payment.create({ data: { orderId: f.orderId, amount: 10, currency: 'GBP' } })
    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'needs-review')
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })
    assert.equal(order.invoiceNumber, f.number, 'IMS was not unwound over the payment')
    assert.equal(order.accountingInvoiceId, f.xeroId)
    const flagged = await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })
    assert.equal(flagged.state, 'NEEDS_REVIEW')
    assert.deepEqual((flagged.snapshot as { lateActivity: string[] }).lateActivity, ['1 payment(s)'])
    const warning = await db.activityLog.findFirstOrThrow({ where: { entityId: f.orderId, action: 'accounting_document_delete_needs_review' } })
    assert.equal(warning.level, 'ERROR')
    assert.match(warning.description, /did NOT unwind it/)
    // Visible on the page, with a way back; further activity stays refused.
    const ui = (await documentDeleteUiStates('SALES_INVOICE', [f.orderId], true))[f.orderId]!
    assert.ok(ui.show && !ui.eligible && ui.review === true)
    assert.match(String(await pendingDeletionError(f.orderId)), /already removed/)
    // Resume while the payment is still there: still stopped. Clear it, resume: unwound.
    assert.equal(await resumeAccountingDocumentDeletion('SALES_INVOICE', f.orderId), 'needs-review')
    await db.payment.deleteMany({ where: { orderId: f.orderId } })
    assert.equal(await resumeAccountingDocumentDeletion('SALES_INVOICE', f.orderId), 'completed')
    assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })).invoiceNumber, null)
    assert.equal(await pendingDeletionError(f.orderId), null)
  } finally {
    await cleanSales(db, f)
  }
})

test('NEW ACTIVITY ON A BILL: a supplier credit note recorded after the request stops the unwind and its link to the bill survives', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'blate')
  try {
    const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion } = await service()
    const { pendingDeletionError } = await import('@/lib/domain/accounting/document-delete-pending')
    assert.ok((await requestAccountingDocumentDelete({ kind: 'PURCHASE_BILL', documentId: f.billId, requestedById: null }, billDeps)).ok)
    assert.match(String(await pendingDeletionError(f.billId)), /bill/)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: f.poId }, select: { supplierId: true } })
    const cn = await db.supplierCreditNote.create({ data: { poId: f.poId, purchaseInvoiceId: f.billId, supplierId: po.supplierId, amountForeign: 5, amountBase: 5, currency: 'GBP', fxRateToBase: 1 } })
    assert.equal(await completeAccountingDocumentDeletion(f.xeroId), 'needs-review')
    assert.ok(await db.purchaseInvoice.findUnique({ where: { id: f.billId } }), 'the bill was not hard-deleted')
    assert.equal((await db.supplierCreditNote.findUniqueOrThrow({ where: { id: cn.id } })).purchaseInvoiceId, f.billId, 'the credit note still names its bill')
    assert.equal((await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })).state, 'NEEDS_REVIEW')
    const transit = (await db.transitSubledgerMovement.findMany({ where: { sourceRef: f.poId } })).reduce((sum, row) => sum + Number(row.baseDelta), 0)
    assert.equal(transit, 120, 'no reversal was recorded')
  } finally {
    await cleanBill(db, f)
  }
})

test('A REFUND THAT HOLDS THE ORDER LOCK WHEN COMPLETION ARRIVES: completion parks behind it, counts after it commits, and stops at NEEDS_REVIEW (sales invoice and bill)', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { backendPid, waitUntilParkedBehind } = await import('@/tests/helpers/lock-wait-observer')
  await applySettings()
  const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion } = await service()

  const f = await seedSalesInvoice(db, 'race')
  const b = await seedBill(db, 'brace')
  try {
    assert.ok((await requestAccountingDocumentDelete({ kind: 'SALES_INVOICE', documentId: f.orderId, requestedById: null }, deps(f))).ok)
    assert.ok((await requestAccountingDocumentDelete({ kind: 'PURCHASE_BILL', documentId: b.billId, requestedById: null }, billDeps)).ok)
    const supplierId = (await db.purchaseOrder.findUniqueOrThrow({ where: { id: b.poId }, select: { supplierId: true } })).supplierId

    // The writer passed its pending-delete fence BEFORE the requests committed, then took the lock; completion arrives while it still holds it.
    let completion: Promise<string> | null = null
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${f.orderId} FOR UPDATE`
      const pid = await backendPid(tx)
      completion = completeAccountingDocumentDeletion(f.xeroId)
      await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: /sales_orders/i, describe: 'sales completion behind the refund' })
      await tx.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: 10, totalBase: 10 } })
    }, { timeout: 20_000, maxWait: 10_000 })
    assert.equal(await completion, 'needs-review', 'the refund committed while completion waited, so it was counted')
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId } })
    assert.equal(order.invoiceNumber, f.number, 'not unwound over the refund')
    assert.equal((await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: f.xeroId } })).state, 'NEEDS_REVIEW')

    let billCompletion: Promise<string> | null = null
    await db.$transaction(async (tx) => {
      // o3d-668a2: a bill writer takes the purchase order first, then the bill (the supplier credit note and the return do), and so does completion.
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${b.poId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${b.billId} FOR UPDATE`
      const pid = await backendPid(tx)
      billCompletion = completeAccountingDocumentDeletion(b.xeroId)
      await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: /purchase_orders/i, describe: 'bill completion behind the credit note' })
      await tx.supplierCreditNote.create({ data: { poId: b.poId, purchaseInvoiceId: b.billId, supplierId, amountForeign: 5, amountBase: 5, currency: 'GBP', fxRateToBase: 1 } })
    }, { timeout: 20_000, maxWait: 10_000 })
    assert.equal(await billCompletion, 'needs-review')
    assert.ok(await db.purchaseInvoice.findUnique({ where: { id: b.billId } }), 'the bill was not hard-deleted over the credit note')
    assert.equal((await db.accountingDocumentDeletion.findUniqueOrThrow({ where: { externalDocumentId: b.xeroId } })).state, 'NEEDS_REVIEW')
  } finally {
    await cleanSales(db, f)
    await cleanBill(db, b)
  }
})
