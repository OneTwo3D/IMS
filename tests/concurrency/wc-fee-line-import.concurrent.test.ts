import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * WooCommerce import of the wclc EU fee lines, against a real PostgreSQL (real importer, scratch database).
 *
 *   1. A NEW import mirrors a taxed EU Import Duty and EU Customs Fee (net, tax, rate, persisted fee kind), a non-taxable
 *      over-EUR-150 "Import Duty" and a legacy untaxed fee beside taxable goods, persists the order-level components, and
 *      the stored totals equal WooCommerce's.
 *   2. An EXISTING order (imported before the kind/component columns existed) is UPDATED by a later delivery: the update
 *      path rebuilds no lines, so the lines keep their stored kind (null) and amounts, and only the order-level
 *      components are refreshed from the delivery.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

// The accounting facade, partially mocked: the settings the import reads and a capture of what it enqueues. Nothing is sent anywhere.
const queued: Array<{ type: string; referenceId: string; payload: Record<string, unknown> }> = []
let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      queueAccountingSync: async (params: { type: string; referenceId: string; payload: Record<string, unknown> }) => {
        queued.push({ type: params.type, referenceId: params.referenceId, payload: params.payload })
        return { queued: true }
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

const ADDRESS = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Amsterdam', state: '', postcode: '1011AB', country: 'NL', email: 'a@b.c', phone: '' }
const marker = (id: number, kind: string) => [
  { id: id * 10, key: '_wclc_fee', value: '1' },
  { id: id * 10 + 1, key: '_wclc_fee_kind', value: kind },
]

function payload(externalId: number, wcRateId: number, orderMeta: Array<{ id: number; key: string; value: unknown }> = []) {
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: ADDRESS, shipping: ADDRESS, meta_data: orderMeta,
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '21.00', total: '100.00', total_tax: '21.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '21.00', subtotal: '21.00' }], meta_data: [] }],
    fee_lines: [
      { id: 11, name: 'EU Import Duty', tax_class: '', total: '6.00', total_tax: '1.26', taxes: [{ id: wcRateId, total: '1.26' }], meta_data: marker(11, 'duty_flat') },
      { id: 12, name: 'EU Customs Fee', tax_class: '', total: '4.00', total_tax: '0.84', taxes: [{ id: wcRateId, total: '0.84' }], meta_data: marker(12, 'uhf') },
      { id: 13, name: 'Import Duty', tax_class: '', total: '53.40', total_tax: '0.00', taxes: [], meta_data: marker(13, 'duty_fee') },
      { id: 14, name: 'EU Duty', tax_class: '', total: '3.00', total_tax: '0.00', taxes: [], meta_data: [] },
    ],
    tax_lines: [{ id: 21, rate_code: 'NL-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '23.10', shipping_tax_total: '0.00', meta_data: [] }],
    shipping_lines: [], coupon_lines: [], refunds: [],
    total: '189.50', total_tax: '23.10', discount_total: '0.00', discount_tax: '0.00', shipping_total: '0.00', shipping_tax: '0.00',
  }
}

async function seedTaxRate(db: Awaited<ReturnType<typeof loadDb>>, wcRateId: number) {
  const rate = await db.taxRate.create({ data: { name: `NL Standard ${randomUUID()}`, rate: 0.21, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'NL', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'NL VAT', externalCountry: 'NL', externalRatePct: 21, taxRateId: rate.id } })
  return rate
}

test('[wclc fees] a new import mirrors taxed and untaxed fee lines, persists kind and components, and totals equal WooCommerce', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const rate = await seedTaxRate(db, wcRateId)
  const warehouse = await db.warehouse.create({ data: { code: `WFL-${randomUUID().slice(0, 8)}`, name: 'Fee-line test warehouse', syncToStore: true, availableForSale: true } })
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

  const wc = payload(externalId, wcRateId, [
    { id: 1, key: '_wclc_duty_component', value: '9.00' },
    { id: 2, key: '_wclc_tax_component', value: '0' },
    { id: 3, key: '_wclc_handling_component', value: '0' },
    { id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` },
  ])
  const result = await importWcOrder(wc as never)
  assert.equal(result.success, true, `import succeeded: ${JSON.stringify(result)}`)
  orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const order = await db.salesOrder.findUniqueOrThrow({
    where: { id: orderId! },
    include: { lines: { orderBy: { description: 'asc' } } },
  })
  const byName = new Map(order.lines.map((l) => [l.description, l]))
  const row = (name: string) => byName.get(name)!
  // Net, tax and persisted kind per line, as WooCommerce reported.
  assert.deepEqual(
    ['EU Import Duty', 'EU Customs Fee', 'Import Duty', 'EU Duty', 'Widget'].map((n) => [n, row(n).totalForeign.toString(), row(n).taxForeign.toString(), row(n).wclcFeeKind]),
    [['EU Import Duty', '6', '1.26', 'duty_flat'], ['EU Customs Fee', '4', '0.84', 'uhf'], ['Import Duty', '53.4', '0', 'duty_fee'], ['EU Duty', '3', '0', null], ['Widget', '100', '21', null]],
  )
  // The taxed fees carry the mapped rate; the untaxed ones carry none.
  assert.equal(row('EU Import Duty').taxRateId, rate.id)
  assert.equal(row('EU Customs Fee').taxRateId, rate.id)
  assert.equal(row('Import Duty').taxRateId, null)
  assert.equal(row('EU Duty').taxRateId, null)
  // Order level: components as reported (handling stored only above zero), totals equal WooCommerce's.
  assert.equal(order.wclcDutyComponent?.toString(), '9')
  assert.equal(order.wclcTaxComponent?.toString(), '0')
  assert.equal(order.wclcHandlingComponent, null)
  assert.equal(order.totalForeign.toString(), '189.5')
  assert.equal(order.taxForeign.toString(), '23.1')

  // The invoice payload handed to accounting: untaxed fees on NONE, taxed fees and goods on the mapped code, and the document
  // (net + rate x net per line) totals what WooCommerce charged.
  const invoice = queued.find((q) => q.type === 'SALES_INVOICE' && q.referenceId === orderId)
  assert.ok(invoice, 'the sales invoice was handed to accounting')
  const lines = (invoice.payload.lines as Array<{ description: string; quantity: number; unitAmount: number; taxType?: string }>)
  assert.deepEqual(
    Object.fromEntries(lines.map((l) => [l.description, l.taxType])),
    { Widget: 'OUTPUT2', 'EU Import Duty': 'OUTPUT2', 'EU Customs Fee': 'OUTPUT2', 'Import Duty': 'NONE', 'EU Duty': 'NONE' },
  )
  const rateOf = (type?: string) => (type === 'OUTPUT2' ? 0.21 : 0)
  const documentTotal = lines.reduce((sum, l) => {
    const net = Math.round(l.quantity * l.unitAmount * 100) / 100
    return sum + net + Math.round(net * rateOf(l.taxType) * 100) / 100
  }, 0)
  assert.equal(Math.round(documentTotal * 100) / 100, 189.5, 'the invoice totals what WooCommerce charged')
})

test('[wclc fees] an EXISTING order updated by a later delivery keeps its lines AND its components exactly as stored', { skip }, async (t) => {
  const db = await loadDb()
  const { updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const id = `WFL-${process.pid}-${randomUUID()}`
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { entityId: id } })
    await db.salesOrderLine.deleteMany({ where: { orderId: id } })
    await db.salesOrder.deleteMany({ where: { id } })
  })
  // An order imported BEFORE the columns existed (a fee line with no kind, no components), and one imported after (components set).
  await db.salesOrder.create({
    data: {
      id, status: 'PROCESSING', currency: 'GBP', subtotalForeign: 109, totalForeign: 109, subtotalBase: 109, totalBase: 109,
      wclcDutyComponent: '7.00', wclcTaxComponent: '1.00',
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: String(externalId), externalOrderNumber: String(externalId) } },
      lines: { create: [{ description: 'EU Duty', sku: '', qty: 1, unitPriceForeign: 9, unitPriceBase: 9, totalForeign: 9, totalBase: 9 }] },
    },
  })
  // The components split the lines stored with them, and the update rebuilds no lines: a delivery carrying different
  // components, or none, changes neither the lines nor the stored split.
  for (const meta of [
    [{ id: 1, key: '_wclc_duty_component', value: '9.00' }, { id: 2, key: '_wclc_tax_component', value: '40.38' }, { id: 3, key: '_wclc_handling_component', value: '2.00' }],
    [],
  ]) {
    await updateExistingWcOrderFromPayload(id, payload(externalId, 1, meta) as never)
    const after = await db.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    assert.equal(after.lines.length, 1, 'no line was added or rebuilt')
    assert.equal(after.lines[0]!.wclcFeeKind, null, 'the stored line keeps its (null) kind')
    assert.equal(after.lines[0]!.totalForeign.toString(), '9')
    assert.equal(after.wclcDutyComponent?.toString(), '7', 'the stored duty component is untouched')
    assert.equal(after.wclcTaxComponent?.toString(), '1', 'the stored tax component is untouched')
    assert.equal(after.wclcHandlingComponent, null, 'no handling component appears from a later delivery')
  }
})
