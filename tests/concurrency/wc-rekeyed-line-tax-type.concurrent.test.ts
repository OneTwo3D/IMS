import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * A RE-KEYED RATE: the line is persisted with the replacement's id (resolveLinesTaxRates redirects lineData), and the invoice payload must carry the REPLACEMENT's Xero code and reverse-charge handling and be bound to the replacement's id. With the
 * Sales Invoices switch OFF the whole payload is byte-identical to what the importer built before the treatment existed: GOLDEN is the normalised payload that origin/development builds for this very order (captured by running this file on a checkout of it with DUMP=1).
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

const captured: Array<Record<string, unknown>> = []
let mocked = false
async function mockAccounting() {
  if (mocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({
        connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: 'RCSALES',
        euVatIossAccount: '821', euVatDdpAccount: '232', euFeeAccount: '232', roundingDifferenceAccount: '860',
      }),
      isAccountingSyncTypeEnabledFor: async () => false,
      queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: { payload: Record<string, unknown> }) => { captured.push(params.payload); return { queued: false, reason: 'not-configured' } },
    },
  })
  mocked = true
}

const ADDRESS = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'London', state: '', postcode: 'SW1A 1AA', country: 'GB', email: 'a@b.c', phone: '' }
function order(externalId: number, wcRateId: number) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: '2026-11-02T09:05:00', date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00', date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: ADDRESS, shipping: ADDRESS, meta_data: [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, { id: 2, key: 'is_vat_exempt', value: 'no' }],
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: 'SKU-REKEY', price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [], coupon_lines: [], refunds: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '2.00', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Flat', method_id: 'flat_rate', total: '10.00', total_tax: '2.00', taxes: [{ id: wcRateId, total: '2.00' }], meta_data: [] }],
    total: '132.00', total_tax: '22.00', discount_total: '0.00', discount_tax: '0.00', shipping_total: '10.00', shipping_tax: '2.00',
  }
}

/** Normalised: the contact, dates, reference, receipt id and the random rate ids (replaced by OLD and NEW) are left out or named; everything else is kept. */
const GOLDEN: string | null = '{"currency":"GBP","lines":[{"description":"Widget","quantity":1,"unitAmount":100,"accountCode":"200","taxType":"RCSALES","taxRateId":"NEW","taxRateBasis":"sales_line"}],"shippingAmount":10,"shippingDescription":"Shipping","shippingAccountCode":"260","shippingTaxType":"OUTPUT3","shippingTaxRateId":"NEW","shippingTaxRateBasis":"plain","discountAccountCode":"270","discountTaxType":"OUTPUT3","discountTaxRateId":"NEW","discountTaxRateBasis":"plain","lineAmountsIncludeTax":false,"_postingMode":"submitted","_paymentMethod":"bacs","_registerPayment":true,"_paymentAmount":132}'

test('[re-key] a line whose rate was re-keyed is built on the REPLACEMENT (its Xero code, its reverse-charge flag, its id), byte-identical to origin/development with the treatment off', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  await mockAccounting()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const replacement = await db.taxRate.create({ data: { name: `GB NEW ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT3', reverseCharge: true, countryCode: 'GB', taxCategory: 'STANDARD', active: true } })
  const old = await db.taxRate.create({ data: { name: `GB OLD ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', reverseCharge: false, countryCode: 'GB', taxCategory: 'STANDARD', active: true, replacedById: replacement.id } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'UK VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: old.id } })
  const warehouse = await db.warehouse.create({ data: { code: `RK-${randomUUID().slice(0, 8)}`, name: 'Re-key test warehouse', syncToStore: true, availableForSale: true } })
  t.after(async () => {
    const orderId = (await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } }))?.orderId
    if (orderId) {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.activityLog.deleteMany({ where: { entityId: orderId } })
      await db.payment.deleteMany({ where: { orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    }
    await db.shoppingSyncLog.deleteMany({ where: { externalId: String(externalId) } })
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: { in: [old.id, replacement.id] } } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: old.id } })
    await db.taxRate.deleteMany({ where: { id: replacement.id } })
  })
  captured.length = 0
  const result = await importWcOrder(order(externalId, wcRateId) as never)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(captured.length, 1, 'the invoice was built and offered to the queue')
  const raw = captured[0]!
  const lines = raw.lines as Array<Record<string, unknown>>
  // The replacement's reverse-charge flag swaps the type to the configured reverse-charge code; the old row's would have posted OUTPUT2.
  assert.equal(lines[0]!.taxType, 'RCSALES')
  assert.equal(lines[0]!.taxRateId, replacement.id, 'bound to the replacement')
  assert.equal(raw.shippingTaxType, 'OUTPUT3', 'shipping follows the replacement too')
  const skipKeys = new Set(['contactName', 'contactEmail', 'date', 'reference', 'currencyRateToBase', '_paymentId', '_paymentDate', '_idempotencyKey', 'invoiceNumber'])
  const normalise = JSON.stringify(raw, (key, value) => (skipKeys.has(key) ? undefined : value)).split(replacement.id).join('NEW').split(old.id).join('OLD')
  if (process.env.DUMP === '1') console.log(`GOLDEN-BEGIN${normalise}GOLDEN-END`)
  if (GOLDEN !== null) assert.equal(normalise, GOLDEN, 'byte-identical to what origin/development builds for this order')
})
