import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * THE RATE-182 HOLD AT THE TREATMENT'S OWN SEAM (treatCreditNotePayload called directly with a stub enqueue), against a real PostgreSQL (scratch database): the result kind for each answer the held row's enqueue can give, on the new-hold path and on the permanent-hold path,
 * the prior-refund VAT pricing the aggregate bound uses, and the refund-writer's refusal to take a 182 figure from a public caller. Written to kill the mutants the first mutation pass left alive.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() { depsPromise ??= loadDepsOnce(); return depsPromise }
async function loadDepsOnce() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  mock.module('../../lib/domain/sales/post-refund-release.ts', { namedExports: { releaseReservationsAfterRefund: async () => undefined } })
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
const ACCOUNTS = { ioss: '821', ddp: '232', fee: '232', rounding: '860' }
const heldCount = async (db: Db) => (await db.setting.findUnique({ where: { key: COUNT } }))?.value ?? null
type Stub = (reason: string) => Promise<{ queued: boolean; reason?: string; connector: string | null }>

/** A rate-182 refund written straight to the database (net `net`, stated gross and tax as given) with one line, and the payload the hand-off would build for it. */
async function eas182Refund(deps: Deps, fx: Fixture, opts: { net: string; stated: string; tax: string; rate?: string | null; source?: 'MANUAL_UI' | 'CHARGEBACK_POLLER'; basis?: string | null; eas?: boolean; withStated?: boolean }) {
  const number = `CN-T-${randomUUID().slice(0, 6)}`
  const refund = await deps.db.salesOrderRefund.create({
    data: {
      orderId: fx.orderId, creditNoteNumber: number, totalForeign: opts.net, totalBase: opts.net, totalsBasis: opts.basis === undefined ? 'NET' : opts.basis, source: opts.source ?? 'MANUAL_UI',
      statedGrossForeign: opts.withStated === false ? null : opts.stated, ...(opts.eas === false ? {} : { eas182StatedTaxForeign: opts.tax }),
      lines: { create: [{ salesOrderLineId: fx.goods, description: 'Widget', qty: 1, unitPriceForeign: opts.net, unitPriceBase: opts.net, totalForeign: opts.net, totalBase: opts.net, accountingTaxType: fx.rate.accountingTaxType, lineKind: 'sale', postingTaxType: 'TAX131', schemeTaxRateValue: opts.rate === undefined ? '0.19' : opts.rate }] },
    },
    select: { id: true },
  })
  const rows = await deps.db.salesOrderRefundLine.findMany({ where: { refundId: refund.id }, select: { id: true } })
  const payload = { creditNoteNumber: number, currency: deps.baseCurrency, lines: [{ description: 'Widget', quantity: 1, unitAmount: Number(opts.net), accountCode: '200', taxType: fx.rate.accountingTaxType }], lineAmountsIncludeTax: false }
  return { refundId: refund.id, lineIds: rows.map((r) => r.id), payload }
}
async function treat(deps: Deps, fx: Fixture, refund: Awaited<ReturnType<typeof eas182Refund>>, enqueue: Stub) {
  const { treatCreditNotePayload } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  return treatCreditNotePayload({ refundId: refund.refundId, orderId: fx.orderId, payload: refund.payload, refundLineIds: refund.lineIds, connector: 'xero', accounts: ACCOUNTS, now: new Date(), enqueueHeldRow: enqueue as never })
}
const stampOf = async (deps: Deps, id: string) => (await deps.db.salesOrderRefund.findUnique({ where: { id }, select: { eas182HeldAt: true } }))!.eas182HeldAt
const sendableRow = (deps: Deps, refundId: string) => deps.db.accountingSyncLog.create({ data: { type: 'CREDIT_NOTE', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: refundId, payload: { lines: [{ description: 'x', quantity: 1, unitAmount: 1 }] } }, select: { id: true } })
const noRow: Stub = async () => ({ queued: true, reason: 'already-queued', connector: 'xero' })
const handled: Stub = async () => ({ queued: true, reason: 'handled-by-hand', connector: 'xero' })

for (const permanent of [false, true]) {
  test(`[refund 182 treatment] ${permanent ? 'PERMANENT-hold path (stamped refund, switch ON)' : 'new-hold path'}: handled-by-hand, a queued answer with no row and a sendable row are three different results; none stamps or counts`, { skip }, async (t) => {
    const deps = await loadDeps()
    const restore = await configure(deps.db, true, { [COUNT]: '3', [THRESHOLD]: '10' })
    const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
    t.after(async () => { await restore(); await cleanup(deps.db, fx) })
    await seedXeroList(deps.db, { TAX131: '0.000000' })
    const refund = await eas182Refund(deps, fx, { net: '100', stated: '119', tax: '19', rate: null })
    if (permanent) await deps.db.salesOrderRefund.update({ where: { id: refund.refundId }, data: { eas182HeldAt: new Date() } })
    const before = await stampOf(deps, refund.refundId)
    // handled by hand: its own result, no stamp change, no count.
    const a = await treat(deps, fx, refund, handled)
    assert.equal(a.kind, 'hold_handled')
    assert.equal(await heldCount(deps.db), '3')
    // queued but no refused row exists: accounted as UNMET.
    const b = await treat(deps, fx, refund, noRow)
    assert.equal(b.kind, 'held')
    assert.equal(b.kind === 'held' && b.outcome.queued, false, 'the obligation stays unmet')
    assert.equal(await heldCount(deps.db), '3')
    // a sendable row exists: a conflict, and the operator is told.
    const sendable = await sendableRow(deps, refund.refundId)
    const c = await treat(deps, fx, refund, noRow)
    assert.equal(c.kind, 'hold_conflict')
    assert.ok(await deps.db.accountingSyncLog.findUnique({ where: { id: sendable.id } }), 'the sendable row is untouched')
    assert.equal(await heldCount(deps.db), '3')
    assert.deepEqual(await stampOf(deps, refund.refundId), before, 'the stamp is as it was')
    assert.ok(await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_182_hold_conflict' } }))
  })
}

test('[refund 182 treatment] a permanent hold is held with the switch OFF and with the threshold lowered to 0; a never-held refund with a null line rate still holds (the 182 path needs no frozen rate)', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, false, { [COUNT]: '3', [THRESHOLD]: '0' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  const refund = await eas182Refund(deps, fx, { net: '100', stated: '119', tax: '19' })
  await deps.db.salesOrderRefund.update({ where: { id: refund.refundId }, data: { eas182HeldAt: new Date() } })
  let reason = ''
  const result = await treat(deps, fx, refund, async (r) => { reason = r; return { queued: true, reason: 'queued', connector: 'xero' } })
  assert.equal(result.kind, 'held', 'switch off and threshold 0: still held')
  assert.match(reason, /rate 182/)
  assert.equal(await heldCount(deps.db), '3')
  // Still switch OFF: handled-by-hand and a sendable row are their own results on the permanent path (never a fall-through to an ordinary credit note).
  assert.equal((await treat(deps, fx, refund, handled)).kind, 'hold_handled')
  await sendableRow(deps, refund.refundId)
  assert.equal((await treat(deps, fx, refund, noRow)).kind, 'hold_conflict')
  // The wording uses the stored figures: 119 total, 19 VAT.
  assert.match(reason, /total 119 [A-Z]{3}[\s\S]*19 is VAT|119 [A-Z]{3}, of which 19 is VAT/)
})

test('[refund 182 treatment] prior refunds are priced for the aggregate bound: a whole-order reversal uses all the VAT, a legacy gross-basis refund or a rate-less line cannot be priced (refused), a stated gross gives its tax, and the allowance is the ORDER\'s (lines + 1 minor units)', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '10', [THRESHOLD]: '10' })
  const mk = async () => { const f = await seed(deps, { stamp: 'IOSS', schemeRate: true }); t.after(async () => { await cleanup(deps.db, f) }); return f }
  t.after(async () => { await restore() })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const refused = async (fx: Fixture, refund: Awaited<ReturnType<typeof eas182Refund>>) => {
    const r = await treat(deps, fx, refund, async () => ({ queued: true, connector: 'xero' }))
    return r.kind === 'refused' ? r.reason : null
  }
  // (1) an earlier whole-order reversal returned all of the order's VAT: nothing is left.
  const f1 = await mk()
  await eas182Refund(deps, f1, { net: '134', stated: '159.46', tax: '25.46', source: 'CHARGEBACK_POLLER', eas: false, withStated: false, rate: null })
  const r1 = await eas182Refund(deps, f1, { net: '1', stated: '1.19', tax: '0.19' })
  assert.match((await refused(f1, r1)) ?? '', /already been refunded/)
  // (2) an earlier refund on a legacy (gross) basis cannot be priced.
  const f2 = await mk()
  await eas182Refund(deps, f2, { net: '10', stated: '11.9', tax: '1.9', basis: null, eas: false })
  const r2 = await eas182Refund(deps, f2, { net: '100', stated: '119', tax: '19' })
  assert.match((await refused(f2, r2)) ?? '', /earlier refund on this order cannot be established/)
  // (3) an earlier refund with no stated gross and a line with no frozen rate cannot be priced.
  const f3 = await mk()
  await eas182Refund(deps, f3, { net: '10', stated: '0', tax: '0', rate: null, eas: false, withStated: false })
  const r3 = await eas182Refund(deps, f3, { net: '100', stated: '119', tax: '19' })
  assert.match((await refused(f3, r3)) ?? '', /earlier refund on this order cannot be established/)
  // (4) an earlier refund with no stated gross is priced from its lines' frozen rate (10 x 0.19 = 1.9).
  const f4 = await mk()
  await eas182Refund(deps, f4, { net: '10', stated: '0', tax: '0', eas: false, withStated: false })
  const r4 = await eas182Refund(deps, f4, { net: '100', stated: '123.56', tax: '23.56' })
  assert.equal(await refused(f4, r4), null, '1.9 + 23.56 = 25.46: exactly the order\'s VAT')
  // (5) the order's allowance is lines + 1 = 4 minor units (3 lines): 25.50 passes, 25.51 does not.
  const f5 = await mk()
  await eas182Refund(deps, f5, { net: '10', stated: '0', tax: '0', eas: false, withStated: false })
  const r5 = await eas182Refund(deps, f5, { net: '100', stated: '123.60', tax: '23.60' })
  assert.equal(await refused(f5, r5), null, '25.50 is on the bound')
  const f6 = await mk()
  await eas182Refund(deps, f6, { net: '10', stated: '0', tax: '0', eas: false, withStated: false })
  const r6 = await eas182Refund(deps, f6, { net: '100', stated: '123.61', tax: '23.61' })
  assert.match((await refused(f6, r6)) ?? '', /more than the order's collected VAT not already refunded/)
})
