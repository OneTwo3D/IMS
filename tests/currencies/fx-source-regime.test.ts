import assert from 'node:assert/strict'
import test from 'node:test'

import { getFxRateToBase, resolveFxRatesToBase } from '@/lib/currencies/fx-lookup'
import { selectFxRateFromRows, type FxRateRow } from '@/lib/currencies/fx-select'
import { FxSourceHistoryUnreadableError, appendFxSourceSwitch, fxRegimeRestrictsAt, fxSourceRegimeFromSettings, parseFxSourceHistory } from '@/lib/currencies/fx-source-regime'
import { fakeFxClient, type FakeFxRow } from '@/tests/helpers/fx-fake-client'

/**
 * THE SOURCE REGIME OF THE ONE LOOKUP (lib/currencies/fx-source-regime.ts). While the FX source is Aelia, a lookup dated at or after the cutover instant (fx_rate_source_since) may only use Aelia rows and
 * manual overrides; an ECB row, however new, is not eligible, and a currency Aelia has not given is refused. A lookup dated before the cutover is exactly today's. Every caller shares it: the pure
 * selection (selectFxRateFromRows: first-load, finance reports), and getFxRateToBase / resolveFxRatesToBase (every database caller).
 */

const SINCE = '2026-10-24T00:00:00Z'
const at = (s: string) => new Date(s)
const row = (to: string, rate: string, when: string, source = 'frankfurter', manualOverride = false): FxRateRow & FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: at(when), source, manualOverride })
const regime = fxSourceRegimeFromSettings('aelia', SINCE)
const AFTER = at('2026-10-26T12:00:00Z')
const BEFORE = at('2026-10-20T12:00:00Z')
const settings = { fx_rate_source: 'aelia', fx_rate_source_since: SINCE }

const rows = [
  row('EUR', '1.10', '2026-10-19T06:00:00Z'), // ECB before the cutover
  row('EUR', '1.19', '2026-10-23T23:36:05Z', 'aelia'), // Aelia, dated by Aelia
  row('EUR', '1.18', '2026-10-23T23:50:00Z'), // an ECB row NEWER than Aelia's but still before the cutover
  row('EUR', '1.25', '2026-10-25T06:00:00Z'), // a NEWER ECB row after the cutover
  row('USD', '1.30', '2026-10-25T06:00:00Z'), // an ECB row; Aelia has given no USD
]

test('regime parse: only exactly aelia is a regime; a missing or unreadable instant restricts everything', () => {
  assert.equal(fxSourceRegimeFromSettings(undefined, SINCE), null)
  assert.equal(fxSourceRegimeFromSettings('ecb', SINCE), null)
  assert.equal(fxSourceRegimeFromSettings('Aelia', SINCE), null)
  assert.deepEqual(fxSourceRegimeFromSettings('aelia', SINCE), { aelia: [{ since: at(SINCE), until: null }] })
  assert.equal(fxSourceRegimeFromSettings('aelia', null)?.aelia[0]?.since.getTime(), 0)
  assert.equal(fxSourceRegimeFromSettings('aelia', 'garbage')?.aelia[0]?.since.getTime(), 0)
})

test('pure selection: after the cutover a NEWER ECB row is ignored; the Aelia row is the rate', () => {
  const picked = selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: AFTER, regime })
  assert.equal(picked.rate.toString(), '1.19')
  assert.equal(picked.source, 'aelia')
  // CONTROL: without the regime the newer ECB row wins, so the arm can fail
  assert.equal(selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: AFTER }).rate.toString(), '1.25')
})

test('pure selection: a currency Aelia has not given refuses after the cutover (never an old ECB row)', () => {
  assert.throws(() => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  // a currency with no row at all keeps its own reason
  assert.throws(() => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'NOK', asOf: AFTER, regime }), (e: Error & { reason?: string }) => e.reason === 'no_rate')
})

test('pure selection: a lookup dated BEFORE the cutover is unchanged (past documents keep their rates)', () => {
  assert.equal(selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: BEFORE, regime }).rate.toString(), '1.1')
  // the last instant before the cutover is unchanged; exactly AT the cutover instant the regime applies
  assert.equal(selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: at('2026-10-23T23:59:59.999Z'), regime }).rate.toString(), '1.18')
  assert.equal(selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: at(SINCE), regime }).source, 'aelia')
})

test('pure selection: a manual override still wins (it is eligible and newest)', () => {
  const pinned = [...rows, row('EUR', '1.40', '2026-10-25T12:00:00Z', 'manual', true), row('USD', '1.50', '2026-10-25T12:00:00Z', 'manual', true)]
  const eur = selectFxRateFromRows(pinned, { baseCurrency: 'GBP', currency: 'EUR', asOf: AFTER, regime })
  assert.equal(eur.rate.toString(), '1.4')
  assert.equal(eur.manualOverride, true)
  assert.equal(selectFxRateFromRows(pinned, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.5', 'a pin also covers a currency Aelia has not given')
})

test('database lookup (getFxRateToBase): the same four arms through the real query shape', async () => {
  const client = fakeFxClient(rows, 'GBP', settings)
  const eur = await getFxRateToBase(client, { currency: 'EUR', asOf: AFTER })
  assert.equal(eur.rate.toString(), '1.19')
  assert.equal(eur.source, 'aelia')
  await assert.rejects(getFxRateToBase(client, { currency: 'USD', asOf: AFTER }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: BEFORE })).rate.toString(), '1.1')
  assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: at('2026-10-23T23:59:59.999Z') })).rate.toString(), '1.18', 'just before the cutover: unchanged')
  assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: at(SINCE) })).source, 'aelia', 'exactly at the cutover: the regime applies')
  const pinnedClient = fakeFxClient([...rows, row('USD', '1.50', '2026-10-25T12:00:00Z', 'manual', true)], 'GBP', settings)
  assert.equal((await getFxRateToBase(pinnedClient, { currency: 'USD', asOf: AFTER })).rate.toString(), '1.5')
  // many at once: per-currency outcomes
  const many = await resolveFxRatesToBase(client, { currencies: ['EUR', 'USD'], asOf: AFTER })
  assert.equal(many.get('EUR')?.ok, true)
  const usd = many.get('USD')
  assert.ok(usd && !usd.ok && usd.error.reason === 'no_rate_from_selected_source')
})

test('database lookup: flag OFF (no setting, or ecb) is exactly today\'s plain latest row', async () => {
  for (const s of [{}, { fx_rate_source: 'ecb', fx_rate_source_since: SINCE }] as Array<Record<string, string>>) {
    const client = fakeFxClient(rows, 'GBP', s)
    assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: AFTER })).rate.toString(), '1.25')
    assert.equal((await getFxRateToBase(client, { currency: 'USD', asOf: AFTER })).rate.toString(), '1.3')
  }
})

// ---- THE SWITCH HISTORY: the regime in effect at the lookup's asOf, after later switches ----

const BACK = '2026-11-02T00:00:00Z'
const history = JSON.stringify([{ source: 'aelia', since: SINCE }, { source: 'ecb', since: BACK }])
const afterBack = { fx_rate_source: 'ecb', fx_rate_source_since: BACK, fx_rate_source_history: history }
const historyRows = [
  ...rows,
  row('EUR', '1.40', '2026-11-03T06:00:00Z'), // an ECB row after the switch back
]
const IN_AELIA_PERIOD = at('2026-10-30T12:00:00Z')
const AFTER_BACK = at('2026-11-04T12:00:00Z')

test('history: after a switch back to ECB, a lookup dated in the Aelia period still uses Aelia rows', async () => {
  const client = fakeFxClient(historyRows, 'GBP', afterBack)
  const eur = await getFxRateToBase(client, { currency: 'EUR', asOf: IN_AELIA_PERIOD })
  assert.equal(eur.source, 'aelia')
  assert.equal(eur.rate.toString(), '1.19', 'the ECB rows of 25 Oct (and the later 3 Nov one) are not eligible for an Aelia-period document')
  await assert.rejects(getFxRateToBase(client, { currency: 'USD', asOf: IN_AELIA_PERIOD }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  // pure selection agrees
  const regimeNow = fxSourceRegimeFromSettings('ecb', BACK, history)
  assert.equal(selectFxRateFromRows(historyRows, { baseCurrency: 'GBP', currency: 'EUR', asOf: IN_AELIA_PERIOD, regime: regimeNow }).source, 'aelia')
  // CONTROL: the current-only reading (no history) is the plain latest row, which is the defect
  assert.equal(selectFxRateFromRows(historyRows, { baseCurrency: 'GBP', currency: 'EUR', asOf: IN_AELIA_PERIOD, regime: fxSourceRegimeFromSettings('ecb', BACK) }).rate.toString(), '1.25')
})

test('history: before the first switch and after the switch back are the plain latest row', async () => {
  const client = fakeFxClient(historyRows, 'GBP', afterBack)
  assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: BEFORE })).rate.toString(), '1.1', 'before any recorded switch: today\'s behaviour')
  assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: AFTER_BACK })).rate.toString(), '1.4', 'after the switch back the plain latest row (the ECB one) answers')
  assert.equal((await getFxRateToBase(client, { currency: 'USD', asOf: AFTER_BACK })).rate.toString(), '1.3')
  // the boundaries: the Aelia interval is [since, until)
  const r = fxSourceRegimeFromSettings('ecb', BACK, history)
  assert.equal(fxRegimeRestrictsAt(r, at(SINCE)), true)
  assert.equal(fxRegimeRestrictsAt(r, at('2026-11-01T23:59:59.999Z')), true)
  assert.equal(fxRegimeRestrictsAt(r, at(BACK)), false)
  assert.equal(fxRegimeRestrictsAt(r, at('2026-10-23T23:59:59.999Z')), false)
})

test('history: a second Aelia period after the switch back is a second interval; the earlier gap stays unrestricted', () => {
  const h = JSON.stringify([{ source: 'aelia', since: SINCE }, { source: 'ecb', since: BACK }, { source: 'aelia', since: '2026-11-10T00:00:00Z' }])
  const r = fxSourceRegimeFromSettings('aelia', '2026-11-10T00:00:00Z', h)
  assert.equal(r?.aelia.length, 2)
  assert.equal(fxRegimeRestrictsAt(r, at('2026-10-30T00:00:00Z')), true)
  assert.equal(fxRegimeRestrictsAt(r, at('2026-11-05T00:00:00Z')), false)
  assert.equal(fxRegimeRestrictsAt(r, at('2026-11-11T00:00:00Z')), true)
})

test('history: the current pair is always honoured and an unreadable history is a closed fault, not an absence', () => {
  // the pair says Aelia since X but the history never recorded it: still restricted (strict reading)
  assert.equal(fxRegimeRestrictsAt(fxSourceRegimeFromSettings('aelia', SINCE, JSON.stringify([{ source: 'ecb', since: '2026-01-01T00:00:00Z' }])), AFTER), true)
  assert.equal(parseFxSourceHistory('not json'), null)
  assert.equal(parseFxSourceHistory('[{"source":"x","since":"2026-01-01T00:00:00Z"}]'), null)
  assert.equal(parseFxSourceHistory('[{"source":"ecb","since":"nope"}]'), null)
  assert.deepEqual(fxSourceRegimeFromSettings('ecb', BACK, 'not json'), { aelia: [], unreadable: true })
  assert.equal(fxSourceRegimeFromSettings('ecb', BACK, null), null)
  assert.equal(fxSourceRegimeFromSettings('ecb', BACK, undefined), null)
})

test('history: appendFxSourceSwitch appends one entry, and seeds a pre-history Aelia pair so the first switch back keeps its interval', () => {
  const first = JSON.parse(appendFxSourceSwitch(undefined, 'ecb', undefined, 'aelia', at(SINCE))) as Array<{ source: string; since: string }>
  assert.deepEqual(first, [{ source: 'aelia', since: SINCE.replace('Z', '.000Z') }])
  const second = JSON.parse(appendFxSourceSwitch(JSON.stringify(first), 'aelia', SINCE, 'ecb', at(BACK))) as Array<{ source: string }>
  assert.deepEqual(second.map((x) => x.source), ['aelia', 'ecb'])
  const seeded = JSON.parse(appendFxSourceSwitch(undefined, 'aelia', SINCE, 'ecb', at(BACK))) as Array<{ source: string; since: string }>
  assert.deepEqual(seeded.map((x) => x.source), ['aelia', 'ecb'])
  assert.equal(seeded[0]?.since, SINCE.replace('Z', '.000Z'))
  const r = fxSourceRegimeFromSettings('ecb', BACK, JSON.stringify(seeded))
  assert.equal(fxRegimeRestrictsAt(r, IN_AELIA_PERIOD), true)
})

test('history: entries stored out of order are read oldest first', () => {
  const shuffled = JSON.stringify([{ source: 'ecb', since: BACK }, { source: 'aelia', since: SINCE }])
  assert.deepEqual(parseFxSourceHistory(shuffled)?.map((h) => h.source), ['aelia', 'ecb'])
  const r = fxSourceRegimeFromSettings('ecb', BACK, shuffled)
  assert.equal(fxRegimeRestrictsAt(r, IN_AELIA_PERIOD), true)
  assert.equal(fxRegimeRestrictsAt(r, AFTER_BACK), false)
})

test('an UNREADABLE history refuses every lookup (fx_source_history_unreadable), whatever the current source; an absent one keeps today\'s behaviour', async () => {
  const bad = ['{not json', '{"a":1}', '[{"source":"gold","since":"2026-10-01T00:00:00Z"}]', '[{"source":"ecb","since":"nope"}]', '']
  for (const history of bad) {
    for (const source of ['ecb', 'aelia']) {
      const settingsBad = { fx_rate_source: source, fx_rate_source_since: SINCE, fx_rate_source_history: history }
      assert.deepEqual(fxSourceRegimeFromSettings(source, SINCE, history), { aelia: [], unreadable: true })
      const client = fakeFxClient(rows, 'GBP', settingsBad)
      for (const asOf of [AFTER, BEFORE]) {
        await assert.rejects(getFxRateToBase(client, { currency: 'EUR', asOf }), (e: Error & { reason?: string }) => e.reason === 'fx_source_history_unreadable', `${source} ${JSON.stringify(history)}`)
        const many = await resolveFxRatesToBase(client, { currencies: ['EUR', 'USD'], asOf })
        for (const c of ['EUR', 'USD']) {
          const o = many.get(c)
          assert.ok(o && !o.ok && o.error.reason === 'fx_source_history_unreadable')
        }
      }
    }
    assert.throws(() => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'EUR', asOf: AFTER, regime: fxSourceRegimeFromSettings('ecb', SINCE, history) }), (e: Error & { reason?: string }) => e.reason === 'fx_source_history_unreadable')
  }
  // the base currency needs no rate and is not a lookup of the table
  assert.equal((await getFxRateToBase(fakeFxClient(rows, 'GBP', { fx_rate_source_history: '{bad' }), { currency: 'GBP', asOf: AFTER })).isBase, true)
  // CONTROL: an absent history, and a readable empty one, behave as before
  assert.equal((await getFxRateToBase(fakeFxClient(rows, 'GBP', { fx_rate_source: 'ecb' }), { currency: 'EUR', asOf: AFTER })).rate.toString(), '1.25')
  assert.equal((await getFxRateToBase(fakeFxClient(rows, 'GBP', { fx_rate_source: 'ecb', fx_rate_source_history: '[]' }), { currency: 'EUR', asOf: AFTER })).rate.toString(), '1.25')
})

test('history: a switch is REFUSED while a present history is unreadable, and an absent or empty-array one is fine', () => {
  for (const bad of ['{not json', '{"a":1}', '[{"source":"gold","since":"2026-10-01T00:00:00Z"}]', '[{"source":"ecb","since":"nope"}]', '']) {
    assert.throws(() => appendFxSourceSwitch(bad, 'aelia', SINCE, 'ecb', at(BACK)), (e: unknown) => e instanceof FxSourceHistoryUnreadableError && e.reason === 'fx_source_history_unreadable' && /fx_source_history_unreadable/.test(e.message), JSON.stringify(bad))
  }
  // CONTROL: absent, null and a readable empty history are not faults
  for (const ok of [undefined, null, '[]']) assert.doesNotThrow(() => appendFxSourceSwitch(ok, 'aelia', SINCE, 'ecb', at(BACK)))
})

test('a manual override is a PIN only while it is the latest row across ALL sources: a later row of any source supersedes it (pin, then clear, then Aelia)', async () => {
  const pin = row('USD', '1.50', '2026-10-21T12:00:00Z', 'manual', true)
  const cleared = row('USD', '1.31', '2026-10-22T12:00:00Z') // clearing a pin inserts a newer non-manual (ECB) row and leaves the old manual row
  const both = [...rows.filter((r) => r.toCurrency !== 'USD'), pin, cleared]
  // pure selection: the superseded pin is not eligible, and the cleared rate (ECB) is not either, so USD is refused after the cutover
  assert.throws(() => selectFxRateFromRows(both, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  // database lookup, the same
  const client = fakeFxClient(both, 'GBP', settings)
  await assert.rejects(getFxRateToBase(client, { currency: 'USD', asOf: AFTER }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  const many = await resolveFxRatesToBase(client, { currencies: ['USD'], asOf: AFTER })
  const usd = many.get('USD')
  assert.ok(usd && !usd.ok && usd.error.reason === 'no_rate_from_selected_source')
  // an Aelia row, when there is one, answers instead of the old pin
  const withAelia = [...both, row('USD', '1.40', '2026-10-24T06:00:00Z', 'aelia')]
  assert.equal((await getFxRateToBase(fakeFxClient(withAelia, 'GBP', settings), { currency: 'USD', asOf: AFTER })).rate.toString(), '1.4')
  assert.equal(selectFxRateFromRows(withAelia, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.4')
  // a pin newer than everything is IN FORCE and is used, also over an older Aelia row
  const pinnedNow = [...withAelia, row('USD', '1.60', '2026-10-25T12:00:00Z', 'manual', true)]
  assert.equal(selectFxRateFromRows(pinnedNow, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.6')
  assert.equal((await getFxRateToBase(fakeFxClient(pinnedNow, 'GBP', settings), { currency: 'USD', asOf: AFTER })).manualOverride, true)
  // a pin superseded by a later ECB row BEFORE the lookup's asOf only: looked up earlier, it was still in force
  assert.equal(selectFxRateFromRows(both, { baseCurrency: 'GBP', currency: 'USD', asOf: at('2026-10-21T18:00:00Z'), regime: fxSourceRegimeFromSettings('aelia', '2026-10-21T00:00:00Z') }).rate.toString(), '1.5')
  // CONTROL: outside the regime the plain latest row (the cleared ECB rate) answers
  assert.equal(selectFxRateFromRows(both, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER }).rate.toString(), '1.31')
})

test('a fetchedAt TIE goes to the later write (seq), also over a pin; rows without a seq stay ambiguous as before', async () => {
  const T = '2026-10-22T12:00:00Z'
  const pinFirst = [{ ...row('USD', '1.50', T, 'manual', true), seq: 1 }, { ...row('USD', '1.31', T), seq: 2 }]
  const pinLast = [{ ...row('USD', '1.31', T), seq: 1 }, { ...row('USD', '1.50', T, 'manual', true), seq: 2 }]
  const noSeq = [row('USD', '1.50', T, 'manual', true), row('USD', '1.31', T)]
  // outside the regime
  assert.equal(selectFxRateFromRows(pinFirst, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER }).rate.toString(), '1.31', 'a clear written after the pin wins')
  assert.equal(selectFxRateFromRows(pinLast, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER }).rate.toString(), '1.5', 'a pin written after the refresh wins')
  assert.throws(() => selectFxRateFromRows(noSeq, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER }), (e: Error & { reason?: string }) => e.reason === 'ambiguous_rate')
  // under the regime: a pin written first is superseded, a pin written last is in force
  assert.throws(() => selectFxRateFromRows(pinFirst, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  assert.equal(selectFxRateFromRows(pinLast, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.5')
  // the database lookup, through the fake client that returns the rows as given
  await assert.rejects(getFxRateToBase(fakeFxClient(pinFirst, 'GBP', settings), { currency: 'USD', asOf: AFTER }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
  assert.equal((await getFxRateToBase(fakeFxClient(pinLast, 'GBP', settings), { currency: 'USD', asOf: AFTER })).rate.toString(), '1.5')
  assert.equal((await getFxRateToBase(fakeFxClient(pinFirst, 'GBP', {}), { currency: 'USD', asOf: AFTER })).rate.toString(), '1.31')
  // a later Aelia write over a pin at the same instant also supersedes the pin; an earlier one does not
  const aeliaLast = [{ ...row('USD', '1.50', T, 'manual', true), seq: 1 }, { ...row('USD', '1.40', T, 'aelia'), seq: 2 }]
  assert.equal(selectFxRateFromRows(aeliaLast, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.4')
  const aeliaFirst = [{ ...row('USD', '1.40', T, 'aelia'), seq: 1 }, { ...row('USD', '1.50', T, 'manual', true), seq: 2 }]
  assert.equal(selectFxRateFromRows(aeliaFirst, { baseCurrency: 'GBP', currency: 'USD', asOf: AFTER, regime }).rate.toString(), '1.5')
})
