import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'
import pg from 'pg'

import { ECB_BACKFILL_STATEMENTS, parseEcbCsv, runBackfill, type BackfillPort } from '../../lib/first-load/backfill-ecb-rates'
import { selectFxRateFromRows } from '../../lib/currencies/fx-select'

/**
 * o3d-q0x56.33: the ECB history backfill against a real, migrated database (the SQL of the existing-day read, the first-live-row read, the settings read, the insert and the lock).
 * ROLLED BACK, ALWAYS: everything runs inside one outer transaction; the command's own BEGIN / COMMIT / ROLLBACK become savepoints, and the outer transaction is rolled back at the end, so no row of
 * the shared tier database is changed. GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so tests/db/fx-backfill-ecb.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'ecb-hist-small.csv'), 'utf8')

test('ecb backfill on a real database: write, idempotent re-run, first-live-row refusal, Aelia refusal, pin not un-pinned', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const parsed = parseEcbCsv(FIXTURE); assert.ok(parsed.ok)
  const file = parsed.file
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    const q = (sql: string, params?: unknown[]) => client.query(sql, params)
    // savepoints stand in for the command's own transaction
    const port: BackfillPort = {
      query: async (sql, params) => {
        const verb = /^(BEGIN|COMMIT|ROLLBACK)\b/.exec(sql)?.[1]
        if (verb === 'BEGIN') { await client.query('SAVEPOINT backfill'); return { rows: [] } }
        if (verb === 'COMMIT') { await client.query('RELEASE SAVEPOINT backfill'); return { rows: [] } }
        if (verb === 'ROLLBACK') { await client.query('ROLLBACK TO SAVEPOINT backfill'); return { rows: [] } }
        return { rows: (await client.query(sql, params ? [...params] : undefined)).rows as never[] }
      },
    }
    const ident = (await q(`select current_database() as db, (select system_identifier::text from pg_control_system()) as sid`)).rows[0]
    const args = { from: '2026-03-26', to: '2026-03-31', currencies: null as string[] | null, expectDb: ident.db as string, expectSystemId: ident.sid as string, dryRun: false }
    const count = async (where = 'true') => (await q(`select count(*)::int n from "fx_rates" where ${where}`)).rows[0].n as number

    await q('delete from "fx_rates"'); await q('delete from "settings" where "key" like \'fx_rate_source%\''); await q('delete from "currencies"'); await q('delete from "organisations"')
    for (const c of ['GBP', 'EUR', 'USD', 'CNY']) await q(`insert into "currencies" ("code","name","symbol","active") values ($1,$1,$1,$2)`, [c, c !== 'CNY'])
    await q(`insert into "organisations" ("id","name","baseCurrency","updatedAt") values ('o','o','GBP',now())`)

    // dry run writes nothing
    assert.equal((await runBackfill(port, file, { ...args, dryRun: true })).kind, 'done')
    assert.equal(await count(), 0)

    // a real write: EUR and USD, 4 business days each, source ecb-history, 16:00 Berlin in UTC, 8 dp
    const first = await runBackfill(port, file, args)
    assert.equal(first.kind, 'done')
    if (first.kind === 'done') { assert.equal(first.written, 8); assert.equal(first.skippedExisting, 0) }
    const usd = (await q(`select rate::text r, to_char("fetchedAt",'YYYY-MM-DD"T"HH24:MI') f, source, "manualOverride" m from "fx_rates" where "toCurrency"='USD' order by "fetchedAt"`)).rows
    assert.deepEqual(usd.map((r) => [r.f, r.r, r.source, r.m]), [
      ['2026-03-26T15:00', '1.32500000', 'ecb-history', false], ['2026-03-27T15:00', '1.33750000', 'ecb-history', false],
      ['2026-03-30T14:00', '1.27058824', 'ecb-history', false], ['2026-03-31T14:00', '1.27906977', 'ecb-history', false],
    ])
    assert.equal(await count(`"toCurrency" in ('CNY','GBP')`), 0) // disabled currency and the base are never written

    // an idempotent re-run: its own rows are not "live", so the same window is a no-op
    const again = await runBackfill(port, file, args)
    assert.equal(again.kind, 'done')
    if (again.kind === 'done') { assert.equal(again.written, 0); assert.equal(again.skippedExisting, 8) }
    assert.equal(await count(), 8)

    // a first LIVE row on 03-30 for USD: a window reaching it is refused (nothing written), a window before it is a no-op
    await q(`delete from "fx_rates"`)
    await q(`insert into "fx_rates" ("id","fromCurrency","toCurrency","rate","fetchedAt","source") values ('live','GBP','USD',1.5,'2026-03-30 06:00:00','frankfurter')`)
    const reach = await runBackfill(port, file, { ...args, currencies: ['USD'] })
    assert.equal(reach.kind, 'refused')
    if (reach.kind === 'refused') assert.match(reach.refusals.join(), /on or after the first live row of USD \(2026-03-30\)/)
    assert.equal(await count(), 1)
    const before = await runBackfill(port, file, { ...args, currencies: ['USD'], to: '2026-03-27' })
    assert.equal(before.kind, 'done')
    assert.equal(await count(), 3)
    const rows = (await q(`select "fromCurrency","toCurrency",rate::text rate,to_char("fetchedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fa,source,seq from "fx_rates" where "toCurrency"='USD'`)).rows.map((r) => ({ ...r, fetchedAt: new Date(r.fa) }))
    const sel = (d: string) => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'USD', asOf: new Date(`${d}T23:59:59.999Z`) })
    assert.equal(sel('2026-03-30').source, 'frankfurter'); assert.equal(sel('2026-03-27').source, 'ecb-history'); assert.equal(sel('2026-03-31').source, 'frankfurter')

    // a manual PIN on 03-26: the backfill must not write after it (it would silently un-pin)
    await q(`delete from "fx_rates"`)
    await q(`insert into "fx_rates" ("id","fromCurrency","toCurrency","rate","fetchedAt","source","manualOverride") values ('pin','GBP','USD',1.4,'2026-03-26 09:00:00','manual',true)`)
    const pin = await runBackfill(port, file, { ...args, currencies: ['USD'] })
    assert.equal(pin.kind, 'refused')
    assert.equal(await count(), 1)

    // an Aelia interval starting 03-29: a window reaching it is refused for every currency, one before it is fine
    await q(`delete from "fx_rates"`)
    await q(`insert into "settings" ("key","value","updatedAt") values ('fx_rate_source','aelia',now()),('fx_rate_source_since','2026-03-29T10:00:00.000Z',now())`)
    const aelia = await runBackfill(port, file, args)
    assert.equal(aelia.kind, 'refused')
    if (aelia.kind === 'refused') assert.match(aelia.refusals.join(), /Aelia period \(2026-03-29\)/)
    assert.equal(await count(), 0)
    assert.equal((await runBackfill(port, file, { ...args, to: '2026-03-27' })).kind, 'done')
    assert.equal(await count(), 4)

    // a wrong target never reaches the lock or the data
    assert.equal((await runBackfill(port, file, { ...args, expectDb: 'nope' })).kind, 'target-refused')
    assert.ok(ECB_BACKFILL_STATEMENTS.firstLive.includes('<> \'ecb-history\''))
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
})
