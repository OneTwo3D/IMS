/**
 * Bead o3d-q0x56.33: the one-off ECB history backfill. Fixture CSV only, never the network. Every arm names the mutation that turns it red.
 * The database arms need a scratch Postgres migrated with the real schema: set FX_BACKFILL_TEST_DATABASE_URL to a database whose name starts with "fxbf_scratch" (skipped otherwise).
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { FX_TABLE_LOCK_KEY } from '../../lib/db/advisory-locks.ts'
import { selectFxRateFromRows } from '../../lib/currencies/fx-select.ts'
import {
  ECB_BACKFILL_FX_TABLE_LOCK_KEY, ECB_BACKFILL_STATEMENTS, divideRounded, ecbPublicationInstant, parseBackfillArgs, parseEcbCsv, planBackfill, runBackfill, insertStatement, type BackfillPort, type EcbFile,
} from '../../lib/first-load/backfill-ecb-rates.ts'
import { runCli } from '../../scripts/fx-backfill-ecb.ts'
import { scratchRoot } from '../helpers/scratch-root'

const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'ecb-hist-small.csv'), 'utf8')
const file = (): EcbFile => { const p = parseEcbCsv(FIXTURE); assert.ok(p.ok); return p.file }
const none: ReadonlySet<string> = new Set()
const base = { file: undefined as unknown as EcbFile, baseCurrency: 'GBP', enabledCurrencies: ['GBP', 'EUR', 'USD', 'JPY'], requested: null, from: '2026-03-26', to: '2026-03-31', existing: none }
const plan = (over: Partial<Parameters<typeof planBackfill>[0]> = {}) => planBackfill({ ...base, file: file(), ...over })

test('the lock key is the one every fx_rates writer takes', () => {
  assert.equal(ECB_BACKFILL_FX_TABLE_LOCK_KEY, FX_TABLE_LOCK_KEY) // [mutation: change either constant]
})

test('parse: trailing comma, N/A, range; refuses malformed', () => {
  const f = file()
  assert.deepEqual(f.currencies, ['USD', 'JPY', 'GBP', 'CNY'])
  assert.equal(f.firstDay, '2026-03-26'); assert.equal(f.lastDay, '2026-03-31')
  assert.equal(f.days.get('2026-03-26')!.get('CNY'), null)
  assert.equal(parseEcbCsv('Date,USD,\n2026-01-01,abc,\n').ok, false)
  assert.equal(parseEcbCsv('Date,USD,\n2026-01-01,1.1,\n2026-01-01,1.2,\n').ok, false)
  assert.equal(parseEcbCsv('Day,USD,\n2026-01-01,1.1,\n').ok, false)
})

// [mutation: use a fixed +1h / +2h offset, or UTC 16:00]
test('publication time is 16:00 Berlin across DST: 15:00Z in winter, 14:00Z in summer, correct on the change days', () => {
  assert.equal(ecbPublicationInstant('2026-03-27').toISOString(), '2026-03-27T15:00:00.000Z')
  assert.equal(ecbPublicationInstant('2026-03-28').toISOString(), '2026-03-28T15:00:00.000Z')
  assert.equal(ecbPublicationInstant('2026-03-29').toISOString(), '2026-03-29T14:00:00.000Z') // clocks went forward at 01:00Z that day
  assert.equal(ecbPublicationInstant('2026-03-30').toISOString(), '2026-03-30T14:00:00.000Z')
  assert.equal(ecbPublicationInstant('2026-10-24').toISOString(), '2026-10-24T14:00:00.000Z')
  assert.equal(ecbPublicationInstant('2026-10-25').toISOString(), '2026-10-25T15:00:00.000Z') // clocks went back
  assert.equal(ecbPublicationInstant('2026-12-01').toISOString(), '2026-12-01T15:00:00.000Z')
})

// [mutation: invert the division, drop the EUR special case, round half up]
test('conversion: rate = X_per_EUR / BASE_per_EUR, EUR = 1 / BASE_per_EUR, 8 dp half-even, base excluded', () => {
  const p = plan()
  assert.ok(p.ok)
  const get = (c: string, d: string) => p.rows.find((r) => r.currency === c && r.day === d)?.rate
  assert.equal(get('USD', '2026-03-27'), '1.33750000') // 1.07 / 0.80
  assert.equal(get('EUR', '2026-03-27'), '1.25000000') // 1 / 0.80
  assert.equal(get('EUR', '2026-03-30'), '1.17647059') // 1 / 0.85
  assert.equal(get('JPY', '2026-03-30'), '194.11764706') // 165 / 0.85
  assert.ok(!p.rows.some((r) => r.currency === 'GBP'))
  assert.equal(p.rows.length, 3 * 4) // EUR, USD, JPY x 4 business days (no weekend rows)
  assert.equal(p.rows.find((r) => r.day === '2026-03-30')!.fetchedAt.toISOString(), '2026-03-30T14:00:00.000Z')
  // exact half-even
  assert.equal(divideRounded({ n: BigInt(5), s: 0 }, { n: BigInt(2), s: 0 }, 0), '2.')
  assert.equal(divideRounded({ n: BigInt(1), s: 0 }, { n: BigInt(16), s: 0 }, 3), '0.062') // 0.0625 -> even
  assert.equal(divideRounded({ n: BigInt(3), s: 0 }, { n: BigInt(16), s: 0 }, 3), '0.188') // 0.1875 -> even
  // EUR base: base per EUR is 1
  const eur = plan({ baseCurrency: 'EUR', enabledCurrencies: ['EUR', 'USD'] })
  assert.ok(eur.ok)
  assert.equal(eur.rows.find((r) => r.currency === 'USD' && r.day === '2026-03-27')!.rate, '1.07000000')
  assert.ok(!eur.rows.some((r) => r.currency === 'EUR'))
})

// [mutation: drop a refusal]
test('refusals: N/A cell, window outside the file, base missing, unknown / disabled / base currency, empty set', () => {
  const na = plan({ enabledCurrencies: ['GBP', 'CNY'] })
  assert.ok(!na.ok); assert.match(na.refusals.join('\n'), /2026-03-26: CNY has a blank/)
  const out = plan({ from: '2026-03-01' }); assert.ok(!out.ok); assert.match(out.refusals[0]!, /outside the ECB file's range/)
  const out2 = plan({ to: '2026-04-01' }); assert.ok(!out2.ok)
  const nobase = plan({ baseCurrency: 'SEK' }); assert.ok(!nobase.ok); assert.match(nobase.refusals.join(), /base currency SEK is not a column/)
  const dis = plan({ requested: ['CNY'] }); assert.ok(!dis.ok); assert.match(dis.refusals.join(), /CNY is not an enabled currency/)
  const self = plan({ requested: ['GBP'] }); assert.ok(!self.ok)
  const cols = plan({ enabledCurrencies: ['GBP', 'CHF'] }); assert.ok(!cols.ok); assert.match(cols.refusals.join(), /CHF is not a column/)
  const empty = plan({ enabledCurrencies: ['GBP'] }); assert.ok(!empty.ok)
  const gap = plan({ file: (() => { const f = file(); f.days.get('2026-03-30')!.set('GBP', null); return f })() }); assert.ok(!gap.ok); assert.match(gap.refusals.join(), /base currency GBP has a blank/)
  const ok = plan({ requested: ['USD'] }); assert.ok(ok.ok); assert.equal(ok.rows.length, 4)
})

// [mutation: ignore `existing`, or only skip an exact-instant match]
test('existing days are skipped and counted per currency', () => {
  const p = plan({ requested: ['USD', 'EUR'], existing: new Set(['USD|2026-03-30', 'USD|2026-03-31', 'EUR|2026-03-27']) })
  assert.ok(p.ok)
  assert.equal(p.rows.length, 8 - 3)
  assert.deepEqual(p.counts.map((c) => [c.currency, c.toWrite, c.skippedExisting]), [['EUR', 3, 1], ['USD', 2, 2]])
})

// A live row on a day wins over the backfill because that day is skipped, so no tie of different rates can exist; later days are later rows.
test('fx-select: a day holding a live row is never backfilled, so the live row wins and no tie arises', () => {
  const live = { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.50000000', fetchedAt: new Date('2026-03-30T06:00:00.000Z'), source: 'frankfurter', seq: 2 }
  const p2 = plan({ requested: ['USD'], existing: new Set(['USD|2026-03-30']) }); assert.ok(p2.ok)
  assert.ok(!p2.rows.some((r) => r.day === '2026-03-30'))
  const rows = [...p2.rows.map((r) => ({ fromCurrency: 'GBP', toCurrency: 'USD', rate: r.rate, fetchedAt: r.fetchedAt, source: 'ecb-history', seq: 1 })), live]
  const at = (d: string) => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'USD', asOf: new Date(`${d}T23:59:59.999Z`) })
  assert.equal(at('2026-03-30').source, 'frankfurter')
  assert.equal(at('2026-03-30').rate.toString(), '1.5')
  assert.equal(at('2026-03-27').source, 'ecb-history')
  assert.equal(at('2026-03-27').rate.toString(), '1.3375')
  // a planned row never shares an instant with a live row of its day, so the tie refusal cannot fire
  const tie = rows.filter((r) => r.fetchedAt.getTime() === live.fetchedAt.getTime())
  assert.equal(tie.length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the transaction, against a recording fake port

function fakePort(opts: { db?: string; sid?: string; base?: string; existing?: Array<{ cur: string; day: string }> } = {}): { port: BackfillPort; sent: Array<{ sql: string; params?: readonly unknown[] }> } {
  const sent: Array<{ sql: string; params?: readonly unknown[] }> = []
  return {
    sent,
    port: {
      async query<T>(sql: string, params?: readonly unknown[]) {
        sent.push({ sql, params })
        if (sql === ECB_BACKFILL_STATEMENTS.identity) return { rows: [{ db: opts.db ?? 'ims', sid: opts.sid ?? '7001' }] as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.base) return { rows: [{ base: opts.base ?? 'GBP' }] as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.enabled) return { rows: [{ code: 'EUR' }, { code: 'GBP' }, { code: 'USD' }] as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.existing) return { rows: (opts.existing ?? []) as T[] }
        return { rows: [] as T[] }
      },
    },
  }
}
const args = { from: '2026-03-26', to: '2026-03-31', currencies: null, expectDb: 'ims', expectSystemId: '7001', dryRun: false }

// [mutation: skip the identity check, check after the insert, drop the lock, drop the rollback]
test('a real run: lock first, target confirmed before any read of the plan inputs, one insert, COMMIT; a wrong target writes nothing', async () => {
  const ok = fakePort()
  const out = await runBackfill(ok.port, file(), args)
  assert.equal(out.kind, 'done')
  const sqls = ok.sent.map((s) => s.sql)
  assert.equal(sqls[0], ECB_BACKFILL_STATEMENTS.beginWrite)
  assert.equal(sqls[1], ECB_BACKFILL_STATEMENTS.lock)
  assert.deepEqual(ok.sent[1]!.params, [FX_TABLE_LOCK_KEY])
  assert.equal(sqls[2], ECB_BACKFILL_STATEMENTS.identity)
  assert.equal(sqls.at(-1), ECB_BACKFILL_STATEMENTS.commit)
  assert.equal(sqls.filter((s) => s.startsWith('insert')).length, 1)
  for (const bad of [{ db: 'other' }, { sid: '9' }]) {
    const f = fakePort(bad)
    const r = await runBackfill(f.port, file(), args)
    assert.equal(r.kind, 'target-refused')
    assert.ok(!f.sent.some((s) => s.sql.startsWith('insert')))
    assert.equal(f.sent.at(-1)!.sql, ECB_BACKFILL_STATEMENTS.rollback)
  }
})

test('a dry run is READ ONLY, takes no lock, inserts nothing, reports the counts', async () => {
  const f = fakePort({ existing: [{ cur: 'USD', day: '2026-03-27' }] })
  const out = await runBackfill(f.port, file(), { ...args, dryRun: true })
  assert.equal(out.kind, 'done')
  assert.equal(f.sent[0]!.sql, ECB_BACKFILL_STATEMENTS.beginDryRun)
  assert.ok(!f.sent.some((s) => s.sql === ECB_BACKFILL_STATEMENTS.lock || s.sql.startsWith('insert') || s.sql === ECB_BACKFILL_STATEMENTS.commit))
  assert.equal(f.sent.at(-1)!.sql, ECB_BACKFILL_STATEMENTS.rollback)
  if (out.kind === 'done') { assert.equal(out.written, 0); assert.equal(out.skippedExisting, 1); assert.equal(out.counts.find((c) => c.currency === 'USD')!.toWrite, 3) }
})

test('a refusal rolls back and writes nothing; the statement list has only the known verbs; no secret in any statement', async () => {
  const f = fakePort()
  const out = await runBackfill(f.port, file(), { ...args, from: '2026-01-01' })
  assert.equal(out.kind, 'refused')
  assert.ok(!f.sent.some((s) => s.sql.startsWith('insert') || s.sql === ECB_BACKFILL_STATEMENTS.commit))
  for (const sql of [...Object.values(ECB_BACKFILL_STATEMENTS), insertStatement(2)]) assert.ok(!/\b(update|delete|truncate|alter|drop|create|grant)\b/i.test(sql))
  assert.ok(insertStatement(1).includes("'ecb-history'") && insertStatement(1).includes('false'))
})

test('arguments: required, dates, credentials refused, --dry-run and --currencies parsed', () => {
  const ok = ['--env-file', '/e', '--expect-db', 'd', '--expect-system-id', '1', '--ecb-csv', 'x.csv', '--from', '2026-01-01', '--to', '2026-02-01']
  assert.equal(parseBackfillArgs(ok).kind, 'run')
  const r = parseBackfillArgs([...ok, '--dry-run', '--currencies', 'usd,eur'])
  assert.ok(r.kind === 'run' && r.args.dryRun && r.args.currencies!.join() === 'USD,EUR')
  assert.equal(parseBackfillArgs(ok.slice(2)).kind, 'usage')
  assert.equal(parseBackfillArgs([...ok.slice(0, -1), '2025-01-01']).kind, 'usage')
  assert.equal(parseBackfillArgs([...ok, '--database-url', 'postgres://u:p@h/db']).kind, 'usage')
  assert.equal(parseBackfillArgs(['--help']).kind, 'help')
})

test('the CLI never prints the connection string and exits 3 on a wrong target, 0 on a dry run (fake port)', async () => {
  const dir = mkdtempSync(path.join(scratchRoot(), 'fxbf-'))
  try {
    const env = path.join(dir, 'env'); writeFileSync(env, 'DATABASE_URL=postgres://user:SECRETPW@127.0.0.1:1/ims\n'); chmodSync(env, 0o600)
    const csv = path.join(dir, 'ecb.csv'); writeFileSync(csv, FIXTURE)
    const argv = ['--env-file', env, '--expect-db', 'ims', '--expect-system-id', '7001', '--ecb-csv', csv, '--from', '2026-03-26', '--to', '2026-03-31', '--dry-run']
    let out = ''; let err = ''
    const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t } }
    const open = (f: ReturnType<typeof fakePort>) => async () => ({ port: f.port, close: async () => undefined })
    assert.equal(await runCli(argv, io, {}, { open: open(fakePort()) }), 0)
    assert.match(out, /DRY RUN/); assert.match(out, /USD: would write 4/)
    assert.equal(await runCli(argv, io, {}, { open: open(fakePort({ db: 'zzz' })) }), 3)
    assert.equal(await runCli(argv.map((a) => (a === '2026-03-26' ? '2020-01-01' : a)), io, {}, { open: open(fakePort()) }), 4)
    assert.ok(!(out + err).includes('SECRETPW') && !(out + err).includes('postgres://'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// a real scratch database (migrated with the real schema)

const dbUrl = process.env.FX_BACKFILL_TEST_DATABASE_URL
test('real database: write, idempotent re-run, skip-existing day, refusal writes nothing', { skip: dbUrl ? false : 'FX_BACKFILL_TEST_DATABASE_URL not set' }, async () => {
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    const q = (sql: string, params?: unknown[]) => client.query(sql, params)
    const ident = (await q(`select current_database() as db, (select system_identifier::text from pg_control_system()) as sid`)).rows[0]
    assert.match(ident.db, /^fxbf_scratch/, 'refuses to run against a database that is not a scratch one')
    await q('delete from "fx_rates"'); await q('delete from "currencies"'); await q('delete from "organisations"')
    for (const c of ['GBP', 'EUR', 'USD', 'CNY']) await q(`insert into "currencies" ("code","name","symbol","active") values ($1,$1,$1,$2)`, [c, c !== 'CNY'])
    await q(`insert into "organisations" ("id","name","baseCurrency","updatedAt") values ('o','o','GBP',now())`)
    const port: BackfillPort = { query: async (sql, params) => ({ rows: (await client.query(sql, params ? [...params] : undefined)).rows as never[] }) }
    const A = { ...args, expectDb: ident.db as string, expectSystemId: ident.sid as string }
    // a live row on 2026-03-30 for USD
    await q(`insert into "fx_rates" ("id","fromCurrency","toCurrency","rate","fetchedAt","source") values ('live','GBP','USD',1.5,'2026-03-30 06:00:00','frankfurter')`)

    const dry = await runBackfill(port, file(), { ...A, dryRun: true })
    assert.equal(dry.kind, 'done')
    assert.equal((await q('select count(*)::int as n from "fx_rates"')).rows[0].n, 1) // nothing written

    const first = await runBackfill(port, file(), A)
    assert.equal(first.kind, 'done')
    if (first.kind === 'done') { assert.equal(first.written, 7); assert.equal(first.skippedExisting, 1) } // EUR 4 + USD 3 (03-30 skipped)
    const rows = (await q(`select "toCurrency" c, "rate"::text r, to_char("fetchedAt",'YYYY-MM-DD"T"HH24:MI') f, source, "manualOverride" m, seq from "fx_rates" where source='ecb-history' order by 1, 3`)).rows
    assert.equal(rows.length, 7)
    assert.deepEqual(rows.find((r) => r.c === 'USD' && r.f.startsWith('2026-03-27')), { c: 'USD', r: '1.33750000', f: '2026-03-27T15:00', source: 'ecb-history', m: false, seq: rows.find((r) => r.c === 'USD' && r.f.startsWith('2026-03-27'))!.seq })
    assert.ok(rows.some((r) => r.c === 'EUR' && r.f === '2026-03-30T14:00'))
    assert.ok(!rows.some((r) => r.c === 'CNY' || r.c === 'GBP')) // disabled currency and base are never written
    assert.equal((await q(`select rate::text r from "fx_rates" where id='live'`)).rows[0].r, '1.50000000') // untouched
    assert.equal((await q(`select count(*)::int n from "fx_rates" where "toCurrency"='USD' and to_char("fetchedAt",'YYYY-MM-DD')='2026-03-30'`)).rows[0].n, 1)

    const again = await runBackfill(port, file(), A)
    assert.equal(again.kind, 'done')
    if (again.kind === 'done') { assert.equal(again.written, 0); assert.equal(again.skippedExisting, 8) }
    assert.equal((await q('select count(*)::int as n from "fx_rates"')).rows[0].n, 8)

    const refused = await runBackfill(port, file(), { ...A, currencies: ['CNY'] })
    assert.equal(refused.kind, 'refused') // CNY is not enabled
    const refused2 = await runBackfill(port, file(), { ...A, from: '2020-01-01' })
    assert.equal(refused2.kind, 'refused')
    const wrong = await runBackfill(port, file(), { ...A, expectDb: 'nope' })
    assert.equal(wrong.kind, 'target-refused')
    assert.equal((await q('select count(*)::int as n from "fx_rates"')).rows[0].n, 8)
    // a refusal mid-window (a blank cell) writes nothing, not even the good days
    await q(`update "currencies" set active = true where code = 'CNY'`)
    const gap = await runBackfill(port, file(), { ...A, currencies: ['CNY', 'USD'] })
    assert.equal(gap.kind, 'refused')
    assert.equal((await q('select count(*)::int as n from "fx_rates"')).rows[0].n, 8)
    // the central lookup picks the live row at the live day, and a backfilled row before it
    const all = (await q(`select "fromCurrency","toCurrency",rate::text rate,to_char("fetchedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fa,source,seq from "fx_rates" where "toCurrency"='USD'`)).rows.map((r) => ({ ...r, fetchedAt: new Date(r.fa) }))
    const sel = (d: string) => selectFxRateFromRows(all, { baseCurrency: 'GBP', currency: 'USD', asOf: new Date(`${d}T23:59:59.999Z`) })
    assert.equal(sel('2026-03-30').source, 'frankfurter')
    assert.equal(sel('2026-03-27').source, 'ecb-history')
  } finally { await client.end() }
})
