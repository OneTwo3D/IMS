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
/** The reverse-charge sales tax type setting the mocked accounting settings return; a test sets it and puts it back. */
let rcSetting = ''
/** The OFF case needs to see what the importer built; the real queue would write nothing. Only that case sets it. */
let recordWhenOff = false
let accountingMocked = false
/** A change made between the importer's first verification of a held invoice and its release's own order lock (the release re-verifies under that lock). Armed by one test. */
const betweenHook: { armed: boolean; verified: boolean; run: null | (() => Promise<void>) } = { armed: false, verified: false, run: null }
async function mockAccounting() {
  if (accountingMocked) return
  const verification = await import('@/lib/connectors/woocommerce/sync/held-invoice-verification')
  mock.module('@/lib/connectors/woocommerce/sync/held-invoice-verification', {
    namedExports: {
      ...verification,
      heldInvoiceDifference: (...args: Parameters<typeof verification.heldInvoiceDifference>) => {
        const difference = verification.heldInvoiceDifference(...args)
        if (betweenHook.armed && difference === null) betweenHook.verified = true
        return difference
      },
    },
  })
  const allocation = await import('@/lib/domain/sales/allocation-service')
  mock.module('@/lib/domain/sales/allocation-service', {
    namedExports: {
      ...allocation,
      lockSalesOrder: async (...args: Parameters<typeof allocation.lockSalesOrder>) => {
        if (betweenHook.armed && betweenHook.verified && betweenHook.run) {
          const run = betweenHook.run
          betweenHook.run = null
          betweenHook.armed = false
          await run()
        }
        return allocation.lockSalesOrder(...args)
      },
    },
  })
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({
        connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: rcSetting,
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
  await seedXeroList(db, { TAX131: '0.000000' })
  return { rate, warehouse }
}

/** The stored Xero tax-rate list the treatment proves the scheme posting type against (the hourly drift job's list): a connected organisation, a stamped, digested list. `rates` is taxType -> effective rate; a missing key is an unknown type. */
async function seedXeroList(db: Awaited<ReturnType<typeof loadDb>>, rates: Record<string, string>) {
  const { replaceXeroTaxRateList } = await import('@/lib/connectors/xero/tax-rate-store')
  const { TAX_RATE_DRIFT_LAST_CHECKED_SETTING } = await import('@/lib/connectors/xero/tax-rate-drift-sweeper')
  const now = new Date()
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'test', expiresAt: new Date(now.getTime() + 3_600_000), tenantId: 'tenant-eu-vat-test' } })
  await db.$transaction(async (tx) => {
    await replaceXeroTaxRateList(tx, {
      tenantId: 'tenant-eu-vat-test',
      fetchedAt: now,
      rows: [
        ...Object.entries(rates).map(([taxType, effectiveRate]) => ({ taxType, name: taxType, status: 'ACTIVE' as const, reportTaxType: null, effectiveRate, displayTaxRate: effectiveRate, components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } })),
        { taxType: 'ZERORATEDOUTPUT', name: 'Zero Rated', status: 'ACTIVE' as const, reportTaxType: null, effectiveRate: '0.000000', displayTaxRate: '0.000000', components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } },
      ],
    })
    await tx.setting.upsert({ where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, create: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: now.toISOString() }, update: { value: now.toISOString() } })
  })
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
  await db.xeroTaxRateList.deleteMany({ where: { connector: 'xero' } })
  await db.xeroTaxRate.deleteMany({ where: { connector: 'xero' } })
  await db.accountingToken.deleteMany({ where: { connector: 'xero', tenantId: 'tenant-eu-vat-test' } })
  await db.warehouse.deleteMany({ where: { id: ctx.warehouse.id } })
  await db.taxRate.deleteMany({ where: { id: ctx.rate.id } })
}

type Line = { description: string; quantity: number; unitAmount: number; accountCode: string; taxType?: string; noTaxKind?: string }
type Invoice = { lines: Line[]; shippingAmount: number; shippingTaxType?: string; shippingAccountCode?: string; _registerPayment?: boolean; _taxUnreconciled?: { reason: string }; _euVatTreatment?: Record<string, unknown> }

async function run(t: test.TestContext, meta: Array<{ id: number; key: string; value: unknown }>, on: boolean, list?: Record<string, string>) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = on
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  if (list) await seedXeroList(db, list)
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
  const { taxBinding, ...marker } = invoice._euVatTreatment as Record<string, unknown> & { taxBinding: { lineRateIds: unknown[]; shippingRateIds: unknown[]; rates: Record<string, { accountingTaxType: string; reverseCharge: boolean }>; lines: Array<{ rateId: string | null; source: string; type: string | null }>; shipping: { rateId: string | null; type: string | null } } }
  assert.deepEqual(marker, { applied: true, route: 'scheme', regime: 'IOSS', schemePostingTaxType: 'TAX131', orderTotal: '135.66', vatAccount: '821', feesRecoded: 1, roundingAdjustment: null })
  // The tax binding recorded BEFORE the treatment re-typed the lines: both lines and the shipping on the one WooCommerce rate, which resolved to the charged code.
  assert.equal(taxBinding.lineRateIds.length, 2)
  assert.equal(taxBinding.shippingRateIds.length, 1)
  assert.deepEqual(Object.values(taxBinding.rates).map((r) => [r.accountingTaxType, r.reverseCharge]), [['DE_CHARGED', false]])
  assert.deepEqual(taxBinding.lines.map((l) => [l.source, l.type]), [['woo-rate', 'DE_CHARGED'], ['woo-rate', 'DE_CHARGED']], 'the resolved source and effective pre-treatment type of each line')
  assert.equal(taxBinding.shipping.type, 'DE_CHARGED')
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

test('[eu vat] switch ON, the plugin recorded no account: the NUMBERED invoice is parked (never queued) with the refusal\'s reason, nothing is stamped on the order', { skip }, async (t) => {
  const { invoice, order, db, orderId } = await run(t, [{ id: 2, key: 'is_vat_exempt', value: 'no' }], true)
  assert.equal(invoice, null, 'a treatment refusal is not queued: the poster would always refuse it')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const held = (await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })).payload as unknown as { accountingPayload: Invoice }
  assert.deepEqual([held.accountingPayload._euVatTreatment?.applied, held.accountingPayload._euVatTreatment?.reason], [false, 'treatment_refused'])
  assert.match(String(held.accountingPayload._euVatTreatment?.refusal), /plugin_account_missing/)
  assert.equal(held.accountingPayload.lines[0]!.taxType, 'DE_CHARGED', 'the original payload, as built')
  assert.equal(held.accountingPayload._taxUnreconciled, undefined)
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
  assert.equal('_euVatTreatment' in accountingPayload, false, 'a switch-off hold carries NO marker: it is parked exactly as built')
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
  assert.match(after.errorMessage ?? '', /parked before the EU IOSS\/VOEC\/DDP treatment ran on it.*re-import the order/)
})

async function parkAndRelease(t: test.TestContext, opts: { parkWithSwitch: boolean; stripMarker: boolean }) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = opts.parkWithSwitch
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const result = await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)
  assert.equal(result.success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = held.payload as unknown as { accountingPayload: Invoice } & Record<string, unknown>
  if (opts.stripMarker) {
    // A hold parked before this change existed: no treatment marker at all.
    const { _euVatTreatment: _drop, ...legacy } = parked.accountingPayload
    void _drop
    await db.shoppingSyncLog.update({ where: { id: held.id }, data: { payload: { ...parked, accountingPayload: legacy } as never } })
  }
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  switchOn = true
  await retryHeldWcSalesInvoiceReleases()
  return { db, orderId, held, parked, after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] a hold parked with the switch ON carries applied:true and releases treated (positive control)', { skip }, async (t) => {
  const { parked, rows } = await parkAndRelease(t, { parkWithSwitch: true, stripMarker: false })
  assert.equal((parked.accountingPayload._euVatTreatment as { applied: boolean }).applied, true)
  assert.equal(rows.length, 1, 'released')
  assert.equal((rows[0]!.payload as unknown as Invoice).lines.at(-1)!.noTaxKind, 'eu-vat-recovery')
})

test('[eu vat] a LEGACY hold (no treatment marker) is kept PENDING with the re-import note once the switch is on, not released untreated', { skip }, async (t) => {
  const { parked, after, rows } = await parkAndRelease(t, { parkWithSwitch: true, stripMarker: true })
  assert.equal('_euVatTreatment' in parked.accountingPayload, true, 'the fixture really was parked with a marker before it was stripped')
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /parked before the EU IOSS\/VOEC\/DDP treatment ran on it.*re-import the order/)
})

test('[eu vat] a stamped IOSS order whose facts now decide DDP is refused, not treated through the IOSS stamp', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  recordWhenOff = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { treatImportedSalesInvoice } = await import('@/lib/connectors/woocommerce/sync/eu-vat-invoice-treatment')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const num = { id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }
  assert.equal((await importWcOrder(payload(externalId, wcRateId, [num, ...PLUGIN('821')]) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).euVatRegime, 'IOSS')
  const invoice = (await db.accountingSyncLog.findFirstOrThrow({ where: { type: 'SALES_INVOICE', referenceId: orderId } })).payload as unknown as Record<string, unknown>
  const base = { orderId, payload: { currency: 'GBP', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: 'DE_CHARGED' }, { description: 'EU Customs Fee', quantity: 1, unitAmount: 4, accountCode: '200', taxType: 'DE_CHARGED' }], shippingAmount: 10, shippingAccountCode: '260', shippingTaxType: 'DE_CHARGED' } as Record<string, unknown>,
    mappedLines: [{ isFeeLine: false, wclcFeeKind: null, forceNoTax: false, taxForeign: 19 }, { isFeeLine: true, wclcFeeKind: 'uhf' as const, forceNoTax: false, taxForeign: 0.76 }],
    connector: 'xero', taxBindingDeps: { reverseChargeSalesTaxType: '', invoiceTypes: { lines: [{ rateId: null, source: 'woo-rate', type: 'DE_CHARGED' }, { rateId: null, source: 'woo-rate', type: 'DE_CHARGED' }], shipping: { rateId: null, type: 'DE_CHARGED' }, discount: { rateId: null, source: 'mapped', type: 'DE_CHARGED' } } }, accounts: { ioss: '821', ddp: '232', fee: '232', rounding: '860' }, storeCreditForeign: { gt: () => false }, now: new Date() }
  void invoice
  // The same facts: still IOSS, treated.
  const same = await treatImportedSalesInvoice({ ...base, wcOrder: payload(externalId, wcRateId, [num, ...PLUGIN('821')]) as never })
  assert.equal(same.kind, 'treated')
  // The facts now decide DDP (the plugin's recorded account changed, as a crossed threshold would change it): the stamp stays IOSS and the order is refused.
  const changed = await treatImportedSalesInvoice({ ...base, wcOrder: payload(externalId, wcRateId, [num, ...PLUGIN('232')]) as never })
  assert.equal(changed.kind, 'refused')
  assert.match(changed.kind === 'refused' ? changed.reason : '', /stamped IOSS on account 821, but its facts now decide DDP on account 232/)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).euVatRegime, 'IOSS', 'the stamp is never re-derived')
})

const REFUSED_LISTS: Array<{ label: string; list: Record<string, string>; expect: RegExp }> = [
  { label: 'a TAXABLE posting type (19% in Xero)', list: { TAX131: '19.000000' }, expect: /19.*% in Xero, not zero-rated/ },
  { label: 'an UNKNOWN posting type (not in the stored Xero list)', list: { TAX999: '0.000000' }, expect: /TAX131 is not in the stored Xero tax-rate list/ },
]
for (const scenario of REFUSED_LISTS) {
  test(`[eu vat] ${scenario.label}: the invoice is refused, not built on it`, { skip }, async (t) => {
    const { invoice, db, orderId } = await run(t, PLUGIN('821'), true, scenario.list)
    assert.equal(invoice, null, 'not queued')
    const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
    const held = (await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })).payload as unknown as { accountingPayload: Invoice }
    assert.equal(held.accountingPayload._euVatTreatment?.reason, 'treatment_refused')
    assert.match(String(held.accountingPayload._euVatTreatment?.refusal), scenario.expect)
    assert.equal(held.accountingPayload.lines.some((l) => l.noTaxKind === 'eu-vat-recovery'), false)
  })
}

test('[eu vat] the poster re-checks the scheme posting type: proven zero-rated posts, a type that turned taxable in Xero since is refused, and a payload without the marker is untouched', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  const { euSchemePostingRefusal } = await import('@/lib/connectors/xero/scheme-posting-check')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { await cleanup(db, externalId, ctx) })
  const treated = { invoiceNumber: 'INV-1', _euVatTreatment: { applied: true, route: 'scheme', regime: 'IOSS', schemePostingTaxType: 'TAX131', vatAccount: '821' } }
  assert.equal(await euSchemePostingRefusal(treated), null)
  assert.equal(await euSchemePostingRefusal({ invoiceNumber: 'INV-2' }), null)
  assert.equal(await euSchemePostingRefusal({ invoiceNumber: 'INV-3', _euVatTreatment: { applied: true, route: 'none' } }), null)
  await seedXeroList(db, { TAX131: '20.000000' })
  assert.match((await euSchemePostingRefusal(treated)) ?? '', /^NOTHING WAS SENT\. Sales invoice INV-1 was refused: .*20.*% in Xero, not zero-rated/)
  await seedXeroList(db, { TAX999: '0.000000' })
  assert.match((await euSchemePostingRefusal(treated)) ?? '', /not in the stored Xero tax-rate list/)
  await db.xeroTaxRateList.deleteMany({ where: { connector: 'xero' } })
  assert.match((await euSchemePostingRefusal(treated)) ?? '', /cannot be relied on/)
})

async function parkOffThenReimport(t: test.TestContext, reimportMeta: Array<{ id: number; key: string; value: unknown }>) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  // Parked with the switch off: no invoice number yet, built without the treatment.
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  assert.equal('_euVatTreatment' in (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload, false, 'parked with no marker')
  // The switch comes on, WooCommerce numbers the invoice, and the order is delivered again.
  switchOn = true
  await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...reimportMeta]) as never)
  return {
    db, orderId, held,
    after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }),
    rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }),
    order: await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { euVatRegime: true, euVatLineAccount: true } }),
  }
}

test('[eu vat] a hold parked with the switch OFF is treated and released when the switch is on and the order is re-imported', { skip }, async (t) => {
  const { rows, order, after } = await parkOffThenReimport(t, PLUGIN('821'))
  assert.equal(rows.length, 1, 'the held invoice was released')
  const invoice = rows[0]!.payload as unknown as Invoice
  assert.deepEqual(invoice.lines.map((l) => [l.accountCode, l.taxType, l.noTaxKind ?? null]), [['200', 'TAX131', null], ['232', 'NONE', 'fee-no-tax'], ['821', 'NONE', 'eu-vat-recovery']])
  assert.equal(invoice.shippingTaxType, 'TAX131')
  assert.equal(total(invoice), 135.66)
  assert.equal(invoice._taxUnreconciled, undefined)
  assert.equal(order.euVatRegime, 'IOSS')
  assert.equal(after.status, 'SYNCED')
})

test('[eu vat] a re-import whose treatment REFUSES leaves the hold PENDING with the refusal reason, queues nothing', { skip }, async (t) => {
  const { rows, after } = await parkOffThenReimport(t, [{ id: 2, key: 'is_vat_exempt', value: 'no' }])
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /not released: the EU IOSS\/VOEC\/DDP treatment refused it: .*plugin_account_missing.*re-import the order from WooCommerce to try again\. NOTHING was queued/)
})

type Meta = Array<{ id: number; key: string; value: unknown }>
/** Park a hold (switch `parkWith`), then deliver the order again with `change` applied to the payload and the invoice number present, with the switch ON. */
async function parkThenChange(t: test.TestContext, parkWith: boolean, reimportMeta: Meta, change: (p: ReturnType<typeof payload>) => void = () => {}) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = parkWith
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  switchOn = true
  const changed = payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...reimportMeta])
  change(changed)
  await importWcOrder(changed as never)
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  return { db, orderId, after, rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] an already TREATED hold whose regime changes before numbering stays PENDING, marked order_changed, and nothing is queued', { skip }, async (t) => {
  // Parked treated as IOSS (account 821); delivered again deciding DDP (account 232).
  const { after, rows } = await parkThenChange(t, true, PLUGIN('232'))
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held .*needs its invoice rebuilt/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] an already TREATED hold whose goods changed before numbering stays PENDING', { skip }, async (t) => {
  const { after, rows } = await parkThenChange(t, true, PLUGIN('821'), (p) => {
    p.line_items[0]!.subtotal = '110.00'; p.line_items[0]!.total = '110.00'; p.line_items[0]!.total_tax = '20.90'; p.line_items[0]!.taxes = [{ id: p.line_items[0]!.taxes[0]!.id, total: '20.90', subtotal: '20.90' }]
    p.tax_lines[0]!.tax_total = '21.66'; p.total = '147.56'; p.total_tax = '23.56'
  })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held .*unit amount.*needs its invoice rebuilt/)
})

test('[eu vat] an UNCHANGED treated hold is still released on re-import (positive control)', { skip }, async (t) => {
  const { after, rows } = await parkThenChange(t, true, PLUGIN('821'))
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
  assert.equal((rows[0]!.payload as unknown as Invoice).lines.at(-1)!.noTaxKind, 'eu-vat-recovery')
})

test('[eu vat] a LEGACY hold whose order keeps the same line count and total but a different line split refuses and stays PENDING', { skip }, async (t) => {
  // Parked untreated (switch off): goods 100.00 + fee 4.00. Delivered again with goods 98.00 + fee 6.00: same two lines, same total 135.66.
  const { after, rows } = await parkThenChange(t, false, PLUGIN('821'), (p) => {
    const rate = p.line_items[0]!.taxes[0]!.id
    p.line_items[0]!.subtotal = '98.00'; p.line_items[0]!.total = '98.00'; p.line_items[0]!.total_tax = '18.62'; p.line_items[0]!.taxes = [{ id: rate, total: '18.62', subtotal: '18.62' }]
    p.fee_lines[0]!.total = '6.00'; p.fee_lines[0]!.total_tax = '1.14'; p.fee_lines[0]!.taxes = [{ id: rate, total: '1.14' }]
    assert.equal(p.total, '135.66')
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held .*unit amount.*needs its invoice rebuilt/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] the order changes AFTER the first verification and BEFORE the release: the release re-verifies under its own lock and does not release', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; betweenHook.armed = false; betweenHook.run = null; await cleanup(db, externalId, ctx) })
  // Parked treated (IOSS, 821) with the switch on.
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  assert.equal(((held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as { applied: boolean }).applied, true)
  // The numbered delivery is unchanged, so the FIRST verification passes. Then, just before the release takes its lock, the order's regime stamp is changed by someone else.
  betweenHook.verified = false
  betweenHook.armed = true
  betweenHook.run = async () => { await db.salesOrder.update({ where: { id: orderId }, data: { euVatRegime: 'DDP', euVatLineAccount: '232' } }) }
  await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...PLUGIN('821')]) as never)
  assert.equal(betweenHook.verified, true, 'the first verification passed')
  assert.equal(betweenHook.run, null, 'the change really happened between the verification and the release')
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'nothing was queued')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(.*stamped DDP on account 232.*\) and needs its invoice rebuilt/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] a SWEEP that read the hold, then a re-import that marks it order_changed under the lock, then the sweep\'s release: nothing is queued', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; betweenHook.armed = false; betweenHook.verified = false; betweenHook.run = null; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  assert.equal(((held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as { applied: boolean }).applied, true)
  // The order now has its number, so the sweep will pick the hold up.
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  // The sweep has read the hold (applied:true) and reaches the release's order lock; just before it takes it, a RE-IMPORT of a changed order (goods changed) runs and marks the hold order_changed.
  betweenHook.verified = true
  betweenHook.armed = true
  betweenHook.run = async () => {
    const changed = payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...PLUGIN('821')])
    changed.line_items[0]!.subtotal = '110.00'; changed.line_items[0]!.total = '110.00'; changed.line_items[0]!.total_tax = '20.90'
    changed.line_items[0]!.taxes = [{ id: changed.line_items[0]!.taxes[0]!.id, total: '20.90', subtotal: '20.90' }]
    changed.tax_lines[0]!.tax_total = '21.66'; changed.total = '147.56'; changed.total_tax = '23.56'
    await importWcOrder(changed as never)
  }
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(betweenHook.run, null, 'the re-import really ran between the sweep\'s read and its release lock')
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'the sweep queued nothing')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] a treated hold whose order\'s fee lost its landed-cost marker while held stays PENDING (the marker is checked apart from no-tax status)', { skip }, async (t) => {
  const { after, rows } = await parkThenChange(t, true, PLUGIN('821'), (p) => {
    // The fee becomes an ordinary untaxed fee: still on no tax, no longer the landed-cost fee.
    p.fee_lines[0]!.meta_data = []; p.fee_lines[0]!.total_tax = '0.00'; p.fee_lines[0]!.taxes = []
    p.tax_lines[0]!.tax_total = '19.00'; p.total = '134.90'; p.total_tax = '20.90'
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held .*landed-cost fee marker differs.*needs its invoice rebuilt/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] a held invoice whose order changed currency while held is not released in the old currency', { skip }, async (t) => {
  const { after, rows } = await parkThenChange(t, true, PLUGIN('821'), (p) => { p.currency = 'EUR' })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(the parked invoice is in GBP but the order is now in EUR\) and needs its invoice rebuilt/)
})

// ---- an ordinary domestic (non-scheme) 20% VAT hold ----
const GB_ADDRESS = { ...ADDRESS, city: 'London', postcode: 'SW1A 1AA', country: 'GB' }
function domesticPayload(externalId: number, wcRateId: number, meta: Meta) {
  return {
    ...payload(externalId, wcRateId, meta), billing: GB_ADDRESS, shipping: GB_ADDRESS,
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '20.00', total: '100.00', total_tax: '20.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcRateId, total: '20.00', subtotal: '20.00' }], meta_data: [] }],
    fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: '20.00', shipping_tax_total: '2.00', meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Flat', method_id: 'flat_rate', total: '10.00', total_tax: '2.00', taxes: [{ id: wcRateId, total: '2.00' }], meta_data: [] }],
    total: '132.00', total_tax: '22.00',
  }
}
async function seedDomestic(db: Awaited<ReturnType<typeof loadDb>>, wcRateId: number) {
  const rate = await db.taxRate.create({ data: { name: `GB VAT ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD', active: true } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'UK VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `EUD-${randomUUID().slice(0, 8)}`, name: 'Domestic hold test warehouse', syncToStore: true, availableForSale: true } })
  return { rate, warehouse }
}
async function domesticHold(t: test.TestContext, changeTotal: boolean, between?: (db: Awaited<ReturnType<typeof loadDb>>, rateId: string) => Promise<void>, parkSetting = '') {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, wcRateId)
  t.after(async () => { switchOn = false; rcSetting = ''; await cleanup(db, externalId, ctx) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  rcSetting = parkSetting
  assert.equal((await importWcOrder(domesticPayload(externalId, wcRateId, extra) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const marker = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as Record<string, unknown>
  assert.deepEqual([marker.applied, marker.route, marker.orderTotal], [true, 'none', '132.00'])
  if (between) await between(db, ctx.rate.id)
  const again = domesticPayload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra])
  if (changeTotal) { again.shipping_lines[0]!.total_tax = '3.00'; again.tax_lines[0]!.shipping_tax_total = '3.00'; again.total = '133.00'; again.total_tax = '23.00' }
  await importWcOrder(again as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] an UNCHANGED domestic 20% VAT hold (route none) is released on re-import: its taxed total is not compared as an untaxed sum', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false)
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
  const invoice = rows[0]!.payload as unknown as Invoice
  assert.deepEqual(invoice.lines.map((l) => [l.accountCode, l.taxType]), [['200', 'OUTPUT2']])
  assert.equal(invoice.shippingTaxType, 'OUTPUT2')
})

test('[eu vat] a domestic hold whose order total changed (a tax figure) while held stays PENDING', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, true)
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order total was 132\.00 when the invoice was held and is 133\.00 now/)
})

test('[eu vat] a hold parked with the switch OFF is parked byte for byte as the importer built it: no marker, same keys and lines as the payload queued for a numbered order', { skip }, async (t) => {
  recordWhenOff = true
  t.after(() => { recordWhenOff = false })
  // The numbered order: the double records what the importer built (switch off).
  const queued = await run(t, PLUGIN('821'), false)
  assert.ok(queued.invoice)
  // The unnumbered order: the same importer parks the same payload.
  const db = await loadDb()
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { await cleanup(db, externalId, ctx) })
  switchOn = false
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const parked = ((await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })).payload as unknown as { accountingPayload: Record<string, unknown> & { lines: Array<Record<string, unknown>> } }).accountingPayload
  assert.equal('_euVatTreatment' in parked, false)
  const built = queued.invoice as unknown as Record<string, unknown> & { lines: Array<Record<string, unknown>> }
  const strip = (l: Record<string, unknown>) => { const { itemCode: _i, taxRateId: _r, ...rest } = l; void _i; void _r; return rest }
  const control = (o: Record<string, unknown>) => Object.keys(o).filter((k) => !['invoiceNumber', '_idempotencyKey', 'reference', '_paymentId'].includes(k)).sort()
  assert.deepEqual(control(parked), control(built), 'the same set of payload keys')
  assert.deepEqual(parked.lines.map(strip), built.lines.map(strip), 'the same lines')
  for (const key of ['shippingAmount', 'shippingTaxType', 'shippingAccountCode', 'currency', 'lineAmountsIncludeTax', '_registerPayment']) assert.deepEqual(parked[key], built[key], key)
})

/** Park a scheme invoice whose treatment REFUSES (the plugin recorded no VAT account) with no invoice number, then deliver the order again with a number and `fixedMeta`. */
async function parkRefusedThenReimport(t: test.TestContext, fixedMeta: Meta, numbered = false) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const numberMeta: Meta = numbered ? [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }] : []
  assert.equal((await importWcOrder(payload(externalId, wcRateId, [...numberMeta, { id: 2, key: 'is_vat_exempt', value: 'no' }]) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, numbered ? 'a numbered treatment refusal queued nothing (the poster would always refuse it)' : 'nothing queued')
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload
  // Parked as an UNTREATED hold carrying the refusal's reason, never applied:true; the original payload (no stamp).
  assert.deepEqual([parked._euVatTreatment?.applied, parked._euVatTreatment?.reason], [false, 'treatment_refused'])
  assert.match(String(parked._euVatTreatment?.refusal), /plugin_account_missing/)
  assert.equal(parked._taxUnreconciled, undefined)
  // The numbered order is delivered again, switch on. (The sweep first: it must never release an applied:false hold.)
  if (!numbered) await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'the sweep did not release the refused hold')
  assert.match((await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })).errorMessage ?? '', numbered ? /treatment refused it: .*plugin_account_missing/ : /^$|.*/)
  await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, { id: 2, key: 'is_vat_exempt', value: 'no' }, ...fixedMeta]) as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), order: await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { euVatRegime: true } }) }
}

test('[eu vat] a scheme invoice parked with a treatment REFUSAL and no number: the cause fixed, the re-import treats it and releases it', { skip }, async (t) => {
  const { after, rows, order } = await parkRefusedThenReimport(t, [{ id: 1, key: '_o3d_ioss_vat_account', value: '821' }])
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
  const invoice = rows[0]!.payload as unknown as Invoice
  assert.deepEqual(invoice.lines.map((l) => [l.accountCode, l.taxType, l.noTaxKind ?? null]), [['200', 'TAX131', null], ['232', 'NONE', 'fee-no-tax'], ['821', 'NONE', 'eu-vat-recovery']])
  assert.equal(total(invoice), 135.66)
  assert.equal(order.euVatRegime, 'IOSS')
})

test('[eu vat] the same refused hold with the cause NOT fixed stays PENDING with the refusal reason and queues nothing', { skip }, async (t) => {
  const { after, rows } = await parkRefusedThenReimport(t, [])
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /treatment refused it: .*plugin_account_missing/)
})

// ---- two equal-value lines that exchange taxable and zero-rated status ----
function twoLinePayload(externalId: number, rate20: number, rate0: number, meta: Meta, swap: boolean) {
  const taxed = (id: number, name: string, rate: number) => ({ id, name, product_id: id, variation_id: 0, quantity: 1, tax_class: '', subtotal: '50.00', subtotal_tax: '10.00', total: '50.00', total_tax: '10.00', sku: `NOSKU-${externalId}-${id}`, price: 50, taxes: [{ id: rate, total: '10.00', subtotal: '10.00' }], meta_data: [] })
  const zero = (id: number, name: string, rate: number) => ({ ...taxed(id, name, rate), subtotal_tax: '0.00', total_tax: '0.00', taxes: [{ id: rate, total: '0.00', subtotal: '0.00' }] })
  const base = domesticPayload(externalId, rate20, meta)
  return {
    ...base,
    line_items: swap ? [zero(1, 'Widget A', rate0), taxed(2, 'Widget B', rate20)] : [taxed(1, 'Widget A', rate20), zero(2, 'Widget B', rate0)],
    shipping_lines: [], shipping_total: '0.00', shipping_tax: '0.00',
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: rate20, label: 'VAT', compound: false, tax_total: '10.00', shipping_tax_total: '0.00', meta_data: [] }, { id: 22, rate_code: 'GB-ZERO-1', rate_id: rate0, label: 'Zero', compound: false, tax_total: '0.00', shipping_tax_total: '0.00', meta_data: [] }],
    total: '110.00', total_tax: '10.00',
  }
}
async function twoLineHold(t: test.TestContext, opts: { parkOn: boolean; swap: boolean }) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = opts.parkOn
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const rate20 = 900_000 + Math.floor(Math.random() * 40_000)
  const rate0 = 940_000 + Math.floor(Math.random() * 40_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, rate20)
  const zeroRate = await db.taxRate.create({ data: { name: `GB Zero ${randomUUID()}`, rate: 0, usedFor: 'SALES', accountingTaxType: 'ZERORATEDOUTPUT', countryCode: 'GB', taxCategory: 'ZERO', active: true } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(rate0), externalName: 'Zero Rated', externalCountry: 'GB', externalRatePct: 0, taxRateId: zeroRate.id } })
  t.after(async () => { switchOn = false; await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: zeroRate.id } }); await cleanup(db, externalId, ctx); await db.taxRate.deleteMany({ where: { id: zeroRate.id } }) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  assert.equal((await importWcOrder(twoLinePayload(externalId, rate20, rate0, extra, false) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  switchOn = true
  await importWcOrder(twoLinePayload(externalId, rate20, rate0, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra], opts.swap) as never)
  return { held, after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: an unchanged two-line hold (one taxable, one zero-rated) is released on re-import', { skip }, async (t) => {
  const { held, rows } = await twoLineHold(t, { parkOn: true, swap: false })
  const binding = ((held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as { taxBinding?: { lineRateIds: unknown[] } }).taxBinding
  assert.equal(binding?.lineRateIds.length, 2, 'the parked marker recorded the tax binding')
  assert.equal(rows.length, 1, 'released')
  assert.deepEqual((rows[0]!.payload as unknown as Invoice).lines.map((l) => l.taxType), ['OUTPUT2', 'ZERORATEDOUTPUT'])
})

test('[eu vat] equal-value lines exchange taxable and zero-rated status (total unchanged): a TREATED hold stays PENDING', { skip }, async (t) => {
  const { after, rows } = await twoLineHold(t, { parkOn: true, swap: true })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(line 1: the resolved tax rate and type changed from .*(OUTPUT2|ZERORATEDOUTPUT).* to .*(OUTPUT2|ZERORATEDOUTPUT).*\) and needs its invoice rebuilt/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] the same exchange on an UNTREATED hold (parked with the switch off) is refused too', { skip }, async (t) => {
  const { after, rows } = await twoLineHold(t, { parkOn: false, swap: true })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(line 1: the parked tax type is OUTPUT2, the order's line now resolves to ZERORATEDOUTPUT\)/)
})

// ---- every input that decides a posted tax type is recorded and compared ----
test('[eu vat] the reverse-charge FLAG flips on the mapped rate (same id, same base type, empty setting so the posted type does not change): the hold is refused', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false, async (db, rateId) => { await db.taxRate.update({ where: { id: rateId }, data: { reverseCharge: true } }) })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /WooCommerce tax rate \d+: reverseCharge changed from false to true/)
  assert.match(after.errorMessage ?? '', /needs its invoice rebuilt/)
})

test('[eu vat] the reverse-charge flag flips with a reverse-charge setting in force (the posted type swaps): refused', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false, async (db, rateId) => { await db.taxRate.update({ where: { id: rateId }, data: { reverseCharge: true } }) }, 'ECOUTPUTSERVICES')
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /line 1: the resolved tax rate and type changed from .*OUTPUT2.* to .*ECOUTPUTSERVICES/)
})

test('[eu vat] the reverse-charge SALES tax type SETTING changes while the hold waits: refused', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false, async () => { rcSetting = 'ECOUTPUTSERVICES' })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the reverse-charge sales tax type setting changed from "" to "ECOUTPUTSERVICES"/)
})

test('[eu vat] the mapped rate is made INACTIVE (archived) while the hold waits: refused', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false, async (db, rateId) => { await db.taxRate.update({ where: { id: rateId }, data: { active: false } }) })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /WooCommerce tax rate \d+: active changed from true to false/)
})

test('[eu vat] the mapped rate\'s accounting tax type or its percentage changes while the hold waits: refused', { skip }, async (t) => {
  const { after, rows } = await domesticHold(t, false, async (db, rateId) => { await db.taxRate.update({ where: { id: rateId }, data: { accountingTaxType: 'OUTPUT3', rate: 0.25 } }) })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /line 1: the resolved tax rate and type changed from .*OUTPUT2.* to .*OUTPUT3/)
})

test('[eu vat] an UNTREATED hold: the reverse-charge setting and flag change so the line\'s effective type changes: refused', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, wcRateId)
  t.after(async () => { switchOn = false; rcSetting = ''; await cleanup(db, externalId, ctx) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  assert.equal((await importWcOrder(domesticPayload(externalId, wcRateId, extra) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  assert.equal('_euVatTreatment' in (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload, false)
  // The switch comes on, the rate becomes reverse-charge and the setting is configured: the line now resolves to the reverse-charge type, not the parked OUTPUT2.
  await db.taxRate.update({ where: { id: ctx.rate.id }, data: { reverseCharge: true } })
  rcSetting = 'ECOUTPUTSERVICES'
  switchOn = true
  await importWcOrder(domesticPayload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra]) as never)
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0)
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /line 1: the parked tax type is OUTPUT2, the order's line now resolves to ECOUTPUTSERVICES/)
})

// ---- a line that names NO WooCommerce rate still resolves to a rate (category resolver, else the order default): that selection is compared too ----
const ZZ_ADDRESS = { ...ADDRESS, city: 'Zed', postcode: '00000', country: 'ZZ' }
type ZzRate = { id: string }
async function zzHold(t: test.TestContext, kind: 'category' | 'default', change: null | ((db: Awaited<ReturnType<typeof loadDb>>, rates: { main: ZzRate; wcMain: number; wcExtra: number; track: (id: string) => void }) => Promise<void>)) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcMain = 900_000 + Math.floor(Math.random() * 40_000)
  const wcExtra = 940_000 + Math.floor(Math.random() * 40_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const created: string[] = []
  const warehouse = await db.warehouse.create({ data: { code: `EZZ-${randomUUID().slice(0, 8)}`, name: 'Rate-less line test warehouse', syncToStore: true, availableForSale: true } })
  const mk = async (data: { name: string; rate: number; type: string; category: 'STANDARD' | 'ZERO' | 'REDUCED'; wc?: number }) => {
    const rate = await db.taxRate.create({ data: { name: `${data.name} ${randomUUID()}`, rate: data.rate, usedFor: 'SALES', accountingTaxType: data.type, countryCode: 'zz', taxCategory: data.category, active: true } })
    created.push(rate.id)
    if (data.wc !== undefined) await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(data.wc), externalName: data.name, externalCountry: 'ZZ', externalRatePct: data.rate * 100, taxRateId: rate.id } })
    return rate
  }
  // category: the only STANDARD rate for zz is the 20% one the order's tax line names; default: the order's tax line names a 0% rate (ZERO category), so a rate-less STANDARD line finds no category rate and takes the order default.
  const main = kind === 'category' ? await mk({ name: 'ZZ VAT', rate: 0.2, type: 'OUTPUT2', category: 'STANDARD', wc: wcMain }) : await mk({ name: 'ZZ Zero', rate: 0, type: 'ZERORATEDOUTPUT', category: 'ZERO', wc: wcMain })
  t.after(async () => {
    switchOn = false
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
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: { in: created } } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: { in: created } } })
  })
  const taxed = kind === 'category'
  const order = (meta: Meta, extraTaxLine: boolean) => ({
    ...payload(externalId, wcMain, meta), billing: ZZ_ADDRESS, shipping: ZZ_ADDRESS,
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: taxed ? '20.00' : '0.00', total: '100.00', total_tax: taxed ? '20.00' : '0.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [], meta_data: [] }],
    fee_lines: [], shipping_lines: [], shipping_total: '0.00', shipping_tax: '0.00',
    tax_lines: [{ id: 21, rate_code: 'ZZ-1', rate_id: wcMain, label: 'VAT', compound: false, tax_total: taxed ? '20.00' : '0.00', shipping_tax_total: '0.00', meta_data: [] }, ...(extraTaxLine ? [{ id: 22, rate_code: 'ZZ-2', rate_id: wcExtra, label: 'Standard', compound: false, tax_total: '0.00', shipping_tax_total: '0.00', meta_data: [] }] : [])],
    total: taxed ? '120.00' : '100.00', total_tax: taxed ? '20.00' : '0.00',
  })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  assert.equal((await importWcOrder(order(extra, false) as never)).success, true, 'the parked import succeeded')
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const marker = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as { taxBinding: { lines: Array<{ rateId: string | null; source: string; type: string | null }> } }
  assert.deepEqual(marker.taxBinding.lines.map((l) => [l.source, l.type, l.rateId === main.id]), [[kind === 'category' ? 'category' : 'default', taxed ? 'OUTPUT2' : 'ZERORATEDOUTPUT', true]], 'the rate-less line\'s resolved rate, source and type were recorded')
  if (change) await change(db, { main, wcMain, wcExtra, track: (id) => { created.push(id) } })
  await importWcOrder(order([{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra], kind === 'default' && change !== null) as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: an unchanged hold whose line names no WooCommerce rate (category-resolved) is released', { skip }, async (t) => {
  const { rows } = await zzHold(t, 'category', null)
  assert.equal(rows.length, 1, 'released')
  assert.deepEqual((rows[0]!.payload as unknown as Invoice).lines.map((l) => l.taxType), ['OUTPUT2'])
})

test('[eu vat] a rate-less line whose CATEGORY resolver selection changes to a different tax type at the SAME percentage is refused', { skip }, async (t) => {
  const { after, rows } = await zzHold(t, 'category', async (db, { main, track }) => {
    // Another active 20% zz STANDARD rate on a different Xero type; the original is retired, so the resolver now selects the new one.
    const other = await db.taxRate.create({ data: { name: `ZZ VAT B ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT3', countryCode: 'zz', taxCategory: 'STANDARD', active: true } })
    await db.taxRate.update({ where: { id: main.id }, data: { active: false } })
    track(other.id)
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(line 1: the resolved tax rate and type changed from .*OUTPUT2.* to .*OUTPUT3.*\) and needs its invoice rebuilt/)
})

test('[eu vat] CONTROL: an unchanged hold whose line takes the ORDER DEFAULT is released', { skip }, async (t) => {
  const { rows } = await zzHold(t, 'default', null)
  assert.equal(rows.length, 1, 'released')
  assert.deepEqual((rows[0]!.payload as unknown as Invoice).lines.map((l) => l.taxType), ['ZERORATEDOUTPUT'])
})

test('[eu vat] the ORDER DEFAULT changes (the order now names a "Standard" rate on another Xero type): a rate-less line that took the default is refused', { skip }, async (t) => {
  const { after, rows } = await zzHold(t, 'default', async (db, { wcExtra, track }) => {
    const standard = await db.taxRate.create({ data: { name: `ZZ Standard ${randomUUID()}`, rate: 0, usedFor: 'SALES', accountingTaxType: 'EXEMPTOUTPUT', countryCode: 'zz', taxCategory: 'REDUCED', active: true } })
    track(standard.id)
    await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcExtra), externalName: 'Standard', externalCountry: 'ZZ', externalRatePct: 0, taxRateId: standard.id } })
  })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /line 1: the resolved tax rate and type changed from .*ZERORATEDOUTPUT.* to .*EXEMPTOUTPUT/)
})

test('[eu vat] a NUMBERED invoice whose treatment refuses is parked, not queued; the cause fixed, the re-import treats and queues it', { skip }, async (t) => {
  const { after, rows, order } = await parkRefusedThenReimport(t, [{ id: 1, key: '_o3d_ioss_vat_account', value: '821' }], true)
  assert.equal(rows.length, 1, 'queued once the treatment succeeded')
  assert.equal(after.status, 'SYNCED')
  const invoice = rows[0]!.payload as unknown as Invoice
  assert.equal(invoice._taxUnreconciled, undefined, 'the queued invoice is the treated one, not a stamped refusal')
  assert.deepEqual(invoice.lines.map((l) => [l.accountCode, l.taxType, l.noTaxKind ?? null]), [['200', 'TAX131', null], ['232', 'NONE', 'fee-no-tax'], ['821', 'NONE', 'eu-vat-recovery']])
  assert.equal(total(invoice), 135.66)
  assert.equal(order.euVatRegime, 'IOSS')
})

test('[eu vat] the same numbered refusal with the cause NOT fixed stays held with the refusal reason', { skip }, async (t) => {
  const { after, rows } = await parkRefusedThenReimport(t, [], true)
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /treatment refused it: .*plugin_account_missing/)
})

// ---- the order-level discount posts on the ORDER DEFAULT rate; its mapping is part of the compared outputs ----
async function discountHold(t: test.TestContext, change: null | ((db: Awaited<ReturnType<typeof loadDb>>, defaultRateId: string) => Promise<void>)) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcLine = 900_000 + Math.floor(Math.random() * 40_000)
  const wcDefault = 940_000 + Math.floor(Math.random() * 40_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const created: string[] = []
  const warehouse = await db.warehouse.create({ data: { code: `EDS-${randomUUID().slice(0, 8)}`, name: 'Discount hold test warehouse', syncToStore: true, availableForSale: true } })
  const mk = async (name: string, rate: number, type: string, category: 'STANDARD' | 'ZERO', wc: number) => {
    const row = await db.taxRate.create({ data: { name: `${name} ${randomUUID()}`, rate, usedFor: 'SALES', accountingTaxType: type, countryCode: 'gb', taxCategory: category, active: true } })
    created.push(row.id)
    await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wc), externalName: name, externalCountry: 'GB', externalRatePct: rate * 100, taxRateId: row.id } })
    return row
  }
  // The line and the shipping are zero-rated on their own rate; the order also names a "Standard" rate (the order default, by name) that only the order-level discount posts on.
  const lineRate = await mk('GB Zero', 0, 'ZERORATEDOUTPUT', 'ZERO', wcLine)
  const defaultRate = await mk('GB Standard', 0.2, 'OUTPUT2', 'STANDARD', wcDefault)
  void lineRate
  t.after(async () => {
    switchOn = false
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
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: { in: created } } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: { in: created } } })
  })
  const order = (meta: Meta) => ({
    ...payload(externalId, wcLine, meta), billing: GB_ADDRESS, shipping: GB_ADDRESS,
    line_items: [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: 1, tax_class: '', subtotal: '100.00', subtotal_tax: '0.00', total: '100.00', total_tax: '0.00', sku: `NOSKU-${externalId}`, price: 100, taxes: [{ id: wcLine, total: '0.00', subtotal: '0.00' }], meta_data: [] }],
    fee_lines: [], shipping_lines: [{ id: 51, method_title: 'Post', method_id: 'flat_rate', total: '10.00', total_tax: '0.00', taxes: [{ id: wcLine, total: '0.00' }], meta_data: [] }], shipping_total: '10.00', shipping_tax: '0.00',
    coupon_lines: [{ id: 41, code: 'SAVE5', discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 1, key: 'coupon_data', value: JSON.stringify({ discount_type: 'fixed_cart' }) }] }],
    tax_lines: [{ id: 21, rate_code: 'GB-0', rate_id: wcLine, label: 'Zero', compound: false, tax_total: '0.00', shipping_tax_total: '0.00', meta_data: [] }, { id: 22, rate_code: 'GB-S', rate_id: wcDefault, label: 'Standard', compound: false, tax_total: '0.00', shipping_tax_total: '0.00', meta_data: [] }],
    total: '105.00', total_tax: '0.00', discount_total: '5.00', discount_tax: '0.00',
  })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  const first = await importWcOrder(order(extra) as never)
  assert.equal(first.success, true, `the parked import succeeded: ${JSON.stringify(first)}`)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = (held.payload as unknown as { accountingPayload: Invoice & { discountAmount?: number; discountTaxType?: string } }).accountingPayload
  assert.equal(parked.discountAmount, 5, 'the order carries a positive order-level discount')
  assert.equal(parked.discountTaxType, 'OUTPUT2', 'posted on the order default rate')
  const binding = (parked._euVatTreatment as { taxBinding: { discount: { rateId: string | null; source: string; type: string | null } } }).taxBinding
  assert.deepEqual([binding.discount.rateId === defaultRate.id, binding.discount.source, binding.discount.type], [true, 'mapped', 'OUTPUT2'], 'the order default rate, its source and the discount type were recorded')
  if (change) await change(db, defaultRate.id)
  await importWcOrder(order([{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra]) as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: an unchanged hold with a positive order-level discount is released', { skip }, async (t) => {
  const { rows } = await discountHold(t, null)
  assert.equal(rows.length, 1, 'released')
  assert.equal((rows[0]!.payload as unknown as { discountTaxType?: string }).discountTaxType, 'OUTPUT2')
})

test('[eu vat] a hold with a positive discount where ONLY the order default rate\'s mapping changes (the lines are untouched) is refused', { skip }, async (t) => {
  const { after, rows } = await discountHold(t, async (db, defaultRateId) => { await db.taxRate.update({ where: { id: defaultRateId }, data: { accountingTaxType: 'OUTPUT3' } }) })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(the order discount's resolved tax rate and type changed from .*OUTPUT2.* to .*OUTPUT3.*\) and needs its invoice rebuilt/)
})

// A LEGACY hold: parked with the switch OFF (no treatment marker), then the switch comes on and the order is delivered again.
async function legacyDomesticHold(t: test.TestContext, changeTotal: boolean, mutate?: (p: ReturnType<typeof domesticPayload>) => void) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  assert.equal((await importWcOrder(domesticPayload(externalId, wcRateId, extra) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload
  assert.equal('_euVatTreatment' in parked, false, 'parked with no marker')
  switchOn = true
  const again = domesticPayload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra])
  // Only the tax charged and the order total move: the net lines, the shipping and every tax type are as they were.
  if (changeTotal) { again.shipping_lines[0]!.total_tax = '3.00'; again.tax_lines[0]!.shipping_tax_total = '3.00'; again.total = '133.00'; again.total_tax = '23.00' }
  if (mutate) mutate(again)
  await importWcOrder(again as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: an unchanged LEGACY domestic hold is treated and released (its total is what the order says)', { skip }, async (t) => {
  const { after, rows } = await legacyDomesticHold(t, false)
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
  const marker = (rows[0]!.payload as unknown as Invoice)._euVatTreatment as Record<string, unknown>
  assert.deepEqual([marker.applied, marker.orderTotal], [true, '132.00'])
})

test('[eu vat] a LEGACY hold where ONLY the tax charged and the order total change (net lines and types unchanged) is refused, never stamped with the new total', { skip }, async (t) => {
  const { after, rows } = await legacyDomesticHold(t, true)
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(the parked invoice totals 132\.00 and the order total is 133\.00 now\)/)
  const parked = (after.payload as unknown as { accountingPayload: Invoice }).accountingPayload
  assert.notEqual((parked._euVatTreatment as { applied?: boolean } | undefined)?.applied, true, 'not stamped applied')
})

// A hold stamped `_taxUnreconciled`: parked while WooCommerce's shipping tax disagreed with the rate IMS holds (5.00 charged where 20% of 10.00 is 2.00), then re-delivered with a number.
async function unreconciledHold(t: test.TestContext, fixed: boolean) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  const broken = (m: Meta) => { const p = domesticPayload(externalId, wcRateId, m); p.shipping_lines[0]!.total_tax = '5.00'; p.tax_lines[0]!.shipping_tax_total = '5.00'; p.total = '135.00'; p.total_tax = '25.00'; return p }
  assert.equal((await importWcOrder(broken(extra) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = (held.payload as unknown as { accountingPayload: Invoice & Record<string, unknown> }).accountingPayload
  assert.ok(parked._taxUnreconciled !== undefined, 'the parked payload is stamped as not totalling the order')
  assert.equal(parked._euVatTreatment, undefined, 'a stamped payload is not treated at the create path')
  const num: Meta = [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra]
  await importWcOrder((fixed ? domesticPayload(externalId, wcRateId, num) : broken(num)) as never)
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] a hold stamped _taxUnreconciled whose cause is now FIXED is treated and released without the stamp', { skip }, async (t) => {
  const { after, rows } = await unreconciledHold(t, true)
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
  const sent = rows[0]!.payload as unknown as Record<string, unknown>
  assert.equal(sent._taxUnreconciled, undefined, 'no stamp is released')
  assert.deepEqual([sent._registerPayment, sent._paymentAmount], [true, 132], 'the payment legs are rebuilt for a document that totals the order')
  assert.deepEqual([(sent._euVatTreatment as { applied?: boolean }).applied, (sent._euVatTreatment as { orderTotal?: string }).orderTotal], [true, '132.00'])
})

test('[eu vat] a hold stamped _taxUnreconciled whose cause is STILL broken stays PENDING with the reason and queues nothing', { skip }, async (t) => {
  const { after, rows } = await unreconciledHold(t, false)
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /does not (still )?total the order|still does not total the order/)
  assert.notEqual(after.status, 'SYNCED')
})

// THE FRESH-BUILD COMPARISON: facts nobody listed. Prices, rate ids, tax types and the order total all stay as parked; only WooCommerce's per-line tax split moves.
test('[eu vat] a treated hold where the per-line tax split shifts (a marked fee loses its tax to the goods line, total unchanged) is refused', { skip }, async (t) => {
  const { after, rows } = await parkThenChange(t, true, PLUGIN('821'), (p) => {
    p.fee_lines[0]!.total_tax = '0.00'; p.fee_lines[0]!.taxes = [{ id: p.fee_lines[0]!.taxes[0]!.id, total: '0.00' }]
    p.line_items[0]!.total_tax = '19.76'; p.line_items[0]!.taxes = [{ id: p.line_items[0]!.taxes[0]!.id, total: '19.76', subtotal: '19.76' }]
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(.+\) and needs its invoice rebuilt|refuses it now|does not total the order/)
  assert.notEqual(after.status, 'SYNCED')
})

async function domesticHoldMutated(t: test.TestContext, mutate: ((p: ReturnType<typeof domesticPayload>) => void) | null, between?: (db: Awaited<ReturnType<typeof loadDb>>, orderId: string) => Promise<void>) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seedDomestic(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  const extra: Meta = [{ id: 2, key: 'is_vat_exempt', value: 'no' }]
  assert.equal((await importWcOrder(domesticPayload(externalId, wcRateId, extra) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const again = domesticPayload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...extra])
  if (mutate) mutate(again)
  if (between) await between(db, orderId)
  await importWcOrder(again as never)
  return { all: await db.accountingSyncLog.findMany({ where: { referenceId: orderId } }), after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: the same domestic hold, unchanged, is released (the fresh build equals the parked payload)', { skip }, async (t) => {
  const { after, rows } = await domesticHoldMutated(t, null)
  assert.equal(rows.length, 1)
  assert.equal(after.status, 'SYNCED')
})

test('[eu vat] a domestic treated hold where WooCommerce moves tax from the shipping to the goods line (prices, rate ids and the total unchanged) is refused', { skip }, async (t) => {
  const { after, rows } = await domesticHoldMutated(t, (p) => {
    p.shipping_lines[0]!.total_tax = '0.00'; p.shipping_lines[0]!.taxes = [{ id: p.shipping_lines[0]!.taxes[0]!.id, total: '0.00' }]; p.tax_lines[0]!.shipping_tax_total = '0.00'
    p.line_items[0]!.total_tax = '22.00'; p.line_items[0]!.taxes = [{ id: p.line_items[0]!.taxes[0]!.id, total: '22.00', subtotal: '22.00' }]; p.tax_lines[0]!.tax_total = '22.00'
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(.+\) and needs its invoice rebuilt|does not total the order/)
})

// WHAT XERO ALSO READS: the payment method picks the payment account, the settlement rate drives the payment follow-up.
test('[eu vat] a PAID held order whose payment method changes before numbering is refused', { skip }, async (t) => {
  const { after, rows } = await domesticHoldMutated(t, (p) => { p.payment_method = 'stripe' })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the order changed after it was held \(the parked invoice differs from the invoice the order produces now at _paymentMethod\)/)
})

test('[eu vat] a PAID held order whose receipt\'s settlement rate changes before numbering is refused', { skip }, async (t) => {
  const { after, rows } = await domesticHoldMutated(t, null, async (db, orderId) => { await db.payment.updateMany({ where: { orderId }, data: { settlementRateToBase: 1.2 } }) })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /at _paymentSettlementRateToBase\)/)
})

// STORE CREDIT ADDED AFTER PARKING: neither the invoice nor the payment may be queued.
test('[eu vat] store credit added to the order after a treated hold was parked: the hold is order_changed, nothing is queued', { skip }, async (t) => {
  const { after, rows, all } = await domesticHoldMutated(t, (p) => {
    p.coupon_lines = [{ id: 41, code: 'sc', discount: '5.00', discount_tax: '0.00', meta_data: [{ id: 9, key: 'coupon_info', value: '[1,"sc","smart_coupon","50"]' }] }] as never
    p.total = '127.00'; p.discount_total = '5.00' as never
  })
  assert.equal(rows.length + all.length, 0, 'no invoice and no payment follow-up was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /store credit/)
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

// RACE (compare-and-swap): the untreated hold was verified, then a concurrent import marked it order_changed, then this import's replacement transaction ran.
test('[eu vat] an UNTREATED hold marked order_changed by a concurrent import between the verification and the replacement is not replaced and nothing is queued', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; betweenHook.armed = false; betweenHook.verified = false; betweenHook.run = null; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  assert.equal('_euVatTreatment' in (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload, false, 'parked untreated (switch off)')
  switchOn = true
  betweenHook.verified = false
  betweenHook.armed = true
  betweenHook.run = async () => {
    const current = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
    const p = current.payload as unknown as { accountingPayload: Record<string, unknown> }
    await db.shoppingSyncLog.update({ where: { id: held.id }, data: { payload: { ...p, accountingPayload: { ...p.accountingPayload, _euVatTreatment: { applied: false, reason: 'order_changed' } } } as never, errorMessage: 'concurrent import: the order changed' } })
  }
  await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...PLUGIN('821')]) as never)
  assert.equal(betweenHook.run, null, 'the concurrent write really happened between the verification and the replacement')
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'nothing was enqueued')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' }, 'the order_changed marker was not overwritten')
})

// MUTATION-PASS SURVIVORS KILLED.
test('[eu vat] a LEGACY (untreated) hold where only the payment method changes (nothing the per-fact checks list) is refused by the fresh build', { skip }, async (t) => {
  const { after, rows } = await legacyDomesticHold(t, false, (p) => { p.payment_method = 'stripe' })
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /at _paymentMethod/)
})

test('[eu vat] a hold already marked order_changed stays order_changed and is not released even when the order is back to what was parked', { skip }, async (t) => {
  const { after, rows } = await domesticHoldMutated(t, null, async (db, orderId) => {
    const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
    const row = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
    const p = row.payload as unknown as { accountingPayload: Record<string, unknown> }
    await db.shoppingSyncLog.update({ where: { id: row.id }, data: { payload: { ...p, accountingPayload: { ...p.accountingPayload, _euVatTreatment: { applied: false, reason: 'order_changed' } } } as never, errorMessage: 'the order changed after it was held' } })
  })
  assert.equal(rows.length, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.deepEqual(((after.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment), { applied: false, reason: 'order_changed' })
})

test('[eu vat] RACE: a concurrent rewrite of the untreated hold that does NOT mark it (here its payment method) is not overwritten by the replacement and nothing is queued', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = false
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; betweenHook.armed = false; betweenHook.verified = false; betweenHook.run = null; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  switchOn = true
  betweenHook.verified = false
  betweenHook.armed = true
  betweenHook.run = async () => {
    const current = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
    const p = current.payload as unknown as { accountingPayload: Record<string, unknown> }
    await db.shoppingSyncLog.update({ where: { id: held.id }, data: { payload: { ...p, accountingPayload: { ...p.accountingPayload, _paymentMethod: 'stripe' } } as never } })
  }
  await importWcOrder(payload(externalId, wcRateId, [{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...PLUGIN('821')]) as never)
  assert.equal(betweenHook.run, null, 'the concurrent write happened between the verification and the replacement')
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'nothing was enqueued')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.equal((after.payload as unknown as { accountingPayload: Record<string, unknown> }).accountingPayload._paymentMethod, 'stripe', 'the concurrent version was not replaced')
})

test('[eu vat] the SWEEP never releases a treated hold that carries the not-totalling stamp', { skip }, async (t) => {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const p = held.payload as unknown as { accountingPayload: Record<string, unknown> }
  assert.equal((p.accountingPayload._euVatTreatment as { applied: boolean }).applied, true)
  await db.shoppingSyncLog.update({ where: { id: held.id }, data: { payload: { ...p, accountingPayload: { ...p.accountingPayload, _taxUnreconciled: { reason: 'a stamped hold' } } } as never } })
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'nothing was queued')
  const after = await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } })
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /does not total the order/)
})

// THE TREATMENT AND THE IMPORT'S HELD-INVOICE CHECK DECIDE THE REGIME FROM THE SAME SETTINGS-DERIVED INPUT, the gift-card flag cut-in included.
const GIFT_CARD_CUT_IN = 'eu_vat_gift_card_flag_cut_in'
async function giftCardHold(t: test.TestContext, cutIn: { atPark: string | null; atRelease: string | null }) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  const setCutIn = async (value: string | null) => {
    if (value === null) await db.setting.deleteMany({ where: { key: GIFT_CARD_CUT_IN } })
    else await db.setting.upsert({ where: { key: GIFT_CARD_CUT_IN }, create: { key: GIFT_CARD_CUT_IN, value }, update: { value } })
  }
  t.after(async () => { switchOn = false; await setCutIn(null); await cleanup(db, externalId, ctx) })
  // The order carries a gift-card line with NO flag (the plugin did not write one): lenient before the cut-in, a refusal from it on. It was created 2026-11-02.
  const unflagged = (m: Meta) => { const p = payload(externalId, wcRateId, m); p.line_items[0]!.meta_data = []; return p }
  await setCutIn(cutIn.atPark)
  const first = await importWcOrder(unflagged(PLUGIN('821')) as never)
  assert.equal(first.success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parkedMarker = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as Record<string, unknown>
  const stampedAtPark = (await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { euVatRegime: true } })).euVatRegime
  await setCutIn(cutIn.atRelease)
  await importWcOrder(unflagged([{ id: 4, key: '_wcpdf_invoice_number', value: `INV-${externalId}` }, ...PLUGIN('821')]) as never)
  return {
    parkedMarker, stampedAtPark,
    after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }),
    rows: await db.accountingSyncLog.findMany({ where: { type: 'SALES_INVOICE', referenceId: orderId } }),
  }
}

test('[eu vat] gift-card line with no flag, cut-in AFTER the order (lenient): the treatment stamps IOSS and the held-invoice check agrees, so the hold is released', { skip }, async (t) => {
  const { parkedMarker, stampedAtPark, rows, after } = await giftCardHold(t, { atPark: '2026-12-01', atRelease: '2026-12-01' })
  assert.equal(parkedMarker.applied, true)
  assert.equal(stampedAtPark, 'IOSS')
  assert.equal(rows.length, 1, 'released')
  assert.equal(after.status, 'SYNCED')
})

test('[eu vat] gift-card line with no flag, cut-in BEFORE the order (required): the treatment refuses it by the flag, stamps nothing, and the re-import refuses it for the same reason', { skip }, async (t) => {
  const { parkedMarker, stampedAtPark, rows, after } = await giftCardHold(t, { atPark: '2026-11-01', atRelease: '2026-11-01' })
  assert.deepEqual([parkedMarker.applied, parkedMarker.reason], [false, 'treatment_refused'])
  assert.match(String(parkedMarker.refusal), /gift-card flag/)
  assert.equal(stampedAtPark, null, 'nothing was stamped')
  assert.equal(rows.length, 0)
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /gift-card flag/)
})

test('[eu vat] the cut-in passes between parking and release: the treated hold is refused by the held-invoice check with the same gift-card reason', { skip }, async (t) => {
  const { parkedMarker, stampedAtPark, rows, after } = await giftCardHold(t, { atPark: '2026-12-01', atRelease: '2026-11-01' })
  assert.equal(parkedMarker.applied, true)
  assert.equal(stampedAtPark, 'IOSS')
  assert.equal(rows.length, 0, 'nothing queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /gift-card flag/)
})

// THE SWEEP FAILS CLOSED when the regime settings changed since a treated hold was parked (it has no order to re-verify with).
async function sweepAfterSettingChange(t: test.TestContext, change: ((setCutIn: (v: string | null) => Promise<void>) => Promise<void>) | null) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  const setCutIn = async (value: string | null) => {
    if (value === null) await db.setting.deleteMany({ where: { key: 'eu_vat_gift_card_flag_cut_in' } })
    else await db.setting.upsert({ where: { key: 'eu_vat_gift_card_flag_cut_in' }, create: { key: 'eu_vat_gift_card_flag_cut_in', value }, update: { value } })
  }
  t.after(async () => { switchOn = false; await setCutIn(null); await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, PLUGIN('821')) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const marker = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as Record<string, unknown>
  assert.equal(marker.applied, true)
  assert.deepEqual(marker.regimePolicy, { mode: 'adopt_plugin', cutIn: 'unset', ioss: '821', ddp: '232' }, 'the policy the hold was decided under is recorded')
  if (change) await change(setCutIn)
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  await retryHeldWcSalesInvoiceReleases()
  return { after: await db.shoppingSyncLog.findUniqueOrThrow({ where: { id: held.id } }), rows: await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }) }
}

test('[eu vat] CONTROL: the sweep releases a treated hold when the regime settings are unchanged', { skip }, async (t) => {
  const { after, rows } = await sweepAfterSettingChange(t, null)
  assert.equal(rows, 1)
  assert.equal(after.status, 'SYNCED')
})

test('[eu vat] the gift-card cut-in changes between parking and the SWEEP: nothing is queued and the hold stays PENDING with the reason', { skip }, async (t) => {
  const { after, rows } = await sweepAfterSettingChange(t, async (setCutIn) => { await setCutIn('2026-12-01') })
  assert.equal(rows, 0, 'nothing was queued')
  assert.equal(after.status, 'PENDING')
  assert.match(after.errorMessage ?? '', /the EU VAT regime settings changed since it was parked \(cutIn\).*NOTHING was queued.*Re-import the order/)
})
