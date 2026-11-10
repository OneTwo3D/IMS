import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * A WOOCOMMERCE STATUS MAPPED TO DRAFT. The importer saved the order, then tried to allocate it; allocation declines a draft (a draft is allocated and invoiced
 * when it is finalised), and the importer treated that refusal as a failed import after the order was already committed. A draft-mapped order is now imported
 * and acknowledged without an allocation attempt: it stays a DRAFT, holds no stock, and the import reports success.
 *
 * [mutation: allocate a DRAFT-mapped import again]
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

test('an imported order whose WooCommerce status is mapped to DRAFT is imported as a DRAFT with no allocation and the import succeeds', { skip }, async () => {
  const auth = await import('@/lib/auth/server')
  const session = { user: { id: undefined as unknown as string, role: 'ADMIN', name: 'Test Admin', email: 'admin@example.test' } }
  mock.module('@/lib/auth/server', { namedExports: { ...auth, ...Object.fromEntries(Object.keys(auth).filter((k) => k.startsWith('require')).map((k) => [k, async () => session])) } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const tag = randomUUID().slice(0, 8)
  const wcRateId = 800_000 + Math.floor(Math.random() * 90_000)
  const externalId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  // The ordinary WooCommerce status, mapped (for this test only) to Draft; the prior mapping, if any, is put back.
  const status = 'processing'
  const priorMapping = await db.shoppingStatusMapping.findUnique({ where: { connector_externalStatus: { connector: 'woocommerce', externalStatus: status } } })
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  await db.shoppingStatusMapping.upsert({ where: { connector_externalStatus: { connector: 'woocommerce', externalStatus: status } }, create: { connector: 'woocommerce', externalStatus: status, imsStatus: 'DRAFT' }, update: { imsStatus: 'DRAFT' } })
  const address = { first_name: 'Dee', last_name: `Raft${tag}`, company: '', address_1: '1 Draft Road', address_2: '', city: 'Leeds', state: '', postcode: 'LS1 1AA', country: 'GB', email: `dee.raft+${tag}@example.test`, phone: '' }
  const body = {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status, currency: 'GBP', prices_include_tax: false, customer_note: '', customer_id: 0,
    payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '', date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00', billing: address, shipping: address, meta_data: [],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, meta_data: [], taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }] }],
    fee_lines: [], tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '0.00', meta_data: [] }],
    shipping_lines: [], coupon_lines: [], refunds: [], total: '120.00', total_tax: '20.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax_total: '0.00', shipping_tax: '0.00',
  }
  try {
    const imported = await importWcOrder(body as never)
    assert.equal(imported.success, true, `the import succeeds: ${JSON.stringify(imported)}`)
    const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId }, select: { status: true } })
    assert.equal(order.status, 'DRAFT')
    assert.equal(await db.orderAllocation.count({ where: { orderId: link.orderId } }), 0, 'a draft holds no stock')
    const failed = await db.shoppingSyncLog.count({ where: { entityId: link.orderId, status: 'FAILED' } })
    assert.equal(failed, 0, 'no failed sync record for the import')
  } finally {
    const link = await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
    if (link) {
      const o = await db.salesOrder.findUnique({ where: { id: link.orderId }, select: { customerId: true } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: link.orderId } })
      await db.activityLog.deleteMany({ where: { entityId: link.orderId } })
      await db.shoppingSyncLog.deleteMany({ where: { entityId: link.orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId: link.orderId } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: link.orderId } })
      await db.salesOrder.deleteMany({ where: { id: link.orderId } })
      if (o?.customerId) { await db.shoppingCustomerLink.deleteMany({ where: { customerId: o.customerId } }); await db.customer.deleteMany({ where: { id: o.customerId } }) }
    }
    if (priorMapping) await db.shoppingStatusMapping.update({ where: { id: priorMapping.id }, data: { imsStatus: priorMapping.imsStatus } })
    else await db.shoppingStatusMapping.deleteMany({ where: { connector: 'woocommerce', externalStatus: status } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
  }
})
