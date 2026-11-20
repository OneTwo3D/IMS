/**
 * The one-off ECB history backfill (fx:backfill-ecb). Fixture CSV and a recording fake port, never the network. Every arm names the mutation that turns it red.
 * The SQL runs against a real migrated database in tests/db/fx-backfill-ecb.test.ts.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { FX_TABLE_LOCK_KEY } from '../../lib/db/advisory-locks.ts'
import { selectFxRateFromRows } from '../../lib/currencies/fx-select.ts'
import {
  ECB_BACKFILL_STATEMENTS, divideRounded, ecbPublicationInstant, parseBackfillArgs, parseEcbCsv, planBackfill, runBackfill, insertStatement, type BackfillPort, type EcbFile,
} from '../../lib/first-load/backfill-ecb-rates.ts'
import { runCli } from '../../scripts/fx-backfill-ecb.ts'
import { scratchRoot } from '../helpers/scratch-root'

const FIXTURE = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'ecb-hist-small.csv'), 'utf8')
const file = (): EcbFile => { const p = parseEcbCsv(FIXTURE); assert.ok(p.ok); return p.file }
const none: ReadonlySet<string> = new Set()
const base = { file: undefined as unknown as EcbFile, baseCurrency: 'GBP', enabledCurrencies: ['GBP', 'EUR', 'USD', 'JPY'], requested: null, from: '2026-03-26', to: '2026-03-31', existing: none }
const plan = (over: Partial<Parameters<typeof planBackfill>[0]> = {}) => planBackfill({ ...base, file: file(), ...over })

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

// A backfilled row is always older than the first live row, so the live row wins wherever it exists and no tie arises.
test('fx-select: with the window before the first live row, the live row answers from its day on and the backfill before it', () => {
  const live = { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.50000000', fetchedAt: new Date('2026-03-30T06:00:00.000Z'), source: 'frankfurter', seq: 2 }
  const refused = plan({ requested: ['USD'], firstLiveDay: new Map([['USD', '2026-03-30']]) }); assert.ok(!refused.ok)
  const p2 = plan({ requested: ['USD'], to: '2026-03-27', firstLiveDay: new Map([['USD', '2026-03-30']]) }); assert.ok(p2.ok)
  const rows = [...p2.rows.map((r) => ({ fromCurrency: 'GBP', toCurrency: 'USD', rate: r.rate, fetchedAt: r.fetchedAt, source: 'ecb-history', seq: 1 })), live]
  const at = (d: string) => selectFxRateFromRows(rows, { baseCurrency: 'GBP', currency: 'USD', asOf: new Date(`${d}T23:59:59.999Z`) })
  assert.equal(at('2026-03-27').source, 'ecb-history')
  assert.equal(at('2026-03-27').rate.toString(), '1.3375')
  assert.equal(at('2026-03-30').source, 'frankfurter')
  assert.equal(at('2026-03-31').source, 'frankfurter') // the latest row stays the live one
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the transaction, against a recording fake port

function fakePort(opts: { db?: string; sid?: string; base?: string; existing?: Array<{ cur: string; day: string }>; firstLive?: Array<{ cur: string; day: string }>; settings?: Array<{ key: string; value: string }> } = {}): { port: BackfillPort; sent: Array<{ sql: string; params?: readonly unknown[] }> } {
  const sent: Array<{ sql: string; params?: readonly unknown[] }> = []
  return {
    sent,
    port: {
      async query<T>(sql: string, params?: readonly unknown[]) {
        sent.push({ sql, params })
        if (sql === ECB_BACKFILL_STATEMENTS.identity) return { rows: [{ db: opts.db ?? 'ims', sid: opts.sid ?? '7001' }] as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.base) return { rows: [{ base: opts.base ?? 'GBP' }] as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.enabled) return { rows: [{ code: 'EUR' }, { code: 'GBP' }, { code: 'USD' }] as T[] }
        // by default every currency has a first live row well after the window
        if (sql === ECB_BACKFILL_STATEMENTS.firstLive) return { rows: (opts.firstLive ?? [{ cur: 'EUR', day: '2026-04-15' }, { cur: 'USD', day: '2026-04-15' }]) as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.fxSource) return { rows: (opts.settings ?? []) as T[] }
        if (sql === ECB_BACKFILL_STATEMENTS.existing) return { rows: (opts.existing ?? []) as T[] }
        return { rows: [] as T[] }
      },
    },
  }
}
const args = { from: '2026-03-26', to: '2026-03-31', currencies: null, expectDb: 'ims', expectSystemId: '7001', dryRun: false }

// [mutation: skip the identity check, check after the insert, drop the lock, drop the rollback]
test('a real run: target confirmed first, then the lock, then the reads, one insert, COMMIT; a wrong target writes nothing', async () => {
  const ok = fakePort()
  const out = await runBackfill(ok.port, file(), args)
  assert.equal(out.kind, 'done')
  const sqls = ok.sent.map((s) => s.sql)
  assert.equal(sqls[0], ECB_BACKFILL_STATEMENTS.beginWrite)
  assert.equal(sqls[1], ECB_BACKFILL_STATEMENTS.identity) // the target is confirmed BEFORE the lock is asked for
  assert.equal(sqls[2], ECB_BACKFILL_STATEMENTS.lockTimeout)
  assert.equal(sqls[3], ECB_BACKFILL_STATEMENTS.lock)
  assert.deepEqual(ok.sent[3]!.params, [FX_TABLE_LOCK_KEY])
  assert.equal(sqls.at(-1), ECB_BACKFILL_STATEMENTS.commit)
  assert.equal(sqls.filter((s) => s.startsWith('insert')).length, 1)
  for (const bad of [{ db: 'other' }, { sid: '9' }]) {
    const f = fakePort(bad)
    const r = await runBackfill(f.port, file(), args)
    assert.equal(r.kind, 'target-refused')
    assert.ok(!f.sent.some((s) => s.sql.startsWith('insert') || s.sql === ECB_BACKFILL_STATEMENTS.lock)) // a wrong target never reaches the lock
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

// [mutation: drop the floor check, compare against a row of any source, drop the Aelia check]
test('live period: a day on or after the first live row of a currency is REFUSED (not clamped), listing the days', () => {
  // a manual pin on 03-27, a window after it: the pin must not be un-pinned by a later backfilled row
  const pin = plan({ requested: ['USD'], firstLiveDay: new Map([['USD', '2026-03-27']]) })
  assert.ok(!pin.ok); assert.match(pin.refusals.join('\n'), /USD: 3 planned day\(s\) on or after the first live row of USD \(2026-03-27\).*2026-03-30.*lower --to to 2026-03-26.*--currencies excluding USD/)
  // a gap day after a first live row (live 03-26, gap 03-27)
  const gap = plan({ requested: ['USD', 'EUR'], from: '2026-03-27', to: '2026-03-27', firstLiveDay: new Map([['USD', '2026-03-26'], ['EUR', '2026-04-15']]) })
  assert.ok(!gap.ok); assert.match(gap.refusals.join(), /USD: 1 planned day/); assert.ok(!gap.refusals.join().includes('EUR:'))
  // the same window before the first live row is fine, and a currency without live rows is unaffected
  const ok = plan({ requested: ['USD', 'EUR'], to: '2026-03-27', firstLiveDay: new Map([['USD', '2026-03-28'], ['EUR', '2026-04-15']]) })
  assert.ok(ok.ok); assert.equal(ok.rows.length, 4)
})

test('live period: the earliest Aelia interval start refuses every day on or after it', () => {
  const p = plan({ requested: ['USD'], aeliaFromDay: '2026-03-30' })
  assert.ok(!p.ok); assert.match(p.refusals.join(), /on or after the start of the Aelia period \(2026-03-30\): USD 2026-03-30, USD 2026-03-31/)
  assert.ok(plan({ requested: ['USD'], to: '2026-03-27', aeliaFromDay: '2026-03-30' }).ok)
})

test('a zero base cell and a rate that rounds to zero are refusals, never an exception', () => {
  const f = file(); f.days.get('2026-03-30')!.set('GBP', '0.0000')
  const zero = plan({ file: f }); assert.ok(!zero.ok); assert.match(zero.refusals.join(), /2026-03-30: the base currency GBP has a blank, N\/A or zero cell/)
  const g = file(); g.days.get('2026-03-30')!.set('USD', '0.0001'); g.days.get('2026-03-30')!.set('GBP', '100000')
  const tiny = plan({ file: g, requested: ['USD'] }); assert.ok(!tiny.ok); assert.match(tiny.refusals.join(), /rounds to zero/)
  const z2 = file(); z2.days.get('2026-03-30')!.set('USD', '0')
  assert.ok(!plan({ file: z2, requested: ['USD'] }).ok)
})

test('a non-GBP base: the insert is bound with that base and rates converted against it', async () => {
  const f = fakePort({ base: 'EUR' })
  const out = await runBackfill(f.port, file(), { ...args, currencies: ['USD'] })
  assert.equal(out.kind, 'done')
  const ins = f.sent.find((s) => s.sql.startsWith('insert'))!
  assert.equal(ins.params![1], 'EUR'); assert.equal(ins.params![2], 'USD'); assert.equal(ins.params![3], '1.06000000')
  assert.equal(ins.params![4], '2026-03-26T15:00:00.000') // zero-zone UTC text
})

test('lock timeout is a refusal with nothing written; a COMMIT failure is reported as outcome unknown', async () => {
  const base = fakePort()
  const timing: BackfillPort = { query: async (sql, params) => { if (sql === ECB_BACKFILL_STATEMENTS.lock) throw Object.assign(new Error('x'), { code: '55P03' }); return base.port.query(sql, params) } }
  const r = await runBackfill(timing, file(), args)
  assert.equal(r.kind, 'target-refused')
  assert.ok(!base.sent.some((s) => s.sql.startsWith('insert')))
  const failing: BackfillPort = { query: async (sql, params) => { if (sql === ECB_BACKFILL_STATEMENTS.commit) throw new Error('gone'); return base.port.query(sql, params) } }
  await assert.rejects(runBackfill(failing, file(), args), /COMMIT_OUTCOME_UNKNOWN/)
})

// [mutation: drop the no-live-row refusal]
test('a currency with NO live row is refused: a backfilled row would become its latest rate', async () => {
  const p = plan({ requested: ['USD', 'EUR'], firstLiveDay: new Map([['EUR', '2026-04-15']]) })
  assert.ok(!p.ok); assert.match(p.refusals.join(), /USD: there is no live \(non-ecb-history\) GBP\/USD row.*run the FX refresh first, or exclude it with --currencies/)
  assert.ok(!p.refusals.join().includes('EUR:'))
  const f = fakePort({ firstLive: [{ cur: 'EUR', day: '2026-04-15' }] })
  const out = await runBackfill(f.port, file(), args)
  assert.equal(out.kind, 'refused')
  assert.ok(!f.sent.some((x) => x.sql.startsWith('insert')))
})

test('a malformed FX source history refuses the run and writes nothing', async () => {
  const f = fakePort({ settings: [{ key: 'fx_rate_source_history', value: 'not json' }] })
  const out = await runBackfill(f.port, file(), args)
  assert.equal(out.kind, 'refused')
  if (out.kind === 'refused') assert.match(out.refusals.join(), /history is unreadable/)
  assert.ok(!f.sent.some((x) => x.sql.startsWith('insert') || x.sql === ECB_BACKFILL_STATEMENTS.commit))
})

test('a dry run refuses the live period too (CLI exit 4)', async () => {
  const dir = mkdtempSync(path.join(scratchRoot(), 'fxbf-'))
  try {
    const env = path.join(dir, 'env'); writeFileSync(env, 'DATABASE_URL=postgres://user:pw@127.0.0.1:1/ims\n'); chmodSync(env, 0o600)
    const csv = path.join(dir, 'ecb.csv'); writeFileSync(csv, FIXTURE)
    const argv = ['--env-file', env, '--expect-db', 'ims', '--expect-system-id', '7001', '--ecb-csv', csv, '--from', '2026-03-26', '--to', '2026-03-31', '--dry-run']
    let err = ''
    const f = fakePort({ firstLive: [{ cur: 'EUR', day: '2026-03-30' }, { cur: 'USD', day: '2026-03-30' }] })
    const code = await runCli(argv, { out: () => undefined, err: (t) => { err += t } }, {}, { open: async () => ({ port: f.port, close: async () => undefined }) })
    assert.equal(code, 4); assert.match(err, /on or after the first live row/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
