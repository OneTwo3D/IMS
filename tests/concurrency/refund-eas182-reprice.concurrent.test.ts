import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * A REAL EAS RE-PRICE THROUGH THE WooCommerce REFUND PATH (syncWcRefund -> createRefund -> createSalesOrderRefund), against a real PostgreSQL (scratch database). EAS books a refund's tax under its own rate 182, at a rate that is NOT the order line's own (here a 19% shipping charge re-priced to 20%),
 * so the writer's per-line posted-VAT fence (the line's VAT at its ORIGINAL rate, within a minor unit) would refuse it before any refund or held row existed. For a rate-182 refund on a scheme-stamped order (switch on, internal caller) that fence is replaced by the source-stated tax and the aggregate order bound.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() { depsPromise ??= loadDepsOnce(); return depsPromise }
async function loadDepsOnce() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  mock.module('../../lib/domain/sales/post-refund-release.ts', { namedExports: { releaseReservationsAfterRefund: async () => undefined } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }) } })
  mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
  const realAuth = await import('../../lib/auth/server.ts')
  mock.module('../../lib/auth/server.ts', { namedExports: { ...realAuth, requirePermission: async () => ({ user: { id: 'ioss-cn-test' } }), requireFreshPermission: async () => ({ user: { id: 'ioss-cn-test' } }), freshAuthFailureResult: () => null } })
  const [{ db }, actions, bypass, { getBaseCurrencyCode }] = await Promise.all([
    import('../../lib/db/index.ts'), import('../../app/actions/sales.ts'), import('../../lib/internal-action-bypass.ts'), import('../../lib/base-currency.ts'),
  ])
  return { db, createRefund: actions.createRefund, bypass: bypass.INTERNAL_ACTION_BYPASS, baseCurrency: await getBaseCurrencyCode() }
}
type Deps = Awaited<ReturnType<typeof loadDepsOnce>>
type Db = Deps['db']

/** Xero active, sync on, credit notes posting, every account configured; the Sales Invoices switch as asked. Returns what to put back. */
async function configure(db: Db, switchOn: boolean, extra: Record<string, string> = {}): Promise<() => Promise<void>> {
  const entries: Array<[string, string]> = Object.entries({
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero]: 'true', xero_sync_enabled: 'true', xero_sync_credit_note: 'draft', xero_sync_sales_invoice: switchOn ? 'draft' : 'off',
    xero_sales_account: '200', xero_shipping_account: '260', xero_discount_account: '270', xero_eu_vat_ioss_account: '821', xero_eu_vat_ddp_account: '232', xero_eu_fee_account: '232', xero_rounding_difference_account: '860',
    ...extra,
  })
  const before = new Map((await db.setting.findMany({ where: { key: { in: entries.map(([k]) => k) } } })).map((row) => [row.key, row.value]))
  for (const [key, value] of entries) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return async () => {
    for (const [key] of entries) {
      const previous = before.get(key)
      if (previous === undefined) await db.setting.deleteMany({ where: { key } })
      else await db.setting.update({ where: { key }, data: { value: previous } })
    }
  }
}

/** The stored Xero tax-rate list the treatment proves the scheme posting type against. */
async function seedXeroList(db: Db, rates: Record<string, string>) {
  const { replaceXeroTaxRateList } = await import('../../lib/connectors/xero/tax-rate-store.ts')
  const { TAX_RATE_DRIFT_LAST_CHECKED_SETTING } = await import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts')
  const now = new Date()
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'test', expiresAt: new Date(now.getTime() + 3_600_000), tenantId: 'tenant-eu-vat-cn-test' } })
  await db.$transaction(async (tx) => {
    await replaceXeroTaxRateList(tx, {
      tenantId: 'tenant-eu-vat-cn-test',
      fetchedAt: now,
      rows: Object.entries(rates).map(([taxType, effectiveRate]) => ({ taxType, name: taxType, status: 'ACTIVE' as const, reportTaxType: null, effectiveRate, displayTaxRate: effectiveRate, components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } })),
    })
    await tx.setting.upsert({ where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, create: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: now.toISOString() }, update: { value: now.toISOString() } })
  })
}

type Fixture = Awaited<ReturnType<typeof seed>>

/**
 * One order: goods 100.00 (tax 19.00), TWO landed-cost fees 20.00 (tax 3.80) and 4.00 (tax 0.76), shipping 10.00 (tax 1.90), all at 19%; total 158.46 + ... (net 134, tax 25.46, total 159.46 is not needed: only the refunds' own figures matter).
 * `stamp`: null (never decided), 'IOSS' (stamped on 821) or 'none' (decided, outside the scheme).
 */
async function seed(deps: Deps, opts: { stamp: 'IOSS' | 'none' | null; schemeRate: boolean; noType?: boolean }) {
  const { db } = deps
  const { Prisma } = await import('../../app/generated/prisma/client.ts')
  const suffix = randomUUID().slice(0, 8)
  const rate = await db.taxRate.create({
    data: {
      name: `DE CN VAT ${suffix}`, rate: new Prisma.Decimal('0.19'), usedFor: 'SALES', accountingTaxType: `DE_CHARGED_${suffix}`, countryCode: 'DE', taxCategory: 'STANDARD', active: true,
      ...(opts.schemeRate ? { reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' } : {}),
    },
  })
  const line = (description: string, net: string, tax: string, fee: string | null) => ({
    description, qty: new Prisma.Decimal('1'), unitPriceForeign: new Prisma.Decimal(net), unitPriceBase: new Prisma.Decimal(net), taxForeign: new Prisma.Decimal(tax), taxBase: new Prisma.Decimal(tax),
    totalForeign: new Prisma.Decimal(net), totalBase: new Prisma.Decimal(net), taxRateId: rate.id, ...(fee === null ? {} : { wclcFeeKind: fee }),
  })
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `CN-${suffix}`, status: 'SHIPPED', currency: deps.baseCurrency, fxRateToBase: new Prisma.Decimal('1'), pricesIncludeVat: false, taxRateName: rate.name, taxRatePercent: new Prisma.Decimal('0.19'),
      subtotalForeign: new Prisma.Decimal('134'), subtotalBase: new Prisma.Decimal('134'), taxForeign: new Prisma.Decimal('25.46'), taxBase: new Prisma.Decimal('25.46'), totalForeign: new Prisma.Decimal('159.46'), totalBase: new Prisma.Decimal('159.46'),
      shippingForeign: new Prisma.Decimal('10'), shippingBase: new Prisma.Decimal('10'),
      ...(opts.stamp === null ? {} : opts.stamp === 'none'
        ? { euVatRegimeStampedAt: new Date(), euVatRegimeBasis: { version: 1, outcome: 'SKIP', skipReason: 'no_scheme_vat', warnings: [] } }
        : { euVatRegime: 'IOSS' as const, euVatLineAccount: '821', euVatRegimeStampedAt: new Date(), euVatRegimeBasis: { version: 1, outcome: 'SCHEME', scheme: { imsRateIds: [rate.id], ...(opts.noType ? {} : { schemePostingTaxType: 'TAX131' }) }, warnings: [] } }),
      lines: { create: [line('Widget', '100.00', '19.00', null), line('EU Customs Fee', '20.00', '3.80', 'duty_flat'), line('EU Handling Fee', '4.00', '0.76', 'uhf')] },
    },
    select: { id: true, lines: { select: { id: true, description: true } } },
  })
  const lineId = (description: string) => order.lines.find((l) => l.description === description)!.id
  return { rate, orderId: order.id, goods: lineId('Widget'), feeA: lineId('EU Customs Fee'), feeB: lineId('EU Handling Fee') }
}

async function cleanup(db: Db, fx: Fixture | undefined) {
  if (!fx) return
  const refunds = await db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })
  const ids = refunds.map((r) => r.id)
  await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [...ids, fx.orderId] } } }).catch(() => {})
  await db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: ids } } }).catch(() => {})
  await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: fx.orderId } } }).catch(() => {})
  await db.salesOrderRefund.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.shoppingSyncLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.shoppingOrderLink.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.activityLog.deleteMany({ where: { entityId: fx.orderId } }).catch(() => {})
  await db.salesOrderLine.deleteMany({ where: { orderId: fx.orderId } }).catch(() => {})
  await db.salesOrder.deleteMany({ where: { id: fx.orderId } }).catch(() => {})
  await db.taxRate.deleteMany({ where: { id: fx.rate.id } }).catch(() => {})
  await db.xeroTaxRateList.deleteMany({ where: { connector: 'xero' } }).catch(() => {})
  await db.xeroTaxRate.deleteMany({ where: { connector: 'xero' } }).catch(() => {})
  await db.accountingToken.deleteMany({ where: { connector: 'xero', tenantId: 'tenant-eu-vat-cn-test' } }).catch(() => {})
}


const COUNT = 'eu_vat_refund182_held_count'
const THRESHOLD = 'eu_vat_refund182_hold_threshold'
const wooRefundId = () => 3_000_000 + Math.floor(Math.random() * 6_000_000)
const REFUSED = '_euVatCreditNoteRefused'

/** A WooCommerce refund of the order's shipping charge: `net` of shipping and `tax` of VAT, the tax booked on rate `rateId` (182 = EAS). */
const wcShippingRefund = (id: number, parent: number, net: string, tax: string, rateId = 182, taxTotal = tax) => ({
  id, parent_id: parent, date_created: '2026-11-02T10:00:00', date_created_gmt: '2026-11-02T10:00:00', amount: (Number(net) + Number(tax)).toFixed(2), reason: 'r', refunded_by: 1, refunded_payment: false, meta_data: [],
  line_items: [],
  shipping_lines: [{ id: 5, method_title: 'Shipping', method_id: 'flat_rate', total: `-${net}`, total_tax: `-${tax}`, taxes: [{ id: rateId, total: `-${taxTotal}` }] }],
})

async function wcOrder(deps: Deps, stamp: 'IOSS' | 'none') {
  const fx = await seed(deps, { stamp, schemeRate: stamp === 'IOSS' })
  const externalOrderId = 7_000_000 + Math.floor(Math.random() * 1_000_000)
  await deps.db.shoppingOrderLink.create({ data: { orderId: fx.orderId, connector: 'woocommerce', externalOrderId: String(externalOrderId) } })
  return { fx, externalOrderId }
}
const refundsOf = (deps: Deps, orderId: string) => deps.db.salesOrderRefund.findMany({ where: { orderId }, select: { id: true, eas182HeldAt: true, eas182StatedTaxForeign: true, statedGrossForeign: true } })

test('[refund 182 re-price] a 19% shipping charge re-priced by EAS to 20% VAT is RECORDED through the WooCommerce path and held (the first of the first N); the per-line fence is not applied', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const { fx, externalOrderId } = await wcOrder(deps, 'IOSS')
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const id = wooRefundId()
  const outcome = await syncWcRefund(externalOrderId, wcShippingRefund(id, externalOrderId, '10.00', '2.00') as never)
  assert.notEqual(outcome.outcome, 'quarantined-refusal', outcome.error)
  const refunds = await refundsOf(deps, fx.orderId)
  assert.equal(refunds.length, 1, 'the refund is recorded')
  assert.equal(refunds[0]!.eas182StatedTaxForeign?.toString(), '2')
  assert.equal(refunds[0]!.statedGrossForeign?.toString(), '12')
  assert.ok(refunds[0]!.eas182HeldAt, 'held')
  assert.equal((await deps.db.setting.findUnique({ where: { key: COUNT } }))?.value, '1')
  const row = await deps.db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: refunds[0]!.id }, select: { payload: true } })
  assert.ok((row?.payload as Record<string, unknown> | null)?.[REFUSED], 'the held row is the refused, never-sent credit note')
})

test('[refund 182 re-price] the SAME re-priced refund on a non-scheme order, or with the Sales Invoices switch off, still meets the old per-line fence (nothing recorded); an over-bound re-price and a stated-tax mismatch refuse', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const scheme = await wcOrder(deps, 'IOSS')
  const outside = await wcOrder(deps, 'none')
  const off = await wcOrder(deps, 'IOSS')
  const over = await wcOrder(deps, 'IOSS')
  const mismatch = await wcOrder(deps, 'IOSS')
  t.after(async () => { await restore(); for (const o of [scheme, outside, off, over, mismatch]) await cleanup(deps.db, o.fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  // Non-scheme order: the old fence refuses the re-price (2.00 against 1.90 at the order's own 19%).
  const a = await syncWcRefund(outside.externalOrderId, wcShippingRefund(wooRefundId(), outside.externalOrderId, '10.00', '2.00') as never)
  assert.equal((await refundsOf(deps, outside.fx.orderId)).length, 0, 'not recorded: ' + (a.error ?? ''))
  assert.match(a.error ?? '', /posted|credit note|VAT|tax/i)
  // Switch OFF on a scheme-stamped order: the same.
  const restoreOff = await configure(deps.db, false, { [COUNT]: '0', [THRESHOLD]: '10' })
  const b = await syncWcRefund(off.externalOrderId, wcShippingRefund(wooRefundId(), off.externalOrderId, '10.00', '2.00') as never)
  assert.equal((await refundsOf(deps, off.fx.orderId)).length, 0, 'not recorded with the switch off: ' + (b.error ?? ''))
  await restoreOff()
  // Over the order's VAT: 30.00 of VAT on a 10.00 shipping refund (the order collected 25.46 in all).
  const c = await syncWcRefund(over.externalOrderId, wcShippingRefund(wooRefundId(), over.externalOrderId, '10.00', '30.00') as never)
  assert.equal((await refundsOf(deps, over.fx.orderId)).length, 0, 'over-bound re-price refused: ' + (c.error ?? ''))
  assert.match(c.error ?? '', /more than the order's collected VAT/)
  // The tax the lines state and the tax the refund states in all disagree.
  const d = await syncWcRefund(mismatch.externalOrderId, wcShippingRefund(wooRefundId(), mismatch.externalOrderId, '10.00', '2.00', 182, '5.00') as never)
  assert.equal((await refundsOf(deps, mismatch.fx.orderId)).length, 0, 'mismatch refused: ' + (d.error ?? ''))
  assert.equal((await deps.db.setting.findUnique({ where: { key: COUNT } }))?.value, '0', 'nothing counted')
})

test('[refund 182 re-price] a PUBLIC caller cannot state the rate-182 tax: createRefund without the internal token records none and keeps the per-line fence', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // A re-priced line (20% VAT on a 19% line) from a public caller: the per-line fence refuses it; the 182 figure it tried to pass is ignored.
  const result = await deps.createRefund(fx.orderId, [{ lineId: fx.goods, productId: null, description: 'Widget', qty: 0, totalBase: 100, lineKind: 'sale', chargedTaxForeign: 20 }], 'public', undefined, { eas182StatedTaxForeign: 20, statedGrossForeign: 120 } as never)
  assert.equal(result.success, false, 'refused by the old fence')
  assert.equal((await refundsOf(deps, fx.orderId)).length, 0)
  // The internal caller with the same figures is accepted (the rate-182 replacement).
  const internal = await deps.createRefund(fx.orderId, [{ lineId: fx.goods, productId: null, description: 'Widget', qty: 0, totalBase: 100, lineKind: 'sale', chargedTaxForeign: 20 }], 'internal', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), eas182StatedTaxForeign: 20, statedGrossForeign: 120 })
  assert.equal(internal.success, true, internal.error)
})

test('[refund 182 re-price] a MONETARY-ONLY refund (zero returned quantity) on a 19% order re-priced by EAS to 20% VAT is recorded and held: the net is the stated gross less the stated 182 tax, not the gross divided by the order\'s own rate', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const { fx, externalOrderId } = await wcOrder(deps, 'IOSS')
  const over = await wcOrder(deps, 'IOSS')
  t.after(async () => { await restore(); await cleanup(deps.db, fx); await cleanup(deps.db, over.fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const monetary = (id: number, parent: number, net: string, tax: string) => ({
    id, parent_id: parent, date_created: '2026-11-02T10:00:00', date_created_gmt: '2026-11-02T10:00:00', amount: (Number(net) + Number(tax)).toFixed(2), reason: 'r', refunded_by: 1, refunded_payment: false, meta_data: [],
    line_items: [{ id: 91, name: 'Widget', product_id: 1, variation_id: 0, quantity: 0, tax_class: '', subtotal: `-${net}`, subtotal_tax: `-${tax}`, total: `-${net}`, total_tax: `-${tax}`, sku: 's', meta_data: [], refund_total: -Number(net), taxes: [{ id: 182, total: `-${tax}` }] }],
  })
  const outcome = await syncWcRefund(externalOrderId, monetary(wooRefundId(), externalOrderId, '100.00', '20.00') as never)
  assert.notEqual(outcome.outcome, 'quarantined-refusal', outcome.error)
  const refunds = await refundsOf(deps, fx.orderId)
  assert.equal(refunds.length, 1, 'the refund is recorded: ' + (outcome.error ?? ''))
  assert.equal(refunds[0]!.statedGrossForeign?.toString(), '120')
  assert.equal(refunds[0]!.eas182StatedTaxForeign?.toString(), '20')
  assert.ok(refunds[0]!.eas182HeldAt, 'held')
  const lines = await deps.db.salesOrderRefundLine.findMany({ where: { refundId: refunds[0]!.id }, select: { totalForeign: true } })
  assert.equal(lines.reduce((sum, l) => sum + Number(l.totalForeign), 0), 100, 'the net is 120 - 20, not 120 / 1.19')
  // Over the order's VAT (30.00 of VAT): refused by the writer's aggregate bound, nothing recorded.
  const refused = await syncWcRefund(over.externalOrderId, monetary(wooRefundId(), over.externalOrderId, '10.00', '30.00') as never)
  assert.equal((await refundsOf(deps, over.fx.orderId)).length, 0, 'over-bound: ' + (refused.error ?? ''))
})
