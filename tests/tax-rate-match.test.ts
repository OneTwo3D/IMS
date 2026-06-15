import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchTaxRates,
  normalizeTaxName,
  ratesEqual,
  suggestedAutoApply,
  type ImsRateLite,
  type WcRateLite,
  type XeroRateLite,
} from '@/lib/tax/tax-rate-match'

// audit-wrwr: rate-first, then normalized-name matching across IMS/WC/Xero.

test('normalizeTaxName lowercases and strips non-alphanumerics', () => {
  assert.equal(normalizeTaxName('UK Standard Rate'), 'ukstandardrate')
  assert.equal(normalizeTaxName('20% (UK)'), '20uk')
  assert.equal(normalizeTaxName('Standard-rate'), 'standardrate')
})

test('ratesEqual tolerates rounding within half a basis point', () => {
  assert.equal(ratesEqual(20, 20.0000), true)
  assert.equal(ratesEqual(20, 19.9999), true)
  assert.equal(ratesEqual(20, 20.004), true)
  assert.equal(ratesEqual(20, 19.5), false)
  assert.equal(ratesEqual(20, 19.99), false)
  assert.equal(ratesEqual(Number.NaN, 20), false)
})

const ims = (id: string, name: string, ratePct: number, accountingTaxType: string | null = null): ImsRateLite =>
  ({ id, name, ratePct, accountingTaxType })
const wc = (externalTaxRateId: string, externalName: string, externalRatePct: number, taxRateId: string | null = null): WcRateLite =>
  ({ externalTaxRateId, externalName, externalRatePct, taxRateId })
const xr = (taxType: string, name: string, ratePct: number): XeroRateLite => ({ taxType, name, ratePct })

test('exact rate+name match wins over a rate-only candidate (two-pass priority)', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'UK Standard', 20)],
    wcRates: [wc('w1', 'Reduced', 20), wc('w2', 'UK Standard', 20)],
    xeroRates: [],
  })
  // Both WC rates are 20%, but the perfect name+rate match must be chosen.
  assert.equal(result.rows[0].wc.match?.externalTaxRateId, 'w2')
  assert.equal(result.rows[0].wc.confidence, 'rate+name')
  // The other 20% WC rate is left unmatched (consumed-once).
  assert.deepEqual(result.unmatchedWc.map((w) => w.externalTaxRateId), ['w1'])
})

test('matches WC "Standard rate" 20% to IMS "UK Standard" 20% by rate when names differ', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'UK Standard', 20)],
    wcRates: [wc('w1', 'Standard rate', 20)],
    xeroRates: [],
  })
  assert.equal(result.rows[0].wc.match?.externalTaxRateId, 'w1')
  assert.equal(result.rows[0].wc.confidence, 'rate')
  assert.equal(result.rows[0].wc.rateConflict, false)
})

test('name matches but rate differs => conflict (name confidence), never auto-applied', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20)],
    wcRates: [wc('w1', 'Standard', 17.5)],
    xeroRates: [],
  })
  assert.equal(result.rows[0].wc.confidence, 'name')
  assert.equal(result.rows[0].wc.rateConflict, true)
  // suggestedAutoApply must exclude conflicts.
  assert.equal(suggestedAutoApply(result).wcLinks.length, 0)
})

test('0% Zero/Exempt/reverse-charge disambiguate by name, not by colliding rate', () => {
  const result = matchTaxRates({
    imsRates: [ims('zero', 'Zero Rated', 0), ims('exempt', 'Exempt', 0)],
    wcRates: [wc('wz', 'Zero rated', 0), wc('we', 'Exempt', 0)],
    xeroRates: [],
  })
  const byId = Object.fromEntries(result.rows.map((r) => [r.ims.id, r.wc.match?.externalTaxRateId]))
  assert.equal(byId['zero'], 'wz')
  assert.equal(byId['exempt'], 'we')
})

test('Xero match sets accountingTaxType suggestion; already-set is not re-suggested', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'UK Standard', 20, null), ims('i2', 'Reduced', 5, 'OUTPUT3')],
    wcRates: [],
    xeroRates: [xr('OUTPUT2', '20% (VAT on Income)', 20), xr('OUTPUT3', '5% Reduced', 5)],
  })
  const apply = suggestedAutoApply(result)
  // i1 gets OUTPUT2 suggested; i2 already OUTPUT3 so not re-suggested.
  assert.deepEqual(apply.xeroLinks, [{ taxRateId: 'i1', accountingTaxType: 'OUTPUT2' }])
})

test('auto-apply never overwrites an already-set accountingTaxType (no clobber)', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20, 'MANUAL_TYPE')], // already set, deliberately
    wcRates: [],
    xeroRates: [xr('OUTPUT2', 'Standard', 20)],
  })
  assert.equal(suggestedAutoApply(result).xeroLinks.length, 0)
})

test('auto-apply never re-maps a WC rate already mapped to another IMS rate (no clobber)', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20), ims('i2', 'Also 20', 20)],
    wcRates: [wc('w1', 'Standard', 20, 'i2')], // already mapped to i2
    xeroRates: [],
  })
  assert.equal(suggestedAutoApply(result).wcLinks.length, 0)
})

test('leftover WC rate with no IMS hub appears in unmatchedWc', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20)],
    wcRates: [wc('w1', 'Standard', 20), wc('w2', 'Some Other', 12.5)],
    xeroRates: [],
  })
  assert.deepEqual(result.unmatchedWc.map((w) => w.externalTaxRateId), ['w2'])
})

test('already-mapped WC link is not re-suggested', () => {
  const result = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20)],
    wcRates: [wc('w1', 'Standard', 20, 'i1')], // already mapped to i1
    xeroRates: [],
  })
  assert.equal(suggestedAutoApply(result).wcLinks.length, 0)
})

test('deterministic under shuffled input order', () => {
  const a = matchTaxRates({
    imsRates: [ims('i1', 'Standard', 20), ims('i2', 'Reduced', 5)],
    wcRates: [wc('w1', 'Standard', 20), wc('w2', 'Reduced', 5)],
    xeroRates: [xr('O2', 'Standard', 20), xr('O3', 'Reduced', 5)],
  })
  const b = matchTaxRates({
    imsRates: [ims('i2', 'Reduced', 5), ims('i1', 'Standard', 20)],
    wcRates: [wc('w2', 'Reduced', 5), wc('w1', 'Standard', 20)],
    xeroRates: [xr('O3', 'Reduced', 5), xr('O2', 'Standard', 20)],
  })
  const pick = (r: ReturnType<typeof matchTaxRates>) =>
    r.rows.map((row) => [row.ims.id, row.wc.match?.externalTaxRateId, row.xero.match?.taxType]).sort()
  assert.deepEqual(pick(a), pick(b))
})
