import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOMESTIC_TERRITORIES, EU27, IOSS_THRESHOLD_EUR, REFUSAL_CODES, SCHEME_DESTINATIONS, VOEC_THRESHOLD_NOK, WARNING_CODES,
  resolveEuVatRegime, type EuVatRegimeDecision, type EuVatRegimeInput, type RateFact, type RateMappingFact,
} from '@/lib/domain/accounting/eu-vat-regime'

/** A scheme rate as the seed declares it: the destination's own IMS rate, IOSS (VOEC for NO) category, the zero-rated posting type. */
function schemeRate(country: string, over: Partial<Extract<RateMappingFact, { state: 'mapped' }>> = {}): RateMappingFact {
  return {
    state: 'mapped', imsRateId: `ims-${country}`, name: `${country} VAT`, active: true, countryCode: country, rate: '0.1900',
    reportingCategory: country === 'NO' ? 'VOEC' : 'IOSS', schemePostingTaxType: `TAX-${country}`, ...over,
  }
}
const plainRate = (country: string | null, rate = '0.2000', over: Partial<Extract<RateMappingFact, { state: 'mapped' }>> = {}): RateMappingFact => ({
  state: 'mapped', imsRateId: `ims-plain-${country ?? 'none'}`, name: `${country ?? 'XX'} plain`, active: true, countryCode: country, rate, reportingCategory: null, schemePostingTaxType: null, ...over,
})

/** A German order in EUR: goods 100.00, VAT 19.00 on the DE scheme rate, plugin record agreeing, accounts configured. */
function order(over: Partial<EuVatRegimeInput> = {}): EuVatRegimeInput {
  return {
    shippingCountry: 'DE', billingCountry: 'DE', currency: 'EUR',
    goodsLines: [{ total: '100.00', voucher: 'no' }],
    rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE') }],
    orderTax: '19.00', vatExempt: false, vatRecord: { state: 'absent' }, eas: { state: 'absent' },
    thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T00:00:00.000Z', source: 'same currency' },
    accounts: { ioss: '821', ddp: '232' }, pluginVatAccount: null, overThresholdDutyFee: false,
    ...over,
  }
}
const scheme = (d: EuVatRegimeDecision) => { assert.equal(d.kind, 'SCHEME', JSON.stringify(d)); return d as Extract<EuVatRegimeDecision, { kind: 'SCHEME' }> }
const refused = (d: EuVatRegimeDecision) => { assert.equal(d.kind, 'REFUSE', JSON.stringify(d)); return d as Extract<EuVatRegimeDecision, { kind: 'REFUSE' }> }
const eurOrderOf = (value: string, over: Partial<EuVatRegimeInput> = {}) => order({ goodsLines: [{ total: value, voucher: 'no' }], ...over })
const nokOrderOf = (value: string, over: Partial<EuVatRegimeInput> = {}) => order({
  shippingCountry: 'NO', billingCountry: 'NO', currency: 'NOK', goodsLines: [{ total: value, voucher: 'no' }],
  rates: [{ wooRateId: 239, tax: '500.00', mapping: schemeRate('NO', { rate: '0.2500' }) }], orderTax: '500.00',
  thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T00:00:00.000Z', source: 'same currency' },
  overThresholdDutyFee: false, ...over,
})

test('the thresholds and the destination allowlist are the law, as constants', () => {
  assert.equal(IOSS_THRESHOLD_EUR, '150')
  assert.equal(VOEC_THRESHOLD_NOK, '3000')
  assert.equal(EU27.size, 27)
  assert.equal(SCHEME_DESTINATIONS.size, 29)
  assert.ok(SCHEME_DESTINATIONS.has('MC') && SCHEME_DESTINATIONS.has('NO') && !EU27.has('MC') && !EU27.has('NO'))
  assert.ok(!SCHEME_DESTINATIONS.has('GB') && !SCHEME_DESTINATIONS.has('CH') && !SCHEME_DESTINATIONS.has('IM'))
  assert.deepEqual(Object.keys(DOMESTIC_TERRITORIES).sort(), ['GB', 'IM'])
})

// ---- the regime and the boundaries -------------------------------------------------------------------------------------------------------------------------------------------
const boundaryRows: Array<[string, EuVatRegimeInput, 'IOSS' | 'VOEC' | 'DDP', string]> = [
  ['EUR 149.99 is IOSS', eurOrderOf('149.99'), 'IOSS', '821'],
  ['EUR exactly 150.00 is IOSS (strictly above is DDP)', eurOrderOf('150.00'), 'IOSS', '821'],
  ['EUR 150.01 is DDP', eurOrderOf('150.01'), 'DDP', '232'],
  ['EUR 150.004 rounds to 150.00 at the minor unit: IOSS', eurOrderOf('150.004'), 'IOSS', '821'],
  ['EUR 150.005 rounds to 150.01: DDP', eurOrderOf('150.005'), 'DDP', '232'],
  ['NOK 2999.99 is VOEC', nokOrderOf('2999.99'), 'VOEC', '821'],
  ['NOK exactly 3000.00 is VOEC', nokOrderOf('3000.00'), 'VOEC', '821'],
  ['NOK 3000.01 is DDP', nokOrderOf('3000.01'), 'DDP', '232'],
  ['a coupon-reduced line below the threshold is IOSS', eurOrderOf('149.00'), 'IOSS', '821'],
  ['several lines add up past the threshold', order({ goodsLines: [{ total: '75.00', voucher: 'no' }, { total: '75.01', voucher: 'no' }] }), 'DDP', '232'],
  ['a gift card line is not goods: 100 + a 120 gift card is IOSS', order({ goodsLines: [{ total: '100.00', voucher: 'no' }, { total: '120.00', voucher: 'yes' }] }), 'IOSS', '821'],
  ['GBP 130 at 1.15 EUR is 149.50: IOSS', order({ currency: 'GBP', goodsLines: [{ total: '130.00', voucher: 'no' }], thresholdFx: { state: 'ok', rate: '1.15', sameCurrency: false, asOf: 'x', source: 'fx_rates' } }), 'IOSS', '821'],
  ['GBP 131 at 1.15 EUR is 150.65: DDP', order({ currency: 'GBP', goodsLines: [{ total: '131.00', voucher: 'no' }], thresholdFx: { state: 'ok', rate: '1.15', sameCurrency: false, asOf: 'x', source: 'fx_rates' } }), 'DDP', '232'],
  ['GBP 200 to Norway at 13.4 NOK is 2680: VOEC', nokOrderOf('200.00', { currency: 'GBP', thresholdFx: { state: 'ok', rate: '13.4', sameCurrency: false, asOf: 'x', source: 'fx_rates' } }), 'VOEC', '821'],
  ['GBP 230 to Norway at 13.4 NOK is 3082: DDP', nokOrderOf('230.00', { currency: 'GBP', thresholdFx: { state: 'ok', rate: '13.4', sameCurrency: false, asOf: 'x', source: 'fx_rates' } }), 'DDP', '232'],
]
for (const [name, input, regime, account] of boundaryRows) {
  test(`regime: ${name}`, () => {
    const decision = scheme(resolveEuVatRegime(input))
    assert.equal(decision.regime, regime)
    assert.equal(decision.vatAccount, account)
  })
}

test('a scheme decision states the VAT, the zero-rated posting type and what it rested on', () => {
  const d = scheme(resolveEuVatRegime(order({ thresholdFx: { state: 'ok', rate: '1', sameCurrency: true, asOf: '2026-11-01T10:00:00.000Z', source: 'same currency' } })))
  assert.equal(d.vatAmount, '19')
  assert.equal(d.schemePostingTaxType, 'TAX-DE')
  assert.deepEqual(d.basis, {
    destination: 'DE', thresholdCurrency: 'EUR', threshold: '150', intrinsicValue: '100', convertedValue: '100.00',
    fx: { rate: '1', sameCurrency: true, asOf: '2026-11-01T10:00:00.000Z', source: 'same currency' }, vatTotal: '19', wooRateIds: [216], imsRateIds: ['ims-DE'],
  })
  const no = scheme(resolveEuVatRegime(nokOrderOf('1000')))
  assert.equal(no.basis.thresholdCurrency, 'NOK')
  assert.equal(no.basis.threshold, '3000')
  assert.equal(no.schemePostingTaxType, 'TAX-NO')
})

test('the destination is the shipping country, else the billing country; UK and EL are normalised', () => {
  assert.equal(scheme(resolveEuVatRegime(order({ shippingCountry: null, billingCountry: 'de' }))).basis.destination, 'DE')
  // Shipping wins over billing: shipping to DE with a French billing address is a DE sale.
  assert.equal(scheme(resolveEuVatRegime(order({ shippingCountry: 'DE', billingCountry: 'FR' }))).basis.destination, 'DE')
  assert.equal(scheme(resolveEuVatRegime(order({ shippingCountry: 'EL', billingCountry: 'EL', rates: [{ wooRateId: 1, tax: '24', mapping: schemeRate('GR') }] }))).basis.destination, 'GR')
})

test('Monaco is on the scheme with its own rate', () => {
  const d = scheme(resolveEuVatRegime(order({ shippingCountry: 'MC', billingCountry: 'MC', rates: [{ wooRateId: 236, tax: '20.00', mapping: schemeRate('MC') }] })))
  assert.equal(d.basis.destination, 'MC')
  assert.equal(d.basis.thresholdCurrency, 'EUR')
})

test('two rates of one country on the same posting type (a region and its country) add up', () => {
  const d = scheme(resolveEuVatRegime(order({
    shippingCountry: 'PT', billingCountry: 'PT',
    rates: [
      { wooRateId: 241, tax: '10.00', mapping: schemeRate('PT', { imsRateId: 'pt-a' }) },
      { wooRateId: 242, tax: '3.00', mapping: schemeRate('PT', { imsRateId: 'pt-b' }) },
    ],
    orderTax: '13.00',
  })))
  assert.equal(d.vatAmount, '13')
  assert.deepEqual(d.basis.wooRateIds, [241, 242])
})

// ---- not on the scheme -------------------------------------------------------------------------------------------------------------------------------------------------------
test('skip: a UK order on UK VAT, a US order with no tax, a Swiss order with no tax', () => {
  for (const country of ['GB', 'US', 'CH']) {
    const rates: RateFact[] = country === 'GB' ? [{ wooRateId: 112, tax: '20.00', mapping: plainRate('GB') }] : []
    const d = resolveEuVatRegime(order({ shippingCountry: country, billingCountry: country, rates, orderTax: country === 'GB' ? '20.00' : '0' }))
    assert.deepEqual(d, { kind: 'SKIP', reason: 'no_scheme_vat', vatExemptB2b: false, warnings: [] })
  }
})

test('skip: the Isle of Man and the Channel Islands on their own rates', () => {
  for (const country of ['IM', 'JE', 'GG']) {
    const d = resolveEuVatRegime(order({ shippingCountry: country, billingCountry: country, rates: [{ wooRateId: 231, tax: '20.00', mapping: plainRate('IM') }], orderTax: '20.00' }))
    // IM VAT is ordinary on IM and GB only; JE and GG are not its territory.
    assert.equal(d.kind, country === 'IM' ? 'SKIP' : 'REFUSE', country)
  }
})

test('B2B: an EU buyer flagged VAT-exempt with no tax is a skip that says so; Norway and Monaco are not zero-rated that way', () => {
  const eu = resolveEuVatRegime(order({ vatExempt: true, rates: [], orderTax: '0' }))
  assert.deepEqual(eu, { kind: 'SKIP', reason: 'vat_exempt_b2b', vatExemptB2b: true, warnings: [] })
  for (const country of ['NO', 'MC', 'US']) {
    const d = resolveEuVatRegime(order({ shippingCountry: country, billingCountry: country, vatExempt: true, rates: [], orderTax: '0' }))
    assert.deepEqual(d, { kind: 'SKIP', reason: 'no_scheme_vat', vatExemptB2b: false, warnings: [] }, country)
  }
})

test('a zero-percent or zero-money EU rate (Canary Islands, a zero-rated class) moves no money and is ignored', () => {
  const d = resolveEuVatRegime(order({ shippingCountry: 'ES', billingCountry: 'ES', rates: [{ wooRateId: 223, tax: '0.00', mapping: plainRate('ES', '0.0000') }], orderTax: '0' }))
  assert.equal(d.kind, 'SKIP')
})

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const refusalRows: Array<[string, EuVatRegimeInput, (typeof REFUSAL_CODES)[number]]> = [
  ['Q1: an EU rate that moved money and is not on the scheme (an OSS-style rate)', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: plainRate('DE', '0.1900') }] }), 'eu_rated_not_on_scheme'],
  ['Q1: the same on a destination outside the EU', order({ shippingCountry: 'US', billingCountry: 'US', rates: [{ wooRateId: 216, tax: '19.00', mapping: plainRate('DE', '0.1900') }] }), 'eu_rated_not_on_scheme'],
  ['Q1: Norway rated but not on the scheme', nokOrderOf('1000', { rates: [{ wooRateId: 239, tax: '250', mapping: plainRate('NO', '0.2500') }] }), 'eu_rated_not_on_scheme'],
  ['an id with money and no mapping', order({ rates: [{ wooRateId: 999, tax: '19.00', mapping: { state: 'unmapped' } }] }), 'rate_unmapped'],
  ['an unmapped id on a non-EU order', order({ shippingCountry: 'US', billingCountry: 'US', rates: [{ wooRateId: 999, tax: '5.00', mapping: { state: 'unmapped' } }] }), 'rate_unmapped'],
  ['an inactive mapped rate with money', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE', { active: false }) }] }), 'rate_inactive'],
  ['a scheme category without a posting type', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE', { schemePostingTaxType: null }) }] }), 'scheme_misconfigured'],
  ['a posting type without a scheme category', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE', { reportingCategory: null }) }] }), 'scheme_misconfigured'],
  ['a blank posting type counts as none', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE', { schemePostingTaxType: '  ' }) }] }), 'scheme_misconfigured'],
  ['UK VAT charged on an order to Germany', order({ rates: [{ wooRateId: 112, tax: '20.00', mapping: plainRate('GB') }] }), 'domestic_rate_abroad'],
  ['UK VAT charged on an order to the US', order({ shippingCountry: 'US', billingCountry: 'US', rates: [{ wooRateId: 112, tax: '20.00', mapping: plainRate('GB') }] }), 'domestic_rate_abroad'],
  ['IM VAT charged on an order to Jersey', order({ shippingCountry: 'JE', billingCountry: 'JE', rates: [{ wooRateId: 231, tax: '20.00', mapping: plainRate('IM') }] }), 'domestic_rate_abroad'],
  ['a scheme rate on an order to the US', order({ shippingCountry: 'US', billingCountry: 'US' }), 'scheme_rate_outside_destination'],
  ['a scheme rate on an order with no destination', order({ shippingCountry: null, billingCountry: null }), 'scheme_rate_outside_destination'],
  ['tax charged to Germany with no scheme rate identified (the evidence is gone)', order({ rates: [], orderTax: '19.00' }), 'tax_without_scheme_rate'],
  ['tax charged to Germany on a rate with no country', order({ rates: [{ wooRateId: 5, tax: '19.00', mapping: plainRate(null) }], orderTax: '19.00' }), 'tax_without_scheme_rate'],
  ['two scheme posting types on one order', order({ rates: [{ wooRateId: 216, tax: '10.00', mapping: schemeRate('DE') }, { wooRateId: 217, tax: '9.00', mapping: schemeRate('DE', { imsRateId: 'other', schemePostingTaxType: 'TAX-OTHER' }) }] }), 'multiple_scheme_types'],
  ['a scheme rate of France on an order to Germany', order({ rates: [{ wooRateId: 218, tax: '19.00', mapping: schemeRate('FR') }] }), 'rate_country_mismatch'],
  ['a scheme rate with no country', order({ rates: [{ wooRateId: 218, tax: '19.00', mapping: schemeRate('DE', { countryCode: null }) }] }), 'rate_country_mismatch'],
  ['an IOSS-marked rate on Norway', nokOrderOf('1000', { rates: [{ wooRateId: 239, tax: '500', mapping: schemeRate('NO', { reportingCategory: 'IOSS' }) }] }), 'rate_scheme_mismatch'],
  ['a VOEC-marked rate on Germany', order({ rates: [{ wooRateId: 216, tax: '19.00', mapping: schemeRate('DE', { reportingCategory: 'VOEC' }) }] }), 'rate_scheme_mismatch'],
  ['VAT-exempt with scheme VAT charged', order({ vatExempt: true }), 'exempt_but_vat_charged'],
  ['the VAT record in another currency', order({ vatRecord: { state: 'present', currency: 'GBP', total: '19.00' } }), 'vat_record_currency_mismatch'],
  ['the VAT record disagreeing with the tax lines', order({ vatRecord: { state: 'present', currency: 'EUR', total: '19.50' } }), 'vat_record_mismatch'],
  ['no exchange rate for the threshold', order({ currency: 'GBP', thresholdFx: { state: 'unavailable', reason: 'no rate' } }), 'threshold_value_unavailable'],
  ['no IOSS account configured', order({ accounts: { ioss: null, ddp: '232' } }), 'vat_account_not_configured'],
  ['no IOSS account configured (blank)', order({ accounts: { ioss: ' ', ddp: '232' } }), 'vat_account_not_configured'],
  ['no DDP account configured on a DDP order', eurOrderOf('200.00', { accounts: { ioss: '821', ddp: '' } }), 'vat_account_not_configured'],
]
for (const [name, input, code] of refusalRows) {
  test(`refuse: ${name}`, () => {
    const d = refused(resolveEuVatRegime(input))
    assert.equal(d.code, code)
    assert.ok(d.reason.length > 10)
  })
}

test('every refusal code is exercised by a row above', () => {
  const seen = new Set(refusalRows.map((row) => row[2]))
  assert.deepEqual(REFUSAL_CODES.filter((code) => !seen.has(code)), [])
})

test('a refusal on an IOSS account does not apply to a DDP order, which needs only the DDP account', () => {
  assert.equal(scheme(resolveEuVatRegime(eurOrderOf('200.00', { accounts: { ioss: null, ddp: '232' } }))).vatAccount, '232')
})

test('the VAT record: within 0.02 agrees, an absent one never refuses, tax on a zero-money rate is not counted', () => {
  assert.equal(resolveEuVatRegime(order({ vatRecord: { state: 'present', currency: 'EUR', total: '19.02' } })).kind, 'SCHEME')
  assert.equal(resolveEuVatRegime(order({ vatRecord: { state: 'present', currency: null, total: '19.00' } })).kind, 'SCHEME')
  assert.equal(resolveEuVatRegime(order({ vatRecord: { state: 'absent' } })).kind, 'SCHEME')
})

test('a non-EU order with an unrelated rate and no scheme rate is a skip (not every foreign rate is a contradiction)', () => {
  const d = resolveEuVatRegime(order({ shippingCountry: 'AU', billingCountry: 'AU', rates: [{ wooRateId: 7, tax: '10.00', mapping: plainRate('AU', '0.1000') }], orderTax: '10.00' }))
  assert.equal(d.kind, 'SKIP')
})

// ---- warnings ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const warningCodes = (d: EuVatRegimeDecision) => (d.kind === 'REFUSE' ? [] : d.warnings.map((w) => w.code))

test('warning: a value within 5% of the threshold either side, and not just outside it', () => {
  const rows: Array<[string, boolean]> = [['142.50', true], ['142.49', false], ['150.00', true], ['157.50', true], ['157.51', false], ['100.00', false], ['200.00', false]]
  for (const [value, warned] of rows) {
    // the customs label agrees with accounting in every row, so only the band is in play
    const over = Number(value) > 150
    const d = resolveEuVatRegime(eurOrderOf(value, { overThresholdDutyFee: over }))
    assert.equal(warningCodes(d).includes('threshold_band'), warned, value)
  }
  assert.equal(warningCodes(resolveEuVatRegime(nokOrderOf('2850.00'))).includes('threshold_band'), true)
  assert.equal(warningCodes(resolveEuVatRegime(nokOrderOf('2849.99'))).includes('threshold_band'), false)
})

test('warning: the band is judged on the CONVERTED value (the order-date rate), and the basis records that rate', () => {
  const fx = { state: 'ok' as const, rate: '1.15', sameCurrency: false, asOf: '2026-11-01T00:00:00.000Z', source: 'fx_rates GBP/EUR' }
  const d = resolveEuVatRegime(order({ currency: 'GBP', goodsLines: [{ total: '130.00', voucher: 'no' }], thresholdFx: fx }))
  assert.ok(warningCodes(d).includes('threshold_band'))
  assert.equal(scheme(d).basis.convertedValue, '149.50')
  assert.equal(scheme(d).basis.fx.rate, '1.15')
  // A rate that moves the same goods across the boundary changes the regime, which is exactly what the warning is for.
  assert.equal(scheme(resolveEuVatRegime(order({ currency: 'GBP', goodsLines: [{ total: '130.00', voucher: 'no' }], thresholdFx: { ...fx, rate: '1.16' } }))).regime, 'DDP')
})

test('warning: the EAS figure disagreeing, and not when absent, in another currency or within 0.02', () => {
  const eas = (merchandiseVatExcl: string, currency: string | null) => order({ eas: { state: 'present', merchandiseVatExcl, currency } })
  assert.ok(warningCodes(resolveEuVatRegime(eas('90.00', 'EUR'))).includes('eas_disagrees'))
  assert.ok(!warningCodes(resolveEuVatRegime(eas('100.02', 'EUR'))).includes('eas_disagrees'))
  assert.ok(!warningCodes(resolveEuVatRegime(eas('90.00', 'GBP'))).includes('eas_disagrees'))
  assert.ok(!warningCodes(resolveEuVatRegime(order())).includes('eas_disagrees'))
  // EAS never decides: the regime follows the WooCommerce lines even when EAS says otherwise.
  assert.equal(scheme(resolveEuVatRegime(order({ eas: { state: 'present', merchandiseVatExcl: '500.00', currency: 'EUR' } }))).regime, 'IOSS')
})

test('warning: lines with no gift-card flag, only when counting them as goods is what decides', () => {
  // 100 known goods + an unflagged 60 line: DDP only because the unflagged line counts.
  const flips = resolveEuVatRegime(order({ goodsLines: [{ total: '100.00', voucher: 'no' }, { total: '60.00', voucher: 'unknown' }], overThresholdDutyFee: true }))
  assert.equal(scheme(flips).regime, 'DDP')
  assert.ok(warningCodes(flips).includes('voucher_flag_absent'))
  // The same lines with the flag read as no: no warning.
  assert.ok(!warningCodes(resolveEuVatRegime(order({ goodsLines: [{ total: '100.00', voucher: 'no' }, { total: '60.00', voucher: 'no' }], overThresholdDutyFee: true }))).includes('voucher_flag_absent'))
  // Unflagged lines that do not change the answer: no warning.
  assert.ok(!warningCodes(resolveEuVatRegime(order({ goodsLines: [{ total: '40.00', voucher: 'unknown' }] }))).includes('voucher_flag_absent'))
  // All lines unflagged and over the threshold: the answer rests on them being goods, so it warns (a DDP order whose lines carry no flag at all).
  assert.ok(warningCodes(resolveEuVatRegime(order({ goodsLines: [{ total: '400.00', voucher: 'unknown' }], overThresholdDutyFee: true }))).includes('voucher_flag_absent'))
  // Known goods alone already decide: unflagged extra lines change nothing.
  assert.ok(!warningCodes(resolveEuVatRegime(order({ goodsLines: [{ total: '400.00', voucher: 'no' }, { total: '10.00', voucher: 'unknown' }], overThresholdDutyFee: true }))).includes('voucher_flag_absent'))
})

test('warning (Q6): accounting and the customs label disagree, never a refusal', () => {
  const ddpNoFee = resolveEuVatRegime(eurOrderOf('200.00', { overThresholdDutyFee: false }))
  assert.equal(scheme(ddpNoFee).regime, 'DDP')
  assert.ok(warningCodes(ddpNoFee).includes('label_regime_disagrees'))
  const iossWithFee = resolveEuVatRegime(eurOrderOf('100.00', { overThresholdDutyFee: true }))
  assert.equal(scheme(iossWithFee).regime, 'IOSS')
  assert.ok(warningCodes(iossWithFee).includes('label_regime_disagrees'))
  assert.ok(!warningCodes(resolveEuVatRegime(eurOrderOf('200.00', { overThresholdDutyFee: true }))).includes('label_regime_disagrees'))
  assert.ok(!warningCodes(resolveEuVatRegime(eurOrderOf('100.00', { overThresholdDutyFee: false }))).includes('label_regime_disagrees'))
  // Norway is not compared: the label keeps VOEC possible with a prepaid fee.
  assert.ok(!warningCodes(resolveEuVatRegime(nokOrderOf('1000', { overThresholdDutyFee: true }))).includes('label_regime_disagrees'))
})

test('warning: the plugin recorded another VAT account (Q8 cross-check); the same one, or none, is quiet', () => {
  assert.ok(warningCodes(resolveEuVatRegime(order({ pluginVatAccount: '232' }))).includes('plugin_account_differs'))
  assert.ok(!warningCodes(resolveEuVatRegime(order({ pluginVatAccount: '821' }))).includes('plugin_account_differs'))
  assert.ok(!warningCodes(resolveEuVatRegime(order({ pluginVatAccount: null }))).includes('plugin_account_differs'))
})

test('every warning code is exercised', () => {
  assert.deepEqual([...WARNING_CODES].sort(), ['eas_disagrees', 'label_regime_disagrees', 'plugin_account_differs', 'threshold_band', 'voucher_flag_absent'])
})

test('the resolver does not mutate its input and is deterministic', () => {
  const input = order({ goodsLines: [{ total: '149.99', voucher: 'no' }] })
  const snapshot = JSON.stringify(input)
  const first = resolveEuVatRegime(input)
  assert.equal(JSON.stringify(input), snapshot)
  assert.deepEqual(resolveEuVatRegime(input), first)
})
