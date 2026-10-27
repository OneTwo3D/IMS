import assert from 'node:assert/strict'
import test from 'node:test'

import { getFxRateToBase, resolveFxRatesToBase } from '@/lib/currencies/fx-lookup'
import { selectFxRateFromRows, type FxRateRow } from '@/lib/currencies/fx-select'
import { fxSourceRegimeFromSettings } from '@/lib/currencies/fx-source-regime'
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
  assert.deepEqual(fxSourceRegimeFromSettings('aelia', SINCE), { source: 'aelia', since: at(SINCE) })
  assert.equal(fxSourceRegimeFromSettings('aelia', null)?.since.getTime(), 0)
  assert.equal(fxSourceRegimeFromSettings('aelia', 'garbage')?.since.getTime(), 0)
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
