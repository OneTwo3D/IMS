import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * AN AELIA WRITE TAKES THE FX TABLE LOCK (lib/currencies/aelia-ingest.ts, lib/currencies/fx-table-lock.ts).
 *
 * A running CSV import holds the exchange-rate table still (the shared side of the lock). The ingest of Aelia's rates is a writer of fx_rates, so it takes the EXCLUSIVE side and must WAIT for the
 * import to finish: it may not write mid-import.
 *   arm 1  with the table held still, the ingest is blocked on the advisory lock and has written nothing
 *   arm 2  when the hold is released the ingest completes: rows are source aelia, rate before markup, dated by Aelia, and a repeat of the same read adds no row
 * Real Postgres, the real lock. Mutation: take the ingest's writes out of withFxTableWriteLock -> arm 1 sees the rows written while the table is held.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

const AELIA_TIME = '2026-01-05T10:00:00Z'
const answer = {
  ok: true,
  base: 'GBP',
  last_update: AELIA_TIME,
  rates: [{ currency: 'EUR', rate: '1.194344', markup: '0.02', set_manually: false }],
}

test('the Aelia ingest waits for a running import (shared lock) and then writes the pre-markup rate at Aelia\'s time', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { getBaseCurrencyCode } = await import('@/lib/base-currency')
  const { withFxTableHeldStill } = await import('@/lib/currencies/fx-table-lock')
  const { ingestAeliaRates } = await import('@/lib/currencies/aelia-ingest')

  const base = await getBaseCurrencyCode()
  assert.equal(base, 'GBP', 'PRECONDITION: the scratch database base currency is GBP')
  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: { active: true }, create: { code: 'EUR', name: 'EUR', symbol: 'EUR', active: true } })
  // any other active currency of the scratch database would be reported as "not listed by Aelia"; that does not matter here, only EUR is asserted
  // the regular ingest writes only while the source is Aelia (it re-checks inside the lock)
  const sourceBefore = await db.setting.findUnique({ where: { key: 'fx_rate_source' } })
  await db.setting.upsert({ where: { key: 'fx_rate_source' }, create: { key: 'fx_rate_source', value: 'aelia' }, update: { value: 'aelia' } })
  t.after(async () => {
    if (sourceBefore) await db.setting.update({ where: { key: 'fx_rate_source' }, data: { value: sourceBefore.value } })
    else await db.setting.deleteMany({ where: { key: 'fx_rate_source' } })
    await db.fxRate.deleteMany({ where: { toCurrency: 'EUR', source: 'aelia' } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
  })
  await db.fxRate.deleteMany({ where: { toCurrency: 'EUR', source: 'aelia' } })

  let ingest: Promise<Awaited<ReturnType<typeof ingestAeliaRates>>> | null = null
  await withFxTableHeldStill(async () => {
    ingest = ingestAeliaRates(answer, { now: new Date('2026-01-05T12:00:00Z') })
    // the writer must be WAITING on the advisory lock
    let waiting = 0
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
      waiting = Number(rows[0]?.n ?? 0)
      if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(waiting >= 1, 'PRECONDITION: the Aelia ingest is blocked on the advisory lock while the table is held still')
    assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', source: 'aelia' } }), 0, 'arm 1: nothing was written while the table was held')
  })
  assert.ok(ingest)
  const result = await (ingest as Promise<Awaited<ReturnType<typeof ingestAeliaRates>>>)
  assert.deepEqual(result.written, ['EUR'])
  assert.deepEqual(result.markups, { EUR: '0.02' })

  const rows = await db.fxRate.findMany({ where: { toCurrency: 'EUR', source: 'aelia' } })
  assert.equal(rows.length, 1, 'arm 2: one row')
  assert.equal(rows[0].rate.toString(), '1.194344', 'the rate before markup (not 1.214344)')
  assert.equal(rows[0].fetchedAt.toISOString(), '2026-01-05T10:00:00.000Z', 'dated by Aelia, not by the read')
  assert.equal(rows[0].manualOverride, false)

  const again = await ingestAeliaRates(answer, { now: new Date('2026-01-05T13:00:00Z') })
  assert.deepEqual(again.written, [])
  assert.deepEqual(again.unchanged, ['EUR'])
  assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', source: 'aelia' } }), 1, 'a repeated read adds no row')
})
