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
// Runs when the importer's customer step is entered, inside the ORDER-CREATE TRANSACTION and before the customer is looked up.
// The tracking each fulfilment update was asked to record (see the completion test). The real function still runs.
const fulfilmentTracking: Array<unknown[]> = []
// When set, the WooCommerce REST read the erasure sweep makes is answered by this double (GET params recorded); otherwise the real one runs.
let wcFetchImpl: ((path: string, params: Record<string, string>) => Promise<{ data: unknown; totalPages: number; totalItems: number; error?: string }>) | null = null
// Runs after the customer step returned, still inside the order-create transaction: a hook that throws fails the whole transaction.
let afterUpsertCustomerInTx: (() => Promise<void>) | null = null
// Makes the sweep's mirror step throw for an order id (a mirror ERROR, as opposed to a read error).
let failMirrorFor: ((id: number | string) => boolean) | null = null
let beforeUpsertCustomer: (() => Promise<void>) | null = null
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
  mock.module('@/lib/connectors/woocommerce/sync/field-mapping', { namedExports: { ...fieldMapping, upsertCustomer: async (order: never, client?: never) => { await beforeUpsertCustomer?.(); const id = await fieldMapping.upsertCustomer(order, client); await afterUpsertCustomerInTx?.(); return id } } })
  // A seam between an email action's read of the order address and its enqueue (the read is real; the hook runs after it).
  const orderEmail = await import('@/lib/order-email')
  mock.module('@/lib/order-email', { namedExports: { ...orderEmail, getAccountingInvoiceQueueData: async (orderId: string) => { const data = await orderEmail.getAccountingInvoiceQueueData(orderId); await afterAddressRead?.(); return data } } })
  // A seam to pause an action between its write and its in-transaction activity row (and only there).
  const activity = await import('@/lib/activity-log')
  mock.module('@/lib/activity-log', { namedExports: { ...activity, logActivityInTransaction: async (tx: never, params: never) => { await beforeActivityWrite?.(); return activity.logActivityInTransaction(tx, params) } } })
  const mirrorModule = await import('@/lib/connectors/woocommerce/sync/anonymisation-mirror')
  mock.module('@/lib/connectors/woocommerce/sync/anonymisation-mirror', { namedExports: { ...mirrorModule, mirrorWcAnonymisationIfHeld: async (o: { id: number | string }) => { if (failMirrorFor?.(o.id)) throw new Error('injected mirror failure'); return mirrorModule.mirrorWcAnonymisationIfHeld(o as never) } } })
  const wcApi = await import('@/lib/connectors/woocommerce/api')
  mock.module('@/lib/connectors/woocommerce/api', { namedExports: { ...wcApi, wcFetch: (path: string, params: Record<string, string> = {}, ...rest: never[]) => (wcFetchImpl ? wcFetchImpl(path, params) : (wcApi.wcFetch as (...a: unknown[]) => unknown)(path, params, ...rest)) } })
  const fulfilment = await import('@/lib/fulfillment/external-fulfillment')
  mock.module('@/lib/fulfillment/external-fulfillment', { namedExports: { ...fulfilment, applyExternalFulfillmentUpdate: async (args: { tracking?: unknown[] }) => { fulfilmentTracking.push(args.tracking ?? []); return fulfilment.applyExternalFulfillmentUpdate(args as never) } } })
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

  // A SECOND order from the same person (matched by email). The customer step now runs INSIDE the order-create transaction: on entering it (the
  // seam) an erasure takes the customer row lock and has not committed; the step finds the still-live customer, then blocks on that lock, and
  // re-reads the customer as erased once the erasure commits.
  // The customer's ORIGINAL erasure proof (as an earlier erasure would have written it).
  const ORIGINAL_REQUEST_ID = `orig-request-${randomUUID()}`
  await db.activityLog.create({ data: { entityType: 'CUSTOMER', entityId: fx.customerId, action: 'gdpr_erasure_recorded', description: 'Personal data erased', tag: 'sales', level: 'INFO', metadata: { requestId: ORIGINAL_REQUEST_ID, trigger: 'ON_REQUEST' } } as never })
  t.after(async () => { await db.activityLog.deleteMany({ where: { entityId: fx.customerId } }) })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let erasing: Promise<void> = Promise.resolve()
  beforeUpsertCustomer = async () => {
    beforeUpsertCustomer = null
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
  assert.equal(done, false, 'the create transaction is waiting on the customer row lock (taken inside its customer step)')
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
  assert.equal((proof.metadata as { requestId: string }).requestId, ORIGINAL_REQUEST_ID, 'the record carries the customer\'s ORIGINAL erasure request id')
  assert.equal((proof.metadata as { trigger: string }).trigger, 'IMPORT_AFTER_ERASURE', 'and a distinct trigger')
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
  // The sync LOG no longer copies the raw warehouse record for ANY order (only the return id); the inbox row above keeps it for review.
  const returnLogs = await db.wmsSyncLog.findMany({ where: { sku: 'SKU-RET', job: { type: 'RETURNS_SYNC' } } })
  assert.ok(returnLogs.length > 0, 'PRECONDITION: the sync wrote a log row')
  assert.ok(returnLogs.every((l) => !JSON.stringify(l.payload).includes(STREET) && !JSON.stringify(l.payload).includes(NAME.last)), 'no raw warehouse record in the sync log')
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
  // CONTROL: rows written BEFORE the erasure exist, and (the raw record is no longer copied into the log; the erasure also clears the return id they carry) none holds the value.
  const preLogs = await db.wmsSyncLog.findMany({ where: { createdAt: { lt: erasedAtMark } } })
  assert.ok(preLogs.length > 0 && preLogs.every((l) => !JSON.stringify(l.payload).includes(STREET)), 'control: pre-erasure log rows exist and hold no raw record')

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


test('[erasure] the free-text guard: raw connector text is stored for a live order, cleared by the erasure, and can no longer be written back, whoever writes it, before, during and after', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { eraseCustomerPersonalData, ERASED_FREE_TEXT_MARKER } = await import('@/lib/domain/erasure/erase-personal-data')
  const { GUARDED_FREE_TEXT } = await import('@/lib/domain/erasure/free-text-guard')
  const RAW = `Connector said: cannot deliver to ${FULL_NAME}, ${STREET}, ${POSTCODE}`
  const retNo = `RET-GUARD-${randomUUID().slice(0, 6)}`
  t.after(async () => {
    await db.wmsReturnsInbox.deleteMany({ where: { orderId: fx.orderId } }); await db.wmsOrderDiscrepancy.deleteMany({ where: { orderId: fx.orderId } })
    await db.wmsOrderPushLink.deleteMany({ where: { orderId: fx.orderId } }); await db.wmsOrderStatusSnapshot.deleteMany({ where: { orderId: fx.orderId } })
    await db.payment.deleteMany({ where: { orderId: fx.orderId } }); await fx.cleanup()
  })
  const snapshot = await db.wmsOrderStatusSnapshot.update({ where: { orderId: fx.orderId }, data: { lastError: RAW } })
  const link = await db.wmsOrderPushLink.create({ data: { orderId: fx.orderId, connector: 'mintsoft', lastError: RAW, dispatchLastError: RAW, dispatchUnresolvedError: RAW } as never })
  const disc = await db.wmsOrderDiscrepancy.create({ data: { orderId: fx.orderId, connector: 'mintsoft', category: 'ADDRESS', detail: RAW } as never })
  const inbox = await db.wmsReturnsInbox.create({ data: { orderId: fx.orderId, connector: 'mintsoft', externalReturnId: retNo, reason: RAW, resolutionNote: RAW, rawPayload: { who: FULL_NAME } } as never })
  await db.salesOrderRefund.update({ where: { id: fx.refundId }, data: { accountingWarning: RAW } })
  const note = await db.payment.create({ data: { orderId: fx.orderId, amount: 1, currency: 'GBP', paidAt: new Date('2026-11-02T10:00:00Z'), reference: 'GUARD-REF', notes: RAW } as never })
  const read = async () => ({
    snapshot: (await db.wmsOrderStatusSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).lastError,
    link: await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id }, select: { lastError: true, dispatchLastError: true, dispatchUnresolvedError: true } }),
    disc: (await db.wmsOrderDiscrepancy.findUniqueOrThrow({ where: { id: disc.id } })).detail,
    inbox: await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: inbox.id }, select: { reason: true, resolutionNote: true, rawPayload: true } }),
    refund: (await db.salesOrderRefund.findUniqueOrThrow({ where: { id: fx.refundId } })).accountingWarning,
    payment: (await db.payment.findUniqueOrThrow({ where: { id: note.id } })).notes,
  })

  // BEFORE: a LIVE order stores the raw text (the guard does not touch it) ...
  const before = await read()
  assert.deepEqual([before.snapshot, before.link.lastError, before.disc, before.inbox.reason, before.refund, before.payment], [RAW, RAW, RAW, RAW, RAW, RAW], 'a live order keeps its connector text')
  // ... and the erasure clears all of it.
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const cleared = await read()
  assert.deepEqual([cleared.snapshot, cleared.link, cleared.disc, cleared.inbox, cleared.refund, cleared.payment], [
    ERASED_FREE_TEXT_MARKER, { lastError: ERASED_FREE_TEXT_MARKER, dispatchLastError: ERASED_FREE_TEXT_MARKER, dispatchUnresolvedError: ERASED_FREE_TEXT_MARKER },
    ERASED_FREE_TEXT_MARKER, { reason: ERASED_FREE_TEXT_MARKER, resolutionNote: ERASED_FREE_TEXT_MARKER, rawPayload: {} }, ERASED_FREE_TEXT_MARKER, null,
  ])

  // AFTER: every writer, with any text, writes the marker (updates AND inserts, through plain Prisma writes as the sweeps do).
  await db.wmsOrderStatusSnapshot.update({ where: { id: snapshot.id }, data: { lastError: RAW } })
  await db.wmsOrderPushLink.update({ where: { id: link.id }, data: { lastError: RAW, dispatchLastError: RAW, dispatchUnresolvedError: RAW } })
  await db.wmsOrderDiscrepancy.update({ where: { id: disc.id }, data: { detail: RAW } })
  await db.wmsReturnsInbox.update({ where: { id: inbox.id }, data: { reason: RAW, resolutionNote: RAW, rawPayload: { who: FULL_NAME } } })
  await db.salesOrderRefund.update({ where: { id: fx.refundId }, data: { accountingWarning: RAW } })
  await db.payment.update({ where: { id: note.id }, data: { notes: RAW } })
  const after = await read()
  assert.deepEqual(after, cleared, 'nothing written back after the erasure survives')
  const newDisc = await db.wmsOrderDiscrepancy.create({ data: { orderId: fx.orderId, connector: 'mintsoft', category: 'UNMAPPED_SKU', detail: RAW } as never })
  const newInbox = await db.wmsReturnsInbox.create({ data: { orderId: fx.orderId, connector: 'mintsoft', externalReturnId: `${retNo}-2`, reason: RAW, rawPayload: { who: FULL_NAME } } as never })
  const newPay = await db.payment.create({ data: { orderId: fx.orderId, amount: 1, currency: 'GBP', paidAt: new Date('2026-11-03T10:00:00Z'), reference: 'GUARD-REF-2', notes: RAW } as never })
  const exact = await db.payment.create({ data: { orderId: fx.orderId, amount: 1, currency: 'GBP', paidAt: new Date('2026-11-03T10:00:00Z'), reference: 'GUARD-REF-3', notes: 'Imported from WooCommerce (paid when the order was imported)' } as never })
  assert.equal((await db.wmsOrderDiscrepancy.findUniqueOrThrow({ where: { id: newDisc.id } })).detail, ERASED_FREE_TEXT_MARKER, 'a NEW row is guarded on insert')
  const ni = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: newInbox.id } })
  assert.deepEqual([ni.reason, ni.rawPayload], [ERASED_FREE_TEXT_MARKER, {}])
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: newPay.id } })).notes, null)
  assert.equal((await db.payment.findUniqueOrThrow({ where: { id: exact.id } })).notes, 'Imported from WooCommerce (paid when the order was imported)', 'the importer\'s exact sentence passes')
  // The guard list covers every table it names: each has its trigger installed.
  for (const g of GUARDED_FREE_TEXT) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_trigger WHERE tgrelid = ${g.table}::regclass AND tgname LIKE '%erased_free_text'`
    assert.equal(Number(rows[0]!.n), 1, `${g.table} has its guard trigger`)
  }
})

test('[erasure] the free-text guard DURING an erasure: a writer blocked on a row the erasure holds is re-evaluated against the committed marker and writes none of its text', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const RAW = `Outer catch: ${FULL_NAME} at ${STREET}`
  const link = await db.wmsOrderPushLink.create({ data: { orderId: fx.orderId, connector: 'mintsoft' } as never })
  t.after(async () => { await db.wmsOrderPushLink.deleteMany({ where: { id: link.id } }); await fx.cleanup() })

  // The erasure (simulated by what matters: it holds the order lock and the link row, with the marker uncommitted).
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const erasing = db.$transaction(async (tx) => {
    await lockSalesOrder(tx, fx.orderId)
    await tx.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: new Date() } })
    await tx.wmsOrderPushLink.update({ where: { id: link.id }, data: { lastError: 'cleared by the erasure' } })
    await gate
  }, { timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 300))
  // An outer catch with no lock writes the connector's exception text into the same row.
  let written = false
  const writer = db.wmsOrderPushLink.update({ where: { id: link.id }, data: { lastError: RAW } }).then(() => { written = true })
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(written, false, 'PRECONDITION: the writer is blocked on the row the erasure holds')
  release()
  await erasing
  await writer
  const row = await db.wmsOrderPushLink.findUniqueOrThrow({ where: { id: link.id } })
  assert.equal(row.lastError, 'Text removed by GDPR erasure', 'the trigger was re-evaluated against the committed marker: nothing of the text survived')
})


test('[erasure] a refund-accounting retry that fails for an ERASED order logs a fixed description and the error class, never the exception text; a live order keeps its text', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const fx = await importFixture(db)
  t.after(async () => { settingsHook = null; await fx.cleanup() })
  const { retryRefundAccounting } = await import('@/app/actions/sales')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const RAW = `connector refused contact ${FULL_NAME} at ${STREET}`
  settingsHook = async () => { throw new Error(RAW) }
  const logsOf = async () => db.activityLog.findMany({ where: { entityId: fx.orderId, action: 'refund_accounting_retry_failed' } })

  assert.equal((await retryRefundAccounting(fx.refundId)).success, false)
  assert.ok((await logsOf()).some((l) => l.description.includes(NAME.last)), 'CONTROL: a live order keeps the exception text')
  await db.activityLog.deleteMany({ where: { entityId: fx.orderId, action: 'refund_accounting_retry_failed' } })

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  await retryRefundAccounting(fx.refundId)
  const rows = await logsOf()
  assert.ok(rows.length >= 1)
  for (const l of rows) {
    assert.ok(!JSON.stringify(l).includes(NAME.last) && !JSON.stringify(l).includes(STREET), 'an erased order logs no identity')
    assert.match(l.description, /Error.*withheld for an erased order/)
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// WOOCOMMERCE ANONYMISATION GUARDS. A payload carrying WooCommerce's positive marker is created already erased and never
// touches the customer table; the placeholders WooCommerce writes are never a match key, for any order.
// ---------------------------------------------------------------------------------------------------------------------

const WOO_PLACEHOLDER_EMAIL = 'deleted@site.invalid'
const WOO_ANON_ADDRESS = { first_name: '[deleted]', last_name: '[deleted]', company: '', address_1: '[deleted]', address_2: '', city: '[deleted]', state: '', postcode: '[deleted]', country: '', email: WOO_PLACEHOLDER_EMAIL, phone: '+000000000000' }

function anonymisedPayload(externalId: number, wcRateId: number) {
  const base = payload(externalId, wcRateId)
  return { ...base, customer_id: 0, billing: WOO_ANON_ADDRESS, shipping: WOO_ANON_ADDRESS, meta_data: [{ id: 5, key: '_anonymized', value: 'yes' }], customer_note: ORDER_NOTE }
}

async function cleanupImported(db: Awaited<ReturnType<typeof loadDb>>, externalIds: number[], options: { keepCustomers?: boolean } = {}) {
  for (const id of externalIds) {
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(id) }, select: { orderId: true } })
    if (!link) continue
    const orderId = link.orderId
    const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { customerId: true } })
    await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
    await db.activityLog.deleteMany({ where: { entityId: orderId } })
    await db.salesOrderLine.deleteMany({ where: { orderId } })
    await db.salesOrder.deleteMany({ where: { id: orderId } })
    await db.shoppingOrderLink.deleteMany({ where: { orderId } })
    if (order?.customerId && !options.keepCustomers) {
      await db.shoppingCustomerLink.deleteMany({ where: { customerId: order.customerId } })
      await db.customer.deleteMany({ where: { id: order.customerId } })
    }
  }
}

test('[erasure] a payload WooCommerce has anonymised is created already erased: no customer is matched or minted, the proof is written, the money stays', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const ids = [fx.externalId + 11, fx.externalId + 12]
  t.after(async () => { await cleanupImported(db, ids); await fx.cleanup() })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  // A pre-existing customer that already holds the placeholder address: the collision the guard exists to prevent.
  const squatter = await db.customer.create({ data: { firstName: 'Squat', lastName: 'Ter', email: WOO_PLACEHOLDER_EMAIL } })
  t.after(async () => { await db.customer.deleteMany({ where: { id: squatter.id } }) })
  const customersBefore = await db.customer.count()
  const before = await db.shoppingCustomerLink.count()

  for (const id of ids) {
    const result = await importWcOrder(anonymisedPayload(id, wcRateId) as never)
    assert.equal(result.success, true, JSON.stringify(result))
  }
  assert.equal(await db.customer.count(), customersBefore, 'no customer was minted')
  assert.equal(await db.shoppingCustomerLink.count(), before, 'no storefront link was written')
  const orders = await Promise.all(ids.map(async (id) => {
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(id) }, select: { orderId: true, metadata: true } })
    return { link, order: await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } }) }
  }))
  for (const { link, order } of orders) {
    assert.equal(order.customerId, null, 'not attached to the placeholder-address customer, nor to any other')
    assert.deepEqual([order.customerName, order.customerEmail, order.customerVatNumber, order.billingAddress, order.shippingAddress, order.notes],
      ['GDPR Anonymised', null, null, null, null, null], 'every identity column is erased, customer_note included (WooCommerce keeps it)')
    assert.ok(order.erasedAt)
    assert.equal(order.totalForeign.toString(), '126', 'the money stays')
    assert.equal(link.metadata, null, 'no storefront order key')
    const proof = await db.activityLog.findFirstOrThrow({ where: { entityId: order.id, action: 'gdpr_erasure_recorded' } })
    assert.equal((proof.metadata as { trigger: string }).trigger, 'MIRRORED_FROM_STOREFRONT')
    assert.equal((proof.metadata as { customerId: unknown }).customerId, null)
    const accounting = await db.accountingSyncLog.findMany({ where: { referenceId: order.id } })
    for (const row of accounting) assert.ok(!JSON.stringify(row.payload).includes(WOO_PLACEHOLDER_EMAIL), 'no placeholder address in an accounting payload')
  }
  assert.notEqual(orders[0]!.order.id, orders[1]!.order.id)
  // A redelivery of the same anonymised payload (the update path) changes nothing.
  assert.equal((await importWcOrder(anonymisedPayload(ids[0]!, wcRateId) as never)).success, true)
  const again = await db.salesOrder.findUniqueOrThrow({ where: { id: orders[0]!.order.id } })
  assert.deepEqual([again.customerName, again.notes, again.billingAddress], ['GDPR Anonymised', null, null])
  assert.equal(await db.customer.count(), customersBefore)
})

test('[erasure] the placeholders are never a match key or a stored identity for ANY order, marked or not', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const ids = [fx.externalId + 21, fx.externalId + 22]
  t.after(async () => { await cleanupImported(db, ids); await fx.cleanup() })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const squatter = await db.customer.create({ data: { firstName: 'Squat', lastName: 'Ter', email: WOO_PLACEHOLDER_EMAIL } })
  t.after(async () => { await db.customer.deleteMany({ where: { id: squatter.id } }) })

  // NOT marked: two real, distinct people whose email was replaced by the placeholder some other way.
  const named = (first: string) => ({ ...WC_ADDRESS, first_name: first, last_name: 'Distinctname', email: WOO_PLACEHOLDER_EMAIL })
  for (const [i, id] of ids.entries()) {
    const p = { ...payload(id, wcRateId), billing: named(`Person${i}`), shipping: named(`Person${i}`) }
    assert.equal((await importWcOrder(p as never)).success, true)
  }
  const customers = await Promise.all(ids.map(async (id) => {
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(id) }, select: { orderId: true } })
    return (await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId }, select: { customerId: true } })).customerId
  }))
  assert.ok(customers[0] && customers[1] && customers[0] !== customers[1], 'two distinct customers, not one shared record')
  assert.ok(!customers.includes(squatter.id), 'the customer already holding the placeholder address was not matched')
  for (const c of customers) assert.equal((await db.customer.findUniqueOrThrow({ where: { id: c! } })).email, null, 'the placeholder was not stored as an address')
  assert.equal(await db.customer.count({ where: { firstName: '[deleted]' } }), 0)

  // An ANONYMISED customer row is never a match target: same email as a live one, flagged erased.
  const mapped = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  const erasedRow = await db.customer.create({ data: { firstName: 'GDPR', lastName: 'Anonymised', email: `erased-${randomUUID()}@example.test`, gdprAnonymisedAt: new Date() } })
  t.after(async () => { await db.customer.deleteMany({ where: { id: erasedRow.id } }) })
  const matched = await mapped.upsertCustomer({ ...payload(ids[0]!, wcRateId), billing: { ...WC_ADDRESS, email: erasedRow.email! } } as never)
  t.after(async () => { if (matched) await db.customer.deleteMany({ where: { id: matched } }) })
  assert.notEqual(matched, erasedRow.id, 'an anonymised row is not matched')
})

test('[erasure] a delivery for an erased order that still carries real identity is refused AND logged once a day; an anonymised delivery logs nothing', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const refusals = () => db.activityLog.findMany({ where: { entityId: fx.orderId, action: 'inbound_repopulation_refused' } })

  assert.equal((await importWcOrder(anonymisedPayload(fx.externalId, wcRateId) as never)).success, true)
  assert.equal((await refusals()).length, 0, 'an anonymised delivery is the steady state and logs nothing')

  for (let i = 0; i < 2; i += 1) assert.equal((await importWcOrder(payload(fx.externalId, wcRateId) as never)).success, true)
  const rows = await refusals()
  assert.equal(rows.length, 1, 'two redeliveries, one line')
  assert.equal(rows[0]!.level, 'WARNING')
  const text = JSON.stringify(rows[0])
  for (const s of PERSONAL_STRINGS) assert.ok(!text.includes(s), 'the line names no erased data')
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.deepEqual([order.customerName, order.customerEmail, order.notes, order.billingAddress], ['GDPR Anonymised', null, null, null], 'and the identity was still withheld')
})

test('[erasure] a WooCommerce completion for an erased order writes no tracking number (WooCommerce keeps its tracking items), and the same completion DOES for a live order', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const { processWcCompletion } = await import('@/lib/connectors/woocommerce/sync/completion-flow')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const NUMBER = `WOOTRK-${randomUUID().slice(0, 8)}`
  const completed = { ...payload(fx.externalId, wcRateId), status: 'completed', meta_data: [{ id: 7, key: '_wc_shipment_tracking_items', value: [{ tracking_provider: 'Royal Mail', tracking_number: NUMBER }] }] }
  fulfilmentTracking.length = 0

  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  await processWcCompletion(fx.orderId, completed as never)
  assert.deepEqual(fulfilmentTracking, [[]], 'the fulfilment update was asked to record no tracking number for the erased order')
  assert.equal(await db.shipment.count({ where: { orderId: fx.orderId, trackingNumber: NUMBER } }), 0)
  // CONTROL: the same completion on the same order once the marker is cleared is asked to record it, so the empty list above is the guard.
  await db.salesOrder.update({ where: { id: fx.orderId }, data: { erasedAt: null } })
  fulfilmentTracking.length = 0
  await processWcCompletion(fx.orderId, completed as never)
  assert.equal(fulfilmentTracking.length, 1)
  assert.equal(fulfilmentTracking[0]!.length, 1, 'without the marker the completion carries the tracking number')
})

// ---------------------------------------------------------------------------------------------------------------------
// FIRST-IMPORT RACE: a marked and an unmarked delivery of the SAME storefront order, neither of which finds an IMS order.
// Serialised per storefront order, in BOTH winner orders: the order ends erased and no customer or link holds the identity.
// ---------------------------------------------------------------------------------------------------------------------

async function blockedOnAdvisoryLock(db: Awaited<ReturnType<typeof loadDb>>): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`
  return Number(rows[0]?.n ?? 0)
}

for (const winner of ['unmarked', 'marked'] as const) {
  test(`[erasure] concurrent first imports of one storefront order, the ${winner} delivery first: the order ends erased and no customer or link keeps the identity`, { skip }, async (t) => {
    const db = await loadDb()
    const fx = await importFixture(db)
    const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
    const externalId = fx.externalId + (winner === 'unmarked' ? 81 : 82)
    const tag = randomUUID().slice(0, 8)
    const subject = { ...WC_ADDRESS, first_name: `Race${tag}`, last_name: `Subject${tag}`, email: `race.${tag}@example.test` }
    const wooCustomerId = 500_000_000 + Math.floor(Math.random() * 90_000_000)
    t.after(async () => {
      await db.shoppingCustomerLink.deleteMany({ where: { externalCustomerId: String(wooCustomerId) } })
      await cleanupImported(db, [externalId])
      await db.customer.deleteMany({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } })
      await fx.cleanup()
    })
    const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
    const unmarked = { ...payload(externalId, wcRateId), customer_id: wooCustomerId, billing: subject, shipping: subject }
    const marked = anonymisedPayload(externalId, wcRateId)

    // Hold the per-order lock ourselves (the importer's own session lock) so both deliveries queue on it, then release: the first to queue is the first to run.
    const { acquireWcFirstImportLock } = await import('@/lib/connectors/woocommerce/sync/first-import-lock')
    const releaseHeld = await acquireWcFirstImportLock(externalId)
    const [first, second] = winner === 'unmarked' ? [unmarked, marked] : [marked, unmarked]
    const baseline = await blockedOnAdvisoryLock(db)
    const a = importWcOrder(first as never)
    for (let i = 0; i < 100 && (await blockedOnAdvisoryLock(db)) < baseline + 1; i += 1) await new Promise((r) => setTimeout(r, 50))
    const b = importWcOrder(second as never)
    for (let i = 0; i < 100 && (await blockedOnAdvisoryLock(db)) < baseline + 2; i += 1) await new Promise((r) => setTimeout(r, 50))
    assert.equal(await blockedOnAdvisoryLock(db), baseline + 2, 'both deliveries are queued on the per-order lock')
    await releaseHeld()
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra.success, true, JSON.stringify(ra))
    assert.equal(rb.success, true, JSON.stringify(rb))

    assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } }), 1, 'one order')
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
    assert.ok(order.erasedAt, 'the order is erased')
    assert.deepEqual([order.customerName, order.customerEmail, order.customerVatNumber, order.billingAddress, order.shippingAddress, order.notes], ['GDPR Anonymised', null, null, null, null, null])
    assert.equal(order.totalForeign.toString(), '126')
    assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }, { firstName: subject.first_name }] } }), 0, 'no customer row holds the identity')
    assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(wooCustomerId) } }), 0, 'no storefront link survives')
    const log = JSON.stringify(await db.activityLog.findMany({ where: { entityId: order.id } }))
    for (const s of [subject.first_name, subject.last_name, subject.email, STREET]) assert.ok(!log.includes(s), 'no identity in the order\'s activity log')
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// THE MIRROR: a marked delivery onto a HELD order erases it (order-first), the customer only when no live order remains.
// ---------------------------------------------------------------------------------------------------------------------

const proofRows = (db: Awaited<ReturnType<typeof loadDb>>, ids: string[]) =>
  db.activityLog.findMany({ where: { entityId: { in: ids }, action: 'gdpr_erasure_recorded' } })

test('[erasure] the mirror erases the marked order, keeps a customer who has another live order, and erases the customer with the last one', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const second = fx.externalId + 31
  t.after(async () => { await cleanupImported(db, [second], { keepCustomers: true }); await fx.cleanup() })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  assert.equal((await importWcOrder(payload(second, wcRateId) as never)).success, true)
  const secondOrder = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(second) }, select: { orderId: true } })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: secondOrder.orderId } })).customerId, fx.customerId, 'both orders belong to one customer')

  const pre = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  // The marked delivery for the FIRST order. The payload still carries the placeholders and customer_id 0.
  assert.equal((await importWcOrder(anonymisedPayload(fx.externalId, wcRateId) as never)).success, true)
  const first = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })
  assert.deepEqual([first.customerName, first.customerEmail, first.customerVatNumber, first.billingAddress, first.shippingAddress, first.notes, first.trackingNumber, first.internalNotes],
    ['GDPR Anonymised', null, null, null, null, null, null, null], 'the order is erased and the placeholders were not written back')
  assert.equal(first.customerId, null, 'the erased order is UNLINKED from the customer who stays live (as WooCommerce does with customer_id 0): the live customer no longer lists it')
  const { getCustomerDetail } = await import('@/app/actions/customers')
  const detail = await getCustomerDetail(fx.customerId)
  assert.deepEqual(detail!.orders.map((o) => o.id), [secondOrder.orderId], 'the live customer lists only its other order')
  assert.equal(await db.salesOrder.count({ where: { customerId: fx.customerId } }), 1)
  assert.equal(first.currency, 'GBP')
  assert.equal(first.totalForeign.toString(), '126', 'the money stays')
  for (const col of ['totalForeign', 'totalBase', 'taxForeign', 'taxBase', 'subtotalBase', 'orderNumber', 'externalOrderNumber', 'currency', 'invoiceNumber', 'invoicePdfPath', 'status'] as const) {
    assert.equal(String((first as Record<string, unknown>)[col]), String((pre as Record<string, unknown>)[col]), `${col} is retained`)
  }
  assert.equal(await db.salesOrderLine.count({ where: { orderId: fx.orderId } }), 1, 'the lines stay')
  let customer = await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })
  assert.equal(customer.gdprAnonymisedAt, null, 'the customer keeps another live order: not erased')
  assert.equal(customer.email, EMAIL)
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: fx.customerId } }) > 0, true, 'and keeps its storefront link')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: secondOrder.orderId } })).erasedAt, null, 'the other order is untouched')
  const proofs1 = await proofRows(db, [fx.orderId, fx.customerId])
  assert.equal(proofs1.length, 1)
  assert.equal((proofs1[0]!.metadata as { trigger: string }).trigger, 'MIRRORED_FROM_STOREFRONT')
  assert.equal(proofs1[0]!.entityType, 'SALES_ORDER')

  // IDEMPOTENT: the same delivery again writes nothing and records nothing.
  const stamp = first.erasedAt!.getTime()
  assert.equal((await importWcOrder(anonymisedPayload(fx.externalId, wcRateId) as never)).success, true)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt!.getTime(), stamp, 'erasedAt not rewritten')
  assert.equal((await proofRows(db, [fx.orderId, fx.customerId])).length, 1, 'no second proof row')

  // NOTHING RE-LINKS IT: an unmarked redelivery of the erased order (the update path), and a NEW order from the same live customer, leave it unlinked.
  assert.equal((await importWcOrder(payload(fx.externalId, wcRateId) as never)).success, true)
  const third = fx.externalId + 33
  t.after(async () => { await cleanupImported(db, [third], { keepCustomers: true }) })
  assert.equal((await importWcOrder(payload(third, wcRateId) as never)).success, true)
  const thirdOrder = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(third) }, select: { orderId: true } })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: thirdOrder.orderId } })).customerId, fx.customerId, 'the new order links to the live customer')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).customerId, null, 'the erased order stays unlinked')
  const proofMeta = (await proofRows(db, [fx.orderId]))[0]!.metadata as { customerId: unknown }
  assert.equal(proofMeta.customerId, null, 'the proof does not name the live customer')
  // The third order is a live order of the customer now: erase it as well so the later "last live order" step below still sees exactly two to go.
  await db.salesOrder.update({ where: { id: thirdOrder.orderId }, data: { erasedAt: new Date(), customerId: null } })

  // The LAST live order: the customer goes with it, in the same transaction, with ONE proof row for the customer.
  assert.equal((await importWcOrder(anonymisedPayload(second, wcRateId) as never)).success, true)
  customer = await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })
  assert.ok(customer.gdprAnonymisedAt, 'no live order remains: the customer is erased')
  assert.deepEqual([customer.firstName, customer.lastName, customer.email, customer.phone, customer.company, customer.notes], ['GDPR', 'Anonymised', null, null, null, null])
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: fx.customerId } }), 0)
  const proofs2 = await proofRows(db, [secondOrder.orderId, fx.customerId])
  assert.equal(proofs2.length, 1)
  assert.equal(proofs2[0]!.entityType, 'CUSTOMER')
  assert.equal((proofs2[0]!.metadata as { customerId: string }).customerId, fx.customerId)
  const allText = JSON.stringify(await db.activityLog.findMany({ where: { entityId: { in: [fx.orderId, secondOrder.orderId, fx.customerId] } } }))
  for (const sentinel of [NAME.first, NAME.last, EMAIL, STREET, POSTCODE]) assert.ok(!allText.includes(sentinel), 'no erased value is left in the activity log')
})

test('[erasure] a GUEST order (no customer) is fully erased by the mirror, which the customer-keyed erasure could never reach', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const guest = fx.externalId + 41
  t.after(async () => { await cleanupImported(db, [guest]); await fx.cleanup() })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const blank = { ...WC_ADDRESS, first_name: '', last_name: '', company: '', email: '', phone: '' }
  // A guest checkout that left no name or email on the customer step: upsertCustomer returns no customer, so the order is unlinked. Identity rides on the order itself.
  const p = { ...payload(guest, wcRateId), billing: blank, shipping: blank }
  assert.equal((await importWcOrder(p as never)).success, true)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(guest) }, select: { orderId: true } })
  await db.salesOrder.update({ where: { id: link.orderId }, data: { customerName: FULL_NAME, customerEmail: EMAIL, customerVatNumber: VAT, trackingNumber: TRACKING, internalNotes: INTERNAL_NOTE, billingAddress: { line1: STREET, postcode: POSTCODE } } })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })).customerId, null, 'a guest order: no customer')

  assert.equal((await importWcOrder(anonymisedPayload(guest, wcRateId) as never)).success, true)
  const o = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.deepEqual([o.customerName, o.customerEmail, o.customerVatNumber, o.billingAddress, o.shippingAddress, o.notes, o.trackingNumber, o.internalNotes],
    ['GDPR Anonymised', null, null, null, null, null, null, null])
  assert.ok(o.erasedAt)
  const proofs = await proofRows(db, [link.orderId])
  assert.equal(proofs.length, 1)
  assert.equal((proofs[0]!.metadata as { customerId: unknown }).customerId, null)
  assert.equal((proofs[0]!.metadata as { counts: { customers: number } }).counts.customers, 0)
})

test('[erasure] a marked delivery is mirrored whatever the status selection (even EMPTY) because it only ever touches an order IMS holds, and creates nothing', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const unseen = fx.externalId + 51
  const prior = await db.setting.findUnique({ where: { key: 'wc_sync_order_statuses' } })
  t.after(async () => {
    if (prior) await db.setting.update({ where: { key: 'wc_sync_order_statuses' }, data: { value: prior.value } }); else await db.setting.deleteMany({ where: { key: 'wc_sync_order_statuses' } })
    await cleanupImported(db, [unseen]); await fx.cleanup()
  })
  await db.setting.upsert({ where: { key: 'wc_sync_order_statuses' }, create: { key: 'wc_sync_order_statuses', value: '[]' }, update: { value: '[]' } })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  assert.equal((await importWcOrder({ ...anonymisedPayload(fx.externalId, wcRateId), status: 'cancelled' } as never)).success, true)
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt, 'the held order was mirrored under an empty selection and an unselected status')
  // CONTROL: an order IMS does NOT hold is still refused under the empty selection: nothing is created.
  const before = await db.salesOrder.count()
  await importWcOrder(anonymisedPayload(unseen, wcRateId) as never)
  assert.equal(await db.salesOrder.count(), before, 'the empty selection still creates nothing')
})

test('[erasure] mirror vs manual erasure, and two orders of one customer mirrored at once, end consistent: everything erased, exactly one customer proof', { skip }, async (t) => {
  const db = await loadDb()
  const { eraseOrderPersonalData, eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  for (let round = 0; round < 3; round += 1) {
    const fx = await importFixture(db)
    const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
    const second = fx.externalId + 61
    t.after(async () => { await cleanupImported(db, [second], { keepCustomers: true }); await fx.cleanup() })
    assert.equal((await importWcOrder(payload(second, wcRateId) as never)).success, true)
    const secondId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(second) }, select: { orderId: true } })).orderId
    const user = { trigger: 'MIRRORED_FROM_STOREFRONT' as const, userId: null }
    const results = await Promise.all(round === 0
      ? [eraseOrderPersonalData(fx.orderId, user), eraseOrderPersonalData(secondId, user)]
      : [eraseOrderPersonalData(fx.orderId, user), eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })])
    assert.ok(results.some((r) => r.success), JSON.stringify(results))
    for (const r of results) if (!r.success) assert.match(r.error, /already anonymised/, 'the only acceptable refusal is "already anonymised"')
    if (round === 0) assert.ok(results.every((r) => r.success))
    assert.ok((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).gdprAnonymisedAt, `round ${round}: the customer is erased`)
    for (const id of [fx.orderId, secondId]) assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id } })).erasedAt, `round ${round}: order erased`)
    assert.equal(await db.activityLog.count({ where: { entityId: fx.customerId, action: 'gdpr_erasure_recorded' } }), 1, `round ${round}: exactly one customer proof`)
  }
})

test('[erasure] a mirror that cannot run THROWS so the delivery retries, with fixed text', { skip }, async () => {
  await loadDb()
  const { mirrorWcAnonymisation, WcAnonymisationMirrorFailed } = await import('@/lib/connectors/woocommerce/sync/anonymisation-mirror')
  await assert.rejects(() => mirrorWcAnonymisation('no-such-order'), (e: Error) => e instanceof WcAnonymisationMirrorFailed && !/no-such-order/.test(e.message))
})


// ---------------------------------------------------------------------------------------------------------------------
// THE RECONCILE BACKSTOP (sweepWcAnonymisedOrders): keyset paging by modified time, a per-run budget, obligations for unheld marked orders.
// The REST read is answered by an in-memory store that honours status=any, modified_after / modified_before (exclusive), orderby=modified asc,
// page and per_page, so the paging behaviour is the real code against a faithful list; a hook can change the store between two requests.
// ---------------------------------------------------------------------------------------------------------------------

type FakeOrder = { id: number; mod: number; marked: boolean }

/** Europe/London for the 2026 autumn rollback: BST (GMT+1) until 01:00 UTC on 2026-10-25, GMT after. */
const londonLocal = (gmtMs: number) => (gmtMs < Date.UTC(2026, 9, 25, 1, 0, 0) ? gmtMs + 3_600_000 : gmtMs)

/** `sortBy: 'local'` sorts by the SITE-LOCAL modified time while the filter stays on GMT, as a legacy posts store may do. */
function fakeWooStore(orders: FakeOrder[], hook?: (requestNumber: number) => void, sortBy: 'gmt' | 'local' = 'gmt') {
  const calls: Array<Record<string, string>> = []
  const impl = async (_path: string, params: Record<string, string>) => {
    calls.push(params)
    hook?.(calls.length)
    const after = params.modified_after ? Date.parse(`${params.modified_after}Z`) : Number.NEGATIVE_INFINITY
    const before = params.modified_before ? Date.parse(`${params.modified_before}Z`) : Number.POSITIVE_INFINITY
    const perPage = Number(params.per_page)
    const page = Number(params.page)
    const key = (o: FakeOrder) => (sortBy === 'local' ? londonLocal(o.mod) : o.mod)
    const rows = orders.filter((o) => o.mod > after && o.mod < before).sort((a, b) => key(a) - key(b) || a.id - b.id)
    const slice = rows.slice((page - 1) * perPage, page * perPage)
    return {
      data: slice.map((o) => ({ id: o.id, number: String(o.id), date_modified_gmt: new Date(o.mod).toISOString().replace(/\.\d{3}Z$/, ''), meta_data: o.marked ? [{ id: 1, key: '_anonymized', value: 'yes' }] : [] })),
      totalPages: Math.ceil(rows.length / perPage), totalItems: rows.length,
    }
  }
  return { calls, impl }
}

const SWEEP_KEYS = ['wc_sync_order_statuses', 'wc_initial_import_completed', 'wc_erasure_sweep_cursor']

async function prepareSweep(db: Awaited<ReturnType<typeof loadDb>>, t: { after: (fn: () => Promise<void>) => void }, ids: () => number[]) {
  const prior = await db.setting.findMany({ where: { key: { in: SWEEP_KEYS } } })
  t.after(async () => {
    wcFetchImpl = null
    await db.setting.deleteMany({ where: { key: { in: SWEEP_KEYS } } })
    for (const row of prior) await db.setting.create({ data: { key: row.key, value: row.value } })
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: ids().map(String) } } })
    await db.activityLog.deleteMany({ where: { action: 'wc_anonymisation_sweep' } })
  })
  for (const [key, value] of [['wc_sync_order_statuses', '[]'], ['wc_initial_import_completed', 'true']] as const) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  // The tests' orders are dated in the past: start the cursor just before them (the production default is seven days back, tested separately).
  const startAt = new Date(Date.parse('2026-10-01T00:00:00Z') - 60_000).toISOString()
  await db.setting.upsert({ where: { key: 'wc_erasure_sweep_cursor' }, create: { key: 'wc_erasure_sweep_cursor', value: JSON.stringify({ after: startAt }) }, update: { value: JSON.stringify({ after: startAt }) } })
}

const obligationIds = async (db: Awaited<ReturnType<typeof loadDb>>, ids: number[]) =>
  new Set((await db.storefrontOrderErasureObligation.findMany({ where: { externalOrderId: { in: ids.map(String) } }, select: { externalOrderId: true } })).map((r) => Number(r.externalOrderId)))

const T0 = Date.parse('2026-10-01T00:00:00Z')

test('[erasure] the backstop: status=any, GET only, a marked HELD order is erased under the lock, a marked UNHELD order leaves an obligation, an unmarked one is ignored, nothing is created, the cursor moves, the count is logged', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const unheld = fx.externalId + 72
  const plain = fx.externalId + 73
  await prepareSweep(db, t, () => [unheld, plain, fx.externalId])
  t.after(async () => { await fx.cleanup() })
  await db.storefrontOrderErasureObligation.create({ data: { connector: 'woocommerce', externalOrderId: String(fx.externalId) } })
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore([
    { id: fx.externalId, mod: T0 + 5 * 3_600_000, marked: true },
    { id: plain, mod: T0 + 4 * 3_600_000, marked: false },
    { id: unheld, mod: T0 + 3 * 3_600_000, marked: true },
  ])
  wcFetchImpl = store.impl
  const ordersBefore = await db.salesOrder.count()
  const result = await sweepWcAnonymisedOrders()
  assert.deepEqual([result.scanned, result.markedHeld, result.mirrored, result.obligationsRecorded, result.errors.length], [3, 1, 1, 1, 0])
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt, 'the held marked order was erased')
  assert.ok((await db.storefrontOrderErasureObligation.findUniqueOrThrow({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(fx.externalId) } } })).retiredAt, 'and its open obligation retired')
  assert.equal((await obligationIds(db, [unheld])).has(unheld), true, 'the unheld marked order left an obligation (a later create is erased-on-create)')
  assert.equal((await obligationIds(db, [plain])).has(plain), false, 'the unmarked order left nothing')
  assert.equal(await db.salesOrder.count(), ordersBefore, 'the sweep created nothing')
  assert.ok(store.calls.every((c) => c.status === 'any' && c.orderby === 'modified' && c.order === 'asc' && c.dates_are_gmt === 'true'), 'GET /orders, status=any, GMT comparison')
  const state = JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value) as { after: string }
  const { WC_ERASURE_SWEEP_CURSOR_OVERLAP_MS } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  assert.equal(state.after, new Date(T0 + 5 * 3_600_000 - WC_ERASURE_SWEEP_CURSOR_OVERLAP_MS).toISOString(), 'the cursor is the newest modified time minus the 65-minute overlap')
  assert.equal(((await db.activityLog.findFirstOrThrow({ where: { action: 'wc_anonymisation_sweep' }, orderBy: { createdAt: 'desc' } })).metadata as { obligationsRecorded: number }).obligationsRecorded, 1, 'the per-run count is logged')
})

test('[erasure] PAGE SHIFT: an order modified between two page reads is not skipped, and the order the old offset scheme skipped is covered', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_600_000_000 + Math.floor(Math.random() * 50_000_000)
  const orders: FakeOrder[] = Array.from({ length: 250 }, (_, i) => ({ id: base + i, mod: T0 + i * 600_000, marked: true }))
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  // Between the first and the second read, an order already read on page 1 is edited in WooCommerce: its modified time jumps to NOW. With offset
  // paging every later order shifts down one place and the 101st order (index 100) lands on the page that was already read: it is skipped.
  const store = fakeWooStore(orders, (n) => { if (n === 2) orders[5]!.mod = T0 + 999_000_000_000 })
  wcFetchImpl = store.impl
  const result = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(result.errors.length, 0)
  const got = await obligationIds(db, orders.map((o) => o.id))
  assert.equal(got.size, 250, 'every order has its obligation')
  assert.ok(got.has(orders[100]!.id), 'including the one an offset scheme would have skipped')
  assert.ok(store.calls.every((c) => c.page === '1'), 'no offset was used: every request is page 1 of a moving lower bound')
})

test('[erasure] a block of orders sharing ONE modified second that is larger than a page is read inside its window, twice, and fully covered', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_700_000_000 + Math.floor(Math.random() * 50_000_000)
  const tie = Array.from({ length: 230 }, (_, i) => ({ id: base + i, mod: T0 + 50_000, marked: true }))
  const after = Array.from({ length: 5 }, (_, i) => ({ id: base + 1000 + i, mod: T0 + 100_000 + i * 1000, marked: true }))
  const before = [{ id: base + 2000, mod: T0 + 1000, marked: true }]
  const orders: FakeOrder[] = [...before, ...tie, ...after]
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore(orders)
  wcFetchImpl = store.impl
  const result = await sweepWcAnonymisedOrders({ maxPages: 40 })
  assert.equal(result.errors.length, 0)
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, orders.length, 'every order of the tie block, and those around it, is covered')
  const windowed = store.calls.filter((c) => c.modified_before)
  assert.ok(windowed.length >= 6, 'the window was read by offset, both passes')
  assert.ok(windowed.some((c) => c.page === '2') && windowed.some((c) => c.page === '3'))
  const state = JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value) as { after: string; window?: unknown }
  assert.equal(state.window, undefined, 'the window is closed')
})

test('[erasure] the per-run budget stops the sweep cleanly and the next run RESUMES from the persisted state, including inside a tie window', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_800_000_000 + Math.floor(Math.random() * 50_000_000)
  const spread: FakeOrder[] = Array.from({ length: 250 }, (_, i) => ({ id: base + i, mod: T0 + i * 600_000, marked: true }))
  const tie: FakeOrder[] = Array.from({ length: 230 }, (_, i) => ({ id: base + 5000 + i, mod: T0 + 300_000_000, marked: true }))
  const orders = [...spread, ...tie]
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore(orders)
  wcFetchImpl = store.impl
  let runs = 0
  let previousCalls = 0
  for (; runs < 30; runs += 1) {
    const result = await sweepWcAnonymisedOrders({ maxPages: 2 })
    assert.equal(result.errors.length, 0)
    assert.ok(store.calls.length - previousCalls <= 2, 'never more than the budget in one run')
    previousCalls = store.calls.length
    if (!result.budgetStop) break
  }
  assert.ok(runs >= 3 && runs < 30, `it took several budgeted runs (${runs + 1}) and finished`)
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, orders.length, 'every order was covered across the resumed runs')
  // A wall-clock budget stops a run too.
  // A wall-clock budget stops a run too, with plenty of data left to read.
  const many: FakeOrder[] = Array.from({ length: 600 }, (_, i) => ({ id: base + 10_000 + i, mod: T0 + 4_000_000_000 + i * 600_000, marked: false }))
  wcFetchImpl = fakeWooStore(many).impl
  let t0 = 0
  const timed = await sweepWcAnonymisedOrders({ maxMs: 1000, now: () => (t0 += 600) })
  assert.equal(timed.budgetStop, true, 'the time budget stopped the run')
  assert.ok(timed.pages <= 2, `and after at most two pages (${timed.pages})`)
})

test('[erasure] an error mid-page leaves the cursor at a safe value, and the next run loses nothing', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_900_000_000 + Math.floor(Math.random() * 50_000_000)
  const orders: FakeOrder[] = Array.from({ length: 250 }, (_, i) => ({ id: base + i, mod: T0 + i * 600_000, marked: true }))
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const good = fakeWooStore(orders)
  let n = 0
  wcFetchImpl = async (path, params) => (++n === 2 ? { data: null, totalPages: 0, totalItems: 0, error: 'rate limited' } : good.impl(path, params))
  const first = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(first.errors.length, 1)
  const state = JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value) as { after: string }
  assert.ok(Date.parse(state.after) <= orders[99]!.mod, 'the cursor is at or before the last order fully processed')
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, 100, 'exactly the first page was processed')
  wcFetchImpl = good.impl
  const second = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(second.errors.length, 0)
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, 250, 'the next run covered everything')
})

test('[erasure] the backstop meets an UNHELD marked order while a stale first import of it is paused inside the lock: it waits, then erases what the import committed', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const externalId = fx.externalId + 401
  const tag = randomUUID().slice(0, 8)
  const subject = { ...WC_ADDRESS, first_name: `Sweep${tag}`, last_name: `Race${tag}`, email: `sweep.${tag}@example.test` }
  await prepareSweep(db, t, () => [externalId])
  // The stale first import must be ADMITTED (the default selection), unlike the sweep tests above, which run under an empty one.
  await db.setting.deleteMany({ where: { key: 'wc_sync_order_statuses' } })
  t.after(async () => {
    beforeUpsertCustomer = null
    await cleanupImported(db, [externalId])
    await db.customer.deleteMany({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } })
    await fx.cleanup()
  })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  let reached!: () => void
  const atHook = new Promise<void>((r) => { reached = r })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  beforeUpsertCustomer = async () => { beforeUpsertCustomer = null; reached(); await gate }
  const stale = importWcOrder({ ...payload(externalId, wcRateId), billing: subject, shipping: subject } as never)
  await atHook
  wcFetchImpl = fakeWooStore([{ id: externalId, mod: T0, marked: true }]).impl
  let done = false
  const sweeping = sweepWcAnonymisedOrders({ maxPages: 3 }).then((r) => { done = true; return r })
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(done, false, 'the sweep waits on the first-import lock: it does not decide on an unlocked read')
  release()
  await stale
  const result = await sweeping
  assert.equal(result.errors.length, 0)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.ok(order.erasedAt, 'the order the stale import committed was erased')
  assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } }), 0, 'no customer holds the identity')
})


test('[erasure] a burst of first imports larger than the application pool, a marked one among them, all complete: the lock never takes a connection of the main pool', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { DB_POOL_MAX } = await import('@/lib/db')
  const count = DB_POOL_MAX + 6
  const ids = Array.from({ length: count }, (_, i) => fx.externalId + 200 + i)
  const markedId = ids[3]!
  t.after(async () => { await cleanupImported(db, ids); await fx.cleanup() })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const blank = { ...WC_ADDRESS, first_name: '', last_name: '', company: '', email: '', phone: '' }
  const results = await Promise.all(ids.map((id) => importWcOrder((id === markedId ? anonymisedPayload(id, wcRateId) : { ...payload(id, wcRateId), billing: blank, shipping: blank }) as never)))
  results.forEach((r, i) => assert.equal(r.success, true, `import ${i}: ${JSON.stringify(r)}`))
  assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: { in: ids.map(String) } } }), count, 'every order was created')
  const marked = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(markedId) }, select: { orderId: true } })
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: marked.orderId } })).erasedAt, 'the marked order was created erased')
})

test('[erasure] the first-import lock wait is bounded: a second acquire on a held order throws the retryable error and frees its connection', { skip }, async () => {
  await loadDb()
  const { acquireWcFirstImportLock, WcFirstImportLockUnavailable } = await import('@/lib/connectors/woocommerce/sync/first-import-lock')
  const id = 1_900_000_000 + Math.floor(Math.random() * 90_000_000)
  const release = await acquireWcFirstImportLock(id)
  await assert.rejects(() => acquireWcFirstImportLock(id, 300), (e: Error) => e instanceof WcFirstImportLockUnavailable)
  await release()
  const again = await acquireWcFirstImportLock(id, 300)
  await again()
})

test('[erasure] the customer step is atomic with the order create: a failure after it leaves no customer or link, so a later marked delivery leaves no identity anywhere; a successful import still creates and links', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const externalId = fx.externalId + 91
  const okId = fx.externalId + 92
  const tag = randomUUID().slice(0, 8)
  const subject = { ...WC_ADDRESS, first_name: `Atomic${tag}`, last_name: `Subject${tag}`, email: `atomic.${tag}@example.test` }
  const wooCustomerId = 400_000_000 + Math.floor(Math.random() * 90_000_000)
  const okWooCustomerId = wooCustomerId + 1
  t.after(async () => {
    beforeUpsertCustomer = null; afterUpsertCustomerInTx = null
    await db.shoppingCustomerLink.deleteMany({ where: { externalCustomerId: { in: [String(wooCustomerId), String(okWooCustomerId)] } } })
    await cleanupImported(db, [externalId, okId])
    await db.customer.deleteMany({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } })
    await fx.cleanup()
  })
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const unmarked = { ...payload(externalId, wcRateId), customer_id: wooCustomerId, billing: subject, shipping: subject }

  // The customer step succeeds INSIDE the create transaction, then something later in the same transaction throws (injected).
  let injected = false
  afterUpsertCustomerInTx = async () => { afterUpsertCustomerInTx = null; injected = true; throw new Error('injected failure after the customer step') }
  const failed = await importWcOrder(unmarked as never)
  assert.equal(injected, true, 'the customer step was reached and returned')
  assert.equal(failed.success, false, 'the import failed after the customer step')
  assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } }), 0, 'no order')
  assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } }), 0, 'and the customer step rolled back with it: no customer row')
  assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(wooCustomerId) } }), 0, 'and no storefront link')

  // The marked delivery now creates an erased order, and nothing anywhere holds the identity.
  assert.equal((await importWcOrder(anonymisedPayload(externalId, wcRateId) as never)).success, true)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.ok(order.erasedAt)
  assert.deepEqual([order.customerName, order.customerEmail, order.billingAddress, order.notes], ['GDPR Anonymised', null, null, null])
  assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }, { firstName: subject.first_name }] } }), 0, 'no customer holds the identity')
  assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(wooCustomerId) } }), 0)

  // CONTROL: a successful first import still creates and links the customer.
  const ok = { ...payload(okId, wcRateId), customer_id: okWooCustomerId, billing: { ...subject, email: `ok.${tag}@example.test`, first_name: `Okay${tag}` }, shipping: { ...subject, first_name: `Okay${tag}` } }
  t.after(async () => { await db.customer.deleteMany({ where: { email: `ok.${tag}@example.test` } }) })
  assert.equal((await importWcOrder(ok as never)).success, true)
  const okLink = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(okId) }, select: { orderId: true } })
  const okOrder = await db.salesOrder.findUniqueOrThrow({ where: { id: okLink.orderId } })
  assert.ok(okOrder.customerId, 'the order is linked to a customer')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: okOrder.customerId! } })).email, `ok.${tag}@example.test`)
  assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(okWooCustomerId), customerId: okOrder.customerId! } }), 1, 'and the storefront link was written')
})

// ---------------------------------------------------------------------------------------------------------------------
// A MARKED DELIVERY IS NEVER DECIDED BY AN UNLOCKED "IS THERE AN ORDER?" READ (Codex R5): an unmarked first import is paused INSIDE the
// first-import lock (in its create transaction, order not committed) while the marked delivery arrives by each route that used to skip or
// acknowledge it before the lock. It must wait for the in-flight import and then erase what it committed.
// ---------------------------------------------------------------------------------------------------------------------

type MarkedRoute = { name: string; deliver: (externalId: number, wcRateId: number) => Promise<unknown> }

const MARKED_ROUTES: MarkedRoute[] = [
  {
    name: 'a withdrawal-status delivery through the withdrawal wrapper (used to be skipped as "never imported" and acknowledged)',
    deliver: async (externalId, wcRateId) => {
      const { getWithdrawalStatuses, importWcOrderGuarded } = await import('@/lib/connectors/woocommerce/sync/withdrawal')
      const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
      const { submitted } = await getWithdrawalStatuses()
      const marked = { ...anonymisedPayload(externalId, wcRateId), status: submitted }
      const guarded = await importWcOrderGuarded(marked as never, () => importWcOrder(marked as never))
      return guarded
    },
  },
  {
    name: 'a delivery in a status the operator has not ticked (used to be refused by the admission gate before the lock)',
    deliver: async (externalId, wcRateId) => {
      const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
      return importWcOrder({ ...anonymisedPayload(externalId, wcRateId), status: 'cancelled' } as never)
    },
  },
  {
    name: 'the initial-import-pending path (mirrors onto a held order instead of dropping the delivery)',
    deliver: async (externalId) => {
      const { mirrorWcAnonymisationIfHeld } = await import('@/lib/connectors/woocommerce/sync/anonymisation-mirror')
      return mirrorWcAnonymisationIfHeld({ id: externalId })
    },
  },
]

for (const [index, route] of MARKED_ROUTES.entries()) {
  test(`[erasure] a marked delivery arriving while an unmarked first import is in flight waits for it and erases the order: ${route.name}`, { skip }, async (t) => {
    const db = await loadDb()
    const fx = await importFixture(db)
    const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
    const externalId = fx.externalId + 101 + index
    const tag = randomUUID().slice(0, 8)
    const subject = { ...WC_ADDRESS, first_name: `Inflight${tag}`, last_name: `Subject${tag}`, email: `inflight.${tag}@example.test` }
    const wooCustomerId = 300_000_000 + Math.floor(Math.random() * 90_000_000)
    t.after(async () => {
      beforeUpsertCustomer = null
      await db.shoppingCustomerLink.deleteMany({ where: { externalCustomerId: String(wooCustomerId) } })
      await cleanupImported(db, [externalId])
      await db.customer.deleteMany({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } })
      await fx.cleanup()
    })
    const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
    const unmarked = { ...payload(externalId, wcRateId), customer_id: wooCustomerId, billing: subject, shipping: subject }

    // Pause the unmarked first import inside its create transaction, which is inside the first-import lock.
    let reached!: () => void
    const atHook = new Promise<void>((r) => { reached = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    beforeUpsertCustomer = async () => { beforeUpsertCustomer = null; reached(); await gate }
    const first = importWcOrder(unmarked as never)
    await atHook
    assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } }), 0, 'the in-flight import has committed nothing yet')

    let done = false
    const second = route.deliver(externalId, wcRateId).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 1500))
    assert.equal(done, false, 'the marked delivery is waiting for the in-flight import, not acknowledged on a read that says "no order"')
    release()
    await first
    const delivered = await second
    assert.notEqual((delivered as { outcome?: string } | undefined)?.outcome, 'skipped-withdrawal', 'the marked delivery was not skipped on an unlocked read')

    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
    assert.ok(order.erasedAt, 'the order the in-flight import committed was erased')
    assert.deepEqual([order.customerName, order.customerEmail, order.billingAddress, order.shippingAddress, order.notes], ['GDPR Anonymised', null, null, null, null])
    assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }, { firstName: subject.first_name }] } }), 0, 'no customer holds the identity')
    assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(wooCustomerId) } }), 0, 'no storefront link survives')
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// THE ORDER-KEYED ERASURE OBLIGATION (Codex R6): a marked delivery for an order IMS does not hold is acknowledged by several routes while an
// import (the initial import's page snapshot, a refusal drain, a retry) may still hold an OLDER, identifiable read of that order. The
// acknowledgement leaves a durable obligation; when that older read is imported it is created ALREADY ERASED, and the obligation retires.
// ---------------------------------------------------------------------------------------------------------------------

for (const [index, route] of MARKED_ROUTES.entries()) {
  test(`[erasure] a marked delivery acknowledged for an order IMS does not hold leaves an obligation; the OLDER identifiable read imported afterwards is created erased: ${route.name}`, { skip }, async (t) => {
    const db = await loadDb()
    const fx = await importFixture(db)
    const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
    const externalId = fx.externalId + 301 + index
    const tag = randomUUID().slice(0, 8)
    const subject = { ...WC_ADDRESS, first_name: `Stale${tag}`, last_name: `Snapshot${tag}`, email: `stale.${tag}@example.test` }
    const wooCustomerId = 200_000_000 + Math.floor(Math.random() * 90_000_000)
    t.after(async () => {
      await db.shoppingCustomerLink.deleteMany({ where: { externalCustomerId: String(wooCustomerId) } })
      await cleanupImported(db, [externalId])
      await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: String(externalId) } })
      await db.customer.deleteMany({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }] } })
      await fx.cleanup()
    })
    const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
    // The older read, fetched BEFORE the anonymisation (as the initial import's page snapshot is).
    const stale = { ...payload(externalId, wcRateId), customer_id: wooCustomerId, billing: subject, shipping: subject }

    // The marked delivery arrives; IMS does not hold the order, so the delivery is acknowledged (or refused) and nothing is created.
    await route.deliver(externalId, wcRateId)
    await route.deliver(externalId, wcRateId) // a redelivery: idempotent
    assert.equal(await db.shoppingOrderLink.count({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } }), 0, 'nothing was created')
    const open = await db.storefrontOrderErasureObligation.findMany({ where: { externalOrderId: String(externalId) } })
    assert.equal(open.length, 1, 'exactly one obligation, however many deliveries')
    assert.equal(open[0]!.retiredAt, null, 'and it is open')

    // The older read is imported afterwards: it is created ALREADY ERASED and the obligation retires in that transaction.
    assert.equal((await importWcOrder(stale as never)).success, true)
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
    assert.ok(order.erasedAt, 'the identifiable older read was created erased')
    assert.deepEqual([order.customerName, order.customerEmail, order.customerVatNumber, order.billingAddress, order.shippingAddress, order.notes], ['GDPR Anonymised', null, null, null, null, null])
    assert.equal(order.customerId, null)
    assert.equal(order.totalForeign.toString(), '126', 'the money is imported as usual')
    assert.equal(await db.customer.count({ where: { OR: [{ email: subject.email }, { lastName: subject.last_name }, { firstName: subject.first_name }] } }), 0, 'no customer holds the identity')
    assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(wooCustomerId) } }), 0, 'no storefront link')
    assert.ok((await db.storefrontOrderErasureObligation.findUniqueOrThrow({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(externalId) } } })).retiredAt, 'the obligation retired with the create')
    assert.equal(await proofRows(db, [link.orderId]).then((r) => r.length), 1, 'one proof record')

    // IDEMPOTENT: the marked delivery again, now for a HELD erased order, changes nothing and records no second proof or obligation.
    await route.deliver(externalId, wcRateId)
    assert.equal(await proofRows(db, [link.orderId]).then((r) => r.length), 1, 'still one proof record')
    assert.ok((await db.storefrontOrderErasureObligation.findUniqueOrThrow({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(externalId) } } })).retiredAt, 'still retired')
  })
}

test('[erasure] erasing a HELD order through the mirror retires an open obligation for it', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  t.after(async () => { await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: String(fx.externalId) } }); await fx.cleanup() })
  const { recordWcErasureObligation } = await import('@/lib/connectors/woocommerce/sync/erasure-obligation')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  await recordWcErasureObligation(fx.externalId)
  assert.equal((await importWcOrder(anonymisedPayload(fx.externalId, wcRateId) as never)).success, true)
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt)
  assert.ok((await db.storefrontOrderErasureObligation.findUniqueOrThrow({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(fx.externalId) } } })).retiredAt, 'retired after erasing the held order')
})

test('[erasure] the backstop cadence: due when never run, not due again within 6 hours, due again after 6 hours, and on every tick while a budget stop left a backlog', { skip }, async (t) => {
  const db = await loadDb()
  const keys = ['wc_erasure_sweep_last_run_at', 'wc_erasure_sweep_backlog']
  await prepareSweep(db, t, () => [])
  t.after(async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) })
  await db.setting.deleteMany({ where: { key: { in: keys } } })
  const { runWcErasureSweepIfDue } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore([])
  wcFetchImpl = store.impl
  const first = await runWcErasureSweepIfDue()
  assert.ok(!('skipped' in first), 'never run: due')
  const second = await runWcErasureSweepIfDue()
  assert.deepEqual(second, { skipped: true, reason: 'not_due' })
  assert.equal(store.calls.length, 1, 'a tick that is not due adds no request')
  const setLastRun = (hoursAgo: number) => db.setting.update({ where: { key: 'wc_erasure_sweep_last_run_at' }, data: { value: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } })
  await setLastRun(5)
  assert.deepEqual(await runWcErasureSweepIfDue(), { skipped: true, reason: 'not_due' }, 'five hours: still not due')
  await setLastRun(7)
  assert.ok(!('skipped' in (await runWcErasureSweepIfDue())), 'seven hours: due')
  await db.setting.upsert({ where: { key: 'wc_erasure_sweep_backlog' }, create: { key: 'wc_erasure_sweep_backlog', value: 'true' }, update: { value: 'true' } })
  assert.ok(!('skipped' in (await runWcErasureSweepIfDue())), 'a backlog makes the very next tick due')
})

test('[erasure] the FIRST run starts seven days back, not at the beginning of history', { skip }, async (t) => {
  const db = await loadDb()
  await prepareSweep(db, t, () => [])
  await db.setting.deleteMany({ where: { key: 'wc_erasure_sweep_cursor' } })
  const { sweepWcAnonymisedOrders, WC_ERASURE_SWEEP_INITIAL_LOOKBACK_MS } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore([])
  wcFetchImpl = store.impl
  const before = Date.now()
  await sweepWcAnonymisedOrders()
  const asked = Date.parse(`${store.calls[0]!.modified_after}Z`)
  assert.ok(Math.abs(asked - (before - WC_ERASURE_SWEEP_INITIAL_LOOKBACK_MS)) < 5000, 'the first request asks for the last seven days')
  // An explicit `since` sweeps further back when an operator needs it.
  await sweepWcAnonymisedOrders({ since: new Date('2026-01-01T00:00:00Z') })
  assert.equal(store.calls[1]!.modified_after, '2026-01-01T00:00:00')
})

test('[erasure] an order that FLIPS from unmarked to marked between two page reads of one run is evaluated, not skipped as already seen', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_950_000_000 + Math.floor(Math.random() * 40_000_000)
  const orders: FakeOrder[] = Array.from({ length: 150 }, (_, i) => ({ id: base + i, mod: T0 + i * 600_000, marked: false }))
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  // Request 1 reads order index 10 unmarked. Before request 2, WooCommerce anonymises it: it is now marked and its modified time moves later.
  const store = fakeWooStore(orders, (n) => { if (n === 2) { orders[10]!.marked = true; orders[10]!.mod = T0 + 999_000_000_000 } })
  wcFetchImpl = store.impl
  const result = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(result.errors.length, 0)
  assert.equal((await obligationIds(db, [orders[10]!.id])).has(orders[10]!.id), true, 'the marked version was evaluated and left its obligation')
  assert.equal((await obligationIds(db, orders.filter((o) => !o.marked).map((o) => o.id))).size, 0, 'and nothing else did')
})

test('[erasure] the backstop is NOT gated on the initial import: an order held during an incomplete initial import, anonymised with its webhook missed, is swept', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  await prepareSweep(db, t, () => [fx.externalId])
  t.after(async () => { await fx.cleanup() })
  await db.setting.upsert({ where: { key: 'wc_initial_import_completed' }, create: { key: 'wc_initial_import_completed', value: 'false' }, update: { value: 'false' } })
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  wcFetchImpl = fakeWooStore([{ id: fx.externalId, mod: T0 + 1000, marked: true }]).impl
  const result = await sweepWcAnonymisedOrders()
  assert.equal(result.markedHeld, 1)
  assert.ok((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt, 'the held order was erased although the initial import never completed')
})

test('[erasure] the initial cursor is persisted at once, and ANY incomplete run (read error, mirror error, budget stop) leaves the backlog set so the next tick retries; only a confirmed caught-up run starts the 6-hour cadence', { skip }, async (t) => {
  const db = await loadDb()
  const keys = ['wc_erasure_sweep_last_run_at', 'wc_erasure_sweep_backlog']
  await prepareSweep(db, t, () => [])
  t.after(async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) })
  await db.setting.deleteMany({ where: { key: { in: [...keys, 'wc_erasure_sweep_cursor'] } } })
  const { sweepWcAnonymisedOrders, runWcErasureSweepIfDue } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const backlog = async () => (await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_backlog' } })).value

  // A read error on the very first request: the run is incomplete, the initial cursor was still persisted, and the next tick is due.
  wcFetchImpl = async () => ({ data: null, totalPages: 0, totalItems: 0, error: 'rate limited' })
  const failed = await sweepWcAnonymisedOrders()
  assert.equal(failed.errors.length, 1)
  assert.ok(await db.setting.findUnique({ where: { key: 'wc_erasure_sweep_cursor' } }), 'the initial cursor was persisted before the failing read')
  assert.equal(await backlog(), 'true', 'a read error leaves the backlog set')
  const retry = fakeWooStore([])
  wcFetchImpl = retry.impl
  assert.ok(!('skipped' in (await runWcErasureSweepIfDue())), 'and the very next tick retries')

  // A budget stop is incomplete too.
  const base = 1_970_000_000 + Math.floor(Math.random() * 20_000_000)
  const many: FakeOrder[] = Array.from({ length: 250 }, (_, i) => ({ id: base + i, mod: Date.now() - 3_000_000 + i * 1000, marked: false }))
  wcFetchImpl = fakeWooStore(many).impl
  const stopped = await sweepWcAnonymisedOrders({ maxPages: 1 })
  assert.equal(stopped.budgetStop, true)
  assert.equal(await backlog(), 'true')

  // A confirmed caught-up run (a short final page, no errors) clears it, and the next tick is then NOT due.
  wcFetchImpl = fakeWooStore([]).impl
  const clean = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(clean.errors.length, 0)
  assert.equal(await backlog(), 'false')
  assert.deepEqual(await runWcErasureSweepIfDue(), { skipped: true, reason: 'not_due' })
})

for (const sortBy of ['local', 'gmt'] as const) {
  test(`[erasure] DST ROLLBACK: orders on both sides of the repeated hour are all evaluated when the store sorts by ${sortBy.toUpperCase()} time and filters by GMT, with a page boundary inside the hour`, { skip }, async (t) => {
    const db = await loadDb()
    const base = 1_960_000_000 + Math.floor(Math.random() * 20_000_000) + (sortBy === 'local' ? 0 : 5_000_000)
    // One order a minute from 22:00 GMT on the 24th to 04:00 GMT on the 25th: 360 orders across the clock change at 01:00 GMT (02:00 BST back to 01:00 GMT).
    const start = Date.UTC(2026, 9, 24, 22, 1, 0) // the minute offset puts a page boundary on the far side of the repeated hour (a 2-second overlap loses 20 orders here)
    const orders: FakeOrder[] = Array.from({ length: 360 }, (_, i) => ({ id: base + i, mod: start + i * 60_000, marked: true }))
    await prepareSweep(db, t, () => orders.map((o) => o.id))
    await db.setting.upsert({ where: { key: 'wc_erasure_sweep_cursor' }, create: { key: 'wc_erasure_sweep_cursor', value: JSON.stringify({ after: new Date(start - 60_000).toISOString() }) }, update: { value: JSON.stringify({ after: new Date(start - 60_000).toISOString() }) } })
    const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
    const store = fakeWooStore(orders, undefined, sortBy)
    wcFetchImpl = store.impl
    const result = await sweepWcAnonymisedOrders({ maxPages: 60 })
    assert.equal(result.errors.length, 0)
    const got = await obligationIds(db, orders.map((o) => o.id))
    const missing = orders.filter((o) => !got.has(o.id)).map((o) => new Date(o.mod).toISOString())
    assert.deepEqual(missing, [], 'every marked order was evaluated')
  })
}

test('[erasure] a successful response that is NOT an order list is a read failure: the cursor and the backlog are kept and the next tick retries', { skip }, async (t) => {
  const db = await loadDb()
  const keys = ['wc_erasure_sweep_last_run_at', 'wc_erasure_sweep_backlog']
  await prepareSweep(db, t, () => [])
  t.after(async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) })
  await db.setting.deleteMany({ where: { key: { in: keys } } })
  const { sweepWcAnonymisedOrders, runWcErasureSweepIfDue } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const cursorBefore = (await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value
  for (const bad of [null, '<html>502</html>', { message: 'proxy' }]) {
    wcFetchImpl = async () => ({ data: bad, totalPages: 1, totalItems: 0 })
    const result = await sweepWcAnonymisedOrders()
    assert.equal(result.errors.length, 1, `a ${typeof bad} body is an error, not an empty page`)
    assert.equal((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_backlog' } })).value, 'true', 'the backlog is kept')
    assert.equal((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value, cursorBefore, 'the cursor did not move')
  }
  wcFetchImpl = fakeWooStore([]).impl
  assert.ok(!('skipped' in (await runWcErasureSweepIfDue())), 'the next tick retries immediately')
})

test('[erasure] the sweep has a single owner: two concurrent invocations issue requests from only one; the other reports already-running and writes nothing', { skip }, async (t) => {
  const db = await loadDb()
  const keys = ['wc_erasure_sweep_last_run_at', 'wc_erasure_sweep_backlog']
  await prepareSweep(db, t, () => [])
  t.after(async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) })
  await db.setting.deleteMany({ where: { key: { in: keys } } })
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  const store = fakeWooStore([])
  wcFetchImpl = async (path, params) => { await new Promise((r) => setTimeout(r, 600)); return store.impl(path, params) }
  const [a, b] = await Promise.all([sweepWcAnonymisedOrders(), sweepWcAnonymisedOrders()])
  const owners = [a, b].filter((r) => !r.alreadyRunning)
  assert.equal(owners.length, 1, 'exactly one run owned the sweep')
  assert.equal([a, b].filter((r) => r.alreadyRunning).length, 1)
  assert.equal(store.calls.length, 1, 'only the owner issued a request')
  const skipped = [a, b].find((r) => r.alreadyRunning)!
  assert.deepEqual([skipped.pages, skipped.errors.length], [0, 0])
  // The lease is released: the next run owns it again.
  wcFetchImpl = store.impl
  assert.equal((await sweepWcAnonymisedOrders()).alreadyRunning, false)
})

test('[erasure] the order-first erasure takes the customer row lock and ALL the customer\'s order locks (not only its own row): it waits behind a held customer lock and behind a held lock on the customer\'s OTHER order', { skip }, async (t) => {
  const db = await loadDb()
  const { eraseOrderPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const waits = async (target: string, hold: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, label: string) => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let held!: () => void
    const holding = new Promise<void>((r) => { held = r })
    const holder = db.$transaction(async (tx) => { await hold(tx); held(); await gate }, { timeout: 30_000 })
    await holding
    let done = false
    const erasing = eraseOrderPersonalData(target, { trigger: 'MIRRORED_FROM_STOREFRONT', userId: null }).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 1200))
    assert.equal(done, false, `the erasure is waiting behind the held ${label} lock`)
    release()
    await holder
    assert.equal((await erasing).success, true)
  }
  // Two orders of ONE live customer: erasing one leaves the customer live, so a customer-row lock is the only thing that can make it wait for a held
  // customer lock, and only the customer's all-orders lock can make it wait for a held lock on the OTHER order.
  for (const round of ['customer', 'other order'] as const) {
    const fx = await importFixture(db)
    const wcRateId = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
    const second = fx.externalId + 501 + (round === 'customer' ? 0 : 1)
    // Each round cleans up BEFORE the next imports (both fixtures use the same email, so they would share one customer).
    try {
    assert.equal((await importWcOrder(payload(second, wcRateId) as never)).success, true)
    const otherId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(second) }, select: { orderId: true } })).orderId
    if (round === 'customer') await waits(fx.orderId, (tx) => tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${fx.customerId} FOR UPDATE`, 'customer')
    else await waits(fx.orderId, (tx) => tx.$queryRaw`SELECT id FROM "sales_orders" WHERE id = ${otherId} FOR UPDATE`, "customer's other order")
    } finally {
      await cleanupImported(db, [second], { keepCustomers: true })
      await fx.cleanup()
    }
  }
})

test('[erasure] the obligation helpers: a retired row reads closed, and recording again re-opens it', { skip }, async (t) => {
  const db = await loadDb()
  const id = 1_990_000_000 + Math.floor(Math.random() * 9_000_000)
  t.after(async () => { await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: String(id) } }) })
  const { recordWcErasureObligation, hasOpenWcErasureObligation, retireWcErasureObligation } = await import('@/lib/connectors/woocommerce/sync/erasure-obligation')
  assert.equal(await hasOpenWcErasureObligation(id), false)
  await recordWcErasureObligation(id)
  await recordWcErasureObligation(id)
  assert.equal(await hasOpenWcErasureObligation(id), true)
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(id) } }), 1, 'idempotent')
  await retireWcErasureObligation(id)
  assert.equal(await hasOpenWcErasureObligation(id), false, 'retired reads closed')
  await recordWcErasureObligation(id)
  assert.equal(await hasOpenWcErasureObligation(id), true, 'recording again re-opens it')
})

test('[erasure] the window is read TWICE: an order shifted out of a tie window while its first pass is running is still evaluated', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_940_000_000 + Math.floor(Math.random() * 20_000_000)
  const orders: FakeOrder[] = Array.from({ length: 230 }, (_, i) => ({ id: base + i, mod: T0 + 50_000, marked: true }))
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  const { sweepWcAnonymisedOrders } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  // Request 1 is the plain page, request 2 the window's first page, request 3 its SECOND page: an order already read on page 1 is edited (it leaves the
  // window), every later order shifts down one place, and the one at the page boundary (index 100) is read by neither pass-1 page.
  const store = fakeWooStore(orders, (n) => { if (n === 3) orders[5]!.mod = T0 + 999_000_000_000 })
  wcFetchImpl = store.impl
  const result = await sweepWcAnonymisedOrders({ maxPages: 40 })
  assert.equal(result.errors.length, 0)
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, 230, 'the second pass covered the order the first pass skipped')
})

test('[erasure] a MIRROR error ends the run, leaves the cursor at the last fully processed page, keeps the backlog, and the next run loses nothing', { skip }, async (t) => {
  const db = await loadDb()
  const base = 1_930_000_000 + Math.floor(Math.random() * 20_000_000)
  const orders: FakeOrder[] = Array.from({ length: 250 }, (_, i) => ({ id: base + i, mod: T0 + i * 600_000, marked: true }))
  await prepareSweep(db, t, () => orders.map((o) => o.id))
  t.after(async () => { failMirrorFor = null; await db.setting.deleteMany({ where: { key: { in: ['wc_erasure_sweep_backlog', 'wc_erasure_sweep_last_run_at'] } } }) })
  const { sweepWcAnonymisedOrders, WC_ERASURE_SWEEP_CURSOR_OVERLAP_MS } = await import('@/lib/connectors/woocommerce/sync/anonymisation-sweep')
  wcFetchImpl = fakeWooStore(orders).impl
  failMirrorFor = (id) => Number(id) === orders[150]!.id
  const first = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(first.errors.length, 1, 'one mirror error, and the run stopped')
  const state = JSON.parse((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_cursor' } })).value) as { after: string }
  assert.equal(state.after, new Date(orders[99]!.mod - WC_ERASURE_SWEEP_CURSOR_OVERLAP_MS).toISOString(), 'the cursor is at the end of the last FULLY processed page, not past the failing one')
  assert.equal((await db.setting.findUniqueOrThrow({ where: { key: 'wc_erasure_sweep_backlog' } })).value, 'true')
  failMirrorFor = null
  const second = await sweepWcAnonymisedOrders({ maxPages: 20 })
  assert.equal(second.errors.length, 0)
  assert.equal((await obligationIds(db, orders.map((o) => o.id))).size, 250, 'the next run covered everything, including the order that failed')
})

test('[erasure] an UNMATCHED return cleared by the erasure stays erased: a later poll that resolves it to no order cannot write the raw record or the reason back', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const { runMintsoftReturnsSync } = await import('@/lib/connectors/mintsoft/sync/returns-sync')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const uid = randomUUID().slice(0, 8)
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `unm-${uid}`, active: true }, select: { id: true } })
  const binding = await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: fx.warehouseId, connector: 'mintsoft', externalWarehouseId: `ext-${uid}`, active: true, returnsMode: 'POLL' } as never, select: { id: true } })
  const returnId = `RET-UNM-${uid}`
  t.after(async () => {
    pollReturnsRecords = null
    await db.wmsReturnsInbox.deleteMany({ where: { externalReturnId: returnId } })
    await db.externalWmsBinding.deleteMany({ where: { id: binding.id } })
    await db.wmsConnection.deleteMany({ where: { id: connection.id } })
    await fx.cleanup()
  })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId }, select: { orderNumber: true } })
  // The return was staged with NO order link (the warehouse's reference did not resolve then), carrying the recipient's raw record and a reason.
  await db.wmsReturnsInbox.create({ data: { connector: 'mintsoft', externalReturnId: returnId, orderId: null, reference: order.orderNumber, reason: `${FULL_NAME} says broken`, rawPayload: { Customer: { Name: FULL_NAME }, Note: STREET } } as never })
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const after = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { connector_externalReturnId: { connector: 'mintsoft', externalReturnId: returnId } } })
  assert.ok(after.erasedAt, 'the erasure marked the row')
  assert.deepEqual(after.rawPayload, {})
  // A later poll: the same return, a reference that resolves to NO order now, and the raw record again.
  pollReturnsRecords = () => [{
    externalReturnId: returnId, externalWarehouseId: `ext-${uid}`, sku: 'SKU-RET', qty: 1, orderReference: 'NO-SUCH-REFERENCE', reason: `${FULL_NAME} says it arrived broken`,
    receivedAt: '2026-11-04T10:00:00.000Z', raw: { Customer: { Name: FULL_NAME }, Note: `Collect from ${STREET}` },
  }]
  await runMintsoftReturnsSync('test')
  const again = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { connector_externalReturnId: { connector: 'mintsoft', externalReturnId: returnId } } })
  assert.deepEqual(again.rawPayload, {}, 'the raw record is not written back')
  assert.ok(again.reason === null || again.reason === 'Text removed by GDPR erasure', 'the reason is not written back')
  assert.equal(again.erasedAt?.getTime(), after.erasedAt?.getTime(), 'the marker stays')
  // ... and the trigger honours the marker for ANY writer.
  await db.$executeRaw`UPDATE "wms_returns_inbox" SET "reason" = ${`from ${FULL_NAME}`}, "rawPayload" = ${JSON.stringify({ n: FULL_NAME })}::jsonb WHERE "externalReturnId" = ${returnId}`
  const forced = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { connector_externalReturnId: { connector: 'mintsoft', externalReturnId: returnId } } })
  assert.deepEqual(forced.rawPayload, {}); assert.equal(forced.reason, 'Text removed by GDPR erasure')
  const logs = await db.wmsSyncLog.findMany({ where: { sku: 'SKU-RET', job: { type: 'RETURNS_SYNC' } } })
  assert.ok(logs.every((l) => !JSON.stringify(l.payload).includes(STREET)))
})
