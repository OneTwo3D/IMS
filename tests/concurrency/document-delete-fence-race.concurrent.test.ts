import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import '../helpers/xero-attested.ts'
import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

import { loadEnv, uid } from './po-landed-fixtures'

/**
 * o3d-668a2 — THE PENDING-DELETE FENCE IS READ UNDER THE LOCK THE DELETE REQUEST TAKES, against a real PostgreSQL.
 *
 * Each race is driven the same way: a "request" transaction takes the locks requestAccountingDocumentDelete takes (the sales order; or the
 * purchase order, then the bill) and writes its PENDING deletion record, uncommitted. The writer under test is started while that transaction
 * holds the locks, and the test WAITS until the server reports the writer parked behind the holder (lock-wait-observer: the barrier, asserted,
 * never a sleep). Then the request commits. The writer must refuse: it reads the fence only once it holds the lock, so it sees the committed
 * request. Before the fix it read the fence first (nothing pending), then waited, then wrote against a document Xero was about to remove.
 *
 * The lock-order test (completion takes the purchase order before the bill) is decided by NOWAIT on the bill while completion is parked on
 * the purchase order.
 *
 * Every fixture is created with unique ids and removed afterwards; nothing assumes the tables are empty. Gated: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireAuth: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
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

async function applySettings() {
  const { db } = await import('@/lib/db')
  if (priorSettings === null) priorSettings = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } }, select: { key: true, value: true } })
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
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
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0]

async function observer() {
  return import('@/tests/helpers/lock-wait-observer')
}

/**
 * The request, paused: holds `lock(tx)` and an uncommitted PENDING deletion record while `writer()` runs, commits once the writer is observed
 * parked behind it. Returns the writer's answer.
 */
async function raceAgainstRequest<T>(db: Db, params: {
  lock: (tx: Tx) => Promise<void>
  deletion: { kind: string; referenceType: string; referenceId: string; documentId: string; externalDocumentId: string; originalNumber: string }
  writer: () => Promise<T>
  waitingOn: RegExp
  describe: string
}): Promise<{ answer: T; parkedOn: string }> {
  const { backendPid, waitUntilParkedBehind } = await observer()
  let running: Promise<T> | null = null
  let parkedOn = ''
  await db.$transaction(async (tx) => {
    await params.lock(tx)
    await tx.accountingDocumentDeletion.create({ data: { ...params.deletion, releasedNumber: `${params.deletion.originalNumber}-DEL-RACE01`, snapshot: {} } })
    const pid = await backendPid(tx)
    running = params.writer()
    // THE BARRIER: the writer is blocked by this transaction's lock. Fails loud (never proceeds) if it is not observed.
    const parked = await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: params.waitingOn, describe: params.describe })
    parkedOn = parked.query
  }, { timeout: 25_000, maxWait: 10_000 })
  assert.ok(running, 'the writer was started while the request held the lock')
  return { answer: await (running as unknown as Promise<T>), parkedOn }
}

// ---------------------------------------------------------------------------------------------------------------------------
// SALES INVOICE
// ---------------------------------------------------------------------------------------------------------------------------

type SalesFixture = { orderId: string; xeroId: string; number: string; tag: string; productId: string; lineId: string; warehouseIds: string[] }

async function seedSalesInvoice(db: Db, label: string): Promise<SalesFixture> {
  const tag = `${label}-${uid()}`
  const orderId = `FENCE-${tag}`
  const xeroId = `xero-inv-${tag}`
  const number = `INV-${tag}`
  const product = await db.product.create({ data: { sku: `FENCE-${tag}`, name: 'fence', type: 'SIMPLE' }, select: { id: true } })
  const order = await db.salesOrder.create({
    data: {
      id: orderId, status: 'SHIPPED', currency: 'GBP', fxRateToBase: 1, subtotalForeign: 100, totalForeign: 100, subtotalBase: 100, taxBase: 0, totalBase: 100,
      invoiceNumber: number, invoicedAt: new Date('2026-11-10T00:00:00Z'), accountingInvoiceId: xeroId, accountingInvoiceConnector: 'xero',
      lines: { create: [{ productId: product.id, description: 'fence', qty: 1, unitPriceForeign: 100, unitPriceBase: 100, taxForeign: 0, taxBase: 0, totalForeign: 100, totalBase: 100 }] },
    },
    select: { lines: { select: { id: true } } },
  })
  await db.accountingSyncLog.create({
    data: {
      type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: orderId, externalTransactionId: xeroId, syncedAt: new Date(),
      payload: { date: '2026-11-10', invoiceNumber: number, reference: `SO-${tag}`, _idempotencyKey: `seed-${tag}` },
    },
  })
  return { orderId, xeroId, number, tag, productId: product.id, lineId: order.lines[0]!.id, warehouseIds: [] }
}

async function cleanSales(db: Db, f: SalesFixture) {
  const refundIds = (await db.salesOrderRefund.findMany({ where: { orderId: f.orderId }, select: { id: true } })).map((r) => r.id)
  await db.accountingDocumentDeletion.deleteMany({ where: { externalDocumentId: f.xeroId } })
  await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [f.orderId, ...refundIds] } } })
  await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: [f.orderId, ...refundIds] } } })
  await db.integrationOutbox.deleteMany({ where: { payloadJson: { path: ['orderId'], equals: f.orderId } } })
  await db.activityLog.deleteMany({ where: { entityId: f.orderId } })
  await db.payment.deleteMany({ where: { orderId: f.orderId } })
  await db.salesOrderRefundLine.deleteMany({ where: { refundId: { in: refundIds } } })
  await db.salesOrderRefund.deleteMany({ where: { orderId: f.orderId } })
  await db.salesOrderLine.deleteMany({ where: { orderId: f.orderId } })
  await db.salesOrder.deleteMany({ where: { id: f.orderId } })
  await db.product.deleteMany({ where: { id: f.productId } })
}

const salesDeletion = (f: SalesFixture) => ({ kind: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: f.orderId, documentId: f.orderId, externalDocumentId: f.xeroId, originalNumber: f.number })

test('MARK PAID vs THE DELETE REQUEST: parked behind the request\'s order lock, it reads the committed request and refuses; the order is not marked paid', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedSalesInvoice(db, 'paid')
  try {
    await db.salesOrder.update({ where: { id: f.orderId }, data: { status: 'PROCESSING', paidAt: null } })
    const { markSalesOrderPaid } = await import('@/app/actions/sales')
    const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
    const { answer } = await raceAgainstRequest(db, {
      lock: (tx) => lockSalesOrder(tx, f.orderId),
      deletion: salesDeletion(f),
      writer: () => markSalesOrderPaid(f.orderId),
      waitingOn: /sales_orders/i,
      describe: 'mark paid behind the delete request',
    })
    assert.equal(answer.success, false, 'the mark-paid must refuse once the request has committed')
    assert.match(String(answer.error), /is being deleted in IMS and Xero/)
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { paidAt: true } })
    assert.equal(order.paidAt, null, 'nothing was recorded against the invoice whose delete is pending')
  } finally {
    await cleanSales(db, f)
  }
})

test('A REFUND vs THE DELETE REQUEST: createSalesOrderRefund parks behind the order lock, then refuses on the committed request and writes nothing', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedSalesInvoice(db, 'refund')
  try {
    await db.salesOrder.update({ where: { id: f.orderId }, data: { paidAt: new Date() } })
    const { createSalesOrderRefund } = await import('@/lib/domain/sales/refund-service')
    const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
    const { answer } = await raceAgainstRequest(db, {
      lock: (tx) => lockSalesOrder(tx, f.orderId),
      deletion: salesDeletion(f),
      writer: () => createSalesOrderRefund(db, { orderId: f.orderId, lines: [{ lineId: f.lineId, productId: f.productId, description: 'fence', qty: 1, totalBase: 100 }], reason: 'race', creditNotePrefix: `FR${f.tag.slice(-6)}-` }),
      waitingOn: /sales_orders/i,
      describe: 'refund behind the delete request',
    })
    assert.equal(answer.success, false, 'the refund must refuse once the request has committed')
    assert.match(String((answer as { error?: string }).error), /is being deleted in IMS and Xero/)
    assert.equal(await db.salesOrderRefund.count({ where: { orderId: f.orderId } }), 0, 'no refund was recorded against the invoice')
  } finally {
    await cleanSales(db, f)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------
// SUPPLIER BILL
// ---------------------------------------------------------------------------------------------------------------------------

async function seedBill(db: Db, label: string, opts: { received?: number } = {}) {
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
  const poLineId = po.lines[0]!.id
  await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'PO_SENT' } })
  const number = `SUP-${tag}`
  const bill = await createInvoice(po.id, { invoiceDate: '2026-11-12', invoiceNumber: number, lines: [{ kind: 'product', poLineId, qtyBilled: 10, unitCostForeign: 12 }] } as never)
  assert.equal(bill.success, true, String(bill.error))
  const invoice = await db.purchaseInvoice.findFirstOrThrow({ where: { poId: po.id }, select: { id: true, lines: { select: { id: true } } } })
  const xeroId = `xero-bill-${tag}`
  await db.purchaseInvoice.update({ where: { id: invoice.id }, data: { accountingInvoiceId: xeroId, accountingInvoiceConnector: 'xero', accountingInvoiceIdSource: 'BILL_KEYED_SYNC' } })
  await db.accountingSyncLog.updateMany({ where: { type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', referenceId: invoice.id }, data: { status: 'SYNCED', externalTransactionId: xeroId, syncedAt: new Date() } })
  if (opts.received) {
    // The goods arrived (written as the receipt leaves them: the line's received quantity, the stock, a layer attributable to the line).
    await db.purchaseOrderLine.update({ where: { id: poLineId }, data: { qtyReceived: opts.received } })
    await db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'RECEIVED' } })
    await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: opts.received, reservedQty: 0 } })
    await db.costLayer.create({ data: { productId: product.id, warehouseId: warehouse.id, receivedQty: opts.received, remainingQty: opts.received, unitCostBase: 12, poLineId } })
  }
  return { tag, poId: po.id, poLineId, billId: invoice.id, billLineId: invoice.lines[0]!.id, xeroId, number, productId: product.id, warehouseId: warehouse.id }
}

type BillFixture = Awaited<ReturnType<typeof seedBill>>

async function cleanBill(db: Db, f: BillFixture) {
  await db.accountingDocumentDeletion.deleteMany({ where: { externalDocumentId: f.xeroId } })
  await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: f.billId }, { referenceId: f.poId }] } })
  await db.activityLog.deleteMany({ where: { entityId: f.poId } })
  await db.supplierCreditNote.deleteMany({ where: { poId: f.poId } })
  await db.transitSubledgerMovement.deleteMany({ where: { sourceRef: f.poId } })
}

const billDeletion = (f: BillFixture) => ({ kind: 'PURCHASE_BILL', referenceType: 'PurchaseInvoice', referenceId: f.billId, documentId: f.billId, externalDocumentId: f.xeroId, originalNumber: f.number })

/** The bill delete request's locks, in its order (o3d-668a2): the purchase order, then the bill. */
const lockPoThenBill = (f: BillFixture) => async (tx: Tx) => {
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${f.poId} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${f.billId} FOR UPDATE`
}

test('A BILL EDIT vs THE DELETE REQUEST: parked behind the request\'s locks, it refuses on the committed request; the bill is unchanged', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'bedit')
  try {
    const { updateInvoice } = await import('@/app/actions/purchase-orders')
    const before = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: f.billId }, select: { notes: true, updatedAt: true } })
    const { answer } = await raceAgainstRequest(db, {
      lock: lockPoThenBill(f),
      deletion: billDeletion(f),
      writer: () => updateInvoice(f.billId, { invoiceDate: '2026-11-12', invoiceNumber: f.number, notes: `edited in the race ${f.tag}`, lines: [{ id: f.billLineId, qtyBilled: 10, unitCostForeign: 12 }] } as never),
      waitingOn: /purchase_(orders|invoices)/i,
      describe: 'bill edit behind the delete request',
    })
    assert.equal(answer.success, false, 'the edit must refuse once the request has committed')
    assert.match(String(answer.error), /is being deleted in IMS and Xero/)
    const after = await db.purchaseInvoice.findUniqueOrThrow({ where: { id: f.billId }, select: { notes: true, updatedAt: true } })
    assert.deepEqual(after, before, 'the bill was not edited')
    assert.equal(await db.accountingSyncLog.count({ where: { type: 'PURCHASE_INVOICE_UPDATE', referenceId: f.billId } }), 0, 'no update was queued for the bill on its way out')
  } finally {
    await cleanBill(db, f)
  }
})

test('A BILL PAYMENT vs THE DELETE REQUEST: parked behind the bill lock, it refuses on the committed request; the bill is not marked paid', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'bpay')
  const bankId = `bank-${f.tag}`
  await db.accountingAccount.create({ data: { connector: 'xero', externalAccountId: bankId, code: `B${f.tag.slice(-5)}`, name: `Bank ${f.tag}`, type: 'BANK', active: true } })
  try {
    const { markBillPaid } = await import('@/app/actions/purchase-orders')
    const { answer } = await raceAgainstRequest(db, {
      lock: lockPoThenBill(f),
      deletion: billDeletion(f),
      writer: () => markBillPaid(f.billId, { bankAccountId: bankId, paymentDate: '2026-11-15' }),
      waitingOn: /purchase_invoices/i,
      describe: 'bill payment behind the delete request',
    })
    assert.equal(answer.success, false, 'the payment must refuse once the request has committed')
    assert.match(String(answer.error), /is being deleted in IMS and Xero/)
    assert.equal((await db.purchaseInvoice.findUniqueOrThrow({ where: { id: f.billId }, select: { paidAt: true } })).paidAt, null)
    assert.equal(await db.accountingSyncLog.count({ where: { type: 'BILL_PAYMENT', referenceId: f.billId } }), 0)
  } finally {
    await db.accountingAccount.deleteMany({ where: { externalAccountId: bankId } })
    await cleanBill(db, f)
  }
})

test('A SUPPLIER RETURN vs THE DELETE REQUEST: parked behind the purchase order lock, it refuses on the committed request; no credit note names the bill', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'bret', { received: 10 })
  try {
    const { returnPurchaseOrder } = await import('@/app/actions/purchase-orders')
    const { answer } = await raceAgainstRequest(db, {
      lock: lockPoThenBill(f),
      deletion: billDeletion(f),
      writer: () => returnPurchaseOrder(f.poId, [{ poLineId: f.poLineId, qtyReturned: 2, warehouseId: f.warehouseId }], 'damaged'),
      waitingOn: /purchase_orders/i,
      describe: 'supplier return behind the delete request',
    })
    assert.equal(answer.success, false, 'the return must refuse once the request has committed')
    assert.match(String(answer.error), /is being deleted in IMS and Xero/)
    assert.equal(await db.supplierCreditNote.count({ where: { purchaseInvoiceId: f.billId } }), 0, 'no credit note was raised against the bill on its way out')
    assert.equal(Number((await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: f.productId, warehouseId: f.warehouseId } } })).quantity), 10, 'the return rolled back whole')
  } finally {
    await db.purchaseReturnLine.deleteMany({ where: { return: { poId: f.poId } } }).catch(() => {})
    await db.purchaseReturn.deleteMany({ where: { poId: f.poId } }).catch(() => {})
    await cleanBill(db, f)
  }
})

test('A SUPPLIER CREDIT NOTE vs THE DELETE REQUEST: recorded behind the purchase order lock, it refuses on the committed request', SKIP, async () => {
  const { db } = await import('@/lib/db')
  await applySettings()
  const f = await seedBill(db, 'bcn')
  try {
    const { recordSupplierFreightCreditNote } = await import('@/app/actions/purchase-orders')
    const { answer } = await raceAgainstRequest(db, {
      lock: lockPoThenBill(f),
      deletion: billDeletion(f),
      writer: () => recordSupplierFreightCreditNote({ poId: f.poId, purchaseInvoiceId: f.billId, amountForeign: 5, reason: 'race' }),
      waitingOn: /purchase_orders/i,
      describe: 'supplier credit note behind the delete request',
    })
    assert.equal(answer.success, false, 'the credit note must refuse once the request has committed')
    assert.match(String(answer.error), /is being deleted in IMS and Xero/)
    assert.equal(await db.supplierCreditNote.count({ where: { purchaseInvoiceId: f.billId } }), 0)
  } finally {
    await cleanBill(db, f)
  }
})

test('LOCK ORDER: bill completion takes the purchase order BEFORE the bill (as the supplier return does), so parked on the order it holds no bill lock', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { backendPid, waitUntilParkedBehind } = await observer()
  await applySettings()
  const f = await seedBill(db, 'border')
  try {
    const { requestAccountingDocumentDelete, completeAccountingDocumentDeletion } = await import('@/lib/domain/accounting/document-delete-service')
    const billDeps = { lookupInvoiceNumber: async () => ({ ok: false as const, error: 'bills are not looked up by number' }), activeConnector: async () => 'xero', newToken: () => 'LOCK42' }
    assert.ok((await requestAccountingDocumentDelete({ kind: 'PURCHASE_BILL', documentId: f.billId, requestedById: null }, billDeps)).ok)
    let completion: Promise<string> | null = null
    let billFreeWhileParked: boolean | null = null
    await db.$transaction(async (tx) => {
      // A supplier return in flight: it holds the purchase order (and would next share-lock the bill through its credit note's foreign key).
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${f.poId} FOR UPDATE`
      const pid = await backendPid(tx)
      completion = completeAccountingDocumentDeletion(f.xeroId)
      await waitUntilParkedBehind(db, { holderPid: pid, waitingOn: /purchase_orders/i, describe: 'completion behind the return' })
      // THE DISCRIMINATOR: with bill-then-order, completion would hold the bill here and the return's credit note insert would deadlock against it.
      billFreeWhileParked = await db.$transaction(async (probe) => {
        try {
          await probe.$queryRaw`SELECT id FROM purchase_invoices WHERE id = ${f.billId} FOR KEY SHARE NOWAIT`
          return true
        } catch {
          return false
        }
      })
    }, { timeout: 25_000, maxWait: 10_000 })
    assert.equal(billFreeWhileParked, true, 'completion parked on the purchase order holds no lock on the bill')
    assert.equal(await completion, 'completed')
  } finally {
    await cleanBill(db, f)
  }
})
