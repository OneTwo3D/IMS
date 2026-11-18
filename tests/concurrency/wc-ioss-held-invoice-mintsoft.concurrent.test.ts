import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * End to end, against a real PostgreSQL: a WooCommerce import whose sales invoice is HELD (no invoice number yet) while the EU VAT stamp
 * is IOSS must still mirror the IOSS number, and the Mintsoft create payload must carry the shop IOSS number that is CURRENT when the
 * create happens (a changed number applies at once; a cleared one sends none). Only the HTTP edge is doubled.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let puts: string[] = []
let doubled = false
async function installDoubles() {
  if (doubled) return
  doubled = true
  // FIRST: the accounting facade below pulls the Mintsoft client into the module cache, after which a mock would not apply.
  mock.module('@/lib/connectors/mintsoft/api/client', {
    namedExports: {
      mintsoftRequest: async (path: string, init?: { method?: string; body?: string }) => {
        const pathname = path.split('?')[0]
        if (pathname === '/api/Order' && init?.method === 'PUT') {
          puts.push(init.body ?? '')
          return { data: [{ Success: true, OrderId: 900, OrderNumber: 'X', ExternalOrderReference: 'X' }], status: 200 }
        }
        if (pathname === '/api/Order/900' && (init?.method ?? 'GET') === 'GET') return { data: { ID: 900, OrderNumber: 'X', ExternalOrderReference: 'X', OrderStatusId: 1, ClientId: 5 }, status: 200 }
        if (pathname === '/api/Order/900/Items') return { data: [], status: 200 }
        throw new Error(`Unexpected Mintsoft path: ${path}`)
      },
    },
  })
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      isAccountingSyncTypeEnabledFor: async () => false,
    },
  })
  // The EU VAT treatment itself is out of scope: the double stamps the order IOSS exactly as the real treatment does, then reports it skipped.
  const treatment = await import('@/lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  mock.module('@/lib/connectors/woocommerce/sync/eu-vat-invoice-treatment', {
    namedExports: {
      ...treatment,
      treatImportedSalesInvoice: async (params: { orderId: string }) => {
        const { db } = await import('@/lib/db')
        await db.salesOrder.update({ where: { id: params.orderId }, data: { euVatRegime: 'IOSS', euVatLineAccount: '820', euVatRegimeStampedAt: new Date() } })
        return { kind: 'skipped', why: 'switch_off' }
      },
    },
  })
  mock.method(console, 'info', () => undefined)
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

async function seedTaxRate(db: Awaited<ReturnType<typeof loadDb>>, wcRateId: number, opts: { active?: boolean; mapped?: boolean } = {}) {
  const rate = await db.taxRate.create({ data: { name: `NL Standard ${randomUUID()}`, rate: 0.21, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'NL', taxCategory: 'STANDARD', active: opts.active ?? true } })
  if (opts.mapped !== false) await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'NL VAT', externalCountry: 'NL', externalRatePct: 21, taxRateId: rate.id } })
  return rate
}



test('[ioss held invoice] a held-invoice import mirrors the IOSS number, and the warehouse create uses the CURRENT shop number', { skip }, async (t) => {
  const db = await loadDb()
  await installDoubles()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { ORDER_PUSH_SELECT, buildPushInput } = await import('@/lib/domain/wms/order-push-sweep')
  const { pushMintsoftOrder } = await import('@/lib/connectors/mintsoft/api/order-push')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const rate = await seedTaxRate(db, wcRateId)
  const warehouse = await db.warehouse.create({ data: { code: `WIH-${randomUUID().slice(0, 8)}`, name: 'IOSS held test warehouse', syncToStore: true, availableForSale: true } })
  const keys = ['shop_ioss_number', 'mintsoft_client_id', 'mintsoft_send_ioss_number']
  const priorRows = await db.setting.findMany({ where: { key: { in: keys } } })
  const created: { orderId?: string } = {}
  t.after(async () => {
    const orderId = created.orderId
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
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const r of priorRows) await db.setting.create({ data: { key: r.key, value: r.value } })
  })
  for (const [key, value] of [['shop_ioss_number', 'IM5280000001'], ['mintsoft_client_id', '5'], ['mintsoft_send_ioss_number', 'true']] as const) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }

  // No _wcpdf_invoice_number: the sales invoice is HELD, and the import returns early.
  const result = await importWcOrder(payload(externalId, wcRateId) as never)
  assert.equal(result.success, true, JSON.stringify(result))
  const orderId = (created.orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId)
  assert.equal(await db.activityLog.count({ where: { entityId: orderId, action: 'sales_invoice_number_unavailable' } }), 1, 'the held-invoice early return was taken')
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })
  assert.deepEqual([order.euVatRegime, order.iossNumber, order.deliveryTerm], ['IOSS', 'IM5280000001', 'IOSS_DDP'], 'mirrored before the held return')

  const create = async (): Promise<Record<string, unknown>> => {
    puts = []
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_PUSH_SELECT })
    await pushMintsoftOrder(buildPushInput(row as never, '301'))
    assert.equal(puts.length, 1)
    return JSON.parse(puts[0]!) as Record<string, unknown>
  }
  assert.equal((await create()).IOSSNumber, 'IM5280000001')
  // The operator replaces the number before the order is pushed: the create uses the new one (the stored copy is stale and ignored).
  await db.setting.update({ where: { key: 'shop_ioss_number' }, data: { value: 'IM5289999999' } })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).iossNumber, 'IM5280000001', 'the stored copy is stale')
  assert.equal((await create()).IOSSNumber, 'IM5289999999')
  // Cleared: no IOSSNumber at all.
  await db.setting.update({ where: { key: 'shop_ioss_number' }, data: { value: '' } })
  assert.equal('IOSSNumber' in (await create()), false)
})
