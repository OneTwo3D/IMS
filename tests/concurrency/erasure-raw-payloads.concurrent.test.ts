import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => { return { connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' } },
      queueAccountingSync: async () => ({ queued: true }),
      // The held-invoice release enqueues inside its order-locked transaction.
      queueAccountingSyncTxWithOutcome: async () => ({ queued: true, connector: 'xero' }),
    },
  })
  accountingMocked = true
}

let actionsMocked = false
async function mockActionEnvironment() {
  if (actionsMocked) return
  const actual = await import('@/lib/auth/server')
  // Every `require*` guard answers with an admin session; nothing else in the module changes.
  const session = { user: { id: undefined as unknown as string, role: 'ADMIN', name: 'Test Admin', email: 'admin@example.test' } }
  const guards = Object.fromEntries(Object.keys(actual).filter((k) => k.startsWith('require')).map((k) => [k, async () => session]))
  mock.module('@/lib/auth/server', { namedExports: { ...actual, ...guards } })
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
    line_items: [{ id: 1, name: `Widget for ${NAME.first}`, parent_name: `Gift for ${NAME.last}`, product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
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

/**
 * THE RAW PAYLOAD STORES AGAINST A REAL POSTGRES (the copies of connector payloads an erasure has to reach), through the real importer and the real erasure.
 * One order is imported from a WooCommerce payload; every raw store is then filled with distinctive identity (a name, a gift receiver's email, an IP, a user
 * agent, tracking numbers, a warehouse return record) and the customer is erased. Every token must be gone from every row, the currency / totals / tax /
 * line / reason evidence must survive, payloadHash must not move, and a row written AFTER the erasure must arrive already projected.
 * No network: `fetch` is counted throughout (and the test:concurrency preload refuses any non-loopback socket).
 */

const GIFT = `giftreceiver.quillfeather+${randomUUID().slice(0, 6)}@example.test`
const IP = '203.0.113.77'
const UA = 'Mozilla/5.0 (QuillBrowser 9.9)'
const ORDER_KEY_TOKEN = 'wc_order_QUILLKEY123'
const TRACK_TOKEN = 'TRK-RAW-777'
const REFUND_REASON = 'Item arrived damaged, kept per the retention ruling'
const RAW_TOKENS = [NAME.first, NAME.last, EMAIL, PHONE, COMPANY, STREET, POSTCODE, GIFT, IP, UA, ORDER_KEY_TOKEN, TRACK_TOKEN, 'Mrs Quillfeather', 'Leeds', ORDER_NOTE]

/** The refund reason is free text KEPT by owner ruling: remove it (when it is a string) before looking for fragments; a non-string reason must be gone already. */
function stripKeptText(v: unknown): string {
  const o = JSON.parse(JSON.stringify(v ?? null)) as Record<string, unknown> | null
  if (o && typeof o === 'object') {
    if (typeof o.reason === 'string') delete o.reason
    if (Array.isArray(o.refunds)) for (const r of o.refunds as Array<Record<string, unknown>>) if (r && typeof r.reason === 'string') delete r.reason
  }
  return JSON.stringify(o)
}

const sha = (body: string) => createHash('sha256').update(body).digest('hex')
const rowText = (row: unknown) => JSON.stringify(row)
const leaks = (row: unknown) => RAW_TOKENS.filter((tok) => rowText(row).includes(tok))

function rawOrder(fx: Fixture, wcRateId: number, over: Record<string, unknown> = {}) {
  const base = payload(fx.externalId, wcRateId) as Record<string, unknown>
  return {
    ...base,
    customer_id: fx.wooCustomerId, customer_ip_address: IP, customer_user_agent: UA, order_key: ORDER_KEY_TOKEN, cart_hash: 'abc123hash',
    transaction_id: 'TXN-RAW-1', payment_url: `https://shop.example.test/checkout/order-pay/${fx.externalId}/?key=${ORDER_KEY_TOKEN}`,
    version: '9.4.1', created_via: 'checkout', currency_symbol: '£', wpo_wcpdf_invoice_number: 'INV-RAW-1', cost_of_goods_sold: { total_value: '12.00' },
    _links: { self: [{ href: `https://shop.example.test/wp-json/wc/v3/orders/${fx.externalId}` }], customer: [{ href: `https://shop.example.test/wp-json/wc/v3/customers/${fx.wooCustomerId}` }] },
    meta_data: [
      { id: 1, key: '_base_currency_exchange_rate', value: '1.2345' },
      { id: 2, key: 'gift_receiver_email', value: GIFT },
      { id: 3, key: 'temp_gift_card_receivers_emails', value: [GIFT] },
      { id: 4, key: '_wc_shipment_tracking_items', value: [{ tracking_number: TRACK_TOKEN }] },
      { id: 5, key: '_order_total_base_currency', value: '126.00' },
      { id: 6, key: '_wcpdf_invoice_number', value: 'INV-RAW-1' },
    ],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 2, price: 50, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${fx.externalId}`, image: { id: 1, src: 'https://shop.example.test/x.png' },
      taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }],
      meta_data: [{ id: 8, key: '_line_total_base_currency', value: '100.00' }, { id: 9, key: 'Engraving', value: `For ${NAME.first}` }] }],
    refunds: [{ id: 5551, reason: REFUND_REASON, total: '-10.00' }],
    ...over,
  }
}
function rawRefund(fx: Fixture) {
  return { id: 5551, parent_id: fx.externalId, date_created: '2026-11-03T10:00:00', date_created_gmt: '2026-11-03T10:00:00', amount: '10.00', reason: REFUND_REASON, refunded_by: 42, refunded_payment: false,
    meta_data: [{ id: 1, key: 'note', value: `Refund for ${FULL_NAME}` }],
    line_items: [{ id: 77, name: 'Widget', product_id: 1, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-5.00', subtotal_tax: '-1.00', total: '-5.00', total_tax: '-1.00', sku: 'S', refund_total: -5, meta_data: [{ id: 3, key: '_refunded_item_id', value: '1' }, { id: 4, key: 'Engraving', value: NAME.first }] }] }
}

type RawRows = { inboxOrder: string; inboxPending: string; inboxRefund: string; inboxCustomerOnly: string; inboxOther: string; queued: string; park: string; parkOther: string; tracking: string; held: string }

async function seedRaw(db: Awaited<ReturnType<typeof loadDb>>, fx: Fixture, extraCleanup: Array<() => Promise<void>>): Promise<RawRows & { rawBody: string; otherOrderBody: string }> {
  const rateMap = await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })
  const wcRate = Number(rateMap.externalTaxRateId)
  const order = rawOrder(fx, wcRate)
  const rawBody = JSON.stringify(order)
  const mk = async (resource: string, body: unknown, status = 'PROCESSED', lastError: string | null = null) => {
    const text = JSON.stringify(body) + randomUUID()
    const row = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource, topic: 'order.updated', payloadHash: resource === 'orders' && body === order ? sha(rawBody) : sha(text), payloadJson: body as never, status, lastError } })
    extraCleanup.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: row.id } }) })
    return row.id
  }
  const inboxOrder = await mk('orders', order)
  const inboxPending = await mk('orders', { ...order, status: 'on-hold' }, 'PENDING', `HTTP 500: ${FULL_NAME} at ${STREET}`)
  const inboxRefund = await mk('refunds', rawRefund(fx))
  // The same person's order IMS never imported: found only through the storefront customer id.
  const inboxCustomerOnly = await mk('orders', { ...order, id: fx.externalId + 7_000_000_000 })
  const otherId = fx.externalId + 1
  const otherOrderBody = JSON.stringify({ ...order, id: otherId, customer_id: 1, billing: { ...WC_ADDRESS, first_name: 'Otherperson' } })
  const inboxOther = await mk('orders', JSON.parse(otherOrderBody))
  const mkLog = async (data: Record<string, unknown>) => {
    const row = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', ...data } as never })
    extraCleanup.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: row.id } }) })
    return row.id
  }
  // A queue row for an order IMS holds but has not imported YET: entityId null, externalId = the storefront order id.
  const queued = await mkLog({ externalId: String(fx.externalId), payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: String(fx.externalId), externalOrderNumber: String(fx.externalId), currency: 'GBP', asOf: null, order }, errorMessage: `rate missing for ${FULL_NAME}` })
  const park = await mkLog({ entityId: fx.orderId, externalId: '5551', recordKind: 'WC_REFUND_PARK', payload: rawRefund(fx), errorMessage: `refund 5551 failed for ${FULL_NAME}` })
  // ANOTHER order's refund park whose externalId happens to equal this order's storefront id: the numbers share one space and it is NOT ours.
  const parkOther = await mkLog({ entityId: `other-${fx.orderId}`, externalId: String(fx.externalId), recordKind: 'WC_REFUND_PARK', payload: { ...rawRefund(fx), id: fx.externalId, reason: 'someone else reason' } })
  const tracking = await mkLog({ entityId: fx.orderId, externalId: String(fx.externalId), direction: 'TO_CONNECTOR', status: 'SYNCED', payload: { meta_key: '_wc_shipment_tracking_items', items: [{ tracking_number: TRACK_TOKEN, tracking_provider: 'Royal Mail' }] } })
  const held = await mkLog({ entityId: fx.orderId, externalId: String(fx.externalId), recordKind: 'WC_HELD_SALES_INVOICE', payload: { reason: 'missing_wc_invoice_number', accountingPayload: { contactName: 'Held Name', lines: [] } } })
  return { inboxOrder, inboxPending, inboxRefund, inboxCustomerOnly, inboxOther, queued, park, parkOther, tracking, held, rawBody, otherOrderBody }
}

const ev = (db: Awaited<ReturnType<typeof loadDb>>, id: string) => db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })
const lg = (db: Awaited<ReturnType<typeof loadDb>>, id: string) => db.shoppingSyncLog.findUniqueOrThrow({ where: { id } })

test('[raw payloads] the erasure projects every raw store: identity gone, currency / totals / tax / lines / refund reason kept, payloadHash unmoved, other orders untouched', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  const spy = spyOnFetch()
  t.after(async () => { spy.restore(); for (const c of cleanups) await c(); await db.wmsSyncLog.deleteMany({ where: { jobId: { in: jobIds } } }); await db.wmsSyncJob.deleteMany({ where: { id: { in: jobIds } } }); await db.wmsReturnsInbox.deleteMany({ where: { externalReturnId: { in: returnIds } } }); await fx.cleanup() })
  const jobIds: string[] = []
  const returnIds: string[] = []
  const rows = await seedRaw(db, fx, cleanups)
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId }, select: { orderNumber: true } })
  // Warehouse return records: one linked to the order, one with NO order link whose reference is the order's number, one for somebody else.
  const job = await db.wmsSyncJob.create({ data: { connector: 'mintsoft', type: 'RETURNS_SYNC', status: 'SUCCEEDED', startedAt: new Date() } as never })
  jobIds.push(job.id)
  const retUnmatched = `RET-RAW-${randomUUID().slice(0, 6)}`; returnIds.push(retUnmatched)
  const unmatchedInbox = await db.wmsReturnsInbox.create({ data: { connector: 'mintsoft', externalReturnId: retUnmatched, orderId: null, reference: order.orderNumber, reason: `from ${FULL_NAME}`, rawPayload: { Customer: { Name: FULL_NAME }, Note: STREET } } as never })
  const rawRecord = { ReturnId: retUnmatched, OrderReference: order.orderNumber, Recipient: { Name: FULL_NAME, Address: STREET } }
  const rawLog = await db.wmsSyncLog.create({ data: { jobId: job.id, action: 'created', payload: rawRecord } as never })
  const otherLog = await db.wmsSyncLog.create({ data: { jobId: job.id, action: 'created', payload: { ReturnId: 'RET-OTHER', OrderReference: 'NOT-THIS-ORDER', Recipient: { Name: 'Somebody Else' } } } as never })
  const otherInbox = await db.wmsReturnsInbox.create({ data: { connector: 'mintsoft', externalReturnId: `RET-OTHER-${randomUUID().slice(0, 4)}`, orderId: null, reference: 'NOT-THIS-ORDER', reason: 'other person', rawPayload: { Name: 'Somebody Else' } } as never })
  returnIds.push(otherInbox.externalReturnId)

  const before = { order: await ev(db, rows.inboxOrder), other: await ev(db, rows.inboxOther), parkOther: await lg(db, rows.parkOther), held: await lg(db, rows.held) }
  assert.ok(leaks(before.order.payloadJson).length > 5, 'PRECONDITION: the raw order carries the identity')

  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, true, JSON.stringify(result))

  // (a) no token survives in any raw row of the subject, errors included
  for (const id of [rows.inboxOrder, rows.inboxPending, rows.inboxRefund, rows.inboxCustomerOnly]) {
    const row = await ev(db, id)
    assert.deepEqual(leaks(row), [], `webhook inbox row ${id} holds no identity`)
    assert.equal((row.payloadJson as Record<string, unknown>)._erasure_projected, true)
  }
  assert.equal((await ev(db, rows.inboxPending)).lastError, 'Text removed by GDPR erasure', 'an echoed error is cleared')
  for (const id of [rows.queued, rows.park, rows.tracking]) assert.deepEqual(leaks(await lg(db, id)), [], `sync log ${id} holds no identity`)
  assert.deepEqual(leaks(await db.wmsSyncLog.findUniqueOrThrow({ where: { id: rawLog.id } })), [])
  const un = await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: unmatchedInbox.id } })
  assert.deepEqual(leaks(un), [], 'a return with NO order link is cleared too (#844 reaches only linked rows)')

  // (b) the evidence survives
  type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- reading a JSON payload field by field
  const o = (await ev(db, rows.inboxOrder)).payloadJson as J
  assert.equal(o.currency, 'GBP'); assert.equal(o.total, '126.00'); assert.equal(o.total_tax, '21.00'); assert.equal(o.id, fx.externalId)
  assert.equal(o.version, '9.4.1'); assert.equal(o.created_via, 'checkout'); assert.equal(o.date_created_gmt, '2026-11-02T09:00:00')
  assert.equal(o.tax_lines[0].tax_total, '20.00'); assert.equal(o.tax_lines[0].rate_code, 'GB-VAT-1')
  assert.equal(o.line_items[0].name, `NOSKU-${fx.externalId}`, 'a free-text item name becomes the SKU'); assert.equal('parent_name' in o.line_items[0], false)
  assert.equal(o.line_items[0].quantity, 2); assert.equal(o.line_items[0].price, 50); assert.equal(o.line_items[0].total, '100.00')
  assert.deepEqual(o.line_items[0].meta_data.map((m: { key: string }) => m.key), ['_line_total_base_currency'], 'line meta is allowlisted')
  assert.deepEqual(o.meta_data.map((m: { key: string }) => m.key), ['_base_currency_exchange_rate', '_order_total_base_currency', '_wcpdf_invoice_number'])
  assert.equal(o.billing.country, 'GB', 'the 2-letter country is kept (VAT place of supply)'); assert.equal(o.billing.postcode, ''); assert.equal(o.billing.email, '')
  assert.equal(o.transaction_id, '0', 'mirrors the storefront eraser'); assert.equal(o.customer_id, 0)
  assert.equal(o.refunds[0].reason, REFUND_REASON, 'refund reason is KEPT')
  const refund = (await ev(db, rows.inboxRefund)).payloadJson as J
  assert.equal(refund.reason, REFUND_REASON); assert.equal(refund.amount, '10.00'); assert.equal(refund.parent_id, fx.externalId); assert.equal(refund.refunded_by, 0)
  assert.deepEqual(refund.line_items[0].meta_data, [{ id: 3, key: '_refunded_item_id', value: '1' }], 'the refund line link the park readers need survives')
  const park = await lg(db, rows.park)
  assert.equal((park.payload as { amount: string }).amount, '10.00'); assert.equal(park.status, 'PENDING'); assert.equal(park.entityId, fx.orderId); assert.equal(park.recordKind, 'WC_REFUND_PARK')
  const queued = (await lg(db, rows.queued)).payload as { externalOrderId: string; order: Record<string, unknown> }
  assert.equal(queued.externalOrderId, String(fx.externalId)); assert.equal(queued.order.id, fx.externalId)
  assert.deepEqual(((await lg(db, rows.tracking)).payload as { items: unknown[]; meta_key: string }), { meta_key: '_wc_shipment_tracking_items', items: [], _erasure_projected: true })

  // (c) idempotency evidence: the hash column did not move, so the ORIGINAL body is still a duplicate; the compaction predicate still sees a payload
  assert.equal((await ev(db, rows.inboxOrder)).payloadHash, before.order.payloadHash)
  const { persistWcWebhookEvent, createShoppingWebhookEventRepository } = await import('@/lib/connectors/shopping-webhook-inbox')
  const again = await persistWcWebhookEvent(createShoppingWebhookEventRepository({ client: db as never }), { resource: 'orders', topic: 'order.updated', externalEventId: null, rawBody: rows.rawBody, payload: JSON.parse(rows.rawBody) } as never)
  assert.equal(again.status, 'duplicate', 'a redelivery of the original body is still detected as a duplicate')
  assert.equal(again.event.id, rows.inboxOrder)

  // (d) untouched: another order's delivery, another order's park with a colliding externalId, the held invoice (the contact step owns it), another subject's return
  assert.deepEqual((await ev(db, rows.inboxOther)).payloadJson, before.other.payloadJson)
  assert.deepEqual((await lg(db, rows.parkOther)).payload, before.parkOther.payload)
  assert.equal((await lg(db, rows.parkOther)).errorMessage, before.parkOther.errorMessage)
  assert.equal(rowText((await lg(db, rows.held)).payload).includes('Held Name'), false, 'the held invoice is scrubbed by its own step')
  assert.ok(rowText((await db.wmsSyncLog.findUniqueOrThrow({ where: { id: otherLog.id } })).payload).includes('Somebody Else'))
  assert.ok(rowText((await db.wmsReturnsInbox.findUniqueOrThrow({ where: { id: otherInbox.id } })).rawPayload).includes('Somebody Else'))

  // (e) the proof counts the work and names nobody
  const proof = await db.activityLog.findFirstOrThrow({ where: { action: 'gdpr_erasure_recorded', entityId: fx.customerId } })
  const counts = (proof.metadata as { counts: Record<string, number> }).counts
  assert.ok(counts.rawWebhookEventsProjected >= 4 && counts.rawSyncLogsProjected >= 3 && counts.rawReturnRecordsCleared >= 2, JSON.stringify(counts))
  assert.equal(counts.storefrontIdMissing, 0)
  assert.deepEqual(leaks(proof), [])
  assert.equal(spy.calls(), 0, 'no network call')

  // (f) idempotent: a second projection finds nothing to change
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.deepEqual(await reconcileRawPayloads(db), { projected: 0, remaining: 0 })
})

test('[raw payloads] writers AFTER the erasure: the guard triggers project a delivery, a queue row and an error written for an erased order, whoever writes it; a live order is untouched', { skip }, async (t) => {
  const db = await loadDb()
  const gone = await importFixture(db)
  // A LIVE order is any id the erasure never touched: a distinct storefront id and an IMS order id that is not erased.
  const live = { externalId: gone.externalId + 11, orderId: `live-${gone.orderId}`, wooCustomerId: 5 } as unknown as Fixture
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { for (const c of cleanups) await c(); await gone.cleanup(); await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: obligationId } }) })
  const obligationId = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000))
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(gone.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: gone.rateId } })).externalTaxRateId)
  const liveRate = rate

  const ins = async (fx: Fixture, r: number, id?: number) => {
    const body = rawOrder(fx, r, id ? { id } : {})
    const row = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.updated', payloadHash: sha(JSON.stringify(body) + randomUUID()), payloadJson: body as never, status: 'PENDING' } })
    cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: row.id } }) })
    return row
  }
  // (1) a delivery for an ERASED order is stored already projected; (2) for a LIVE order it is stored verbatim
  const erasedRow = await ins(gone, rate)
  assert.deepEqual(leaks(erasedRow.payloadJson), [], 'the insert for an erased order is projected')
  const liveRow = await ins(live, liveRate)
  assert.ok(leaks(liveRow.payloadJson).includes(IP), 'a live order keeps its raw delivery')
  // (3) an error written later is cleared; the markers are applied to an UPDATE too
  const failed = await db.shoppingWebhookEvent.update({ where: { id: erasedRow.id }, data: { status: 'FAILED', lastError: `boom ${FULL_NAME}` } })
  assert.equal(failed.lastError, 'Text removed by GDPR erasure')
  assert.equal((await db.shoppingWebhookEvent.update({ where: { id: liveRow.id }, data: { lastError: 'boom live' } })).lastError, 'boom live')
  // (4) an order IMS does not hold yet but has an OPEN erasure obligation for
  await db.storefrontOrderErasureObligation.create({ data: { connector: 'woocommerce', externalOrderId: obligationId } })
  const futureBody = rawOrder(gone, rate, { id: Number(obligationId) })
  const futureRow = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.created', payloadHash: sha(randomUUID()), payloadJson: futureBody as never, status: 'PENDING' } })
  cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: futureRow.id } }) })
  assert.deepEqual(leaks(futureRow.payloadJson), [], 'a delivery for an order with an open obligation is projected')
  // (5) sync logs: a park and an error for the erased order; a tracking log; and the live order's park stays raw
  const mk = async (fx: Fixture, data: Record<string, unknown>) => { const row = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: '5551', ...data } as never }); cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: row.id } }) }); return row }
  const parkGone = await mk(gone, { recordKind: 'WC_REFUND_PARK', payload: rawRefund(gone), errorMessage: `failed for ${FULL_NAME}` })
  assert.deepEqual(leaks(parkGone), [])
  const parkLive = await mk(live, { externalId: '5552', recordKind: 'WC_REFUND_PARK', payload: rawRefund(live), errorMessage: `failed for ${FULL_NAME}` })
  assert.ok(leaks(parkLive).includes(NAME.first), 'a live order keeps its park')
  const trackGone = await mk(gone, { direction: 'TO_CONNECTOR', status: 'SYNCED', payload: { meta_key: '_wc_shipment_tracking_items', items: [{ tracking_number: TRACK_TOKEN }] } })
  assert.deepEqual(leaks(trackGone), [])
  const updated = await db.shoppingSyncLog.update({ where: { id: parkGone.id }, data: { errorMessage: `again ${FULL_NAME}`, payload: rawRefund(gone) as never } })
  assert.deepEqual(leaks(updated), [], 'an UPDATE is projected too')
  // (6) a status push (ids only) is not rewritten
  const push = await mk(gone, { direction: 'TO_CONNECTOR', status: 'SYNCED', payload: { status: 'completed', pushedDateModifiedGmt: '2026-11-02T10:00:00' } })
  assert.deepEqual(push.payload, { status: 'completed', pushedDateModifiedGmt: '2026-11-02T10:00:00', _erasure_projected: true }, 'a status push is rebuilt from its two typed fields')
})

test('[raw payloads] a row the trigger could not see (inserted while an erasure was uncommitted) is cleared by the reconcile pass', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"'); for (const c of cleanups) await c(); await fx.cleanup() })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" DISABLE TRIGGER "shopping_webhook_events_erased_projection"')
  const body = rawOrder(fx, rate)
  const row = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.updated', payloadHash: sha(randomUUID()), payloadJson: body as never, status: 'PROCESSED' } })
  cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: row.id } }) })
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"')
  assert.ok(leaks(await ev(db, row.id)).length > 3, 'PRECONDITION: the straggler holds raw identity')
  const out = await reconcileRawPayloads(db)
  assert.equal(out.remaining, 0); assert.ok(out.projected >= 1)
  assert.deepEqual(leaks(await ev(db, row.id)), [])
  assert.equal((await ev(db, row.id)).payloadHash, row.payloadHash)
})

test('[raw payloads] a projection that did not take FAILS the erasure and rolls it back: nothing is erased, nothing is half-projected', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_undo_projection ON "shopping_webhook_events"'); await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_undo_projection()'); for (const c of cleanups) await c(); await fx.cleanup() })
  const rows = await seedRaw(db, fx, cleanups)
  // A saboteur: a trigger that puts the original payload back, so the post-write check sees a row still carrying identity.
  await db.$executeRawUnsafe(`CREATE FUNCTION test_undo_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."payloadJson" ? 'billing' THEN NEW."payloadJson" := OLD."payloadJson"; END IF; RETURN NEW; END $$`)
  await db.$executeRawUnsafe('CREATE TRIGGER test_undo_projection BEFORE UPDATE OF "payloadJson" ON "shopping_webhook_events" FOR EACH ROW EXECUTE FUNCTION test_undo_projection()')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const result = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(result.success, false, 'the erasure reports failure')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt, null, 'the order is NOT marked erased')
  assert.equal((await db.customer.findUniqueOrThrow({ where: { id: fx.customerId } })).gdprAnonymisedAt, null)
  assert.ok(leaks(await lg(db, rows.park)).length > 0, 'a sync log row was not half-projected')
})

test('[raw payloads] the projection keeps what the readers read: a projected queue snapshot still passes the replay guard and imports, a projected park still yields its amount and refunded quantities', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { for (const c of cleanups) await c(); await fx.cleanup() })
  const rows = await seedRaw(db, fx, cleanups)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const { isQueuedWcOrderPayload, importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const queued = (await lg(db, rows.queued)).payload
  assert.equal(isQueuedWcOrderPayload(queued), true, 'the replay guard still accepts the projected snapshot')
  const replay = await importWcOrder((queued as { order: unknown }).order as never)
  assert.equal(replay.success, true, `the projected snapshot replays: ${JSON.stringify(replay)}`)
  const after = await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId }, select: { customerName: true, customerEmail: true, billingAddress: true, erasedAt: true } })
  assert.deepEqual(leaks(after), [], 'the replay brings no identity back')
  assert.ok(after.erasedAt)
  const refund = (await lg(db, rows.park)).payload as { amount: string; line_items: Array<{ quantity: number; meta_data: Array<{ key: string; value: string }> }> }
  assert.equal(Number(refund.amount), 10)
  assert.equal(Math.abs(refund.line_items[0]!.quantity), 1)
  assert.equal(refund.line_items[0]!.meta_data.find((m) => m.key === '_refunded_item_id')?.value, '1')
})

test('[raw payloads] the inbox compaction predicate is undisturbed: a projected row still reads as carrying a payload, an already-compacted row stays {} and is not "dirty"', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { for (const c of cleanups) await c(); await fx.cleanup() })
  const rows = await seedRaw(db, fx, cleanups)
  const compacted = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.updated', payloadHash: sha(randomUUID()), payloadJson: {}, status: 'PROCESSED' } })
  cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: compacted.id } }) })
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const { compactableShoppingWebhookEventWhere, PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE } = await import('@/lib/connectors/shopping-webhook-retention')
  assert.equal(PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE, true, 'the hold is untouched by this work')
  const future = new Date(Date.now() + 86_400_000)
  const mine = { id: { in: [rows.inboxOrder, rows.inboxRefund, compacted.id] } }
  // The hold covers ORDER deliveries only; a refund delivery was always compactable, and a compacted row is never re-selected.
  assert.deepEqual((await db.shoppingWebhookEvent.findMany({ where: { AND: [mine, compactableShoppingWebhookEventWhere(future)] }, select: { id: true } })).map((r) => r.id), [rows.inboxRefund], 'held order deliveries are still exempt, projected or not')
  const withoutHold = { ...compactableShoppingWebhookEventWhere(future), AND: undefined }
  // With the hold removed from the predicate (what a reviewed lift would do) the projected rows ARE compactable once, and the compacted one is not re-selected.
  const eligible = await db.shoppingWebhookEvent.findMany({ where: { AND: [mine, withoutHold] }, select: { id: true } })
  assert.deepEqual(eligible.map((e) => e.id).sort(), [rows.inboxOrder, rows.inboxRefund].sort(), 'a projected payload is not {}, so it is selected exactly once')
  assert.deepEqual((await ev(db, compacted.id)).payloadJson, {})
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.equal((await reconcileRawPayloads(db)).remaining, 0)
  assert.deepEqual((await ev(db, compacted.id)).payloadJson, {}, 'the reconcile never rewrites a compacted row')
})

test('[raw payloads] key census: every key of a real-shaped order is classified keep / neutralised / dropped, so a key this projection has not heard of FAILS here instead of silently surviving', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const KEEP = ['id', 'parent_id', 'number', 'status', 'currency', 'currency_symbol', 'version', 'created_via', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'date_paid', 'date_paid_gmt', 'date_completed', 'date_completed_gmt', 'prices_include_tax', 'discount_total', 'discount_tax', 'shipping_total', 'shipping_tax', 'cart_tax', 'total', 'total_tax', 'payment_method', 'payment_method_title', 'needs_payment', 'needs_processing', 'is_editable', 'wpo_wcpdf_invoice_number', 'cost_of_goods_sold', 'store_credit_used', 'tax_lines', 'refunds', 'line_items', 'shipping_lines', 'fee_lines', 'coupon_lines', 'meta_data']
  const NEUTRALISED = ['billing', 'shipping', 'customer_id', 'customer_note', 'customer_ip_address', 'customer_user_agent', 'order_key', 'payment_url', 'cart_hash', 'transaction_id']
  const DROPPED = ['_links', 'shipping_tax_total']
  const sample = rawOrder(fx, rate)
  // The top-level key names of a captured order delivery (key census of a real store's inbox, names only): a key a real order carries that is in none of the lists fails.
  const CAPTURED_TOP_LEVEL_KEYS = ['wpo_wcpdf_invoice_number', 'billing', 'cart_hash', 'cart_tax', 'transaction_id', 'version', '_links', 'cost_of_goods_sold', 'coupon_lines', 'created_via', 'currency', 'currency_symbol', 'customer_id', 'customer_ip_address', 'customer_note', 'customer_user_agent', 'date_completed', 'date_completed_gmt', 'date_created', 'date_created_gmt', 'date_modified', 'date_modified_gmt', 'date_paid', 'date_paid_gmt', 'discount_tax', 'discount_total', 'fee_lines', 'id', 'is_editable', 'line_items', 'meta_data', 'needs_payment', 'needs_processing', 'number', 'order_key', 'parent_id', 'payment_method', 'payment_method_title', 'payment_url', 'prices_include_tax', 'refunds', 'shipping', 'shipping_lines', 'shipping_tax', 'shipping_total', 'status', 'store_credit_used', 'tax_lines', 'total', 'total_tax']
  const WC_FULL_ORDER_FIXTURES: Array<Record<string, unknown>> = [Object.fromEntries(CAPTURED_TOP_LEVEL_KEYS.map((k) => [k, null]))]
  const seen = new Set<string>([...Object.keys(sample), ...WC_FULL_ORDER_FIXTURES.flatMap((o) => Object.keys(o))])
  const unclassified = [...seen].filter((k) => ![...KEEP, ...NEUTRALISED, ...DROPPED].includes(k))
  assert.deepEqual(unclassified, [], `classify these keys of the captured order shape in the projection (migration) and in this test: ${unclassified.join(', ')}`)
  const projected = (await db.$queryRaw<Array<{ p: Record<string, unknown> }>>`SELECT gdpr_project_wc_order(${JSON.stringify(sample)}::jsonb) AS p`)[0]!.p
  const out = Object.keys(projected)
  assert.deepEqual(out.filter((k) => k !== '_erasure_projected' && ![...KEEP, ...NEUTRALISED].includes(k)), [], 'the projection emits nothing outside keep + neutralised')
  for (const k of DROPPED) assert.equal(k in projected, false, `${k} is dropped`)
  // idempotent
  const twice = (await db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_wc_order(${JSON.stringify(projected)}::jsonb) AS p`)[0]!.p
  assert.deepEqual(twice, projected)
})

test('[raw payloads] fee and item names: a personalised name is dropped, a credit-named fee keeps its name (the coupon classifier reads it), the wclc markers survive', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const sample = rawOrder(fx, rate, {
    fee_lines: [
      { id: 1, name: `Gift wrap for ${NAME.first}`, tax_class: '', tax_status: 'taxable', total: '2.00', total_tax: '0.40', taxes: [], meta_data: [{ id: 1, key: '_wclc_fee', value: 'yes' }, { id: 2, key: '_wclc_fee_kind', value: 'duty' }, { id: 3, key: 'note', value: NAME.last }] },
      { id: 2, name: 'Store Credit', tax_class: '', tax_status: 'none', total: '-5.00', total_tax: '0.00', taxes: [], meta_data: [] },
      { id: 3, name: `Gift card for ${NAME.first} ${NAME.last} (${EMAIL})`, tax_class: '', tax_status: 'none', total: '-3.00', total_tax: '0.00', taxes: [], meta_data: [] },
      { id: 4, name: `TeraWallet payment ${NAME.last}`, tax_class: '', tax_status: 'none', total: '-1.00', total_tax: '0.00', taxes: [], meta_data: [] },
    ],
  })
  const p = (await db.$queryRaw<Array<{ p: Record<string, unknown> }>>`SELECT gdpr_project_wc_order(${JSON.stringify(sample)}::jsonb) AS p`)[0]!.p as { fee_lines: Array<{ name: string; total: string; meta_data: Array<{ key: string }> }> }
  assert.deepEqual(leaks(p), [])
  assert.equal(p.fee_lines[0]!.name, 'Fee'); assert.equal(p.fee_lines[0]!.total, '2.00')
  assert.deepEqual(p.fee_lines[0]!.meta_data.map((m) => m.key), ['_wclc_fee', '_wclc_fee_kind'])
  assert.equal(p.fee_lines[1]!.name, 'Store credit', 'a credit fee gets a FIXED label, never the original text')
  assert.equal(p.fee_lines[2]!.name, 'Gift card'); assert.equal(p.fee_lines[3]!.name, 'Wallet')
  // the classifier reaches the same verdict on the projected fees as on the originals
  const { classifyWcCouponLines } = await import('@/lib/connectors/woocommerce/sync/coupon-classification')
  const verdict = (fees: unknown) => classifyWcCouponLines([], [], fees as never).signalProblems.length
  assert.equal(verdict(p.fee_lines), verdict((sample as unknown as { fee_lines: unknown }).fee_lines), 'classification unchanged')
  assert.ok(verdict(p.fee_lines) >= 3, 'PRECONDITION: the negative credit fees are problems both ways')
  // the refund line name too
  const r = (await db.$queryRaw<Array<{ p: { line_items: Array<{ name: string }> } }>>`SELECT gdpr_project_wc_refund(${JSON.stringify({ ...rawRefund(fx), line_items: [{ ...rawRefund(fx).line_items[0], name: `Mug for ${NAME.first}` }] })}::jsonb) AS p`)[0]!.p
  assert.deepEqual(leaks(r), [])
})

test('[raw payloads] a delivery for an order IMS does not hold, found only through the customer id, leaves an order-keyed obligation: its redelivery is projected on insert and a later import creates it ERASED', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  const unheldId = fx.externalId + 7_000_000_000
  t.after(async () => {
    for (const c of cleanups) await c()
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(unheldId) } })
    if (link) { await db.accountingSyncLog.deleteMany({ where: { referenceId: link.orderId } }); await db.salesOrderLine.deleteMany({ where: { orderId: link.orderId } }); await db.activityLog.deleteMany({ where: { entityId: link.orderId } }); await db.shoppingOrderLink.deleteMany({ where: { orderId: link.orderId } }); await db.salesOrder.deleteMany({ where: { id: link.orderId } }) }
    await db.shoppingSyncLog.deleteMany({ where: { externalId: String(unheldId) } })
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: String(unheldId) } })
    await fx.cleanup()
  })
  const rows = await seedRaw(db, fx, cleanups)
  // An EXISTING pending-FX queue row for the customer-only order (no entity id; the customer id sits inside the snapshot).
  const rateForQueue = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const queuedUnheld = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(unheldId), errorMessage: `rate missing for ${FULL_NAME}`,
    payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: String(unheldId), externalOrderNumber: String(unheldId), currency: 'GBP', asOf: null, order: rawOrder(fx, rateForQueue, { id: unheldId }) } as never } })
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(unheldId) } }), 0, 'PRECONDITION: no obligation yet')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  assert.deepEqual(leaks(await ev(db, rows.inboxCustomerOnly)), [], 'the delivery found by customer id is projected')
  const ob = await db.storefrontOrderErasureObligation.findUnique({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(unheldId) } } })
  assert.ok(ob && ob.retiredAt === null, 'an open obligation names the unheld order')
  const queuedAfter = await lg(db, queuedUnheld.id)
  assert.deepEqual(leaks(queuedAfter), [], 'an existing queue row for the customer-only order is projected at erasure')
  assert.equal((queuedAfter.payload as { externalOrderId: string }).externalOrderId, String(unheldId))
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(fx.externalId) } }), 0, 'no obligation for the order IMS holds (its link is enough)')
  // A later delivery of that order is projected on insert (trigger sees the obligation) ...
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const body = rawOrder(fx, rate, { id: unheldId })
  const again = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.updated', payloadHash: sha(randomUUID()), payloadJson: body as never, status: 'PENDING' } })
  cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: again.id } }) })
  assert.deepEqual(leaks(again.payloadJson), [])
  // ... and a later IMPORT of it creates the order already erased.
  await (await import('@/lib/connectors/woocommerce/sync/order-import')).importWcOrder(rawOrder(fx, rate, { id: unheldId, number: String(unheldId) }) as never)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(unheldId) } })
  const created = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })
  assert.ok(created.erasedAt, 'created already erased')
  assert.deepEqual(leaks({ n: created.customerName, e: created.customerEmail, b: created.billingAddress, s: created.shippingAddress }), [])
})

test('[raw payloads] store-credit evidence survives the projection in both legacy shapes: the importer\'s classifier reaches the SAME verdict on the projected order, and no email or restriction survives', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { classifyWcCouponLines, WC_UNMODELLED_CREDIT_META_KEYS } = await import('@/lib/connectors/woocommerce/sync/coupon-classification')
  const project = async (order: unknown) => (await db.$queryRaw<Array<{ p: { coupon_lines: unknown[]; meta_data: unknown[]; fee_lines: unknown[] } }>>`SELECT gdpr_project_wc_order(${JSON.stringify(order)}::jsonb) AS p`)[0]!.p
  const verdict = (o: { coupon_lines: unknown[]; meta_data: unknown[]; fee_lines?: unknown[] }) => {
    const c = classifyWcCouponLines(o.coupon_lines as never, o.meta_data as never, (o.fee_lines ?? []) as never)
    return JSON.stringify({ lines: c.lines.map((l) => [l.code, l.kind, String(l.net), String(l.tax), l.discountType, l.creditConflict]), problems: c.signalProblems.map((p) => p.code).sort(), unknown: c.unknown.length, creditNet: String(c.creditNet) })
  }
  const cases: Array<[string, Record<string, unknown>]> = [
    ['contribution as a JSON string + legacy coupon_data with an email restriction', {
      coupon_lines: [{ id: 1, code: 'gc-5', discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 1, key: 'coupon_data', value: { discount_type: 'smart_coupon', customer_email: [EMAIL], note: NAME.last } }] }],
      meta_data: [{ id: 2, key: 'smart_coupons_contribution', value: JSON.stringify({ 'gc-5': '5.00' }) }] }],
    ['contribution as an object, no type record', {
      coupon_lines: [{ id: 1, code: 'gc-7', discount: '7.00', discount_tax: '0.00', meta_data: [] }],
      meta_data: [{ id: 2, key: 'smart_coupons_contribution', value: { 'gc-7': 7 } }] }],
    ['a contribution amount that is junk', {
      coupon_lines: [{ id: 1, code: 'gc-9', discount: '9.00', discount_tax: '0.00', meta_data: [] }],
      meta_data: [{ id: 2, key: 'smart_coupons_contribution', value: { 'gc-9': `junk ${NAME.first}` } }] }],
    ['legacy coupon_data only, a genuine percent discount', {
      coupon_lines: [{ id: 1, code: 'save10', discount: '10.00', discount_tax: '2.00', meta_data: [{ id: 1, key: 'coupon_data', value: JSON.stringify({ discount_type: 'percent', email_restrictions: [EMAIL] }) }] }],
      meta_data: [] }],
    ['credit words only in an unrelated coupon-line meta entry', {
      coupon_lines: [{ id: 1, code: 'plain', discount: '4.00', discount_tax: '0.00', meta_data: [{ id: 1, key: 'campaign', value: 'Store credit top-up' }] }],
      meta_data: [] }],
    ['wallet meta: a readable amount and a junk one', {
      coupon_lines: [], meta_data: [{ id: 1, key: '_used_wallet_amount', value: '2.50' }, { id: 2, key: '_gift_card_amount', value: `abc ${NAME.first}` }] }],
  ]
  for (const [label, extra] of cases) {
    const original = { ...rawOrder(fx, rate, extra), fee_lines: [] }
    const projected = await project(original)
    assert.equal(verdict(projected), verdict(original as never), `same classification: ${label}`)
    assert.deepEqual(leaks(projected), [], `no identity: ${label}`)
    assert.equal(JSON.stringify(projected).includes('customer_email'), false)
  }
  // The SQL's wallet-key list covers every key the classifier's own list names.
  for (const key of WC_UNMODELLED_CREDIT_META_KEYS) {
    const p = await project({ ...rawOrder(fx, rate, { meta_data: [{ id: 1, key, value: '3.00' }], coupon_lines: [] }), fee_lines: [] })
    assert.deepEqual(p.meta_data, [{ id: 1, key, value: '3.00' }], `${key} survives`)
  }
})

// Every allowlisted meta key and the value projection declared for it. Add a key to the SQL allowlist and this test fails until it is declared here AND has a kind there.
const DECLARED_META_VALUE_KINDS: Record<string, string> = {
  _base_currency_exchange_rate: 'number', _cogs_total_value_order_currency: 'number', _cogs_value_order_currency: 'number', _wcpdf_invoice_number: 'invoice_number',
  smart_coupons_contribution: 'contribution',
  _wc_store_credit_used: 'credit_amount', _store_credit_used: 'credit_amount', _store_credit_applied: 'credit_amount', _used_wallet_amount: 'credit_amount', _woo_wallet_used: 'credit_amount',
  _partial_pay_through_wallet_amount: 'credit_amount', _ywgc_applied_gift_cards_total: 'credit_amount', _gift_card_amount: 'credit_amount', _giftcard_amount: 'credit_amount',
  wc_gift_cards_total: 'credit_amount', _smart_coupon_credit_used: 'credit_amount',
  _wclc_fee: 'flag', _wclc_fee_kind: 'wclc_kind', _wclc_duty_component: 'decimal', _wclc_tax_component: 'decimal', _wclc_handling_component: 'decimal',
}
const SCOPED_META_VALUE_KINDS: Record<string, string> = { coupon_info: 'coupon_info', coupon_data: 'coupon_data', _refunded_item_id: 'int', _line_total_base_currency: 'number' }

test('[raw payloads] meta census: every allowlisted meta key has a declared value projection, and an identity embedded in ANY allowlisted key\'s value (string, array element, object field, JSON string) does not survive', { skip }, async () => {
  const db = await loadDb()
  const rows = await db.$queryRaw<Array<{ k: string; kind: string | null }>>`SELECT k, gdpr_wc_meta_value_kind(k) AS kind FROM unnest(gdpr_wc_meta_exact_keys()) AS k`
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.k, r.kind])), DECLARED_META_VALUE_KINDS, 'the SQL allowlist and its value kinds equal the declared census (a key without a kind fails here)')
  for (const [key, kind] of Object.entries(SCOPED_META_VALUE_KINDS)) {
    assert.equal((await db.$queryRaw<Array<{ kind: string | null }>>`SELECT gdpr_wc_meta_value_kind(${key}) AS kind`)[0]!.kind, kind, `${key} kind`)
  }
  const IDENTITY = [`${NAME.first} ${NAME.last}`, EMAIL, PHONE, STREET]
  const shapes = (id: string): unknown[] => [id, [id], [1, 'CODE', id, id], { discount_type: id, customer_email: [id], note: id, x: { y: id } }, { [`k_${randomUUID().slice(0, 4)}`]: id }, JSON.stringify([1, 'CODE', id, '10', id]), JSON.stringify([id, id, id, id]), [id, id, id, id], JSON.stringify({ discount_type: id, email_restrictions: [id] })]
  for (const key of [...Object.keys(DECLARED_META_VALUE_KINDS), ...Object.keys(SCOPED_META_VALUE_KINDS)]) {
    for (const id of IDENTITY) {
      for (const shape of shapes(id)) {
        const out = (await db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_meta_value(${key}, ${JSON.stringify(shape)}::jsonb) AS p`)[0]!.p
        for (const frag of [NAME.first, NAME.last, 'example.test', '7700', 'Marmalade']) {
          assert.equal(JSON.stringify(out ?? null).includes(frag), false, `${key}: "${frag}" survived a ${typeof shape} value: ${JSON.stringify(out)}`)
        }
      }
    }
  }
})

test('[raw payloads] the closed discount-type vocabulary matches the importer\'s: every type it knows survives verbatim, every wclc fee kind too', { skip }, async () => {
  const db = await loadDb()
  const { WC_GENUINE_DISCOUNT_TYPES, WC_STORE_CREDIT_DISCOUNT_TYPE } = await import('@/lib/connectors/woocommerce/sync/coupon-classification')
  const { WCLC_FEE_KINDS } = await import('@/lib/connectors/woocommerce/sync/field-mapping')
  for (const type of [...WC_GENUINE_DISCOUNT_TYPES, WC_STORE_CREDIT_DISCOUNT_TYPE]) {
    const out = (await db.$queryRaw<Array<{ p: { discount_type: string } }>>`SELECT gdpr_project_coupon_data(${JSON.stringify({ discount_type: type })}::jsonb) AS p`)[0]!.p
    assert.equal(out.discount_type, type, `${type} survives`)
  }
  for (const kind of WCLC_FEE_KINDS) {
    const out = (await db.$queryRaw<Array<{ p: string }>>`SELECT gdpr_project_meta_value('_wclc_fee_kind', ${JSON.stringify(kind)}::jsonb) AS p`)[0]!.p
    assert.equal(out, kind, `${kind} survives`)
  }
})

test('[raw payloads] coupon_info carrying an email keeps only its type: the classifier reaches the same verdict', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { classifyWcCouponLines } = await import('@/lib/connectors/woocommerce/sync/coupon-classification')
  const verdict = (o: { coupon_lines: unknown[]; meta_data: unknown[] }) => {
    const c = classifyWcCouponLines(o.coupon_lines as never, o.meta_data as never, [])
    return JSON.stringify({ lines: c.lines.map((l) => [l.code, l.kind, String(l.net), l.discountType, l.creditConflict]), problems: c.signalProblems.map((p) => p.code).sort(), unknown: c.unknown.length })
  }
  for (const [label, info] of [
    ['a percent discount', JSON.stringify([1, 'SALE', 'percent', '10', EMAIL])],
    ['store credit', JSON.stringify([2, 'gc-5', 'smart_coupon', '5', EMAIL, FULL_NAME])],
    ['an unreadable record', `not json ${FULL_NAME}`],
  ] as const) {
    const code = label === 'store credit' ? 'gc-5' : 'SALE'
    const original = { ...rawOrder(fx, rate, { coupon_lines: [{ id: 1, code, discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 1, key: 'coupon_info', value: info }] }], meta_data: [] }), fee_lines: [] }
    const projected = (await db.$queryRaw<Array<{ p: { coupon_lines: unknown[]; meta_data: unknown[] } }>>`SELECT gdpr_project_wc_order(${JSON.stringify(original)}::jsonb) AS p`)[0]!.p
    assert.equal(verdict(projected), verdict(original as never), `same classification: ${label}`)
    assert.deepEqual(leaks(projected), [], label)
    assert.equal(JSON.stringify(projected).includes('example.test'), false, label)
  }
})

test('[raw payloads] structured fields are rebuilt from typed fields: taxes, cost_of_goods_sold and a nested value under a scalar key cannot carry an added field, in any shape', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const shapes = (id: string): unknown[] => [id, [id], { a: id }, { total: id, subtotal: id, note: id, nested: { who: id } }, [{ id: rate, total: '1.00', subtotal: '1.00', email: id, meta: { who: id } }], { total_value: '5.00', note: id }]
  for (const id of [FULL_NAME, EMAIL, PHONE, STREET]) {
    for (const shape of shapes(id)) {
      const order = rawOrder(fx, rate, {
        cost_of_goods_sold: shape, store_credit_used: shape, customer_note: shape, currency: shape, total: shape, discount_total: shape,
        line_items: [{ id: 1, product_id: 1, quantity: 1, price: shape, taxes: shape, cost_of_goods_sold: shape, cogs_value: shape, meta_data: [] }],
        shipping_lines: [{ id: 2, method_id: 'flat_rate', total: '5.00', taxes: shape, meta_data: [] }],
        fee_lines: [{ id: 3, name: 'x', total: '1.00', taxes: shape, meta_data: [] }],
      })
      const p = (await db.$queryRaw<Array<{ p: Record<string, any> }>>`SELECT gdpr_project_wc_order(${JSON.stringify(order)}::jsonb) AS p`)[0]!.p // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const frag of [NAME.first, NAME.last, 'example.test', '7700', 'Marmalade']) assert.equal(JSON.stringify(p).includes(frag), false, `"${frag}" survived a ${JSON.stringify(shape).slice(0, 60)}`)
      assert.equal('cost_of_goods_sold' in p, false, 'cost_of_goods_sold has no reader and is dropped')
      for (const line of [...p.line_items, ...p.shipping_lines, ...p.fee_lines]) {
        for (const tax of line.taxes ?? []) assert.deepEqual(Object.keys(tax).filter((k) => !['id', 'total', 'subtotal'].includes(k)), [], 'a tax entry holds only id, total, subtotal')
      }
    }
  }
  // the typed fields themselves survive
  const ok = (await db.$queryRaw<Array<{ p: { line_items: Array<{ taxes: unknown }> } }>>`SELECT gdpr_project_wc_order(${JSON.stringify(rawOrder(fx, rate))}::jsonb) AS p`)[0]!.p
  assert.deepEqual(ok.line_items[0]!.taxes, [{ id: rate, total: '20.00', subtotal: '20.00' }])
})

test('[raw payloads] a customer TOMBSTONE (hash only) catches a delivery inserted between the scan and the commit, and leaves an order created after the erasure live', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  const lateId = fx.externalId + 8_000_000_000
  const earlyId = fx.externalId + 9_000_000_000
  t.after(async () => {
    await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"')
    for (const c of cleanups) await c()
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: [String(lateId), String(earlyId)] } } })
    await db.storefrontCustomerErasureTombstone.deleteMany({})
    await fx.cleanup()
  })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  // The tombstone holds a hash and a time, never the id.
  const tombs = await db.storefrontCustomerErasureTombstone.findMany()
  const expected = createHash('sha256').update(`woocommerce:${fx.wooCustomerId}`).digest('hex')
  assert.ok(tombs.some((x) => x.customerKeyHash === expected), 'the tombstone is the sha256 of connector:customer id')
  assert.equal(JSON.stringify(tombs).includes(String(fx.wooCustomerId)), false, 'no raw customer id in the tombstone')
  const body = (id: number, created: string) => rawOrder(fx, rate, { id, number: String(id), date_created_gmt: created, date_created: created })
  const mk = async (b: unknown) => {
    const row = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.created', payloadHash: sha(randomUUID()), payloadJson: b as never, status: 'PENDING' } })
    cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: row.id } }) })
    return row.id
  }
  // (a) an order created BEFORE the erasure, inserted while the trigger could not see the marker: the reconcile finds it by the tombstone.
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" DISABLE TRIGGER "shopping_webhook_events_erased_projection"')
  const early = await mk(body(earlyId, '2020-01-01T00:00:00'))
  const late = await mk(body(lateId, new Date(Date.now() + 86_400_000).toISOString().slice(0, 19)))
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"')
  assert.ok(leaks((await ev(db, early)).payloadJson).length > 3, 'PRECONDITION: the straggler is raw')
  const out = await reconcileRawPayloads(db)
  assert.equal(out.remaining, 0)
  assert.deepEqual(leaks(await ev(db, early)), [], 'the delivery of the erased account is projected by the reconcile')
  const ob = await db.storefrontOrderErasureObligation.findUnique({ where: { connector_externalOrderId: { connector: 'woocommerce', externalOrderId: String(earlyId) } } })
  assert.ok(ob && ob.retiredAt === null, 'and an order obligation is recorded for it')
  // (b) an order created AFTER the erasure is new data from a still-existing account: it stays live, with no obligation.
  assert.ok(leaks((await ev(db, late)).payloadJson).length > 3, 'an order created after the erasure stays live')
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(lateId) } }), 0)
  // (c) with the trigger enabled, a new insert for an order created before the erasure is projected on insert and obligated.
  const early2Id = earlyId + 1
  const early2 = await mk(body(early2Id, '2020-01-02T00:00:00'))
  assert.deepEqual(leaks((await ev(db, early2)).payloadJson), [])
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(early2Id), retiredAt: null } }), 1)
  await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: String(early2Id) } })
})

test('[raw payloads] a DIRECT import of a pre-erasure snapshot of an unseen order (no webhook row, no sync-log row) is created already erased; an order created after the erasure imports normally', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const extra: Array<{ orderId: string; customerId: string | null }> = []
  t.after(async () => {
    for (const e of extra) {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: e.orderId } }); await db.salesOrderLine.deleteMany({ where: { orderId: e.orderId } })
      await db.activityLog.deleteMany({ where: { OR: [{ entityId: e.orderId }, ...(e.customerId ? [{ entityId: e.customerId }] : [])] } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: e.orderId } }); await db.salesOrder.deleteMany({ where: { id: e.orderId } })
      if (e.customerId) { await db.shoppingCustomerLink.deleteMany({ where: { customerId: e.customerId } }); await db.customer.deleteMany({ where: { id: e.customerId } }) }
    }
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: [String(oldId), String(newId)] } } })
    await db.storefrontCustomerErasureTombstone.deleteMany({})
    await fx.cleanup()
  })
  const oldId = fx.externalId + 5_000_000_000
  const newId = fx.externalId + 6_000_000_000
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const customersBefore = await db.customer.count()

  // A snapshot fetched BEFORE the erasure (the order was created in 2026-11-02), delivered after it. Nothing else has seen this order.
  assert.equal(await db.shoppingWebhookEvent.count({ where: { payloadHash: { contains: String(oldId) } } }), 0)
  const oldResult = await importWcOrder(rawOrder(fx, rate, { id: oldId, number: String(oldId), customer_id: fx.wooCustomerId }) as never)
  assert.equal(oldResult.success, true, JSON.stringify(oldResult))
  const oldLink = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(oldId) } })
  const oldOrder = await db.salesOrder.findUniqueOrThrow({ where: { id: oldLink.orderId } })
  extra.push({ orderId: oldOrder.id, customerId: oldOrder.customerId })
  assert.ok(oldOrder.erasedAt, 'created already erased')
  assert.equal(oldOrder.customerId, null, 'no customer step')
  assert.deepEqual(leaks({ n: oldOrder.customerName, e: oldOrder.customerEmail, b: oldOrder.billingAddress, s: oldOrder.shippingAddress, nt: oldOrder.notes }), [])
  assert.equal(await db.customer.count(), customersBefore, 'no customer row was minted')
  assert.equal(await db.shoppingCustomerLink.count({ where: { externalCustomerId: String(fx.wooCustomerId) } }), 0, 'no storefront account link')
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(oldId), retiredAt: null } }), 0)
  assert.ok(await db.activityLog.findFirst({ where: { entityId: oldOrder.id, action: 'gdpr_erasure_recorded' } }), 'the name-free proof is written')

  // An order created AFTER the erasure is new data from a still-existing account: an ordinary import.
  const later = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19)
  const newResult = await importWcOrder(rawOrder(fx, rate, { id: newId, number: String(newId), customer_id: fx.wooCustomerId, date_created_gmt: later, date_created: later }) as never)
  assert.equal(newResult.success, true, JSON.stringify(newResult))
  const newLink = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(newId) } })
  const newOrder = await db.salesOrder.findUniqueOrThrow({ where: { id: newLink.orderId } })
  extra.push({ orderId: newOrder.id, customerId: newOrder.customerId })
  assert.equal(newOrder.erasedAt, null, 'an order created after the erasure stays live')
  assert.ok(newOrder.customerId, 'and gets a customer')
})

test('[raw payloads] one projection is FINAL: project(project(x)) = project(x) for the whole payload, over the seven identity shapes in every kept and dropped field, and no fragment survives', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  t.after(async () => { await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const project = async (v: unknown) => (await db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_wc_order(${JSON.stringify(v)}::jsonb) AS p`)[0]!.p
  const shapes = (id: string): unknown[] => [id, [id], { a: id }, { total: id, subtotal: id, note: id, nested: { who: id } }, [{ id: rate, total: '1.00', email: id, meta: { who: id } }], JSON.stringify([1, 'CODE', id]), 7]
  const base = rawOrder(fx, rate) as Record<string, unknown>
  const topKeys = Object.keys(base).filter((k) => !['line_items', 'meta_data'].includes(k))
  for (const id of [FULL_NAME, EMAIL, PHONE, STREET]) {
    for (const shape of shapes(id)) {
      const order: Record<string, unknown> = { ...base }
      for (const k of topKeys) order[k] = shape
      order.line_items = [Object.fromEntries(['id', 'name', 'parent_name', 'sku', 'product_id', 'quantity', 'price', 'subtotal', 'total', 'tax_class', 'taxes', 'meta_data', 'image', 'cogs_value', 'global_unique_id'].map((k) => [k, shape]))]
      order.fee_lines = [Object.fromEntries(['id', 'name', 'total', 'taxes', 'meta_data', 'tax_class'].map((k) => [k, shape]))]
      order.shipping_lines = [Object.fromEntries(['id', 'method_id', 'method_title', 'total', 'taxes', 'meta_data'].map((k) => [k, shape]))]
      order.coupon_lines = [Object.fromEntries(['id', 'code', 'discount', 'meta_data'].map((k) => [k, shape]))]
      order.meta_data = [...Object.keys(DECLARED_META_VALUE_KINDS), 'coupon_info', 'coupon_data', 'other_key'].map((key, i) => ({ id: i, key, value: shape }))
      const once = await project(order)
      const twice = await project(once)
      assert.deepEqual(twice, once, `projection is idempotent for ${JSON.stringify(shape).slice(0, 50)}`)
      for (const frag of [NAME.first, NAME.last, 'example.test', '7700', 'Marmalade']) {
        // the refund reason is free text KEPT by owner ruling; every other field must be clean
        const text = stripKeptText(once)
        assert.equal(text.includes(frag), false, `"${frag}" survived ${JSON.stringify(shape).slice(0, 50)}`)
      }
    }
  }
})

test('[raw payloads] a structured sku never becomes a name: an object or array sku gives "Item" and an empty sku', { skip }, async () => {
  const db = await loadDb()
  for (const sku of [{ a: `${NAME.first} ${NAME.last}` }, [`${NAME.first}`], `${NAME.first} ${NAME.last}`, EMAIL]) {
    const p = (await db.$queryRaw<Array<{ p: { line_items: Array<{ name: string; sku: string }> } }>>`SELECT gdpr_project_wc_order(${JSON.stringify({ id: 1, line_items: [{ id: 1, name: 'x', sku, quantity: 1 }] })}::jsonb) AS p`)[0]!.p
    assert.equal(p.line_items[0]!.name, 'Item'); assert.equal(p.line_items[0]!.sku, '')
  }
  const ok = (await db.$queryRaw<Array<{ p: { line_items: Array<{ name: string; sku: string }> } }>>`SELECT gdpr_project_wc_order(${JSON.stringify({ id: 1, line_items: [{ id: 1, name: 'x', sku: 'AB-12_x.3', quantity: 1 }] })}::jsonb) AS p`)[0]!.p
  assert.equal(ok.line_items[0]!.name, 'AB-12_x.3'); assert.equal(ok.line_items[0]!.sku, 'AB-12_x.3')
})

test('[raw payloads] EVERY erased-on-create path maps the projection: a marked payload, an open obligation and a tombstone each create an order with no personalised item name, fee name or gateway id, and its money equals a normal import of the same order', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const made: Array<{ orderId: string; customerId: string | null }> = []
  const ids = { marked: fx.externalId + 3_100_000_000, obligation: fx.externalId + 3_200_000_000, tombstone: fx.externalId + 3_300_000_000, normal: fx.externalId + 3_400_000_000 }
  t.after(async () => {
    for (const e of made) {
      await db.payment.deleteMany({ where: { orderId: e.orderId } }); await db.accountingSyncLog.deleteMany({ where: { referenceId: e.orderId } }); await db.salesOrderLine.deleteMany({ where: { orderId: e.orderId } })
      await db.activityLog.deleteMany({ where: { OR: [{ entityId: e.orderId }, ...(e.customerId ? [{ entityId: e.customerId }] : [])] } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: e.orderId } }); await db.salesOrder.deleteMany({ where: { id: e.orderId } })
      if (e.customerId) { await db.shoppingCustomerLink.deleteMany({ where: { customerId: e.customerId } }); await db.customer.deleteMany({ where: { id: e.customerId } }) }
    }
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: Object.values(ids).map(String) } } })
    await db.storefrontCustomerErasureTombstone.deleteMany({})
    await fx.cleanup()
  })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const mk = (id: number, over: Record<string, unknown> = {}) => {
    const base = rawOrder(fx, rate, { id, number: String(id), ...over }) as Record<string, unknown> & { line_items: Array<Record<string, unknown>> }
    return { ...base, transaction_id: `TXN-${NAME.last}-${id}`, date_paid_gmt: '2026-11-02T09:05:00', date_paid: '2026-11-02T09:05:00',
      line_items: [{ ...base.line_items[0]!, name: `Widget engraved for ${NAME.first}`, parent_name: `Gift for ${NAME.last}` }],
      fee_lines: [{ id: 41, name: `Gift wrap for ${NAME.last}`, tax_class: '', tax_status: 'none', total: '0.00', total_tax: '0.00', taxes: [], meta_data: [] }] }
  }
  const run = async (id: number, over: Record<string, unknown> = {}) => {
    const r = await importWcOrder(mk(id, over) as never)
    assert.equal(r.success, true, JSON.stringify(r))
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(id) } })
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId }, include: { lines: true } })
    const payments = await db.payment.findMany({ where: { orderId: order.id } })
    made.push({ orderId: order.id, customerId: order.customerId })
    return { order, payments }
  }
  const money = (o: Awaited<ReturnType<typeof run>>) => JSON.stringify({ total: String(o.order.totalForeign), lines: o.order.lines.map((l) => [String(l.qty), String(l.unitPriceForeign), String(l.totalForeign), String(l.taxForeign)]).sort(), pay: o.payments.map((p) => String(p.amount)) })

  // The reference: a NORMAL import of the same order from a live customer (a different person, so it is not caught by anything).
  const normal = await run(ids.normal, { billing: { ...WC_ADDRESS, email: `live.${randomUUID().slice(0, 6)}@example.test`, first_name: 'Livia', last_name: 'Other' }, shipping: { ...WC_ADDRESS, first_name: 'Livia', last_name: 'Other' }, customer_id: 0 })
  assert.equal(normal.order.erasedAt, null)
  assert.ok(normal.order.lines.some((l) => l.description.includes(NAME.first)), 'PRECONDITION: a normal import keeps the item name')

  // PATH 1: a payload the storefront marked anonymised.
  const marked = await run(ids.marked, { meta_data: [{ id: 5, key: '_anonymized', value: 'yes' }], customer_id: 0 })
  // PATH 2: an open obligation for the order.
  await db.storefrontOrderErasureObligation.create({ data: { connector: 'woocommerce', externalOrderId: String(ids.obligation) } })
  const obligated = await run(ids.obligation, { customer_id: 0 })
  // PATH 3: a customer tombstone (the account was erased after this snapshot was taken).
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const tombstoned = await run(ids.tombstone, { customer_id: fx.wooCustomerId })

  for (const [label, r] of [['marked payload', marked], ['open obligation', obligated], ['tombstone', tombstoned]] as const) {
    assert.ok(r.order.erasedAt, `${label}: created erased`)
    for (const l of r.order.lines) assert.deepEqual(leaks(l), [], `${label}: no personalised name on a line (${l.description})`)
    assert.ok(r.order.lines.every((l) => !l.description.includes('Widget engraved') && !l.description.includes('Gift wrap')), `${label}: line and fee descriptions come from the projection`)
    assert.ok(r.payments.length >= 1 && r.payments.every((p) => p.reference === null), `${label}: the receipt carries no gateway id`)
    assert.deepEqual(leaks(r.payments), [], `${label}: no identity on the payment`)
    assert.equal(money(r), money(normal), `${label}: money, tax, lines and receipt equal a normal import of the same order`)
  }
})

test('[raw payloads] the erasure\'s own customer-id scans apply the tombstone cutoff: a delivery or queue row for an order created AFTER the erasure, present while it runs, stays live (no projection, no obligation) and imports normally; a pre-erasure one is still projected', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  const preId = fx.externalId + 4_100_000_000
  const postId = fx.externalId + 4_200_000_000
  t.after(async () => {
    for (const c of cleanups) await c()
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(postId) } })
    if (link) { const o = await db.salesOrder.findUnique({ where: { id: link.orderId } }); await db.payment.deleteMany({ where: { orderId: link.orderId } }); await db.accountingSyncLog.deleteMany({ where: { referenceId: link.orderId } }); await db.salesOrderLine.deleteMany({ where: { orderId: link.orderId } }); await db.activityLog.deleteMany({ where: { entityId: link.orderId } }); await db.shoppingOrderLink.deleteMany({ where: { orderId: link.orderId } }); await db.salesOrder.deleteMany({ where: { id: link.orderId } }); if (o?.customerId) { await db.shoppingCustomerLink.deleteMany({ where: { customerId: o.customerId } }); await db.customer.deleteMany({ where: { id: o.customerId } }) } }
    await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: [String(preId), String(postId)] } } })
    await db.storefrontCustomerErasureTombstone.deleteMany({})
    await fx.cleanup()
  })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 19)
  const body = (id: number, created: string) => rawOrder(fx, rate, { id, number: String(id), date_created_gmt: created, date_created: created })
  const mkEv = async (b: unknown) => { const row = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.created', payloadHash: sha(randomUUID()), payloadJson: b as never, status: 'PENDING' } }); cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: row.id } }) }); return row.id }
  const mkQ = async (id: number, created: string) => { const row = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(id), payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: String(id), externalOrderNumber: String(id), currency: 'GBP', asOf: null, order: body(id, created) } as never } }); cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: row.id } }) }); return row.id }
  const preEv = await mkEv(body(preId, '2020-01-01T00:00:00'))
  const postEv = await mkEv(body(postId, future))
  const preQ = await mkQ(preId, '2020-01-01T00:00:00')
  const postQ = await mkQ(postId, future)
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  assert.deepEqual(leaks(await ev(db, preEv)), [], 'the pre-erasure delivery is projected')
  assert.deepEqual(leaks(await lg(db, preQ)), [], 'the pre-erasure queue row is projected')
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(preId), retiredAt: null } }), 1)
  assert.ok(leaks((await ev(db, postEv)).payloadJson).length > 3, 'the post-erasure delivery stays live')
  assert.ok(leaks(await lg(db, postQ)).length > 3, 'the post-erasure queue row stays live')
  assert.equal(await db.storefrontOrderErasureObligation.count({ where: { externalOrderId: String(postId) } }), 0, 'no obligation for the post-erasure order')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const r = await importWcOrder(body(postId, future) as never)
  assert.equal(r.success, true, JSON.stringify(r))
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(postId) } })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId } })).erasedAt, null, 'it imports as a live order')
})

test('[raw payloads] the sync-log projection dispatches by the row\'s own columns and FAILS CLOSED: a refund park whose body carries a `queue` field is still projected by the sweep, the guard and the reconcile; an unrecognised shape in scope is stubbed, and counts as dirty until it is', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" ENABLE TRIGGER "shopping_sync_logs_erased_projection"'); for (const c of cleanups) await c(); await fx.cleanup() })
  const mk = async (data: Record<string, unknown>) => { const row = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: String(Math.floor(Math.random() * 1e9)), ...data } as never }); cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: row.id } }) }); return row }
  const dirty = async (id: string) => (await db.$queryRaw<Array<{ d: boolean }>>`SELECT gdpr_sync_log_row_dirty(l) AS d FROM "shopping_sync_logs" l WHERE l."id" = ${id}`)[0]!.d
  const trick = { ...rawRefund(fx), queue: 'admission_refusal', reason: REFUND_REASON }
  const parkSweep = await mk({ recordKind: 'WC_REFUND_PARK', payload: trick, externalId: '6001' })
  const unknownIn = await mk({ payload: { whatever: `${FULL_NAME} ${EMAIL}`, nested: { note: STREET } }, externalId: '6002' })
  const unknownArr = await mk({ payload: [FULL_NAME, EMAIL], externalId: '6003' })
  const unknownOut = await mk({ direction: 'TO_CONNECTOR', status: 'SYNCED', payload: { who: FULL_NAME }, externalId: '6004' })
  const refusal = await mk({ payload: { queue: 'admission_refusal', reason: 'status_not_admitted', connector: 'woocommerce', externalOrderId: '6005', externalOrderNumber: '6005', status: 'pending', configured: ['processing'], currency: 'GBP', refusedAt: '2026-11-01T00:00:00.000Z', attempts: 0 }, externalId: '6005' })
  for (const r of [parkSweep, unknownIn, unknownArr, unknownOut]) assert.equal(await dirty(r.id), true, 'PRECONDITION: unrecognised or raw counts as dirty')
  assert.equal(await dirty(refusal.id), true, 'a refusal is REBUILT too (no recognised family passes through): dirty until projected')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  const p = (await lg(db, parkSweep.id)).payload as { amount: string; reason: string; queue?: string }
  assert.equal(p.amount, '10.00'); assert.equal(p.reason, REFUND_REASON); assert.equal('queue' in p, false, 'the refund projection ran whatever fields the body carried')
  assert.deepEqual(leaks(await lg(db, parkSweep.id)), [])
  for (const r of [unknownIn, unknownArr, unknownOut]) {
    assert.deepEqual((await lg(db, r.id)).payload, { _erasure_projected: true }, 'an unrecognised shape in scope is stubbed')
    assert.equal(await dirty(r.id), false, 'and is clean only once stubbed')
  }
  const refusalAfter = (await lg(db, refusal.id)).payload as Record<string, unknown>
  assert.deepEqual({ ...refusalAfter, _erasure_projected: undefined }, { ...(refusal.payload as Record<string, unknown>), _erasure_projected: undefined }, 'a clean refusal keeps every typed field')
  assert.equal(refusalAfter._erasure_projected, true)
  // THE GUARD: an insert or update of the same park for the erased order is projected on the way in.
  const guarded = await mk({ recordKind: 'WC_REFUND_PARK', payload: trick, externalId: '6006' })
  assert.deepEqual(leaks(guarded), []); assert.equal(((guarded.payload as { queue?: string }).queue), undefined)
  const guardedUnknown = await mk({ payload: { who: FULL_NAME }, externalId: '6007' })
  assert.deepEqual(guardedUnknown.payload, { _erasure_projected: true })
  // THE RECONCILE: with the trigger off, rows slip in raw; the reconcile projects and stubs them, and reports none left.
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" DISABLE TRIGGER "shopping_sync_logs_erased_projection"')
  const slipPark = await mk({ recordKind: 'WC_REFUND_PARK', payload: trick, externalId: '6008' })
  const slipUnknown = await mk({ payload: { who: FULL_NAME }, externalId: '6009' })
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" ENABLE TRIGGER "shopping_sync_logs_erased_projection"')
  assert.ok(leaks(await lg(db, slipPark.id)).length > 0 && leaks(await lg(db, slipUnknown.id)).length > 0, 'PRECONDITION: raw')
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.equal((await reconcileRawPayloads(db)).remaining, 0)
  assert.deepEqual(leaks(await lg(db, slipPark.id)), []); assert.equal(((await lg(db, slipPark.id)).payload as { queue?: string }).queue, undefined)
  assert.deepEqual((await lg(db, slipUnknown.id)).payload, { _erasure_projected: true })
})

test('[raw payloads] EVERY family\'s envelope is rebuilt from typed fields: an extra unknown top-level key and the seven identity shapes in every field leave no fragment, the projection is idempotent, and an email-shaped currency on an erased order\'s admission refusal is removed by the sweep, the guard and the reconcile', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" ENABLE TRIGGER "shopping_sync_logs_erased_projection"'); for (const c of cleanups) await c(); await fx.cleanup() })
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const shapes = (id: string): unknown[] => [id, [id], { a: id }, { total: id, nested: { who: id } }, [{ id: 1, email: id }], JSON.stringify([1, 'CODE', id]), 7]
  const fill = (keys: string[], shape: unknown, extra = 'x_unknown') => ({ ...Object.fromEntries(keys.map((k) => [k, shape])), [extra]: shape })
  const call = async <T,>(q: Promise<Array<{ p: T }>>) => (await q)[0]!.p
  const sl = (payload: unknown, family: string) => call(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_sync_log_payload(${JSON.stringify(payload)}::jsonb, ${family}) AS p`)
  const wh = (payload: unknown, resource: string) => call(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_webhook_payload(${JSON.stringify(payload)}::jsonb, ${resource}) AS p`)
  const ev2 = (payload: unknown) => call(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_return_event(${JSON.stringify(payload)}::jsonb) AS p`)
  const clean = (v: unknown) => { const o = JSON.parse(JSON.stringify(v ?? null)) as Record<string, unknown> | null; if (o && typeof o === 'object') { if (typeof o.reason === 'string') delete o.reason; if (Array.isArray(o.refunds)) for (const r of o.refunds as Array<Record<string, unknown>>) if (r && typeof r.reason === 'string') delete r.reason } return JSON.stringify(o) }
  const order = rawOrder(fx, rate) as Record<string, unknown>
  for (const id of [FULL_NAME, EMAIL, PHONE, STREET]) {
    for (const shape of shapes(id)) {
      const cases: Array<[string, () => Promise<unknown>, (v: unknown) => Promise<unknown>]> = [
        ['queue envelope', () => sl({ ...fill(['reason', 'connector', 'externalOrderId', 'externalOrderNumber', 'currency', 'asOf', 'receiptPaymentId'], shape), paidBlock: fill(['kind', 'attempts', 'firstAt'], shape), order }, 'inbound'), (v) => sl(v, 'inbound')],
        ['queue envelope, hostile order', () => sl({ reason: 'x', connector: 'woocommerce', externalOrderId: '1', externalOrderNumber: '1', currency: 'GBP', asOf: null, order: fill(Object.keys(order), shape) }, 'inbound'), (v) => sl(v, 'inbound')],
        ['admission refusal', () => sl(fill(['queue', 'reason', 'connector', 'externalOrderId', 'externalOrderNumber', 'status', 'configured', 'currency', 'refusedAt', 'attempts'], shape), 'inbound'), (v) => sl(v, 'inbound')],
        ['tracking log', () => sl(fill(['meta_key', 'items', 'pushedDateModifiedGmt'], shape), 'outbound'), (v) => sl(v, 'outbound')],
        ['tracking log (real discriminator)', () => sl({ ...fill(['items', 'pushedDateModifiedGmt'], shape), meta_key: '_wc_shipment_tracking_items' }, 'outbound'), (v) => sl(v, 'outbound')],
        ['status push', () => sl({ ...fill(['pushedDateModifiedGmt'], shape), status: shape }, 'outbound'), (v) => sl(v, 'outbound')],
        ['refund park', () => sl(fill(['id', 'parent_id', 'order_id', 'date_created', 'amount', 'reason', 'refunded_by', 'refunded_payment', 'meta_data', 'line_items', 'shipping_lines', 'queue'], shape), 'refund_park'), (v) => sl(v, 'refund_park')],
        ['webhook order', () => wh({ ...fill(Object.keys(order), shape), id: 5 }, 'orders'), (v) => wh(v, 'orders')],
        ['webhook refund', () => wh({ ...fill(['parent_id', 'order_id', 'amount', 'reason', 'refunded_by', 'meta_data', 'line_items'], shape), id: 5 }, 'refunds'), (v) => wh(v, 'refunds')],
        ['return event', () => ev2(fill(['reason', 'resolutionNote', 'sku', 'qty', 'reference', 'status', 'warehouseId', 'orderMatched', 'productMatched'], shape)), (v) => ev2(v)],
      ]
      for (const [label, project, again] of cases) {
        const once = await project()
        assert.deepEqual(await again(once), once, `${label}: idempotent for ${JSON.stringify(shape).slice(0, 40)}`)
        for (const frag of [NAME.first, NAME.last, 'example.test', '7700', 'Marmalade']) assert.equal(clean(once).includes(frag), false, `${label}: "${frag}" survived ${JSON.stringify(shape).slice(0, 40)}: ${clean(once).slice(0, 200)}`)
        assert.equal(clean(once).includes('x_unknown'), false, `${label}: an unknown top-level key is dropped`)
      }
    }
  }

  // REGRESSION: an erased order's admission refusal whose stated currency is email-shaped.
  const mk = async (externalId: string, payload: unknown) => { const row = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId, payload: payload as never } }); cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: row.id } }) }); return row }
  const refusalBody = (id: string, currency: string) => ({ queue: 'admission_refusal', reason: 'currency_missing', connector: 'woocommerce', externalOrderId: id, externalOrderNumber: id, status: 'pending', configured: ['processing'], currency, refusedAt: '2026-11-01T00:00:00.000Z', attempts: 0, billing_email: EMAIL })
  const preId = String(fx.externalId) // an order IMS holds: its refusal row has no entity id and is keyed by the storefront order id, which the erasure sweep reads from the link
  const sweepRow = await mk(preId, refusalBody(preId, EMAIL))
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  cleanups.push(async () => { await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: [guardId, slipId] } } }) })
  assert.equal((await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })).success, true)
  // sweep: the refusal row of an order IMS holds (entity id set) is found by the erasure; the unheld one by the obligation, below via the guard and reconcile
  const guardId = String(fx.externalId + 2_200_000_000); const slipId = String(fx.externalId + 2_300_000_000)
  await db.storefrontOrderErasureObligation.createMany({ data: [{ connector: 'woocommerce', externalOrderId: guardId }, { connector: 'woocommerce', externalOrderId: slipId }] })
  const guarded = await mk(guardId, refusalBody(guardId, EMAIL))
  assert.deepEqual(leaks(guarded), [], 'the guard rebuilds the refusal'); assert.equal((guarded.payload as { currency: string }).currency, 'unreadable'); assert.equal('billing_email' in (guarded.payload as object), false)
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" DISABLE TRIGGER "shopping_sync_logs_erased_projection"')
  const slip = await mk(slipId, refusalBody(slipId, EMAIL))
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" ENABLE TRIGGER "shopping_sync_logs_erased_projection"')
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  assert.ok(leaks(await lg(db, slip.id)).length > 0 || JSON.stringify((await lg(db, slip.id)).payload).includes('example.test'), 'PRECONDITION: raw')
  assert.equal((await reconcileRawPayloads(db)).remaining, 0)
  const reconciled = (await lg(db, slip.id)).payload as { currency: string }
  assert.equal(reconciled.currency, 'unreadable'); assert.equal(JSON.stringify(reconciled).includes('example.test'), false)
  assert.equal(JSON.stringify((await lg(db, sweepRow.id)).payload).includes('example.test'), false, 'the erasure sweep removed the email-shaped currency')
})

test('[raw payloads] targeted gaps from the mutation pass: reason typing, single-word invoice numbers, country, the held park, error-only rows, queue rows of a tombstoned account, undated deliveries, the sync-log recheck, storefrontIdMissing', { skip }, async (t) => {
  const db = await loadDb()
  const fx = await importFixture(db)
  const cleanups: Array<() => Promise<void>> = []
  t.after(async () => { await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_undo_sync_projection ON "shopping_sync_logs"'); await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_undo_sync_projection()'); await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"'); for (const c of cleanups) await c(); await db.storefrontOrderErasureObligation.deleteMany({ where: { externalOrderId: { in: [String(undatedId), String(queuedId)] } } }); await db.storefrontCustomerErasureTombstone.deleteMany({}); await fx.cleanup() })
  const undatedId = fx.externalId + 7_100_000_000
  const queuedId = fx.externalId + 7_200_000_000
  const rate = Number((await db.shoppingTaxRateMapping.findFirstOrThrow({ where: { taxRateId: fx.rateId } })).externalTaxRateId)
  const one = async (q: Promise<Array<{ p: unknown }>>) => (await q)[0]!.p

  // reason: a non-string is the empty string; a string is kept (owner ruling)
  const r1 = await one(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_wc_refund(${JSON.stringify({ id: 1, reason: { who: FULL_NAME }, amount: '1.00' })}::jsonb) AS p`) as { reason: string }
  assert.equal(r1.reason, '')
  const r2 = await one(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_wc_refund(${JSON.stringify({ id: 1, reason: REFUND_REASON, amount: '1.00' })}::jsonb) AS p`) as { reason: string }
  assert.equal(r2.reason, REFUND_REASON)
  // a single-word name is not an invoice number (a document number has a digit)
  assert.equal(await one(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_meta_value('_wcpdf_invoice_number', ${JSON.stringify(NAME.last)}::jsonb) AS p`), null)
  assert.equal(await one(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_project_meta_value('_wcpdf_invoice_number', ${JSON.stringify('INV-2026-17')}::jsonb) AS p`), 'INV-2026-17')
  // the country is two letters or nothing
  const addr = await one(db.$queryRaw<Array<{ p: unknown }>>`SELECT gdpr_empty_address(${JSON.stringify({ country: EMAIL })}::jsonb) AS p`) as { country: string }
  assert.equal(addr.country, '')

  // a held-invoice park keeps its STRUCTURE and its fixed error text through the sweep (the contact step owns its contact block)
  const held = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: String(fx.externalId), recordKind: 'WC_HELD_SALES_INVOICE', payload: { reason: 'missing_wc_invoice_number', accountingPayload: { contactName: 'Held Name', lines: [{ amount: 1 }] } }, errorMessage: 'Waiting for _wcpdf_invoice_number on WooCommerce order 1' } })
  cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: held.id } }) })
  // an error-only row: NO payload at all, identity in its error text
  const errOnly = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'TO_CONNECTOR', status: 'FAILED', entityType: 'SalesOrder', entityId: fx.orderId, externalId: String(fx.externalId), errorMessage: `push failed for ${FULL_NAME}` } })
  cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: errOnly.id } }) })
  // the sync-log recheck: a saboteur that restores the payload makes the erasure FAIL and roll back
  const sab = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', entityId: fx.orderId, externalId: '5551', recordKind: 'WC_REFUND_PARK', payload: rawRefund(fx) } })
  cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: sab.id } }) })
  await db.$executeRawUnsafe(`CREATE FUNCTION test_undo_sync_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."id" = '${sab.id}' THEN NEW."payload" := OLD."payload"; END IF; RETURN NEW; END $$`)
  await db.$executeRawUnsafe('CREATE TRIGGER test_undo_sync_projection BEFORE UPDATE OF "payload" ON "shopping_sync_logs" FOR EACH ROW EXECUTE FUNCTION test_undo_sync_projection()')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const failed = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(failed.success, false, 'a sync-log row left raw fails the erasure')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: fx.orderId } })).erasedAt, null)
  await db.$executeRawUnsafe('DROP TRIGGER test_undo_sync_projection ON "shopping_sync_logs"')

  // storefrontIdMissing: an order that looks like a storefront order but has no link is COUNTED in the proof
  await db.shoppingOrderLink.deleteMany({ where: { orderId: fx.orderId } })
  const ok = await eraseCustomerPersonalData(fx.customerId, { trigger: 'ON_REQUEST', userId: null })
  assert.equal(ok.success, true, JSON.stringify(ok))
  const proof = await db.activityLog.findFirstOrThrow({ where: { action: 'gdpr_erasure_recorded', entityId: fx.customerId } })
  assert.equal((proof.metadata as { counts: { storefrontIdMissing: number } }).counts.storefrontIdMissing, 1)
  const heldAfter = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal((heldAfter.payload as { accountingPayload: { lines: unknown[] } }).accountingPayload.lines.length, 1, 'the held park keeps its structure')
  assert.equal(heldAfter.errorMessage, 'Waiting for _wcpdf_invoice_number on WooCommerce order 1', 'and its fixed error text')
  const errAfter = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: errOnly.id } })
  assert.deepEqual(leaks(errAfter), [], 'an error-only row is cleared'); assert.equal(errAfter.errorMessage, 'Text removed by GDPR erasure')

  // tombstone: a queue row of an unimported order of the erased account is found by the rule alone; an undated delivery counts as BEFORE the erasure
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" DISABLE TRIGGER "shopping_sync_logs_erased_projection"')
  const queued = await db.shoppingSyncLog.create({ data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', status: 'PENDING', entityType: 'SalesOrder', externalId: String(queuedId), payload: { reason: 'missing_fx_rate', connector: 'woocommerce', externalOrderId: String(queuedId), externalOrderNumber: String(queuedId), currency: 'GBP', asOf: null, order: rawOrder(fx, rate, { id: queuedId, number: String(queuedId), date_created_gmt: '2020-01-01T00:00:00' }) } as never } })
  cleanups.push(async () => { await db.shoppingSyncLog.deleteMany({ where: { id: queued.id } }) })
  await db.$executeRawUnsafe('ALTER TABLE "shopping_sync_logs" ENABLE TRIGGER "shopping_sync_logs_erased_projection"')
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" DISABLE TRIGGER "shopping_webhook_events_erased_projection"')
  const undatedBody = { ...(rawOrder(fx, rate, { id: undatedId, number: String(undatedId) }) as Record<string, unknown>) }
  delete undatedBody.date_created_gmt; delete undatedBody.date_created
  const undated = await db.shoppingWebhookEvent.create({ data: { connector: 'woocommerce', resource: 'orders', topic: 'order.created', payloadHash: sha(randomUUID()), payloadJson: undatedBody as never, status: 'PENDING' } })
  cleanups.push(async () => { await db.shoppingWebhookEvent.deleteMany({ where: { id: undated.id } }) })
  await db.$executeRawUnsafe('ALTER TABLE "shopping_webhook_events" ENABLE TRIGGER "shopping_webhook_events_erased_projection"')
  const { reconcileRawPayloads } = await import('@/lib/domain/erasure/raw-payloads')
  const out = await reconcileRawPayloads(db)
  assert.equal(out.remaining, 0)
  assert.deepEqual(leaks(await lg(db, queued.id)), [], 'the queue row of a tombstoned, unimported account is projected by the reconcile')
  assert.deepEqual(leaks((await ev(db, undated.id)).payloadJson), [], 'an undated delivery counts as before the erasure')
})
