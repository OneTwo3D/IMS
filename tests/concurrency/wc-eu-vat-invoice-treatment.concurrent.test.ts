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
  assert.deepEqual(invoice._euVatTreatment, { applied: true, route: 'scheme', regime: 'IOSS', schemePostingTaxType: 'TAX131', orderTotal: '135.66', vatAccount: '821', feesRecoded: 1, roundingAdjustment: null })
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
    connector: 'xero', accounts: { ioss: '821', ddp: '232', fee: '232', rounding: '860' }, storeCreditForeign: { gt: () => false }, now: new Date() }
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
    const { invoice, order } = await run(t, PLUGIN('821'), true, scenario.list)
    assert.ok(invoice)
    assert.match(invoice._taxUnreconciled?.reason ?? '', scenario.expect)
    assert.equal(invoice._registerPayment, false)
    assert.equal(invoice.lines.some((l) => l.noTaxKind === 'eu-vat-recovery'), false)
    void order
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
async function domesticHold(t: test.TestContext, changeTotal: boolean) {
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
  const marker = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload._euVatTreatment as Record<string, unknown>
  assert.deepEqual([marker.applied, marker.route, marker.orderTotal], [true, 'none', '132.00'])
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
async function parkRefusedThenReimport(t: test.TestContext, fixedMeta: Meta) {
  const db = await loadDb()
  await mockAccounting()
  switchOn = true
  const { importWcOrder, retryHeldWcSalesInvoiceReleases } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const { heldSalesInvoiceQueueWhere } = await import('@/lib/connectors/woocommerce/sync/held-sales-invoice')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = Math.floor(Math.random() * 2_000_000_000)
  const ctx = await seed(db, wcRateId)
  t.after(async () => { switchOn = false; await cleanup(db, externalId, ctx) })
  assert.equal((await importWcOrder(payload(externalId, wcRateId, [{ id: 2, key: 'is_vat_exempt', value: 'no' }]) as never)).success, true)
  const orderId = (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
  const held = await db.shoppingSyncLog.findFirstOrThrow({ where: heldSalesInvoiceQueueWhere({ salesOrderId: orderId }) })
  const parked = (held.payload as unknown as { accountingPayload: Invoice }).accountingPayload
  // Parked as an UNTREATED hold carrying the refusal's reason, never applied:true; the original payload (no stamp).
  assert.deepEqual([parked._euVatTreatment?.applied, parked._euVatTreatment?.reason], [false, 'treatment_refused'])
  assert.match(String(parked._euVatTreatment?.refusal), /plugin_account_missing/)
  assert.equal(parked._taxUnreconciled, undefined)
  // The numbered order is delivered again, switch on. (The sweep first: it must never release an applied:false hold.)
  await db.salesOrder.update({ where: { id: orderId }, data: { invoiceNumber: `INV-${externalId}` } })
  await retryHeldWcSalesInvoiceReleases()
  assert.equal(await db.accountingSyncLog.count({ where: { type: 'SALES_INVOICE', referenceId: orderId } }), 0, 'the sweep did not release the refused hold')
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
