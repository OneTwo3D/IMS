import assert from 'node:assert/strict'
import test from 'node:test'

import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { DRIFT_MAX_STALENESS_MS } from '@/lib/domain/accounting/tax-rate-drift-status'
import {
  REKEY_OUTCOMES, applyRefusal, digestRekeyPlan, imsMeaningDifference, pickXeroHoldEnv, xeroHoldState, matchRekeyRates, projectRatesAfterRekey, readRekeyPlan, rekeyRegionDifference, runTaxRekey, xeroNameCountry,
  type RekeyImsRate, type RekeyPlan, type RekeyReferences,
} from '@/lib/tax/tax-rekey'
import { TAX_REKEY_EXIT_CODES, parseTaxRekeyArgs, renderTaxRekeyText, taxRekeyExitCode } from '@/lib/tax/tax-rekey-cli'
import { compareVatSets, type ImsRateRow, type ImsXeroSnapshot } from '@/lib/tax/vat-difference-report'
import { xeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'
import { isOrganisationSpecificTaxType } from '@/lib/tax/xero-built-in-tax-types'
import { runTaxRekeyCli } from '../../scripts/tax-rekey'

/**
 * THE RE-KEY OF IMS TAX RATES TO THE CUSTOM CODES OF THE CONNECTED XERO ORGANISATION (lib/tax/tax-rekey.ts): the matcher is pure and tested on fixtures in the SHAPE of the live
 * list (names such as "CY VAT" 19%, codes numbered per organisation, not copied from it); the list proof over an in-memory client; the command line with doubles. What is committed
 * to a real database (the apply, the re-pointing, the fence, the preview writing nothing) is in tests/concurrency/tax-rekey*.concurrent.test.ts.
 * Each guard has a `[mutation: ...]` line: the change that turns its arm red (made, seen red, reverted).
 */

const TENANT = 'tenant-live'
const NOW = new Date('2026-10-25T12:00:00Z')
const FETCHED = new Date('2026-10-25T11:30:00Z')

/** A live type's own VAT-return treatment defaults to what IMS assigns a sales rate of that name (the same helper that creates Xero rates). */
const reportOf = (name: string, pct: string): string => xeroReportTaxType({ reportingCategory: null, usedFor: 'SALES', name, rate: Number(pct) / 100 })
const xeroRow = (taxType: string, name: string, pct: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({
  taxType, name, status: 'ACTIVE', reportTaxType: reportOf(name, pct), effectiveRate: `${pct}.000000`, displayTaxRate: `${pct}.000000`,
  components: pct === '0' ? [] : [{ name: 'VAT', rate: `${pct}.000000`, compound: false, nonRecoverable: false }],
  canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true }, ...over,
})
const ims = (id: string, name: string, code: string | null, fraction: string, over: Partial<RekeyImsRate> = {}): RekeyImsRate => ({
  id, name, rate: fraction, usedFor: 'SALES', countryCode: name.slice(0, 2), accountingTaxType: code, isDefault: false, components: [], ...over,
})
const match = (rates: RekeyImsRate[], xero: NormalisedXeroTaxRate[]) => matchRekeyRates({ rates, xero })
const outcomeOf = (rates: RekeyImsRate[], xero: NormalisedXeroTaxRate[], id: string) => match(rates, xero).rows.find((r) => r.imsRateId === id)!

/** The Demo-organisation numbering on the IMS side against the live organisation's: the same codes mean other rates. */
const LIVE = [
  xeroRow('TAX004', 'BE VAT', '21'), xeroRow('TAX005', 'BG VAT', '20'), xeroRow('TAX013', 'FR VAT', '20'), xeroRow('TAX020', 'IT VAT', '22'),
  xeroRow('TAX008', 'CY VAT', '19', { canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: true } }), xeroRow('TAX012', 'GR VAT', '24'), xeroRow('TAX018', 'LU VAT', '17'), xeroRow('OUTPUT2', '20% (VAT on Income)', '20'),
]
const DEMO = [
  ims('cy', 'CY VAT', 'TAX005', '0.1900'), ims('gr', 'GR VAT', 'TAX013', '0.2400'), ims('lu', 'LU VAT', 'TAX020', '0.1700'),
  ims('be', 'BE VAT', 'TAX021', '0.2100'), ims('bg', 'BG VAT', 'TAX006', '0.2000'), ims('uk', 'UK VAT', 'OUTPUT2', '0.2000', { countryCode: 'GB' }),
]

// ---- the matcher ----------------------------------------------------------------------------------------

// [mutation: the match made by code (`xero.find((r) => r.taxType === currentCode)`) -> "CY VAT" is tied to live TAX005 = "BG VAT" and the arm fails]
test('REKEY: a rate is tied to the live type of the SAME NAME, never to the live type that has its code', () => {
  const rows = match(DEMO, LIVE).rows
  const cy = rows.find((r) => r.imsRateId === 'cy')!
  assert.deepEqual([cy.outcome, cy.currentCode, cy.target?.taxType, cy.target?.name, cy.matchedBy], ['REKEY', 'TAX005', 'TAX008', 'CY VAT', 'EXACT'])
  assert.deepEqual(rows.filter((r) => r.outcome === 'REKEY').map((r) => `${r.name}:${r.currentCode}->${r.target!.taxType}`).sort(), [
    'BE VAT:TAX021->TAX004', 'BG VAT:TAX006->TAX005', 'CY VAT:TAX005->TAX008', 'GR VAT:TAX013->TAX012', 'LU VAT:TAX020->TAX018',
  ])
})

test('ALREADY_CORRECT: the code already points at the same-named, active, same-percentage live type', () => {
  const row = outcomeOf([ims('cy', 'CY VAT', 'TAX008', '0.1900')], LIVE, 'cy')
  assert.deepEqual([row.outcome, row.target?.taxType], ['ALREADY_CORRECT', 'TAX008'])
})

test('NO_MATCH: no live type has the name ("CI VAT" exists only in the Demo organisation), even though live TAX004 exists', () => {
  const row = outcomeOf([ims('ci', 'CI VAT', 'TAX004', '0.1800', { countryCode: 'CI' })], LIVE, 'ci')
  assert.deepEqual([row.outcome, row.matchedBy, row.target], ['NO_MATCH', null, null])
})

test('built-in codes and rates with no code are out of scope; every other code is organisation-specific', () => {
  const plan = match([...DEMO, ims('none', 'Local', null, '0.0500', { countryCode: null })], LIVE)
  assert.deepEqual([plan.inScope, plan.outOfScope], [5, 2])
  assert.equal(plan.rows.some((r) => r.imsRateId === 'uk' || r.imsRateId === 'none'), false)
  assert.deepEqual(['TAX001', 'TAX999', 'CUSTOMX'].map(isOrganisationSpecificTaxType), [true, true, true])
  assert.deepEqual(['OUTPUT2', 'INPUT2', 'NONE', 'ZERORATEDOUTPUT'].map(isOrganisationSpecificTaxType), [false, false, false, false])
})

// [mutation: the percentage comparison removed (a name match is enough) -> the arm fails: the wrong-percentage rate is re-keyed]
test('PERCENTAGE_DIFFERS: a name match with another percentage is shown with both numbers and is NOT re-keyed', () => {
  const row = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '18')], 'cy')
  assert.deepEqual([row.outcome, row.imsPercent, row.target?.percent, row.target?.taxType], ['PERCENTAGE_DIFFERS', '19', '18', 'TAX008'])
  assert.match(row.reason, /18% .* 19%/)
  assert.equal(match([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '18')]).counts.REKEY, 0)
})

// [mutation: only the rate column compared (the components' effective percentage ignored) -> the arm fails]
test('PERCENTAGE_DIFFERS also when the percentage tax is computed at (the active components) differs although the rate column is right', () => {
  const rate = ims('cy', 'CY VAT', 'TAX005', '0.1900', { components: [{ rate: '0.1800', compoundOnPrevious: false, active: true, sortOrder: 0 }] })
  const row = outcomeOf([rate], LIVE, 'cy')
  assert.deepEqual([row.outcome, row.imsPercent, row.imsEffectivePercent], ['PERCENTAGE_DIFFERS', '19', '18'])
})

test('percentages are compared exactly, not rounded: 19.0001 against 19 differs, 19.0000 equals 19', () => {
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { effectiveRate: '19.000100' })], 'cy').outcome, 'PERCENTAGE_DIFFERS')
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { effectiveRate: '19.000000' })], 'cy').outcome, 'REKEY')
})

test('the percentage is Xero\'s EffectiveRate, else DisplayTaxRate', () => {
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { effectiveRate: null })], 'cy').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { effectiveRate: null, displayTaxRate: '20.000000' })], 'cy').outcome, 'PERCENTAGE_DIFFERS')
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { effectiveRate: null, displayTaxRate: null })], 'cy').outcome, 'PERCENTAGE_DIFFERS')
})

// [mutation: the status filter removed -> an ARCHIVED live type is re-keyed to]
test('NAME_MATCHES_INACTIVE: the only live types with the name are not ACTIVE', () => {
  const row = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19', { status: 'ARCHIVED' }), xeroRow('TAX009', 'CY VAT', '19', { status: 'DELETED' })], 'cy')
  assert.deepEqual([row.outcome, row.target], ['NAME_MATCHES_INACTIVE', null])
  assert.equal(row.candidates.length, 2)
})

test('an inactive duplicate does not make the name ambiguous: the one ACTIVE live type is the match', () => {
  const row = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19'), xeroRow('TAX009', 'CY VAT', '19', { status: 'ARCHIVED' })], 'cy')
  assert.deepEqual([row.outcome, row.target?.taxType], ['REKEY', 'TAX008'])
})

// [mutation: the candidate count check removed (take the first) -> the arm fails]
test('AMBIGUOUS: more than one active live type with the name is refused, not guessed', () => {
  const row = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19'), xeroRow('TAX030', 'CY VAT', '19')], 'cy')
  assert.deepEqual([row.outcome, row.target], ['AMBIGUOUS', null])
  assert.match(row.reason, /TAX008, TAX030/)
  // Even when only one of them has the right percentage: which one is meant is still a guess.
  assert.equal(outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT', '19'), xeroRow('TAX030', 'CY VAT', '20')], 'cy').outcome, 'AMBIGUOUS')
})

// [mutation: the case-insensitive tier tried first / always -> the exact-first arm fails]
test('the name comparison is trimmed and case-sensitive FIRST; case-insensitive only when that finds nothing, and the plan says which', () => {
  const exactWins = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', ' CY VAT ', '19'), xeroRow('TAX030', 'cy vat', '19')], 'cy')
  assert.deepEqual([exactWins.outcome, exactWins.matchedBy, exactWins.target?.taxType], ['REKEY', 'EXACT', 'TAX008'])
  const folded = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX030', 'Cy Vat', '19')], 'cy')
  assert.deepEqual([folded.outcome, folded.matchedBy, folded.target?.taxType], ['REKEY', 'CASE_INSENSITIVE', 'TAX030'])
  const twoFolded = outcomeOf([ims('cy', 'CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX030', 'Cy Vat', '19'), xeroRow('TAX031', 'cy vat', '19')], 'cy')
  assert.deepEqual([twoFolded.outcome, twoFolded.matchedBy], ['AMBIGUOUS', 'CASE_INSENSITIVE'])
  assert.equal(outcomeOf([ims('cy', '  CY VAT', 'TAX005', '0.1900')], [xeroRow('TAX008', 'CY VAT  ', '19')], 'cy').matchedBy, 'EXACT')
})

// [mutation: the country check removed -> "CY VAT" for a Greek rate is re-keyed to the Cyprus type]
test('country: an IMS country and a Xero name prefix must agree; no IMS country, or no prefix, is no objection', () => {
  const live = [xeroRow('TAX008', 'CY VAT', '19')]
  assert.deepEqual([outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'GR' })], live, 'x').outcome, outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'GR' })], live, 'x').target?.taxType], ['COUNTRY_DIFFERS', 'TAX008'])
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'CY' })], live, 'x').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: null })], live, 'x').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: 'GB' })], [xeroRow('TAX040', 'Standard', '20')], 'x').outcome, 'REKEY')
  // UK is the IMS/Xero spelling of GB.
  assert.equal(outcomeOf([ims('x', 'UK VAT', 'TAX005', '0.2000', { countryCode: 'GB' })], [xeroRow('TAX040', 'UK VAT', '20')], 'x').outcome, 'REKEY')
  assert.deepEqual([xeroNameCountry('CY VAT'), xeroNameCountry('EL VAT'), xeroNameCountry('Zero Rated'), xeroNameCountry('20% (VAT on Income)'), xeroNameCountry('cy VAT'), xeroNameCountry(' Uk-VAT'), xeroNameCountry('el vat')], ['CY', 'GR', null, null, 'CY', 'GB', 'GR'])
})

// [mutation: the prefix parse made uppercase-only again -> the lowercase-disagreeing arm re-keys a Bulgarian rate to the Cyprus type]
test('country prefixes are parsed CASE-INSENSITIVELY, like the name comparison: IMS "CY VAT" (country BG) against a live "cy VAT" is refused; lowercase agreeing re-keys; an IMS name that disagrees with its own country is refused', () => {
  const lowerLive = (name: string) => [xeroRow('TAX008', name, '19')]
  const bg = outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'BG' })], lowerLive('cy VAT'), 'x')
  assert.deepEqual([bg.outcome, bg.matchedBy, bg.target?.taxType], ['COUNTRY_DIFFERS', 'CASE_INSENSITIVE', 'TAX008'], 'the lowercase live prefix is a country statement')
  assert.match(bg.reason, /live name prefix CY.*IMS name prefix CY.*IMS country BG/)
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'CY' })], lowerLive('cy VAT'), 'x').outcome, 'REKEY', 'lowercase agreeing')
  assert.equal(outcomeOf([ims('x', 'cy VAT', 'TAX005', '0.1900', { countryCode: 'cy' })], lowerLive('CY VAT'), 'x').outcome, 'REKEY', 'case differs on the IMS side, all agree')
  // The IMS row's own name disagrees with its country, even against an identical live name.
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'BG' })], lowerLive('CY VAT'), 'x').outcome, 'COUNTRY_DIFFERS')
  assert.equal(outcomeOf([ims('x', 'cy VAT', 'TAX005', '0.1900', { countryCode: 'BG' })], lowerLive('cy VAT'), 'x').outcome, 'COUNTRY_DIFFERS')
  // No country on the IMS row: the name statements alone agree, so it re-keys; and a name with no prefix is no statement.
  assert.equal(outcomeOf([ims('x', 'cy VAT', 'TAX005', '0.1900', { countryCode: null })], lowerLive('CY VAT'), 'x').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: 'GB' })], [xeroRow('TAX040', 'standard', '20')], 'x').outcome, 'REKEY')
})

// [mutation: the duplicate-target blocker removed -> two rates are tied to one live type]
test('BLOCKERS: two rates re-keying to one live type on an overlapping side, and a live type another active rate keeps', () => {
  const duplicate = match([ims('a', 'CY VAT', 'TAX005', '0.1900', { usedFor: 'SALES' }), ims('b', 'CY VAT', 'TAX006', '0.1900', { usedFor: 'BOTH' })], LIVE)
  assert.deepEqual(duplicate.blockers.map((b) => [b.code, b.taxType]), [['DUPLICATE_TARGET', 'TAX008']])
  // A purchase-only rate files to INPUT, a sales rate of an EU name to MOSSSALES: one live type cannot be both, so they never collide on it.
  assert.deepEqual(match([ims('a', 'CY VAT', 'TAX005', '0.1900', { usedFor: 'SALES' }), ims('b', 'CY VAT', 'TAX006', '0.1900', { usedFor: 'PURCHASE' })], LIVE).blockers, [])
  // An unrelated active rate ("Other") already holds the live code TAX008 and stays.
  const held = match([ims('cy', 'CY VAT', 'TAX005', '0.1900'), ims('other', 'Other VAT', 'TAX008', '0.0500')], LIVE)
  assert.deepEqual(held.blockers.map((b) => [b.code, b.imsRateId, b.taxType]), [['TARGET_CODE_HELD', 'cy', 'TAX008']])
  // A holder that is itself re-keyed away frees the code (the swap): no blocker.
  const swap = match([ims('cy', 'CY VAT', 'TAX005', '0.1900'), ims('gr', 'GR VAT', 'TAX008', '0.2400')], LIVE)
  assert.deepEqual(swap.blockers, [])
  assert.deepEqual(swap.rows.map((r) => `${r.name}:${r.outcome}`).sort(), ['CY VAT:REKEY', 'GR VAT:REKEY'])
})

test('every outcome is reachable and the counts add up', () => {
  const live = [
    xeroRow('TAX008', 'CY VAT', '19'), xeroRow('TAX012', 'GR VAT', '24'), xeroRow('TAX004', 'BE VAT', '21'), xeroRow('TAX050', 'BE VAT', '21'),
    xeroRow('TAX018', 'LU VAT', '17'), xeroRow('TAX013', 'FR VAT', '20', { status: 'ARCHIVED' }),
    xeroRow('TAX060', 'DE VAT', '19', { canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: false } }),
    xeroRow('TAX062', 'IE VAT', '23', { reportTaxType: 'OUTPUT' }), xeroRow('TAX063', 'PT VAT', '23', { reportTaxType: null }),
    xeroRow('TAX064', 'FI VAT', '24'),
    xeroRow('TAX061', 'ES VAT', '21', { components: [{ name: 'a', rate: '10.000000', compound: false, nonRecoverable: false }, { name: 'b', rate: '11.000000', compound: false, nonRecoverable: false }] }),
  ]
  const plan = match([
    ims('ok', 'CY VAT', 'TAX008', '0.1900'), ims('mv', 'GR VAT', 'TAX013', '0.2400'), ims('no', 'CI VAT', 'TAX004', '0.1800', { countryCode: 'CI' }),
    ims('am', 'BE VAT', 'TAX021', '0.2100'), ims('pd', 'LU VAT', 'TAX020', '0.1500'), ims('in', 'FR VAT', 'TAX013', '0.2000'),
    ims('sd', 'DE VAT', 'TAX070', '0.1900'), ims('md', 'ES VAT', 'TAX071', '0.2100'), ims('cd', 'FI VAT', 'TAX074', '0.2400', { countryCode: 'SE' }), ims('rd', 'IE VAT', 'TAX072', '0.2300'), ims('ru', 'PT VAT', 'TAX073', '0.2300'),
  ], live)
  const byId = Object.fromEntries(plan.rows.map((r) => [r.imsRateId, r.outcome]))
  assert.deepEqual(byId, { ok: 'ALREADY_CORRECT', mv: 'REKEY', no: 'NO_MATCH', am: 'AMBIGUOUS', pd: 'PERCENTAGE_DIFFERS', in: 'NAME_MATCHES_INACTIVE', sd: 'SIDE_NOT_ALLOWED', md: 'MEANING_DIFFERS', cd: 'COUNTRY_DIFFERS', rd: 'REPORT_TYPE_DIFFERS', ru: 'REPORT_TYPE_UNKNOWN' })
  assert.equal(REKEY_OUTCOMES.filter((o) => o !== 'CLEAR').every((o) => plan.counts[o] === 1), true, 'CLEAR exists only with the clear-unresolved choice')
  assert.equal(plan.counts.CLEAR, 0)
})

// [mutation: clearedComponents always empty -> the arm fails]
test('components: a custom code that is not a live ACTIVE type is listed to be cleared on a REKEY; built-in and live-valid codes are kept; ALREADY_CORRECT lists none', () => {
  const comp = (sortOrder: number, code: string | null) => ({ name: `c${sortOrder}`, rate: '0.1900', compoundOnPrevious: false, active: sortOrder === 0, sortOrder, accountingTaxType: code })
  const live = [...LIVE, xeroRow('TAX077', 'Other VAT', '5', { status: 'ARCHIVED' })]
  const rate = ims('cy', 'CY VAT', 'TAX005', '0.1900', { components: [comp(0, 'TAX099'), comp(1, 'OUTPUT2'), comp(2, 'TAX012'), comp(3, null), comp(4, 'TAX077')] })
  const row = match([rate], live).rows[0]!
  assert.equal(row.outcome, 'REKEY')
  assert.deepEqual(row.clearedComponents.map((c) => [c.sortOrder, c.taxType]), [[0, 'TAX099'], [4, 'TAX077']])
  const ok = match([ims('cy', 'CY VAT', 'TAX008', '0.1900', { components: [comp(0, 'TAX099')] })], live).rows[0]!
  assert.deepEqual([ok.outcome, ok.clearedComponents], ['ALREADY_CORRECT', []])
  const base = planOf()
  assert.notEqual(digestRekeyPlan({ ...base, rows: base.rows.map((r) => r.imsRateId === 'cy' ? { ...r, clearedComponents: [{ sortOrder: 0, name: 'c', taxType: 'TAX099' }] } : r) }), base.digest, 'the digest covers the cleared components')
})

// [mutation: the canApply check removed -> the arm fails]
test('SIDE_NOT_ALLOWED: the live type must be allowed on every side the IMS rate is used for (revenue for sales, expenses for purchases, both for BOTH)', () => {
  const can = (revenue: boolean, expenses: boolean) => ({ assets: false, equity: false, expenses, liabilities: false, revenue })
  const at = (usedFor: string, revenue: boolean, expenses: boolean) => outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { usedFor })], [xeroRow('TAX008', 'CY VAT', '19', { canApply: can(revenue, expenses), ...(usedFor === 'PURCHASE' ? { reportTaxType: 'INPUT' } : {}) })], 'x')
  assert.equal(at('SALES', false, true).outcome, 'SIDE_NOT_ALLOWED')
  assert.equal(at('PURCHASE', true, false).outcome, 'SIDE_NOT_ALLOWED')
  assert.equal(at('BOTH', true, false).outcome, 'SIDE_NOT_ALLOWED')
  assert.match(at('BOTH', true, false).reason, /expenses/)
  assert.deepEqual(['SALES', 'PURCHASE', 'BOTH'].map((u) => at(u, u !== 'PURCHASE', u !== 'SALES').outcome), ['REKEY', 'REKEY', 'REKEY'], 'control: allowed sides re-key')
})

// [mutation: the component comparison removed -> the arm fails; mutation: the non-recoverable check removed -> the last assertion fails]
test('MEANING_DIFFERS: same percentage but another component breakdown, another compounding, or a non-recoverable component is not re-keyed; equal breakdowns are', () => {
  const part = (rate: string, compound = false, nonRecoverable = false) => ({ name: 'p', rate, compound, nonRecoverable })
  const comp = (rate: string, sortOrder: number, compoundOnPrevious = false) => ({ rate, compoundOnPrevious, active: true, sortOrder })
  const two = [comp('0.1000', 0), comp('0.1100', 1)]
  const at = (components: ReturnType<typeof comp>[], live: ReturnType<typeof part>[], pct = '21') => outcomeOf([ims('x', 'ES VAT', 'TAX005', Number(pct) / 100 === 0.21 ? '0.2100' : '0.1900', { components })], [xeroRow('TAX008', 'ES VAT', pct, { components: live })], 'x')
  assert.equal(at(two, [part('10.000000'), part('11.000000')]).outcome, 'REKEY', 'control: the same two components')
  assert.equal(at([], [part('21.000000')]).outcome, 'REKEY', 'control: no IMS components equals one live component at the rate')
  assert.equal(at(two, [part('21.000000')]).outcome, 'MEANING_DIFFERS')
  assert.match(at(two, [part('21.000000')]).reason, /2 component\(s\).*1/)
  assert.equal(at(two, [part('9.000000'), part('12.000000')]).outcome, 'MEANING_DIFFERS')
  assert.equal(at(two, [part('10.000000'), part('11.000000', true)]).outcome, 'MEANING_DIFFERS')
  assert.equal(at([], [part('21.000000', false, true)]).outcome, 'MEANING_DIFFERS')
  assert.match(at([], [part('21.000000', false, true)]).reason, /non-recoverable/)
})

// [mutation: the report-type comparison removed -> the differs arms fail; mutation: the helper replaced by a constant OUTPUT -> the EU / EC / purchase arms fail]
test('REPORT TYPE: the live type must file to the VAT-return box IMS assigns the rate (the same helper that creates Xero rates); a mismatch is shown with both values, also on an already-correct code; an undecidable one is refused', () => {
  const at = (rate: RekeyImsRate, live: NormalisedXeroTaxRate) => outcomeOf([rate], [live], rate.id)
  const eu = ims('x', 'CY VAT', 'TAX005', '0.1900')
  // EU sales name -> MOSSSALES (OSS/IOSS/VOEC), not OUTPUT.
  const wrong = at(eu, xeroRow('TAX008', 'CY VAT', '19', { reportTaxType: 'OUTPUT' }))
  assert.deepEqual([wrong.outcome, wrong.reportType], ['REPORT_TYPE_DIFFERS', { expected: 'MOSSSALES', live: 'OUTPUT' }])
  assert.match(wrong.reason, /MOSSSALES.*OUTPUT/)
  assert.equal(at(eu, xeroRow('TAX008', 'CY VAT', '19', { reportTaxType: 'mosssales' })).outcome, 'REKEY', 'case-insensitive, and the matching type re-keys')
  // The same check on a code that already points at the right name.
  assert.equal(at(ims('x', 'CY VAT', 'TAX008', '0.1900'), xeroRow('TAX008', 'CY VAT', '19', { reportTaxType: 'OUTPUT' })).outcome, 'REPORT_TYPE_DIFFERS')
  assert.equal(at(ims('x', 'CY VAT', 'TAX008', '0.1900'), xeroRow('TAX008', 'CY VAT', '19')).outcome, 'ALREADY_CORRECT')
  // Category, side and zero rate decide as the helper does.
  assert.equal(at(ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: null, reportingCategory: 'EC_SALES' }), xeroRow('TAX040', 'Standard', '20', { reportTaxType: 'ECOUTPUTSERVICES' })).outcome, 'REKEY')
  assert.equal(at(ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: null, reportingCategory: 'REVERSE_CHARGE' }), xeroRow('TAX040', 'Standard', '20', { reportTaxType: 'OUTPUT' })).reportType.expected, 'REVERSECHARGES')
  assert.equal(at(ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: null, usedFor: 'PURCHASE' }), xeroRow('TAX040', 'Standard', '20', { reportTaxType: 'INPUT', canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } })).outcome, 'REKEY')
  assert.equal(at(ims('x', 'CY VAT', 'TAX005', '0.1900', { usedFor: 'PURCHASE' }), xeroRow('TAX008', 'CY VAT', '19', { canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } })).outcome, 'REPORT_TYPE_DIFFERS', 'a purchase-only EU rate files to INPUT, not MOSSSALES')
  // Undecidable: the live type states none, or the category is one IMS does not map.
  const unknownLive = at(eu, xeroRow('TAX008', 'CY VAT', '19', { reportTaxType: null }))
  assert.deepEqual([unknownLive.outcome, unknownLive.reportType.live], ['REPORT_TYPE_UNKNOWN', null])
  assert.equal(at(ims('x', 'CY VAT', 'TAX005', '0.1900', { reportingCategory: 'SOMETHING_NEW' }), xeroRow('TAX008', 'CY VAT', '19')).outcome, 'REPORT_TYPE_UNKNOWN')
  assert.equal(at(ims('x', 'CY VAT', 'TAX005', '0.1900', { reportingCategory: 'oss' }), xeroRow('TAX008', 'CY VAT', '19')).outcome, 'REKEY', 'the category is normalised like the helper does')
  // The digest binds it.
  const base = planOf()
  assert.notEqual(digestRekeyPlan({ ...base, rows: base.rows.map((r) => r.imsRateId === 'cy' ? { ...r, reportType: { expected: 'MOSSSALES', live: 'OUTPUT' } } : r) }), base.digest)
})

// [mutation: IOSS or VOEC dropped from the helper's decidable set -> the REKEY arms fail; mutation: decidable whatever the helper says -> the UNKNOWN arms fail; the same set serves R13]
test('REPORT TYPE: an IOSS or VOEC rate re-keys where the helper files it under MOSSSALES (an EU or Norway sales rate), is REPORT_TYPE_DIFFERS against another box, and stays UNKNOWN where the helper would only guess', () => {
  const at = (rate: RekeyImsRate, live: NormalisedXeroTaxRate) => outcomeOf([rate], [live], rate.id)
  const ioss = ims('x', 'AT IOSS VAT', 'TAX005', '0.2000', { reportingCategory: 'IOSS' })
  assert.deepEqual([at(ioss, xeroRow('TAX126', 'AT IOSS VAT', '20')).outcome, at(ioss, xeroRow('TAX126', 'AT IOSS VAT', '20')).reportType], ['REKEY', { expected: 'MOSSSALES', live: 'MOSSSALES' }])
  assert.equal(at({ ...ioss, reportingCategory: ' ioss ' }, xeroRow('TAX126', 'AT IOSS VAT', '20')).outcome, 'REKEY', 'normalised like the helper does')
  const wrong = at(ioss, xeroRow('TAX126', 'AT IOSS VAT', '20', { reportTaxType: 'OUTPUT' }))
  assert.deepEqual([wrong.outcome, wrong.reportType], ['REPORT_TYPE_DIFFERS', { expected: 'MOSSSALES', live: 'OUTPUT' }])
  assert.equal(at(ioss, xeroRow('TAX126', 'AT IOSS VAT', '20', { reportTaxType: null })).outcome, 'REPORT_TYPE_UNKNOWN', 'a live type with no report type is still unknown')
  const voec = ims('x', 'NO VOEC VAT', 'TAX005', '0.2500', { reportingCategory: 'VOEC', countryCode: 'NO' })
  assert.equal(at(voec, xeroRow('TAX127', 'NO VOEC VAT', '25')).outcome, 'REKEY')
  // Undecidable: no EU / Norway name prefix (the helper would give OUTPUT), or a purchase-only marker (INPUT).
  const guess = at(ims('x', 'GB IOSS VAT', 'TAX005', '0.2000', { reportingCategory: 'IOSS', countryCode: 'GB' }), xeroRow('TAX126', 'GB IOSS VAT', '20'))
  assert.deepEqual([guess.outcome, guess.reportType.expected], ['REPORT_TYPE_UNKNOWN', 'OUTPUT'])
  assert.equal(at({ ...voec, name: 'GB VOEC VAT', countryCode: 'GB' }, xeroRow('TAX127', 'GB VOEC VAT', '25')).outcome, 'REPORT_TYPE_UNKNOWN')
  assert.equal(at({ ...ioss, usedFor: 'PURCHASE' }, xeroRow('TAX126', 'AT IOSS VAT', '20', { canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: false } })).outcome, 'REPORT_TYPE_UNKNOWN')
  assert.equal(at({ ...ioss, reportingCategory: 'IOSSX' }, xeroRow('TAX126', 'AT IOSS VAT', '20')).outcome, 'REPORT_TYPE_UNKNOWN', 'a near-miss token is not recognised')
})

// [mutation: the region check removed from the candidate filter -> the unreadable arm fails; mutation: an unreadable region treated as no region -> the same arm fails; mutation: regions compared by country only -> the direct PT-30 / PT-20 arm fails]
test('REGION: the region the two names state must agree (PT-30 against PT-20 refuses, PT-30 against PT-30 re-keys); an unreadable region is refused; a name with no region suffix is unchanged', () => {
  // The decision itself, on every pair (the name tiers make a differing readable region unreachable through the matcher today).
  assert.equal(rekeyRegionDifference('PT-30 VAT', 'PT-30 VAT', 'PT'), null)
  assert.equal(rekeyRegionDifference('PT-30 VAT', 'pt-30 vat', 'PT'), null, 'case does not count')
  assert.match(rekeyRegionDifference('PT-30 VAT', 'PT-20 VAT', 'PT')!, /regions differ.*30.*20/)
  assert.match(rekeyRegionDifference('PT-30 VAT', 'PT VAT', 'PT')!, /regions differ/, 'regional against country-wide')
  assert.match(rekeyRegionDifference('PT VAT', 'PT-30 VAT', 'PT')!, /regions differ/, 'country-wide against regional')
  assert.match(rekeyRegionDifference('PT Madeira VAT', 'PT Madeira VAT', 'PT')!, /cannot be read/)
  assert.match(rekeyRegionDifference('PT VAT', 'PT Madeira VAT', 'PT')!, /cannot be read/, 'unreadable on the live side only')
  assert.match(rekeyRegionDifference('PT Madeira VAT', 'PT VAT', 'PT')!, /cannot be read/, 'unreadable on the IMS side only')
  for (const plain of ['CY VAT', 'GB VAT (Income)', 'UK Standard Rate (20%)', '20% (VAT on Income)', 'Standard']) assert.equal(rekeyRegionDifference(plain, plain, 'CY'), null, plain)
  // Through the matcher.
  const regional = (name: string, liveName: string, countryCode: string | null = 'PT') => outcomeOf([ims('x', name, 'TAX005', '0.2200', { countryCode })], [xeroRow('TAX130', liveName, '22')], 'x')
  assert.deepEqual([regional('PT-30 VAT', 'PT-30 VAT').outcome, regional('PT-30 VAT', 'PT-30 VAT').target?.taxType], ['REKEY', 'TAX130'])
  assert.equal(regional('PT-30 VAT', 'PT-30 VAT', null).outcome, 'REKEY', 'no IMS country code: the name prefix is the country')
  assert.equal(regional('PT-30 VAT', 'PT-20 VAT').outcome, 'NO_MATCH', 'the name tier never offers a candidate of another region')
  const both = outcomeOf([ims('x', 'PT-30 VAT', 'TAX005', '0.2200', { countryCode: 'PT' })], [xeroRow('TAX131', 'PT-20 VAT', '22'), xeroRow('TAX130', 'PT-30 VAT', '22')], 'x')
  assert.deepEqual([both.outcome, both.target?.taxType], ['REKEY', 'TAX130'])
  const unreadable = regional('PT Madeira VAT', 'PT Madeira VAT')
  assert.deepEqual([unreadable.outcome, unreadable.target?.taxType], ['COUNTRY_DIFFERS', 'TAX130'])
  assert.match(unreadable.reason, /region.*cannot be read/)
  // Unchanged without a region suffix.
  assert.equal(regional('PT VAT', 'PT VAT').outcome, 'REKEY')
  assert.equal(outcomeOf(DEMO, LIVE, 'cy').outcome, 'REKEY')
  // A country disagreement still reads as one.
  assert.match(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'BG' })], [xeroRow('TAX008', 'CY VAT', '19')], 'x').reason, /country statements disagree/)
})

// [mutation: the tiers trim only (no whitespace collapse) -> the double-space arm fails; mutation: the case-insensitive tier does not collapse -> the folded arm fails; mutation: the exact tier made case-insensitive -> the exact-first arm fails]
test('the name tiers collapse internal whitespace like R13: IMS "AT IOSS VAT" matches the live "AT IOSS  VAT"; the case-sensitive tier still comes first', () => {
  const rate = ims('at', 'AT IOSS VAT', 'TAX005', '0.2000')
  const double = outcomeOf([rate], [xeroRow('TAX126', 'AT IOSS  VAT', '20')], 'at')
  assert.deepEqual([double.outcome, double.matchedBy, double.target?.taxType, double.target?.name], ['REKEY', 'EXACT', 'TAX126', 'AT IOSS  VAT'], 'the plan names the live name as it is')
  assert.equal(outcomeOf([ims('at', 'AT  IOSS VAT', 'TAX005', '0.2000')], [xeroRow('TAX126', 'AT IOSS VAT', '20')], 'at').matchedBy, 'EXACT', 'the IMS side too')
  assert.equal(outcomeOf([rate], [xeroRow('TAX126', ' AT\tIOSS \u00a0 VAT ', '20')], 'at').matchedBy, 'EXACT', 'tabs and non-breaking spaces are whitespace')
  const folded = outcomeOf([rate], [xeroRow('TAX126', 'at ioss   VAT', '20')], 'at')
  assert.deepEqual([folded.outcome, folded.matchedBy], ['REKEY', 'CASE_INSENSITIVE'])
  const exactFirst = outcomeOf([rate], [xeroRow('TAX126', 'AT IOSS  VAT', '20'), xeroRow('TAX127', 'at ioss vat', '20')], 'at')
  assert.deepEqual([exactFirst.outcome, exactFirst.matchedBy, exactFirst.target?.taxType], ['REKEY', 'EXACT', 'TAX126'])
  const two = outcomeOf([rate], [xeroRow('TAX126', 'AT IOSS  VAT', '20'), xeroRow('TAX127', 'AT  IOSS VAT', '20')], 'at')
  assert.deepEqual([two.outcome, two.matchedBy], ['AMBIGUOUS', 'EXACT'])
  assert.equal(outcomeOf([rate], [xeroRow('TAX126', 'ATIOSS VAT', '20')], 'at').outcome, 'NO_MATCH', 'a removed space is not a collapse')
})

// ---- the digest and the refusals to apply ---------------------------------------------------------------

const refs = (over: Partial<RekeyReferences> = {}): RekeyReferences => ({
  suppliers: 1, storefrontMappings: 1, isDefault: false, unpostedSalesOrders: 0, unpostedSalesOrderLines: 0, unpostedPurchaseOrders: 0, unpostedPurchaseOrderLines: 0,
  queuedSyncRows: 0, queuedEvents: 0, postedSalesOrders: 0, postedSalesOrderLines: 0, postedPurchaseOrders: 0, postedPurchaseOrderLines: 0, cancelledSalesOrders: 0, cancelledSalesOrderLines: 0, cancelledPurchaseOrders: 0, cancelledPurchaseOrderLines: 0, pendingRefunds: 0, pendingRefundLines: 0, refundSnapshotConflict: false, ...over,
})
const planOf = (referenceOver: Partial<RekeyReferences> = {}): RekeyPlan => {
  const matched = match(DEMO, LIVE)
  const references = Object.fromEntries(matched.rows.filter((r) => r.outcome === 'REKEY').map((r) => [r.imsRateId, refs(referenceOver)]))
  const plan: RekeyPlan = { list: { tenantId: TENANT, fetchedAt: FETCHED.toISOString(), rowCount: LIVE.length, digest: digestTaxRateList(TENANT, LIVE) }, ...matched, references, clearUnresolved: false, digest: '' }
  plan.digest = digestRekeyPlan(plan)
  return plan
}

// [mutation: the digest ignores the rows (only the list digest) -> the changed-row arm fails; mutation: it includes list.fetchedAt -> the hourly re-read arm fails]
test('the digest is stable, changes with any decision-bearing fact, and ignores facts that only move because time passes', () => {
  const base = planOf()
  assert.match(base.digest, /^[0-9a-f]{64}$/)
  assert.equal(planOf().digest, base.digest)
  assert.equal(digestRekeyPlan({ ...base, list: { ...base.list, fetchedAt: new Date(FETCHED.getTime() + 3_600_000).toISOString() } }), base.digest, 'the hourly re-read of an unchanged list keeps the digest')
  assert.notEqual(planOf({ postedSalesOrders: 1, postedSalesOrderLines: 2 }).digest, base.digest, 'an already-posted order is a future posting source, so it is part of the plan')
  assert.notEqual(planOf({ unpostedSalesOrders: 1 }).digest, base.digest, 'an order that became unposted')
  assert.notEqual(planOf({ suppliers: 2 }).digest, base.digest, 'a supplier that now references the rate')
  assert.notEqual(digestRekeyPlan({ ...base, rows: base.rows.map((r) => r.imsRateId === 'cy' ? { ...r, target: { ...r.target!, taxType: 'TAX099' } } : r) }), base.digest, 'a different target code')
  assert.notEqual(digestRekeyPlan({ ...base, list: { ...base.list, digest: digestTaxRateList(TENANT, LIVE.slice(1)) } }), base.digest, 'a different list')
})

// [mutation: any one check dropped from applyRefusal -> that arm fails]
test('applyRefusal: blockers and queued payloads always refuse; unposted orders refuse unless the explicit flag is passed', () => {
  assert.equal(applyRefusal(planOf(), false), null)
  assert.equal(applyRefusal(planOf({ unpostedSalesOrders: 2, unpostedSalesOrderLines: 3 }), false)?.code, 'UNPOSTED_DOCUMENTS')
  assert.equal(applyRefusal(planOf({ unpostedPurchaseOrders: 1, unpostedPurchaseOrderLines: 1 }), false)?.code, 'UNPOSTED_DOCUMENTS')
  // An ALREADY-POSTED order still re-reads its lines' rate on an edit / re-send / credit note / refund / further bill: it blocks too (a part-billed PO, an invoiced SO).
  assert.equal(applyRefusal(planOf({ postedSalesOrders: 1, postedSalesOrderLines: 1 }), false)?.code, 'UNPOSTED_DOCUMENTS')
  assert.equal(applyRefusal(planOf({ postedPurchaseOrders: 1, postedPurchaseOrderLines: 1 }), false)?.code, 'UNPOSTED_DOCUMENTS')
  assert.equal(applyRefusal(planOf({ postedSalesOrders: 1, postedPurchaseOrders: 1 }), true), null, 'control: the flag lets posted sources through')
  assert.equal(applyRefusal(planOf({ unpostedSalesOrders: 2 }), true), null, 'control: the flag lets unposted orders through')
  // CANCELLED documents never block (they are re-pointed by every apply) but are part of the plan the digest binds.
  assert.equal(applyRefusal(planOf({ cancelledSalesOrders: 3, cancelledSalesOrderLines: 4, cancelledPurchaseOrders: 1, cancelledPurchaseOrderLines: 1 }), false), null)
  assert.notEqual(planOf({ cancelledSalesOrders: 1 }).digest, planOf().digest)
  // Pending refund-line snapshots: no queued payload exists, yet a retry would send the old code.
  assert.equal(applyRefusal(planOf({ pendingRefunds: 1, pendingRefundLines: 2 }), false)?.code, 'PENDING_REFUND_SNAPSHOTS')
  assert.equal(applyRefusal(planOf({ pendingRefunds: 1, pendingRefundLines: 2 }), true), null, 'control: the flag migrates them')
  assert.equal(applyRefusal(planOf({ pendingRefunds: 1, pendingRefundLines: 2, refundSnapshotConflict: true }), true)?.code, 'REFUND_SNAPSHOT_IDENTITY', 'no flag migrates a snapshot whose identity is not the old row\'s')
  assert.equal(applyRefusal(planOf({ refundSnapshotConflict: true }), false), null, 'a conflict with no pending refund line is nothing to migrate')
  assert.equal(applyRefusal(planOf({ queuedSyncRows: 1 }), true)?.code, 'QUEUED_PAYLOADS', 'no flag overrides a queued payload')
  assert.equal(applyRefusal(planOf({ queuedEvents: 1 }), false)?.code, 'QUEUED_PAYLOADS')
  assert.equal(applyRefusal({ ...planOf(), blockers: [{ code: 'DUPLICATE_TARGET', imsRateId: 'a', taxType: 'TAX008', detail: 'x' }] }, true)?.code, 'PLAN_HAS_BLOCKERS')
})

test('an apply without the exact digest refuses before anything is read', async () => {
  for (const confirm of [undefined, '', 'abc', 'G'.repeat(64), 'a'.repeat(63)]) {
    const result = await runTaxRekey({ apply: true, confirm })
    assert.deepEqual([result.refusal?.code, result.wrote, result.plan], ['CONFIRM_REQUIRED', false, null], String(confirm))
  }
})

// ---- the proof of the stored list -----------------------------------------------------------------------

const decimal = (s: string) => ({ toFixed: (dp?: number) => (dp === undefined ? s : Number(s).toFixed(dp)) })
type State = { list: NormalisedXeroTaxRate[] | null; tenant?: string; fetchedAt?: Date; stamp?: string | null; headerDigest?: string; rates?: Array<RekeyImsRate> }
function client(state: State) {
  const list = state.list
  const tenant = state.tenant ?? TENANT
  const fetchedAt = state.fetchedAt ?? FETCHED
  return {
    xeroTaxRateList: { findMany: async () => (list === null ? [] : [{ connector: 'xero', tenantId: tenant, fetchedAt, rowCount: list.length, digest: state.headerDigest ?? digestTaxRateList(tenant, list) }]) },
    xeroTaxRate: {
      findMany: async () => (list ?? []).map((r) => ({
        connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType,
        effectiveRate: r.effectiveRate === null ? null : decimal(r.effectiveRate), displayTaxRate: r.displayTaxRate === null ? null : decimal(r.displayTaxRate),
        components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: r.canApply.equity, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: r.canApply.liabilities, canApplyToRevenue: r.canApply.revenue,
      })),
    },
    setting: { findUnique: async () => { const stamp = state.stamp === undefined ? fetchedAt.toISOString() : state.stamp; return stamp === null ? null : { value: stamp } } },
    taxRate: {
      findMany: async () => (state.rates ?? DEMO).map((r) => ({ id: r.id, name: r.name, rate: decimal(r.rate), usedFor: r.usedFor, countryCode: r.countryCode, accountingTaxType: r.accountingTaxType, isDefault: r.isDefault, components: [] })),
    },
    supplier: { count: async () => 1 },
    salesOrderRefundLine: { findMany: async () => [] },
    shoppingTaxRateMapping: { count: async () => 2 },
    salesOrder: { findMany: async () => [] },
    purchaseOrder: { findMany: async () => [] },
    accountingSyncLog: { findMany: async () => [] },
    accountingEvent: { findMany: async () => [] },
    $queryRaw: async () => [{ n: BigInt(0) }],
  } as never
}

test('a trusted stored list gives a plan (control for the refusals below)', async () => {
  const read = await readRekeyPlan(client({ list: LIVE }), { now: NOW, connectedTenantId: TENANT })
  assert.equal(read.ok, true)
  if (read.ok) {
    assert.equal(read.plan.counts.REKEY, 5)
    assert.deepEqual(Object.values(read.plan.references)[0], { suppliers: 1, storefrontMappings: 2, isDefault: false, unpostedSalesOrders: 0, unpostedSalesOrderLines: 0, unpostedPurchaseOrders: 0, unpostedPurchaseOrderLines: 0, postedSalesOrders: 0, postedSalesOrderLines: 0, postedPurchaseOrders: 0, postedPurchaseOrderLines: 0, cancelledSalesOrders: 0, cancelledSalesOrderLines: 0, cancelledPurchaseOrders: 0, cancelledPurchaseOrderLines: 0, pendingRefunds: 0, pendingRefundLines: 0, refundSnapshotConflict: false, queuedSyncRows: 0, queuedEvents: 0 })
    const again = await readRekeyPlan(client({ list: LIVE }), { now: NOW, connectedTenantId: TENANT })
    assert.equal(again.ok && again.plan.digest, read.plan.digest, 'the same state gives the same digest')
  }
})

// [mutation: each refusal replaced by a pass-through -> its arm returns a plan and fails]
test('an untrusted or stale stored list is REFUSED with the import\'s own codes, never planned from', async () => {
  const code = async (state: State, connected: string | null = TENANT) => {
    const read = await readRekeyPlan(client(state), { now: NOW, connectedTenantId: connected })
    return read.ok ? 'PLAN' : read.refusal.code
  }
  assert.equal(await code({ list: LIVE }, null), 'XERO_NOT_CONNECTED')
  assert.equal(await code({ list: null }), 'XERO_LIST_MISSING')
  assert.equal(await code({ list: LIVE, tenant: 'tenant-demo' }), 'XERO_LIST_WRONG_ORGANISATION')
  assert.equal(await code({ list: LIVE, stamp: null }), 'XERO_LIST_NOT_STAMPED')
  assert.equal(await code({ list: LIVE, fetchedAt: new Date(NOW.getTime() - DRIFT_MAX_STALENESS_MS - 60_000) }), 'XERO_LIST_STALE')
  assert.equal(await code({ list: LIVE, headerDigest: 'f'.repeat(64) }), 'XERO_LIST_UNREADABLE')
})

// ---- the report after an apply --------------------------------------------------------------------------

const reportRow = (rate: RekeyImsRate): ImsRateRow => ({
  id: rate.id, reportingCategory: null, name: rate.name, rate: rate.rate, usedFor: rate.usedFor, active: true, accountingTaxType: rate.accountingTaxType, countryCode: rate.countryCode,
  isCompound: false, reverseCharge: false, components: [],
})

// [mutation: projectRatesAfterRekey leaves the code unchanged -> the "after" arm fails; mutation: the live fixture's CY percentage changed -> the control arm and "after" arm both fail]
test('AFTER APPLY the VAT difference report shows no PERCENTAGE_MISMATCH_IMS_XERO for the re-keyed rates (it did before)', () => {
  const plan = match(DEMO, LIVE)
  const rekeyed = new Set(plan.rows.filter((r) => r.outcome === 'REKEY').map((r) => r.imsRateId))
  const xero: ImsXeroSnapshot['xero'] = { tenantId: TENANT, fetchedAt: FETCHED, rows: LIVE }
  const mismatches = (rates: ImsRateRow[], idOf: (id: string) => string) => compareVatSets({ snapshot: { xero, rates, mappings: [] }, woo: [] }).differences
    .filter((d) => d.reason === 'PERCENTAGE_MISMATCH_IMS_XERO').map((d) => idOf(d.imsRateId!)).sort()

  const before = DEMO.map(reportRow)
  // Control: before, the re-keyed rates are exactly the ones whose percentage disagrees with the live type their DEMO code points at (CY 19 vs BG 20, GR 24 vs FR 20, LU 17 vs IT 22 ...).
  const beforeMismatches = mismatches(before, (id) => id)
  for (const id of ['cy', 'gr', 'lu']) assert.ok(beforeMismatches.includes(id), `before: ${id} disagrees (${beforeMismatches.join(',')})`)

  const after = projectRatesAfterRekey(before, plan)
  const afterMismatches = mismatches(after, (id) => id.replace(':rekeyed', ''))
  assert.deepEqual(afterMismatches.filter((id) => rekeyed.has(id)), [], 'no re-keyed rate is a percentage mismatch any more')
  assert.deepEqual(afterMismatches, [], 'and nothing else is either on this fixture')
  const report = compareVatSets({ snapshot: { xero, rates: after, mappings: [] }, woo: [] })
  assert.equal(report.counts.PERCENTAGE_MISMATCH_IMS_XERO, 0)
  // The deactivated old rows are not compared (the report reads active rates only).
  assert.equal(report.ims.activeRates, before.length)
})

// ---- the command line ---------------------------------------------------------------------------------

test('the command line takes exactly --apply --confirm <64-hex>, --allow-unposted, --json, --help; confirm and the flag need --apply', () => {
  const digest = 'a'.repeat(64)
  assert.deepEqual(parseTaxRekeyArgs([]), { apply: false, confirm: null, allowUnposted: false, clearUnresolved: false, json: false, help: false })
  assert.deepEqual(parseTaxRekeyArgs(['--apply', '--confirm', digest, '--allow-unposted', '--json']), { apply: true, confirm: digest, allowUnposted: true, clearUnresolved: false, json: true, help: false })
  for (const argv of [['--confirm', digest], ['--allow-unposted'], ['--apply', '--confirm', 'xyz'], ['--apply', '--confirm'], ['--apply', '--apply'], ['--other'], ['--apply', '--confirm', digest, '--confirm', digest]]) {
    assert.deepEqual(parseTaxRekeyArgs(argv), { code: 'BAD_ARGUMENTS' }, argv.join(' '))
  }
  assert.deepEqual(parseTaxRekeyArgs(['--clear-unresolved']), { apply: false, confirm: null, allowUnposted: false, clearUnresolved: true, json: false, help: false }, 'the preview takes the clear choice too: it is part of the plan and the digest')
  assert.deepEqual(parseTaxRekeyArgs(['--apply', '--confirm', digest, '--clear-unresolved']), { apply: true, confirm: digest, allowUnposted: false, clearUnresolved: true, json: false, help: false })
  assert.deepEqual(parseTaxRekeyArgs(['--clear-unresolved', '--clear-unresolved']), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parseTaxRekeyArgs(['postgres://u:p@h/db']), { code: 'CREDENTIAL_ARGUMENT' })
  assert.deepEqual(parseTaxRekeyArgs(['--apply', '--confirm', 'token=abc']), { code: 'CREDENTIAL_ARGUMENT' })
})

const result = (over: Partial<Parameters<typeof renderTaxRekeyText>[0]> = {}) => ({ applied: false, wrote: false, plan: planOf(), refusal: null, written: null, hold: { held: true, detail: 'Xero is held' }, ...over })

test('exit codes: 0 nothing to do or applied, 1 a preview that lists work, 2 refused', () => {
  assert.equal(TAX_REKEY_EXIT_CODES.length, 4)
  assert.equal(taxRekeyExitCode(result()), 1)
  const clean = { ...planOf(), rows: planOf().rows.map((r) => ({ ...r, outcome: 'ALREADY_CORRECT' as const })) }
  assert.equal(taxRekeyExitCode(result({ plan: clean })), 0)
  assert.equal(taxRekeyExitCode(result({ applied: true, wrote: true, written: { created: [], suppliersRepointed: 0, mappingsRepointed: 0, salesLinesRepointed: 0, purchaseLinesRepointed: 0, cancelledLinesRepointed: 0, refundLinesRepointed: 0 } })), 0)
  assert.equal(taxRekeyExitCode(result({ applied: true, refusal: { code: 'DIGEST_MISMATCH', detail: 'x' } })), 2)
  assert.equal(taxRekeyExitCode(result({ plan: null, refusal: { code: 'XERO_LIST_STALE', detail: 'x' } })), 2)
  const text = renderTaxRekeyText(result())
  assert.match(text, /== REKEY \(5\)/)
  assert.match(text, /CY VAT \[SALES CY\] TAX005 19% {2}-> TAX008 "CY VAT" 19%/)
  assert.match(text, new RegExp(`Plan digest: ${planOf().digest}`))
})

test('the command: account, credential and database refusals, the replaced environment, and the digest handed to the run', async () => {
  const digest = 'b'.repeat(64)
  const calls: unknown[] = []
  const out: string[] = []
  const err: string[] = []
  const deps = { run: async (o: unknown) => { calls.push(o); return result({ applied: true, wrote: true, written: { created: [{ oldId: 'a', newId: 'b', name: 'CY VAT', fromCode: 'TAX005', toCode: 'TAX008' }], suppliersRepointed: 1, mappingsRepointed: 2, salesLinesRepointed: 0, purchaseLinesRepointed: 0, cancelledLinesRepointed: 0, refundLinesRepointed: 0 } }) }, disconnect: async () => undefined }
  const base = { env: { DATABASE_URL: 'postgresql://x', HOME: '/tmp', PGHOST: '203.0.113.1', PGPASSWORD: 'x', NODE_OPTIONS: '--require /evil.js', SETTINGS_ENCRYPTION_KEY: 'k' }, uid: 0, checkoutOwnerUid: 1000, deps, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }

  assert.equal(await runTaxRekeyCli({ ...base, argv: ['--apply', '--confirm', digest], onKeptEnv: (kept) => { assert.deepEqual(Object.keys(kept).sort(), ['DATABASE_URL', 'HOME', 'SETTINGS_ENCRYPTION_KEY']) } }), 0)
  assert.deepEqual(calls, [{ apply: true, confirm: digest, allowUnposted: false, clearUnresolved: false, producerEnv: {} }])
  assert.match(out.join('\n'), /Applied: 1 rate\(s\) re-keyed/)
  assert.equal(await runTaxRekeyCli({ ...base, argv: ['--apply', '--confirm', digest, '--allow-unposted'] }), 0)
  assert.deepEqual(calls[1], { apply: true, confirm: digest, allowUnposted: true, clearUnresolved: false, producerEnv: {} })
  assert.equal(await runTaxRekeyCli({ ...base, argv: [] }), 0, 'a preview run passes apply false')
  assert.deepEqual(calls[2], { apply: false, confirm: undefined, allowUnposted: false, clearUnresolved: false, producerEnv: {} })
  assert.equal(await runTaxRekeyCli({ ...base, argv: ['--apply'] }), 3)
  assert.equal(await runTaxRekeyCli({ ...base, uid: 1234, argv: [] }), 3, 'neither root nor the checkout\'s owner')
  assert.equal(await runTaxRekeyCli({ ...base, uid: 1000, argv: [] }), 0, 'the checkout\'s owner')
  assert.equal(await runTaxRekeyCli({ ...base, env: { HOME: '/tmp' }, argv: [] }), 3, 'no database')
  assert.equal(await runTaxRekeyCli({ ...base, argv: ['mysql://u:p@h/d'] }), 3)
  assert.match(err.join('\n'), /CREDENTIAL_ARGUMENT/)
  assert.equal(calls.length, 4, 'a refused command never reached the run')
  assert.equal(await runTaxRekeyCli({ ...base, deps: { ...deps, run: async () => { throw new Error('boom secret=hunter2') } }, argv: [] }), 3)
  assert.equal(err.join('\n').includes('hunter2'), false, 'nothing from a failure is echoed')
})

// ---- the Xero hold (the structural guarantee) -------------------------------------------------------------

// [mutation: held when only enforced (grant / live-from ignored) -> the live arms fail; mutation: xero not required in the list -> the "names another destination" arm fails]
test('xeroHoldState: held ONLY when the hold is enforced for xero AND no grant / live-from instant is in force', () => {
  const held = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }
  assert.equal(xeroHoldState(held).held, true)
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }).held, true)
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce, xero' }).held, true)
  assert.equal(xeroHoldState({}).held, false, 'not enforced: producers would still queue deliverable work')
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }).held, false, 'enforced for another destination only')
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'bogus' }).held, false, 'unreadable switch')
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITES_LIVE_FROM: '2026-12-01T00:00:00Z' }).held, false, 'a live-from instant (even a future one) is not held')
  assert.equal(xeroHoldState({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITES_LIVE_FROM: 'garbage' }).held, false)
  assert.equal(xeroHoldState({ ...held, XERO_WRITE_ALLOWED_TENANT: '11111111-2222-3333-4444-555555555555' }).held, false, 'a grant alone is inconsistent, not held')
  const live = { ...held, XERO_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z', XERO_WRITE_ALLOWED_TENANT: '11111111-2222-3333-4444-555555555555' }
  assert.equal(xeroHoldState(live).held, false, 'destination live')
  assert.deepEqual(Object.keys(pickXeroHoldEnv({ ...live, DATABASE_URL: 'x', SECRET: 'y' })).sort(), Object.keys(live).sort().filter((k) => k in pickXeroHoldEnv(live)), 'only the hold variables are picked')
  assert.equal('DATABASE_URL' in pickXeroHoldEnv({ DATABASE_URL: 'x' }), false)
})

test('an apply is refused with XERO_NOT_HELD before the database is touched, unless Xero is held', async () => {
  const confirm = 'c'.repeat(64)
  for (const env of [{}, { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITES_LIVE_FROM: '2026-01-01T00:00:00Z' }]) {
    const r = await runTaxRekey({ apply: true, confirm, producerEnv: env })
    assert.deepEqual([r.refusal?.code, r.wrote, r.plan, r.hold.held], ['XERO_NOT_HELD', false, null, false], JSON.stringify(env))
  }
})

// [mutation: the meaning comparison reduced to name + percentage (the pre-R4 check) -> every arm but the first fails]
test('imsMeaningDifference: any difference in country, side, component breakdown, isCompound, reverseCharge or reportingCategory is a difference (the refund-snapshot identity check)', () => {
  const base = ims('a', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'CY', usedFor: 'SALES', isCompound: false, reverseCharge: false, reportingCategory: 'EC_SALES' })
  const with_ = (over: Partial<RekeyImsRate>) => imsMeaningDifference(base, { ...base, id: 'b', ...over })
  assert.equal(with_({}), null, 'control: identical carriers')
  assert.equal(with_({ name: ' CY VAT ' }), null, 'trimmed name')
  assert.equal(with_({ name: 'CZ VAT' }), 'name')
  assert.equal(with_({ rate: '0.2000' }), 'percentage')
  assert.equal(with_({ countryCode: 'GR' }), 'country')
  assert.equal(with_({ countryCode: null }), 'country')
  assert.equal(with_({ usedFor: 'BOTH' }), 'side')
  assert.equal(with_({ isCompound: true }), 'isCompound')
  assert.equal(with_({ reverseCharge: true }), 'reverseCharge')
  assert.equal(with_({ reportingCategory: 'OSS' }), 'reportingCategory')
  const two = [{ rate: '0.1000', compoundOnPrevious: false, active: true, sortOrder: 0 }, { rate: '0.0900', compoundOnPrevious: false, active: true, sortOrder: 1 }]
  assert.equal(with_({ components: two }), 'component breakdown', 'same headline percentage, another breakdown')
  assert.equal(with_({ components: [{ rate: '0.1900', compoundOnPrevious: true, active: true, sortOrder: 0 }] }), 'component breakdown', 'compounding')
  assert.equal(with_({ components: [{ rate: '0.1900', compoundOnPrevious: false, active: true, sortOrder: 0 }] }), null, 'one active component at the column equals none')
})

// [mutation: the unresolved check removed from applyRefusal -> the apply succeeds half done; mutation: the clear choice not part of the digest -> the digest arm fails]
test('NO PARTIAL APPLY: unresolved rates refuse the apply (listed), the clear choice turns them into CLEAR rows bound into the digest', async () => {
  const live = [xeroRow('TAX008', 'CY VAT', '19', { canApply: { assets: false, equity: false, expenses: true, liabilities: false, revenue: true } })]
  const rates = [ims('cy', 'CY VAT', 'TAX005', '0.1900'), ims('be', 'BE VAT', 'TAX021', '0.2100')]
  const planFor = async (clearUnresolved: boolean) => {
    const read = await readRekeyPlan(client({ list: live, rates }), { now: NOW, connectedTenantId: TENANT, clearUnresolved })
    assert.equal(read.ok, true)
    return read.ok ? read.plan : (undefined as never)
  }
  const plain = await planFor(false)
  assert.deepEqual(plain.rows.map((r) => `${r.name}:${r.outcome}`), ['BE VAT:NO_MATCH', 'CY VAT:REKEY'])
  const refusal = applyRefusal(plain, true)
  assert.equal(refusal?.code, 'UNRESOLVED_RATES')
  assert.match(refusal!.detail, /BE VAT \(TAX021\) NO_MATCH/)
  const clearing = await planFor(true)
  assert.deepEqual(clearing.rows.map((r) => `${r.name}:${r.outcome}:${r.wasOutcome ?? ''}`), ['BE VAT:CLEAR:NO_MATCH', 'CY VAT:REKEY:'])
  assert.deepEqual([clearing.counts.CLEAR, clearing.counts.REKEY, clearing.clearUnresolved], [1, 1, true])
  assert.equal(applyRefusal(clearing, true), null, 'with the clear choice nothing is left unresolved')
  assert.notEqual(clearing.digest, plain.digest, 'the digest changes with the flag')
  assert.equal((await planFor(true)).digest, clearing.digest, 'and is stable')
  // The flag itself is in the digest even when it changes no row.
  const okRates = [ims('cy', 'CY VAT', 'TAX005', '0.1900')]
  const onlyRekey = async (clearUnresolved: boolean) => { const read = await readRekeyPlan(client({ list: live, rates: okRates }), { now: NOW, connectedTenantId: TENANT, clearUnresolved }); return read.ok ? read.plan.digest : '' }
  assert.notEqual(await onlyRekey(true), await onlyRekey(false), 'the digest binds the choice, not only its effects')
  // A rate that is already correct or re-keyable is never CLEAR, and an in-scope-free plan has nothing unresolved.
  assert.equal(applyRefusal({ ...plain, rows: plain.rows.filter((r) => r.outcome === 'REKEY') }, true), null)
})
