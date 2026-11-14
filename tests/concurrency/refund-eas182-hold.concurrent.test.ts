import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { EU_VAT_CREDIT_NOTE_REFUSED_KEY } from '../../lib/domain/accounting/eu-vat-credit-note.ts'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * THE FIRST-N HOLD ON A RATE-182 SCHEME CREDIT NOTE, through the real `createRefund`, against a real PostgreSQL (scratch database). No Xero call is made: the queue writes a row and nothing posts.
 *   1. The first refund is held: queued as a refused row (never sent), the count goes 0 -> 1, the refund is stamped.
 *   2. With the count at the threshold the next one posts normally: ONE VAT line on the stamped account, total = the refund.
 *   3. Two refunds racing at count 9 of 10 hold exactly one.
 *   4. A refund whose VAT is over the order's VAT not already refunded, or does not match its own stated tax, refuses: nothing queued.
 *   5. Switch OFF: nothing is read or written (no stamp, no count), whatever the caller hands in.
 *   6. An accounting retry of a held refund is held again and is not counted again.
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

const wooRefundId = () => 3_000_000 + Math.floor(Math.random() * 6_000_000)
type RefundLine = { lineId: string | null; productId: null; description: string; qty: 0; totalBase: number; lineKind: 'sale' | 'shipping'; chargedTaxForeign?: number }
const itemised = (lineId: string, description: string, net: number, tax: number): RefundLine => ({ lineId, productId: null, description, qty: 0, totalBase: net, lineKind: 'sale', chargedTaxForeign: tax })

async function creditNoteRowOf(db: Db, refundId: string) {
  const row = await db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: refundId }, select: { payload: true } })
  return (row?.payload ?? null) as Record<string, unknown> | null
}
const COUNT = 'eu_vat_refund182_held_count'
const THRESHOLD = 'eu_vat_refund182_hold_threshold'
const heldCount = async (db: Db) => (await db.setting.findUnique({ where: { key: COUNT } }))?.value ?? null

/** A rate-182 refund of the goods line: net 100, VAT as stated (19 by default), gross as stated. */
async function refund182(deps: Deps, fx: Fixture, opts: { gross?: number; statedTax?: number; net?: number; tax?: number } = {}) {
  const net = opts.net ?? 100
  const tax = opts.tax ?? 19
  const result = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', net, tax)], 'rate 182', undefined, {
    internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: opts.gross ?? net + tax, eas182StatedTaxForeign: opts.statedTax ?? tax,
  })
  const refund = await deps.db.salesOrderRefund.findFirst({ where: { orderId: fx.orderId }, orderBy: { createdAt: 'desc' }, select: { id: true, eas182HeldAt: true, eas182StatedTaxForeign: true, accountingRetryRequired: true } })
  return { result, refund: refund!, payload: result.success ? await creditNoteRowOf(deps.db, refund!.id) : null }
}

test('[refund 182 hold] the FIRST refund is held (a refused row, never sent) and the count increments; the 11th posts on the stamped account', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const first = await refund182(deps, fx)
  assert.equal(first.result.success, true, first.result.error)
  assert.ok(first.payload, 'a row was queued')
  const marker = first.payload[EU_VAT_CREDIT_NOTE_REFUSED_KEY] as { reason: string } | undefined
  assert.ok(marker, 'the held credit note is the refused, non-postable row')
  assert.match(marker.reason, /rate 182[\s\S]*first 10[\s\S]*number 1[\s\S]*Check Xero[\s\S]*settle action on \/sync/)
  assert.deepEqual(first.payload.lines, [], 'no lines: nothing in it could be posted')
  assert.equal(await heldCount(deps.db), '1')
  assert.ok(first.refund.eas182HeldAt, 'the refund is stamped as held')
  assert.equal(first.refund.eas182StatedTaxForeign?.toString(), '19')
  // The count reaches the threshold: the next credit note posts as an ordinary scheme credit note.
  await deps.db.setting.update({ where: { key: COUNT }, data: { value: '10' } })
  const eleventh = await refund182(deps, fx, { net: 20, tax: 3.8 })
  assert.equal(eleventh.result.success, true, eleventh.result.error)
  assert.ok(eleventh.payload, 'a row was queued')
  assert.equal(EU_VAT_CREDIT_NOTE_REFUSED_KEY in eleventh.payload, false, 'not held')
  const lines = eleventh.payload.lines as Array<{ description: string; accountCode: string; taxType: string; noTaxKind?: string; unitAmount: number; quantity: number }>
  assert.deepEqual(lines.map((l) => [l.description, l.accountCode, l.taxType, l.noTaxKind ?? null, l.unitAmount]), [['Widget', '200', 'TAX131', null, 20], ['IOSS VAT refunded', '821', 'NONE', 'eu-vat-recovery', 3.8]])
  assert.equal(lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0).toFixed(2), '23.80', 'the total is the refund amount')
  assert.equal((eleventh.payload._euVatTreatment as Record<string, unknown>).applied, true)
  assert.equal(await heldCount(deps.db), '10', 'a posted credit note is not counted')
  assert.equal(eleventh.refund.eas182HeldAt, null)
})

test('[refund 182 hold] two refunds racing at count 9 of 10 hold EXACTLY one; the other posts; the count ends at 10', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '9', [THRESHOLD]: '10' })
  const a = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const b = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, a); await cleanup(deps.db, b) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const [x, y] = await Promise.all([refund182(deps, a), refund182(deps, b)])
  assert.equal(x.result.success, true, x.result.error)
  assert.equal(y.result.success, true, y.result.error)
  const held = [x, y].filter((r) => r.payload !== null && EU_VAT_CREDIT_NOTE_REFUSED_KEY in r.payload)
  const posted = [x, y].filter((r) => r.payload !== null && !(EU_VAT_CREDIT_NOTE_REFUSED_KEY in r.payload))
  assert.equal(held.length, 1, 'exactly one is held')
  assert.equal(posted.length, 1, 'the other posts')
  assert.equal(await heldCount(deps.db), '10')
  assert.equal([x, y].filter((r) => r.refund.eas182HeldAt !== null).length, 1)
})

test('[refund 182 hold] a refund whose VAT is over the order\'s VAT not already refunded, or does not match its own stated tax, REFUSES: nothing queued, nothing counted', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '10', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const fx2 = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx); await cleanup(deps.db, fx2) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // The stated gross and the stated tax disagree beyond rounding: refused (the total check).
  const mismatch = await refund182(deps, fx, { gross: 125, statedTax: 19 })
  assert.equal(mismatch.payload, null, 'nothing queued')
  assert.equal(mismatch.refund.accountingRetryRequired, true, 'the obligation stays unmet')
  const refusal = await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_credit_note_eu_vat_refused' }, select: { description: true } })
  assert.match(refusal?.description ?? '', /tax it states across its tax rates is 19/)
  // An earlier refund took 25 of the order's 25.46 VAT (re-priced by the plugin); a second one asking 6.46 is over what is left.
  const first = await refund182(deps, fx2, { gross: 125, statedTax: 25, net: 100, tax: 19 })
  assert.equal(first.result.success, true, first.result.error)
  assert.ok(first.payload && !(EU_VAT_CREDIT_NOTE_REFUSED_KEY in first.payload), 'the first posts (count at the threshold)')
  const over = await refund182(deps, fx2, { net: 34, tax: 6.46 })
  const overRefunds = await deps.db.salesOrderRefund.findMany({ where: { orderId: fx2.orderId }, select: { id: true } })
  assert.equal(overRefunds.length >= 2, true)
  const overRow = await deps.db.accountingSyncLog.count({ where: { type: 'CREDIT_NOTE', referenceId: over.refund.id } })
  assert.equal(overRow, 0, 'nothing queued for the over-bound refund')
  assert.equal(over.refund.accountingRetryRequired, true)
  const overActivity = await deps.db.activityLog.findFirst({ where: { entityId: fx2.orderId, action: 'refund_credit_note_eu_vat_refused', description: { contains: 'not already refunded' } }, select: { description: true } })
  assert.ok(overActivity, 'the refusal says the VAT is over what is left to refund')
  assert.equal(await heldCount(deps.db), '10', 'a refusal is not counted')
})

test('[refund 182 hold] switch OFF: the 182 figure handed in is ignored: no stamp, no count, no marker, the credit note is built as development builds it', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, false, { [COUNT]: '0', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  const out = await refund182(deps, fx)
  assert.equal(out.result.success, true, out.result.error)
  assert.ok(out.payload)
  assert.equal(EU_VAT_CREDIT_NOTE_REFUSED_KEY in out.payload, false)
  assert.equal('_euVatTreatment' in out.payload, false)
  assert.match((out.payload.lines as Array<{ taxType: string }>)[0]!.taxType, /^DE_CHARGED_/, 'the charged code, as development builds it')
  assert.equal(out.refund.eas182HeldAt, null)
  assert.equal(out.refund.eas182StatedTaxForeign, null)
  assert.equal(await heldCount(deps.db), '0', 'the count is untouched')
})

test('[refund 182 hold] an accounting retry of a held refund is held again and NOT counted again; a threshold that is not a number holds without counting', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { decideRefund182Hold } = await import('../../lib/domain/sales/refund-182-hold.ts')
  const first = await refund182(deps, fx)
  assert.equal(first.result.success, true, first.result.error)
  assert.equal(await heldCount(deps.db), '1')
  const again = await decideRefund182Hold(first.refund.id, async () => ({ queued: true as const }))
  assert.deepEqual(again, { held: true, queued: true, newlyHeld: false, heldNumber: 1, threshold: 10, outcome: { queued: true } })
  assert.equal(await heldCount(deps.db), '1', 'not counted twice')
  // Not a whole number: held, and the count is left alone.
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: 'ten' } })
  const second = await refund182(deps, fx, { net: 20, tax: 3.8 })
  assert.equal(second.result.success, true, second.result.error)
  assert.ok(second.payload && EU_VAT_CREDIT_NOTE_REFUSED_KEY in second.payload, 'held, not guessed')
  assert.equal(await heldCount(deps.db), '1')
  // Threshold 0: nothing is held and nothing is written.
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '0' } })
  const third = await refund182(deps, fx, { net: 10, tax: 1.9 })
  assert.ok(third.payload && !(EU_VAT_CREDIT_NOTE_REFUSED_KEY in third.payload), 'posts')
  assert.equal(await heldCount(deps.db), '1')
})

test('[refund 182 hold] no stamp and no count without the row: an enqueue that fails or throws rolls the hold back; a held refund stays held (the refused row only, no sendable payload) after the switch is turned off', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const fx2 = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx); await cleanup(deps.db, fx2) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { decideRefund182Hold } = await import('../../lib/domain/sales/refund-182-hold.ts')
  const { retryRefundAccounting } = await import('../../app/actions/sales.ts')
  const first = await refund182(deps, fx)
  assert.equal(first.result.success, true, first.result.error)
  assert.ok(first.payload && EU_VAT_CREDIT_NOTE_REFUSED_KEY in first.payload)
  assert.equal(await heldCount(deps.db), '1')

  // A second refund whose enqueue is refused, then one whose enqueue throws: nothing stamped, nothing counted.
  const second = await refund182(deps, fx2, { net: 20, tax: 3.8 })
  await deps.db.setting.update({ where: { key: COUNT }, data: { value: '1' } })
  const stampOf = async (id: string) => (await deps.db.salesOrderRefund.findUnique({ where: { id }, select: { eas182HeldAt: true } }))!.eas182HeldAt
  const fresh = await deps.db.salesOrderRefund.create({ data: { orderId: fx2.orderId, totalForeign: 1, totalBase: 1, totalsBasis: 'NET' }, select: { id: true } })
  const refusedEnqueue = await decideRefund182Hold(fresh.id, async () => ({ queued: false as const }))
  assert.deepEqual(refusedEnqueue, { held: true, queued: false, outcome: { queued: false } })
  assert.equal(await stampOf(fresh.id), null, 'not stamped')
  assert.equal(await heldCount(deps.db), '1', 'not counted')
  await assert.rejects(decideRefund182Hold(fresh.id, async () => { throw new Error('enqueue exploded') }), /enqueue exploded/)
  assert.equal(await stampOf(fresh.id), null)
  assert.equal(await heldCount(deps.db), '1')
  await deps.db.salesOrderRefund.delete({ where: { id: fresh.id } })
  void second

  // The stamp is committed but the row was lost; the switch is turned OFF; the retry gives the held refused row only, and the count is unchanged.
  await deps.db.accountingSyncLog.deleteMany({ where: { type: 'CREDIT_NOTE', referenceId: first.refund.id } })
  await deps.db.salesOrderRefund.update({ where: { id: first.refund.id }, data: { accountingRetryRequired: true } })
  await deps.db.setting.upsert({ where: { key: 'xero_sync_sales_invoice' }, create: { key: 'xero_sync_sales_invoice', value: 'off' }, update: { value: 'off' } })
  const retried = await retryRefundAccounting(first.refund.id)
  assert.equal(retried.success, true, retried.error)
  const row = await creditNoteRowOf(deps.db, first.refund.id)
  assert.ok(row, 'the refused row is queued again')
  assert.ok(EU_VAT_CREDIT_NOTE_REFUSED_KEY in row, 'a held refund stays held with the switch off')
  assert.deepEqual(row.lines, [], 'no sendable payload')
  assert.equal('_euVatTreatment' in row, false)
  assert.equal(await heldCount(deps.db), '1', 'the count is unchanged')
})

test('[refund 182 hold] a SENDABLE credit note already queued for the refund is a CONFLICT: nothing is stamped or counted, the row is left alone, the operator is told; the permanent-hold path conflicts too', { skip }, async (t) => {
  const deps = await loadDeps()
  // Threshold 0: the 182 credit note is queued as an ordinary, sendable, pending credit note.
  const restore = await configure(deps.db, true, { [COUNT]: '0', [THRESHOLD]: '0' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const { retryRefundAccounting } = await import('../../app/actions/sales.ts')
  const first = await refund182(deps, fx)
  assert.equal(first.result.success, true, first.result.error)
  assert.ok(first.payload && !(EU_VAT_CREDIT_NOTE_REFUSED_KEY in first.payload), 'queued sendable')
  const rowBefore = await deps.db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: first.refund.id }, select: { id: true, status: true, payload: true } })
  assert.ok(rowBefore)
  // The threshold is raised above the count; a retry would dedupe against the sendable row.
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '10' } })
  await deps.db.salesOrderRefund.update({ where: { id: first.refund.id }, data: { accountingRetryRequired: true } })
  await retryRefundAccounting(first.refund.id)
  const stamp = await deps.db.salesOrderRefund.findUnique({ where: { id: first.refund.id }, select: { eas182HeldAt: true } })
  assert.equal(stamp?.eas182HeldAt, null, 'not stamped')
  assert.equal(await heldCount(deps.db), '0', 'not counted')
  const rowAfter = await deps.db.accountingSyncLog.findMany({ where: { type: 'CREDIT_NOTE', referenceId: first.refund.id }, select: { id: true, status: true, payload: true } })
  assert.equal(rowAfter.length, 1)
  assert.deepEqual(rowAfter[0], rowBefore, 'the sendable row is untouched')
  const notice = await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_182_hold_conflict' }, select: { description: true } })
  assert.match(notice?.description ?? '', /could NOT be held for review[\s\S]*already queued to be sent/)

  // Permanent-hold path: a stamped refund whose key resolves to a sendable row is a conflict, never silently held.
  await deps.db.salesOrderRefund.update({ where: { id: first.refund.id }, data: { eas182HeldAt: new Date(), accountingRetryRequired: true } })
  await deps.db.activityLog.deleteMany({ where: { entityId: fx.orderId, action: 'refund_182_hold_conflict' } })
  await retryRefundAccounting(first.refund.id)
  assert.ok(await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_182_hold_conflict' } }), 'surfaced again')
  assert.equal(await heldCount(deps.db), '0')
  assert.deepEqual((await deps.db.accountingSyncLog.findMany({ where: { type: 'CREDIT_NOTE', referenceId: first.refund.id }, select: { id: true, status: true, payload: true } }))[0], rowBefore)
})

test('[refund 182 hold] the held row must EXIST with this refund\'s key before anything is stamped or counted: a handled-by-hand answer with no row, and a "queued" answer with no row, both leave no stamp and no count', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '3', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  const { decideRefund182Hold, creditNoteIdempotencyKey } = await import('../../lib/domain/sales/refund-182-hold.ts')
  const fresh = await deps.db.salesOrderRefund.create({ data: { orderId: fx.orderId, totalForeign: 1, totalBase: 1, totalsBasis: 'NET' }, select: { id: true } })
  const stampOf = async () => (await deps.db.salesOrderRefund.findUnique({ where: { id: fresh.id }, select: { eas182HeldAt: true } }))!.eas182HeldAt
  // The posting was marked handled by hand: the enqueue answers queued, reason handled-by-hand, and writes NO row.
  const handled = await decideRefund182Hold(fresh.id, async () => ({ queued: true as const, reason: 'handled-by-hand' }))
  assert.deepEqual(handled, { held: false, handledByHand: true, outcome: { queued: true, reason: 'handled-by-hand' } })
  assert.equal(await stampOf(), null, 'no stamp')
  assert.equal(await heldCount(deps.db), '3', 'no count')
  // "Queued" with no row at all (any other reason): not a hold; reported as unmet.
  const missing = await decideRefund182Hold(fresh.id, async () => ({ queued: true as const, reason: 'already-queued' }))
  assert.deepEqual(missing, { held: true, queued: false, outcome: { queued: true, reason: 'already-queued' }, rowMissing: true })
  assert.equal(await stampOf(), null)
  assert.equal(await heldCount(deps.db), '3')
  // A refused row under ANOTHER key is not this refund's held row.
  const other = await deps.db.accountingSyncLog.create({ data: { type: 'CREDIT_NOTE', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: fresh.id, payload: { lines: [], _euVatCreditNoteRefused: { reason: 'x' }, _idempotencyKey: 'some-other-key' } }, select: { id: true } })
  const wrongKey = await decideRefund182Hold(fresh.id, async () => ({ queued: true as const, reason: 'already-queued' }))
  assert.equal(wrongKey.held && !wrongKey.queued, true)
  assert.equal(await stampOf(), null)
  assert.equal(await heldCount(deps.db), '3')
  // The row with this refund's key: held, stamped, counted.
  await deps.db.accountingSyncLog.update({ where: { id: other.id }, data: { payload: { lines: [], _euVatCreditNoteRefused: { reason: 'x' }, _idempotencyKey: creditNoteIdempotencyKey(fresh.id) } } })
  const ok = await decideRefund182Hold(fresh.id, async () => ({ queued: true as const, reason: 'already-queued' }))
  assert.equal(ok.held && ok.queued && ok.newlyHeld, true)
  assert.ok(await stampOf())
  assert.equal(await heldCount(deps.db), '4')
  // The key the hold expects is the key the hand-off queues under.
  assert.match(readFileSync('app/actions/sales.ts', 'utf8'), /idempotencyKey: `sales-order-refund:\$\{input\.refundId\}:credit-note`/)
  assert.equal(creditNoteIdempotencyKey('R1'), 'sales-order-refund:R1:credit-note')
})

test('[refund 182 hold] edge cases: threshold 0 writes nothing; a held refund stays held when the threshold drops to 0; a cancelled sendable row is not a conflict; a non-numeric count holds without counting; an already-held refund whose row is missing is unmet; the place among the held is reported', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '3', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  const { decideRefund182Hold, creditNoteIdempotencyKey } = await import('../../lib/domain/sales/refund-182-hold.ts')
  const mkRefund = async () => (await deps.db.salesOrderRefund.create({ data: { orderId: fx.orderId, totalForeign: 1, totalBase: 1, totalsBasis: 'NET' }, select: { id: true } })).id
  const refusedRow = (refundId: string, over: Record<string, unknown> = {}) => deps.db.accountingSyncLog.create({ data: { type: 'CREDIT_NOTE', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: refundId, payload: { lines: [], _euVatCreditNoteRefused: { reason: 'x' }, _idempotencyKey: creditNoteIdempotencyKey(refundId), ...over } } })
  const stamp = async (id: string) => (await deps.db.salesOrderRefund.findUnique({ where: { id }, select: { eas182HeldAt: true } }))!.eas182HeldAt
  const queued = async () => ({ queued: true as const, reason: 'queued' })

  // Threshold 0 with NO counter row: nothing is held and no counter row is written.
  await deps.db.setting.deleteMany({ where: { key: COUNT } })
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '0' } })
  const zero = await mkRefund()
  assert.deepEqual(await decideRefund182Hold(zero, queued), { held: false })
  assert.equal(await heldCount(deps.db), null, 'no counter row was written')
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '10' } })
  await deps.db.setting.upsert({ where: { key: COUNT }, create: { key: COUNT, value: '3' }, update: { value: '3' } })

  // A held refund stays held when the threshold is later lowered to 0 (and when it is no longer below the count).
  const heldId = await mkRefund()
  await refusedRow(heldId)
  const first = await decideRefund182Hold(heldId, queued)
  assert.equal(first.held && 'queued' in first && first.queued && first.newlyHeld && first.heldNumber >= 1, true)
  assert.equal(first.held && 'heldNumber' in first ? first.heldNumber : -1, 4, 'the number is the count after this one (3 + 1)')
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '0' } })
  const again = await decideRefund182Hold(heldId, queued)
  assert.equal(again.held && 'newlyHeld' in again && again.newlyHeld === false, true, 'still held, not counted again')
  await deps.db.setting.update({ where: { key: THRESHOLD }, data: { value: '10' } })

  // An already-held refund whose refused row is gone: held again but UNMET (nothing exists to settle).
  const gone = await mkRefund()
  await deps.db.$executeRaw`UPDATE sales_order_refunds SET eas182_held_at = now() WHERE id = ${gone}`
  const missing = await decideRefund182Hold(gone, queued)
  assert.deepEqual(missing, { held: true, queued: false, outcome: { queued: true, reason: 'queued' }, rowMissing: true })

  // A CANCELLED sendable row can never go out: not a conflict.
  const cancelled = await mkRefund()
  await deps.db.accountingSyncLog.create({ data: { type: 'CREDIT_NOTE', status: 'CANCELLED', referenceType: 'SalesOrderRefund', referenceId: cancelled, payload: { lines: [{ description: 'x', quantity: 1, unitAmount: 1 }] } } })
  await refusedRow(cancelled)
  const ok = await decideRefund182Hold(cancelled, queued)
  assert.equal(ok.held && 'queued' in ok && ok.queued, true)
  assert.ok(await stamp(cancelled))

  // A count that is not a whole number holds without counting.
  await deps.db.setting.update({ where: { key: COUNT }, data: { value: 'abc' } })
  const odd = await mkRefund()
  await refusedRow(odd)
  const held = await decideRefund182Hold(odd, queued)
  assert.equal(held.held && 'queued' in held && held.queued && held.threshold === null, true)
  assert.equal(await heldCount(deps.db), 'abc', 'not counted')
})


test('[refund 182 hold] the SAME refund treated twice at once is counted ONCE (the held mark is re-read under the counter lock)', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true, { [COUNT]: '3', [THRESHOLD]: '10' })
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  const { decideRefund182Hold, creditNoteIdempotencyKey } = await import('../../lib/domain/sales/refund-182-hold.ts')
  const refund = await deps.db.salesOrderRefund.create({ data: { orderId: fx.orderId, totalForeign: 1, totalBase: 1, totalsBasis: 'NET' }, select: { id: true } })
  await deps.db.accountingSyncLog.create({ data: { type: 'CREDIT_NOTE', status: 'PENDING', referenceType: 'SalesOrderRefund', referenceId: refund.id, payload: { lines: [], _euVatCreditNoteRefused: { reason: 'x' }, _idempotencyKey: creditNoteIdempotencyKey(refund.id) } } })
  // A slow enqueue keeps the counter lock held while the others have already passed the unlocked held check and are waiting on it.
  const enqueue = async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return { queued: true as const, reason: 'already-queued' } }
  const results = await Promise.all([decideRefund182Hold(refund.id, enqueue), decideRefund182Hold(refund.id, enqueue), decideRefund182Hold(refund.id, enqueue)])
  assert.equal(results.every((r) => r.held), true)
  assert.equal(results.filter((r) => r.held && 'newlyHeld' in r && r.newlyHeld).length, 1, 'exactly one counted it')
  assert.equal(await heldCount(deps.db), '4', 'the count went up by one')
})
