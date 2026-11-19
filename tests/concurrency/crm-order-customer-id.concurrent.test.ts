import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * CRM: THE STOREFRONT CUSTOMER ID STORED ON AN ORDER (sales_orders.external_customer_id), THROUGH THE REAL IMPORTER AGAINST A REAL POSTGRES.
 *
 * The review scenario of PR 1057 round 2: an order is imported under storefront account 42 (person P). Staff then move it to account 43 (person Q, who has no
 * link row yet) in WooCommerce and the order is redelivered. The importer's update path never moves the order's customer, so it must NOT rewrite the stored id
 * either (it records an operator notice instead), and the NEXT order of account 43 must go to Q: a customer is matched by storefront id only through the
 * customer-link table, never through "the oldest order carrying that id". No WooCommerce, Xero or warehouse call is made.
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
      isAccountingSyncTypeEnabledFor: async () => false,
      queueAccountingSync: async () => ({ queued: true }),
    },
  })
  accountingMocked = true
}

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

const address = (email: string, first: string, last: string) => ({ first_name: first, last_name: last, company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1 1AA', country: 'GB', email, phone: '' })

function payload(externalId: number, wcRateId: number, customerId: number, email: string, first: string, last: string) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: customerId, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: address(email, first, last), shipping: address(email, first, last), meta_data: [],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '0.00', meta_data: [] }],
    shipping_lines: [], coupon_lines: [], refunds: [],
    total: '120.00', total_tax: '20.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax: '0.00',
  }
}

test('[crm] an order moved from account 42 (P) to account 43 (Q, no link) keeps its customer and stored id, and the next order of account 43 goes to Q', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder, updateExistingWcOrderFromPayload, CUSTOMER_ACCOUNT_MOVED_ACTION } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const acctP = 10_000_000 + Math.floor(Math.random() * 1_000_000)
  const acctQ = acctP + 1
  const key = randomUUID().slice(0, 8)
  const emailP = `p.${key}@example.test`
  const emailQ = `q.${key}@example.test`
  const orderA = 2_000_000_000 + Math.floor(Math.random() * 100_000_000)
  const orderB = orderA + 1
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `CRM-${randomUUID().slice(0, 8)}`, name: 'CRM id test warehouse', syncToStore: true, availableForSale: true } })
  const q = await db.customer.create({ data: { firstName: 'Quinn', lastName: key, email: emailQ }, select: { id: true } })
  const customerIds = [q.id]
  const orderIds: string[] = []
  t.after(async () => {
    const links = await db.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: { in: [String(orderA), String(orderB)] } }, select: { orderId: true } })
    orderIds.push(...links.map((l) => l.orderId))
    const created = await db.customer.findMany({ where: { OR: [{ email: emailP }, { id: { in: customerIds } }] }, select: { id: true } })
    const all = created.map((c) => c.id)
    await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: orderIds } } })
    await db.activityLog.deleteMany({ where: { OR: [{ entityId: { in: [...orderIds, ...all] } }] } })
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: { in: [String(orderA), String(orderB)] } } })
    await db.shoppingCustomerLink.deleteMany({ where: { customerId: { in: all } } })
    await db.customerMergeEvent.deleteMany({ where: { OR: [{ customerId: { in: all } }, { otherCustomerId: { in: all } }] } })
    await db.customer.deleteMany({ where: { id: { in: all } } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  })

  // 1. order A is placed under account 42 by P
  assert.equal((await importWcOrder(payload(orderA, wcRateId, acctP, emailP, 'Pat', key) as never)).success, true)
  const linkA = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(orderA) }, select: { orderId: true } })
  const before = await db.salesOrder.findUniqueOrThrow({ where: { id: linkA.orderId }, select: { customerId: true, externalCustomerId: true } })
  assert.equal(before.externalCustomerId, acctP)
  const p = before.customerId!
  customerIds.push(p)
  assert.equal((await db.shoppingCustomerLink.findFirstOrThrow({ where: { customerId: p } })).externalCustomerId, String(acctP))

  // 2. staff move the order to account 43 (Q): the redelivery must not rewrite the stored id, and records an operator notice
  await updateExistingWcOrderFromPayload(linkA.orderId, payload(orderA, wcRateId, acctQ, emailQ, 'Quinn', key) as never)
  const after = await db.salesOrder.findUniqueOrThrow({ where: { id: linkA.orderId }, select: { customerId: true, externalCustomerId: true } })
  assert.deepEqual(after, { customerId: p, externalCustomerId: acctP }, 'the first id is kept and the order keeps its customer')
  assert.equal(await db.activityLog.count({ where: { entityType: 'SALES_ORDER', entityId: linkA.orderId, action: CUSTOMER_ACCOUNT_MOVED_ACTION } }), 1, 'an operator notice is recorded')
  // the same delivery again adds no second notice the same day
  await updateExistingWcOrderFromPayload(linkA.orderId, payload(orderA, wcRateId, acctQ, emailQ, 'Quinn', key) as never)
  assert.equal(await db.activityLog.count({ where: { entityType: 'SALES_ORDER', entityId: linkA.orderId, action: CUSTOMER_ACCOUNT_MOVED_ACTION } }), 1)

  // 3. the next order from account 43 goes to Q (matched by email, then linked), not to P
  assert.equal((await importWcOrder(payload(orderB, wcRateId, acctQ, emailQ, 'Quinn', key) as never)).success, true)
  const linkB = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(orderB) }, select: { orderId: true } })
  const orderBRow = await db.salesOrder.findUniqueOrThrow({ where: { id: linkB.orderId }, select: { customerId: true, externalCustomerId: true } })
  assert.equal(orderBRow.customerId, q.id, 'the order of account 43 is Q\'s, not P\'s')
  assert.equal(orderBRow.externalCustomerId, acctQ)
  assert.equal((await db.shoppingCustomerLink.findFirstOrThrow({ where: { customerId: q.id } })).externalCustomerId, String(acctQ), 'the link for account 43 is created on Q')
  assert.equal(await db.shoppingCustomerLink.count({ where: { customerId: p } }), 1, 'P keeps only its own link')

  // 4. a guest or anonymised delivery never blanks the stored id, and an order with no stored id takes the first positive one
  await updateExistingWcOrderFromPayload(linkB.orderId, payload(orderB, wcRateId, 0, emailQ, 'Quinn', key) as never)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: linkB.orderId }, select: { externalCustomerId: true } })).externalCustomerId, acctQ)
  await db.salesOrder.update({ where: { id: linkB.orderId }, data: { externalCustomerId: null } })
  await updateExistingWcOrderFromPayload(linkB.orderId, payload(orderB, wcRateId, acctQ, emailQ, 'Quinn', key) as never)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: linkB.orderId }, select: { externalCustomerId: true } })).externalCustomerId, acctQ)
})
