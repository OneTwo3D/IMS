import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

/**
 * THE EU IOSS / VOEC / DDP CREDIT-NOTE TREATMENT THROUGH THE REAL `createRefund`, against a real PostgreSQL (scratch database). No Xero call is made: the queue writes a row and nothing posts.
 *
 *   1. Sales Invoices switch OFF: the credit-note payload is byte-identical to what origin/development builds. GOLDEN_* are the normalised payloads that origin/development builds for these very orders (captured by running this file on a checkout of it with DUMP=1).
 *   2. Switch ON, a scheme-stamped order: a partial refund (the goods and ONE of two fees) is rebuilt on the stamped account and the snapshotted posting type, only the touched fee is present, the total is the refund's amount, and the refund line snapshots its posting type.
 *   3. A cancellation (the payment poller's whole-order reversal) reverses the order's whole VAT and totals the whole invoice.
 *   4. A scheme order with no stamp refuses and queues nothing; an order outside the scheme is left alone.
 *   5. The stamped account is reused after the facts changed; the policy recorded is the one in force; a change to it is refused by the final pre-socket check, with the working instruction.
 *   6. A WooCommerce refund whose tax is booked on rate 182 is parked, not recorded, and createRefund is never called.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'
const DUMP = process.env.DUMP === '1'

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
async function seed(deps: Deps, opts: { stamp: 'IOSS' | 'none' | null; schemeRate: boolean }) {
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
        : { euVatRegime: 'IOSS' as const, euVatLineAccount: '821', euVatRegimeStampedAt: new Date(), euVatRegimeBasis: { version: 1, outcome: 'SCHEME', scheme: { imsRateIds: [rate.id] }, warnings: [] } }),
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

async function creditNoteRow(db: Db, orderId: string) {
  const refund = await db.salesOrderRefund.findFirst({ where: { orderId }, select: { id: true } })
  if (!refund) return null
  const row = await db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: refund.id }, select: { payload: true } })
  return { refundId: refund.id, payload: (row?.payload ?? null) as Record<string, unknown> | null }
}

/** The payload with what varies by run (contact, dates, numbers, ids, the rate id and its random code) left out or named. */
function normalise(payload: Record<string, unknown>, fx: Fixture): string {
  const { contactName: _c, contactEmail: _e, date: _d, creditNoteNumber: _n, reference: _r, _idempotencyKey: _k, ...rest } = payload
  void [_c, _e, _d, _n, _r, _k]
  return JSON.stringify(rest).split(fx.rate.id).join('RATE').replace(/DE_CHARGED_[0-9a-f]{8}/g, 'CHARGED')
}

// Captured by running this file on origin/development with DUMP=1 (the credit-note payloads it builds for these two orders, on and off the scheme). Compared as stored (jsonb), the form the queue row holds.
const GOLDEN_PLAIN: string | null = '{"lines":[{"taxType":"CHARGED","quantity":1,"taxRateId":"RATE","unitAmount":100,"accountCode":"200","description":"Widget","taxRateBasis":"sales_line"},{"taxType":"CHARGED","quantity":1,"taxRateId":"RATE","unitAmount":20,"accountCode":"200","description":"EU Customs Fee","taxRateBasis":"sales_line"}],"currency":"GBP","_postingMode":"draft","currencyRateToBase":1,"_connectionProvenance":"!disconnected","lineAmountsIncludeTax":false}'
const GOLDEN_SCHEME_OFF: string | null = '{"lines":[{"taxType":"CHARGED","quantity":1,"taxRateId":"RATE","unitAmount":100,"accountCode":"200","description":"Widget","taxRateBasis":"sales_line"},{"taxType":"CHARGED","quantity":1,"taxRateId":"RATE","unitAmount":20,"accountCode":"200","description":"EU Customs Fee","taxRateBasis":"sales_line"}],"currency":"GBP","_postingMode":"draft","currencyRateToBase":1,"_connectionProvenance":"!disconnected","lineAmountsIncludeTax":false}'

for (const scheme of [false, true]) {
  test(`[eu vat credit note] switch OFF: the credit note on ${scheme ? 'a scheme-stamped' : 'an ordinary'} order is byte-identical to origin/development, nothing is read, no marker`, { skip }, async (t) => {
    const deps = await loadDeps()
    const restore = await configure(deps.db, false)
    const fx = await seed(deps, { stamp: scheme ? 'IOSS' : 'none', schemeRate: scheme })
    t.after(async () => { await restore(); await cleanup(deps.db, fx) })
    const result = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', 100, 19), itemised(fx.feeA, 'EU Customs Fee', 20, 3.8)], 'goldens', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 142.8 })
    assert.equal(result.success, true, result.error)
    const row = await creditNoteRow(deps.db, fx.orderId)
    assert.ok(row?.payload, 'a credit note was queued')
    const text = normalise(row.payload, fx)
    if (DUMP) console.log(`GOLDEN-${scheme ? 'SCHEME_OFF' : 'PLAIN'} ${text}`)
    const golden = scheme ? GOLDEN_SCHEME_OFF : GOLDEN_PLAIN
    if (golden !== null) assert.equal(text, golden)
    assert.equal('_euVatTreatment' in row.payload, false, 'no marker')
    const lines = row.payload.lines as Array<{ accountCode: string; taxType: string }>
    assert.deepEqual(lines.map((l) => [l.accountCode, l.taxType]), [['200', lines[0]!.taxType], ['200', lines[0]!.taxType]], 'the fee stays on the sales account and the charged code')
    assert.match(lines[0]!.taxType, /^DE_CHARGED_/)
    // Nothing the treatment snapshots is written either.
    const stored = await deps.db.salesOrderRefund.findUnique({ where: { id: row.refundId }, select: { statedGrossForeign: true, lines: { select: { postingTaxType: true } } } })
    assert.equal(stored?.statedGrossForeign, null)
    assert.deepEqual(stored?.lines.map((l) => l.postingTaxType), [null, null])
  })
}

test('[eu vat credit note] switch ON, scheme order, PARTIAL refund (goods + one of two fees): stamped account, snapshotted type, only the touched fee, ONE VAT line, total = the refund', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const result = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', 100, 19), itemised(fx.feeA, 'EU Customs Fee', 20, 3.8)], 'partial', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 142.8 })
  assert.equal(result.success, true, result.error)
  const row = await creditNoteRow(deps.db, fx.orderId)
  assert.ok(row?.payload, 'a credit note was queued')
  const lines = row.payload.lines as Array<{ description: string; quantity: number; unitAmount: number; accountCode: string; taxType: string; noTaxKind?: string }>
  assert.deepEqual(lines.map((l) => [l.description, l.accountCode, l.taxType, l.noTaxKind ?? null, l.unitAmount]), [
    ['Widget', '200', 'TAX131', null, 100],
    ['EU Customs Fee', '232', 'NONE', 'fee-no-tax', 20],
    ['IOSS VAT refunded', '821', 'NONE', 'eu-vat-recovery', 22.8],
  ])
  assert.equal(lines.some((l) => l.description === 'EU Handling Fee'), false, 'the fee this refund does not touch is not on it')
  assert.equal(lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0).toFixed(2), '142.80', 'the total is the refund amount, to the cent')
  const marker = row.payload._euVatTreatment as Record<string, unknown>
  assert.deepEqual({ applied: marker.applied, document: marker.document, route: marker.route, regime: marker.regime, type: marker.schemePostingTaxType, account: marker.vatAccount }, { applied: true, document: 'credit-note', route: 'scheme', regime: 'IOSS', type: 'TAX131', account: '821' })
  assert.equal((marker.regimePolicy as Record<string, string>).ioss, '821', 'the policy in force is recorded')
  // The posting type is snapshotted beside the tax identity, and the stated gross on the refund.
  const stored = await deps.db.salesOrderRefund.findUnique({ where: { id: row.refundId }, select: { statedGrossForeign: true, lines: { select: { postingTaxType: true, accountingTaxType: true } } } })
  assert.equal(stored?.statedGrossForeign?.toString(), '142.8')
  assert.ok(stored?.lines.every((l) => l.postingTaxType === 'TAX131' && /^DE_CHARGED_/.test(l.accountingTaxType ?? '')))
  // The poster's checks: the same policy and proof pass now, and nothing else is touched.
  const { euCreditNoteSchemePostingRefusal, composeFinalBeforePost } = await import('../../lib/connectors/xero/scheme-posting-check.ts')
  assert.equal(await euCreditNoteSchemePostingRefusal(row.payload), null)
  assert.deepEqual(await composeFinalBeforePost(null, row.payload, 'create')({} as never), { ok: true })

  // THE POLICY CHANGES while the credit note is queued: the early check and the final pre-socket check both refuse, nothing is sent, and the instruction works (restore the setting and retry on /sync, or post by hand).
  await deps.db.setting.upsert({ where: { key: 'eu_vat_gift_card_flag_cut_in' }, create: { key: 'eu_vat_gift_card_flag_cut_in', value: '2026-12-01' }, update: { value: '2026-12-01' } })
  t.after(async () => { await deps.db.setting.deleteMany({ where: { key: 'eu_vat_gift_card_flag_cut_in' } }) })
  const early = await euCreditNoteSchemePostingRefusal(row.payload)
  const final = await composeFinalBeforePost(null, row.payload, 'create')({} as never)
  for (const text of [early, final.ok ? null : final.error]) {
    assert.ok(text)
    assert.match(text, /NOTHING WAS SENT\. Credit note .* was refused: the EU VAT regime settings changed since it was prepared \(cutIn\)/)
    assert.match(text, /Check Xero for credit note .* first/)
    assert.match(text, /restore the previous EU VAT settings \(Settings > Accounting\) and retry this row on \/sync, or post the credit note by hand in Xero and record it on this row with the settle action on \/sync/)
  }
  await deps.db.setting.deleteMany({ where: { key: 'eu_vat_gift_card_flag_cut_in' } })
  assert.deepEqual(await composeFinalBeforePost(null, row.payload, 'create')({} as never), { ok: true }, 'restoring the setting is what lets the same payload post')
  // And the scheme type proven zero-rated is re-proven at the last moment.
  await seedXeroList(deps.db, { TAX131: '20.000000' })
  const typeRefused = await composeFinalBeforePost(null, row.payload, 'create')({} as never)
  assert.equal(typeRefused.ok, false)
  assert.match((typeRefused as { error: string }).error, /20.*% in Xero, not zero-rated/)
  // A credit note the treatment never touched is not judged.
  assert.deepEqual(await composeFinalBeforePost(null, { creditNoteNumber: 'CN-PLAIN', lines: [] }, 'create')({} as never), { ok: true })
})

test('[eu vat credit note] the account is the STAMPED one after the facts changed (a changed exchange rate and an IOSS account setting), never re-derived', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // The order's facts now point elsewhere: a different rate, a basis that would decide DDP, and the IOSS account setting itself changed. The stamp is write-once.
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { fxRateToBase: '0.5', euVatRegimeBasis: { version: 1, outcome: 'SCHEME', scheme: { imsRateIds: [fx.rate.id], intrinsicValue: '9999', fx: { rate: '0.5' } }, warnings: [] } } })
  await deps.db.setting.upsert({ where: { key: 'xero_eu_vat_ioss_account' }, create: { key: 'xero_eu_vat_ioss_account', value: '999' }, update: { value: '999' } })
  const { treatCreditNotePayload } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  const refund = await deps.db.salesOrderRefund.create({
    data: { orderId: fx.orderId, creditNoteNumber: `CN-FX-${randomUUID().slice(0, 6)}`, totalForeign: '100', totalBase: '100', totalsBasis: 'NET', source: 'MANUAL_UI', lines: { create: [{ salesOrderLineId: fx.goods, description: 'Widget', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', totalForeign: '100', totalBase: '100', accountingTaxType: fx.rate.accountingTaxType, lineKind: 'sale', postingTaxType: 'TAX131' }] } },
    select: { id: true, lines: { select: { id: true } } },
  })
  const payload = { creditNoteNumber: 'CN-FX', currency: deps.baseCurrency, lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: fx.rate.accountingTaxType }], lineAmountsIncludeTax: false }
  const outcome = await treatCreditNotePayload({ refundId: refund.id, orderId: fx.orderId, payload, refundLineIds: refund.lines.map((l) => l.id), connector: 'xero', accounts: { ioss: '999', ddp: '232', fee: '232', rounding: '860' }, now: new Date() })
  assert.equal(outcome.kind, 'treated')
  if (outcome.kind !== 'treated') return
  const vat = (outcome.payload.lines as Array<{ noTaxKind?: string; accountCode: string; unitAmount: number }>).find((l) => l.noTaxKind === 'eu-vat-recovery')
  assert.deepEqual([vat?.accountCode, vat?.unitAmount], ['821', 19], 'the VAT line is on the account stamped at the invoice, at the refund\'s own tax (no stated gross: the line\'s own rate)')
  assert.equal((outcome.regimePolicy as Record<string, string>).ioss, '999', 'the policy records the setting in force; the account is not taken from it')
})

test('[eu vat credit note] a scheme order with NO stamp refuses and queues nothing; an order outside the scheme is untouched', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const unstamped = await seed(deps, { stamp: null, schemeRate: true })
  const outside = await seed(deps, { stamp: null, schemeRate: false })
  t.after(async () => { await restore(); await cleanup(deps.db, unstamped); await cleanup(deps.db, outside) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const refused = await deps.createRefund(unstamped.orderId, [itemised(unstamped.goods, 'Widget', 100, 19)], 'unstamped', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  // The refund itself is recorded (the money has gone back); its credit note is what is refused, and the refund stays marked for retry.
  assert.equal(refused.success, true, refused.error)
  const row = await creditNoteRow(deps.db, unstamped.orderId)
  assert.equal(row?.payload, null, 'no credit note is queued')
  const refundRow = await deps.db.salesOrderRefund.findUnique({ where: { id: row!.refundId }, select: { accountingRetryRequired: true } })
  assert.equal(refundRow?.accountingRetryRequired, true, 'the refund is still marked for accounting retry')
  const log = await deps.db.activityLog.findFirst({ where: { entityId: unstamped.orderId, action: 'refund_credit_note_eu_vat_refused' }, select: { description: true } })
  assert.match(log?.description ?? '', /NOTHING WAS QUEUED\. Credit note [\s\S]* has no recorded VAT regime[\s\S]*stays marked for accounting retry/)
  // Not a scheme order, and never stamped: left exactly as before.
  const ok = await deps.createRefund(outside.orderId, [itemised(outside.goods, 'Widget', 100, 19)], 'plain', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(ok.success, true, ok.error)
  const plain = await creditNoteRow(deps.db, outside.orderId)
  assert.ok(plain?.payload)
  assert.equal('_euVatTreatment' in plain.payload, false)
})

test('[eu vat credit note] a CANCELLATION (the whole-order reversal) reverses the whole VAT with full lines: the stamped regime, every fee, the order\'s own tax', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const lines: RefundLine[] = [
    { lineId: fx.goods, productId: null, description: 'Widget', qty: 0, totalBase: 100, lineKind: 'sale' },
    { lineId: fx.feeA, productId: null, description: 'EU Customs Fee', qty: 0, totalBase: 20, lineKind: 'sale' },
    { lineId: fx.feeB, productId: null, description: 'EU Handling Fee', qty: 0, totalBase: 4, lineKind: 'sale' },
    { lineId: null, productId: null, description: 'Shipping', qty: 0, totalBase: 10, lineKind: 'shipping' },
  ]
  const result = await deps.createRefund(fx.orderId, lines, 'Payment reversed (chargeback)', undefined, { internalBypassToken: deps.bypass, chargeback: true })
  assert.equal(result.success, true, result.error)
  const row = await creditNoteRow(deps.db, fx.orderId)
  assert.ok(row?.payload, 'a credit note was queued')
  const queued = row.payload.lines as Array<{ description: string; accountCode: string; taxType: string; noTaxKind?: string; unitAmount: number; quantity: number }>
  assert.deepEqual(queued.map((l) => [l.description, l.accountCode, l.taxType]), [
    ['Widget', '200', 'TAX131'], ['EU Customs Fee', '232', 'NONE'], ['EU Handling Fee', '232', 'NONE'], ['Shipping', '260', 'TAX131'], ['IOSS VAT refunded', '821', 'NONE'],
  ])
  assert.equal(queued.at(-1)?.unitAmount, 25.46, 'the order\'s whole collected VAT is reversed')
  assert.equal(queued.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0).toFixed(2), '159.46', 'and the credit note totals the whole invoice')
})

test('[eu vat credit note] a WooCommerce refund whose tax is booked on rate 182 is parked, not recorded: createRefund is never called; the switch off, or a non-scheme order, is not touched', { skip }, async (t) => {
  const deps = await loadDeps()
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const outside = await seed(deps, { stamp: 'none', schemeRate: false })
  const externalOrderId = 5_000_000 + Math.floor(Math.random() * 1_000_000)
  const externalOutside = externalOrderId + 1
  await deps.db.shoppingOrderLink.create({ data: { orderId: fx.orderId, connector: 'woocommerce', externalOrderId: String(externalOrderId) } })
  await deps.db.shoppingOrderLink.create({ data: { orderId: outside.orderId, connector: 'woocommerce', externalOrderId: String(externalOutside) } })
  t.after(async () => { await cleanup(deps.db, fx); await cleanup(deps.db, outside) })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const refund = (id: number, rateId: number) => ({
    id, parent_id: externalOrderId, date_created: '2026-11-02T10:00:00', date_created_gmt: '2026-11-02T10:00:00', amount: '119.00', reason: 'r', refunded_by: 1, refunded_payment: false, meta_data: [],
    line_items: [{ id: 91, name: 'Widget', product_id: 1, variation_id: 0, quantity: 0, tax_class: '', subtotal: '-100.00', subtotal_tax: '-19.00', total: '-100.00', total_tax: '-19.00', sku: 's', meta_data: [], refund_total: -100, taxes: [{ id: rateId, total: '-19.00' }] }],
  })
  let called = 0
  const stub = async () => { called += 1; return { success: true } }
  // Switch OFF: the refund is read as it always was (the stub is reached).
  let restore = await configure(deps.db, false)
  await syncWcRefund(externalOrderId, refund(wooRefundId(), 182) as never, { createRefund: stub as never })
  assert.equal(called, 1, 'switch off: not refused')
  await restore()
  // Switch ON, scheme order, tax on 182: parked QUARANTINED with the operator wording, createRefund not called.
  restore = await configure(deps.db, true)
  t.after(async () => { await restore() })
  called = 0
  const id = wooRefundId()
  const outcome = await syncWcRefund(externalOrderId, refund(id, 182) as never, { createRefund: stub as never })
  assert.equal(outcome.outcome, 'quarantined-refusal')
  assert.equal(called, 0)
  assert.match(outcome.error ?? '', new RegExp(`WooCommerce refund ${id} was NOT recorded: its VAT \\(19\\) is booked on WooCommerce tax rate 182`))
  const park = await deps.db.shoppingSyncLog.findFirst({ where: { externalId: String(id), entityId: fx.orderId }, select: { status: true } })
  assert.equal(park?.status, 'QUARANTINED')
  // The same refund on another rate, switch on, scheme order: not refused.
  await syncWcRefund(externalOrderId, refund(wooRefundId(), 244) as never, { createRefund: stub as never })
  assert.equal(called, 1, 'any other rate is recorded as before')
  // 182 on an order outside the scheme: not refused.
  await syncWcRefund(externalOutside, refund(wooRefundId(), 182) as never, { createRefund: stub as never })
  assert.equal(called, 2, 'a non-scheme order is not touched')
})

test('[eu vat credit note] every route to a credit note reaches the one builder, and the poster wires both checks', () => {
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  // The hand-off builds the payload once and treats it before the enqueue.
  assert.match(sales, /const builtCreditNotePayload[\s\S]*await treatCreditNotePayload\(\{[\s\S]*payload: creditNoteTreatment\.kind === 'treated' \? creditNoteTreatment\.payload : builtCreditNotePayload/)
  // The refund (storefront or operator), the payment poller's whole-order reversal (a chargeback, which calls createRefund) and an accounting retry all end in it.
  assert.equal((sales.match(/await queueRefundAccountingActions\(\{/g) ?? []).length, 2, 'createRefund and retryRefundAccounting')
  assert.match(sales, /export async function raiseChargebackForReversedOrder[\s\S]*await createRefund\(orderId, lines, 'Payment reversed \(chargeback\)'/)
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  assert.match(processor, /const creditNoteSchemeRefusal = await euCreditNoteSchemePostingRefusal\(payload as Record<string, unknown>\)/)
  assert.match(processor, /const creditNoteBeforePostHook = creditNoteBeforePost\(payload as Record<string, unknown>\)\n\s+const fence = await lease\.fenceBeforeRemoteWrite\('credit-note'\)/)
  assert.match(processor, /\.\.\.\(creditNoteBeforePostHook \? \{ beforePost: creditNoteBeforePostHook \} : \{\}\)/)
  const check = readFileSync('lib/connectors/xero/scheme-posting-check.ts', 'utf8')
  assert.match(check, /return composeFinalBeforePost\(null, payload, 'create'\)/, 'the credit-note hook is the composed final check')
  const credit = readFileSync('lib/connectors/xero/credit-notes.ts', 'utf8')
  assert.match(credit, /withSalesInvoiceAuthorization\(opts\?\.beforePost, \(\) => xeroPost<XeroCreditNoteResponse>\('CreditNotes', creditNote, opts\)\)/)
  // No default tax type on a sales credit note: a missing one is refused before anything is sent.
  assert.doesNotMatch(credit.slice(credit.indexOf('export async function pushCreditNote'), credit.indexOf('export const XERO_PURCHASE_CREDIT_NOTE_TYPE')), /\|\| ?'NONE'|DEFAULT_TAX_TYPE/)
})
