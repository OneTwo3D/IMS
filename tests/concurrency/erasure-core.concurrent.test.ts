import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE ERASURE CORE AGAINST A REAL POSTGRES, THROUGH THE REAL IMPORTER.
 *
 * One order is imported from a WooCommerce payload carrying a distinctive name, VAT number and address. The rest of its
 * surface is filled by hand (internal notes, tracking on the order, shipment and warehouse snapshot, outbox rows in every
 * state, a notification, a refund with a reason, an invoice path). The customer is then erased and every column is read
 * back: the personal ones are gone, the retained ones (totals, tax, ids, invoice path, refund reason) are untouched.
 * Then the SAME payload is delivered again — by the update path and by the full import — and the identity must not come
 * back. The proof record is searched for the name, and survives the activity-log purge that deletes an ordinary INFO row.
 *
 * No network: `fetch` is counted throughout (the test:concurrency preload also refuses any non-loopback socket), and the
 * erasure and importer paths are exercised with the accounting facade stubbed, as in the sibling importer tests.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      queueAccountingSync: async () => ({ queued: true }),
    },
  })
  accountingMocked = true
}

let actionsMocked = false
async function mockActionEnvironment() {
  if (actionsMocked) return
  const actual = await import('@/lib/auth/server')
  mock.module('@/lib/auth/server', { namedExports: { ...actual, requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }) } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
  actionsMocked = true
}

async function loadDb() {
  // Installed by the first test, BEFORE it imports any module that captures `requirePermission`.
  await mockActionEnvironment()
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

const NAME = { first: 'Zebediah', last: 'Quillfeather' }
const FULL_NAME = `${NAME.first} ${NAME.last}`
const EMAIL = `zebediah.quillfeather+${randomUUID().slice(0, 8)}@example.test`
const PHONE = '+44 7700 900123'
const COMPANY = 'Quillfeather Ironworks'
const STREET = '77 Marmalade Lane'
const POSTCODE = 'ZQ1 9XY'
const VAT = 'GB987654321'
const TRACKING = 'TRK-QUILL-0001'
const ORDER_NOTE = 'Leave the parcel with Mrs Quillfeather next door'
const INTERNAL_NOTE = 'Customer Zebediah rang about the delivery'
const PERSONAL_STRINGS = [NAME.first, NAME.last, EMAIL, PHONE, COMPANY, STREET, POSTCODE, VAT, TRACKING, ORDER_NOTE, 'Mrs Quillfeather']

const WC_ADDRESS = {
  first_name: NAME.first, last_name: NAME.last, company: COMPANY, address_1: STREET, address_2: '', city: 'Leeds', state: '',
  postcode: POSTCODE, country: 'GB', email: EMAIL, phone: PHONE,
}

function payload(externalId: number, wcRateId: number) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: ORDER_NOTE, customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: WC_ADDRESS, shipping: WC_ADDRESS, meta_data: [{ id: 9, key: '_billing_vat', value: VAT }],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '1.00', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Royal Mail', method_id: 'flat_rate', total: '5.00', total_tax: '1.00', taxes: [{ id: wcRateId, total: '1.00' }], meta_data: [] }],
    coupon_lines: [], refunds: [],
    total: '126.00', total_tax: '21.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '5.00', shipping_tax_total: '1.00', shipping_tax: '1.00',
  }
}

type Fixture = { orderId: string; customerId: string; externalId: number; warehouseId: string; rateId: string; refundId: string; cleanup(): Promise<void> }

async function importFixture(db: Awaited<ReturnType<typeof loadDb>>): Promise<Fixture> {
  await mockAccounting()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `ERS-${randomUUID().slice(0, 8)}`, name: 'Erasure test warehouse', syncToStore: true, availableForSale: true } })
  const imported = await importWcOrder(payload(externalId, wcRateId) as never)
  assert.equal(imported.success, true, `import succeeded: ${JSON.stringify(imported)}`)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
  const orderId = link.orderId
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })
  assert.ok(order.customerId, 'the import attached a customer')
  const customerId = order.customerId

  await db.salesOrder.update({ where: { id: orderId }, data: { internalNotes: INTERNAL_NOTE, trackingNumber: TRACKING, invoicePdfPath: `uploads/invoices/${orderId}.pdf` } })
  await db.shipment.create({ data: { orderId, warehouseId: warehouse.id, trackingNumber: TRACKING } })
  await db.wmsOrderStatusSnapshot.create({ data: { orderId, connector: 'mintsoft', connectorLabel: 'Mintsoft', externalOrderId: 'm1', externalOrderNumber: 'm1', status: 'Despatched', statusLabel: 'Despatched', trackingNumber: TRACKING, carrier: 'Royal Mail', deepLinkUrl: 'https://wms.example.test/o/m1' } })
  const outbox = (kind: string, status: 'SENT' | 'FAILED' | 'PENDING' | 'PROCESSING' | 'PARKED_SEND_CAP') =>
    db.emailOutbox.create({ data: { kind, toEmail: EMAIL, subject: 'Order Confirmation SO-1', html: 'queued', referenceType: 'SalesOrder', referenceId: orderId, status } })
  await outbox('k-sent', 'SENT'); await outbox('k-failed', 'FAILED'); await outbox('k-pending', 'PENDING'); await outbox('k-processing', 'PROCESSING'); await outbox('k-parked', 'PARKED_SEND_CAP')
  await db.notification.create({ data: { type: 'info', title: `Payment for ${FULL_NAME}`, message: `${FULL_NAME} paid`, actionUrl: `/sales/${orderId}` } })
  await db.notification.create({ data: { type: 'info', title: 'Unrelated', message: 'about another order', actionUrl: '/sales/someone-else' } })
  const refund = await db.salesOrderRefund.create({ data: { orderId, reason: 'Item arrived damaged', totalForeign: 1, totalBase: 1 } as never })
  await db.emailOutbox.updateMany({ where: { referenceId: orderId, kind: 'k-processing' }, data: { lockedBy: 'claim-token', processingStartedAt: new Date('2026-11-06T09:00:00Z') } })
  // Activity rows written BEFORE the erasure, as the old actions wrote them: names in descriptions, an email in metadata.
  const before = (id: string, entityType: 'CUSTOMER' | 'SALES_ORDER', entityId: string, action: string, description: string, metadata: object) =>
    db.activityLog.create({ data: { id, entityType, entityId, action, tag: 'sales', level: 'INFO', description, metadata } })
  await before(`pre-created-${orderId}`, 'CUSTOMER', customerId, 'created', `Created customer: ${FULL_NAME}`, { company: COMPANY })
  await before(`pre-legacy-${orderId}`, 'CUSTOMER', customerId, 'gdpr_anonymised', `GDPR anonymised customer: ${FULL_NAME} (1 orders anonymised)`, {})
  await before(`pre-order-${orderId}`, 'SALES_ORDER', orderId, 'wc_note', `Customer ${EMAIL} rang from ${PHONE}`, { contact: { email: EMAIL, tracking: TRACKING } })
  await before(`pre-marker-${orderId}`, 'SALES_ORDER', orderId, 'wc_refund_park_recovered', 'Refund park recovered', { connector: 'woocommerce', externalOrderId: String(externalId) })
  await db.shoppingCustomerLink.updateMany({ where: { customerId }, data: { metadata: { note: FULL_NAME } } })
  await db.customer.update({ where: { id: customerId }, data: { notes: `Prefers ${FULL_NAME}` } })

  return {
    orderId, customerId, externalId, warehouseId: warehouse.id, rateId: rate.id, refundId: refund.id,
    cleanup: async () => {
      await db.emailOutbox.deleteMany({ where: { referenceId: orderId } })
      await db.notification.deleteMany({ where: { OR: [{ actionUrl: { contains: orderId } }, { actionUrl: '/sales/someone-else' }] } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.activityLog.deleteMany({ where: { OR: [{ entityId: orderId }, { entityId: customerId }] } })
      await db.salesOrderRefund.deleteMany({ where: { orderId } })
      await db.shipment.deleteMany({ where: { orderId } })
      await db.wmsOrderStatusSnapshot.deleteMany({ where: { orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
      await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
      await db.shoppingCustomerLink.deleteMany({ where: { customerId } })
      await db.customer.deleteMany({ where: { id: customerId } })
      await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      await db.taxRate.deleteMany({ where: { id: rate.id } })
    },
  }
}

/** Counts fetch calls for the duration of the test: an erasure must make none. */
function spyOnFetch() {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; throw new Error('an erasure test must make no network call') }) as typeof fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

test('[erasure] the core erases every personal column, keeps the decided retentions, and an import cannot bring the identity back', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const net = spyOnFetch()
  t.after(async () => { net.restore(); await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { ERASURE_PLACEHOLDER_EMAIL, ERASURE_RECORD_ACTION } = await import('@/lib/domain/erasure/erasure-record')

  // PRECONDITION: the fixture really holds the personal data, so "gone" below cannot pass vacuously.
  const before = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(before.customerName, FULL_NAME)
  assert.equal(before.customerEmail, EMAIL)
  assert.equal(before.customerVatNumber, VAT)
  assert.equal(before.notes, ORDER_NOTE)
  assert.match(JSON.stringify(before.billingAddress), new RegExp(STREET))
  assert.equal(before.erasedAt, null)
  const keepTotals = { subtotalBase: before.subtotalBase.toString(), totalBase: before.totalBase.toString(), totalForeign: before.totalForeign.toString(), currency: before.currency, orderNumber: before.orderNumber }

  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))

  // ERASED.
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(order.customerName, 'GDPR Anonymised')
  assert.equal(order.customerEmail, null)
  assert.equal(order.customerVatNumber, null)
  assert.equal(order.billingAddress, null)
  assert.equal(order.shippingAddress, null)
  assert.equal(order.notes, null)
  assert.equal(order.internalNotes, null)
  assert.equal(order.trackingNumber, null)
  assert.ok(order.erasedAt, 'the positive erasure marker is set')
  // RETAINED.
  assert.deepEqual({ subtotalBase: order.subtotalBase.toString(), totalBase: order.totalBase.toString(), totalForeign: order.totalForeign.toString(), currency: order.currency, orderNumber: order.orderNumber }, keepTotals)
  assert.equal(order.invoicePdfPath, `uploads/invoices/${fx.orderId}.pdf`, 'the issued invoice PDF reference is a statutory record')
  assert.equal((await db.salesOrderRefund.findUniqueOrThrow({ where: { id: fx.refundId } })).reason, 'Item arrived damaged', 'refund reason is retained by decision')

  const customer = await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })
  assert.deepEqual([customer.firstName, customer.lastName, customer.email, customer.phone, customer.company, customer.taxNumber, customer.billingAddress, customer.shippingAddress, customer.notes, customer.externalCustomerId, customer.active],
    ['GDPR', 'Anonymised', null, null, null, null, null, null, null, null, false])
  assert.ok(customer.gdprAnonymisedAt)

  assert.equal((await db.shipment.findFirstOrThrow({ where: { orderId: fx.orderId } })).trackingNumber, null)
  const snap = await db.wmsOrderStatusSnapshot.findUniqueOrThrow({ where: { orderId: fx.orderId } })
  assert.deepEqual([snap.trackingNumber, snap.carrier, snap.deepLinkUrl], [null, null, null])
  assert.equal((await db.shoppingOrderLink.findFirstOrThrow({ where: { orderId: fx.orderId } })).metadata, null)
  for (const link of await db.shoppingCustomerLink.findMany({ where: { customerId: fx.customerId } })) assert.equal(link.metadata, null)

  const outbox = Object.fromEntries((await db.emailOutbox.findMany({ where: { referenceId: fx.orderId } })).map((r) => [r.kind, r]))
  for (const kind of ['k-sent', 'k-failed', 'k-pending', 'k-parked']) assert.equal(outbox[kind]!.toEmail, ERASURE_PLACEHOLDER_EMAIL, kind)
  assert.equal(outbox['k-pending']!.status, 'FAILED', 'a waiting email is cancelled, not sent to an erased subject')
  assert.equal(outbox['k-parked']!.status, 'FAILED')
  assert.equal(outbox['k-sent']!.status, 'SENT')
  assert.equal(outbox['k-processing']!.toEmail, ERASURE_PLACEHOLDER_EMAIL, 'a claimed row has its address replaced in place')
  assert.equal(outbox['k-processing']!.status, 'PROCESSING', 'and keeps its status and claim, so the sender\'s own fenced terminal write still lands')
  assert.equal(outbox['k-processing']!.lockedBy, 'claim-token')

  const notes = await db.notification.findMany({ where: { actionUrl: { in: [`/sales/${fx.orderId}`, '/sales/someone-else'] } } })
  assert.equal(notes.find((n) => n.actionUrl === `/sales/${fx.orderId}`)!.message.includes(NAME.last), false)
  assert.equal(notes.find((n) => n.actionUrl === '/sales/someone-else')!.title, 'Unrelated', 'only this order\'s notifications are redacted')

  // EARLIER ACTIVITY ROWS are scrubbed in place (kept, not deleted), and a row with no identity is untouched.
  const early = Object.fromEntries((await db.activityLog.findMany({ where: { id: { startsWith: 'pre-' }, entityId: { in: [fx.orderId, fx.customerId] } } })).map((r) => [r.id.split('-')[1], r]))
  assert.equal(Object.keys(early).length, 4, 'no earlier row was deleted')
  assert.equal(early.created!.description.includes(NAME.last), false)
  assert.equal(early.legacy!.description.includes(NAME.last), false)
  assert.equal(JSON.stringify(early.order!.metadata).includes(EMAIL), false)
  assert.equal(early.order!.description.includes(PHONE), false)
  assert.deepEqual(early.marker!.metadata, { connector: 'woocommerce', externalOrderId: String(fx.externalId) }, 'an accounting marker with no identity is unchanged')
  assert.equal(early.marker!.description, 'Refund park recovered')

  // THE PROOF names no one: not in description, not in metadata, not anywhere in the activity log.
  const logs = await db.activityLog.findMany({ select: { description: true, metadata: true, action: true, entityId: true } })
  const haystack = logs.map((l) => `${l.description}\n${JSON.stringify(l.metadata)}`).join('\n')
  for (const s of PERSONAL_STRINGS) assert.ok(!haystack.includes(s), `no activity-log row may contain ${JSON.stringify(s)}`)
  const record = logs.find((l) => l.action === ERASURE_RECORD_ACTION && l.entityId === fx.customerId)
  assert.ok(record, 'the erasure record was written')
  const meta = record.metadata as { requestId: string; orderIds: string[]; counts: Record<string, number>; systems: Record<string, string> }
  assert.deepEqual(meta.orderIds, [fx.orderId])
  assert.equal(meta.counts.salesOrders, 1)
  assert.equal(meta.counts.outboxRowsClaimedFenced, 1)
  assert.ok(meta.counts.activityRowsScrubbed >= 3, 'earlier activity rows were scrubbed')
  assert.deepEqual(Object.values(meta.systems), ['not-attempted', 'not-attempted', 'not-attempted', 'not-attempted'])

  // IDEMPOTENT: a second request refuses and writes nothing more.
  const recordsBefore = logs.filter((l) => l.action === ERASURE_RECORD_ACTION).length
  const again = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.deepEqual(again, { success: false, error: 'Customer already anonymised' })
  assert.equal((await db.activityLog.count({ where: { action: ERASURE_RECORD_ACTION } })), recordsBefore)

  // RE-POPULATION: the SAME payload, by the update path and by the full import. WooCommerce still holds the original.
  const { importWcOrder, updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  await updateExistingWcOrderFromPayload(fx.orderId, payload(fx.externalId, wcRateId) as never)
  await importWcOrder(payload(fx.externalId, wcRateId) as never)
  const after = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.deepEqual([after.customerName, after.customerEmail, after.customerVatNumber, after.billingAddress, after.shippingAddress, after.notes], ['GDPR Anonymised', null, null, null, null, null])
  assert.equal((await db.shoppingOrderLink.findFirstOrThrow({ where: { orderId: fx.orderId } })).metadata, null, 'the order key does not come back')
  assert.equal(await db.customer.count({ where: { id: fx.customerId, email: { not: null } } }), 0)

  // CONTROL, so the guard is what stopped it: the same delivery on an order that is NOT erased does write identity.
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: null } })
  await updateExistingWcOrderFromPayload(fx.orderId, payload(fx.externalId, wcRateId) as never)
  const control = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(control.customerVatNumber, VAT, 'without the marker the update path writes the VAT number back')
  assert.match(JSON.stringify(control.billingAddress), new RegExp(STREET))

  // A NEW ORDER from the storefront account that was erased is not re-attached to the anonymised customer.
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const externalCustomerId = 700_000_000 + Math.floor(Math.random() * 90_000_000)
  await db.shoppingCustomerLink.create({ data: { connector: 'woocommerce', customerId: fx.customerId, externalCustomerId: String(externalCustomerId) } })
  const returning = { ...payload(fx.externalId + 1, wcRateId), customer_id: externalCustomerId } as never
  assert.equal(await upsertCustomer(returning), null, 'an anonymised customer is never matched for a new order')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).firstName, 'GDPR')

  assert.equal(net.calls(), 0, 'no fetch was made by the erasure or the importer')
})

test('[erasure] the importer takes the order lock BEFORE it reads the marker: an import racing an erasure is wholly before or wholly after it', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)

  // Make the stored address recognisably different from the payload's, so "written back" is observable.
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { customerVatNumber: 'STORED-VAT', billingAddress: { line1: 'stored street' } } })

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const holder = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await gate
    // The erasure's marker, committed under the lock the importer is queued behind.
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: new Date() } })
  }, { timeout: 30_000 })

  await new Promise((r) => setTimeout(r, 200))
  let importDone = false
  const importing = updateExistingWcOrderFromPayload(fx.orderId, payload(fx.externalId, wcRateId) as never).then(() => { importDone = true })
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(importDone, false, 'the import is waiting on the order lock, so it cannot have read the marker yet')
  release()
  await holder
  await importing

  const row = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.equal(row.customerVatNumber, 'STORED-VAT', 'the import read the marker AFTER the erasure committed and withheld the identity columns')
  assert.deepEqual(row.billingAddress, { line1: 'stored street' })
})

test('[erasure] the reconcile pass cancels unsent mail and erases the address on rows that appear for an erased order', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileErasedEmailOutbox } = await import('@/lib/domain/erasure/reconcile-email-outbox')
  const { ERASURE_PLACEHOLDER_EMAIL } = await import('@/lib/domain/erasure/erasure-record')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  // A row queued from a stale read AFTER the erasure committed, and a claimed one that regained its address.
  const late = await db.emailOutbox.create({ data: { kind: 'k-late', toEmail: EMAIL, subject: 's', html: 'queued', referenceType: 'SalesOrder', referenceId: fx.orderId, status: 'PENDING' } })
  const claimed = await db.emailOutbox.create({ data: { kind: 'k-late-claimed', toEmail: EMAIL, subject: 's', html: 'queued', referenceType: 'SalesOrder', referenceId: fx.orderId, status: 'PROCESSING', lockedBy: 'tok', processingStartedAt: new Date() } })
  const other = await db.emailOutbox.create({ data: { kind: 'k-other', toEmail: 'someone.else@example.test', subject: 's', html: 'queued', referenceType: 'SalesOrder', referenceId: 'not-erased-order', status: 'PENDING' } })
  t.after(async () => { await db.emailOutbox.deleteMany({ where: { id: other.id } }) })
  const result = await reconcileErasedEmailOutbox()
  assert.ok(result.cancelled >= 1)
  const rows = Object.fromEntries((await db.emailOutbox.findMany({ where: { id: { in: [late.id, claimed.id, other.id] } } })).map((r) => [r.id, r]))
  assert.deepEqual([rows[late.id]!.toEmail, rows[late.id]!.status], [ERASURE_PLACEHOLDER_EMAIL, 'FAILED'])
  assert.deepEqual([rows[claimed.id]!.toEmail, rows[claimed.id]!.status, rows[claimed.id]!.lockedBy], [ERASURE_PLACEHOLDER_EMAIL, 'PROCESSING', 'tok'])
  assert.deepEqual([rows[other.id]!.toEmail, rows[other.id]!.status], ['someone.else@example.test', 'PENDING'], 'a row of an order that is not erased is untouched')
  assert.equal((await reconcileErasedEmailOutbox()).addressesErased, 0, 'idempotent')
})

test('[erasure] the record survives the activity-log purge that deletes an ordinary INFO row of the same age', { skip }, async (t) => {
  const db = await loadDb()
  const { purgeExpiredActivityLogs } = await import('@/lib/activity-log-cleanup')
  const { ERASURE_RECORD_ACTION } = await import('@/lib/domain/erasure/erasure-record')
  const stamp = randomUUID()
  const ids = { record: `erec-${stamp}`, control: `ectl-${stamp}` }
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
  t.after(async () => { await db.activityLog.deleteMany({ where: { id: { in: Object.values(ids) } } }) })
  for (const [id, action] of [[ids.record, ERASURE_RECORD_ACTION], [ids.control, 'erasure_test_ordinary_info']] as const) {
    await db.$executeRawUnsafe(
      `INSERT INTO "activity_logs" (id, "entityType", "entityId", action, tag, level, description, metadata, "createdAt")
       VALUES ($1, 'CUSTOMER'::"ActivityEntityType", $2, $3, 'sales', 'INFO'::"ActivityLogLevel", 'probe', '{}'::jsonb, $4::timestamptz AT TIME ZONE 'UTC')`,
      id, `probe-${stamp}`, action, old.toISOString(),
    )
  }
  await purgeExpiredActivityLogs()
  const left = new Set((await db.activityLog.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true } })).map((r) => r.id))
  assert.ok(left.has(ids.record), 'the erasure record survives a purge 400 days on')
  assert.ok(!left.has(ids.control), 'an ordinary INFO row of the same age IS deleted by the same run, so the exemption is not the purge being inert')
})


test('[erasure] a customer erased between the importer\'s customer lookup and its order create: the order is created UNLINKED and the erasure is not undone', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => {
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(fx.externalId + 1) }, select: { orderId: true } })
    if (link) {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: link.orderId } })
      await db.activityLog.deleteMany({ where: { entityId: link.orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId: link.orderId } })
      await db.salesOrder.deleteMany({ where: { id: link.orderId } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: link.orderId } })
    }
    await fx.cleanup()
  })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)

  // The erasure holds the customer row lock but has not committed. A SECOND order from the same person (matched by email)
  // is imported now: its customer lookup runs, finds the not-yet-erased row, and the create transaction blocks on the lock.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const erasing = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${fx.customerId} FOR UPDATE`
    await gate
    await tx.customer.update({ where: { id: fx.customerId }, data: { gdprAnonymisedAt: new Date(), firstName: 'GDPR', lastName: 'Anonymised', email: null } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 200))
  let done = false
  const importing = importWcOrder(payload(fx.externalId + 1, wcRateId) as never).then((r) => { done = true; return r })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(done, false, 'the create transaction is waiting on the customer row lock')
  release()
  await erasing
  const result = await importing
  assert.equal(result.success, true, JSON.stringify(result))

  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(fx.externalId + 1) }, select: { orderId: true } })
  const created = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.equal(created.customerId, null, 'the new order is NOT attached to the erased customer')
  const recorded = await db.activityLog.findFirst({ where: { entityId: link.orderId, action: 'order_created_unlinked_customer_erased' } })
  assert.ok(recorded, 'and the decision is recorded')
  assert.ok(!JSON.stringify(recorded).includes(NAME.last) && !JSON.stringify(recorded).includes(EMAIL), 'the record names no one')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).firstName, 'GDPR')
})

test('[erasure] the accounting payload copy: unsent rows get the placeholder, ledger rows keep the name but lose the email, financial fields stay; the post gate sends the placeholder', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { resolveSalesPostContact } = await import('@/lib/domain/erasure/accounting-contact')
  const body = (extra: object = {}) => ({ contactName: FULL_NAME, contactEmail: EMAIL, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }], ...extra })
  const mk = (status: 'PENDING' | 'FAILED' | 'SYNCED' | 'PROCESSING', type: 'SALES_INVOICE' | 'CREDIT_NOTE', referenceType: string, referenceId: string) =>
    db.accountingSyncLog.create({ data: { type, status, referenceType, referenceId, payload: body() } })
  const pending = await mk('PENDING', 'SALES_INVOICE', 'SalesOrder', fx.orderId)
  const failed = await mk('FAILED', 'SALES_INVOICE', 'SalesOrder', fx.orderId)
  const synced = await mk('SYNCED', 'SALES_INVOICE', 'SalesOrder', fx.orderId)
  const refundPending = await mk('PENDING', 'CREDIT_NOTE', 'SalesOrderRefund', fx.refundId)
  const unrelated = await mk('PENDING', 'SALES_INVOICE', 'SalesOrder', 'not-this-order')
  t.after(async () => { await db.accountingSyncLog.deleteMany({ where: { id: { in: [pending.id, failed.id, synced.id, refundPending.id, unrelated.id] } } }) })

  assert.deepEqual(await resolveSalesPostContact('SalesOrder', fx.orderId, body()), { contactName: FULL_NAME, contactEmail: EMAIL }, 'before the erasure the gate passes the stored contact')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)

  const rows = Object.fromEntries((await db.accountingSyncLog.findMany({ where: { id: { in: [pending.id, failed.id, synced.id, refundPending.id, unrelated.id] } } })).map((r) => [r.id, r.payload as Record<string, unknown>]))
  for (const id of [pending.id, failed.id, refundPending.id]) {
    assert.equal(rows[id]!.contactName, 'GDPR Anonymised', 'an unsent row names only the placeholder')
    assert.equal('contactEmail' in rows[id]!, false)
    assert.deepEqual(rows[id]!.lines, body().lines, 'financial fields are untouched')
    assert.equal(rows[id]!.date, '2026-11-02')
  }
  assert.equal(rows[synced.id]!.contactName, FULL_NAME, 'a row already in the ledger keeps the contact name it was posted under')
  assert.equal('contactEmail' in rows[synced.id]!, false, 'but not the email, which is not part of the posted document')
  assert.deepEqual(rows[unrelated.id], body(), 'another order\'s row is untouched')

  // THE POST GATE, whatever the payload says.
  assert.deepEqual(await resolveSalesPostContact('SalesOrder', fx.orderId, body()), { contactName: 'GDPR Anonymised', contactEmail: undefined })
  assert.deepEqual(await resolveSalesPostContact('SalesOrderRefund', fx.refundId, body()), { contactName: 'GDPR Anonymised', contactEmail: undefined })
  assert.deepEqual(await resolveSalesPostContact('SalesOrder', 'not-this-order', body()), { contactName: FULL_NAME, contactEmail: EMAIL }, 'an order that does not exist or is not erased passes its stored contact')
})

test('[erasure] notes and shipment tracking edits on an erased order are refused under the order lock and log nothing about the number', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { updateSalesOrderNotes } = await import('@/app/actions/sales')
  const { updateShipmentTracking } = await import('@/app/actions/allocation')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const shipment = await db.shipment.findFirstOrThrow({ where: { orderId: fx.orderId } })
  await db.shipment.update({ where: { id: shipment.id }, data: { status: 'SHIPPED' } })

  // CONTROL: before the erasure both edits work, so the refusals below are the guard.
  assert.deepEqual(await updateSalesOrderNotes(fx.orderId, 'a note', 'an internal note'), { success: true })
  const editBefore = await updateShipmentTracking(shipment.id, { trackingNumber: 'EDIT-BEFORE' })
  assert.equal(editBefore.success, true, JSON.stringify(editBefore))
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).trackingNumber, 'EDIT-BEFORE')

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)

  const notes = await updateSalesOrderNotes(fx.orderId, 'Mrs Quillfeather again', 'rang about it')
  assert.equal(notes.success, false)
  const tracking = await updateShipmentTracking(shipment.id, { trackingNumber: 'EDIT-AFTER-ERASURE' })
  assert.equal(tracking.success, false)
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.deepEqual([order.notes, order.internalNotes, order.trackingNumber], [null, null, null])
  assert.equal((await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).trackingNumber, null)
  const leaked = JSON.stringify(await db.activityLog.findMany({ where: { entityId: fx.orderId } }))
  assert.ok(!leaked.includes('EDIT-AFTER-ERASURE') && !leaked.includes('EDIT-BEFORE'), 'no activity row carries a tracking number (the earlier one was scrubbed)')
})
