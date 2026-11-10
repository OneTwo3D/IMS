import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { Prisma } from '../../app/generated/prisma/client'
import { resolveEuVatRegime, type EuVatRegimeDecision, type EuVatRegimeInput, type RateFact } from '../../lib/domain/accounting/eu-vat-regime'
import {
  applyEuVatTreatment, B2B_ZERO_RATE_TAX_TYPE, lineKindsOf, predictedUntaxedTotal, routeFor, schemePostingTypeProblem,
  type EuVatTreatmentPlan, type TreatableLine, type TreatablePayload, type TreatedLineKind,
} from '../../lib/domain/accounting/eu-vat-treatment'
import { findSalesDocumentTaxTypeProblems } from '../../lib/domain/accounting/sales-document-tax-types'

/**
 * THE INVOICE TREATMENT, from the 65 measured WooCommerce rates (tests/fixtures/eu-vat-parity.json) through the real regime resolver to the Xero lines.
 * For every scheme rate, once as IOSS (VOEC for Norway) and once as DDP: the document totals the order exactly, goods, shipping and discount are on the scheme's zero-rated type,
 * the fee is on 232 on NONE, and ONE line carries all the VAT on the stamped account. For every other rate nothing about the payload changes.
 */
type FixtureRow = {
  wooId: number; country: string; ratePercent: string; wooName: string; group: 'scheme' | 'uk-zero-or-182' | 'outside-scheme'
  xeroomTaxType: string; expectedAccountingTaxType: string | null; expectedSchemePostingTaxType: string | null; expectedReportingCategory: 'IOSS' | 'VOEC' | null
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/eu-vat-parity.json', import.meta.url), 'utf8')) as { rows: FixtureRow[] }

const D = (v: string | number) => new Prisma.Decimal(v)
const r2 = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
const CHARGED = 'OUTPUT_CHARGED'

type Built = { payload: TreatablePayload; plan: EuVatTreatmentPlan; input: EuVatRegimeInput; orderTotal: string; vat: string }

/** A WooCommerce-shaped order and the invoice payload the importer would build for it: one goods line (qty 2, with a line discount), a marked landed-cost fee, shipping and an order-level discount. */
function build(row: FixtureRow, opts: { goodsSubtotal: string; destination?: string; currency?: string; exempt?: 'yes' | 'no' | 'unknown'; feeTaxed?: boolean; extraFee?: boolean } ): Built {
  const pct = D(row.ratePercent).div(100)
  const goodsNet = D(opts.goodsSubtotal).minus(4)
  const feeNet = D('2.00')
  const shipping = D('10.00')
  const discount = D('1.50')
  // WooCommerce's own figures: tax on goods and shipping at the rate, on the fee only when it is taxed; the order-level discount reduces the taxed base.
  const base = goodsNet.plus(shipping).minus(discount).plus(opts.feeTaxed === false ? 0 : feeNet)
  const vat = r2(base.times(pct))
  const orderTotal = goodsNet.plus(feeNet).plus(shipping).minus(discount).plus(vat)
  const charged = row.group === 'scheme' ? CHARGED : (row.expectedAccountingTaxType ?? 'ZERORATEDOUTPUT')
  const bind = { taxRateId: 'ims-rate', taxRateBasis: 'sales_line' }
  const payload: TreatablePayload = {
    currency: opts.currency ?? ((opts.destination ?? row.country) === 'NO' ? 'NOK' : 'EUR'),
    lines: [
      { description: 'Widget', quantity: 2, unitAmount: D(opts.goodsSubtotal).div(2).toNumber(), accountCode: '200', taxType: charged, discountAmount: 4, ...bind },
      { description: 'EU Customs Fee', quantity: 1, unitAmount: feeNet.toNumber(), accountCode: '200', taxType: opts.feeTaxed === false ? 'NONE' : charged, ...(opts.feeTaxed === false ? { noTaxKind: 'fee-no-tax' } : bind) },
    ],
    shippingAmount: shipping.toNumber(), shippingDescription: 'Shipping', shippingAccountCode: '260', shippingTaxType: charged, shippingTaxRateId: 'ims-rate', shippingTaxRateBasis: 'plain',
    discountAmount: discount.toNumber(), discountAccountCode: '270', discountTaxType: charged, discountTaxRateId: 'ims-rate', discountTaxRateBasis: 'plain',
    lineAmountsIncludeTax: false,
  }
  const destination = opts.destination ?? row.country
  const isScheme = row.group === 'scheme'
  const rates: RateFact[] = vat.isZero()
    ? []
    : [{
        wooRateId: row.wooId, tax: vat.toString(),
        mapping: {
          state: 'mapped', imsRateId: 'ims-rate', name: row.wooName, active: true, countryCode: row.country || null, rate: pct.toString(),
          reportingCategory: isScheme ? row.expectedReportingCategory : null, schemePostingTaxType: isScheme ? row.expectedSchemePostingTaxType : null,
        },
      }]
  const nok = destination === 'NO'
  const input: EuVatRegimeInput = {
    unreadable: [], mode: 'decide', pluginFx: { state: 'absent' }, pluginFxConflict: false,
    shippingCountry: destination || 'GB', billingCountry: destination || 'GB', currency: opts.currency ?? (nok ? 'NOK' : 'EUR'),
    goodsLines: [{ total: goodsNet.toString(), voucher: 'no' }], rates, orderTax: vat.toString(),
    vatExempt: opts.exempt ?? 'no', vatRecord: { state: 'absent' }, eas: { state: 'absent' },
    thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T00:00:00.000Z', source: 'same currency' },
    accounts: { ioss: '821', ddp: '232' }, pluginVatAccount: null, overThresholdDutyFee: false,
  }
  const kinds: TreatedLineKind[] = lineKindsOf([{}, { isFeeLine: true, wclcFeeKind: opts.feeTaxed === false ? null : 'uhf', forceNoTax: opts.feeTaxed === false }])
  const plan: EuVatTreatmentPlan = {
    route: { kind: 'none' }, lineKinds: kinds, feeAccount: '232', roundingAccount: '860', orderTotal: orderTotal.toString(),
    lineTax: ['0', opts.feeTaxed === false ? '0' : r2(feeNet.times(pct)).toString()],
    schemePostingTypeProblem: null,
  }
  return { payload, plan, input, orderTotal: orderTotal.toString(), vat: vat.toString() }
}

function route(built: Built): { decision: EuVatRegimeDecision; plan: EuVatTreatmentPlan } {
  const decision = resolveEuVatRegime(built.input)
  const stamp = decision.kind === 'SCHEME'
    ? { regime: decision.regime, vatAccount: decision.vatAccount, stampedAt: new Date('2026-11-01T00:00:00Z') }
    : { regime: null, vatAccount: null, stampedAt: new Date('2026-11-01T00:00:00Z') }
  const routed = routeFor(stamp, decision, built.input)
  assert.ok(routed.ok, routed.ok ? '' : routed.reason)
  return { decision, plan: { ...built.plan, route: routed.route } }
}

const schemeRows = fixture.rows.filter((r) => r.group === 'scheme')
const otherRows = fixture.rows.filter((r) => r.group !== 'scheme')

test('the fixture still holds 30 scheme rates (29 IOSS, 1 VOEC) and 35 others', () => {
  assert.equal(fixture.rows.length, 65)
  assert.equal(schemeRows.length, 30)
  assert.equal(otherRows.length, 35)
})

for (const row of schemeRows) {
  const isNorway = row.country === 'NO'
  for (const regime of ['scheme', 'ddp'] as const) {
    const expectedRegime = regime === 'ddp' ? 'DDP' : isNorway ? 'VOEC' : 'IOSS'
    const goods = regime === 'ddp' ? (isNorway ? '4000.00' : '200.00') : (isNorway ? '1000.00' : '100.00')
    test(`Woo ${row.wooId} ${row.country} ${row.ratePercent}% as ${expectedRegime}: lines on the right types and accounts, total equals the order`, () => {
      const built = build(row, { goodsSubtotal: goods })
      const { decision, plan } = route(built)
      assert.equal(decision.kind, 'SCHEME')
      assert.equal(decision.kind === 'SCHEME' && decision.regime, expectedRegime)
      const treated = applyEuVatTreatment(built.payload, plan)
      assert.ok(treated.ok, treated.ok ? '' : treated.reason)
      const lines = treated.payload.lines
      const zero = row.xeroomTaxType // the zero-rated posting type Xeroom uses for this rate
      assert.equal(lines[0]!.taxType, zero, 'goods on the scheme zero-rated type')
      assert.equal(lines[0]!.accountCode, '200', 'goods account unchanged')
      assert.equal(treated.payload.shippingTaxType, zero)
      assert.equal(treated.payload.shippingAccountCode, '260')
      assert.equal(treated.payload.discountTaxType, zero)
      assert.equal(treated.payload.discountAccountCode, '270')
      assert.notEqual(lines[0]!.taxType, CHARGED, 'never the charged code')
      // The fee: 232, NONE, naming why.
      assert.deepEqual([lines[1]!.accountCode, lines[1]!.taxType, lines[1]!.noTaxKind], ['232', 'NONE', 'fee-no-tax'])
      // ONE VAT line, on the stamped account, on NONE, carrying all the VAT.
      const vatLines = lines.filter((l) => l.noTaxKind === 'eu-vat-recovery')
      assert.equal(vatLines.length, 1)
      assert.equal(vatLines[0]!.accountCode, regime === 'ddp' ? '232' : '821')
      assert.equal(vatLines[0]!.taxType, 'NONE')
      assert.equal(vatLines[0]!.quantity, 1)
      assert.equal(vatLines[0]!.unitAmount, Number(built.vat))
      assert.match(String(vatLines[0]!.description), regime === 'ddp' ? /^DDP import VAT collected — / : isNorway ? /^VOEC VAT collected — NO / : /^IOSS VAT collected — /)
      // On 821 (IOSS/VOEC) exactly the VAT line; on 232 (DDP) the VAT line and the fee beside it.
      assert.deepEqual(lines.filter((l) => l.accountCode === '821').length, regime === 'ddp' ? 0 : 1)
      assert.equal(lines.filter((l) => l.accountCode === '232').length, regime === 'ddp' ? 2 : 1)
      // No rounding was needed, no line carries a tax amount, the rate bindings are gone from re-typed lines.
      assert.equal(lines.some((l) => l.noTaxKind === 'rounding-difference'), false)
      assert.equal(JSON.stringify(treated.payload).includes('TaxAmount'), false)
      for (const l of [lines[0]!, lines[1]!]) assert.equal('taxRateId' in l, false)
      for (const key of ['shippingTaxRateId', 'shippingTaxRateBasis', 'discountTaxRateId', 'discountTaxRateBasis']) assert.equal(key in treated.payload, false, key)
      // The invoice total equals the order total exactly.
      assert.equal(predictedUntaxedTotal(treated.payload)!.toFixed(2), D(built.orderTotal).toFixed(2))
      // Every NONE line names an allowed kind, so the connector's own check passes.
      assert.deepEqual(findSalesDocumentTaxTypeProblems(treated.payload as never), [])
    })
  }
}

for (const row of otherRows) {
  test(`Woo ${row.wooId} ${row.country || '(none)'} "${row.wooName}" ${row.ratePercent}%: not a scheme order, the payload is unchanged`, () => {
    // An unmarked taxed fee and no marked fee: nothing for the treatment to do.
    const built = build(row, { goodsSubtotal: '100.00', feeTaxed: false, destination: row.country || 'GB', exempt: 'no' })
    const plainKinds: TreatedLineKind[] = ['goods', 'untaxed-fee']
    const { decision, plan } = route(built)
    assert.notEqual(decision.kind, 'SCHEME')
    const before = structuredClone(built.payload)
    const treated = applyEuVatTreatment(built.payload, { ...plan, lineKinds: plainKinds })
    assert.ok(treated.ok)
    assert.deepEqual(treated.payload, before)
    assert.equal(treated.applied.route, 'none')
  })
}

test('B2B: an EU-27 business sale charged no VAT goes on ZERORATEDOUTPUT (goods, shipping, discount); Norway does not', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  // WooCommerce charged no tax: no rates, order tax 0, VAT-exempt flag yes.
  const built = build({ ...de, ratePercent: '0.0000' }, { goodsSubtotal: '100.00', exempt: 'yes', feeTaxed: false })
  const { decision, plan } = route(built)
  assert.equal(decision.kind, 'SKIP')
  assert.equal(plan.route.kind, 'b2b_zero_rate')
  const treated = applyEuVatTreatment({ ...built.payload, lines: built.payload.lines.map((l) => ({ ...l, taxType: l.description === 'Widget' ? undefined : l.taxType })) }, { ...plan, lineKinds: ['goods', 'untaxed-fee'] })
  assert.ok(treated.ok, treated.ok ? '' : treated.reason)
  assert.equal(treated.payload.lines[0]!.taxType, B2B_ZERO_RATE_TAX_TYPE)
  assert.equal(treated.payload.shippingTaxType, B2B_ZERO_RATE_TAX_TYPE)
  assert.equal(treated.payload.discountTaxType, B2B_ZERO_RATE_TAX_TYPE)
  assert.equal(treated.payload.lines[1]!.taxType, 'NONE', 'the untaxed fee keeps its own named NONE')
  assert.equal(predictedUntaxedTotal(treated.payload)!.toFixed(2), D(plan.orderTotal).toFixed(2))
  assert.equal(treated.payload.lines.some((l) => l.noTaxKind === 'eu-vat-recovery'), false)
  // Norway is not an EU-27 business sale.
  const no = schemeRows.find((r) => r.country === 'NO')!
  const norway = build({ ...no, ratePercent: '0.0000' }, { goodsSubtotal: '1000.00', exempt: 'yes', feeTaxed: false })
  assert.equal(route(norway).plan.route.kind, 'none')
})

test('a marked landed-cost fee is re-coded on every order: 232 on NONE, naming why, on a UK order too', () => {
  const uk = otherRows.find((r) => r.wooId === 112)!
  const built = build(uk, { goodsSubtotal: '100.00', destination: 'GB' })
  // The fee is marked and untaxed (WooCommerce charged it no tax).
  const plan: EuVatTreatmentPlan = { ...built.plan, route: { kind: 'none' }, lineKinds: ['goods', 'marked-fee'], lineTax: ['0', '0'] }
  const treated = applyEuVatTreatment(built.payload, plan)
  assert.ok(treated.ok)
  assert.deepEqual([treated.payload.lines[1]!.accountCode, treated.payload.lines[1]!.taxType, treated.payload.lines[1]!.noTaxKind], ['232', 'NONE', 'fee-no-tax'])
  assert.equal(treated.payload.lines[0]!.taxType, 'OUTPUT2', 'goods untouched on a non-scheme order')
  assert.equal(treated.applied.feesRecoded, 1)
  // A marked fee that carries VAT outside the scheme cannot move to NONE: the VAT would leave the document.
  const taxed = applyEuVatTreatment(built.payload, { ...plan, lineTax: ['0', '0.40'] })
  assert.equal(taxed.ok, false)
  assert.match(taxed.ok ? '' : taxed.reason, /carries VAT on an order that is not on the IOSS\/VOEC\/DDP scheme/)
  // No fee account configured.
  const noAccount = applyEuVatTreatment(built.payload, { ...plan, feeAccount: null })
  assert.equal(noAccount.ok, false)
  assert.match(noAccount.ok ? '' : noAccount.reason, /landed-cost fees" account is not configured/)
})

test('rounding goes to 860: a few minor units either way is one named line, and the total then equals the order exactly', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  for (const delta of ['0.01', '-0.01', '0.03']) {
    const built = build(de, { goodsSubtotal: '100.00' })
    const { plan } = route(built)
    const orderTotal = D(plan.orderTotal).plus(delta).toString()
    const treated = applyEuVatTreatment(built.payload, { ...plan, orderTotal })
    assert.ok(treated.ok, treated.ok ? '' : treated.reason)
    const rounding = treated.payload.lines.filter((l) => l.noTaxKind === 'rounding-difference')
    assert.equal(rounding.length, 1)
    assert.deepEqual([rounding[0]!.accountCode, rounding[0]!.taxType, rounding[0]!.unitAmount], ['860', 'NONE', Number(delta)])
    assert.equal(predictedUntaxedTotal(treated.payload)!.toFixed(2), D(orderTotal).toFixed(2))
    assert.equal(treated.applied.roundingAdjustment, D(delta).toFixed(2))
    assert.deepEqual(findSalesDocumentTaxTypeProblems(treated.payload as never), [])
  }
  // The rounding line is never on 821 (the plugin's old choice).
  const built = build(de, { goodsSubtotal: '100.00' })
  const { plan } = route(built)
  const withRounding = applyEuVatTreatment(built.payload, { ...plan, orderTotal: D(plan.orderTotal).plus('0.01').toString() })
  assert.ok(withRounding.ok)
  assert.equal(withRounding.payload.lines.some((l) => l.noTaxKind === 'rounding-difference' && l.accountCode === '821'), false)
})

test('refusals: a real difference, a missing rounding account, an unreadable total, a tax-inclusive build, a second line on the VAT account, a misaligned plan', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  const built = build(de, { goodsSubtotal: '100.00' })
  const { plan } = route(built)
  const refused = (payload: TreatablePayload, p: EuVatTreatmentPlan, pattern: RegExp) => {
    const result = applyEuVatTreatment(payload, p)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, pattern)
  }
  refused(built.payload, { ...plan, orderTotal: D(plan.orderTotal).plus('1.00').toString() }, /more than rounding explains/)
  refused(built.payload, { ...plan, orderTotal: D(plan.orderTotal).minus('25').toString() }, /more than rounding explains/)
  refused(built.payload, { ...plan, orderTotal: D(plan.orderTotal).plus('0.01').toString(), roundingAccount: null }, /no rounding account is configured/)
  refused(built.payload, { ...plan, orderTotal: 'abc' }, /order total cannot be read/)
  refused(built.payload, { ...plan, orderTotal: '' }, /order total cannot be read/)
  refused({ ...built.payload, lineAmountsIncludeTax: true }, plan, /tax-inclusive/)
  refused({ ...built.payload, lines: [...built.payload.lines, { description: 'Other', quantity: 1, unitAmount: 1, accountCode: '821', taxType: CHARGED } as TreatableLine] }, { ...plan, lineKinds: ['goods', 'marked-fee', 'goods'], lineTax: ['0', '0', '0'] }, /already posted to the VAT account 821/)
  refused(built.payload, { ...plan, lineKinds: ['goods'] }, /do not line up/)
  refused(built.payload, { ...plan, route: { ...(plan.route as Extract<EuVatTreatmentPlan['route'], { kind: 'scheme' }>), vatAccount: '' } }, /names no account/)
  const unreadable = { ...built.payload, lines: [{ ...built.payload.lines[0]!, unitAmount: Number.NaN }, built.payload.lines[1]!] }
  refused(unreadable, plan, /line amount cannot be read/)
})

test('the same order twice gives the same payload, and the input payload is never mutated', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  const built = build(de, { goodsSubtotal: '100.00' })
  const { plan } = route(built)
  const before = structuredClone(built.payload)
  const a = applyEuVatTreatment(built.payload, plan)
  const b = applyEuVatTreatment(built.payload, plan)
  assert.deepEqual(built.payload, before)
  assert.deepEqual(a, b)
})

test('routeFor: a stamp and the current facts that contradict each other refuse; a REFUSE refuses', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  const built = build(de, { goodsSubtotal: '100.00' })
  const scheme = resolveEuVatRegime(built.input)
  assert.equal(scheme.kind, 'SCHEME')
  const stampedAt = new Date()
  // stamped outside the scheme, facts now say scheme
  const a = routeFor({ regime: null, vatAccount: null, stampedAt }, scheme, built.input)
  assert.equal(a.ok, false)
  // stamped scheme, facts now say no scheme VAT
  const skip: EuVatRegimeDecision = { kind: 'SKIP', reason: 'no_scheme_vat', vatExemptB2b: false, warnings: [] }
  const b = routeFor({ regime: 'IOSS', vatAccount: '821', stampedAt }, skip, built.input)
  assert.equal(b.ok, false)
  // stamped scheme with no account
  const c = routeFor({ regime: 'IOSS', vatAccount: null, stampedAt }, scheme, built.input)
  assert.equal(c.ok, false)
  // a REFUSE
  const d = routeFor({ regime: 'IOSS', vatAccount: '821', stampedAt }, { kind: 'REFUSE', code: 'rate_unmapped', reason: 'x' }, built.input)
  assert.equal(d.ok, false)
  // a stamp that agrees with the fresh decision routes with the stamped account and regime
  const e = routeFor({ regime: 'IOSS', vatAccount: '821', stampedAt }, scheme, built.input)
  assert.ok(e.ok)
  assert.deepEqual(e.ok && e.route.kind === 'scheme' && [e.route.regime, e.route.vatAccount], ['IOSS', '821'])
  // the stamp is never re-derived: a fresh decision of another regime or another account is NOT posted through the old stamp
  const f = routeFor({ regime: 'DDP', vatAccount: '232', stampedAt }, scheme, built.input)
  assert.equal(f.ok, false)
  assert.match(f.ok ? '' : f.reason, /stamped DDP on account 232, but its facts now decide IOSS on account 821/)
  const g = routeFor({ regime: 'IOSS', vatAccount: '999', stampedAt }, scheme, built.input)
  assert.equal(g.ok, false)
})

test('a threshold-crossing re-import: stamped IOSS at 96, the goods rise over EUR 150, the fresh decision is DDP, so the invoice is refused, not posted through the IOSS stamp', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  const first = build(de, { goodsSubtotal: '100.00' })
  const ioss = resolveEuVatRegime(first.input)
  assert.equal(ioss.kind === 'SCHEME' && ioss.regime, 'IOSS')
  const stamp = { regime: 'IOSS' as const, vatAccount: '821', stampedAt: new Date() }
  const later = build(de, { goodsSubtotal: '200.00' })
  const ddp = resolveEuVatRegime(later.input)
  assert.equal(ddp.kind === 'SCHEME' && ddp.regime, 'DDP')
  const routed = routeFor(stamp, ddp, later.input)
  assert.equal(routed.ok, false)
  // the same order again with the same facts still routes
  assert.ok(routeFor(stamp, ioss, first.input).ok)
})

test('the scheme posting type must be a known, ACTIVE, revenue, exactly 0% Xero type: a taxable code, an unknown one, an inactive one and an unstated rate each refuse', () => {
  const row = (over: Partial<{ taxType: string; status: string; effectiveRate: string | null; displayTaxRate: string | null; revenue: boolean | null }> = {}) => ({
    taxType: 'TAX131', status: 'ACTIVE', effectiveRate: '0.000000', displayTaxRate: '0.000000', canApply: { revenue: over.revenue === undefined ? true : over.revenue }, ...over,
  })
  assert.equal(schemePostingTypeProblem([row()], 'TAX131'), null)
  assert.equal(schemePostingTypeProblem([row({ effectiveRate: null, displayTaxRate: '0' })], 'TAX131'), null, 'the displayed rate stands in when no effective rate is given')
  assert.match(schemePostingTypeProblem([row({ effectiveRate: '19.000000' })], 'TAX131') ?? '', /19.*% in Xero, not zero-rated/)
  assert.match(schemePostingTypeProblem([row()], 'TAX999') ?? '', /not in the stored Xero tax-rate list/)
  assert.match(schemePostingTypeProblem([row({ status: 'ARCHIVED' })], 'TAX131') ?? '', /ARCHIVED in Xero, not ACTIVE/)
  assert.match(schemePostingTypeProblem([row({ revenue: false })], 'TAX131') ?? '', /cannot be applied to revenue/)
  assert.match(schemePostingTypeProblem([row({ revenue: null })], 'TAX131') ?? '', /cannot be applied to revenue/)
  assert.match(schemePostingTypeProblem([row({ effectiveRate: null, displayTaxRate: null })], 'TAX131') ?? '', /not stated in Xero/)
  assert.match(schemePostingTypeProblem([row()], '  ') ?? '', /blank/)
})

test('a scheme order whose posting type is not proven zero-rated refuses, and the reason is the one given; a non-scheme order ignores it', () => {
  const de = schemeRows.find((r) => r.country === 'DE')!
  const built = build(de, { goodsSubtotal: '100.00' })
  const { plan } = route(built)
  const refused = applyEuVatTreatment(built.payload, { ...plan, schemePostingTypeProblem: 'the scheme posting type TAX131 is 19% in Xero, not zero-rated' })
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.reason, /19% in Xero, not zero-rated/)
  const uk = otherRows.find((r) => r.wooId === 112)!
  const ukBuilt = build(uk, { goodsSubtotal: '100.00', destination: 'GB', feeTaxed: false })
  const ukPlan = { ...route(ukBuilt).plan, lineKinds: ['goods', 'untaxed-fee'] as TreatedLineKind[], schemePostingTypeProblem: 'irrelevant' }
  assert.ok(applyEuVatTreatment(ukBuilt.payload, ukPlan).ok)
})

test('a positive shipping or order-discount amount with no account code refuses BEFORE any rounding allowance can absorb it', () => {
  const plan = (orderTotal: string): EuVatTreatmentPlan => ({
    route: { kind: 'scheme', regime: 'IOSS', vatAccount: '821', vatAmount: '19.00', schemePostingTaxType: 'TAX131', vatDescription: 'IOSS VAT collected — DE 19%' },
    lineKinds: ['goods'], feeAccount: '232', roundingAccount: '860', orderTotal, lineTax: ['19.00'], schemePostingTypeProblem: null,
  })
  const base = (): TreatablePayload => ({ currency: 'EUR', lines: [{ description: 'Widget', quantity: 1, unitAmount: 100, accountCode: '200', taxType: 'X' }], lineAmountsIncludeTax: false })
  // Control: with the account set, shipping 0.02 is part of the document and nothing is rounded.
  const withAccount = applyEuVatTreatment({ ...base(), shippingAmount: 0.02, shippingAccountCode: '260', shippingTaxType: 'X' }, plan('119.02'))
  assert.ok(withAccount.ok)
  assert.equal(withAccount.payload.lines.some((l) => l.noTaxKind === 'rounding-difference'), false)
  // Shipping with no account: the connector would drop it. 0.02 would have been taken for rounding; it is refused instead.
  for (const accountCode of ['', undefined]) {
    const dropped = applyEuVatTreatment({ ...base(), shippingAmount: 0.02, shippingAccountCode: accountCode, shippingTaxType: 'X' }, plan('119.02'))
    assert.equal(dropped.ok, false)
    assert.match(dropped.ok ? '' : dropped.reason, /positive shipping amount but no shipping account is set/)
  }
  assert.equal(applyEuVatTreatment({ ...base(), shippingAmount: 10, shippingAccountCode: '', shippingTaxType: 'X' }, plan('129.00')).ok, false)
  // The order discount likewise (total 118.98 = 100 + 19 - 0.02).
  const noDiscountAccount = applyEuVatTreatment({ ...base(), discountAmount: 0.02, discountAccountCode: '', discountTaxType: 'X' }, plan('118.98'))
  assert.equal(noDiscountAccount.ok, false)
  assert.match(noDiscountAccount.ok ? '' : noDiscountAccount.reason, /positive discount amount but no discount account is set/)
  assert.ok(applyEuVatTreatment({ ...base(), discountAmount: 0.02, discountAccountCode: '270', discountTaxType: 'X' }, plan('118.98')).ok)
  // A zero amount with no account is nothing to drop.
  assert.ok(applyEuVatTreatment({ ...base(), shippingAmount: 0, shippingAccountCode: '', shippingTaxType: 'X' }, plan('119.00')).ok)
})
