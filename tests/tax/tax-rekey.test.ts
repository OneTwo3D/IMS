import assert from 'node:assert/strict'
import test from 'node:test'

import { digestTaxRateList, type NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { DRIFT_MAX_STALENESS_MS } from '@/lib/domain/accounting/tax-rate-drift-status'
import {
  REKEY_OUTCOMES, applyRefusal, digestRekeyPlan, matchRekeyRates, projectRatesAfterRekey, readRekeyPlan, runTaxRekey, xeroNameCountry,
  type RekeyImsRate, type RekeyPlan, type RekeyReferences,
} from '@/lib/tax/tax-rekey'
import { TAX_REKEY_EXIT_CODES, parseTaxRekeyArgs, renderTaxRekeyText, taxRekeyExitCode } from '@/lib/tax/tax-rekey-cli'
import { compareVatSets, type ImsRateRow, type ImsXeroSnapshot } from '@/lib/tax/vat-difference-report'
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

const xeroRow = (taxType: string, name: string, pct: string, over: Partial<NormalisedXeroTaxRate> = {}): NormalisedXeroTaxRate => ({
  taxType, name, status: 'ACTIVE', reportTaxType: null, effectiveRate: `${pct}.000000`, displayTaxRate: `${pct}.000000`,
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
  assert.deepEqual([outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'GR' })], live, 'x').outcome, outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'GR' })], live, 'x').target], ['NO_MATCH', null])
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: 'CY' })], live, 'x').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { countryCode: null })], live, 'x').outcome, 'REKEY')
  assert.equal(outcomeOf([ims('x', 'Standard', 'TAX005', '0.2000', { countryCode: 'GB' })], [xeroRow('TAX040', 'Standard', '20')], 'x').outcome, 'REKEY')
  // UK is the IMS/Xero spelling of GB.
  assert.equal(outcomeOf([ims('x', 'UK VAT', 'TAX005', '0.2000', { countryCode: 'GB' })], [xeroRow('TAX040', 'UK VAT', '20')], 'x').outcome, 'REKEY')
  assert.deepEqual([xeroNameCountry('CY VAT'), xeroNameCountry('EL VAT'), xeroNameCountry('Zero Rated'), xeroNameCountry('20% (VAT on Income)')], ['CY', 'GR', null, null])
})

// [mutation: the duplicate-target blocker removed -> two rates are tied to one live type]
test('BLOCKERS: two rates re-keying to one live type on an overlapping side, and a live type another active rate keeps', () => {
  const duplicate = match([ims('a', 'CY VAT', 'TAX005', '0.1900', { usedFor: 'SALES' }), ims('b', 'CY VAT', 'TAX006', '0.1900', { usedFor: 'BOTH' })], LIVE)
  assert.deepEqual(duplicate.blockers.map((b) => [b.code, b.taxType]), [['DUPLICATE_TARGET', 'TAX008']])
  // Disjoint sides are legitimate: a sales row and a purchase row of one name.
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
    xeroRow('TAX061', 'ES VAT', '21', { components: [{ name: 'a', rate: '10.000000', compound: false, nonRecoverable: false }, { name: 'b', rate: '11.000000', compound: false, nonRecoverable: false }] }),
  ]
  const plan = match([
    ims('ok', 'CY VAT', 'TAX008', '0.1900'), ims('mv', 'GR VAT', 'TAX013', '0.2400'), ims('no', 'CI VAT', 'TAX004', '0.1800', { countryCode: 'CI' }),
    ims('am', 'BE VAT', 'TAX021', '0.2100'), ims('pd', 'LU VAT', 'TAX020', '0.1500'), ims('in', 'FR VAT', 'TAX013', '0.2000'),
    ims('sd', 'DE VAT', 'TAX070', '0.1900'), ims('md', 'ES VAT', 'TAX071', '0.2100'),
  ], live)
  const byId = Object.fromEntries(plan.rows.map((r) => [r.imsRateId, r.outcome]))
  assert.deepEqual(byId, { ok: 'ALREADY_CORRECT', mv: 'REKEY', no: 'NO_MATCH', am: 'AMBIGUOUS', pd: 'PERCENTAGE_DIFFERS', in: 'NAME_MATCHES_INACTIVE', sd: 'SIDE_NOT_ALLOWED', md: 'MEANING_DIFFERS' })
  assert.equal(REKEY_OUTCOMES.every((o) => plan.counts[o] === 1), true)
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
  const at = (usedFor: string, revenue: boolean, expenses: boolean) => outcomeOf([ims('x', 'CY VAT', 'TAX005', '0.1900', { usedFor })], [xeroRow('TAX008', 'CY VAT', '19', { canApply: can(revenue, expenses) })], 'x')
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

// ---- the digest and the refusals to apply ---------------------------------------------------------------

const refs = (over: Partial<RekeyReferences> = {}): RekeyReferences => ({
  suppliers: 1, storefrontMappings: 1, isDefault: false, unpostedSalesOrders: 0, unpostedSalesOrderLines: 0, unpostedPurchaseOrders: 0, unpostedPurchaseOrderLines: 0,
  queuedSyncRows: 0, queuedEvents: 0, postedSalesOrders: 0, postedSalesOrderLines: 0, postedPurchaseOrders: 0, postedPurchaseOrderLines: 0, pendingRefunds: 0, pendingRefundLines: 0, refundSnapshotConflict: false, ...over,
})
const planOf = (referenceOver: Partial<RekeyReferences> = {}): RekeyPlan => {
  const matched = match(DEMO, LIVE)
  const references = Object.fromEntries(matched.rows.filter((r) => r.outcome === 'REKEY').map((r) => [r.imsRateId, refs(referenceOver)]))
  const plan: RekeyPlan = { list: { tenantId: TENANT, fetchedAt: FETCHED.toISOString(), rowCount: LIVE.length, digest: digestTaxRateList(TENANT, LIVE) }, ...matched, references, digest: '' }
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
    assert.deepEqual(Object.values(read.plan.references)[0], { suppliers: 1, storefrontMappings: 2, isDefault: false, unpostedSalesOrders: 0, unpostedSalesOrderLines: 0, unpostedPurchaseOrders: 0, unpostedPurchaseOrderLines: 0, postedSalesOrders: 0, postedSalesOrderLines: 0, postedPurchaseOrders: 0, postedPurchaseOrderLines: 0, pendingRefunds: 0, pendingRefundLines: 0, refundSnapshotConflict: false, queuedSyncRows: 0, queuedEvents: 0 })
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
  assert.deepEqual(parseTaxRekeyArgs([]), { apply: false, confirm: null, allowUnposted: false, json: false, help: false })
  assert.deepEqual(parseTaxRekeyArgs(['--apply', '--confirm', digest, '--allow-unposted', '--json']), { apply: true, confirm: digest, allowUnposted: true, json: true, help: false })
  for (const argv of [['--confirm', digest], ['--allow-unposted'], ['--apply', '--confirm', 'xyz'], ['--apply', '--confirm'], ['--apply', '--apply'], ['--other'], ['--apply', '--confirm', digest, '--confirm', digest]]) {
    assert.deepEqual(parseTaxRekeyArgs(argv), { code: 'BAD_ARGUMENTS' }, argv.join(' '))
  }
  assert.deepEqual(parseTaxRekeyArgs(['postgres://u:p@h/db']), { code: 'CREDENTIAL_ARGUMENT' })
  assert.deepEqual(parseTaxRekeyArgs(['--apply', '--confirm', 'token=abc']), { code: 'CREDENTIAL_ARGUMENT' })
})

const result = (over: Partial<Parameters<typeof renderTaxRekeyText>[0]> = {}) => ({ applied: false, wrote: false, plan: planOf(), refusal: null, written: null, ...over })

test('exit codes: 0 nothing to do or applied, 1 a preview that lists work, 2 refused', () => {
  assert.equal(TAX_REKEY_EXIT_CODES.length, 4)
  assert.equal(taxRekeyExitCode(result()), 1)
  const clean = { ...planOf(), rows: planOf().rows.map((r) => ({ ...r, outcome: 'ALREADY_CORRECT' as const })) }
  assert.equal(taxRekeyExitCode(result({ plan: clean })), 0)
  assert.equal(taxRekeyExitCode(result({ applied: true, wrote: true, written: { created: [], suppliersRepointed: 0, mappingsRepointed: 0, salesLinesRepointed: 0, purchaseLinesRepointed: 0, refundLinesRepointed: 0 } })), 0)
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
  const deps = { run: async (o: unknown) => { calls.push(o); return result({ applied: true, wrote: true, written: { created: [{ oldId: 'a', newId: 'b', name: 'CY VAT', fromCode: 'TAX005', toCode: 'TAX008' }], suppliersRepointed: 1, mappingsRepointed: 2, salesLinesRepointed: 0, purchaseLinesRepointed: 0, refundLinesRepointed: 0 } }) }, disconnect: async () => undefined }
  const base = { env: { DATABASE_URL: 'postgresql://x', HOME: '/tmp', PGHOST: '203.0.113.1', PGPASSWORD: 'x', NODE_OPTIONS: '--require /evil.js', SETTINGS_ENCRYPTION_KEY: 'k' }, uid: 0, checkoutOwnerUid: 1000, deps, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }

  assert.equal(await runTaxRekeyCli({ ...base, argv: ['--apply', '--confirm', digest], onKeptEnv: (kept) => { assert.deepEqual(Object.keys(kept).sort(), ['DATABASE_URL', 'HOME', 'SETTINGS_ENCRYPTION_KEY']) } }), 0)
  assert.deepEqual(calls, [{ apply: true, confirm: digest, allowUnposted: false }])
  assert.match(out.join('\n'), /Applied: 1 rate\(s\) re-keyed/)
  assert.equal(await runTaxRekeyCli({ ...base, argv: ['--apply', '--confirm', digest, '--allow-unposted'] }), 0)
  assert.deepEqual(calls[1], { apply: true, confirm: digest, allowUnposted: true })
  assert.equal(await runTaxRekeyCli({ ...base, argv: [] }), 0, 'a preview run passes apply false')
  assert.deepEqual(calls[2], { apply: false, confirm: undefined, allowUnposted: false })
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
