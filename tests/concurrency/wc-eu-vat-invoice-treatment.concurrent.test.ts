import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * THE EU IOSS / VOEC / DDP INVOICE TREATMENT THROUGH THE REAL WOOCOMMERCE IMPORT, against a real PostgreSQL (scratch database).
 *
 *   1. Sales Invoices switch OFF: the payload is exactly what it was (charged code, fee on the sales account, no VAT line, no marker), and the order is NOT stamped.
 *   2. Switch ON, IOSS (the plugin recorded account 821): goods and shipping on the scheme's zero-rated type, the marked fee on 232 on NONE, ONE VAT line on 821 on NONE,
 *      the document totals WooCommerce's order total, and the regime is stamped once.
 *   3. Switch ON, DDP (the plugin recorded 232): the VAT line is on 232.
 *   4. Switch ON, the plugin recorded nothing: the document is stamped so the poster refuses it, no payment is registered, nothing is stamped on the order.
 *   5. A hold parked while the switch is off is not released untreated once the switch is on.
 * No Xero call is made: the accounting facade is a double that writes the queue row.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let switchOn = false
/** The OFF case needs to see what the importer built; the real queue would write nothing. Only that case sets it. */
let recordWhenOff = false
let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({
        connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '',
        euVatIossAccount: '821', euVatDdpAccount: '232', euFeeAccount: '232', roundingDifferenceAccount: '860',
      }),
      isAccountingSyncTypeEnabledFor: async () => switchOn,
      queueAccountingSyncTxWithOutcome: async (tx: { accountingSyncLog: { create(args: unknown): Promise<unknown> } }, params: { type: string; referenceType: string; referenceId: string; payload: Record<string, unknown>; idempotencyKey?: string }) => {
        if (!switchOn && !recordWhenOff) return { queued: false, reason: 'not-configured' }
        await tx.accountingSyncLog.create({ data: { type: params.type, status: 'PENDING', referenceType: params.referenceType, referenceId: params.referenceId, payload: { ...params.payload, _idempotencyKey: params.idempotencyKey } } })
        return switchOn ? { queued: true, connector: 'xero' } : { queued: false, reason: 'not-configured' }
      },
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

const ADDRESS = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Berlin', state: '', postcode: '10115', country: 'DE', email: 'a@b.c', phone: '' }
const marker = (id: number, kind: string) => [{ id: id * 10, key: '_wclc_fee', value: '1' }, { id: id * 10 + 1, key: '_wclc_fee_kind', value: kind }]

/** DE order: goods 100.00, marked fee 4.00, shipping 10.00, all at 19% (tax 19.00 + 0.76 + 1.90); total 135.66. */
function payload(externalId: number, wcRateId: number, meta: Array<{ id: number; key: string; value: unknown }>) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: '2026-11-02T09:05:00', date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: ADDRESS, shipping: ADDRESS, meta_data: meta,
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '19.00', total: '100.00', total_tax: '19.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '19.00', subtotal: '19.00' }], meta_data: [{ id: 5, key: '_o3d_is_voucher', value: 'no' }] }],
    fee_lines: [{ id: 11, name: 'EU Customs Fee', tax_class: '', total: '4.00', total_tax: '0.76', taxes: [{ id: wcRateId, total: '0.76' }], meta_data: marker(11, 'uhf') }],
    tax_lines: [{ id: 21, rate_code: 'DE-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '19.76', shipping_tax_total: '1.90', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Flat', method_id: 'flat_rate', total: '10.00', total_tax: '1.90', taxes: [{ id: wcRateId, total: '1.90' }], meta_data: [] }],
    coupon_lines: [], refunds: [],
    total: '135.66', total_tax: '21.66', discount_total: '0.00', discount_tax: '0.00', shipping_total: '10.00', shipping_tax: '1.90',
  }
}

async function seed(db: Awaited<ReturnType<typeof loadDb>>, wcRateId: number) {
  const rate = await db.taxRate.create({
    data: { name: `DE VAT ${randomUUID()}`, rate: 0.19, usedFor: 'SALES', accountingTaxType: 'DE_CHARGED', countryCode: 'DE', taxCategory: 'STANDARD', active: true, reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' },
  })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'DE VAT', externalCountry: 'DE', externalRatePct: 19, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `EUV-${randomUUID().slice(0, 8)}`, name: 'EU VAT treatment test warehouse', syncToStore: true, availableForSale: true } })
  return { rate, warehouse }
}

async function cleanup(db: Awaited<ReturnType<typeof loadDb>>, externalId: number, ctx: { rate: { id: string }; warehouse: { id: string } }) {
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
  await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: ctx.rate.id } })
  await db.warehouse.deleteMany({ where: { id: ctx.warehouse.id } })
  await db.taxRate.deleteMany({ where: { id: ctx.rate.id } })
}

type Line = { description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; noTaxKind?: string }
type Invoice = { lines: Line[]; shippingAmount: number; shippingTaxType?: string; shippingAccountCode?: string; _registerPayment?: boolean; _taxUnreconciled?: { reason: string }; _euVatTreatment?: Record<string, unknown> }

async function run(t: test.TestContext, meta: Array<{ id: number; key: string; value: unknown }>, on: boolean) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = on
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const result = await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...meta]) as never)
  assert.equal(result.success, true, `import succeeded: ${JSON.stringify(result)}`)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const row = await db.accountingSyncLog.findFirst({ where: { type: 'SALES_INVOICE', referenceId: orderId } })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { euVatRegime: true, euVatLineAccount: true, euVatRegimeStampedAt: true } })
  return { db, orderId, externalId, invoice: row ? (row.payload as unknown as Invoice) : null, order }
}

const total = (inv: Invoice): number => Math.round((inv.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitAmount * 100) / 100, 0) + inv.shippingAmount) * 100) / 100

const PLUGIN = (account: string) => [
  { id: 1, key: '_o3d_ioss_vat_account', value: account },
  { id: 2, key: 'is_vat_exempt', value: 'no' },
]

test('[eu vat] switch OFF: the payload is exactly what it was and the order is not stamped', { skip }, async (t) => {
  recordWhenOff = true
  t.after(() => { recordWhenOff = false })
  const { invoice, order } = await run(t, PLUGIN('821'), false)
  assert.ok(invoice)
  // Exactly the pre-treatment payload: every line on the charged code and the sales account, no VAT line, no marker, nothing stamped.
  assert.deepEqual(invoice.lines.map((l) => [l.description, l.accountCode, l.taxType, l.noTaxKind ?? null]), [['Widget', '200', 'DE_CHARGED', null], ['EU Customs Fee', '200', 'DE_CHARGED', null]])
  assert.equal(invoice.shippingTaxType, 'DE_CHARGED')
  assert.equal(invoice._euVatTreatment, undefined)
  assert.equal(invoice._taxUnreconciled, undefined)
  assert.equal(invoice._registerPayment, true)
  assert.equal(JSON.stringify(invoice).includes('eu-vat-recovery'), false)
  assert.deepEqual(order, { euVatRegime: null, euVatLineAccount: null, euVatRegimeStampedAt: null })
})

test('[eu vat] switch ON, IOSS: zero-rated goods and shipping, fee on 232, one VAT line on 821, total equals the order, regime stamped', { skip }, async (t) => {
  const { invoice, order } = await run(t, PLUGIN('821'), true)
  assert.ok(invoice)
  const [goods, fee, vat] = invoice.lines
  assert.deepEqual([goods!.description, goods!.accountCode, goods!.taxType], ['Widget', '200', 'TAX131'])
  assert.deepEqual([fee!.description, fee!.accountCode, fee!.taxType, fee!.noTaxKind], ['EU Customs Fee', '232', 'NONE', 'fee-no-tax'])
  assert.deepEqual([vat!.accountCode, vat!.taxType, vat!.noTaxKind, vat!.unitAmount, vat!.quantity], ['821', 'NONE', 'eu-vat-recovery', 21.66, 1])
  assert.match(vat!.description, /^IOSS VAT collected — DE 19%$/)
  assert.equal(invoice.lines.length, 3)
  assert.equal(invoice.shippingTaxType, 'TAX131')
  assert.equal(invoice.shippingAccountCode, '260')
  assert.equal(total(invoice), 135.66, 'the invoice totals the order')
  assert.equal(invoice._taxUnreconciled, undefined)
  assert.equal(invoice._registerPayment, true)
  assert.deepEqual(invoice._euVatTreatment, { applied: true, route: 'scheme', regime: 'IOSS', vatAccount: '821', feesRecoded: 1, roundingAdjustment: null })
  assert.equal(order.euVatRegime, 'IOSS')
  assert.equal(order.euVatLineAccount, '821')
  assert.ok(order.euVatRegimeStampedAt)
})

test('[eu vat] switch ON, DDP (the plugin recorded 232): the VAT line is on 232, beside the fee', { skip }, async (t) => {
  const { invoice, order } = await run(t, PLUGIN('232'), true)
  assert.ok(invoice)
  assert.deepEqual(invoice.lines.map((l) => [l.accountCode, l.taxType, l.noTaxKind ?? null]), [['200', 'TAX131', null], ['232', 'NONE', 'fee-no-tax'], ['232', 'NONE', 'eu-vat-recovery']])
  assert.equal(total(invoice), 135.66)
  assert.equal(order.euVatRegime, 'DDP')
  assert.equal(order.euVatLineAccount, '232')
})

test('[eu vat] switch ON, the plugin recorded no account: the document is stamped so the poster refuses it, no payment is registered, nothing is stamped on the order', { skip }, async (t) => {
  const { invoice, order, db, orderId } = await run(t, [{ id: 2, key: 'is_vat_exempt', value: 'no' }], true)
  assert.ok(invoice)
  assert.match(invoice._taxUnreconciled?.reason ?? '', /EU IOSS\/VOEC\/DDP treatment .* refused the invoice: .*plugin_account_missing/)
  assert.equal(invoice._registerPayment, false)
  assert.equal(invoice.lines[0]!.taxType, 'DE_CHARGED', 'the lines are left as built: the document will not post')
  assert.equal(invoice._euVatTreatment, undefined)
  assert.deepEqual(order, { euVatRegime: null, euVatLineAccount: null, euVatRegimeStampedAt: null })
  const logged = await db.activityLog.findFirst({ where: { entityId: orderId, action: 'wc_invoice_eu_vat_treatment_refused' } })
  assert.ok(logged, 'the refusal is on the activity log')
})

test('[eu vat] a hold parked while the switch is off is not released untreated once it is on; with the switch still off nothing changes', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  // No invoice number on the order: the import parks the payload.
  const result = await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)
  assert.equal(result.success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const accountingPayload = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload
  assert.deepEqual(accountingPayload._euVatTreatment, { applied: false, reason: 'sales_invoices_switch_off' })
  assert.equal(accountingPayload.lines[0]!.taxType, 'DE_CHARGED', 'parked untreated')

  // The number arrives. Switch still off: the release is not-configured as ever (no row, hold still PENDING).
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0)
  assert.equal((await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })).status, 'PENDING')

  // Switch on: still nothing queued, and the hold says why.
  switchOn = true
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'the untreated payload was not released')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /parked while the Sales Invoices switch was off.*re-import the order/)
})
