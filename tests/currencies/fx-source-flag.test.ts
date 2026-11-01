import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { aeliaAnswer, createFxSourceFakeDb } from '@/tests/helpers/fx-source-fake-db'

/**
 * THE FX SOURCE FLAG (setting `fx_rate_source`, default OFF = 'ecb').
 *   OFF: the scheduled refresh fetches frankfurter exactly as before; the IMS -> WooCommerce push works.
 *   ON ('aelia'): the refresh reads Aelia and never contacts frankfurter; the push is disabled at every level; health judges Aelia's freshness.
 * Database, transport and facade are faked; the lock, the refresh and the push code are real.
 */

const ACTIVE = [{ code: 'GBP', active: true }, { code: 'EUR', active: true }, { code: 'USD', active: true }, { code: 'NOK', active: true }]
let fake = createFxSourceFakeDb()
const calls = { aeliaRead: 0, frankfurter: 0, connectorPush: 0, facadePush: 0, wcFetch: 0, lockHeld: 0 }
let aeliaAnswerBody: unknown = aeliaAnswer()
let aeliaReadResult: { ok: boolean; body?: unknown; reason?: string; message?: string } | null = null

mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get: (_t, k) => (fake.db as never)[k] }) } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/shopping', { namedExports: { pushFxRatesToConnectors: async () => { calls.facadePush += 1; return [] } } })
mock.module('@/lib/connectors/woocommerce/sync/order-import', { namedExports: { retryPendingWcOrdersWaitingForFx: async () => ({ attempted: 0, imported: 0, stillPending: 0, failed: 0 }) } })
mock.module('@/lib/connectors/woocommerce/aelia-rates', {
  namedExports: {
    readAeliaRatesFromWc: async () => { calls.aeliaRead += 1; return aeliaReadResult ?? { ok: true, body: aeliaAnswerBody } },
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret'], ['wc_fx_push_enabled', 'true']]),
  },
})
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async () => { calls.wcFetch += 1; return wcReply() },
  },
})

let lockLost = false
let wcReply = (): Response => new Response(JSON.stringify({ ok: true, pushed: 3 }), { status: 200 })
const RETIRED_REPLY = () => new Response(JSON.stringify({ code: 'oti_fx_push_retired', message: 'retired', data: { status: 410 } }), { status: 410 })

const realFetch = globalThis.fetch
function installFrankfurter() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    assert.match(url, /^https:\/\/api\.frankfurter\.dev\//, 'the only outbound call of the ECB path is frankfurter')
    calls.frankfurter += 1
    return new Response(JSON.stringify({ rates: { EUR: 1.1, USD: 1.25, NOK: 12.1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
function reset(source?: string) {
  fake = createFxSourceFakeDb({ currencies: ACTIVE, settings: source ? { fx_rate_source: source } : {} })
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0
  aeliaAnswerBody = aeliaAnswer()
  aeliaReadResult = null
  installFrankfurter()
}
test.afterEach(() => { globalThis.fetch = realFetch })

test('the source parses to ecb unless it is exactly aelia (default OFF; garbage is OFF)', async () => {
  const { parseFxRateSource, getFxRateSource } = await import('@/lib/currencies/fx-source')
  for (const v of [undefined, null, '', 'ecb', 'ECB', 'Aelia', 'aelia ', 'true', '1']) assert.equal(parseFxRateSource(v), 'ecb', String(v))
  assert.equal(parseFxRateSource('aelia'), 'aelia')
  reset()
  assert.equal(await getFxRateSource(), 'ecb', 'no setting row = OFF')
})

test('flag OFF: the scheduled refresh is today\'s: frankfurter is fetched, rows are source frankfurter, the push fan-out runs, Aelia is never read', async () => {
  reset()
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(result.success, true)
  assert.deepEqual([...result.updated].sort(), ['EUR', 'NOK', 'USD'])
  assert.equal(calls.frankfurter, 1)
  assert.equal(calls.aeliaRead, 0)
  assert.deepEqual([...new Set(fake.rates.map((r) => r.source))], ['frankfurter'])
  assert.equal(calls.facadePush, 1, 'the rate push still follows an ECB fetch')
  assert.equal(fake.settings.has('fx_last_fetched'), true)
  assert.equal(fake.settings.has('fx_aelia_last_update_at'), false)
})

test('flag ON: the scheduled refresh reads Aelia instead of frankfurter, stores source aelia at Aelia\'s time, and does not push', async () => {
  reset('aelia')
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(result.success, true)
  assert.deepEqual([...result.updated].sort(), ['EUR', 'NOK', 'USD'])
  assert.equal(calls.aeliaRead, 1)
  assert.equal(calls.frankfurter, 0, 'frankfurter is never contacted')
  assert.equal(calls.facadePush, 0, 'IMS does not push rates when Aelia is the master')
  assert.deepEqual([...new Set(fake.rates.map((r) => r.source))], ['aelia'])
  assert.equal(fake.rates.find((r) => r.toCurrency === 'EUR')?.rate, '1.194344')
  assert.equal(fake.settings.get('fx_aelia_last_update_at'), '2026-10-23T23:36:05.000Z', 'freshness is Aelia\'s own time')
  assert.equal(fake.settings.get('fx_last_fetch_attempt_status'), 'success')
  // a second scheduled run re-reads the same Aelia update: no new rows
  const again = await fetchAllFxRatesInternal()
  assert.deepEqual(again.updated, [])
  assert.equal(fake.rates.length, 3)
})

test('flag ON: an unreadable Aelia is a visible failure; there is NO frankfurter fallback and no rate is invented', async () => {
  reset('aelia')
  aeliaReadResult = { ok: false, reason: 'http_status', message: 'The helper plugin answered HTTP 404.' }
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(result.success, false)
  assert.equal(calls.frankfurter, 0)
  assert.equal(fake.rates.length, 0)
  assert.equal(fake.settings.get('fx_last_fetch_attempt_status'), 'failed')
  // a base-currency mismatch is refused as a whole
  reset('aelia')
  aeliaAnswerBody = aeliaAnswer({ base: 'EUR' })
  const mismatch = await fetchAllFxRatesInternal()
  assert.equal(mismatch.success, false)
  assert.match(String(mismatch.error), /base_mismatch/)
  assert.equal(fake.rates.length, 0)
  assert.equal(calls.frankfurter, 0)
})

test('flag ON: a missing or non-positive rate is reported per currency (status partial), the rest is stored', async () => {
  reset('aelia')
  aeliaAnswerBody = aeliaAnswer({ rates: [{ currency: 'EUR', rate: '0' }, { currency: 'USD', rate: '1.336829' }] })
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(result.success, true)
  assert.deepEqual(result.updated, ['USD'])
  assert.deepEqual([...result.failed].sort(), ['EUR', 'NOK'])
  assert.equal(fake.settings.get('fx_last_fetch_attempt_status'), 'partial')
  assert.deepEqual(fake.rates.map((r) => r.toCurrency), ['USD'])
})

test('the push to WooCommerce: flag OFF unchanged (it goes to the store); flag ON disabled at the lowest level, nothing sent', async () => {
  // The push holds the FX table lock shared (a real-database arm is in tests/concurrency/fx-source-cutover.concurrent.test.ts); here the lock is a recording pass-through.
  const realLock = await import('@/lib/currencies/fx-table-lock')
  mock.module('@/lib/currencies/fx-table-lock', {
    namedExports: { ...realLock, withFxTableHeldStill: async (work: (g: { lost: boolean; assertHeld: () => void }) => unknown) => { calls.lockHeld += 1; return work({ lost: lockLost, assertHeld: () => {} }) } },
  })
  const { pushFxRatesToWc, pushCurrentFxRatesToWc } = await import('@/lib/connectors/woocommerce/fx-rates')
  const { AELIA_PUSH_DISABLED_MESSAGE } = await import('@/lib/currencies/fx-source')
  const rates = [{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.19, fetchedAt: '2026-10-23T23:36:05Z' }]

  wcReply = () => new Response(JSON.stringify({ ok: true, pushed: 3 }), { status: 200 })
  reset()
  const off = await pushFxRatesToWc(rates)
  assert.deepEqual(off, { supported: true, pushed: 3, errors: [] })
  assert.equal(calls.wcFetch, 1, 'CONTROL: with the flag off the push really reaches the transport')
  assert.equal(calls.lockHeld, 1, 'the push ran inside the FX table lock')

  reset('aelia')
  assert.deepEqual(await pushFxRatesToWc(rates), { supported: false, pushed: 0, errors: [AELIA_PUSH_DISABLED_MESSAGE] })
  assert.deepEqual(await pushCurrentFxRatesToWc(), { supported: false, pushed: 0, errors: [AELIA_PUSH_DISABLED_MESSAGE] })
  assert.equal(calls.wcFetch, 0, 'nothing is sent while Aelia is the source')
})

test('the store refuses the push for good (plugin 1.3.0, 410 oti_fx_push_retired): terminal, no error, sent once, and a lost lock changes nothing', async () => {
  // A push whose lock connection died after the check: the lock is gone (lost) but the POST still goes out; the STORE refuses it.
  lockLost = true
  const { pushFxRatesToWc, FX_PUSH_RETIRED_MESSAGE } = await import('@/lib/connectors/woocommerce/fx-rates')
  const rates = [{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.19, fetchedAt: '2026-10-23T23:36:05Z' }]
  reset()
  wcReply = RETIRED_REPLY
  try {
    assert.deepEqual(await pushFxRatesToWc(rates), { supported: true, pushed: 0, errors: [], retired: true })
    assert.equal(calls.wcFetch, 1, 'one request, no retry')
    // a 403 with the same code is the same terminal answer
    wcReply = () => new Response(JSON.stringify({ code: 'oti_fx_push_retired' }), { status: 403 })
    assert.equal((await pushFxRatesToWc(rates)).retired, true)
    // CONTROL: any other refusal is an ordinary error (so the detection can fail)
    wcReply = () => new Response('Forbidden', { status: 403 })
    const other = await pushFxRatesToWc(rates)
    assert.equal(other.retired, undefined)
    assert.equal(other.errors.length, 1)
    wcReply = () => new Response('Gone', { status: 410 })
    assert.equal((await pushFxRatesToWc(rates)).retired, undefined, 'a 410 without the code is not the retirement')
  } finally {
    lockLost = false
    wcReply = () => new Response(JSON.stringify({ ok: true, pushed: 3 }), { status: 200 })
  }
  assert.match(FX_PUSH_RETIRED_MESSAGE, /retired/)
})

test('the retirement is logged as SKIPPED once per run (never FAILED, never a WARNING) by both callers', () => {
  const shopping = readFileSync('lib/shopping.ts', 'utf8')
  const fan = shopping.slice(shopping.indexOf('if (pushResult.retired)'), shopping.indexOf('if (pushResult.errors.length)'))
  assert.match(fan, /status: 'SKIPPED'/)
  assert.doesNotMatch(fan.replace(/\/\/.*$/gm, ''), /FAILED|WARNING|logActivity/)
  const action = readFileSync('app/actions/wc-sync.ts', 'utf8')
  const now = action.slice(action.indexOf('if (result.retired)'), action.indexOf('if (result.errors.length)', action.indexOf('if (result.retired)')))
  assert.match(now, /status: 'SKIPPED'/)
  assert.match(now, /supported: false/)
  assert.doesNotMatch(now, /FAILED/)
  // the retired check precedes the error and success branches in both
  assert.ok(shopping.indexOf('if (pushResult.retired)') < shopping.indexOf("status: 'OK'"))
  assert.ok(action.indexOf('if (result.retired)') < action.indexOf("status: 'OK'", action.indexOf('if (result.retired)')))
})

test('the other push entry points check the flag first (facade fan-out and the Push Now button), before the producer seam', () => {
  const shopping = readFileSync('lib/shopping.ts', 'utf8')
  const fanout = shopping.slice(shopping.indexOf('export async function pushFxRatesToConnectors'))
  assert.ok(fanout.indexOf("getFxRateSource()) === 'aelia'") > 0, 'the facade checks the flag')
  assert.ok(fanout.indexOf("getFxRateSource()) === 'aelia'") < fanout.indexOf('wooProducerSeam('), 'and before the producer seam leaves a shadow record')
  const action = readFileSync('app/actions/wc-sync.ts', 'utf8')
  const now = action.slice(action.indexOf('export async function pushFxRatesToWcNow'))
  assert.ok(now.indexOf("getFxRateSource()) === 'aelia'") > 0 && now.indexOf("getFxRateSource()) === 'aelia'") < now.indexOf('wooFxRatePushShadow'), 'Push Now checks the flag first')
  assert.ok(now.indexOf("getFxRateSource()) === 'aelia'") < now.indexOf('pushCurrentFxRatesToWc'))
})

test('health: with the Aelia source the freshness judged is Aelia\'s own update time and the reference says aelia', async () => {
  const { buildFxSyncHealthFromLastFetched } = await import('@/lib/ops/health')
  const now = new Date('2026-10-24T08:00:00Z')
  const fresh = buildFxSyncHealthFromLastFetched('2026-10-23T23:36:05.000Z', now, {}, 'aelia')
  assert.equal(fresh.status, 'ok')
  assert.equal(fresh.reference, 'aelia')
  const stale = buildFxSyncHealthFromLastFetched('2026-10-20T23:36:05.000Z', now, {}, 'aelia')
  assert.equal(stale.status, 'warning')
  assert.equal(stale.lastStatus, 'stale')
  assert.match(String(stale.message), /Aelia/)
  const none = buildFxSyncHealthFromLastFetched(null, now, {}, 'aelia')
  assert.equal(none.status, 'warning')
  // default (flag off) is unchanged
  const ecb = buildFxSyncHealthFromLastFetched('2026-10-23T23:36:05.000Z', now)
  assert.equal(ecb.reference, 'frankfurter')
  // and the wiring: the health reader picks the Aelia key only for the Aelia source
  const src = readFileSync('lib/ops/health.ts', 'utf8')
  assert.match(src, /fxSource === 'aelia' \? 'fx_aelia_last_update_at' : 'fx_last_fetched'/)
})

test('the other frankfurter callers stand aside under the Aelia source: a new currency is not fetched from frankfurter, and clearing a pin takes Aelia\'s rate', () => {
  const src = readFileSync('app/actions/currencies.ts', 'utf8')
  const single = src.slice(src.indexOf('async function fetchSingleFxRate'), src.indexOf('/** Fetch FX rates for all active currencies'))
  assert.ok(single.indexOf("getFxRateSource()) === 'aelia') return null") > 0)
  assert.ok(single.indexOf("getFxRateSource()) === 'aelia') return null") < single.indexOf('await fetch('), 'checked before frankfurter is asked')
  const clear = src.slice(src.indexOf('export async function clearManualFxRate'), src.indexOf('export type FxPushLogRow'))
  const guard = clear.indexOf("getFxRateSource()) === 'aelia'")
  assert.ok(guard > 0 && guard < clear.indexOf('await fetch('), 'checked before frankfurter is asked')
  assert.ok(clear.indexOf('clearOverrideFromAelia(read.body, code, ') > guard && clear.indexOf('clearOverrideFromAelia(read.body, code, ') < clear.indexOf('await fetch('))
  assert.match(clear.slice(guard, clear.indexOf('await fetch(')), /return \{ success: true \}/, 'the Aelia branch returns before the frankfurter code')
})

test('the setting key is fx_rate_source and the source switch is a settings.company action', () => {
  const src = readFileSync('app/actions/currencies.ts', 'utf8')
  const action = src.slice(src.indexOf('export async function setFxRateSource'))
  assert.match(action, /requirePermission\('settings\.company'\)/)
  assert.match(readFileSync('lib/currencies/fx-source-regime.ts', 'utf8'), /FX_RATE_SOURCE_SETTING = 'fx_rate_source'/)
  assert.match(readFileSync('lib/currencies/fx-source-regime.ts', 'utf8'), /FX_RATE_SOURCE_SINCE_SETTING = 'fx_rate_source_since'/)
})

test('CUTOVER BARRIER, refresh half: an ECB refresh that was in flight when the source switched to Aelia stores NO ECB row', async () => {
  reset()
  // the switch commits while frankfurter is being asked (what setFxRateSource does, under the exclusive lock)
  globalThis.fetch = (async () => {
    calls.frankfurter += 1
    fake.settings.set('fx_rate_source', 'aelia')
    return new Response(JSON.stringify({ rates: { EUR: 1.1, USD: 1.25, NOK: 12.1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const result = await fetchAllFxRatesInternal()
  assert.equal(calls.frankfurter, 1, 'PRECONDITION: the ECB fetch really happened')
  assert.equal(result.success, false)
  assert.deepEqual(result.updated, [])
  assert.equal(fake.rates.length, 0, 'no ECB row stored after the switch')
  assert.equal(calls.facadePush, 0)
  assert.equal(fake.settings.has('fx_last_fetched'), false)
})

test('CUTOVER BARRIER, wiring: setFxRateSource writes source and instant together under the exclusive lock; the other frankfurter writers re-read the source inside their lock', () => {
  const src = readFileSync('app/actions/currencies.ts', 'utf8')
  const sw = src.slice(src.indexOf('export async function setFxRateSource'))
  assert.match(sw, /withFxTableWriteLock\(async \(tx\) => \{[\s\S]*?FX_RATE_SOURCE_SETTING[\s\S]*?FX_RATE_SOURCE_SINCE_SETTING[\s\S]*?\}\)/)
  const swBody = sw.slice(0, sw.indexOf('revalidatePath'))
  assert.equal((swBody.match(/\btx\.setting\.upsert\(/g) ?? []).length, 5, 'the source, its instant, the switch history and Aelia\'s two freshness stamps are ALL written through the lock transaction')
  assert.equal((swBody.match(/\bdb\.setting\./g) ?? []).length, 0, 'nothing of the switch is written outside the lock transaction')
  const single = src.slice(src.indexOf('async function fetchSingleFxRate'), src.indexOf('/** Fetch FX rates for all active currencies'))
  assert.ok(single.indexOf('withFxTableWriteLock') < single.indexOf("getFxRateSourceInTx(tx)") && single.indexOf("getFxRateSourceInTx(tx)") < single.indexOf('tx.fxRate.create'))
  const clear = src.slice(src.indexOf('export async function clearManualFxRate'), src.indexOf('export type FxPushLogRow'))
  assert.ok(clear.lastIndexOf('withFxTableWriteLock') < clear.lastIndexOf("getFxRateSourceInTx(tx)") && clear.lastIndexOf("getFxRateSourceInTx(tx)") < clear.lastIndexOf('tx.fxRate.create'))
  const refresh = readFileSync('lib/currencies/fx-refresh.ts', 'utf8')
  const ecb = refresh.slice(refresh.indexOf('let sourceChanged = false'), refresh.indexOf('recordFxFetchAttempt({\n      status: failed.length'))
  assert.ok(ecb.indexOf("getFxRateSourceInTx(tx)") < ecb.indexOf('tx.fxRate.create'))
  const push = readFileSync('lib/connectors/woocommerce/fx-rates.ts', 'utf8')
  assert.match(push, /withFxTableHeldStill\(async \(guard\)/)
  const locked = push.slice(push.indexOf('withFxTableHeldStill(async (guard)'), push.indexOf('export type FxHelperPluginProbe'))
  assert.ok(locked.indexOf("getFxRateSource()) === 'aelia'") < locked.indexOf('connectorFetch('), 'the source is checked inside the lock, before the POST')
  assert.match(locked, /guard\.assertHeld\('sending the exchange-rate push'\)/, 'a dead lock connection stops the push before the POST')
  assert.ok(locked.indexOf("guard.assertHeld") >= 0 && locked.indexOf("guard.assertHeld") < locked.indexOf('connectorFetch('))
  assert.match(locked, /signal: AbortSignal\.timeout\(PUSH_TIMEOUT_MS\)/, 'the POST is bounded, so the shared hold is bounded')
  assert.match(push, /const PUSH_TIMEOUT_MS = 15_000/)
  const fin = readFileSync('lib/domain/finance/finance-period-analytics.ts', 'utf8')
  assert.equal((fin.match(/settlementRateToBase\([^)]*fxRegime(?:, [A-Za-z.]+)?\)/g) ?? []).length, 2, 'the FX gain/loss report applies the source regime to both of its lookups')
  assert.match(fin, /getFxSourceRegime\(\{ setting: client\.setting/)
})
