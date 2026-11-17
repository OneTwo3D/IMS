import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * The duty / tax mirror, against a real PostgreSQL (real importer, scratch database). Owner decision D5: WooCommerce calculates, IMS mirrors.
 *   1. A new import stores the IOSS number, the delivery term, the wclc components and each line's customs value override exactly as WooCommerce
 *      reported them, and stores null for what it did not report.
 *   2. An edit in WooCommerce resyncs every one of them on the next delivery (changed, added and removed); a delivery with no meta list leaves them.
 *   3. Nothing is recomputed: values that disagree with the order's own lines and totals are stored as reported.
 *   4. The product import mirrors pa_us_hs_code and _dutify_hs_codes into their own columns, follows edits, and never writes the IMS-owned hsCode from them.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

// The accounting facade, partially mocked: the settings the import reads and a capture of what it enqueues. Nothing is sent anywhere.
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
      // The importer enqueues its invoice INSIDE the order-locked transaction. The queue double writes the real accounting_sync_logs row in that
      // transaction (the connector registry is not configured here), and the test reads the payload back from the row.
      queueAccountingSyncTxWithOutcome: async (tx: { accountingSyncLog: { create(args: unknown): Promise<unknown> } }, params: { type: string; referenceType: string; referenceId: string; payload: Record<string, unknown>; idempotencyKey?: string }) => {
        await tx.accountingSyncLog.create({ data: { type: params.type, status: 'PENDING', referenceType: params.referenceType, referenceId: params.referenceId, payload: { ...params.payload, _idempotencyKey: params.idempotencyKey } } })
        return { queued: true, connector: 'xero' }
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

async function seedTaxRate(db: Awaited<ReturnType<typeof loadDb>>, wcRateId: number, opts: { active?: boolean; mapped?: boolean } = {}) {
  const rate = await db.taxRate.create({ data: { name: `NL Standard ${randomUUID()}`, rate: 0.21, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'NL', taxCategory: 'STANDARD', active: opts.active ?? true } })
  if (opts.mapped !== false) await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'NL VAT', externalCountry: 'NL', externalRatePct: 21, taxRateId: rate.id } })
  return rate
}


const orderMeta = (...pairs: Array<[string, unknown]>) => pairs.map(([key, value], i) => ({ id: i + 1, key, value }))
const lineMeta = (value: unknown) => (value === undefined ? [] : [{ id: 1, key: '_wc_label_customs_unit_value', value }])

async function cleanup(db: Awaited<ReturnType<typeof loadDb>>, externalId: number, rateId: string, warehouseId: string, known?: string) {
  const orderId = known ?? (await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } }))?.orderId
  if (orderId) {
    await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
    await db.activityLog.deleteMany({ where: { entityId: orderId } })
    await db.salesOrderLine.deleteMany({ where: { orderId } })
    await db.salesOrder.deleteMany({ where: { id: orderId } })
  }
  await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
  await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rateId } })
  await db.warehouse.deleteMany({ where: { id: warehouseId } })
  await db.taxRate.deleteMany({ where: { id: rateId } })
}

test('[duty/tax mirror] import stores what WooCommerce reported, edits resync, nothing is recomputed, missing meta stays null', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder, updateExistingWcOrderFromPayload } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const rate = await seedTaxRate(db, wcRateId)
  const warehouse = await db.warehouse.create({ data: { code: `WDT-${randomUUID().slice(0, 8)}`, name: 'Duty/tax mirror test warehouse', syncToStore: true, availableForSale: true } })
  const ids: { orderId?: string } = {}
  t.after(() => cleanup(db, externalId, rate.id, warehouse.id, ids.orderId))
  const read = async () => db.salesOrder.findUniqueOrThrow({ where: { id: ids.orderId! }, include: { lines: { orderBy: { description: 'asc' } } } })
  const withLine = (p: ReturnType<typeof payload>, value: unknown) => ({ ...p, line_items: p.line_items.map((l) => ({ ...l, meta_data: lineMeta(value) })) })

  // 1. Create. The reported duty component (999.99) and the DDU_DAP term contradict the order's own fee lines and totals on purpose.
  const first = withLine(payload(externalId, wcRateId, [
    ...orderMeta(['_o3d_ioss_number', 'IM5280000001'], ['_o3d_delivery_term', 'DDU_DAP'], ['_wclc_duty_component', '999.99'], ['_wclc_tax_component', '0.01']),
    { id: 90, key: '_wcpdf_invoice_number', value: `INV-${externalId}` },
  ]), '12.50')
  const result = await importWcOrder(first as never)
  assert.equal(result.success, true, `import succeeded: ${JSON.stringify(result)}`)
  const orderId = (ids.orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId)
  let order = await read()
  assert.equal(order.iossNumber, 'IM5280000001')
  assert.equal(order.deliveryTerm, 'DDU_DAP')
  assert.equal(order.wclcDutyComponent?.toString(), '999.99', 'stored as reported, not reconciled with the fee lines')
  assert.equal(order.wclcTaxComponent?.toString(), '0.01')
  assert.equal(order.totalForeign.toString(), '189.5', 'the order total is untouched by the mirror')
  const widget = () => order.lines.find((l) => l.description === 'Widget')!
  assert.equal(widget().wcCustomsUnitValue?.toString(), '12.5')
  assert.ok(order.lines.filter((l) => l.description !== 'Widget').every((l) => l.wcCustomsUnitValue === null), 'fee lines carry no override')

  // 2. Edit in WooCommerce: every value changes; the next delivery resyncs the stored values and rebuilds no line.
  const edited = withLine(payload(externalId, wcRateId, orderMeta(['_o3d_ioss_number', 'IM5280000002'], ['_o3d_delivery_term', 'IOSS_DDP'], ['_wclc_duty_component', '3.10'], ['_wclc_handling_component', '2.00'])), '9.99')
  await updateExistingWcOrderFromPayload(orderId, edited as never)
  order = await read()
  assert.deepEqual([order.iossNumber, order.deliveryTerm, order.wclcDutyComponent?.toString(), order.wclcTaxComponent, order.wclcHandlingComponent?.toString()], ['IM5280000002', 'IOSS_DDP', '3.1', null, '2'])
  assert.equal(widget().wcCustomsUnitValue?.toString(), '9.99')
  assert.equal(order.lines.length, 5, 'no line added or rebuilt')
  assert.equal(order.totalForeign.toString(), '189.5')

  // 3. A delivery that carries no meta list at all says nothing: the stored values stay (an absent list is no evidence they went away).
  const silent = payload(externalId, wcRateId, []) as Record<string, unknown>
  delete silent.meta_data
  delete (silent.line_items as Array<Record<string, unknown>>)[0]!.meta_data
  await updateExistingWcOrderFromPayload(orderId, silent as never)
  order = await read()
  assert.deepEqual([order.iossNumber, order.deliveryTerm, order.wclcDutyComponent?.toString()], ['IM5280000002', 'IOSS_DDP', '3.1'])
  assert.equal(widget().wcCustomsUnitValue?.toString(), '9.99')

  // 4. WooCommerce removed them (a meta list is present and carries none): they clear.
  await updateExistingWcOrderFromPayload(orderId, withLine(payload(externalId, wcRateId, orderMeta(['_o3d_delivery_term', 'not-a-term'])), undefined) as never)
  order = await read()
  assert.deepEqual([order.iossNumber, order.deliveryTerm, order.wclcDutyComponent, order.wclcTaxComponent, order.wclcHandlingComponent], [null, null, null, null, null])
  assert.equal(widget().wcCustomsUnitValue, null)
})

test('[duty/tax mirror] an order WooCommerce reports no duty/tax meta for stores null in every mirrored column', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const rate = await seedTaxRate(db, wcRateId)
  const warehouse = await db.warehouse.create({ data: { code: `WDN-${randomUUID().slice(0, 8)}`, name: 'Duty/tax null test warehouse', syncToStore: true, availableForSale: true } })
  t.after(() => cleanup(db, externalId, rate.id, warehouse.id))
  const result = await importWcOrder(payload(externalId, wcRateId, [{ id: 90, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }]) as never)
  assert.equal(result.success, true, `import succeeded: ${JSON.stringify(result)}`)
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })
  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: link.orderId }, include: { lines: true } })
  assert.deepEqual([order.iossNumber, order.deliveryTerm, order.wclcDutyComponent, order.wclcTaxComponent, order.wclcHandlingComponent], [null, null, null, null, null])
  assert.ok(order.lines.every((l) => l.wcCustomsUnitValue === null))
})

test('[duty/tax mirror] the product import mirrors pa_us_hs_code and _dutify_hs_codes, follows edits, and never writes the IMS-owned hsCode from them', { skip }, async (t) => {
  const db = await loadDb()
  const { syncWcProductToIms } = await import('@/lib/connectors/woocommerce/sync/product-sync')
  const sku = `WDT-${randomUUID().slice(0, 10)}`
  const wcId = 1_000_000 + Math.floor(Math.random() * 900_000)
  t.after(async () => {
    const p = await db.product.findFirst({ where: { sku }, select: { id: true } })
    if (p) {
      await db.activityLog.deleteMany({ where: { entityId: p.id } })
      await db.product.deleteMany({ where: { id: p.id } })
    }
  })
  const product = (attributes: unknown[], metaData: unknown[]) => ({
    id: wcId, name: 'HS mirror test', sku, status: 'publish', type: 'simple', description: '', short_description: '', regular_price: '10.00', sale_price: '',
    weight: '', dimensions: { length: '', width: '', height: '' }, images: [], categories: [], tags: [], variations: [], parent_id: 0,
    date_modified_gmt: '2026-11-02T09:00:00', attributes, meta_data: metaData,
  })
  const attr = (slug: string, name: string, option: string) => ({ id: 1, name, slug, position: 0, visible: true, variation: false, options: [option] })
  const dutify = (map: Record<string, string>) => ({ id: 5, key: '_dutify_hs_codes', value: Object.fromEntries(Object.entries(map).map(([c, code]) => [c, { code, hash: 'h', at: 1, source: 'dutify_landed_cost' }])) })
  const read = () => db.product.findFirstOrThrow({ where: { sku }, select: { hsCode: true, wcUsHsCode: true, wcDutifyHsCodes: true } })

  // Create: the store's own code (hs_code) goes to hsCode as before; the two Woo tariff mirrors go to their own columns.
  let result = await syncWcProductToIms(product([attr('pa_hs_code', 'HS Code', '39219090'), attr('pa_us_hs_code', 'US HS Code', '3921905050')], [dutify({ US: '3921905050', CA: '3921909090' })]) as never)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.deepEqual(await read(), { hsCode: '39219090', wcUsHsCode: '3921905050', wcDutifyHsCodes: { US: '3921905050', CA: '3921909090' } })

  // An IMS-owned edit of hsCode is not overwritten by the mirrors, and the mirrors follow a WooCommerce edit (a removed code clears).
  await db.product.updateMany({ where: { sku }, data: { hsCode: '11111111' } })
  result = await syncWcProductToIms(product([attr('pa_us_hs_code', 'US HS Code', '3926909790')], [dutify({ US: '3926909790' })]) as never)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.deepEqual(await read(), { hsCode: '11111111', wcUsHsCode: '3926909790', wcDutifyHsCodes: { US: '3926909790' } }, 'hsCode kept (WooCommerce omitted pa_hs_code); mirrors follow')
  result = await syncWcProductToIms(product([], []) as never)
  assert.equal(result.success, true, JSON.stringify(result))
  assert.deepEqual(await read(), { hsCode: '11111111', wcUsHsCode: null, wcDutifyHsCodes: null })
})
