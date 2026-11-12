import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * The storefront's language-independent courier key survives a REAL import (real importer, scratch database) into
 * the row the warehouse push reads, and the push input built from that row carries it as the courier service.
 *
 * A German-language and an English-language order for the same Calcurates rate import with different labels and the
 * same key, and push the same courier service. An order without the meta imports with no key and pushes its label.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

// The accounting facade, partially mocked: the settings the import reads, and nothing is sent anywhere.
let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      // The EU VAT invoice treatment is gated on the real Sales Invoices switch, which other tests in the shared CI database may leave on: pinned off here, this test is about the untreated payload.
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

const ADDRESS = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1 1AA', country: 'GB', email: 'a@b.c', phone: '' }
const metaEntry = (id: number, name: string, value: unknown) => ({ id, key: name, value })
const KEY = 'calcurates:2579_1565(VAT & Duty paid)'
const EN = 'GLS Euro Priority - 3 to 8 business days(VAT & Duty paid)'
const DE = 'GLS Euro Priority - 3 bis 8 Werktage(VAT & Duty paid)'

function payload(externalId: number, wcRateId: number, title: string, shippingMeta: Array<{ id: number; key: string; value: unknown }>) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: ADDRESS, shipping: ADDRESS, meta_data: [],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '1.00', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: title, method_id: 'calcurates', total: '5.00', total_tax: '1.00', taxes: [{ id: wcRateId, total: '1.00' }], meta_data: shippingMeta }],
    coupon_lines: [], refunds: [],
    total: '126.00', total_tax: '21.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '5.00', shipping_tax: '1.00',
  }
}

test('[courier key] the shipping-line key is imported and pushed as the courier service in every language; no key pushes the label', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { ORDER_PUSH_SELECT, buildPushInput } = await import('@/lib/domain/wms/order-push-sweep')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const base = Math.floor(Math.random() * 1_000_000_000)
  const cases = [
    { externalId: base + 1, title: EN, meta: [{ id: 1, key: 'delivery_date_from', value: '2026-11-09' }, { id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: EN }, metaEntry(3, '_o3d_calcurates_rate_id', '2579_1565')], storedKey: KEY, pushed: KEY },
    { externalId: base + 2, title: DE, meta: [{ id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: DE }], storedKey: KEY, pushed: KEY },
    { externalId: base + 3, title: EN, meta: [{ id: 1, key: 'delivery_date_from', value: '2026-11-09' }], storedKey: null, pushed: `calcurates:${EN}` },
    { externalId: base + 4, title: EN, meta: [{ id: 2, key: '_o3d_courier_key', value: '' }, { id: 4, key: '_o3d_courier_label', value: EN }], storedKey: null, pushed: `calcurates:${EN}` },
    { externalId: base + 6, title: EN, meta: [{ id: 2, key: '_o3d_courier_key', value: KEY }], storedKey: null, pushed: `calcurates:${EN}` }, // no label
    { externalId: base + 7, title: EN, meta: [{ id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: DE }], storedKey: null, pushed: `calcurates:${EN}` }, // edited line
    { externalId: base + 5, title: EN, meta: [{ id: 2, key: '_o3d_courier_key', value: 7 }, { id: 4, key: '_o3d_courier_label', value: EN }], storedKey: null, pushed: `calcurates:${EN}` },
  ]
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `WCK-${randomUUID().slice(0, 8)}`, name: 'Courier-key test warehouse', syncToStore: true, availableForSale: true } })
  const orderIds: string[] = []
  t.after(async () => {
    const ids = (await db.shoppingOrderLink.findMany({ where: { connector: 'woocommerce', externalOrderId: { in: cases.map((c) => String(c.externalId)) } }, select: { orderId: true } })).map((l) => l.orderId)
    orderIds.push(...ids)
    await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: orderIds } } })
    await db.activityLog.deleteMany({ where: { entityId: { in: orderIds } } })
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: { in: cases.map((c) => String(c.externalId)) } } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  })

  for (const c of cases) {
    const result = await importWcOrder(payload(c.externalId, wcRateId, c.title, c.meta) as never)
    assert.equal(result.success, true, `import ${c.externalId} succeeded: ${JSON.stringify(result)}`)
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(c.externalId) }, select: { orderId: true } })
    orderIds.push(link.orderId)
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId }, select: ORDER_PUSH_SELECT })
    assert.equal(row.shippingService, c.title, 'the label is stored exactly as before')
    assert.equal(row.courierKey, c.storedKey, `stored key for ${c.externalId}`)
    const input = buildPushInput(row as never, '301')
    assert.equal(row.shippingMethodId, 'calcurates', 'the method id is stored')
    assert.equal(input.courierService, c.pushed, `pushed courier service for ${c.externalId}`)
  }
})

test('[courier key] a later delivery refreshes label, method id and key together from the CURRENT shipping line', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder, updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `WCK-${randomUUID().slice(0, 8)}`, name: 'Courier-key refresh warehouse', syncToStore: true, availableForSale: true } })
  let orderId: string | undefined
  t.after(async () => {
    orderId ??= (await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } }))?.orderId
    if (orderId) {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.activityLog.deleteMany({ where: { entityId: orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    }
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  })
  const read = async () => db.salesOrder.findUniqueOrThrow({ where: { id: orderId! }, select: { shippingService: true, courierKey: true, shippingMethodId: true } })

  // Imported with a key.
  const first = await importWcOrder(payload(externalId, wcRateId, EN, [{ id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: EN }]) as never)
  assert.equal(first.success, true)
  orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  assert.deepEqual(await read(), { shippingService: EN, courierKey: KEY, shippingMethodId: 'calcurates' })

  // The line is edited in WooCommerce: the producer clears the meta, the title moves on. The stored key is cleared.
  await updateExistingWcOrderFromPayload(orderId, payload(externalId, wcRateId, 'Free shipping', []) as never)
  assert.deepEqual(await read(), { shippingService: 'Free shipping', courierKey: null, shippingMethodId: 'calcurates' })

  // A key whose stored label no longer matches the title is not trusted either.
  await updateExistingWcOrderFromPayload(orderId, payload(externalId, wcRateId, 'Edited title', [{ id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: EN }]) as never)
  assert.equal((await read()).courierKey, null)

  // A new key for a new line is picked up.
  await updateExistingWcOrderFromPayload(orderId, payload(externalId, wcRateId, DE, [{ id: 2, key: '_o3d_courier_key', value: 'calcurates:1_1' }, { id: 4, key: '_o3d_courier_label', value: DE }]) as never)
  assert.deepEqual(await read(), { shippingService: DE, courierKey: 'calcurates:1_1', shippingMethodId: 'calcurates' })

  // A delivery carrying NO shipping lines is no evidence the courier went away: the last known values stay.
  await updateExistingWcOrderFromPayload(orderId, { ...payload(externalId, wcRateId, DE, []), shipping_lines: [] } as never)
  assert.deepEqual(await read(), { shippingService: DE, courierKey: 'calcurates:1_1', shippingMethodId: 'calcurates' })

  // An order imported before the columns existed is populated by the next delivery.
  await db.salesOrder.update({ where: { id: orderId }, data: { courierKey: null, shippingMethodId: null } })
  await updateExistingWcOrderFromPayload(orderId, payload(externalId, wcRateId, EN, [{ id: 2, key: '_o3d_courier_key', value: KEY }, { id: 4, key: '_o3d_courier_label', value: EN }]) as never)
  assert.deepEqual(await read(), { shippingService: EN, courierKey: KEY, shippingMethodId: 'calcurates' })
})
