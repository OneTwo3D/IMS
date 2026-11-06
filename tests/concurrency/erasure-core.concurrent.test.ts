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
// Scripts the mail transport double (see mockActionEnvironment).
let mailerImpl: ((message: { to: string }) => Promise<Record<string, unknown>>) | null = null
// When set, the Mintsoft connector double returns these records from pollReturns.
let pollReturnsRecords: (() => Array<Record<string, unknown>>) | null = null
// Runs after upsertCustomer has returned (inside importWcOrder), before the order is created.
let afterUpsertCustomer: (() => Promise<void>) | null = null
// Runs after an email action has read the order's address and before it enqueues.
let afterAddressRead: (() => Promise<void>) | null = null
// Runs inside logActivityInTransaction, before the row is written (see mockActionEnvironment).
let beforeActivityWrite: (() => Promise<void>) | null = null
// Runs inside the importer's accounting step: between the order create and the invoice enqueue / hold.
let settingsHook: (() => Promise<void>) | null = null
// The accounting queue double: by default it records nothing; a test that needs the real row installs a writer.
type QueueArgs = { type: string; referenceType: string; referenceId: string; payload: Record<string, unknown>; idempotencyKey?: string }
let queueImpl: (tx: unknown, args: QueueArgs) => Promise<unknown> = async () => ({ queued: true, connector: 'xero' })
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => { await settingsHook?.(); return { connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' } },
      queueAccountingSync: async () => ({ queued: true }),
      // The held-invoice release enqueues inside its order-locked transaction.
      queueAccountingSyncTxWithOutcome: async (tx: unknown, args: QueueArgs) => queueImpl(tx, args),
    },
  })
  accountingMocked = true
}

let actionsMocked = false
async function mockActionEnvironment() {
  if (actionsMocked) return
  const actual = await import('@/lib/auth/server')
  // Every `require*` guard answers with an admin session; nothing else in the module changes.
  const session = { user: { id: undefined as unknown as string, role: 'ADMIN', name: 'Test Admin', email: 'admin@example.test' } } // no user row exists in the scratch database: activity rows take a null user
  const guards = Object.fromEntries(Object.keys(actual).filter((k) => k.startsWith('require')).map((k) => [k, async () => session]))
  mock.module('@/lib/auth/server', { namedExports: { ...actual, ...guards } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
  // The warehouse registry, with ONE seam: when a test sets `pollReturnsRecords` the Mintsoft connector is a double whose poll returns those
  // records. No other behaviour changes and nothing here can reach the warehouse.
  const registry = await import('@/lib/connectors/wms/registry')
  mock.module('@/lib/connectors/wms/registry', { namedExports: { ...registry, getWmsConnector: (id: never) => (pollReturnsRecords && (id as string) === 'mintsoft' ? { pollReturns: async () => pollReturnsRecords!() } : registry.getWmsConnector(id)) } })
  // The mail transport double: no SMTP is ever contacted. A test sets `mailerImpl` to script the answer.
  const mailer = await import('@/lib/mailer')
  mock.module('@/lib/mailer', { namedExports: { ...mailer, sendEmail: async (message: never) => (mailerImpl ? mailerImpl(message) : { success: true }) } })
  // A seam AFTER the importer's customer lookup/link step returned its customer and before the order create transaction starts.
  const fieldMapping = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  mock.module('@/lib/connectors/woocommerce/sync/field-mapping', { namedExports: { ...fieldMapping, upsertCustomer: async (order: never) => { const id = await fieldMapping.upsertCustomer(order); await afterUpsertCustomer?.(); return id } } })
  // A seam between an email action's read of the order address and its enqueue (the read is real; the hook runs after it).
  const orderEmail = await import('@/lib/order-email')
  mock.module('@/lib/order-email', { namedExports: { ...orderEmail, getAccountingInvoiceQueueData: async (orderId: string) => { const data = await orderEmail.getAccountingInvoiceQueueData(orderId); await afterAddressRead?.(); return data } } })
  // A seam to pause an action between its write and its in-transaction activity row (and only there).
  const activity = await import('@/lib/activity-log')
  mock.module('@/lib/activity-log', { namedExports: { ...activity, logActivityInTransaction: async (tx: never, params: never) => { await beforeActivityWrite?.(); return activity.logActivityInTransaction(tx, params) } } })
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

type Fixture = { wooCustomerId: number; orderId: string; customerId: string; externalId: number; warehouseId: string; rateId: string; refundId: string; cleanup(): Promise<void> }

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
  // The storefront account this customer belongs to: the link row (raw storefront customer id + free metadata) and the integer on the customer.
  const wooCustomerId = 600_000_000 + Math.floor(Math.random() * 90_000_000)
  await db.shoppingCustomerLink.create({ data: { connector: 'woocommerce', customerId, externalCustomerId: String(wooCustomerId), metadata: { note: FULL_NAME } } })
  await db.customer.update({ where: { id: customerId }, data: { notes: `Prefers ${FULL_NAME}`, externalCustomerId: wooCustomerId } })

  return {
    wooCustomerId, orderId, customerId, externalId, warehouseId: warehouse.id, rateId: rate.id, refundId: refund.id,
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
  // NO RAW STOREFRONT CUSTOMER ID REMAINS: the link row is gone and the customer's integer is cleared.
  assert.equal(await db.shoppingCustomerLink.count({ where: { OR: [{ customerId: fx.customerId }, { externalCustomerId: String(fx.wooCustomerId) }] } }), 0)
  assert.equal(await db.customer.count({ where: { externalCustomerId: fx.wooCustomerId } }), 0)

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

  // A LATER ORDER FROM THE SAME STOREFRONT ACCOUNT finds no link and no email to match on the erased row, so it gets a FRESH customer.
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const returning = { ...payload(fx.externalId + 1, wcRateId), customer_id: fx.wooCustomerId } as never
  const freshId = await upsertCustomer(returning)
  assert.ok(freshId, 'a customer was created for the returning account')
  t.after(async () => { await db.shoppingCustomerLink.deleteMany({ where: { customerId: freshId! } }); await db.customer.deleteMany({ where: { id: freshId! } }) })
  assert.notEqual(freshId, fx.customerId, 'it is NOT the erased record')
  const fresh = await db.customer.findUniqueOrThrow({ where: { id: freshId! } })
  assert.equal(fresh.gdprAnonymisedAt, null, 'the new record is a normal, unerased customer')
  assert.equal(fresh.firstName, NAME.first, 'the new identity belongs to the new record')
  assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(fx.wooCustomerId), customerId: freshId! } }), 1)
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).firstName, 'GDPR', 'the erased record is untouched')

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

  // A SECOND order from the same person (matched by email). The importer's customer step returns the not-yet-erased customer; THEN
  // (from the seam) an erasure takes the customer row lock and has not committed, and the order create transaction blocks on it.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let erasing: Promise<void> = Promise.resolve()
  afterUpsertCustomer = async () => {
    afterUpsertCustomer = null
    erasing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${fx.customerId} FOR UPDATE`
      await gate
      await tx.customer.update({ where: { id: fx.customerId }, data: { gdprAnonymisedAt: new Date(), firstName: 'GDPR', lastName: 'Anonymised', email: null } })
    }, { timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 300))
  }
  let done = false
  const importing = importWcOrder(payload(fx.externalId + 1, wcRateId) as never).then((r) => { done = true; return r })
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(done, false, 'the create transaction is waiting on the customer row lock')
  release()
  await erasing
  const result = await importing
  assert.equal(result.success, true, JSON.stringify(result))

  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(fx.externalId + 1) }, select: { orderId: true } })
  const created = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.equal(created.customerId, null, 'the new order is NOT attached to the erased customer')
  // EVERY identity column on the new order: it was created ERASED, in the same transaction, with its money intact.
  assert.deepEqual([created.customerName, created.customerEmail, created.customerVatNumber, created.billingAddress, created.shippingAddress, created.notes],
    ['GDPR Anonymised', null, null, null, null, null])
  assert.ok(created.erasedAt, 'the erasure marker is set')
  assert.equal(created.totalForeign.toString(), '126', 'the order and its money stay in the books')
  assert.equal(await db.salesOrderLine.count({ where: { orderId: link.orderId } }), 1)
  assert.equal((await db.shoppingOrderLink.findFirstOrThrow({ where: { orderId: link.orderId } })).metadata, null, 'the storefront order key is not stored')
  const proof = await db.activityLog.findFirst({ where: { entityId: link.orderId, action: 'gdpr_erasure_recorded' } })
  assert.ok(proof, 'the name-free proof record was written as an erasure of this order')
  assert.deepEqual((proof.metadata as { orderIds: string[] }).orderIds, [link.orderId])
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

  assert.deepEqual(await resolveSalesPostContact('SalesOrder', fx.orderId, body()), { ok: true, contactName: FULL_NAME, contactEmail: EMAIL }, 'before the erasure the gate passes the stored contact')
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
  assert.deepEqual(await resolveSalesPostContact('SalesOrder', fx.orderId, body()), { ok: true, contactName: 'GDPR Anonymised', contactEmail: undefined })
  assert.deepEqual(await resolveSalesPostContact('SalesOrderRefund', fx.refundId, body()), { ok: true, contactName: 'GDPR Anonymised', contactEmail: undefined })
  assert.deepEqual(await resolveSalesPostContact('SalesOrder', 'not-this-order', body()), { ok: true, contactName: FULL_NAME, contactEmail: EMAIL }, 'an order that does not exist or is not erased passes its stored contact')
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


test('[erasure] hold, erase, release: the held WooCommerce invoice payload is scrubbed, and a release of a stale unscrubbed hold copies no identity', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { buildHeldSalesInvoicePayload, HELD_SALES_INVOICE_RECORD_KIND } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const queued: string[] = []
  type Tx = { accountingSyncLog: { create(args: unknown): Promise<{ id: string }> } }
  queueImpl = async (tx, args) => {
    const row = await (tx as Tx).accountingSyncLog.create({ data: { type: 'SALES_INVOICE', status: 'PENDING', referenceType: args.referenceType, referenceId: args.referenceId, payload: { ...args.payload, _idempotencyKey: args.idempotencyKey } } })
    queued.push(row.id)
    return { queued: true, connector: 'xero' }
  }
  t.after(async () => {
    queueImpl = async () => ({ queued: true, connector: 'xero' })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: fx.orderId } })
    await db.shoppingSyncLog.deleteMany({ where: { entityId: fx.orderId } })
    await fx.cleanup()
  })
  const contact = { ok: true, contactName: FULL_NAME, contactEmail: EMAIL }
  const park = (accountingPayload: Record<string, unknown>) => buildHeldSalesInvoicePayload({
    externalOrderId: String(fx.externalId), externalOrderNumber: String(fx.externalId), salesOrderId: fx.orderId, orderNumber: 'SO-HELD', metaKey: '_wcpdf_invoice_number',
    accountingPayload: { ...contact, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }], ...accountingPayload }, chartConnector: 'xero',
  })
  const hold = await db.shoppingSyncLog.create({ data: {
    connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: String(fx.externalId),
    recordKind: HELD_SALES_INVOICE_RECORD_KIND, payload: park({}) as never, errorMessage: 'waiting', syncedAt: null,
  } })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const scrubbed = (await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: hold.id } })).payload as { accountingPayload: Record<string, unknown>; reason: string }
  assert.equal(scrubbed.accountingPayload.contactName, 'GDPR Anonymised')
  assert.equal('contactEmail' in scrubbed.accountingPayload, false)
  assert.deepEqual(scrubbed.accountingPayload.lines, [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }], 'financial fields are kept')
  assert.equal(scrubbed.reason, (park({}) as { reason: string }).reason, 'the hold stays releasable: its discriminating reason is untouched')

  // WooCommerce numbers the invoice: the release sweep copies the (scrubbed) hold into a new accounting row.
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { invoiceNumber: 'INV-ERASE-1' } })
  const first = await retryHeldWcSalesInvoiceReleases()
  assert.ok(first.released >= 1, JSON.stringify(first))
  const row1 = await db.accountingSyncLog.findFirstOrThrow({ where: { id: { in: queued } } })
  const text1 = JSON.stringify(row1.payload)
  for (const s of [NAME.first, NAME.last, EMAIL]) assert.ok(!text1.includes(s), `the released row carries ${s}`)
  assert.equal((row1.payload as { invoiceNumber: string }).invoiceNumber, 'INV-ERASE-1')

  // A STALE hold: parked with identity AFTER the erasure's scrub (as a release that read it before the erasure would hold it).
  await db.accountingSyncLog.deleteMany({ where: { id: { in: queued } } })
  queued.length = 0
  await db.shoppingSyncLog.update({ where: { id: hold.id }, data: { status: 'PENDING', payload: park({}) as never, errorMessage: 'waiting' } })
  const second = await retryHeldWcSalesInvoiceReleases()
  assert.ok(second.released >= 1, JSON.stringify(second))
  const row2 = await db.accountingSyncLog.findFirstOrThrow({ where: { id: { in: queued } } })
  const text2 = JSON.stringify(row2.payload)
  for (const s of [NAME.first, NAME.last, EMAIL]) assert.ok(!text2.includes(s), `the release gate let ${s} through`)
  assert.equal((row2.payload as { contactName: string }).contactName, 'GDPR Anonymised')
})

test('[erasure] a customer renamed before the erasure: names from BEFORE the rename are gone from the whole log too (structure, not only current values)', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { updateCustomer } = await import('@/app/actions/customers')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { ERASED_ACTIVITY_DESCRIPTION } = await import('@/lib/domain/erasure/activity-identity')
  const OLD = { first: 'Alicia', last: 'Zephyrine' }, NEW = { first: 'Bartholomew', last: 'Yarrowby' }
  assert.equal((await updateCustomer(fx.customerId, { firstName: OLD.first, lastName: OLD.last })).success, true)
  assert.equal((await updateCustomer(fx.customerId, { firstName: NEW.first, lastName: NEW.last })).success, true)
  // PRECONDITION: the log really holds both names, or "gone" proves nothing.
  const before = JSON.stringify(await db.activityLog.findMany({ where: { entityId: fx.customerId } }))
  assert.ok(before.includes(OLD.first) && before.includes(NEW.first))

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const haystack = JSON.stringify(await db.activityLog.findMany())
  for (const s of [OLD.first, OLD.last, NEW.first, NEW.last, NAME.first, NAME.last]) assert.ok(!haystack.includes(s), `the activity log still contains ${s}`)
  const rows = await db.activityLog.findMany({ where: { entityId: fx.customerId, entityType: 'CUSTOMER', action: 'updated' } })
  assert.equal(rows.length, 2, 'the rows are kept')
  for (const r of rows) assert.equal(r.description, ERASED_ACTIVITY_DESCRIPTION)
})


test('[erasure] release races: an erasure committing between the hold read and the release is seen under the order lock; a failure inside the release rolls everything back and the hold stays pending', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { buildHeldSalesInvoicePayload, HELD_SALES_INVOICE_RECORD_KIND } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const queued: string[] = []
  let failAfterInsert = false
  type Tx = { accountingSyncLog: { create(args: unknown): Promise<{ id: string }> } }
  queueImpl = async (tx, args) => {
    const row = await (tx as Tx).accountingSyncLog.create({ data: { type: 'SALES_INVOICE', status: 'PENDING', referenceType: args.referenceType, referenceId: args.referenceId, payload: { ...args.payload, _idempotencyKey: args.idempotencyKey } } })
    queued.push(row.id)
    if (failAfterInsert) throw new Error('injected failure after the insert')
    return { queued: true, connector: 'xero' }
  }
  t.after(async () => {
    queueImpl = async () => ({ queued: true, connector: 'xero' })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: fx.orderId } })
    await db.shoppingSyncLog.deleteMany({ where: { entityId: fx.orderId } })
    await fx.cleanup()
  })
  const held = buildHeldSalesInvoicePayload({
    externalOrderId: String(fx.externalId), externalOrderNumber: String(fx.externalId), salesOrderId: fx.orderId, orderNumber: 'SO-RACE', metaKey: '_wcpdf_invoice_number',
    accountingPayload: { contactName: FULL_NAME, contactEmail: EMAIL, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }] }, chartConnector: 'xero',
  })
  const hold = await db.shoppingSyncLog.create({ data: {
    connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: String(fx.externalId),
    recordKind: HELD_SALES_INVOICE_RECORD_KIND, payload: held as never, errorMessage: 'waiting', syncedAt: null,
  } })
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { invoiceNumber: 'INV-RACE-1' } })

  // (1) FAILURE INJECTION: the insert succeeds and then the release throws. Nothing may remain, and the hold is still pending.
  failAfterInsert = true
  const failed = await retryHeldWcSalesInvoiceReleases()
  assert.equal(failed.released, 0, JSON.stringify(failed))
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: fx.orderId, type: 'SALES_INVOICE' } }), 0, 'the insert was rolled back with the rest of the release')
  assert.equal((await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: hold.id } })).status, 'PENDING', 'the hold stays pending, to be retried')
  failAfterInsert = false

  // (2) THE RACE: the release has read the hold (identity intact) and is waiting on the order lock when an erasure commits.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const erasing = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await gate
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: new Date() } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 200))
  queued.length = 0
  let done = false
  const releasing = retryHeldWcSalesInvoiceReleases().then((r) => { done = true; return r })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(done, false, 'the release is waiting on the order lock')
  release()
  await erasing
  const outcome = await releasing
  assert.ok(outcome.released >= 1, JSON.stringify(outcome))
  const row = await db.accountingSyncLog.findFirstOrThrow({ where: { id: { in: queued } } })
  const text = JSON.stringify(row.payload)
  for (const x of [NAME.first, NAME.last, EMAIL]) assert.ok(!text.includes(x), `the released row carries ${x}`)
  assert.equal((row.payload as { contactName: string }).contactName, 'GDPR Anonymised')
  assert.deepEqual((row.payload as { lines: unknown }).lines, held.accountingPayload.lines, 'financial fields are kept')
})

test('[erasure] the production push port re-reads the order under the lock: an erasure after the sweep loaded it is visible at the push boundary', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { createPrismaWmsOrderPushPort, ORDER_PUSH_SELECT } = await import('@/lib/domain/wms/order-push-sweep')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const port = createPrismaWmsOrderPushPort()
  const loaded = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId }, select: ORDER_PUSH_SELECT })
  assert.equal(loaded.erasedAt, null)
  assert.equal(loaded.customerEmail, EMAIL)
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const fresh = await port.reloadOrderForPush!(fx.orderId)
  assert.ok(fresh?.erasedAt, 'the boundary read sees the erasure the earlier read did not')
  assert.equal(fresh?.customerEmail, null)
  assert.equal(fresh?.customerName, 'GDPR Anonymised')
})


const manualOrder = (customerId: string | undefined, name: string) => ({
  customerId, customerName: name, customerEmail: 'new.person@example.test', currency: 'GBP', isDraft: true,
  // A free-text line with no catalogue product, which the action accepts at runtime.
  lines: [{ sku: `MAN-${randomUUID().slice(0, 8)}`, description: 'Manual widget', qty: 1, unitPriceForeign: 10 }] as never,
})

test('[erasure] a manual order cannot be created for, or cloned from, an erased customer; and a create racing the erasure ends consistent in BOTH commit orders', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const created: string[] = []
  t.after(async () => {
    for (const id of created) {
      await db.activityLog.deleteMany({ where: { entityId: id } })
      await db.salesOrderLine.deleteMany({ where: { orderId: id } })
      await db.salesOrder.deleteMany({ where: { id } })
    }
    await fx.cleanup()
  })
  const { createSalesOrder, cloneSalesOrder } = await import('@/app/actions/sales')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { ANONYMISED_CUSTOMER_LINK_REFUSAL } = await import('@/lib/domain/erasure/customer-link')

  // CONTROL: before the erasure the same call works, so the refusals below are the guard and not the fixture.
  const ok = await createSalesOrder(manualOrder(fx.customerId, 'Control Person'))
  assert.equal(ok.success, true, JSON.stringify(ok))
  created.push(ok.order!.id)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: ok.order!.id } })).customerId, fx.customerId)

  // ORDER 1: the erasure commits first. The create waits on the customer row lock, then refuses.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const erasing = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${fx.customerId} FOR UPDATE`
    await gate
    await tx.customer.update({ where: { id: fx.customerId }, data: { gdprAnonymisedAt: new Date(), firstName: 'GDPR', lastName: 'Anonymised', email: null } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 200))
  const before = await db.salesOrder.count({ where: { customerName: 'Raced Person' } })
  let done = false
  const racing = createSalesOrder(manualOrder(fx.customerId, 'Raced Person')).then((r) => { done = true; return r })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(done, false, 'the create is waiting on the customer row lock')
  release()
  await erasing
  const refused = await racing
  assert.deepEqual(refused, { success: false, error: ANONYMISED_CUSTOMER_LINK_REFUSAL })
  assert.equal(await db.salesOrder.count({ where: { customerName: 'Raced Person' } }), before, 'no order was created')

  // A DIRECT create on the now-erased customer is refused the same way, and so is a clone of one of its orders.
  assert.deepEqual(await createSalesOrder(manualOrder(fx.customerId, 'Direct Person')), { success: false, error: ANONYMISED_CUSTOMER_LINK_REFUSAL })
  const cloned = await cloneSalesOrder(ok.order!.id)
  assert.equal(cloned.success, false)
  assert.equal(cloned.error, ANONYMISED_CUSTOMER_LINK_REFUSAL)
  assert.equal(await db.salesOrder.count({ where: { customerName: 'Direct Person' } }), 0)

  // ORDER 2: the create commits first. An order inserted under the customer lock (what the create does) is found and erased by the
  // erasure that was queued behind it.
  const fx2 = await importFixture(db)
  t.after(async () => { await fx2.cleanup() })
  let release2!: () => void
  const gate2 = new Promise<void>((resolve) => { release2 = resolve })
  let newOrderId = ''
  const creating = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${fx2.customerId} FOR UPDATE`
    await gate2
    const order = await tx.salesOrder.create({ data: { orderNumber: `RACE-${randomUUID().slice(0, 8)}`, status: 'DRAFT', currency: 'GBP', customerId: fx2.customerId, customerName: 'Late Person', customerEmail: 'late@example.test', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } })
    newOrderId = order.id
    created.push(order.id)
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 200))
  let erased = false
  const erasure = eraseCustomerPersonalData(fx2.customerId, { trigger: 'ON_REQUEST', userId: null }).then((r) => { erased = true; return r })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(erased, false, 'the erasure is queued behind the create\'s customer lock')
  release2()
  await creating
  assert.equal((await erasure).success, true)
  const late = await db.salesOrder.findUniqueOrThrow({ where: { id: newOrderId } })
  assert.deepEqual([late.customerName, late.customerEmail], ['GDPR Anonymised', null], 'the order that committed first was found and erased')
  assert.ok(late.erasedAt)
})


test('[erasure] erasure committing between the order create and the invoice enqueue / hold: the queued row and the hold contain no identity', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const queued: string[] = []
  type Tx = { accountingSyncLog: { create(args: unknown): Promise<{ id: string }> } }
  queueImpl = async (tx, args) => {
    const row = await (tx as Tx).accountingSyncLog.create({ data: { type: 'SALES_INVOICE', status: 'PENDING', referenceType: args.referenceType, referenceId: args.referenceId, payload: { ...args.payload, _idempotencyKey: args.idempotencyKey } } })
    queued.push(row.id)
    return { queued: true, connector: 'xero' }
  }
  const extraOrders: string[] = []
  t.after(async () => {
    settingsHook = null
    queueImpl = async () => ({ queued: true, connector: 'xero' })
    for (const id of extraOrders) {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
      await db.shoppingSyncLog.deleteMany({ where: { entityId: id } })
      await db.activityLog.deleteMany({ where: { entityId: id } })
      await db.salesOrderLine.deleteMany({ where: { orderId: id } })
      await db.salesOrder.deleteMany({ where: { id } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: id } })
    }
    await fx.cleanup()
  })
  const withNumber = (id: number, number: string | null) => {
    const body = payload(id, wcRateId) as { meta_data: Array<{ id: number; key: string; value: unknown }> }
    return number === null ? body : { ...body, meta_data: [...body.meta_data, { id: 77, key: '_wcpdf_invoice_number', value: number }] }
  }
  const erasedBy = async (customerId: string) => { assert.equal((await eraseCustomerPersonalData(customerId, { trigger: 'ON_REQUEST', userId: null })).success, true) }

  // (A) a NUMBERED order: the invoice is enqueued. The erasure commits after the order exists and before the enqueue.
  settingsHook = async () => { settingsHook = null; await erasedBy(fx.customerId) }
  const numberedId = fx.externalId + 11
  const first = await importWcOrder(withNumber(numberedId, 'INV-RACE-77') as never)
  assert.equal(first.success, true, JSON.stringify(first))
  const numbered = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(numberedId) }, select: { orderId: true } })
  extraOrders.push(numbered.orderId)
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: numbered.orderId } })).erasedAt, 'PRECONDITION: the erasure really did reach the new order')
  const row = await db.accountingSyncLog.findFirstOrThrow({ where: { id: { in: queued } } })
  const text = JSON.stringify(row.payload)
  for (const x of [NAME.first, NAME.last, EMAIL]) assert.ok(!text.includes(x), `the queued invoice carries ${x}`)
  assert.equal((row.payload as { contactName: string }).contactName, 'GDPR Anonymised')
  assert.equal((row.payload as { invoiceNumber: string }).invoiceNumber, 'INV-RACE-77')

  // (B) an UNNUMBERED order: the invoice is parked. Same window, same answer. (A fresh customer: the first one is erased now.)
  const fx2 = await importFixture(db)
  t.after(async () => { await fx2.cleanup() })
  settingsHook = async () => { settingsHook = null; await erasedBy(fx2.customerId) }
  const heldId = fx2.externalId + 12
  const second = await importWcOrder({ ...withNumber(heldId, null), billing: { ...WC_ADDRESS }, shipping: { ...WC_ADDRESS } } as never)
  assert.equal(second.success, true, JSON.stringify(second))
  const held = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(heldId) }, select: { orderId: true } })
  extraOrders.push(held.orderId)
  const hold = await db.shoppingSyncLog.findFirstOrThrow({ where: { entityId: held.orderId, recordKind: 'WC_HELD_SALES_INVOICE' } })
  const holdText = JSON.stringify(hold.payload)
  for (const x of [NAME.first, NAME.last, EMAIL]) assert.ok(!holdText.includes(x), `the parked hold carries ${x}: ${holdText.slice(Math.max(0, holdText.indexOf(x) - 80), holdText.indexOf(x) + 80)}`)
  assert.equal((hold.payload as { accountingPayload: { contactName: string } }).accountingPayload.contactName, 'GDPR Anonymised')
})


test('[erasure] the central gate: any accounting sync row for an erased order or refund is written with the placeholder contact, whoever queues it; a live order keeps its contact', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { createAccountingSyncLogRow } = await import('@/lib/domain/accounting/sync-log-row')
  const made: string[] = []
  t.after(async () => { await db.accountingSyncLog.deleteMany({ where: { id: { in: made } } }); await fx.cleanup() })
  const write = async (type: 'SALES_INVOICE' | 'CREDIT_NOTE', referenceType: string, referenceId: string) => {
    const result = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx as never, {
      type, referenceType, referenceId, status: 'PENDING', payload: { contactName: FULL_NAME, contactEmail: EMAIL, date: '2026-11-02', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }], _idempotencyKey: `gate-${randomUUID()}` },
    } as never))
    const row = result.row as { id: string } | null
    assert.ok(row, 'the row was written')
    made.push(row.id)
    return (await db.accountingSyncLog.findUniqueOrThrow({ where: { id: row.id } })).payload as Record<string, unknown>
  }
  // CONTROL: a live order keeps its contact (the gate is not scrubbing everything).
  assert.equal((await write('SALES_INVOICE', 'SalesOrder', fx.orderId)).contactName, FULL_NAME)
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  for (const [type, ref, id] of [['SALES_INVOICE', 'SalesOrder', fx.orderId], ['CREDIT_NOTE', 'SalesOrderRefund', fx.refundId]] as const) {
    const payload = await write(type, ref, id)
    assert.equal(payload.contactName, 'GDPR Anonymised', `${ref}`)
    assert.equal('contactEmail' in payload, false)
    assert.deepEqual(payload.lines, [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }], 'financial fields kept')
  }
})


test('[erasure] a customer edit and its name-bearing activity row commit together: an erasure started just before the activity write blocks on the customer lock, then finds and scrubs the row', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { beforeActivityWrite = null; await fx.cleanup() })
  const { updateCustomer, createCustomer } = await import('@/app/actions/customers')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { ERASED_ACTIVITY_DESCRIPTION } = await import('@/lib/domain/erasure/activity-identity')
  const NEWNAME = { first: 'Philomena', last: 'Ravenscroft' }
  let erasure: Promise<{ success: boolean }> | null = null
  let erasureDoneDuringPause = false
  beforeActivityWrite = async () => {
    beforeActivityWrite = null
    // The update has run and holds the customer row lock; the activity row is NOT yet written. Start the erasure now.
    erasure = eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null }).then((r) => { erasureDoneDuringPause = true; return r })
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal(erasureDoneDuringPause, false, 'the erasure is blocked on the customer lock until the edit and its activity row commit')
  }
  const result = await updateCustomer(fx.customerId, { firstName: NEWNAME.first, lastName: NEWNAME.last })
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal((await erasure!).success, true)
  const haystack = JSON.stringify(await db.activityLog.findMany())
  for (const x of [NEWNAME.first, NEWNAME.last]) assert.ok(!haystack.includes(x), `the activity log still contains ${x}`)
  const row = await db.activityLog.findFirstOrThrow({ where: { entityId: fx.customerId, action: 'updated' } })
  assert.equal(row.description, ERASED_ACTIVITY_DESCRIPTION, 'the row existed when the erasure ran, and was scrubbed')

  // The other order: the erasure commits first, the edit changes nothing and writes no row.
  const after = await updateCustomer(fx.customerId, { firstName: 'Late', lastName: 'Edit' })
  assert.equal(after.success, false)
  assert.equal(await db.activityLog.count({ where: { entityId: fx.customerId, action: 'updated', description: { contains: 'Late' } } }), 0)

  // Create: the row and its activity record are one transaction too.
  const made = await createCustomer({ firstName: 'Cordelia', lastName: 'Thistlewood' } as never)
  assert.equal(made.success, true, JSON.stringify(made))
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: made.customer!.id } }); await db.customer.deleteMany({ where: { id: made.customer!.id } }) })
  assert.equal(await db.activityLog.count({ where: { entityId: made.customer!.id, action: 'created' } }), 1)
})


test('[erasure] an email enqueue racing the erasure: paused after the address read, the erasure completes, the insert resumes: refused, no row holds the address', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { afterAddressRead = null; await fx.cleanup() })
  const { sendAccountingInvoiceEmailInternal } = await import('@/lib/accounting-email')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { invoicePdfPath: `uploads/invoices/${fx.orderId}.pdf`, invoiceNumber: 'INV-MAIL-1' } })
  await db.emailOutbox.deleteMany({ where: { referenceId: fx.orderId, kind: 'ACCOUNTING_INVOICE' } })

  // CONTROL: with no erasure in between, the same call queues a row addressed to the customer.
  const control = await sendAccountingInvoiceEmailInternal(fx.orderId)
  assert.equal(control.success, true, JSON.stringify(control))
  assert.equal(await db.emailOutbox.count({ where: { referenceId: fx.orderId, kind: 'ACCOUNTING_INVOICE', toEmail: EMAIL } }), 1, 'the control queued a row with the address')
  await db.emailOutbox.deleteMany({ where: { referenceId: fx.orderId, kind: 'ACCOUNTING_INVOICE' } })

  // THE RACE: paused after the address read, the erasure runs to completion, then the insert resumes.
  afterAddressRead = async () => {
    afterAddressRead = null
    assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  }
  const result = await sendAccountingInvoiceEmailInternal(fx.orderId)
  assert.equal(result.success, false, 'the enqueue was refused')
  assert.equal(await db.emailOutbox.count({ where: { referenceId: fx.orderId, kind: 'ACCOUNTING_INVOICE' } }), 0, 'nothing was written')
  assert.equal(await db.emailOutbox.count({ where: { toEmail: EMAIL } }), 0, 'no outbox row anywhere holds the address')
})


test('[erasure] a CANCELLED accounting row PROVEN never posted is scrubbed like an unsent one; a cancelled row with any posting evidence keeps its ledger name', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const body = () => ({ contactName: FULL_NAME, contactEmail: EMAIL, date: '2026-11-02', currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200' }] })
  const mk = (extra: Record<string, unknown>) => db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', status: 'CANCELLED', referenceType: 'SalesOrder', referenceId: fx.orderId, payload: body(), ...extra } as never })
  // An unclaimed invoice cancelled before it was ever attempted, with the proof stamp the cancelling writers record.
  const proven = await mk({ abandonedBeforeRemoteCall: true, attemptRevision: 0 })
  // CONTROLS, each with one piece of posting evidence (or the absence of the proof):
  const withId = await mk({ abandonedBeforeRemoteCall: true, externalTransactionId: 'XERO-INV-1' })
  const attempted = await mk({ abandonedBeforeRemoteCall: true, remoteAttemptedAt: new Date('2026-11-02T10:00:00Z') })
  const claimed = await mk({ abandonedBeforeRemoteCall: true, attemptRevision: 2 })
  const unproven = await mk({ abandonedBeforeRemoteCall: null, attemptRevision: 0 })
  const ids = [proven.id, withId.id, attempted.id, claimed.id, unproven.id]
  t.after(async () => { await db.accountingSyncLog.deleteMany({ where: { id: { in: ids } } }); await fx.cleanup() })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const rows = Object.fromEntries((await db.accountingSyncLog.findMany({ where: { id: { in: ids } } })).map((r) => [r.id, r.payload as Record<string, unknown>]))
  assert.equal(rows[proven.id]!.contactName, 'GDPR Anonymised', 'a row proven never posted is not a ledger record: its name is scrubbed')
  assert.equal('contactEmail' in rows[proven.id]!, false)
  assert.deepEqual(rows[proven.id]!.lines, body().lines, 'financial fields are kept')
  for (const row of [withId, attempted, claimed, unproven]) {
    assert.equal(rows[row.id]!.contactName, FULL_NAME, `posting evidence keeps the ledger name (${JSON.stringify({ id: row.externalTransactionId, at: row.remoteAttemptedAt, rev: row.attemptRevision, ab: row.abandonedBeforeRemoteCall })})`)
    assert.equal('contactEmail' in rows[row.id]!, false, 'but the email, which is not part of the posted document, is removed')
  }
})


test('[erasure] the importer paused between the customer lookup and the link insert while an erasure commits: no link lands on the erased row, and a fresh customer gets it', { skip }, async (t) => {
  const db = await loadDb()
  const { upsertCustomer } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const email = `link.race+${randomUUID().slice(0, 8)}@example.test`
  const wooId = 500_000_000 + Math.floor(Math.random() * 90_000_000)
  // A live customer with NO storefront link yet (the case where the importer writes one).
  const target = await db.customer.create({ data: { firstName: 'Linus', lastName: 'Raceway', email } })
  let fresh: string | null = null
  t.after(async () => {
    const ids = [target.id, ...(fresh ? [fresh] : [])]
    await db.shoppingCustomerLink.deleteMany({ where: { customerId: { in: ids } } })
    await db.customer.deleteMany({ where: { id: { in: ids } } })
  })
  const order = { ...payload(1, 1), customer_id: wooId, billing: { ...WC_ADDRESS, email }, shipping: { ...WC_ADDRESS } } as never

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const erasing = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${target.id} FOR UPDATE`
    await gate
    // What the erasure commits: the row is anonymised and loses its email.
    await tx.customer.update({ where: { id: target.id }, data: { gdprAnonymisedAt: new Date(), firstName: 'GDPR', lastName: 'Anonymised', email: null } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 200))
  let done = false
  const importing = upsertCustomer(order).then((id) => { done = true; return id })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(done, false, 'PRECONDITION: the importer found the (not yet erased) customer and is waiting on its row lock before the link insert')
  release()
  await erasing
  fresh = await importing
  assert.ok(fresh)
  assert.notEqual(fresh, target.id, 'a FRESH customer was created, not the erased record')
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: target.id } }), 0, 'no link, and so no raw storefront id, landed on the erased row')
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: fresh, externalCustomerId: String(wooId) } }), 1, 'the fresh customer holds the link')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fresh } })).gdprAnonymisedAt, null)

  // CONTROL: with no erasure in the window, the link is written to the matched live customer.
  const live = await db.customer.create({ data: { firstName: 'Lively', lastName: 'Control', email: `live+${randomUUID().slice(0, 8)}@example.test` } })
  t.after(async () => { await db.shoppingCustomerLink.deleteMany({ where: { customerId: live.id } }); await db.customer.deleteMany({ where: { id: live.id } }) })
  const wooId2 = wooId + 1
  const matched = await upsertCustomer({ ...payload(2, 1), customer_id: wooId2, billing: { ...WC_ADDRESS, email: live.email! }, shipping: { ...WC_ADDRESS } } as never)
  assert.equal(matched, live.id)
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: live.id, externalCustomerId: String(wooId2) } }), 1)
})


test('[erasure] payments: existing free-text notes are erased and the reference is kept; a payment recorded after the erasure still posts, with no free text', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { addPayment } = await import('@/app/actions/sales')
  const { WC_RECEIPT_NOTE_PAID_LATER, WC_RECEIPT_NOTE_IMPORTED_PAID } = await import('@/lib/domain/erasure/order-state')
  const SYSTEM_NOTE = WC_RECEIPT_NOTE_PAID_LATER
  const mk = (data: Record<string, unknown>) => db.payment.create({ data: { orderId: fx.orderId, amount: 10, currency: 'GBP', paidAt: new Date('2026-11-02T10:00:00Z'), ...data } as never })
  const operator = await mk({ reference: 'BANK-REF-1', method: 'Bank Transfer', notes: `${NAME.first} phoned to say the transfer was sent` })
  const system = await mk({ reference: 'TXN-77', notes: SYSTEM_NOTE })
  // A person's note that merely STARTS with an importer sentence and then names the customer: free text, not the importer's.
  const spoofed = await mk({ reference: 'BANK-REF-3', notes: `${WC_RECEIPT_NOTE_IMPORTED_PAID}: ${FULL_NAME}, ${STREET}` })
  const spoofedLater = await mk({ reference: 'BANK-REF-4', notes: `Recorded from WooCommerce - ${NAME.last} rang` })
  t.after(async () => { await db.payment.deleteMany({ where: { orderId: fx.orderId } }); await db.accountingSyncLog.deleteMany({ where: { referenceId: fx.orderId } }); await fx.cleanup() })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const rows = Object.fromEntries((await db.payment.findMany({ where: { id: { in: [operator.id, system.id, spoofed.id, spoofedLater.id] } } })).map((p) => [p.id, p]))
  assert.equal(rows[operator.id]!.notes, null, 'the operator\'s free-text note is erased')
  assert.equal(rows[operator.id]!.reference, 'BANK-REF-1', 'the reference reconciles with the bank and is kept')
  assert.equal(rows[operator.id]!.amount.toString(), '10', 'the payment itself is untouched')
  assert.equal(rows[system.id]!.notes, SYSTEM_NOTE, 'the importer\'s own fixed sentence is kept: the importer recognises its earlier receipts by it')
  assert.equal(rows[spoofed.id]!.notes, null, 'a note that only STARTS with an importer sentence is erased')
  assert.equal(rows[spoofedLater.id]!.notes, null)
  // The importer still recognises its own receipt: the predicate it dedups on (notes starting with the receipt prefix) finds the exact
  // sentence that survived, and nothing else.
  const dedup = await db.payment.findMany({ where: { orderId: fx.orderId, refundId: null, notes: { startsWith: 'Recorded from WooCommerce' } } })
  assert.deepEqual(dedup.map((p) => p.id), [system.id])

  // A payment recorded AFTER the erasure: it posts, with the reference and amount, and no free text.
  const after = await addPayment({ orderId: fx.orderId, amount: 5, currency: 'GBP', method: 'Bank Transfer', reference: 'BANK-REF-2', notes: `${NAME.last} says this is for the second parcel`, paidAt: '2026-11-05' })
  assert.equal(after.success, true, JSON.stringify(after))
  const late = await db.payment.findFirstOrThrow({ where: { orderId: fx.orderId, reference: 'BANK-REF-2' } })
  assert.equal(late.notes, null, 'the free-text note is dropped for an erased order')
  const lateSpoof = await addPayment({ orderId: fx.orderId, amount: 3, currency: 'GBP', reference: 'BANK-REF-5', notes: `${WC_RECEIPT_NOTE_IMPORTED_PAID} - ${FULL_NAME}, ${STREET}`, paidAt: '2026-11-05' })
  assert.equal(lateSpoof.success, true, JSON.stringify(lateSpoof))
  assert.equal((await db.payment.findFirstOrThrow({ where: { orderId: fx.orderId, reference: 'BANK-REF-5' } })).notes, null, 'prefix plus personal text is dropped too')
  const exact = await addPayment({ orderId: fx.orderId, amount: 2, currency: 'GBP', reference: 'BANK-REF-6', notes: WC_RECEIPT_NOTE_IMPORTED_PAID, paidAt: '2026-11-05' })
  assert.equal(exact.success, true, JSON.stringify(exact))
  assert.equal((await db.payment.findFirstOrThrow({ where: { orderId: fx.orderId, reference: 'BANK-REF-6' } })).notes, WC_RECEIPT_NOTE_IMPORTED_PAID, 'an exact importer sentence is the only thing that passes')
  assert.equal(late.amount.toString(), '5', 'the money recorded')
})

test('[erasure] free text on the rows hanging off the orders is CLEARED, not matched: an OLD address that no longer matches the order goes too, structured columns stay', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData, ERASED_FREE_TEXT_MARKER } = await import('@/lib/domain/erasure/erase-personal-data')
  // The delivery details these rows mention are NOT the order's current ones (the person moved and changed their name since).
  const OLD = { name: 'Octavia Formerly', street: '9 Former Road', postcode: 'OLD1 1XX' }
  const link = await db.wmsOrderPushLink.create({ data: { orderId: fx.orderId, connector: 'mintsoft', externalOrderId: 'WMS-1', externalOrderNumber: 'WMS-NO-1', lastError: `Address ${OLD.street}, ${OLD.postcode} rejected for ${OLD.name}`, dispatchLastError: `No courier for ${OLD.name}`, dispatchUnresolvedError: `Unresolved: ${OLD.street}` } as never })
  const disc = await db.wmsOrderDiscrepancy.create({ data: { orderId: fx.orderId, connector: 'mintsoft', category: 'ADDRESS', detail: `Warehouse has ${OLD.name} at ${OLD.street}`, externalOrderNumber: 'WMS-NO-1' } as never })
  const ret = await db.wmsReturnsInbox.create({ data: { orderId: fx.orderId, connector: 'mintsoft', externalReturnId: `RET-${randomUUID().slice(0, 6)}`, sku: 'SKU-1', reference: 'SO-REF-1', reason: `${OLD.name} did not like it`, resolutionNote: `Refunded ${OLD.name}`, rawPayload: { returnId: 'R1', customer: { name: OLD.name }, note: `from ${OLD.postcode}`, items: [{ sku: 'SKU-1', qty: 1 }] } } as never })
  const emptyLink = await db.wmsOrderPushLink.create({ data: { orderId: (await db.salesOrder.create({ data: { orderNumber: `NOLINK-${randomUUID().slice(0, 6)}`, status: 'DRAFT', currency: 'GBP', customerId: fx.customerId, subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 } })).id, connector: 'mintsoft' } as never })
  t.after(async () => { await db.wmsReturnsInbox.deleteMany({ where: { id: ret.id } }); await db.wmsOrderDiscrepancy.deleteMany({ where: { id: disc.id } }); await db.wmsOrderPushLink.deleteMany({ where: { id: { in: [link.id, emptyLink.id] } } }); await db.salesOrder.deleteMany({ where: { id: emptyLink.orderId } }); await fx.cleanup() })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const kept = await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
  assert.deepEqual([kept.lastError, kept.dispatchLastError, kept.dispatchUnresolvedError], [ERASED_FREE_TEXT_MARKER, ERASED_FREE_TEXT_MARKER, ERASED_FREE_TEXT_MARKER], 'free text is cleared whatever it said')
  assert.deepEqual([kept.externalOrderId, kept.externalOrderNumber], ['WMS-1', 'WMS-NO-1'], 'the references that reconcile with the warehouse are kept')
  const keptDisc = await db.wmsOrderDiscrepancy.findUniqueOrThrow({ where: { id: disc.id } })
  assert.deepEqual([keptDisc.detail, keptDisc.category, keptDisc.externalOrderNumber], [ERASED_FREE_TEXT_MARKER, 'ADDRESS', 'WMS-NO-1'])
  const keptRet = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: ret.id } })
  assert.deepEqual([keptRet.reason, keptRet.resolutionNote, keptRet.rawPayload], [ERASED_FREE_TEXT_MARKER, ERASED_FREE_TEXT_MARKER, {}])
  assert.deepEqual([keptRet.sku, keptRet.reference, keptRet.externalReturnId.startsWith('RET-')], ['SKU-1', 'SO-REF-1', true], 'structured columns are kept')
  // A column that had no text stays empty (the marker is written only where there was a value).
  const untouched = await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: emptyLink.id } })
  assert.deepEqual([untouched.lastError, untouched.dispatchLastError, untouched.dispatchUnresolvedError], [null, null, null])
  const everything = JSON.stringify([kept, keptDisc, keptRet])
  for (const x of [OLD.name, OLD.street, OLD.postcode]) assert.ok(!everything.includes(x), `the rows still hold ${x}`)
})

test('[erasure] an order edit racing the erasure: the identity sources are read AFTER the locks, so the edited value does not survive in any scrubbed field', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const EDITED = { name: 'Valentina Lastminute', street: '31 Eleventh Hour Close', postcode: 'ZZ9 9ZZ' }
  t.after(async () => { await fx.cleanup() })

  // An edit is IN FLIGHT: it holds the order lock, has changed the order's delivery details, and has written an activity row that
  // mentions the NEW details. The erasure starts now and must wait for it.
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const editing = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { customerName: EDITED.name, shippingAddress: { line1: EDITED.street, postcode: EDITED.postcode } } })
    await tx.activityLog.create({ data: { entityType: 'SALES_ORDER', entityId: fx.orderId, action: 'noted', tag: 'sales', level: 'INFO', description: `Now delivering to ${EDITED.name}, ${EDITED.street} ${EDITED.postcode}`, metadata: { who: EDITED.name } } })
    await gate
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 300))
  let erased = false
  const erasing = eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null }).then((r) => { erased = true; return r })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(erased, false, 'PRECONDITION: the erasure is waiting on the edit\'s order lock')
  release()
  await editing
  assert.equal((await erasing).success, true)

  const log = JSON.stringify(await db.activityLog.findMany({ where: { entityId: { in: [fx.orderId, fx.customerId] } } }))
  for (const x of [EDITED.name, EDITED.street, EDITED.postcode]) assert.ok(!log.includes(x), `the edited value ${x} survived in the activity rows`)
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.deepEqual([order.customerName, order.shippingAddress], ['GDPR Anonymised', null])
})

test('[erasure] a large customer (300 orders, 2000 activity rows, payments, warehouse links) erases in one transaction well inside its timeout, and the proof commits', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData, ERASURE_TRANSACTION_OPTIONS } = await import('@/lib/domain/erasure/erase-personal-data')
  const ORDERS = 300
  const tag = randomUUID().slice(0, 8)
  const orderRows = Array.from({ length: ORDERS }, (_, i) => ({
    id: `big-${tag}-${i}`, orderNumber: `BIG-${tag}-${i}`, status: 'DRAFT' as const, currency: 'GBP', customerId: fx.customerId,
    customerName: FULL_NAME, customerEmail: EMAIL, billingAddress: { line1: STREET, postcode: POSTCODE }, notes: `Leave with ${NAME.last} next door`,
    subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1,
  }))
  await db.salesOrder.createMany({ data: orderRows as never })
  const ids = orderRows.map((o) => o.id)
  await db.payment.createMany({ data: ids.map((orderId, i) => ({ orderId, amount: 1, currency: 'GBP', paidAt: new Date('2026-11-02T10:00:00Z'), reference: `REF-${tag}-${i}`, notes: `${NAME.first} paid by phone` })) as never })
  await db.wmsOrderPushLink.createMany({ data: ids.map((orderId, i) => ({ orderId, connector: 'mintsoft', externalOrderId: `W-${tag}-${i}`, lastError: `Rejected ${STREET} for ${FULL_NAME}` })) as never })
  const entityIds = [fx.customerId, ...ids]
  await db.activityLog.createMany({
    data: Array.from({ length: 2000 }, (_, i) => ({
      id: `bigal-${tag}-${i}`, entityType: i % 7 === 0 ? 'CUSTOMER' : 'SALES_ORDER', entityId: entityIds[i % entityIds.length]!, action: 'noted', tag: 'sales',
      description: i % 2 === 0 ? `Phoned ${FULL_NAME} about ${STREET}` : `Operational note ${i}`,
      metadata: i % 3 === 0 ? { contact: { email: EMAIL }, ref: `r${i}` } : { ref: `r${i}` },
    })) as never,
  })
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { id: { startsWith: `bigal-${tag}` } } })
    await db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
    await db.payment.deleteMany({ where: { orderId: { in: ids } } })
    await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: ids } } })
    await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
    await fx.cleanup()
  })

  const started = Date.now()
  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  const elapsed = Date.now() - started
  assert.equal(result.success, true, JSON.stringify(result))
  console.log(`# large erasure: ${ORDERS + 1} orders, 2000 activity rows, ${elapsed} ms (timeout ${ERASURE_TRANSACTION_OPTIONS.timeout} ms)`)
  assert.ok(elapsed < 30_000, `the erasure took ${elapsed} ms; it must finish far inside its ${ERASURE_TRANSACTION_OPTIONS.timeout} ms timeout`)

  // The proof committed with everything else, and names every order.
  const proof = await db.activityLog.findFirstOrThrow({ where: { entityId: fx.customerId, action: 'gdpr_erasure_recorded' } })
  const meta = proof.metadata as { orderIds: string[]; counts: Record<string, number> }
  assert.equal(meta.orderIds.length, ORDERS + 1)
  assert.equal(meta.counts.salesOrders, ORDERS + 1)
  assert.ok(meta.counts.activityRowsScrubbed >= 1000, `activity rows scrubbed: ${meta.counts.activityRowsScrubbed}`)
  assert.equal(meta.counts.paymentNotesErased >= ORDERS, true)
  // Nothing personal remains on any of it.
  assert.equal(await db.salesOrder.count({ where: { customerId: fx.customerId, erasedAt: null } }), 0)
  const rows = JSON.stringify(await db.activityLog.findMany({ where: { OR: [{ id: { startsWith: `bigal-${tag}` } }, { entityId: { in: entityIds } }] } }))
  for (const x of [NAME.first, NAME.last, EMAIL, STREET, POSTCODE]) assert.ok(!rows.includes(x), `activity rows still hold ${x}`)
  const links = JSON.stringify(await db.wmsOrderPushLink.findMany({ where: { orderId: { in: ids } } }))
  assert.ok(!links.includes(NAME.last) && !links.includes(STREET), 'warehouse link errors were scrubbed')
  assert.equal(await db.payment.count({ where: { orderId: { in: ids }, notes: { not: null } } }), 0)
  assert.equal(await db.payment.count({ where: { orderId: { in: ids }, reference: { startsWith: `REF-${tag}` } } }), ORDERS, 'every payment reference is kept')
})


test('[erasure] the returns sync never reads the warehouse\'s free text back into an erased order\'s return: racing the erasure, and on a redelivery with no order reference', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { runMintsoftReturnsSync } = await import('@/lib/connectors/mintsoft/sync/returns-sync')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const uid = randomUUID().slice(0, 8)
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `ret-${uid}`, active: true }, select: { id: true } })
  const binding = await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: fx.warehouseId, connector: 'mintsoft', externalWarehouseId: `ext-${uid}`, active: true, returnsMode: 'POLL' } as never, select: { id: true } })
  const returnIds: string[] = []
  const record = (externalReturnId: string, over: Record<string, unknown> = {}) => ({
    externalReturnId, externalWarehouseId: `ext-${uid}`, sku: 'SKU-RET', qty: 1, orderReference: String(fx.externalId), reason: `${NAME.first} ${NAME.last} says it arrived broken`,
    receivedAt: '2026-11-04T10:00:00.000Z', raw: { Customer: { Name: FULL_NAME }, Note: `Collect from ${STREET}`, Lines: [{ SKU: 'SKU-RET', Qty: 1 }] }, ...over,
  })
  t.after(async () => {
    pollReturnsRecords = null
    await db.wmsReturnsInbox.deleteMany({ where: { externalReturnId: { in: returnIds } } })
    await db.externalWmsBinding.deleteMany({ where: { id: binding.id } })
    await db.wmsConnection.deleteMany({ where: { id: connection.id } })
    await fx.cleanup()
  })
  const inbox = (id: string) => db.wmsReturnsInbox.findUniqueOrThrow({ where: { connector_externalReturnId: { connector: 'mintsoft', externalReturnId: id } } })

  // (c) CONTROL, not erased: the delivery resolves the order and stores the warehouse's text and payload; a redelivery with no reference
  // keeps the established link (an unresolved delivery never clears it) and, the order not being erased, still writes the text.
  const live = `RET-LIVE-${uid}`; returnIds.push(live)
  pollReturnsRecords = () => [record(live)]
  await runMintsoftReturnsSync('test')
  const first = await inbox(live)
  assert.equal(first.orderId, fx.orderId)
  assert.ok(first.reason?.includes(NAME.last), 'not erased: the reason is stored')
  assert.ok(JSON.stringify(first.rawPayload).includes(STREET), 'not erased: the raw payload is stored')
  pollReturnsRecords = () => [record(live, { orderReference: null, reason: 'updated reason text' })]
  await runMintsoftReturnsSync('test')
  const again = await inbox(live)
  assert.equal(again.orderId, fx.orderId, 'an unresolved redelivery keeps the established link')
  assert.equal(again.reason, 'updated reason text')

  // (a) RACE: an erasure is in progress and holds the order lock; the sync waits on it, then sees the marker and writes no free text.
  const racing = `RET-RACE-${uid}`; returnIds.push(racing)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const erasing = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await gate
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: new Date() } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 300))
  const raceMark = new Date()
  pollReturnsRecords = () => [record(racing)]
  let syncDone = false
  const syncing = runMintsoftReturnsSync('test').then(() => { syncDone = true })
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(syncDone, false, 'PRECONDITION: the sync is waiting on the order lock')
  release()
  await erasing
  await syncing
  const raced = await inbox(racing)
  assert.equal(raced.orderId, fx.orderId, 'the structured link is recorded')
  assert.equal(raced.reason, null, 'no free text was read back')
  assert.deepEqual(raced.rawPayload, {}, 'no raw payload was read back')

  // The earlier row for this (now erased) order is cleared by the real erasure; undo the manual marker so the erasure can run.
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: null } })
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  assert.equal((await inbox(live)).reason, 'Text removed by GDPR erasure')

  const erasedAtMark = new Date()
  // (b) REDELIVERY with a missing order reference, for a return already linked to an ERASED order: the link is kept and no text is written.
  pollReturnsRecords = () => [record(live, { orderReference: null, reason: `${NAME.last} wrote this later`, raw: { Customer: { Name: FULL_NAME } } })]
  await runMintsoftReturnsSync('test')
  const redelivered = await inbox(live)
  assert.equal(redelivered.orderId, fx.orderId, 'the established link is preserved, never nulled')
  assert.equal(redelivered.reason, null, 'and no reason is written over a row linked to an erased order')
  assert.deepEqual(redelivered.rawPayload, {})
  assert.ok(!JSON.stringify(redelivered).includes(NAME.last) && !JSON.stringify(redelivered).includes(STREET))

  // THE SYNC LOG: a row written for a return of the erased order carries no raw payload, on success and on error alike.
  pollReturnsRecords = () => [record(live, { orderReference: null }), record(`RET-ERR-${uid}`, { qty: 'not-a-number' })]
  returnIds.push(`RET-ERR-${uid}`)
  await runMintsoftReturnsSync('test')
  const logsAfter = await db.wmsSyncLog.findMany({ where: { createdAt: { gt: erasedAtMark } } })
  assert.ok(logsAfter.length >= 2, 'PRECONDITION: the sync wrote log rows after the erasure (a success row and an error row)')
  assert.ok(logsAfter.some((l) => l.action === 'error'), 'the error row was written')
  for (const row of logsAfter) {
    assert.ok(!JSON.stringify(row).includes(NAME.last) && !JSON.stringify(row).includes(STREET) && !JSON.stringify(row).includes(NAME.first), `a post-erasure sync log row carries the warehouse payload: ${row.action}`)
  }
  // A MALFORMED quantity that contains the person's details makes the parser's message echo them: the error row's REASON must not.
  const echoed = `RET-ECHO-${uid}`; returnIds.push(echoed)
  const echoMark = new Date()
  pollReturnsRecords = () => [record(echoed, { qty: `${FULL_NAME}, ${STREET}, ${POSTCODE}` })]
  await runMintsoftReturnsSync('test')
  const echoRows = await db.wmsSyncLog.findMany({ where: { createdAt: { gt: echoMark }, action: 'error' } })
  assert.ok(echoRows.length >= 1, 'PRECONDITION: the malformed quantity produced an error row')
  for (const row of echoRows) {
    assert.match(String(row.reason), /^Return rejected: \w+$/, 'a fixed identity-free line naming only the error class')
    assert.ok(!JSON.stringify(row).includes(NAME.last) && !JSON.stringify(row).includes(STREET) && !JSON.stringify(row).includes(POSTCODE), 'neither the reason nor the payload carries the value')
  }
  // The racing delivery above (order lock held, erasure committing) wrote its log row under the lock too: no payload.
  const raceLogs = await db.wmsSyncLog.findMany({ where: { createdAt: { gt: raceMark, lt: erasedAtMark } } })
  assert.ok(raceLogs.length >= 1, 'PRECONDITION: the racing delivery wrote a log row')
  for (const row of raceLogs) assert.ok(!JSON.stringify(row).includes(STREET) && !JSON.stringify(row).includes(NAME.last), 'the racing row carries no payload')
  // CONTROL: the rows written BEFORE the erasure, for the live order, did carry the payload (so the check above is not vacuous).
  assert.ok((await db.wmsSyncLog.findMany({ where: { createdAt: { lt: erasedAtMark } } })).some((l) => JSON.stringify(l.payload).includes(STREET)), 'control: a pre-erasure log row carries the payload')

  // THE MUTATION EVENTS of the return hold the marker, not the reason.
  const events = await db.wmsMutationEvent.findMany({ where: { entityType: 'RETURN', action: 'return_inbox', entityId: redelivered.id } })
  assert.ok(events.length >= 2)
  for (const event of events) {
    const after = event.after as { reason?: string | null } | null
    assert.ok(after?.reason === null || after?.reason === 'Text removed by GDPR erasure', `event reason: ${JSON.stringify(after?.reason)}`)
    assert.ok(!JSON.stringify(event).includes(NAME.last))
  }
  assert.ok(events.some((e) => (e.after as { reason?: string | null }).reason === 'Text removed by GDPR erasure'), 'an event that held a reason now holds the marker')
})


test('[erasure] suppression rows and mail-server text: erasure deletes the subject\'s suppression rows and clears lastError on the order\'s outbox rows, in any status', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData, ERASED_FREE_TEXT_MARKER } = await import('@/lib/domain/erasure/erase-personal-data')
  const other = `unrelated+${randomUUID().slice(0, 8)}@example.test`
  await db.emailSuppression.create({ data: { email: EMAIL, reason: `550 5.1.1 <${EMAIL}> user unknown`, source: 'smtp' } })
  await db.emailSuppression.create({ data: { email: other, reason: `550 <${other}> user unknown`, source: 'smtp' } })
  await db.emailOutbox.updateMany({ where: { referenceId: fx.orderId }, data: { lastError: `550 5.1.1 <${EMAIL}> user unknown` } })
  t.after(async () => { await db.emailSuppression.deleteMany({ where: { email: { in: [EMAIL, other] } } }); await fx.cleanup() })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  assert.equal(await db.emailSuppression.count({ where: { email: EMAIL } }), 0, 'the subject\'s suppression row (address and raw server text) is deleted')
  assert.equal(await db.emailSuppression.count({ where: { email: other } }), 1, 'another address is untouched')
  const rows = await db.emailOutbox.findMany({ where: { referenceId: fx.orderId } })
  assert.ok(rows.length >= 4)
  for (const row of rows) {
    assert.ok(row.lastError === ERASED_FREE_TEXT_MARKER || row.lastError === 'Cancelled: the recipient\'s personal data was erased', `lastError on a ${row.status} row: ${row.lastError}`)
    assert.ok(!JSON.stringify(row).includes(EMAIL))
  }
  assert.ok(rows.some((r) => r.status === 'PROCESSING' && r.lockedBy === 'claim-token'), 'a claimed row keeps its claim')
})

test('[erasure] an invalid-recipient answer completing while the erasure holds the order lock writes no suppression row and no address; the same answer for a live order does (control)', { skip }, async (t) => {
  const db = await loadDb()
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const fx = await importFixture(db)
  const liveTo = `control+${randomUUID().slice(0, 8)}@example.test`
  const erasedTo = `target+${randomUUID().slice(0, 8)}@example.test`
  const mk = (orderId: string, toEmail: string) => db.emailOutbox.create({ data: { kind: 'UNKNOWN_KIND', toEmail, subject: 'x', html: 'queued', referenceType: 'SalesOrder', referenceId: orderId, status: 'PENDING' } })
  t.after(async () => {
    mailerImpl = null
    await db.emailSuppression.deleteMany({ where: { email: { in: [liveTo, erasedTo] } } })
    await fx.cleanup()
  })
  const invalid = async (message: { to: string }) => ({ success: false, permanent: true, invalidRecipient: true, error: `550 5.1.1 <${message.to}> user unknown` })

  // CONTROL: a live order's invalid recipient is suppressed, with the server's text.
  await db.emailOutbox.deleteMany({ where: { status: 'PENDING' } })
  await mk(fx.orderId, liveTo)
  mailerImpl = invalid
  await processPendingEmailOutbox()
  assert.equal(await db.emailSuppression.count({ where: { email: liveTo } }), 1, 'control: a live order\'s bounce is suppressed')
  assert.match((await db.emailOutbox.findFirstOrThrow({ where: { toEmail: liveTo } })).lastError ?? '', /user unknown/)

  // RACE: the erasure holds the order lock; the bounce completes meanwhile and must wait, then see the marker.
  await db.emailOutbox.deleteMany({ where: { status: 'PENDING' } })
  const row = await mk(fx.orderId, erasedTo)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const erasing = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await gate
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: new Date() } })
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 300))
  mailerImpl = invalid
  let drained = false
  const draining = processPendingEmailOutbox().then(() => { drained = true })
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(drained, false, 'PRECONDITION: the drain is waiting on the order lock to write the bounce outcome')
  release()
  await erasing
  await draining
  assert.equal(await db.emailSuppression.count({ where: { email: erasedTo } }), 0, 'no suppression row for an erased order\'s address')
  const after = await db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })
  assert.equal(after.status, 'FAILED')
  assert.equal(after.toEmail, 'erased@erased.invalid')
  assert.ok(!JSON.stringify(after).includes(erasedTo), 'no row holds the address or the server text that echoes it')
})
