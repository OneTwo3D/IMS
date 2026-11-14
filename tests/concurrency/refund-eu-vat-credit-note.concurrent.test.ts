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
 *   6. A WooCommerce refund whose tax is booked on rate 182 is recorded with its tax summed across all rate ids (the hold of the first N is tested in refund-eas182-hold.concurrent.test.ts); an unreadable 182 figure is parked and createRefund is never called.
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
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { fxRateToBase: '0.5', euVatRegimeBasis: { version: 1, outcome: 'SCHEME', scheme: { imsRateIds: [fx.rate.id], schemePostingTaxType: 'TAX131', intrinsicValue: '9999', fx: { rate: '0.5' } }, warnings: [] } } })
  await deps.db.setting.upsert({ where: { key: 'xero_eu_vat_ioss_account' }, create: { key: 'xero_eu_vat_ioss_account', value: '999' }, update: { value: '999' } })
  const { treatCreditNotePayload } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  const refund = await deps.db.salesOrderRefund.create({
    data: { orderId: fx.orderId, creditNoteNumber: `CN-FX-${randomUUID().slice(0, 6)}`, totalForeign: '100', totalBase: '100', totalsBasis: 'NET', source: 'MANUAL_UI', statedGrossForeign: '119', lines: { create: [{ salesOrderLineId: fx.goods, description: 'Widget', qty: 1, unitPriceForeign: '100', unitPriceBase: '100', totalForeign: '100', totalBase: '100', accountingTaxType: fx.rate.accountingTaxType, lineKind: 'sale', postingTaxType: 'TAX131', schemeTaxRateValue: '0.19' }] } },
    select: { id: true, lines: { select: { id: true } } },
  })
  const payload = { creditNoteNumber: 'CN-FX', currency: deps.baseCurrency, lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: fx.rate.accountingTaxType }], lineAmountsIncludeTax: false }
  const outcome = await treatCreditNotePayload({ refundId: refund.id, orderId: fx.orderId, payload, refundLineIds: refund.lines.map((l) => l.id), connector: 'xero', accounts: { ioss: '999', ddp: '232', fee: '232', rounding: '860' }, now: new Date(), enqueueHeldRow: async () => ({ queued: false, reason: "refused", connector: null }) })
  assert.equal(outcome.kind, 'treated')
  if (outcome.kind !== 'treated') return
  const vat = (outcome.payload.lines as Array<{ noTaxKind?: string; accountCode: string; unitAmount: number }>).find((l) => l.noTaxKind === 'eu-vat-recovery')
  assert.deepEqual([vat?.accountCode, vat?.unitAmount], ['821', 19], 'the VAT line is on the account stamped at the invoice, at the refund\'s own tax (the frozen gross)')
  assert.equal((outcome.regimePolicy as Record<string, string>).ioss, '999', 'the policy records the setting in force; the account is not taken from it')
})

test('[eu vat credit note] a scheme order with NO stamp: a REFUSED row is queued (never sent), the refund is not left as an accounting exception, and the operator settles the row by hand; an order outside the scheme is untouched', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const unstamped = await seed(deps, { stamp: null, schemeRate: true })
  const outside = await seed(deps, { stamp: null, schemeRate: false })
  t.after(async () => { await restore(); await cleanup(deps.db, unstamped); await cleanup(deps.db, outside) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const refused = await deps.createRefund(unstamped.orderId, [itemised(unstamped.goods, 'Widget', 100, 19)], 'unstamped', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(refused.success, true, refused.error)
  const row = await creditNoteRow(deps.db, unstamped.orderId)
  assert.ok(row?.payload, 'a row is queued so the operator has something to settle')
  const { refusedCreditNoteError } = await import('../../lib/domain/accounting/eu-vat-credit-note.ts')
  const error = refusedCreditNoteError(row.payload)
  assert.ok(error, 'the poster refuses it before anything else')
  assert.match(error, /NOTHING WAS SENT\. Credit note .* has no recorded VAT regime[\s\S]*This row is refused and is never sent\. Check Xero for credit note .* first[\s\S]*post the credit note by hand in Xero on the same VAT account the order's invoice used[\s\S]*record the outcome on this row with the settle action on \/sync/)
  assert.equal(refusedCreditNoteError({ creditNoteNumber: 'CN-OK', lines: [] }), null, 'any other credit note is not affected')
  // The refund is no longer an accounting exception: its obligation is discharged by the queued row.
  const refundRow = await deps.db.salesOrderRefund.findUnique({ where: { id: row.refundId }, select: { accountingRetryRequired: true } })
  assert.equal(refundRow?.accountingRetryRequired, false)
  // What the poster does with it: a refusal, so the row is FAILED at attempt 1 with that wording.
  const log = await deps.db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: row.refundId }, select: { id: true } })
  await deps.db.accountingSyncLog.update({ where: { id: log!.id }, data: { status: 'FAILED', attemptRevision: 1, errorMessage: error, retryCount: 1 } })
  // The operator checks Xero, posts by hand, and settles the row on /sync.
  await deps.db.user.upsert({ where: { id: 'ioss-cn-test' }, create: { id: 'ioss-cn-test', email: 'ioss-cn-test@example.invalid', name: 'ioss test', passwordHash: 'x' }, update: {} })
  t.after(async () => { await deps.db.activityLog.deleteMany({ where: { userId: 'ioss-cn-test' } }); await deps.db.user.deleteMany({ where: { id: 'ioss-cn-test' } }) })
  const { settleAccountingSyncRow } = await import('../../app/actions/accounting-settlement.ts')
  const settled = await settleAccountingSyncRow(log!.id, { observedStatus: 'FAILED', observedAttemptRevision: 1, outcome: 'POSTED', externalTransactionId: 'CN-BY-HAND-1' })
  assert.equal(settled.success, true, JSON.stringify(settled))
  const after = await deps.db.accountingSyncLog.findUnique({ where: { id: log!.id }, select: { status: true, externalTransactionId: true } })
  assert.deepEqual([after?.status, after?.externalTransactionId], ['SYNCED', 'CN-BY-HAND-1'])
  assert.equal((await deps.db.salesOrderRefund.findUnique({ where: { id: row.refundId }, select: { accountingRetryRequired: true } }))?.accountingRetryRequired, false)
  // Not a scheme order, and never stamped: left exactly as before.
  const ok = await deps.createRefund(outside.orderId, [itemised(outside.goods, 'Widget', 100, 19)], 'plain', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(ok.success, true, ok.error)
  const plain = await creditNoteRow(deps.db, outside.orderId)
  assert.ok(plain?.payload)
  assert.equal('_euVatTreatment' in plain.payload, false)
  assert.equal(refusedCreditNoteError(plain.payload), null)
})

test('[eu vat credit note] a hand-recorded parked refund (Sync Exceptions) carries the WooCommerce gross into the snapshot, and the credit note totals it exactly: a 0.025 net line refunded as 0.03 is 0.03, never 0.04', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // A line allocation whose net is 0.025 (0.02975 with its 19% tax): rounded per line it is 0.03, and the tax on top would make 0.04 for a 0.03 refund.
  const gross = 0.03
  for (const [stated, expected] of [[gross, 0.03], [null, 0.03]] as const) {
    const id = wooRefundId()
    const result = await deps.createRefund(fx.orderId, [{ lineId: fx.goods, productId: null, description: 'Widget', qty: 0, totalBase: 0.025, lineKind: 'sale' }], 'tiny', undefined, { internalBypassToken: deps.bypass, externalRefundId: id, ...(stated === null ? {} : { statedGrossForeign: stated }) })
    assert.equal(result.success, true, result.error)
    const refund = await deps.db.salesOrderRefund.findFirst({ where: { externalRefundId: id }, select: { id: true } })
    const queued = await deps.db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: refund!.id }, select: { payload: true } })
    const lines = (queued!.payload as { lines: Array<{ unitAmount: number; quantity: number }> }).lines
    assert.equal(lines.reduce((sum, l) => sum + Math.round(l.unitAmount * l.quantity * 100) / 100, 0).toFixed(2), expected.toFixed(2), `stated ${String(stated)}`)
  }
})

test('[eu vat credit note] the credit note reverses what the INVOICE used: a rate whose scheme type moved to another 0% type after invoicing does not change it; a stamp that never recorded the type is a refused row to post by hand', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const moved = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const unknown = await seed(deps, { stamp: 'IOSS', schemeRate: true, noType: true })
  t.after(async () => { await restore(); await cleanup(deps.db, moved); await cleanup(deps.db, unknown) })
  await seedXeroList(deps.db, { TAX131: '0.000000', TAX999: '0.000000' })
  await deps.db.taxRate.update({ where: { id: moved.rate.id }, data: { schemePostingTaxType: 'TAX999' } })
  await deps.db.taxRate.update({ where: { id: unknown.rate.id }, data: { schemePostingTaxType: 'TAX999' } })
  const ok = await deps.createRefund(moved.orderId, [itemised(moved.goods, 'Widget', 100, 19)], 'moved', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(ok.success, true, ok.error)
  const row = await creditNoteRow(deps.db, moved.orderId)
  const lines = row!.payload!.lines as Array<{ description: string; taxType: string }>
  assert.equal(lines.find((l) => l.description === 'Widget')?.taxType, 'TAX131', 'the type the invoice was posted on, not the rate\'s mapping now')
  assert.equal((row!.payload!._euVatTreatment as { schemePostingTaxType: string }).schemePostingTaxType, 'TAX131')
  const refused = await deps.createRefund(unknown.orderId, [itemised(unknown.goods, 'Widget', 100, 19)], 'unknown', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(refused.success, true, refused.error)
  const unknownRow = await creditNoteRow(deps.db, unknown.orderId)
  const { refusedCreditNoteError } = await import('../../lib/domain/accounting/eu-vat-credit-note.ts')
  const error = refusedCreditNoteError(unknownRow!.payload!)
  assert.match(error ?? '', /did not record which zero-rated Xero tax type the order's invoice was posted on[\s\S]*Check Xero for credit note .* first[\s\S]*same tax type that invoice used[\s\S]*settle action on \/sync/)
  assert.equal((await deps.db.salesOrderRefund.findUnique({ where: { id: unknownRow!.refundId }, select: { accountingRetryRequired: true } }))?.accountingRetryRequired, false)
})

test('[eu vat credit note] unstamped orders: an IMS-queued treated invoice makes it a scheme order even after the rate mapping is removed; with no such invoice (pre-cut-over) the current mapping decides, an accepted limit', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const withInvoice = await seed(deps, { stamp: null, schemeRate: false })
  const preCutover = await seed(deps, { stamp: null, schemeRate: false })
  t.after(async () => { await restore(); await cleanup(deps.db, withInvoice); await cleanup(deps.db, preCutover) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // The scheme mapping has been REMOVED from the rate (schemeRate: false). IMS had queued a treated invoice for the first order.
  await deps.db.accountingSyncLog.create({ data: { connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: withInvoice.orderId, payload: { invoiceNumber: 'INV-X', lines: [], _euVatTreatment: { applied: true, route: 'scheme' } }, attemptRevision: 1 } })
  const a = await deps.createRefund(withInvoice.orderId, [itemised(withInvoice.goods, 'Widget', 100, 19)], 'a', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(a.success, true, a.error)
  const rowA = await creditNoteRow(deps.db, withInvoice.orderId)
  const { refusedCreditNoteError } = await import('../../lib/domain/accounting/eu-vat-credit-note.ts')
  assert.match(refusedCreditNoteError(rowA!.payload!) ?? '', /no recorded VAT regime/, 'still refused, to be posted by hand')
  const b = await deps.createRefund(preCutover.orderId, [itemised(preCutover.goods, 'Widget', 100, 19)], 'b', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(b.success, true, b.error)
  const rowB = await creditNoteRow(deps.db, preCutover.orderId)
  assert.equal(refusedCreditNoteError(rowB!.payload!), null, 'documented limit: no stamp, no IMS invoice, no scheme mapping now: an ordinary credit note')
})

test('[eu vat credit note] a refused hand-post row carries NO lines or tax codes: a tax re-key that retired the line\'s code before the enqueue cannot stop it from existing; it fails at the poster, settles, and the refund is not flagged', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: null, schemeRate: true })
  const replacement = await deps.db.taxRate.create({ data: { name: `DE CN REPL ${randomUUID().slice(0, 6)}`, rate: '0.19', usedFor: 'SALES', accountingTaxType: `DE_NEW_${randomUUID().slice(0, 6)}`, countryCode: 'DE', taxCategory: 'STANDARD', active: true } })
  t.after(async () => { await restore(); await cleanup(deps.db, fx); await deps.db.taxRate.deleteMany({ where: { id: replacement.id } }) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  // The re-key: the order's rate is retired in favour of the replacement (a different Xero code) before the credit note is queued.
  await deps.db.taxRate.update({ where: { id: fx.rate.id }, data: { replacedById: replacement.id, active: false } })
  const result = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', 100, 19)], 'rekeyed', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), statedGrossForeign: 119 })
  assert.equal(result.success, true, result.error)
  const row = await creditNoteRow(deps.db, fx.orderId)
  assert.ok(row?.payload, 'the refused row exists: the retired-code guard had nothing to reject')
  const payload = row.payload
  assert.deepEqual(payload.lines, [])
  assert.doesNotMatch(JSON.stringify(payload), /taxType|taxRateId|DE_CHARGED/)
  const marker = payload._euVatCreditNoteRefused as { reason: string; refundId: string; orderId: string; netAmount: string }
  assert.deepEqual([marker.refundId, marker.orderId, marker.netAmount], [row.refundId, fx.orderId, '100'])
  const { refusedCreditNoteError } = await import('../../lib/domain/accounting/eu-vat-credit-note.ts')
  assert.match(refusedCreditNoteError(payload) ?? '', /no recorded VAT regime|treated invoice|NOTHING WAS SENT/)
  assert.equal((await deps.db.salesOrderRefund.findUnique({ where: { id: row.refundId }, select: { accountingRetryRequired: true } }))?.accountingRetryRequired, false)
  const log = await deps.db.accountingSyncLog.findFirst({ where: { type: 'CREDIT_NOTE', referenceId: row.refundId }, select: { id: true } })
  await deps.db.accountingSyncLog.update({ where: { id: log!.id }, data: { status: 'FAILED', attemptRevision: 1, errorMessage: refusedCreditNoteError(payload), retryCount: 1 } })
  await deps.db.user.upsert({ where: { id: 'ioss-cn-test' }, create: { id: 'ioss-cn-test', email: 'ioss-cn-test@example.invalid', name: 'ioss test', passwordHash: 'x' }, update: {} })
  t.after(async () => { await deps.db.activityLog.deleteMany({ where: { userId: 'ioss-cn-test' } }); await deps.db.user.deleteMany({ where: { id: 'ioss-cn-test' } }) })
  const { settleAccountingSyncRow } = await import('../../app/actions/accounting-settlement.ts')
  const settled = await settleAccountingSyncRow(log!.id, { observedStatus: 'FAILED', observedAttemptRevision: 1, outcome: 'POSTED', externalTransactionId: 'CN-BY-HAND-2' })
  assert.equal(settled.success, true, JSON.stringify(settled))
  assert.equal((await deps.db.accountingSyncLog.findUnique({ where: { id: log!.id }, select: { status: true } }))?.status, 'SYNCED')
})

test('[eu vat credit note] the refused-row payload is a dedicated record, and only a payload with the marker is ever treated as refused', async () => {
  const { refusedCreditNotePayload, refusedCreditNoteError } = await import('../../lib/domain/accounting/eu-vat-credit-note.ts')
  const built = refusedCreditNotePayload({ creditNoteNumber: 'CN-1', currency: 'EUR', reference: 'R', date: '2026-11-13', refundId: 'rf', orderId: 'so', reason: 'why', lines: [{ quantity: 2, unitAmount: 10.5, taxType: 'X', accountCode: '200' }] })
  assert.deepEqual(Object.keys(built).sort(), ['_euVatCreditNoteRefused', 'creditNoteNumber', 'currency', 'date', 'lines', 'reference'])
  assert.deepEqual(built.lines, [])
  assert.equal((built._euVatCreditNoteRefused as { netAmount: string }).netAmount, '21')
  assert.equal(refusedCreditNoteError(built), 'why')
  // A postable payload (lines, tax types, no marker) is never refused by this route, so the exemption cannot swallow a real credit note.
  assert.equal(refusedCreditNoteError({ creditNoteNumber: 'CN-2', lines: [{ description: 'W', quantity: 1, unitAmount: 1, accountCode: '200', taxType: 'X' }] }), null)
})

test('[eu vat credit note] a MANUAL refund is priced once, at creation: the rate changing before the accounting retry does not change the credit note; a refund with no frozen basis is a refused hand-post row', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  t.after(async () => { await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  const result = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', 100, 19)], 'manual', undefined, { internalBypassToken: deps.bypass })
  assert.equal(result.success, true, result.error)
  const row = await creditNoteRow(deps.db, fx.orderId)
  const first = row!.payload!.lines as Array<{ noTaxKind?: string; unitAmount: number }>
  assert.equal(first.find((l) => l.noTaxKind === 'eu-vat-recovery')?.unitAmount, 19)
  const frozen = await deps.db.salesOrderRefund.findUnique({ where: { id: row!.refundId }, select: { statedGrossForeign: true, source: true, lines: { select: { id: true, schemeTaxRateValue: true } } } })
  assert.equal(frozen?.source, 'MANUAL_UI')
  assert.equal(frozen?.statedGrossForeign?.toString(), '119')
  assert.equal(frozen?.lines[0]?.schemeTaxRateValue?.toString(), '0.19')
  // The rate changes to 20% before the accounting retry rebuilds the credit note.
  await deps.db.taxRate.update({ where: { id: fx.rate.id }, data: { rate: '0.2' } })
  const { treatCreditNotePayload } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  const rebuilt = { creditNoteNumber: 'CN-RETRY', currency: deps.baseCurrency, lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: fx.rate.accountingTaxType }], lineAmountsIncludeTax: false }
  const outcome = await treatCreditNotePayload({ refundId: row!.refundId, orderId: fx.orderId, payload: rebuilt, refundLineIds: [frozen!.lines[0]!.id], connector: 'xero', accounts: { ioss: '821', ddp: '232', fee: '232', rounding: '860' }, now: new Date(), enqueueHeldRow: async () => ({ queued: false, reason: "refused", connector: null }) })
  assert.equal(outcome.kind, 'treated')
  if (outcome.kind !== 'treated') return
  const lines = outcome.payload.lines as Array<{ noTaxKind?: string; unitAmount: number; quantity: number }>
  assert.equal(lines.find((l) => l.noTaxKind === 'eu-vat-recovery')?.unitAmount, 19, 'the original 19%, not 20%')
  assert.equal(lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0).toFixed(2), '119.00')
  // A refund created before the basis was frozen: refused, to be posted by hand.
  await deps.db.salesOrderRefundLine.update({ where: { id: frozen!.lines[0]!.id }, data: { schemeTaxRateValue: null } })
  const old = await treatCreditNotePayload({ refundId: row!.refundId, orderId: fx.orderId, payload: rebuilt, refundLineIds: [frozen!.lines[0]!.id], connector: 'xero', accounts: { ioss: '821', ddp: '232', fee: '232', rounding: '860' }, now: new Date(), enqueueHeldRow: async () => ({ queued: false, reason: "refused", connector: null }) })
  assert.equal(old.kind, 'refused')
  assert.equal(old.kind === 'refused' && old.code, 'hand_post')
  assert.match(old.kind === 'refused' ? old.reason : '', /did not record the VAT rate and amount it was priced at[\s\S]*settle action on \/sync/)
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

test('[eu vat credit note] a WooCommerce refund whose tax is booked on rate 182 is recorded with its tax summed across ALL rate ids (an unreadable 182 figure is still parked); the switch off, or a non-scheme order, is not touched', { skip }, async (t) => {
  const deps = await loadDeps()
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const outside = await seed(deps, { stamp: 'none', schemeRate: false })
  const externalOrderId = 5_000_000 + Math.floor(Math.random() * 1_000_000)
  const externalOutside = externalOrderId + 1
  await deps.db.shoppingOrderLink.create({ data: { orderId: fx.orderId, connector: 'woocommerce', externalOrderId: String(externalOrderId) } })
  await deps.db.shoppingOrderLink.create({ data: { orderId: outside.orderId, connector: 'woocommerce', externalOrderId: String(externalOutside) } })
  t.after(async () => { await cleanup(deps.db, fx); await cleanup(deps.db, outside) })
  const { syncWcRefund } = await import('../../lib/connectors/woocommerce/sync/refund-sync.ts')
  const refund = (id: number, rateId: number, total = '-19.00') => ({
    id, parent_id: externalOrderId, date_created: '2026-11-02T10:00:00', date_created_gmt: '2026-11-02T10:00:00', amount: '119.00', reason: 'r', refunded_by: 1, refunded_payment: false, meta_data: [],
    line_items: [{ id: 91, name: 'Widget', product_id: 1, variation_id: 0, quantity: 0, tax_class: '', subtotal: '-100.00', subtotal_tax: '-19.00', total: '-100.00', total_tax: '-19.00', sku: 's', meta_data: [], refund_total: -100, taxes: [{ id: rateId, total }, { id: 244, total: '0.00' }] }],
  })
  const calls: Array<Record<string, unknown>> = []
  const stub = async (...args: unknown[]) => { calls.push((args[4] ?? {}) as Record<string, unknown>); return { success: true } }
  // Switch OFF: the refund is read as it always was (the stub is reached, and no 182 figure is handed on).
  let restore = await configure(deps.db, false)
  await syncWcRefund(externalOrderId, refund(wooRefundId(), 182) as never, { createRefund: stub as never })
  assert.equal(calls.length, 1, 'switch off: not refused')
  assert.equal('eas182StatedTaxForeign' in calls[0]!, false, 'switch off: nothing handed on')
  await restore()
  // Switch ON, scheme order, tax on 182: recorded, the tax summed across all rate ids is handed to the writer, nothing is parked.
  restore = await configure(deps.db, true)
  t.after(async () => { await restore() })
  calls.length = 0
  const id = wooRefundId()
  const outcome = await syncWcRefund(externalOrderId, refund(id, 182) as never, { createRefund: stub as never })
  assert.notEqual(outcome.outcome, 'quarantined-refusal')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.eas182StatedTaxForeign, 19)
  assert.equal(calls[0]!.statedGrossForeign, 119)
  assert.equal(await deps.db.shoppingSyncLog.count({ where: { externalId: String(id), entityId: fx.orderId, status: 'QUARANTINED' } }), 0, 'not parked as quarantined')
  // A 182 figure that cannot be read: parked QUARANTINED with the operator wording, createRefund not called.
  calls.length = 0
  const unreadable = wooRefundId()
  const refused = await syncWcRefund(externalOrderId, refund(unreadable, 182, 'abc') as never, { createRefund: stub as never })
  assert.equal(refused.outcome, 'quarantined-refusal')
  assert.equal(calls.length, 0)
  assert.match(refused.error ?? '', new RegExp(`WooCommerce refund ${unreadable} was NOT recorded: its VAT \\(1\\) is booked on WooCommerce tax rate 182`))
  const park = await deps.db.shoppingSyncLog.findFirst({ where: { externalId: String(unreadable), entityId: fx.orderId }, select: { status: true, errorMessage: true } })
  assert.equal(park?.status, 'QUARANTINED')
  assert.match(park?.errorMessage ?? '', new RegExp(`WooCommerce refund ${unreadable} was NOT recorded`), 'the parked row carries the operator wording')
  const activity = await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_sync_eas_rate_182_refused' }, select: { level: true, description: true } })
  assert.equal(activity?.level, 'WARNING')
  assert.match(activity?.description ?? '', /rate 182/)
  // The same refund on another rate, switch on, scheme order: recorded as before, nothing extra handed on.
  calls.length = 0
  await syncWcRefund(externalOrderId, refund(wooRefundId(), 244) as never, { createRefund: stub as never })
  assert.equal(calls.length, 1, 'any other rate is recorded as before')
  assert.equal('eas182StatedTaxForeign' in calls[0]!, false)
  // 182 on an order outside the scheme: not touched.
  calls.length = 0
  await syncWcRefund(externalOutside, refund(wooRefundId(), 182) as never, { createRefund: stub as never })
  assert.equal(calls.length, 1, 'a non-scheme order is not touched')
  assert.equal('eas182StatedTaxForeign' in calls[0]!, false)
})

test('[eu vat credit note] every route to a credit note reaches the one builder, and the poster wires both checks', () => {
  const sales = readFileSync('app/actions/sales.ts', 'utf8')
  // The hand-off builds the payload once and treats it before the enqueue.
  assert.match(sales, /const builtCreditNotePayload[\s\S]*await treatCreditNotePayload\(\{[\s\S]*creditNoteTreatment\.kind === 'treated'\s*\? creditNoteTreatment\.payload[\s\S]*: builtCreditNotePayload/)
  // The refund (storefront or operator), the payment poller's whole-order reversal (a chargeback, which calls createRefund) and an accounting retry all end in it.
  assert.equal((sales.match(/await queueRefundAccountingActions\(\{/g) ?? []).length, 2, 'createRefund and retryRefundAccounting')
  assert.match(sales, /export async function raiseChargebackForReversedOrder[\s\S]*await createRefund\(orderId, lines, 'Payment reversed \(chargeback\)'/)
  // The Sync Exceptions hand-recording path passes the parked WooCommerce gross, so the credit note totals it.
  assert.match(readFileSync('app/actions/sync-exceptions.ts', 'utf8'), /externalRefundId,\n[^\n]*\n\s+statedGrossForeign: parkedGross\.toNumber\(\),/)
  const processor = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  assert.match(readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8'), /case 'CREDIT_NOTE': \{\n[^\n]*\n\s+const refusedCreditNoteError = refusedCreditNoteErrorOf\(payload as Record<string, unknown>\)\n\s+if \(refusedCreditNoteError !== null\) return \{ success: false, error: refusedCreditNoteError \}/, 'the refused row is refused before anything else')
  assert.match(processor, /if \(creditNoteSchemeRefusal\) return \{ success: false, error: creditNoteSchemeRefusal \}/, 'the early refusal is returned')
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

// ------------------------------------------------------------------------------------------------------------------------------------------
// MUTATION-DRIVEN CASES: each pins one decision of the treatment, the snapshot or the refund-time freeze that no case above reaches.
// ------------------------------------------------------------------------------------------------------------------------------------------
type DirectLine = { orderLineId?: string | null; net: string; qty?: number; rate?: string | null; type?: string | null }
const ACCOUNTS = { ioss: '821', ddp: '232', fee: '232', rounding: '860' }

/** A refund and its lines written straight to the database (as the snapshot would have left them), and the payload the hand-off would build for it. */
async function directRefund(deps: Deps, fx: Fixture, opts: { lines: DirectLine[]; stated?: string | null; source?: 'MANUAL_UI' | 'CHARGEBACK_POLLER'; number?: string | null }) {
  const number = opts.number === undefined ? `CN-D-${randomUUID().slice(0, 6)}` : opts.number
  const refund = await deps.db.salesOrderRefund.create({
    data: {
      orderId: fx.orderId, creditNoteNumber: number, totalForeign: '1', totalBase: '1', totalsBasis: 'NET', source: opts.source ?? 'MANUAL_UI', statedGrossForeign: opts.stated ?? null,
      lines: { create: opts.lines.map((l) => ({ salesOrderLineId: l.orderLineId === undefined ? fx.goods : l.orderLineId, description: 'Widget', qty: l.qty ?? 1, unitPriceForeign: l.net, unitPriceBase: l.net, totalForeign: l.net, totalBase: l.net, accountingTaxType: fx.rate.accountingTaxType, lineKind: 'sale', postingTaxType: l.type === undefined ? 'TAX131' : l.type, schemeTaxRateValue: l.rate === undefined ? '0.19' : l.rate })) },
    },
    select: { id: true, lines: { select: { id: true }, orderBy: { id: 'asc' } } },
  })
  const rows = await deps.db.salesOrderRefundLine.findMany({ where: { refundId: refund.id }, select: { id: true }, orderBy: { id: 'asc' } })
  const payload = (over: Record<string, unknown> = {}) => ({ creditNoteNumber: number ?? 'CN-PAYLOAD', currency: deps.baseCurrency, lines: opts.lines.map((l) => ({ description: 'Widget', quantity: l.qty ?? 1, unitAmount: Number(l.net) / (l.qty ?? 1), accountCode: '200', taxType: fx.rate.accountingTaxType })), lineAmountsIncludeTax: false, ...over })
  return { refundId: refund.id, lineIds: rows.map((r) => r.id), number, payload }
}
async function treat(deps: Deps, fx: Fixture, refund: Awaited<ReturnType<typeof directRefund>>, over: { payload?: Record<string, unknown>; lineIds?: readonly string[]; connector?: string | null; refundId?: string } = {}) {
  const { treatCreditNotePayload } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  return treatCreditNotePayload({ refundId: over.refundId ?? refund.refundId, orderId: fx.orderId, payload: over.payload ?? refund.payload(), refundLineIds: over.lineIds ?? refund.lineIds, connector: over.connector === undefined ? 'xero' : over.connector, accounts: ACCOUNTS, now: new Date(), enqueueHeldRow: async () => ({ queued: false, reason: "refused", connector: null }) })
}
const refusal = (outcome: Awaited<ReturnType<typeof treat>>) => (outcome.kind === 'refused' ? outcome : null)

async function prepared(t: test.TestContext, opts: { stamp: 'IOSS' | 'none' | null; schemeRate: boolean }) {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, opts)
  t.after(async () => { await deps.db.setting.deleteMany({ where: { key: { in: ['eu_vat_regime_mode', 'eu_vat_gift_card_flag_cut_in'] } } }); await restore(); await cleanup(deps.db, fx) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  return { deps, fx }
}

test('[eu vat credit note] the treatment asks first: only Xero with the Sales Invoices switch on; a refund that does not exist is refused, and the number named is the refund\'s own', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const refund = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '119' })
  // A refund with no persisted scheme snapshot is skipped; one recorded under the scheme treatment is never skipped (a persisted decision outranks the switch and the connector).
  const bareRefund = await directRefund(deps, fx, { lines: [{ net: '100', type: null, rate: null }], stated: null })
  for (const connector of ['quickbooks', null]) {
    assert.deepEqual(await treat(deps, fx, bareRefund, { connector }), { kind: 'skipped', why: 'switch_off' })
    assert.equal(refusal(await treat(deps, fx, refund, { connector }))?.code, 'hand_post')
  }
  assert.equal((await treat(deps, fx, refund)).kind, 'treated')
  const missing = refusal(await treat(deps, fx, refund, { refundId: randomUUID() }))
  assert.match(missing?.reason ?? '', /could not be found/)
  // A line that is not the refund's is refused, not skipped over.
  assert.match(refusal(await treat(deps, fx, refund, { lineIds: [randomUUID()] }))?.reason ?? '', /refund line could not be found/)
  // The number on a refusal is the refund's own, else the payload's.
  const unfrozen = await directRefund(deps, fx, { lines: [{ net: '100', rate: null }], stated: null, number: `CN-OWN-${randomUUID().slice(0, 4)}` })
  assert.match(refusal(await treat(deps, fx, unfrozen))?.reason ?? '', new RegExp(`Credit note ${unfrozen.number}`))
  const unnumbered = await directRefund(deps, fx, { lines: [{ net: '100', rate: null }], stated: null, number: null })
  assert.match(refusal(await treat(deps, fx, unnumbered, { payload: unnumbered.payload({ creditNoteNumber: 'CN-FROM-PAYLOAD' }) }))?.reason ?? '', /Credit note CN-FROM-PAYLOAD/)
  // Lines and ids that do not line up are refused.
  assert.match(refusal(await treat(deps, fx, refund, { lineIds: [refund.lineIds[0]!, refund.lineIds[0]!] }))?.reason ?? '', /do not line up/)
})

test('[eu vat credit note] an unstamped order: the three classifications (a) IMS-queued treated invoice, (b) a stamp outside the scheme, (c) the rates\' current scheme mapping', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: null, schemeRate: false })
  const refund = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '119' })
  // The same refund with no persisted scheme snapshot: only that kind may be skipped.
  const bare = await directRefund(deps, fx, { lines: [{ net: '100', type: null, rate: null }], stated: null })
  const rateOf = (data: Record<string, unknown>) => deps.db.taxRate.update({ where: { id: fx.rate.id }, data })
  // (c) no evidence and no scheme mapping: not a scheme order.
  assert.deepEqual(await treat(deps, fx, bare), { kind: 'skipped', why: 'not_scheme' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post', 'a persisted snapshot is never skipped')
  // (c) the category alone, or the posting type alone, makes it a scheme order; case and padding do not matter; a blank posting type is nothing.
  await rateOf({ reportingCategory: 'IOSS' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post')
  await rateOf({ reportingCategory: ' voec ' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post')
  await rateOf({ reportingCategory: null, schemePostingTaxType: 'TAX131' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post')
  await rateOf({ schemePostingTaxType: '  ' })
  assert.deepEqual(await treat(deps, fx, bare), { kind: 'skipped', why: 'not_scheme' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post', 'a persisted snapshot is never skipped')
  await rateOf({ schemePostingTaxType: null, reportingCategory: 'STANDARD' })
  assert.deepEqual(await treat(deps, fx, bare), { kind: 'skipped', why: 'not_scheme' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post', 'a persisted snapshot is never skipped')
  // (a) an invoice IMS queued with the treatment marker makes it a scheme order, whichever of the two invoice types it was; one without the marker does not.
  const log = (type: 'SALES_INVOICE' | 'SALES_INVOICE_UPDATE', marker: unknown, referenceId = fx.orderId) => deps.db.accountingSyncLog.create({ data: { connector: 'xero', type, status: 'SYNCED', referenceType: 'SalesOrder', referenceId, payload: { invoiceNumber: 'INV-X', lines: [], _euVatTreatment: marker } as never, attemptRevision: 1 } })
  await log('SALES_INVOICE', { applied: false })
  await log('SALES_INVOICE', { applied: true }, randomUUID())
  assert.deepEqual(await treat(deps, fx, bare), { kind: 'skipped', why: 'not_scheme' })
  assert.equal(refusal(await treat(deps, fx, refund))?.code, 'hand_post', 'a persisted snapshot is never skipped')
  await log('SALES_INVOICE_UPDATE', { applied: true })
  const viaUpdate = refusal(await treat(deps, fx, refund))
  assert.equal(viaUpdate?.code, 'hand_post')
  assert.match(viaUpdate?.reason ?? '', /no recorded VAT regime/)
  await deps.db.accountingSyncLog.deleteMany({ where: { referenceId: { in: [fx.orderId] } } })
})

test('[eu vat credit note] (b) a stamp outside the scheme is not a scheme order', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'none', schemeRate: false })
  const r0 = await directRefund(deps, fx, { lines: [{ net: '100', type: null, rate: null }], stated: null })
  assert.deepEqual(await treat(deps, fx, r0), { kind: 'skipped', why: 'not_scheme' })
  // A refund carrying the scheme snapshot on an order stamped outside the scheme cannot be treated: refused, never skipped.
  const persisted = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '119' })
  assert.equal(refusal(await treat(deps, fx, persisted))?.code, 'hand_post')
})

test('[eu vat credit note] a stamped order with a blank account is refused; a padded account is trimmed', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const refund = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '119' })
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { euVatLineAccount: '   ' } })
  assert.match(refusal(await treat(deps, fx, refund))?.reason ?? '', /names no VAT account/)
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { euVatLineAccount: ' 821 ' } })
  const ok = await treat(deps, fx, refund)
  assert.equal(ok.kind, 'treated')
  if (ok.kind === 'treated') assert.equal((ok.payload.lines as Array<{ noTaxKind?: string; accountCode: string }>).find((l) => l.noTaxKind === 'eu-vat-recovery')?.accountCode, '821')
})

test('[eu vat credit note] the policy record: an unreadable mode refuses, the cut-in and the accounts and the mode are recorded as read, and the marker carries the figures', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const refund = await directRefund(deps, fx, { lines: [{ net: '100' }, { net: '20', orderLineId: fx.feeA }], stated: '142.80' })
  await deps.db.setting.upsert({ where: { key: 'eu_vat_regime_mode' }, create: { key: 'eu_vat_regime_mode', value: 'garbage' }, update: { value: 'garbage' } })
  assert.match(refusal(await treat(deps, fx, refund))?.reason ?? '', /neither adopt_plugin nor decide/)
  await deps.db.setting.upsert({ where: { key: 'eu_vat_regime_mode' }, create: { key: 'eu_vat_regime_mode', value: 'decide' }, update: { value: 'decide' } })
  await deps.db.setting.upsert({ where: { key: 'eu_vat_gift_card_flag_cut_in' }, create: { key: 'eu_vat_gift_card_flag_cut_in', value: '2026-12-01' }, update: { value: '2026-12-01' } })
  const outcome = await treat(deps, fx, refund)
  assert.equal(outcome.kind, 'treated')
  if (outcome.kind !== 'treated') return
  assert.deepEqual({ ...outcome.regimePolicy, cutIn: outcome.regimePolicy.cutIn!.slice(0, 10) }, { mode: 'decide', cutIn: '2026-12-01', ioss: '821', ddp: '232', fee: '232', rounding: '860', baseCurrency: deps.baseCurrency })
  const marker = outcome.payload._euVatTreatment as Record<string, unknown>
  assert.deepEqual({ ...marker, regimePolicy: undefined }, { applied: true, document: 'credit-note', route: 'scheme', regime: 'IOSS', schemePostingTaxType: 'TAX131', vatAccount: '821', vatAmount: '22.8', refundTotal: '142.8', feesRecoded: 1, regimePolicy: undefined })
  assert.deepEqual(marker.regimePolicy, outcome.regimePolicy)
  // The fee account comes from the accounts read once by the caller.
  const fee = (outcome.payload.lines as Array<{ noTaxKind?: string; accountCode: string }>).find((l) => l.noTaxKind === 'fee-no-tax')
  assert.equal(fee?.accountCode, '232')
})

test('[eu vat credit note] the frozen basis decides every figure: a missing gross or rate is a hand-post row, each line is priced at its own frozen rate and quantity, and the stated gross is the total', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const taxOf = (o: Awaited<ReturnType<typeof treat>>) => o.kind === 'treated' ? (o.payload.lines as Array<{ noTaxKind?: string; unitAmount: number }>).find((l) => l.noTaxKind === 'eu-vat-recovery')?.unitAmount : undefined
  const totalOf = (o: Awaited<ReturnType<typeof treat>>) => o.kind === 'treated' ? (o.payload.lines as Array<{ unitAmount: number; quantity: number }>).reduce((s, l) => s + l.unitAmount * l.quantity, 0).toFixed(2) : undefined
  // No frozen gross: refused as a hand-post row, with the frozen-basis wording.
  const noGross = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: null })
  const r1 = refusal(await treat(deps, fx, noGross))
  assert.equal(r1?.code, 'hand_post')
  assert.match(r1?.reason ?? '', /did not record the VAT rate and amount it was priced at/)
  // Two lines, two frozen rates (19% and 7%): each line is priced at its own.
  const mixed = await directRefund(deps, fx, { lines: [{ net: '100', rate: '0.19' }, { net: '100', rate: '0.07', orderLineId: fx.feeA }], stated: '226' })
  const mixedOutcome = await treat(deps, fx, mixed)
  assert.equal(taxOf(mixedOutcome), 26)
  assert.equal(totalOf(mixedOutcome), '226.00')
  // Quantity multiplies: 2 x 50 at 19%.
  const qty = await directRefund(deps, fx, { lines: [{ net: '100', qty: 2 }], stated: '119' })
  assert.equal(taxOf(await treat(deps, fx, qty)), 19)
  // The stated gross is the total, within the tolerance of the lines' own tax (2 minor units for one line); beyond it is refused.
  const cents = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '119.02' })
  const centsOutcome = await treat(deps, fx, cents)
  assert.equal(taxOf(centsOutcome), 19.02)
  assert.equal(totalOf(centsOutcome), '119.02')
  const marker = centsOutcome.kind === 'treated' ? (centsOutcome.payload._euVatTreatment as Record<string, unknown>) : {}
  assert.equal(marker.vatAmount, '19.02')
  assert.equal(marker.refundTotal, '119.02')
  const far = await directRefund(deps, fx, { lines: [{ net: '100' }], stated: '120' })
  assert.match(refusal(await treat(deps, fx, far))?.reason ?? '', /more than rounding explains/)
  const negative = await directRefund(deps, fx, { lines: [{ net: '100', rate: '0' }], stated: '99.99' })
  assert.match(refusal(await treat(deps, fx, negative))?.reason ?? '', /less than the/)
  // A line amount that cannot be read, and a payload the builder will not treat (tax-inclusive), are refused.
  assert.match(refusal(await treat(deps, fx, cents, { payload: cents.payload({ lines: [{ description: 'W', quantity: 1, unitAmount: Number.NaN, accountCode: '200', taxType: 'X' }] }) }))?.reason ?? '', /cannot be read/)
  assert.match(refusal(await treat(deps, fx, cents, { payload: cents.payload({ lineAmountsIncludeTax: true }) }))?.reason ?? '', /tax-inclusive/)
  // A blank posting type (even only spaces) is the invoiced-type hand-post row.
  const padded = await directRefund(deps, fx, { lines: [{ net: '100', type: '  ' }], stated: '119' })
  const r2 = refusal(await treat(deps, fx, padded))
  assert.equal(r2?.code, 'hand_post')
  assert.match(r2?.reason ?? '', /did not record which zero-rated/)
  // The posting type is proved against the stored Xero list: a taxable one refuses; one the list does not hold refuses.
  await seedXeroList(deps.db, { TAX131: '20.000000' })
  assert.match(refusal(await treat(deps, fx, cents))?.reason ?? '', /not zero-rated/)
  await seedXeroList(deps.db, { TAX999: '0.000000' })
  assert.match(refusal(await treat(deps, fx, cents))?.reason ?? '', /not in the stored Xero tax-rate list/)
})

test('[eu vat credit note] a whole-order reversal (the chargeback) needs no frozen basis and reverses the order\'s whole VAT', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const refund = await directRefund(deps, fx, { lines: [{ net: '134', rate: null }], stated: null, source: 'CHARGEBACK_POLLER' })
  const outcome = await treat(deps, fx, refund)
  assert.equal(outcome.kind, 'treated')
  if (outcome.kind !== 'treated') return
  const lines = outcome.payload.lines as Array<{ noTaxKind?: string; unitAmount: number }>
  assert.equal(lines.find((l) => l.noTaxKind === 'eu-vat-recovery')?.unitAmount, 25.46)
  assert.equal((outcome.payload._euVatTreatment as Record<string, unknown>).refundTotal, '159.46')
})

test('[eu vat credit note] a refused credit note leaves its operator record', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const { recordCreditNoteTreatmentRefusal } = await import('../../lib/domain/sales/eu-vat-credit-note-treatment.ts')
  await recordCreditNoteTreatmentRefusal({ orderId: fx.orderId, refundId: 'r-1', reason: 'because' })
  const row = await deps.db.activityLog.findFirst({ where: { entityId: fx.orderId, action: 'refund_credit_note_eu_vat_refused' }, select: { description: true, level: true } })
  assert.equal(row?.description, 'because')
  assert.equal(row?.level, 'WARNING')
})

test('[eu vat credit note] the posting snapshot: read from the stamp only, trimmed, NULL when none was kept, nothing for an unstamped, unknown or non-scheme order', { skip }, async (t) => {
  const { deps, fx } = await prepared(t, { stamp: 'IOSS', schemeRate: true })
  const { resolveSchemePostingSnapshot } = await import('../../lib/domain/sales/refund-scheme-posting.ts')
  const snap = () => resolveSchemePostingSnapshot(deps.db, fx.orderId)
  const setBasis = (basis: unknown) => deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { euVatRegimeBasis: basis as never } })
  assert.deepEqual(await snap(), { scheme: true, regime: 'IOSS', postingTaxType: 'TAX131' })
  await setBasis({ version: 1, outcome: 'SCHEME', scheme: { schemePostingTaxType: ' TAX131 ' } })
  assert.deepEqual(await snap(), { scheme: true, regime: 'IOSS', postingTaxType: 'TAX131' })
  await setBasis({ version: 1, outcome: 'SCHEME', scheme: { schemePostingTaxType: '  ' } })
  assert.deepEqual(await snap(), { scheme: true, regime: 'IOSS', postingTaxType: null })
  await setBasis({ version: 1, outcome: 'SCHEME', scheme: { schemePostingTaxType: 5 } })
  assert.deepEqual(await snap(), { scheme: true, regime: 'IOSS', postingTaxType: null })
  await setBasis({ version: 1, outcome: 'SCHEME', scheme: {} })
  assert.deepEqual(await snap(), { scheme: true, regime: 'IOSS', postingTaxType: null })
  assert.deepEqual(await resolveSchemePostingSnapshot(deps.db, randomUUID()), { scheme: false })
  // Stamped but outside the scheme (regime null): nothing is snapshotted.
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { euVatRegime: null, euVatLineAccount: null, euVatRegimeBasis: { version: 1, outcome: 'SKIP', skipReason: 'no_scheme_vat', warnings: [] } } })
  assert.deepEqual(await snap(), { scheme: false })
})

test('[eu vat credit note] the refund-time freeze: the source\'s own gross wins over the computed one, the computed one is rounded once, each line keeps its own rate at the quantity and amount refunded, an unpriceable line leaves no gross, a purchase rate is not a price', { skip }, async (t) => {
  const deps = await loadDeps()
  const restore = await configure(deps.db, true)
  const fx = await seed(deps, { stamp: 'IOSS', schemeRate: true })
  const reduced = await deps.db.taxRate.create({ data: { name: `DE CN RED ${randomUUID().slice(0, 6)}`, rate: '0.07', usedFor: 'SALES', accountingTaxType: `DE_RED_${randomUUID().slice(0, 8)}`, countryCode: 'DE', taxCategory: 'REDUCED', active: true } })
  t.after(async () => { await restore(); await cleanup(deps.db, fx); await deps.db.taxRate.deleteMany({ where: { id: reduced.id } }) })
  await seedXeroList(deps.db, { TAX131: '0.000000' })
  await deps.db.salesOrderLine.update({ where: { id: fx.feeA }, data: { taxRateId: reduced.id } })
  const wipeRefunds = async () => {
    const ids = (await deps.db.salesOrderRefund.findMany({ where: { orderId: fx.orderId }, select: { id: true } })).map((r) => r.id)
    await deps.db.accountingSyncLog.deleteMany({ where: { referenceId: { in: ids } } })
    await deps.db.accountingEvent.deleteMany({ where: { sourceEntityId: { in: ids } } }).catch(() => undefined)
    await deps.db.salesOrderRefundLine.deleteMany({ where: { refundId: { in: ids } } })
    await deps.db.salesOrderRefund.deleteMany({ where: { id: { in: ids } } })
  }
  const frozen = async (lines: RefundLine[], extra: Record<string, unknown> = {}) => {
    const result = await deps.createRefund(fx.orderId, lines, 'freeze', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId(), ...extra })
    assert.equal(result.success, true, result.error)
    const refund = await deps.db.salesOrderRefund.findFirstOrThrow({ where: { orderId: fx.orderId }, orderBy: { createdAt: 'desc' }, select: { id: true, statedGrossForeign: true, lines: { select: { schemeTaxRateValue: true, salesOrderLineId: true } } } })
    await wipeRefunds()
    return { gross: refund.statedGrossForeign?.toString() ?? null, rates: refund.lines.map((l) => [l.salesOrderLineId === fx.goods ? 'goods' : l.salesOrderLineId === fx.feeA ? 'feeA' : 'other', l.schemeTaxRateValue?.toString() ?? null].join(':')).sort() }
  }
  // Each line its own rate: 100 at 19% and 20 at 7% (computed gross 119 + 21.4).
  const mixed = await frozen([itemised(fx.goods, 'Widget', 100, 19), itemised(fx.feeA, 'EU Customs Fee', 20, 1.4)])
  assert.deepEqual(mixed, { gross: '140.4', rates: ['feeA:0.07', 'goods:0.19'] })
  // Shipping is frozen at its own identity too (priced as a shipping line, not as a goods line).
  const shipping = await frozen([{ lineId: null, productId: null, description: 'Shipping', qty: 0, totalBase: 10, lineKind: 'shipping', chargedTaxForeign: 1.9 } as RefundLine])
  assert.deepEqual(shipping, { gross: '11.9', rates: ['other:0.19'] })
  // The source's own gross is stored as stated, even when it differs from the computed one.
  const stated = await frozen([itemised(fx.goods, 'Widget', 100, 19)], { statedGrossForeign: 119.01 })
  assert.equal(stated.gross, '119.01')
  // A gross that is not a number is not stored: the computed one is.
  const nan = await frozen([itemised(fx.goods, 'Widget', 100, 19)], { statedGrossForeign: Number.NaN })
  assert.equal(nan.gross, '119')
  // The computed gross is rounded once, to the currency's minor unit: 0.025 net at 19% is 0.02975, stored as 0.03.
  const tiny = await frozen([itemised(fx.goods, 'Widget', 0.025, 0.005)])
  assert.equal(tiny.gross, '0.03')
  // The amount the line is priced on is the foreign total when one is given, else the base total at the order's rate.
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { fxRateToBase: '0.5' } })
  const foreign = await frozen([{ ...itemised(fx.goods, 'Widget', 50, 9.5), totalForeign: 50 } as RefundLine])
  assert.equal(foreign.gross, '59.5', 'the foreign total when one is given')
  await deps.db.salesOrder.update({ where: { id: fx.orderId }, data: { fxRateToBase: '1' } })
  // A purchase-only rate sharing the code is not a price and does not make the code ambiguous.
  const purchase = await deps.db.taxRate.create({ data: { name: `DE CN PUR ${randomUUID().slice(0, 6)}`, rate: '0.05', usedFor: 'PURCHASE', accountingTaxType: fx.rate.accountingTaxType, countryCode: 'DE', taxCategory: 'STANDARD', active: true } }).catch(() => null)
  const withPurchase = await frozen([itemised(fx.goods, 'Widget', 100, 19)])
  assert.deepEqual(withPurchase, { gross: '119', rates: ['goods:0.19'] })
  if (purchase) await deps.db.taxRate.delete({ where: { id: purchase.id } })
  // An unpriceable line (its code is in no sales rate): no rate on the line and no gross, so the credit note is a hand-post row.
  await deps.db.taxRate.update({ where: { id: fx.rate.id }, data: { usedFor: 'PURCHASE' } })
  const refused = await deps.createRefund(fx.orderId, [itemised(fx.goods, 'Widget', 100, 19)], 'unpriced', undefined, { internalBypassToken: deps.bypass, externalRefundId: wooRefundId() })
  const kept = await deps.db.salesOrderRefund.findFirst({ where: { orderId: fx.orderId }, select: { statedGrossForeign: true, lines: { select: { schemeTaxRateValue: true } } } })
  assert.ok(kept === null || (kept.statedGrossForeign === null && kept.lines.every((l) => l.schemeTaxRateValue === null)), `unpriced line froze a basis: ${JSON.stringify(kept)} ${String(refused.error)}`)
})
