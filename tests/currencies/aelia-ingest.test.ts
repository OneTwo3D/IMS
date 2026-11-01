import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { aeliaAnswer, createFxSourceFakeDb, liveShapedAeliaAnswer, type FakeFxRateRow } from '@/tests/helpers/fx-source-fake-db'

/**
 * AELIA'S RATES INTO fx_rates (lib/currencies/aelia-ingest.ts). Database faked; the exclusive FX table lock is the REAL withFxTableWriteLock over the fake transaction.
 * Mutations for every rule are in the PR (/var/tmp/aelia-mut.py): each one turns a test here red.
 */

let fake = createFxSourceFakeDb()
mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get: (_t, k) => (fake.db as never)[k] }) } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })

const load = async () => import('@/lib/currencies/aelia-ingest')
const sel = async () => import('@/lib/currencies/fx-select')

const ACTIVE = [
  { code: 'GBP', active: true },
  { code: 'EUR', active: true },
  { code: 'USD', active: true },
  { code: 'NOK', active: true },
]
const AELIA_TIME = new Date('2026-10-23T23:36:05Z')
const NOW = new Date('2026-10-24T08:00:00Z')

function reset(seed: Parameters<typeof createFxSourceFakeDb>[0] = {}) {
  // The regular ingest writes only while the source is Aelia (it re-checks inside the lock), so the default state of these tests is the Aelia source.
  fake = createFxSourceFakeDb({ currencies: ACTIVE, ...seed, settings: { fx_rate_source: 'aelia', fx_rate_source_since: '2026-10-20T00:00:00.000Z', ...(seed.settings ?? {}) } })
}
const rowOf = (code: string) => fake.rates.filter((r) => r.toCurrency === code)
const withRates = (rates: unknown[], more: Record<string, unknown> = {}) => aeliaAnswer({ rates, ...more })

test('the stored row is the rate BEFORE markup, exactly; the markup is returned separately and stored nowhere', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  assert.deepEqual(result.written.sort(), ['EUR', 'NOK', 'USD'])
  assert.deepEqual(result.markups, { EUR: '0.02', USD: '0.02', NOK: '0.02' }, 'the markup is read and returned so it can be verified')
  assert.equal(rowOf('EUR')[0].rate, '1.194344', 'EUR stored at Aelia\'s rate, not 1.214344')
  assert.equal(rowOf('USD')[0].rate, '1.336829')
  assert.equal(rowOf('NOK')[0].rate, '12.500597')
  for (const r of fake.rates) {
    assert.deepEqual(Object.keys(r).sort(), ['fetchedAt', 'fromCurrency', 'manualOverride', 'rate', 'source', 'toCurrency'], 'a stored row has no markup field')
    assert.notEqual(r.rate, '1.214344')
    assert.notEqual(r.rate, '1.356829')
    assert.notEqual(r.rate, '12.520597')
  }
})

test('fetchedAt is Aelia\'s own update time, not the time IMS read it; source is aelia', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  for (const code of ['EUR', 'USD', 'NOK']) {
    assert.equal(rowOf(code)[0].fetchedAt.toISOString(), AELIA_TIME.toISOString())
    assert.equal(rowOf(code)[0].source, 'aelia')
    assert.equal(rowOf(code)[0].fromCurrency, 'GBP')
    assert.equal(rowOf(code)[0].manualOverride, false)
  }
})

test('refused: a non-positive rate (zero, negative) stores nothing for that currency; the others are still stored', async () => {
  const { ingestAeliaRates } = await load()
  for (const bad of ['0', '0.0', '-1.2', 0, -3]) {
    reset()
    const result = await ingestAeliaRates(withRates([
      { currency: 'EUR', rate: bad, markup: '0.02' },
      { currency: 'USD', rate: '1.336829', markup: '0.02' },
      { currency: 'NOK', rate: '12.500597', markup: '0.02' },
    ]), { now: NOW })
    assert.equal(rowOf('EUR').length, 0, `EUR ${String(bad)} not stored`)
    assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'non_positive_rate']], String(bad))
    assert.deepEqual(result.written.sort(), ['NOK', 'USD'])
  }
})

test('refused: a non-finite or non-numeric rate', async () => {
  const { ingestAeliaRates } = await load()
  for (const bad of ['NaN', 'Infinity', '-Infinity', 'abc', '1e400', '1,5']) {
    reset()
    const result = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: bad, markup: '0.02' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
    assert.equal(rowOf('EUR').length, 0, bad)
    assert.equal(result.refused.length, 1, bad)
    assert.equal(result.refused[0].currency, 'EUR')
    assert.ok(['non_finite_rate', 'non_positive_rate'].includes(result.refused[0].reason), `${bad}: ${result.refused[0].reason}`)
  }
})

test('refused, never defaulted to 1 or to another source: a missing rate (absent, null, empty) and an IMS currency Aelia does not list', async () => {
  const { ingestAeliaRates } = await load()
  for (const missing of [undefined, null, '']) {
    reset()
    const result = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: missing, markup: '0.02' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
    assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'missing_rate']])
    assert.equal(rowOf('EUR').length, 0)
    assert.ok(!fake.rates.some((r) => r.rate === '1' || r.source !== 'aelia'), 'nothing was invented')
  }
  reset()
  const result = await ingestAeliaRates(withRates([{ currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'not_listed_by_aelia']])
  assert.equal(rowOf('EUR').length, 0)
})

test('refused: more digits than the column keeps (the stored row would not equal Aelia\'s rate)', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: '1.123456789' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'rate_precision']])
  assert.equal(rowOf('EUR').length, 0)
  // trailing zeros are not digits: eight real decimals are fine
  reset()
  const ok = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: '1.12345678000' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
  assert.deepEqual(ok.refused, [])
  assert.equal(rowOf('EUR').length, 1)
})

test('refused: a base currency that is not IMS\'s base; the whole read, nothing stored', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  await assert.rejects(ingestAeliaRates(aeliaAnswer({ base: 'EUR' }), { now: NOW }), (e: Error & { reason?: string }) => e.reason === 'base_mismatch')
  assert.equal(fake.rates.length, 0)
  assert.equal(fake.events.some((e) => e.startsWith('fxRate.create')), false, 'refused before any write')
})

test('refused: an unknown currency (not in IMS) stores nothing for it; a currency IMS has switched off is simply not wanted', async () => {
  reset({ currencies: [...ACTIVE, { code: 'SEK', active: false }] })
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(withRates([
    { currency: 'EUR', rate: '1.194344' }, { currency: 'USD', rate: '1.336829' }, { currency: 'NOK', rate: '12.500597' },
    { currency: 'JPY', rate: '200.1' }, { currency: 'SEK', rate: '13.5' },
  ]), { now: NOW })
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['JPY', 'unknown_currency']])
  assert.equal(rowOf('JPY').length, 0)
  assert.equal(rowOf('SEK').length, 0)
})

test('refused: no update time, an unreadable one, and one in the future (the whole read)', async () => {
  const { ingestAeliaRates } = await load()
  for (const bad of [null, undefined, '', 'yesterday', '2026-10-23 23:36:05', '2026-10-25T08:00:00Z']) {
    reset()
    await assert.rejects(
      ingestAeliaRates(aeliaAnswer({ last_update: bad }), { now: NOW }),
      (e: Error & { reason?: string }) => e.reason === 'no_update_time' || e.reason === 'future_update_time',
      String(bad),
    )
    assert.equal(fake.rates.length, 0)
  }
})

test('refused: a duplicate currency in the answer is ambiguous; neither row is stored', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(withRates([
    { currency: 'EUR', rate: '1.19' }, { currency: 'EUR', rate: '1.25' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.5' },
  ]), { now: NOW })
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'duplicate_currency']])
  assert.equal(rowOf('EUR').length, 0)
})

test('idempotent: re-reading the same Aelia update writes no duplicate rows; a new Aelia update writes new rows', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  const first = await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  assert.equal(first.written.length, 3)
  const again = await ingestAeliaRates(aeliaAnswer(), { now: new Date('2026-10-24T09:00:00Z') })
  assert.deepEqual(again.written, [])
  assert.deepEqual(again.unchanged.sort(), ['EUR', 'NOK', 'USD'])
  assert.equal(fake.rates.length, 3, 'still three rows')
  const next = await ingestAeliaRates(aeliaAnswer({ last_update: '2026-10-24T23:36:05Z', rates: [{ currency: 'EUR', rate: '1.2' }, { currency: 'USD', rate: '1.34' }, { currency: 'NOK', rate: '12.6' }] }), { now: new Date('2026-10-25T08:00:00Z') })
  assert.equal(next.written.length, 3)
  assert.equal(fake.rates.length, 6)
})

test('a changed rate under the SAME Aelia update time is refused (two rows at one instant would be ambiguous), not stored', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  const result = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: '1.5' }, { currency: 'USD', rate: '1.336829' }, { currency: 'NOK', rate: '12.500597' }]), { now: NOW })
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'changed_without_update']])
  assert.equal(rowOf('EUR').length, 1)
  assert.equal(rowOf('EUR')[0].rate, '1.194344')
})

test('manual overrides keep working: a pinned currency is skipped by the ingest, and the lookup ranks the pin over an Aelia row exactly as before', async () => {
  const pin: FakeFxRateRow = { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.3', fetchedAt: new Date('2026-10-20T00:00:00Z'), source: 'manual', manualOverride: true }
  reset({ rates: [pin] })
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  assert.deepEqual(result.skippedManualOverrides, ['EUR'])
  assert.deepEqual(result.written.sort(), ['NOK', 'USD'])
  assert.equal(rowOf('EUR').length, 1, 'no Aelia row was added over the pin')
  const { selectFxRateFromRows } = await sel()
  const picked = selectFxRateFromRows(fake.rates, { baseCurrency: 'GBP', currency: 'EUR', asOf: new Date('2026-10-26T00:00:00Z') })
  assert.equal(picked.rate.toString(), '1.3')
  assert.equal(picked.manualOverride, true)
  assert.equal(picked.source, 'manual')
  // and an ordinary Aelia row is selected like any other row: the latest by time
  const usd = selectFxRateFromRows(fake.rates, { baseCurrency: 'GBP', currency: 'USD', asOf: new Date('2026-10-26T00:00:00Z') })
  assert.equal(usd.rate.toString(), '1.336829')
  assert.equal(usd.source, 'aelia')
  assert.equal(usd.fetchedAt.toISOString(), AELIA_TIME.toISOString())
})

test('clearing an override takes Aelia\'s rate before markup (never frankfurter), dated by the admin\'s action so it is the newest row', async () => {
  const pin: FakeFxRateRow = { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.3', fetchedAt: new Date('2026-10-24T01:00:00Z'), source: 'manual', manualOverride: true }
  reset({ rates: [pin] })
  const { clearOverrideFromAelia } = await load()
  const cleared = await clearOverrideFromAelia(aeliaAnswer(), 'EUR', { now: NOW })
  assert.deepEqual(cleared, { rate: '1.194344', markup: '0.02' })
  const { selectFxRateFromRows } = await sel()
  const picked = selectFxRateFromRows(fake.rates, { baseCurrency: 'GBP', currency: 'EUR', asOf: new Date('2026-10-26T00:00:00Z') })
  assert.equal(picked.rate.toString(), '1.194344')
  assert.equal(picked.manualOverride, false)
  assert.equal(picked.source, 'aelia')
  await assert.rejects(clearOverrideFromAelia(withRates([{ currency: 'EUR', rate: '0' }]), 'EUR', { now: NOW }), (e: Error & { reason?: string }) => e.reason === 'non_positive_rate')
  await assert.rejects(clearOverrideFromAelia(withRates([{ currency: 'USD', rate: '1.3' }]), 'EUR', { now: NOW }), (e: Error & { reason?: string }) => e.reason === 'not_listed_by_aelia')
})

test('every fx_rates write of the ingest happens inside the exclusive lock transaction, after the lock statement', async () => {
  reset({ rates: [{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.3', fetchedAt: new Date('2026-10-20T00:00:00Z'), source: 'manual', manualOverride: true }] })
  const { ingestAeliaRates, clearOverrideFromAelia } = await load()
  await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  await clearOverrideFromAelia(aeliaAnswer(), 'EUR', { now: NOW })
  const creates = fake.events.filter((e) => e.startsWith('fxRate.create'))
  assert.ok(creates.length >= 3, 'PRECONDITION: rows were written')
  assert.ok(creates.every((e) => e === 'fxRate.create(in lock tx)'), `no write outside the lock: ${creates.join(',')}`)
  // within each transaction the lock statement precedes the first write
  let sawLock = false
  for (const e of fake.events) {
    if (e === 'tx.begin') sawLock = false
    if (e === 'lock') sawLock = true
    if (e.startsWith('fxRate.create')) assert.ok(sawLock, 'the lock was taken before the write')
  }
})

// ------------------------------------------------------------------ the live store's shape: an epoch-int update time (rendered ISO by the plugin) and a BASE row without markup

test('LIVE SHAPE: the base row (rate, no markup, no set_manually) neither refuses the read nor is stored; the foreign currencies are stored before markup', async () => {
  reset()
  const { ingestAeliaRates, parseAeliaRatesPayload } = await load()
  const answer = liveShapedAeliaAnswer()
  assert.ok((answer.rates as Array<{ currency: string }>).some((r) => r.currency === 'GBP'), 'PRECONDITION: the answer does list the base row')
  const parsed = parseAeliaRatesPayload(answer, new Date('2026-10-29T12:00:00Z'))
  assert.equal(parsed.entries.some((e) => e.currency === 'GBP'), false, 'the base row is not read')
  assert.deepEqual(parsed.refused, [])
  const result = await ingestAeliaRates(answer, { now: new Date('2026-10-29T12:00:00Z') })
  assert.deepEqual(result.written.sort(), ['EUR', 'NOK', 'USD'])
  assert.deepEqual(result.refused, [])
  assert.equal(rowOf('GBP').length, 0, 'no GBP row is ever stored')
  assert.equal(fake.rates.filter((r) => r.toCurrency === 'GBP' || r.fromCurrency === r.toCurrency).length, 0)
  assert.equal(rowOf('EUR')[0].rate, '1.150000')
  assert.equal(rowOf('NOK')[0].rate, '12.250000')
  assert.equal(rowOf('EUR')[0].fetchedAt.toISOString(), '2026-10-29T11:36:05.000Z', 'the epoch 1793273765, as the plugin renders it')
  assert.equal(new Date(1793273765 * 1000).toISOString(), '2026-10-29T11:36:05.000Z')
})

test('LIVE SHAPE: whatever the base row holds (1, nothing, zero, a wrong number, a word) it is skipped and never refuses the read', async () => {
  const { parseAeliaRatesPayload } = await load()
  for (const base of [{ rate: '1' }, {}, { rate: '0' }, { rate: '0.9' }, { rate: 'abc' }, { rate: null }]) {
    const answer = liveShapedAeliaAnswer({ rates: [{ currency: 'GBP', ...base, decimals: 4 }, { currency: 'EUR', rate: '1.15', markup: '0.01' }] })
    const parsed = parseAeliaRatesPayload(answer, new Date('2026-10-29T12:00:00Z'))
    assert.deepEqual(parsed.entries.map((e) => e.currency), ['EUR'], JSON.stringify(base))
    assert.deepEqual(parsed.refused, [], JSON.stringify(base))
  }
})

test('MARKUP RULE: a non-base currency with no markup is stored at its rate with markup null; the base row\'s absent markup is never read as 0 for anyone', async () => {
  reset()
  const { ingestAeliaRates } = await load()
  const result = await ingestAeliaRates(liveShapedAeliaAnswer(), { now: new Date('2026-10-29T12:00:00Z') })
  assert.deepEqual(result.markups, { EUR: '0.01', NOK: '0.10', USD: null }, 'USD has no markup: null (unknown), not 0; GBP is not reported at all')
  assert.equal(rowOf('USD')[0].rate, '1.300000', 'a missing markup does not change or block the stored rate')
  assert.equal('GBP' in result.markups, false)
  // the key is absent altogether (not only null) on a foreign currency: the same
  const noKey = liveShapedAeliaAnswer({ rates: [{ currency: 'EUR', rate: '1.15' }, { currency: 'USD', rate: '1.3' }, { currency: 'NOK', rate: '12.25' }] })
  reset()
  const again = await ingestAeliaRates(noKey, { now: new Date('2026-10-29T12:00:00Z') })
  assert.deepEqual(again.markups, { EUR: null, USD: null, NOK: null })
})

// ------------------------------------------------------------------ cutover hardening: pins, regression, the source re-check

const aeliaRow = (to: string, rate: string, at: string): FakeFxRateRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: new Date(at), source: 'aelia', manualOverride: false })
const pinRow = (to: string, rate: string, at = '2026-10-24T01:00:00Z'): FakeFxRateRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: new Date(at), source: 'manual', manualOverride: true })
const answerWithout = (code: string) => aeliaAnswer({ rates: (aeliaAnswer().rates as Array<{ currency: string }>).filter((r) => r.currency !== code) })

test('COVERAGE: a pinned currency is covered whether Aelia lists it, omits it or refuses it; an unpinned omission is missing', async () => {
  const { ingestAeliaRates } = await load()
  reset({ rates: [pinRow('USD', '1.4')] })
  const omitted = await ingestAeliaRates(answerWithout('USD'), { now: NOW })
  assert.deepEqual(omitted.missing, [])
  assert.deepEqual(omitted.pinned, ['USD'])
  assert.deepEqual(omitted.skippedManualOverrides, [], 'it was not in the read, so it was not skipped from it')
  assert.deepEqual(omitted.written.sort(), ['EUR', 'NOK'])
  assert.equal(rowOf('USD').length, 1, 'nothing stored for the pinned currency')

  reset({ rates: [pinRow('USD', '1.4')] })
  const refused = await ingestAeliaRates(withRates([{ currency: 'EUR', rate: '1.19' }, { currency: 'USD', rate: '0' }, { currency: 'NOK', rate: '12.5' }]), { now: NOW })
  assert.deepEqual(refused.missing, [])
  assert.deepEqual(refused.refused.map((r) => [r.currency, r.reason]), [['USD', 'non_positive_rate']])

  reset({ rates: [pinRow('USD', '1.4')] })
  const listed = await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  assert.deepEqual(listed.missing, [])
  assert.deepEqual(listed.pinned, ['USD'])
  assert.deepEqual(listed.skippedManualOverrides, ['USD'])

  // CONTROL: without the pin the same omission is missing; an OLD pin superseded by a newer ordinary row is no pin
  reset()
  assert.deepEqual((await ingestAeliaRates(answerWithout('USD'), { now: NOW })).missing, ['USD'])
  reset({ rates: [pinRow('USD', '1.4', '2026-10-01T00:00:00Z'), aeliaRow('USD', '1.3', '2026-10-10T00:00:00Z')] })
  const superseded = await ingestAeliaRates(answerWithout('USD'), { now: NOW })
  assert.deepEqual(superseded.pinned, [])
  assert.deepEqual(superseded.missing, ['USD'])
})

test('REGRESSION: an update time earlier than the newest stored Aelia row of a currency is refused for it (aelia_update_regressed), nothing stored, and it is missing; equal is idempotent, later is written', async () => {
  const { ingestAeliaRates } = await load()
  reset({ rates: [aeliaRow('EUR', '1.1', '2026-10-01T00:00:00Z'), aeliaRow('EUR', '1.2', '2026-10-24T10:00:00Z'), aeliaRow('NOK', '12.500597', '2026-10-23T23:36:05Z'), aeliaRow('USD', '1.33', '2026-10-20T00:00:00Z')] })
  const result = await ingestAeliaRates(aeliaAnswer(), { now: NOW }) // Aelia time 2026-10-23T23:36:05Z
  assert.deepEqual(result.refused.map((r) => [r.currency, r.reason]), [['EUR', 'aelia_update_regressed']])
  assert.match(result.refused[0].message, /2026-10-24T10:00:00\.000Z/)
  assert.deepEqual(result.written, ['USD'], 'older stored row: a new rate')
  assert.deepEqual(result.unchanged, ['NOK'], 'the same time and rate: the idempotent re-read')
  assert.deepEqual(result.missing, ['EUR'])
  assert.equal(rowOf('EUR').length, 2, 'nothing stored for the regressed currency (its history of two rows is untouched)')
  // a later time than every stored row is written
  const later = await ingestAeliaRates(aeliaAnswer({ last_update: '2026-10-24T11:00:00Z' }), { now: new Date('2026-10-24T12:00:00Z') })
  assert.deepEqual(later.written.sort(), ['EUR', 'NOK', 'USD'])
  assert.deepEqual(later.missing, [])
})

test('SOURCE RE-CHECK: the regular ingest writes nothing once the source is no longer Aelia (switched back, or never switched); the cutover entry point is not gated', async () => {
  const { ingestAeliaRates, ingestAeliaRatesInTx } = await load()
  for (const source of ['ecb', null]) {
    reset()
    // `reset` gives the Aelia default; override explicitly
    if (source) fake.settings.set('fx_rate_source', source)
    else fake.settings.delete('fx_rate_source')
    await assert.rejects(ingestAeliaRates(aeliaAnswer(), { now: NOW }), (e: Error & { reason?: string }) => e.reason === 'source_changed')
    assert.equal(fake.rates.length, 0, 'nothing written')
    assert.equal(fake.events.filter((e) => e.startsWith('fxRate.create')).length, 0)
  }
  // the in-transaction entry point (the cutover runs it while the source is still ECB) is not gated
  reset()
  fake.settings.set('fx_rate_source', 'ecb')
  const result = await fake.db.$transaction((tx) => ingestAeliaRatesInTx(tx as never, aeliaAnswer(), { now: NOW }))
  assert.deepEqual(result.written.sort(), ['EUR', 'NOK', 'USD'])
})

test('SOURCE RE-CHECK: clearOverrideFromAelia after the switch back to ECB is refused and stores nothing', async () => {
  const { clearOverrideFromAelia } = await load()
  reset({ rates: [pinRow('EUR', '1.3')] })
  fake.settings.set('fx_rate_source', 'ecb')
  await assert.rejects(clearOverrideFromAelia(aeliaAnswer(), 'EUR', { now: NOW }), (e: Error & { reason?: string }) => e.reason === 'source_changed')
  assert.equal(fake.rates.length, 1, 'the pin is the only row')
  // CONTROL: under the Aelia source the same call stores the row
  fake.settings.set('fx_rate_source', 'aelia')
  assert.deepEqual(await clearOverrideFromAelia(aeliaAnswer(), 'EUR', { now: NOW }), { rate: '1.194344', markup: '0.02' })
  assert.equal(fake.rates.length, 2)
})

test('PINS ARE JUDGED AT THE READ\'S INSTANT: a manual row dated after `now` is no pin (omitted: missing; listed: Aelia\'s row is written); a row dated at or before it is', async () => {
  const { ingestAeliaRates } = await load()
  const future = pinRow('USD', '1.4', '2026-10-30T00:00:00Z') // NOW is 2026-10-24T08:00
  reset({ rates: [aeliaRow('USD', '1.2', '2026-10-01T00:00:00Z'), future] })
  const omitted = await ingestAeliaRates(answerWithout('USD'), { now: NOW })
  assert.deepEqual(omitted.pinned, [])
  assert.deepEqual(omitted.missing, ['USD'])
  reset({ rates: [aeliaRow('USD', '1.2', '2026-10-01T00:00:00Z'), future] })
  const listed = await ingestAeliaRates(aeliaAnswer(), { now: NOW })
  assert.deepEqual(listed.pinned, [])
  assert.deepEqual(listed.skippedManualOverrides, [])
  assert.ok(listed.written.includes('USD'), 'the refresh stores Aelia\'s rate for it: the future row is not in force')
  // in force exactly at `now`
  reset({ rates: [pinRow('USD', '1.4', NOW.toISOString())] })
  assert.deepEqual((await ingestAeliaRates(answerWithout('USD'), { now: NOW })).pinned, ['USD'])
})
