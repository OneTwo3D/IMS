import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveEuVatRegime, type EuVatRegimeInput } from '../../lib/domain/accounting/eu-vat-regime'
import { applyEuVatTreatment, lineKindsOf, provisionalStampFromDecision, routeFor, type EuVatTreatmentPlan, type TreatablePayload } from '../../lib/domain/accounting/eu-vat-treatment'
import {
  compareComparableInvoices, comparableFromBuiltPayload, comparableFromXeroInvoice, isBoundaryOrder, statusOfComparison,
  type ComparableInvoice,
} from '../../lib/domain/accounting/eu-vat-shadow-compare'
import * as xeroInvoicesNs from '../../lib/connectors/xero/invoices'

type Mod<T> = T
const { buildSalesInvoicePayload } = (('default' in xeroInvoicesNs ? (xeroInvoicesNs as unknown as { default: typeof xeroInvoicesNs }).default : xeroInvoicesNs) as Mod<typeof xeroInvoicesNs>)

/**
 * THE SHADOW COMPARISON, from a synthetic DE order through the REAL regime resolver, the in-memory (provisional) stamp, the REAL treatment and the REAL Xero payload builder to the comparator, against a
 * hand-written Xero invoice shaped as the storefront plugin posts it. No real data: every figure is invented.
 */
const RATES: Record<string, number> = { TAX131: 0, NONE: 0, OUTPUT_CHARGED: 19 }
const rateOf = (taxType: string): number | null => RATES[taxType] ?? null

const input: EuVatRegimeInput = {
  unreadable: [], mode: 'decide', giftCardFlag: 'off', pluginFx: { state: 'absent' }, pluginFxConflict: false,
  shippingCountry: 'DE', billingCountry: 'DE', currency: 'EUR',
  goodsLines: [{ total: '96.00', voucher: 'no' }],
  rates: [{ wooRateId: 215, tax: '20.24', mapping: { state: 'mapped', imsRateId: 'ims-de', name: 'DE VAT', active: true, countryCode: 'DE', rate: '0.19', reportingCategory: 'IOSS', schemePostingTaxType: 'TAX131' } }],
  orderTax: '20.24', vatExempt: 'no', vatRecord: { state: 'absent' }, eas: { state: 'absent' },
  thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T00:00:00.000Z', source: 'same currency' },
  accounts: { ioss: '821', ddp: '232' }, pluginVatAccount: null, overThresholdDutyFee: false,
} as unknown as EuVatRegimeInput

function imsInvoice(): { built: Record<string, unknown>; lines: Array<{ noTaxKind?: unknown }>; warnings: Array<{ code: string }> } {
  const decision = resolveEuVatRegime(input)
  assert.equal(decision.kind, 'SCHEME')
  const stamp = provisionalStampFromDecision(decision, new Date('2026-11-10T00:00:00Z'))
  assert.ok(stamp, 'a scheme decision gives a provisional stamp')
  const routed = routeFor(stamp, decision, input)
  assert.ok(routed.ok, routed.ok ? '' : routed.reason)
  const payload: TreatablePayload = {
    currency: 'EUR',
    lines: [
      { description: 'Widget', quantity: 2, unitAmount: 50, accountCode: '200', taxType: 'OUTPUT_CHARGED', discountAmount: 4 },
      { description: 'EU Customs Fee', quantity: 1, unitAmount: 2, accountCode: '200', taxType: 'OUTPUT_CHARGED' },
    ],
    shippingAmount: 10, shippingDescription: 'Shipping', shippingAccountCode: '260', shippingTaxType: 'OUTPUT_CHARGED',
    discountAmount: 1.5, discountAccountCode: '270', discountTaxType: 'OUTPUT_CHARGED', lineAmountsIncludeTax: false,
  }
  const plan: EuVatTreatmentPlan = {
    route: routed.route, lineKinds: lineKindsOf([{}, { isFeeLine: true, wclcFeeKind: 'uhf', forceNoTax: false }]), feeAccount: '232', roundingAccount: '860', orderTotal: '126.74', lineTax: ['0', '0.38'], schemePostingTypeProblem: null,
  }
  const treated = applyEuVatTreatment(payload, plan)
  assert.ok(treated.ok, treated.ok ? '' : treated.reason)
  const data = { ...treated.payload, invoiceNumber: 'SHADOW-1', contactName: 'shadow', date: '2026-11-01' } as unknown as Parameters<typeof buildSalesInvoicePayload>[0]
  const built = buildSalesInvoicePayload(data, 'DRAFT', 'shadow-contact', new Set<string>(), 'EUR')
  return { built, lines: treated.payload.lines, warnings: decision.kind === 'SCHEME' ? decision.warnings : [] }
}

const xeroPlugin = (over: { reorder?: boolean; vatAccount?: string; vatAmount?: number; goodsType?: string; total?: number; omitVat?: boolean } = {}) => {
  const items = [
    { Description: 'Widget', AccountCode: '200', TaxType: over.goodsType ?? 'TAX131', LineAmount: 96, TaxAmount: 0 },
    { Description: 'EU Customs Fee', AccountCode: '232', TaxType: 'NONE', LineAmount: 2, TaxAmount: 0 },
    { Description: 'Shipping', AccountCode: '260', TaxType: 'TAX131', LineAmount: 10, TaxAmount: 0 },
    { Description: 'Order discount', AccountCode: '270', TaxType: 'TAX131', LineAmount: -1.5, TaxAmount: 0 },
    ...(over.omitVat ? [] : [{ Description: 'VAT collected', AccountCode: over.vatAccount ?? '821', TaxType: 'NONE', LineAmount: over.vatAmount ?? 20.24, TaxAmount: 0 }]),
  ]
  return { InvoiceNumber: 'X-1', Status: 'AUTHORISED', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', LineItems: over.reorder ? [...items].reverse() : items, Total: over.total ?? 126.74 }
}

function compare(xeroRaw: unknown, rate = rateOf) {
  const ims = imsInvoice()
  const mine = comparableFromBuiltPayload(ims.built, ims.lines, rate, 'EUR')
  assert.ok(mine.ok, mine.ok ? '' : mine.reason)
  const theirs = comparableFromXeroInvoice(xeroRaw)
  assert.ok(theirs.ok, theirs.ok ? '' : theirs.reason)
  return { ims, mine: mine.invoice, comparison: compareComparableInvoices(mine.invoice, theirs.invoice) }
}

test('the IMS side: goods, shipping and discount on the zero-rated type, the fee on 232 NONE, ONE VAT line on 821 NONE, total equals the order', () => {
  const { mine } = compare(xeroPlugin())
  assert.deepEqual(mine.lines.map((l) => [l.kind, l.accountCode, l.taxType, l.lineAmount]), [
    ['goods', '200', 'TAX131', '96.00'], ['fee', '232', 'NONE', '2.00'], ['vat', '821', 'NONE', '20.24'], ['shipping', '260', 'TAX131', '10.00'], ['discount', '270', 'TAX131', '-1.50'],
  ])
  assert.equal(mine.total, '126.74')
})

test('an invoice the plugin posted the same way matches line by line, whatever the order of its lines', () => {
  for (const reorder of [false, true]) {
    const { comparison } = compare(xeroPlugin({ reorder }))
    assert.equal(comparison.verdict, 'match', comparison.differences.join('; '))
    assert.deepEqual(comparison.differences, [])
    assert.equal(comparison.vatLine.present && comparison.vatLine.match, true)
    assert.equal(comparison.total.match, true)
  }
})

test('a different TaxType on a line differs, and the row names the field', () => {
  const { comparison } = compare(xeroPlugin({ goodsType: 'TAX132' }))
  assert.equal(comparison.verdict, 'differs')
  const row = comparison.lines.find((l) => l.kind === 'goods')!
  assert.equal(row.verdict, 'differs')
  assert.deepEqual(row.fields, ['taxType'])
})

test('a VAT line on the wrong account, or for another amount, or missing, is a difference of the VAT line', () => {
  for (const over of [{ vatAccount: '232' }, { vatAmount: 20.25, total: 126.75 }, { omitVat: true, total: 106.5 }]) {
    const { comparison } = compare(xeroPlugin(over))
    assert.equal(comparison.verdict, 'differs')
    assert.equal(comparison.vatLine.present && !comparison.vatLine.match, true, JSON.stringify(over))
  }
})

test('a different total differs even when every line matches', () => {
  const { comparison } = compare(xeroPlugin({ total: 126.75 }))
  assert.equal(comparison.verdict, 'differs')
  assert.equal(comparison.total.match, false)
  assert.ok(comparison.differences.some((d) => d.startsWith('total:')))
})

test('MATCH MEANS FULLY COMPARED: an unknown rate, a missing Xero TaxAmount or an unavailable total is not_comparable with the reason, never a match', () => {
  const unknownRate = compare(xeroPlugin(), (type) => (type === 'TAX131' ? null : rateOf(type)))
  assert.equal(unknownRate.comparison.verdict, 'not_comparable')
  assert.equal(unknownRate.mine.total, null)
  assert.ok(unknownRate.comparison.incomplete.some((r) => r.includes('TAX131')))
  assert.ok(unknownRate.comparison.incomplete.some((r) => r.includes('expected total')))
  assert.equal(statusOfComparison(unknownRate.comparison, false), 'not_comparable')
  assert.equal(statusOfComparison(unknownRate.comparison, true), 'not_comparable', 'a boundary order that could not be compared is not a review either')

  const noTax = xeroPlugin()
  const withoutTaxAmount = { ...noTax, LineItems: noTax.LineItems.map((l, i) => (i === 0 ? { AccountCode: l.AccountCode, TaxType: l.TaxType, LineAmount: l.LineAmount } : l)) }
  assert.equal(compare(withoutTaxAmount).comparison.verdict, 'not_comparable')
  assert.ok(compare(withoutTaxAmount).comparison.incomplete.some((r) => r.includes('no TaxAmount')))

  const { Total: _total, ...withoutTotal } = xeroPlugin()
  void _total
  const noTotal = compare(withoutTotal).comparison
  assert.equal(noTotal.verdict, 'not_comparable')
  assert.equal(noTotal.total.compared, false)
  assert.ok(noTotal.incomplete.some((r) => r.includes('no Total')))
})

test('a real difference still wins over an incomplete comparison', () => {
  const { comparison } = compare(xeroPlugin({ goodsType: 'TAX132' }), (type) => (type === 'NONE' ? null : rateOf(type)))
  assert.equal(comparison.verdict, 'differs')
  assert.ok(comparison.incomplete.length > 0)
})

test('a boundary-FX order that differs is REVIEW, never differs; one that matches is match', () => {
  const warnings = [{ code: 'threshold_band' }]
  assert.equal(isBoundaryOrder(warnings), true)
  assert.equal(isBoundaryOrder([{ code: 'eas_disagrees' }]), false)
  assert.equal(statusOfComparison(compare(xeroPlugin({ goodsType: 'TAX132' })).comparison, true), 'review')
  assert.equal(statusOfComparison(compare(xeroPlugin({ goodsType: 'TAX132' })).comparison, false), 'differs')
  assert.equal(statusOfComparison(compare(xeroPlugin()).comparison, true), 'match')
})

test('a taxed (route none) invoice: tax is the net times the rate, within one minor unit per line', () => {
  const ims: ComparableInvoice = { currency: 'GBP', foreignCurrency: false, currencyRate: null, lineAmountsIncludeTax: false, total: '120.00', lines: [{ kind: 'goods', accountCode: '200', taxType: 'OUTPUT2', lineAmount: '100.00', taxAmount: '20.00' }] }
  const near: ComparableInvoice = { ...ims, total: '120.01', lines: [{ ...ims.lines[0]!, taxAmount: '20.01' }] }
  const far: ComparableInvoice = { ...ims, total: '120.05', lines: [{ ...ims.lines[0]!, taxAmount: '20.05' }] }
  assert.equal(compareComparableInvoices(ims, near).verdict, 'match')
  assert.equal(compareComparableInvoices(ims, far).verdict, 'differs')
})

test('a line only one side has is shown, and an unreadable Xero invoice is refused rather than compared', () => {
  const ims = compare(xeroPlugin()).mine
  const extra = comparableFromXeroInvoice({ ...xeroPlugin(), LineItems: [...xeroPlugin().LineItems, { AccountCode: '999', TaxType: 'NONE', LineAmount: 5, TaxAmount: 0 }], Total: 131.74 })
  assert.ok(extra.ok)
  const comparison = compareComparableInvoices(ims, extra.invoice)
  assert.equal(comparison.lines.filter((l) => l.verdict === 'only_xero').length, 1)
  assert.equal(comparison.verdict, 'differs')
  assert.equal(comparableFromXeroInvoice({ CurrencyCode: 'EUR', LineItems: [{ AccountCode: '200', TaxType: 'NONE' }] }).ok, false)
  assert.equal(comparableFromXeroInvoice(null).ok, false)
})

test('the comparator keeps only the compared fields: nothing from a Xero response beyond them survives', () => {
  const raw = { ...xeroPlugin(), Contact: { Name: 'Private Person', EmailAddress: 'p@example.invalid' }, Reference: 'secret?auth=abc', LineItems: xeroPlugin().LineItems.map((l) => ({ ...l, Description: 'Private description' })) }
  const reading = comparableFromXeroInvoice(raw)
  assert.ok(reading.ok)
  const text = JSON.stringify(reading)
  for (const leaked of ['Private', 'example.invalid', 'auth=abc']) assert.equal(text.includes(leaked), false, leaked)
})

test('a provisional stamp mirrors the real one and a refusal gives none', () => {
  const decision = resolveEuVatRegime(input)
  assert.equal(decision.kind, 'SCHEME')
  const at = new Date('2026-11-10T00:00:00Z')
  const stamp = provisionalStampFromDecision(decision, at)
  assert.equal(stamp?.regime, 'IOSS')
  assert.equal(stamp?.vatAccount, '821')
  assert.equal(stamp?.schemePostingTaxType, 'TAX131')
  assert.equal(provisionalStampFromDecision({ kind: 'REFUSE', code: 'rate_unmapped', reason: 'x' } as never, at), null)
  assert.deepEqual(provisionalStampFromDecision({ kind: 'SKIP', reason: 'no_scheme_vat', vatExemptB2b: false, warnings: [] }, at), { regime: null, vatAccount: null, stampedAt: at })
})

/**
 * THE EXCHANGE RATE of a foreign-currency invoice is compared (to Xero's 6 decimal places); a base-currency invoice is unchanged.
 */
const foreign = (rate: number | null): ComparableInvoice => ({ currency: 'NOK', foreignCurrency: true, currencyRate: rate, lineAmountsIncludeTax: false, total: '100.00', lines: [{ kind: 'goods', accountCode: '200', taxType: 'TAX122', lineAmount: '100.00', taxAmount: '0.00' }] })

test('foreign currency: equal rates match (IMS full precision against Xero at 6 places); different rates differ; a boundary order that differs on rate is review', () => {
  assert.equal(compareComparableInvoices(foreign(0.0731234567), foreign(0.073123)).verdict, 'match')
  assert.equal(compareComparableInvoices(foreign(0.0731234567), foreign(0.073123)).incomplete.length, 0)
  const different = compareComparableInvoices(foreign(0.0731234567), foreign(0.0742))
  assert.equal(different.verdict, 'differs')
  assert.ok(different.differences.some((d) => d.startsWith('currency rate:')))
  assert.equal(statusOfComparison(different, true), 'review')
  assert.equal(statusOfComparison(different, false), 'differs')
})

test('foreign currency: a missing rate on either side is not_comparable with currency_rate_unavailable, never a match', () => {
  for (const [a, b] of [[null, 0.073123], [0.073123, null], [null, null]] as const) {
    const c = compareComparableInvoices(foreign(a), foreign(b))
    assert.equal(c.verdict, 'not_comparable')
    assert.ok(c.incomplete.some((r) => r.startsWith('currency_rate_unavailable')))
  }
})

test('base currency: the rate is not compared at all (unchanged behaviour)', () => {
  const base = (rate: number | null): ComparableInvoice => ({ ...foreign(rate), currency: 'EUR', foreignCurrency: false })
  assert.equal(compareComparableInvoices(base(null), base(null)).verdict, 'match')
  assert.equal(compareComparableInvoices(base(1.1), base(null)).verdict, 'match')
})

test('the built side carries the CurrencyRate of the real builder for a foreign invoice, and flags foreign against the base currency', () => {
  const ims = imsInvoice()
  const built = { ...ims.built, CurrencyRate: 0.8512345678, CurrencyCode: 'GBP' }
  const mine = comparableFromBuiltPayload(built, ims.lines, rateOf, 'EUR')
  assert.ok(mine.ok)
  if (mine.ok) { assert.equal(mine.invoice.foreignCurrency, true); assert.equal(mine.invoice.currencyRate, 0.8512345678) }
  const baseOne = comparableFromBuiltPayload(ims.built, ims.lines, rateOf, 'EUR')
  assert.ok(baseOne.ok && baseOne.invoice.foreignCurrency === false)
  const xero = comparableFromXeroInvoice({ ...xeroPlugin(), CurrencyRate: 0.851235 })
  assert.ok(xero.ok && xero.invoice.currencyRate === 0.851235)
})

test('free text from Xero never survives: a non-code AccountCode, TaxType or Status becomes ?', () => {
  const reading = comparableFromXeroInvoice({ ...xeroPlugin(), Status: 'Jane Private', LineItems: [{ AccountCode: 'Jane Private', TaxType: 'a@b.invalid', LineAmount: 1, TaxAmount: 0 }] })
  assert.ok(reading.ok)
  if (reading.ok) { assert.equal(reading.status, '?'); assert.equal(reading.invoice.lines[0]!.accountCode, '?'); assert.equal(reading.invoice.lines[0]!.taxType, '?') }
})
