import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { endOfBusinessDateUtc, getFxRateToBase, getFxRatesToBase, MissingFxRateError, resolveFxRatesToBase } from '../../lib/currencies/fx-lookup'

/**
 * The central FX lookup's SQL against a real database: the `groupBy` for the latest fetchedAt per currency, then the
 * rows AT that instant. fx_rates has no unique key on (from, to, fetchedAt), so a tie is a real thing the database
 * permits, and the helper must see it. ROLLED BACK, ALWAYS (fx_rates is replaced inside the transaction only). It never writes `organisations`: the
 * reconciliation-pack basis test counts tuple writes on that table across the whole run, so the base currency is
 * passed explicitly here and the organisation read is covered by tests/currencies/fx-lookup.test.ts.
 *
 * FILE NAME: `zz-` keeps it LAST in the runner's start order. tests/db/reconciliation-pack-basis.test.ts asserts that no
 * tuple is written to settings/organisations/etc. during a 3 s window on a shared database, so any file that shifts which
 * files run beside it can fail it (reproduced three times in a row by adding this file under an alphabetically earlier name).
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/zz-fx-lookup.test.ts would be skipped in an environment that promised a migrated database. Fix the invocation (npm run test:db).')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db')
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const D = (s: string) => new Date(s)

async function seed(tx: Tx, base: string, rates: Array<{ from?: string; to: string; rate: string; at: string; source?: string; manual?: boolean }>) {
  for (const code of ['GBP', 'EUR', 'USD', 'JPY', 'CHF']) {
    await tx.currency.upsert({ where: { code }, update: {}, create: { code, name: code, symbol: code } })
  }
  await tx.fxRate.deleteMany({})
  for (const r of rates) {
    await tx.fxRate.create({ data: { fromCurrency: r.from ?? base, toCurrency: r.to, rate: r.rate, fetchedAt: D(r.at), source: r.source ?? 'frankfurter', manualOverride: r.manual ?? false } })
  }
}

test('db: latest on or before asOf; exactly-at counts; just-after does not', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'GBP', [{ to: 'EUR', rate: '1.10', at: '2026-01-01T00:00:00Z' }, { to: 'EUR', rate: '1.20', at: '2026-01-02T00:00:00Z' }, { to: 'EUR', rate: '1.30', at: '2026-01-03T00:00:00Z' }])
    const at = (s: string) => getFxRateToBase(tx, { currency: 'EUR', asOf: D(s), baseCurrency: 'GBP' })
    assert.equal((await at('2026-01-02T00:00:00Z')).rate.toString(), '1.2')
    assert.equal((await at('2026-01-01T23:59:59.999Z')).rate.toString(), '1.1')
    assert.equal((await at('2026-01-02T00:00:00.001Z')).rate.toString(), '1.2')
    await assert.rejects(at('2025-12-31T00:00:00Z'), (e: unknown) => e instanceof MissingFxRateError && e.reason === 'no_rate')
    assert.equal((await getFxRateToBase(tx, { currency: 'GBP', asOf: D('2026-01-02T00:00:00Z'), baseCurrency: 'GBP' })).isBase, true)
  })
})

test('db: a tie with different rates at the latest instant refuses; equal rates are accepted; an older tie is irrelevant', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'GBP', [
      { to: 'EUR', rate: '1.10', at: '2026-01-02T00:00:00Z' }, { to: 'EUR', rate: '1.11', at: '2026-01-02T00:00:00Z' },
      { to: 'USD', rate: '1.30', at: '2026-01-02T00:00:00Z', source: 'frankfurter' }, { to: 'USD', rate: '1.3000', at: '2026-01-02T00:00:00Z', source: 'manual', manual: true },
      { to: 'JPY', rate: '150', at: '2026-01-01T00:00:00Z' }, { to: 'JPY', rate: '151', at: '2026-01-01T00:00:00Z' }, { to: 'JPY', rate: '152', at: '2026-01-02T00:00:00Z' },
    ])
    const asOf = D('2026-02-01T00:00:00Z')
    await assert.rejects(getFxRateToBase(tx, { currency: 'EUR', asOf, baseCurrency: 'GBP' }), (e: unknown) => e instanceof MissingFxRateError && e.reason === 'ambiguous_rate')
    const usd = await getFxRateToBase(tx, { currency: 'USD', asOf, baseCurrency: 'GBP' })
    assert.equal(usd.rate.toString(), '1.3'); assert.equal(usd.manualOverride, true); assert.equal(usd.source, 'frankfurter,manual')
    assert.equal((await getFxRateToBase(tx, { currency: 'JPY', asOf, baseCurrency: 'GBP' })).rate.toString(), '152')
  })
})

test('db: zero and negative stored rates refuse, and an older good rate does not stand in for a bad latest one', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'GBP', [{ to: 'EUR', rate: '1.2', at: '2026-01-01T00:00:00Z' }, { to: 'EUR', rate: '0', at: '2026-01-02T00:00:00Z' }, { to: 'USD', rate: '-1.3', at: '2026-01-01T00:00:00Z' }])
    for (const currency of ['EUR', 'USD']) {
      await assert.rejects(getFxRateToBase(tx, { currency, asOf: D('2026-02-01T00:00:00Z'), baseCurrency: 'GBP' }), (e: unknown) => e instanceof MissingFxRateError && e.reason === 'non_positive_rate')
    }
  })
})

test('db: a non-GBP base reads that base\'s rows only; GBP is then foreign and refuses without a row', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'EUR', [{ to: 'USD', rate: '1.08', at: '2026-01-01T00:00:00Z' }, { from: 'GBP', to: 'USD', rate: '1.25', at: '2026-01-01T00:00:00Z' }, { from: 'EUR', to: 'GBP', rate: '0.85', at: '2026-01-01T00:00:00Z' }])
    const asOf = D('2026-02-01T00:00:00Z')
    assert.equal((await getFxRateToBase(tx, { currency: 'USD', asOf, baseCurrency: 'EUR' })).rate.toString(), '1.08')
    assert.equal((await getFxRateToBase(tx, { currency: 'GBP', asOf, baseCurrency: 'EUR' })).rate.toString(), '0.85')
    assert.equal((await getFxRateToBase(tx, { currency: 'EUR', asOf, baseCurrency: 'EUR' })).isBase, true)
    await tx.fxRate.deleteMany({ where: { fromCurrency: 'EUR', toCurrency: 'GBP' } })
    await assert.rejects(getFxRateToBase(tx, { currency: 'GBP', asOf, baseCurrency: 'EUR' }), (e: unknown) => e instanceof MissingFxRateError && e.reason === 'no_rate')
  })
})

test('db: the batch agrees with the single lookup and the date rule picks up a same-day rate', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'GBP', [
      { to: 'EUR', rate: '1.10', at: '2026-03-03T09:00:00Z' }, { to: 'EUR', rate: '1.20', at: '2026-03-04T09:00:00Z' },
      { to: 'USD', rate: '1.30', at: '2026-03-04T23:59:59.999Z' },
      { to: 'JPY', rate: '150', at: '2026-03-05T00:00:00Z' },
    ])
    const asOf = endOfBusinessDateUtc('2026-03-04')
    const batch = await getFxRatesToBase(tx, { currencies: ['EUR', 'USD', 'GBP'], asOf, baseCurrency: 'GBP' })
    assert.equal(batch.get('EUR')!.rate.toString(), '1.2')
    assert.equal(batch.get('USD')!.rate.toString(), '1.3') // fetched in the last millisecond of the day: still that day's
    assert.equal(batch.get('GBP')!.isBase, true)
    for (const c of ['EUR', 'USD']) assert.equal((await getFxRateToBase(tx, { currency: c, asOf, baseCurrency: 'GBP' })).rate.toString(), batch.get(c)!.rate.toString())
    const out = await resolveFxRatesToBase(tx, { currencies: ['JPY', 'CHF'], asOf, baseCurrency: 'GBP' })
    assert.equal(out.get('JPY')!.ok, false) // fetched at 00:00:00 the NEXT day: not that day's rate
    assert.equal(out.get('CHF')!.ok, false)
  })
})

test('db: the Aelia source regime filters in SQL: a newer ECB row is ignored after the cutover, a missing Aelia currency refuses, a pre-cutover lookup is unchanged, a pin wins', { skip }, async () => {
  await withRollback(async (tx) => {
    await seed(tx, 'GBP', [
      { to: 'EUR', rate: '1.10', at: '2026-10-19T06:00:00Z' },
      { to: 'EUR', rate: '1.19', at: '2026-10-23T23:36:05Z', source: 'aelia' },
      { to: 'EUR', rate: '1.25', at: '2026-10-25T06:00:00Z' },
      { to: 'USD', rate: '1.30', at: '2026-10-25T06:00:00Z' },
      { to: 'JPY', rate: '150', at: '2026-10-25T06:00:00Z' },
      { to: 'JPY', rate: '160', at: '2026-10-25T12:00:00Z', source: 'manual', manual: true },
    ])
    // the settings are stubbed (writing `settings` here would show up in the basis test's tuple counts); the fx_rates SQL is the real one
    const client = { fxRate: tx.fxRate, setting: { findMany: async () => [{ key: 'fx_rate_source', value: 'aelia' }, { key: 'fx_rate_source_since', value: '2026-10-24T00:00:00Z' }] } } as never
    const after = D('2026-10-26T12:00:00Z')
    assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: after, baseCurrency: 'GBP' })).rate.toString(), '1.19')
    await assert.rejects(getFxRateToBase(client, { currency: 'USD', asOf: after, baseCurrency: 'GBP' }), (e: unknown) => e instanceof MissingFxRateError && e.reason === 'no_rate_from_selected_source')
    assert.equal((await getFxRateToBase(client, { currency: 'EUR', asOf: D('2026-10-20T12:00:00Z'), baseCurrency: 'GBP' })).rate.toString(), '1.1')
    assert.equal((await getFxRateToBase(client, { currency: 'JPY', asOf: after, baseCurrency: 'GBP' })).rate.toString(), '160')
    const ecb = { fxRate: tx.fxRate, setting: { findMany: async () => [] } } as never
    assert.equal((await getFxRateToBase(ecb, { currency: 'EUR', asOf: after, baseCurrency: 'GBP' })).rate.toString(), '1.25')
  })
})
