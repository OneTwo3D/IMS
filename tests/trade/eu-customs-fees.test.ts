/**
 * Parity table for the (unused, prepare-only) EU customs fee rule against wclc.
 *
 * Every row below is a case from wclc's own test suite (tests/run-tests.php on origin/main: the `uhf:`,
 * `uhf over threshold:`, `hs surcharge:` and `count_distinct_hs_codes:` groups), restated as input -> expected
 * fee. The module is called by nothing but this file.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  computeEuCustomsFees,
  countCustomsUnits,
  isUhfLive,
  type EuFeeConfig,
  type EuFeeInput,
  type EuFeeLineInput,
  type DutyQuoteState,
} from '@/lib/trade/eu-customs-fees'

const L = (...hsCodes: string[]): EuFeeLineInput => ({ hsCodes })
const AFTER = new Date('2026-11-02T12:00:00Z')

function run(over: Partial<EuFeeInput> & { lines: EuFeeLineInput[] }) {
  return computeEuCustomsFees({
    destinationCountry: 'DE',
    customer: 'private',
    consignmentValueEur: 100,
    at: AFTER,
    standardVatRatePercent: 19,
    ...over,
  })
}
const f = (v: { toFixed: (n: number) => string } | null | undefined) => (v ? v.toFixed(2) : null)

// --- wclc `uhf: is counted exactly like the duty` / `count_*` ---------------------------------------
const MIXED = [L('3926909790'), L('3926909710'), L('8477109000'), L(), L()]

test('parity: count_units - 2 codes + 2 uncoded lines = 4 units; not per SKU', () => {
  assert.deepEqual(countCustomsUnits(MIXED), { distinctHsCodes: 2, uncodedLines: 2, units: 4 })
})
test('parity: uncoded charge off drops the uncoded lines (units 2)', () => {
  assert.equal(countCustomsUnits(MIXED, { chargeUncoded: false }).units, 2)
})
test('parity: hs_digits 10 splits the shared six digits - 3 codes + 2 uncoded = 5', () => {
  assert.equal(countCustomsUnits(MIXED, { hsDigits: 10 }).units, 5)
})
test('parity: honours the configured digits (6 -> 1, 8 -> 2, 4 -> 1) on 3926909790 / 3926901090', () => {
  const lines = [L('3926909790'), L('3926901090')]
  assert.equal(countCustomsUnits(lines, { hsDigits: 6 }).distinctHsCodes, 1)
  assert.equal(countCustomsUnits(lines, { hsDigits: 8 }).distinctHsCodes, 2)
  assert.equal(countCustomsUnits(lines, { hsDigits: 4 }).distinctHsCodes, 1)
})
test('parity: out-of-range digits clamp (0 -> 1 digit, 99 -> 10)', () => {
  const lines = [L('3926909790'), L('3926901090')]
  assert.equal(countCustomsUnits(lines, { hsDigits: 0 }).distinctHsCodes, 1)
  assert.equal(countCustomsUnits(lines, { hsDigits: 99 }).distinctHsCodes, 2)
})
test('parity: a product carrying several codes counts each', () => {
  assert.equal(countCustomsUnits([L('3926909790', '8477109000')]).distinctHsCodes, 2)
})
test('parity: a value like "n/a" is not a code (no digits) - the line is uncoded; punctuation is stripped', () => {
  assert.deepEqual(countCustomsUnits([L(), L('n/a')]), { distinctHsCodes: 0, uncodedLines: 2, units: 2 })
  assert.equal(countCustomsUnits([L('3926.90.9790'), L('392690-9710')]).distinctHsCodes, 1)
})
test('parity: a code shorter than the digit count still counts, as its own prefix', () => {
  assert.equal(countCustomsUnits([L('3926'), L('392690')]).distinctHsCodes, 2)
})

// --- fee amounts ---------------------------------------------------------------------------------
test('parity: 3 units (2 distinct + 1 uncoded) -> EU Duty 9.00 and EU Customs Fee 6.00, both taxable', () => {
  const r = run({ lines: [L('3926909790'), L('3926909710'), L('8477109000'), L()] })
  assert.equal(r.regime, 'flat_rate')
  assert.equal(r.units, 3)
  assert.equal(f(r.duty?.net), '9.00')
  assert.equal(f(r.uhf?.net), '6.00')
  // VAT at the destination standard rate on BOTH (19%): 1.71 and 1.14.
  assert.equal(f(r.duty?.vat), '1.71')
  assert.equal(f(r.uhf?.vat), '1.14')
})
test('parity: only uncoded items - 2 x 3 charged per item; uncoded off and nothing coded charges nothing', () => {
  const r = run({ lines: [L(), L('n/a')] })
  assert.equal(f(r.duty?.net), '6.00')
  const off = run({ lines: [L()], config: { chargeUncoded: false } })
  assert.equal(off.duty, null)
  assert.equal(off.uhf, null)
})
test('parity: the date gate - 2026-10-31 23:59:59Z duty only; 2026-11-01 00:00:00Z both', () => {
  const lines = [L('3926909790'), L('8477109000')]
  const before = run({ lines, at: new Date('2026-10-31T23:59:59Z') })
  assert.equal(f(before.duty?.net), '6.00')
  assert.equal(before.uhf, null)
  const after = run({ lines, at: new Date('2026-11-01T00:00:00Z') })
  assert.equal(f(after.duty?.net), '6.00')
  assert.equal(f(after.uhf?.net), '4.00')
})
test('parity: the threshold - exactly 150 is the flat-rate regime (3 + 2); 150.01 is not', () => {
  const lines = [L('3926909790')]
  const at = run({ lines, consignmentValueEur: 150 })
  assert.equal(at.regime, 'flat_rate')
  assert.equal(f(at.duty?.net), '3.00')
  assert.equal(f(at.uhf?.net), '2.00')
  const above = run({ lines, consignmentValueEur: '150.01' })
  assert.equal(above.regime, 'over_threshold')
  assert.equal(above.duty, null) // no flat-rate duty line
  assert.equal(above.uhf, null) // and no separate Customs Fee line
  assert.notEqual(above.overThresholdUhf, null) // the fee rides on the Duty Fee line (non-vacuous)
})
test('parity: only EU-27 - Norway is out, Germany is in; GB and US are out', () => {
  const lines = [L('3926909790')]
  assert.equal(run({ lines, destinationCountry: 'NO' }).regime, 'not_applicable')
  assert.equal(run({ lines, destinationCountry: 'NO' }).reason, 'not_eu_27')
  assert.equal(run({ lines, destinationCountry: 'GB' }).regime, 'not_applicable')
  assert.equal(run({ lines, destinationCountry: 'US' }).regime, 'not_applicable')
  assert.equal(run({ lines, destinationCountry: 'de' }).regime, 'flat_rate')
  assert.equal(run({ lines, destinationCountry: ' ie ' }).regime, 'flat_rate')
})
test('parity: a business customer is charged nothing, as for the duty', () => {
  const r = run({ lines: [L('3926909790')], customer: 'business' })
  assert.equal(r.regime, 'not_applicable')
  assert.equal(r.reason, 'business_customer')
  assert.equal(r.duty, null)
  assert.equal(r.uhf, null)
})
test('parity: duty off, fee on - the Customs Fee alone (2.00)', () => {
  const r = run({ lines: [L('3926909790')], config: { dutyEnabled: false } })
  assert.equal(r.duty, null)
  assert.equal(f(r.uhf?.net), '2.00')
})
test('parity: the switch, amount and date are settings; amount 0, a later date and disabled owe nothing', () => {
  const lines = [L('3926909790'), L('8477109000')]
  assert.equal(run({ lines, config: { uhfEnabled: false } }).uhf, null)
  assert.equal(f(run({ lines, config: { uhfPerUnit: '2.50' } }).uhf?.net), '5.00')
  assert.equal(run({ lines, config: { uhfPerUnit: '0' } }).uhf, null)
  assert.equal(run({ lines, config: { uhfEffective: new Date('2027-01-01T00:00:00Z') } }).uhf, null)
  assert.equal(isUhfLive(new Date('2026-10-31T23:59:59.999Z')), false)
  assert.equal(isUhfLive(new Date('2026-11-01T00:00:00.000Z')), true)
})
test('parity: two codes, three lines (8477109000 twice) -> 6 + 4 = 10 net', () => {
  const r = run({ lines: [L('3926909790'), L('8477109000'), L('8477109000')] })
  assert.equal(f(r.duty?.net), '6.00')
  assert.equal(f(r.uhf?.net), '4.00')
})
test('no lines: nothing owed', () => {
  const r = run({ lines: [] })
  assert.equal(r.duty, null)
  assert.equal(r.uhf, null)
})

// --- VAT on the two taxable fees (rounded half up per line) --------------------------------------
test('VAT: Netherlands 21% on 2 units - duty 6.00 + 1.26, fee 4.00 + 0.84 (the wclc order fixture)', () => {
  const r = run({ lines: [L('3926909790'), L('8477109000')], standardVatRatePercent: 21 })
  assert.equal(f(r.duty?.vat), '1.26')
  assert.equal(f(r.uhf?.vat), '0.84')
})
test('VAT: half-up rounding to the cent, and no standard rate means no VAT line tax', () => {
  assert.equal(f(run({ lines: [L('1')], standardVatRatePercent: 23 }).uhf?.vat), '0.46')
  assert.equal(f(run({ lines: [L('1')], standardVatRatePercent: '7.5' }).uhf?.vat), '0.15')
  assert.equal(f(run({ lines: [L('1')], standardVatRatePercent: null }).uhf?.vat), '0.00')
})

// --- over EUR 150: UHF only, grossed -------------------------------------------------------------
test('over threshold parity: 1 unit at DE 19% -> 2.38 added, handling component 2.00, VAT part 0.38', () => {
  const r = run({ lines: [L('3926909790')], consignmentValueEur: 200 })
  assert.equal(f(r.overThresholdUhf?.gross), '2.38')
  assert.equal(f(r.overThresholdUhf?.handlingComponent), '2.00')
  assert.equal(f(r.overThresholdUhf?.taxPart), '0.38')
  // duty + tax + handling = the line: the wclc case 10 + 40 + 2.38 = 52.38 (duty and import tax come from the quote).
  assert.equal(Number(10 + 40) + Number(r.overThresholdUhf?.gross.toFixed(2)), 52.38)
})
test('over threshold parity: dutify mode never adds the fee', () => {
  const r = run({ lines: [L('3926909790')], consignmentValueEur: 200, config: { uhfOverThreshold: 'dutify' } })
  assert.equal(r.overThresholdUhf, null)
})
test('over threshold parity: a TAXABLE duty line takes the fee NET (never grossed AND taxed)', () => {
  const r = run({ lines: [L('3926909790')], consignmentValueEur: 200, config: { dutyFeeLineTaxable: true } })
  assert.equal(f(r.overThresholdUhf?.gross), '2.00')
  assert.equal(f(r.overThresholdUhf?.taxPart), '0.00')
})
test('over threshold parity: no standard rate - the fee goes in net and the gap is reported', () => {
  const r = run({ lines: [L('3926909790')], consignmentValueEur: 200, standardVatRatePercent: null })
  assert.equal(f(r.overThresholdUhf?.gross), '2.00')
  assert.equal(r.vatRateMissing, true)
})
test('over threshold: several units, and before the date nothing is added; a non-EU or business cart owes nothing', () => {
  const lines = [L('3926909790'), L('8477109000')]
  const r = run({ lines, consignmentValueEur: 200, standardVatRatePercent: 21 })
  assert.equal(f(r.overThresholdUhf?.gross), '4.84')
  assert.equal(f(r.overThresholdUhf?.handlingComponent), '4.00')
  assert.equal(run({ lines, consignmentValueEur: 200, at: new Date('2026-10-31T23:59:59Z') }).overThresholdUhf, null)
  assert.equal(run({ lines, consignmentValueEur: 200, destinationCountry: 'US' }).regime, 'not_applicable')
  assert.equal(run({ lines, consignmentValueEur: 200, customer: 'business' }).regime, 'not_applicable')
})
test('over threshold: the Dutify duty is not modelled - no duty and no Customs Fee line', () => {
  const r = run({ lines: [L('3926909790')], consignmentValueEur: 500 })
  assert.equal(r.duty, null)
  assert.equal(r.uhf, null)
})

test('config type: a partial override leaves the other defaults', () => {
  const cfg: Partial<EuFeeConfig> = { dutyPerUnit: '4' }
  const r = run({ lines: [L('3926909790')], config: cfg })
  assert.equal(f(r.duty?.net), '4.00')
  assert.equal(f(r.uhf?.net), '2.00')
})

// --- unknown value: unpriced, never the relieved regime ------------------------------------------------

test('unknown consignment value is UNPRICED, not read as 0 and so as the relieved flat-rate regime', () => {
  const lines = [L('3926909790')]
  for (const bad of [null, undefined, '', '   ', 'abc', Number.NaN, Number.POSITIVE_INFINITY, -1, '-5']) {
    const r = run({ lines, consignmentValueEur: bad as never })
    assert.equal(r.regime, 'unpriced', `value ${String(bad)}`)
    assert.equal(r.reason, 'value_unknown')
    assert.equal(r.duty, null)
    assert.equal(r.uhf, null)
    assert.equal(r.overThresholdUhf, null)
  }
  // Zero is a real value (a free-goods cart): relieved, charged per unit.
  assert.equal(run({ lines, consignmentValueEur: 0 }).regime, 'flat_rate')
  assert.equal(run({ lines, consignmentValueEur: '0' }).regime, 'flat_rate')
  // The gates come first, as in wclc: a business or non-EU cart is simply not applicable, value or no value.
  assert.equal(run({ lines, destinationCountry: 'US', consignmentValueEur: null as never }).regime, 'not_applicable')
  assert.equal(run({ lines, customer: 'business', consignmentValueEur: undefined }).regime, 'not_applicable')
})

// --- over EUR 150: where the UHF goes depends on what the Duty Fee could be priced from ------------------

const over = (extra: Partial<EuFeeInput> = {}) => run({ lines: [L('3926909790')], consignmentValueEur: 200, ...extra })
const FEE = (r: ReturnType<typeof over>) => r.overThresholdUhf

test('over threshold, wclc "exits that price no duty": no API key, the FX band, duty off, Calcurates stand-down -> the UHF alone 2.38, non-taxable', () => {
  const cases: Array<[string, ReturnType<typeof over>]> = [
    ['unconfigured (no key)', over({ dutyFee: { quote: 'unconfigured' } })],
    ['FX band (151, unusable quote)', over({ consignmentValueEur: 151, dutyFee: { quote: 'unusable' } })],
    ['duty switched off', over({ dutyFee: { dutyEnabled: false } })],
    ['Calcurates stand-down', over({ dutyFee: { calcuratesStandDown: true } })],
  ]
  for (const [name, r] of cases) {
    assert.equal(r.regime, 'over_threshold', name)
    assert.equal(f(FEE(r)?.gross), '2.38', name)
    assert.equal(FEE(r)?.placement, 'uhf_only_line', name)
    assert.equal(FEE(r)?.lineTaxable, false, name)
    assert.equal(f(FEE(r)?.handlingComponent), '2.00', name)
    assert.equal(r.dutyEstimate, null, name)
  }
})

test('those no-quote paths owe the UHF in EVERY over-threshold mode (dutify mode has no quote to hold it), even on a taxable duty_tax_class', () => {
  const dutify: Partial<EuFeeConfig> = { uhfOverThreshold: 'dutify', dutyFeeLineTaxable: true }
  assert.equal(f(FEE(over({ config: dutify, dutyFee: { dutyEnabled: false } }))?.gross), '2.38')
  assert.equal(f(FEE(over({ config: dutify, dutyFee: { calcuratesStandDown: true } }))?.gross), '2.38')
  assert.equal(f(FEE(over({ config: dutify, dutyFee: { quote: 'unconfigured' } }))?.gross), '2.38')
  assert.equal(f(FEE(over({ config: dutify, consignmentValueEur: 151, dutyFee: { quote: 'unusable' } }))?.gross), '2.38')
  // Duty off + taxable class: the line is forced non-taxable and grossed ("not taxed again either").
  assert.equal(FEE(over({ config: { dutyFeeLineTaxable: true }, dutyFee: { dutyEnabled: false } }))?.lineTaxable, false)
})

test('before 2026-11-01 those paths owe nothing, exactly the old behaviour', () => {
  const before = new Date('2026-10-31T12:00:00Z')
  for (const dutyFee of [{ quote: 'unconfigured' }, { dutyEnabled: false }, { calcuratesStandDown: true }] as const) {
    assert.equal(FEE(over({ at: before, dutyFee })), null)
  }
  assert.equal(FEE(over({ at: before, consignmentValueEur: 151, dutyFee: { quote: 'unusable' } })), null)
  assert.equal(FEE(over({ at: new Date('2026-11-01T00:00:00Z'), dutyFee: { quote: 'unconfigured' } }))?.gross.toFixed(2), '2.38')
})

test('usable quote: topped up onto the quote line, grossed (2.38); dutify mode adds nothing; a TAXABLE line takes it net (52.00 in wclc)', () => {
  const usable = over({ dutyFee: { quote: 'usable' } })
  assert.equal(f(FEE(usable)?.gross), '2.38')
  assert.equal(FEE(usable)?.placement, 'quote_line')
  assert.equal(over({ config: { uhfOverThreshold: 'dutify' } }).overThresholdUhf, null) // 50.0 in wclc: the quote as it came
  const taxable = over({ config: { dutyFeeLineTaxable: true } })
  assert.equal(f(FEE(taxable)?.gross), '2.00') // 10 + 40 + the NET fee 2 = 52.00
  assert.equal(FEE(taxable)?.lineTaxable, true)
})

test('"Dutify priced nothing": the UHF alone via the top-up - grossed, on its own non-taxable line, but off in dutify mode', () => {
  const none = over({ dutyFee: { quote: 'none' } })
  assert.equal(f(FEE(none)?.gross), '2.38')
  assert.equal(FEE(none)?.placement, 'uhf_only_line')
  assert.equal(FEE(none)?.lineTaxable, false)
  assert.equal(FEE(over({ dutyFee: { quote: 'none' }, config: { dutyFeeLineTaxable: true } }))?.lineTaxable, false) // "not taxed again either"
  assert.equal(FEE(over({ dutyFee: { quote: 'none' }, config: { uhfOverThreshold: 'dutify' } })), null)
})

test('deferred destination / no request: UNPRICED, no UHF', () => {
  for (const quote of ['deferred', 'no_request'] as DutyQuoteState[]) {
    const r = over({ dutyFee: { quote } })
    assert.equal(r.regime, 'unpriced')
    assert.equal(r.reason, quote === 'deferred' ? 'destination_deferred' : 'no_request')
    assert.equal(r.overThresholdUhf, null)
  }
})

test('unusable quote outside the band: the percent-of-goods estimate (2% of 200 = 4.00) plus the UHF whatever the mode says (4 + 2.38)', () => {
  const r = over({ dutyFee: { quote: 'unusable' } })
  assert.equal(f(r.dutyEstimate), '4.00')
  assert.equal(f(FEE(r)?.gross), '2.38')
  assert.equal(FEE(r)?.placement, 'fallback_line')
  assert.equal(FEE(r)?.lineTaxable, false)
  // Mode does not matter (no quote to hold the fee in).
  assert.equal(f(FEE(over({ dutyFee: { quote: 'unusable' }, config: { uhfOverThreshold: 'dutify' } }))?.gross), '2.38')
  // A taxable Duty Fee line: 4 + the NET fee 2 = 6.00 in wclc.
  const taxable = over({ dutyFee: { quote: 'unusable' }, config: { dutyFeeLineTaxable: true } })
  assert.equal(f(taxable.dutyEstimate), '4.00')
  assert.equal(f(FEE(taxable)?.gross), '2.00')
  assert.equal(FEE(taxable)?.lineTaxable, true)
})

test('unusable quote, fallback switched off or estimate a cent or less: the UHF alone, or nothing without it', () => {
  const off = over({ dutyFee: { quote: 'unusable' }, config: { dutyFallbackPercent: '0' } })
  assert.equal(off.dutyEstimate, null)
  assert.equal(f(FEE(off)?.gross), '2.38')
  assert.equal(FEE(off)?.placement, 'uhf_only_line')
  const tiny = over({ dutyFee: { quote: 'unusable' }, config: { dutyFallbackPercent: '0.001' } })
  assert.equal(tiny.dutyEstimate, null)
  assert.equal(FEE(tiny)?.placement, 'uhf_only_line')
  const beforeDate = over({ dutyFee: { quote: 'unusable' }, config: { dutyFallbackPercent: '0' }, at: new Date('2026-10-31T12:00:00Z') })
  assert.equal(FEE(beforeDate), null)
})

test('the FX band is [150, 153] inclusive of the top and the fallback applies beyond it', () => {
  const at = (v: number | string) => over({ consignmentValueEur: v, dutyFee: { quote: 'unusable' } })
  assert.equal(at('150.01').dutyEstimate, null) // in the band: UHF alone, no estimate
  assert.equal(at('153').dutyEstimate, null)
  assert.equal(f(at('153.01').dutyEstimate), '3.06') // beyond it: 2% of 153.01
})

// --- the module is unused until the switchover ----------------------------------------------------
test('unused until switchover: no production source imports the module', () => {
  const root = process.cwd()
  const importers: string[] = []
  let scanned = 0
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', 'generated', '.git'].includes(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|mjs|js)$/.test(name) || full.endsWith(path.join('lib', 'trade', 'eu-customs-fees.ts'))) continue
      scanned += 1
      if (readFileSync(full, 'utf8').includes('eu-customs-fees')) importers.push(path.relative(root, full))
    }
  }
  for (const dir of ['lib', 'app', 'scripts']) walk(path.join(root, dir))
  assert.ok(scanned > 500, `the scan must be non-vacuous (scanned ${scanned})`)
  assert.deepEqual(importers, [])
})
