import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { aeliaAnswer, createFxSourceFakeDb, type FakeFxRateRow } from '@/tests/helpers/fx-source-fake-db'

/**
 * THE CUTOVER TO AELIA READS AND INGESTS FIRST (setFxRateSource in app/actions/currencies.ts; lib/currencies/aelia-cutover.ts).
 * Switching TO Aelia reads the helper plugin once and ingests the answer INSIDE the exclusive FX table lock, and commits the switch only if every IMS-enabled foreign currency has a valid pre-markup
 * rate from that read. Otherwise the transaction rolls back: the source stays ECB, no Aelia row is stored, the refusal names what is missing. Switching back to ECB needs no read.
 * Database and transport are faked (no network); the lock, the ingest and the action are real.
 */

const ACTIVE = [{ code: 'GBP', active: true }, { code: 'EUR', active: true }, { code: 'USD', active: true }, { code: 'NOK', active: true }, { code: 'JPY', active: false }]
const ecbRow = (to: string, rate: string, fetchedAt = '2026-10-25T06:00:00Z', extra: Partial<FakeFxRateRow> = {}): FakeFxRateRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: new Date(fetchedAt), source: 'frankfurter', manualOverride: false, ...extra })
const ECB_ROWS = () => [ecbRow('EUR', '1.10'), ecbRow('USD', '1.25'), ecbRow('NOK', '12.1')]

let fake = createFxSourceFakeDb()
const calls = { read: 0 }
type ReadResult = { ok: true; body: unknown } | { ok: false; reason: string; message: string }
let readImpl: () => Promise<ReadResult> = async () => ({ ok: true, body: aeliaAnswer() })

mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get: (_t, k) => (fake.db as never)[k] }) } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/settings-store', {
  namedExports: { getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret']]) },
})
mock.module('@/lib/connectors/woocommerce/aelia-rates', { namedExports: { readAeliaRatesFromWc: async () => { calls.read += 1; return readImpl() } } })

function reset(rates: FakeFxRateRow[] = ECB_ROWS(), settings: Record<string, string> = {}) {
  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates, settings })
  calls.read = 0
  readImpl = async () => ({ ok: true, body: aeliaAnswer() })
}
const aeliaRows = () => fake.rates.filter((r) => r.source === 'aelia')
const answerWithout = (code: string) => aeliaAnswer({ rates: (aeliaAnswer().rates as Array<{ currency: string }>).filter((r) => r.currency !== code) })

test('FIRST CUTOVER: existing ECB rows, no Aelia rows, a complete read: ends switched, Aelia rows stored (pre-markup), lookups work, the read happened under the lock', async () => {
  reset()
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const { selectFxRateFromRows } = await import('@/lib/currencies/fx-select')
  const { fxSourceRegimeFromSettings } = await import('@/lib/currencies/fx-source-regime')
  assert.equal(aeliaRows().length, 0, 'PRECONDITION: no Aelia row yet')

  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  assert.equal(fake.settings.get('fx_rate_source'), 'aelia')
  assert.ok(fake.settings.get('fx_rate_source_since'))
  assert.deepEqual(aeliaRows().map((r) => r.toCurrency).sort(), ['EUR', 'NOK', 'USD'])
  assert.equal(aeliaRows().find((r) => r.toCurrency === 'EUR')?.rate, '1.194344', 'the rate before markup, not rate + 0.02')
  assert.equal(aeliaRows().some((r) => r.toCurrency === 'JPY'), false, 'a switched-off currency is not wanted')
  assert.equal(fake.settings.get('fx_aelia_last_update_at'), '2026-10-23T23:36:05.000Z')
  // the read and the writes all sit between the lock statement and the end of ONE transaction
  const ev = fake.events
  assert.ok(ev.indexOf('lock') >= 0 && ev.indexOf('lock') < ev.indexOf('fxRate.create(in lock tx)'))
  assert.equal(ev.filter((e) => e === 'fxRate.create(OUTSIDE lock tx)').length, 0)
  assert.equal(ev.filter((e) => e === 'tx.begin').length, 1, 'one transaction for the read, the ingest and the switch')
  assert.equal(ev.includes('tx.rollback'), false)

  // LOOKUPS WORK straight away: after the cutover instant each foreign currency resolves to the Aelia rate (the newer ECB row would have been refused or wrong)
  const regime = fxSourceRegimeFromSettings(fake.settings.get('fx_rate_source'), fake.settings.get('fx_rate_source_since'))
  const asOf = new Date(Date.now() + 1000)
  for (const [code, rate] of [['EUR', '1.194344'], ['USD', '1.336829'], ['NOK', '12.500597']]) {
    const picked = selectFxRateFromRows(fake.rates, { baseCurrency: 'GBP', currency: code, asOf, regime })
    assert.equal(picked.source, 'aelia', code)
    assert.equal(picked.rate.toString(), rate, code)
  }
  // CONTROL: had the switch been made without the ingest, the same lookup refuses (the bug this fixes)
  reset()
  fake.settings.set('fx_rate_source', 'aelia')
  fake.settings.set('fx_rate_source_since', new Date().toISOString())
  const r2 = fxSourceRegimeFromSettings(fake.settings.get('fx_rate_source'), fake.settings.get('fx_rate_source_since'))
  assert.throws(() => selectFxRateFromRows(fake.rates, { baseCurrency: 'GBP', currency: 'EUR', asOf: new Date(Date.now() + 1000), regime: r2 }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source')
})

test('a FAILED read refuses the switch: the source stays ecb, no row written, nothing half-switched, the reason is shown', async () => {
  reset()
  readImpl = async () => ({ ok: false, reason: 'http_status', message: 'The helper plugin answered HTTP 404. Is onetwoInventory Helper 1.3.0 or later installed and active, with the shared secret set?' })
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const before = fake.rates.length
  const result = await setFxRateSource('aelia')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /HTTP 404/)
  assert.match(result.error ?? '', /still ECB/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(fake.settings.has('fx_rate_source_since'), false)
  assert.equal(fake.rates.length, before, 'no row written')
  assert.equal(calls.read, 1, 'one read, no retry')
  assert.equal(fake.events.at(-1), 'tx.end', 'the transaction (and the lock) ended')
})

test('an INCOMPLETE read (one active currency missing) is refused, names it, and the rows of the other currencies are rolled back', async () => {
  reset()
  readImpl = async () => ({ ok: true, body: answerWithout('NOK') })
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const result = await setFxRateSource('aelia')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /NOK/)
  assert.match(result.error ?? '', /not_listed_by_aelia/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(aeliaRows().length, 0, 'EUR and USD were ingested inside the transaction and rolled back with it')
  assert.ok(fake.events.includes('fxRate.create(in lock tx)'), 'PRECONDITION: the ingest really wrote EUR/USD before the refusal')
  assert.ok(fake.events.includes('tx.rollback'))
  // a currency whose rate is unusable counts the same way, and names its reason
  reset()
  readImpl = async () => ({ ok: true, body: aeliaAnswer({ rates: [{ currency: 'EUR', rate: '1.19' }, { currency: 'USD', rate: '0' }, { currency: 'NOK', rate: '12.5' }] }) })
  const bad = await setFxRateSource('aelia')
  assert.equal(bad.success, false)
  assert.match(bad.error ?? '', /USD/)
  assert.equal(aeliaRows().length, 0)
  // CONTROL: the complete answer of the first test does switch (the refusals above are not an artefact of the fake)
  reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
})

// ------------------------------------------------------------------ "complete" = resolvable NOW under the real lookup rule

const resolveNow = async (asOf: Date) => {
  const { resolveFxRatesToBase } = await import('@/lib/currencies/fx-lookup')
  return resolveFxRatesToBase(fake.db as never, { currencies: ['EUR', 'USD', 'NOK'], asOf, baseCurrency: 'GBP' })
}

test('STORE CLOCK AHEAD: Aelia last_update 2 minutes in the future is refused and rolled back; the message says by how much', async () => {
  reset()
  const ahead = new Date(Date.now() + 120_000).toISOString()
  readImpl = async () => ({ ok: true, body: aeliaAnswer({ last_update: ahead }) })
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const result = await setFxRateSource('aelia')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /store clock is ahead by (11[89]|12\d) s/)
  assert.match(result.error ?? '', /still ECB/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(fake.settings.has('fx_rate_source_since'), false)
  assert.equal(aeliaRows().length, 0, 'the rows were ingested inside the transaction and rolled back with it')
  assert.ok(fake.events.includes('fxRate.create(in lock tx)'), 'PRECONDITION: the ingest accepted the future time (it tolerates 5 minutes) and wrote before the refusal')
  assert.ok(fake.events.includes('tx.rollback'))
})

test('Aelia last_update EQUAL TO the cutover instant switches, and every lookup at that instant resolves to the Aelia row (the real lookup)', async () => {
  reset()
  const at = new Date('2026-10-29T12:00:00.000Z')
  mock.timers.enable({ apis: ['Date'], now: at })
  try {
    readImpl = async () => ({ ok: true, body: aeliaAnswer({ last_update: at.toISOString() }) })
    const { setFxRateSource } = await import('@/app/actions/currencies')
    assert.deepEqual(await setFxRateSource('aelia'), { success: true })
    assert.equal(fake.settings.get('fx_rate_source_since'), at.toISOString())
    const outcomes = await resolveNow(at)
    for (const code of ['EUR', 'USD', 'NOK']) {
      const o = outcomes.get(code)
      assert.ok(o?.ok && o.source === 'aelia', code)
    }
  } finally {
    mock.timers.reset()
  }
})

test('Aelia last_update BEFORE the cutover instant switches and the lookups resolve now', async () => {
  reset()
  const { setFxRateSource } = await import('@/app/actions/currencies')
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const outcomes = await resolveNow(new Date())
  assert.deepEqual([...outcomes.values()].map((o) => o.ok), [true, true, true])
})

test('THE REAL LOOKUP IS THE AUTHORITY: a pinned currency resolves through its override; a pin the lookup refuses (rate 0) refuses the switch even though the ingest called it covered', async () => {
  const { setFxRateSource } = await import('@/app/actions/currencies')
  reset([...ECB_ROWS(), ecbRow('USD', '1.40', '2026-10-26T00:00:00Z', { manualOverride: true })])
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const ok = (await resolveNow(new Date())).get('USD')
  assert.ok(ok?.ok && ok.manualOverride && ok.rate.toString() === '1.4', 'USD resolves through its pin')

  reset([...ECB_ROWS(), ecbRow('USD', '0', '2026-10-26T00:00:00Z', { manualOverride: true })])
  const refused = await setFxRateSource('aelia')
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /would not resolve/)
  assert.match(refused.error ?? '', /USD/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(aeliaRows().length, 0, 'EUR and NOK were stored inside the transaction and rolled back')
  assert.ok(fake.events.includes('tx.rollback'))
})

test('a wholly refused answer (Aelia base differs from IMS) refuses the switch', async () => {
  reset()
  readImpl = async () => ({ ok: true, body: aeliaAnswer({ base: 'EUR' }) })
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const result = await setFxRateSource('aelia')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /base_mismatch/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(aeliaRows().length, 0)
})

test('a read that TIMES OUT is refused after the bound and the lock transaction ends', { timeout: 60_000 }, async () => {
  reset()
  const { AELIA_CUTOVER_READ_BOUND_MS } = await import('@/lib/currencies/aelia-cutover')
  assert.equal(AELIA_CUTOVER_READ_BOUND_MS, 20_000)
  readImpl = () => new Promise<ReadResult>(() => {}) // never answers
  const { setFxRateSource } = await import('@/app/actions/currencies')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = setFxRateSource('aelia')
    for (const t0 = Date.now(); Date.now() - t0 < 10_000 && calls.read === 0;) await new Promise((r) => setImmediate(r))
    assert.equal(calls.read, 1, 'PRECONDITION: the read is in flight (stalled) while the lock is held')
    assert.equal(fake.events.at(-1) !== 'tx.end', true, 'the lock transaction is still open')
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    mock.timers.tick(AELIA_CUTOVER_READ_BOUND_MS)
    const result = await pending
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /did not answer within 20 seconds/)
    assert.equal(fake.settings.has('fx_rate_source'), false)
    assert.equal(fake.rates.length, 3, 'no row written')
    assert.equal(fake.events.at(-1), 'tx.end', 'the lock transaction ended: the lock is released')
  } finally {
    mock.timers.reset()
  }
  // the lock is free again: a later attempt with a store that answers switches
  readImpl = async () => ({ ok: true, body: aeliaAnswer() })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
})

test('a currency pinned by a manual override counts as covered (its pin is the rate); the read does not overwrite it', async () => {
  reset([...ECB_ROWS(), ecbRow('USD', '1.40', '2026-10-26T00:00:00Z', { source: 'frankfurter', manualOverride: true })])
  const { setFxRateSource } = await import('@/app/actions/currencies')
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  assert.equal(aeliaRows().some((r) => r.toCurrency === 'USD'), false)
  assert.deepEqual(aeliaRows().map((r) => r.toCurrency).sort(), ['EUR', 'NOK'])
})

test('switching back to ECB needs NO read; setting the source it already has needs none either', async () => {
  reset([], { fx_rate_source: 'aelia', fx_rate_source_since: '2026-10-24T00:00:00.000Z' })
  readImpl = async () => { throw new Error('the store must not be asked') }
  const { setFxRateSource } = await import('@/app/actions/currencies')
  assert.deepEqual(await setFxRateSource('ecb'), { success: true })
  assert.equal(fake.settings.get('fx_rate_source'), 'ecb')
  assert.equal(calls.read, 0)
  assert.deepEqual(await setFxRateSource('ecb'), { success: true })
  reset([], { fx_rate_source: 'aelia', fx_rate_source_since: '2026-10-24T00:00:00.000Z' })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  assert.equal(calls.read, 0, 'already Aelia: no read, no new instant')
  assert.equal(fake.settings.get('fx_rate_source_since'), '2026-10-24T00:00:00.000Z')
})

test('wiring: the read sits inside the exclusive lock, is bounded, and the transaction is capped; the card shows the refusal', () => {
  const src = readFileSync('app/actions/currencies.ts', 'utf8')
  const sw = src.slice(src.indexOf('export async function setFxRateSource'), src.indexOf("  if (!changed) return { success: true }"))
  const lock = sw.indexOf('withFxTableWriteLock(async (tx)')
  assert.ok(lock > 0 && lock < sw.indexOf('readAeliaRatesFromWc()') && sw.indexOf('readAeliaRatesFromWc()') < sw.indexOf('ingestAeliaRatesInTx(tx') && sw.indexOf('ingestAeliaRatesInTx(tx') < sw.indexOf('FX_RATE_SOURCE_SETTING }'))
  assert.match(sw, /readWithin\(AELIA_CUTOVER_READ_BOUND_MS/)
  assert.match(sw, /timeout: AELIA_CUTOVER_TX_TIMEOUT_MS/)
  assert.match(sw, /if \(result\.missing\.length\)/)
  assert.ok(sw.indexOf('FX_RATE_SOURCE_SINCE_SETTING }') < sw.indexOf('resolveFxRatesToBase(tx'), 'the lookup runs after the source and instant are written in the transaction')
  assert.ok(sw.indexOf('resolveFxRatesToBase(tx') < sw.indexOf("'fx_aelia_last_update_at'"), 'and before anything is finished')
  assert.match(sw, /result\.updatedAt\.getTime\(\) > switchedAt\.getTime\(\)/)
  assert.match(sw, /resolveFxRatesToBase\(tx, \{ currencies: activeForeign, asOf: switchedAt, baseCurrency: baseCode \}\)/, 'the lookup is asked AT the cutover instant, where the regime starts (an earlier instant would not apply it)')
  assert.equal((sw.match(/\bdb\./g) ?? []).length, 0, 'nothing of the cutover touches the database outside the lock transaction')
  assert.match(readFileSync('lib/currencies/aelia-cutover.ts', 'utf8'), /AELIA_CUTOVER_TX_TIMEOUT_MS = 45_000/)
  const card = readFileSync('components/settings/fx-rates-table.tsx', 'utf8')
  assert.match(card, /setError\(result\.error \?\? 'Could not change the FX source'\)/)
  assert.match(card, /role="alert"/)
})

test('A PINNED currency that Aelia OMITS still counts as covered: the switch commits, nothing is stored for it, and the real lookup resolves through the pin', async () => {
  const { setFxRateSource } = await import('@/app/actions/currencies')
  reset([...ECB_ROWS(), ecbRow('USD', '1.40', '2026-10-26T00:00:00Z', { manualOverride: true })])
  readImpl = async () => ({ ok: true, body: answerWithout('USD') })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  assert.equal(fake.settings.get('fx_rate_source'), 'aelia')
  assert.deepEqual(aeliaRows().map((r) => r.toCurrency).sort(), ['EUR', 'NOK'])
  const usd = (await resolveNow(new Date())).get('USD')
  assert.ok(usd?.ok && usd.manualOverride && usd.rate.toString() === '1.4', 'USD resolves through its pin')

  // Aelia REFUSES the pinned currency (rate 0): the same
  reset([...ECB_ROWS(), ecbRow('USD', '1.40', '2026-10-26T00:00:00Z', { manualOverride: true })])
  readImpl = async () => ({ ok: true, body: aeliaAnswer({ rates: [{ currency: 'EUR', rate: '1.19' }, { currency: 'USD', rate: '0' }, { currency: 'NOK', rate: '12.5' }] }) })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })

  // CONTROL: the same omission WITHOUT a pin is refused (the pin is what covers it)
  reset()
  readImpl = async () => ({ ok: true, body: answerWithout('USD') })
  const bad = await setFxRateSource('aelia')
  assert.equal(bad.success, false)
  assert.match(bad.error ?? '', /USD/)
})

test('a REGRESSED Aelia update time (older than a stored Aelia row) refuses the cutover: that currency counts as missing, nothing is stored', async () => {
  const { setFxRateSource } = await import('@/app/actions/currencies')
  // a stored Aelia row for EUR NEWER than the answer's update time (2026-10-23T23:36:05Z)
  reset([...ECB_ROWS(), ecbRow('EUR', '1.2', '2026-10-24T10:00:00Z', { source: 'aelia' })])
  const result = await setFxRateSource('aelia')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /EUR \(aelia_update_regressed\)/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.deepEqual(aeliaRows().map((r) => r.toCurrency), ['EUR'], 'only the stored row remains: the rows of this read were rolled back')
  assert.ok(fake.events.includes('tx.rollback'))
  // CONTROL: the same stored row at an OLDER time is no regression: the cutover commits
  reset([...ECB_ROWS(), ecbRow('EUR', '1.2', '2026-10-22T10:00:00Z', { source: 'aelia' })])
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  // and a stored Aelia row identical to this read (same rate, same time) is the idempotent case: the cutover commits and the lookup agrees with the read
  reset([...ECB_ROWS(), ecbRow('EUR', '1.194344', '2026-10-23T23:36:05Z', { source: 'aelia' })])
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
})

test('A manual row DATED IN THE FUTURE is no pin: with an older Aelia row and USD omitted the switch is refused (the lookup would resolve the old Aelia row); once the row is in force it pins', async () => {
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const future = new Date(Date.now() + 86_400_000).toISOString()
  reset([...ECB_ROWS(), ecbRow('USD', '1.2', '2026-10-01T00:00:00Z', { source: 'aelia' }), ecbRow('USD', '1.40', future, { manualOverride: true })])
  readImpl = async () => ({ ok: true, body: answerWithout('USD') })
  const refused = await setFxRateSource('aelia')
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /USD/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.ok(fake.events.includes('tx.rollback'))
  // the same row IN FORCE (dated before the cutover instant) is a valid pin: the switch commits and USD resolves through it
  reset([...ECB_ROWS(), ecbRow('USD', '1.2', '2026-10-01T00:00:00Z', { source: 'aelia' }), ecbRow('USD', '1.40', '2026-10-26T00:00:00Z', { manualOverride: true })])
  readImpl = async () => ({ ok: true, body: answerWithout('USD') })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const usd = (await resolveNow(new Date())).get('USD')
  assert.ok(usd?.ok && usd.manualOverride && usd.rate.toString() === '1.4')
})
