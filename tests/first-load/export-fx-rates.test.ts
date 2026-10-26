/**
 * Owner ruling (2026-10-25): an export command for the ims-fx-rates dataset, read-only, base-currency rows only, the base currency stamped on every row, and
 * first-load:prepare refusing an export whose base differs from the manifest's. Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseCsvStrict } from '../../lib/first-load/csv.ts'
import { FX_EXPORT_STATEMENTS, parseFxExportArgs, readFxRates, renderFxRatesCsv, sinceInstant, type FxExportPort } from '../../lib/first-load/export-fx-rates.ts'
import { ingestDataset } from '../../lib/first-load/ingest.ts'
import { runCli } from '../../scripts/first-load-export-fx-rates.ts'
import { dispositionCodes, ds, precondition, product, rowsOf, run, runBare } from './helpers.ts'

type Row = { fromCurrency: string; toCurrency: string; rate: string; fetchedAt: string }
const TABLE: Row[] = [
  { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.15000000', fetchedAt: '2026-09-01T06:00:00.000Z' },
  { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.17000000', fetchedAt: '2026-09-20T06:00:00.000Z' },
  { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.30000000', fetchedAt: '2026-09-20T06:00:00.000Z' },
  { fromCurrency: 'USD', toCurrency: 'JPY', rate: '150.00000000', fetchedAt: '2026-09-20T06:00:00.000Z' },
]
function fakePort(opts: { base?: string; rows?: Row[]; db?: string; sid?: string } = {}): { port: FxExportPort; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    port: {
      async query<T>(sql: string) {
        sent.push(sql)
        if (sql === FX_EXPORT_STATEMENTS.identity) return { rows: [{ db: opts.db ?? 'ims', sid: opts.sid ?? '7001' }] as T[] }
        if (sql === FX_EXPORT_STATEMENTS.base) return { rows: [{ base: opts.base ?? 'GBP' }] as T[] }
        if (sql === FX_EXPORT_STATEMENTS.rows) return { rows: (opts.rows ?? TABLE) as T[] }
        return { rows: [] as T[] }
      },
    },
  }
}

// [mutation: add a write statement, drop BEGIN READ ONLY, or drop the ROLLBACK]
test('the export runs in ONE read-only repeatable-read transaction and sends only its four statements', async (t) => {
  const { port, sent } = fakePort()
  await readFxRates(port, null)
  precondition(t, 'statements', sent.length)
  assert.deepEqual(sent, [FX_EXPORT_STATEMENTS.begin, FX_EXPORT_STATEMENTS.identity, FX_EXPORT_STATEMENTS.base, FX_EXPORT_STATEMENTS.rows, FX_EXPORT_STATEMENTS.rollback])
  assert.match(FX_EXPORT_STATEMENTS.begin, /^BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ$/)
  for (const sql of Object.values(FX_EXPORT_STATEMENTS)) assert.ok(!/\b(insert|update|delete|truncate|alter|drop|create|grant)\b/i.test(sql), `no write verb in: ${sql.slice(0, 40)}`)
  // a failing read still rolls back
  const failingSent: string[] = []
  const failing: FxExportPort = { async query(sql: string) { failingSent.push(sql); if (sql === FX_EXPORT_STATEMENTS.rows) throw new Error('boom'); return { rows: [] } } }
  await assert.rejects(readFxRates(failing, null))
  assert.equal(failingSent.at(-1), FX_EXPORT_STATEMENTS.rollback)
})

// [mutation: export every fromCurrency, skip the base filter, drop the base stamp column]
test('only base-currency rows are exported, with the expected columns, each stamped with the base; other-base rows are counted', async (t) => {
  const read = await readFxRates(fakePort().port, null)
  precondition(t, 'rows', read.rows.length)
  assert.equal(read.rows.length, 3)
  assert.equal(read.otherBaseRows, 1)
  const csv = renderFxRatesCsv(read)
  const parsed = parseCsvStrict(csv)
  assert.deepEqual(parsed.header, ['currency', 'rate', 'fetchedAt', 'baseCurrency'])
  assert.deepEqual(parsed.rows.map((r) => r.cells), [['EUR', '1.15000000', '2026-09-01T06:00:00.000Z', 'GBP'], ['EUR', '1.17000000', '2026-09-20T06:00:00.000Z', 'GBP'], ['USD', '1.30000000', '2026-09-20T06:00:00.000Z', 'GBP']])
})

// [mutation: default --since to a window, compare with > instead of >=, or ignore --since]
test('the default exports ALL rows; --since keeps rows on or after that day (UTC) and counts the rest; a bad date is refused', async (t) => {
  const all = await readFxRates(fakePort().port, null)
  const boundary: Row = { fromCurrency: 'GBP', toCurrency: 'CHF', rate: '1.1', fetchedAt: '2026-09-20T00:00:00.000Z' }
  const since = await readFxRates(fakePort({ rows: [...TABLE, boundary] }).port, '2026-09-20')
  precondition(t, 'cases', 2)
  assert.equal(all.rows.length, 3)
  assert.deepEqual(since.rows.map((r) => r.currency).sort(), ['CHF', 'EUR', 'USD'], 'a row at the very start of the day is kept')
  assert.equal(since.beforeSinceRows, 1)
  assert.equal(sinceInstant('2026-02-30'), null)
  assert.equal(sinceInstant('2026-9-1'), null)
  assert.equal(parseFxExportArgs(['--env-file', 'e', '--expect-db', 'd', '--expect-system-id', '1', '--out', 'o']).kind, 'run')
  const parsed = parseFxExportArgs(['--env-file', 'e', '--expect-db', 'd', '--expect-system-id', '1', '--out', 'o'])
  assert.equal(parsed.kind === 'run' && parsed.args.since, null, 'the documented default is all rows')
  assert.equal(parseFxExportArgs(['--env-file', 'e', '--expect-db', 'd', '--expect-system-id', '1', '--out', 'o', '--since', '2026-13-01']).kind, 'usage')
})

function envFile(dir: string, mode = 0o600): string {
  const file = path.join(dir, `target-${mode.toString(8)}.env`)
  writeFileSync(file, 'DATABASE_URL=postgresql://u@127.0.0.1:1/ims\n', { mode })
  chmodSync(file, mode)
  return file
}
async function cli(args: string[], port: FxExportPort, env = process.env) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(args, { out: (x) => out.push(x), err: (x) => err.push(x) }, env, { open: async () => ({ port, close: async () => undefined }), now: () => new Date('2026-10-25T10:00:00Z') })
  return { code, out: out.join(''), err: err.join('') }
}

// [mutation: skip the --expect-db / --expect-system-id confirmation, write with a wider mode, overwrite an existing file, drop the digest]
test('the command writes the CSV and its record mode 600 in a mode-700 directory, with the digest; the target must be confirmed; nothing is overwritten', async (t) => {
  const root = mkdtempSync('/var/tmp/first-load-export-')
  try {
    const env = envFile(root)
    const out = path.join(root, 'out')
    const base = ['--env-file', env, '--expect-db', 'ims', '--expect-system-id', '7001', '--out', out]
    const wrongDb = await cli(['--env-file', env, '--expect-db', 'other', '--expect-system-id', '7001', '--out', path.join(root, 'o1')], fakePort().port)
    const wrongSid = await cli(['--env-file', env, '--expect-db', 'ims', '--expect-system-id', '1', '--out', path.join(root, 'o2')], fakePort().port)
    assert.equal(wrongDb.code, 3, wrongDb.err)
    assert.equal(wrongSid.code, 3)
    const ok = await cli(base, fakePort().port)
    precondition(t, 'cases', 3)
    assert.equal(ok.code, 0, ok.err)
    const csv = readFileSync(path.join(out, 'ims-fx-rates.csv'), 'utf8')
    const record = JSON.parse(readFileSync(path.join(out, 'ims-fx-rates.export.json'), 'utf8')) as { file: { sha256: string; rows: number }; baseCurrency: string; since: null; otherBaseRowsNotExported: number }
    assert.equal(record.file.rows, 3)
    assert.equal(record.baseCurrency, 'GBP')
    assert.equal(record.since, null)
    assert.equal(record.otherBaseRowsNotExported, 1)
    assert.match(ok.out, new RegExp(record.file.sha256))
    assert.equal(statSync(path.join(out, 'ims-fx-rates.csv')).mode & 0o777, 0o600)
    assert.equal(statSync(path.join(out, 'ims-fx-rates.export.json')).mode & 0o777, 0o600)
    assert.equal(statSync(out).mode & 0o777, 0o700)
    assert.equal(statSync(out).uid, process.getuid?.())
    // the written file is a valid ims-fx-rates dataset
    assert.equal(ingestDataset('ims-fx-rates', new TextEncoder().encode(csv), 'ims-fx-rates.csv', null).rows.length, 3)
    const again = await cli(base, fakePort().port)
    assert.equal(again.code, 2, 'a second export into the same directory is refused, never overwritten')
    assert.equal(readFileSync(path.join(out, 'ims-fx-rates.csv'), 'utf8'), csv)
    const open = await cli(['--env-file', envFile(root, 0o644), '--expect-db', 'ims', '--expect-system-id', '7001', '--out', path.join(root, 'o3')], fakePort().port)
    assert.equal(open.code, 2, 'an env file readable by others is refused')
    const empty = await cli(['--env-file', env, '--expect-db', 'ims', '--expect-system-id', '7001', '--out', path.join(root, 'o4')], fakePort({ rows: [] }).port)
    assert.equal(empty.code, 4)
    const mixedEnv = path.join(root, 'bad.env')
    writeFileSync(mixedEnv, 'DATABASE_URL=postgresql://u@h/d\nPGHOST=elsewhere\n', { mode: 0o600 })
    assert.equal((await cli(['--env-file', mixedEnv, '--expect-db', 'ims', '--expect-system-id', '7001', '--out', path.join(root, 'o5')], fakePort().port)).code, 2, 'an env file that redirects a client library is refused')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// [mutation: drop the BASE_CURRENCY_MISMATCH reject, compare case-sensitively, or compare with the wrong side]
test('first-load:prepare refuses an export whose base currency differs from the manifest\'s; a matching or unstamped list is accepted', (t) => {
  const stamped = (base: string) => ds('ims-fx-rates', [{ currency: 'USD', rate: '1.25', fetchedAt: '2026-09-24T06:00:00Z', baseCurrency: base }])
  const orders = (fx: ReturnType<typeof stamped>) => run({
    products: ds('products', [product('A')]),
    suppliers: ds('suppliers', [{ name: 'Sup', currency: 'USD' }]),
    'ims-fx-rates': fx,
    'purchase-order-lines': ds('purchase-order-lines', [{ orderKey: 'O', supplierName: 'Sup', sku: 'A', qtyOrdered: '1', qtyReceived: '0', unitCostForeign: '1', createdOn: '2026-09-24' }]),
  })
  const mismatch = orders(stamped('EUR'))
  const lower = orders(stamped('gbp'))
  const unstamped = runBare({
    products: ds('products', [product('A')]),
    suppliers: ds('suppliers', [{ name: 'Sup', currency: 'USD' }]),
    'ims-fx-rates': ds('ims-fx-rates', [{ currency: 'USD', rate: '1.25', fetchedAt: '2026-09-24T06:00:00Z' }]),
    'purchase-order-lines': ds('purchase-order-lines', [{ orderKey: 'O', supplierName: 'Sup', sku: 'A', qtyOrdered: '1', qtyReceived: '0', unitCostForeign: '1', createdOn: '2026-09-24' }]),
  })
  precondition(t, 'cases', 3)
  assert.deepEqual(dispositionCodes(mismatch, 'ims-fx-rates', 'REJECTED'), ['BASE_CURRENCY_MISMATCH'])
  assert.equal(mismatch.blocking, true)
  assert.deepEqual(dispositionCodes(mismatch, 'purchase-order-lines', 'REJECTED'), ['FX_RATE_MISSING'], 'no rate is taken from a refused list')
  assert.deepEqual(dispositionCodes(lower, 'ims-fx-rates', 'REJECTED'), [])
  assert.equal(rowsOf(lower, 'purchase-orders')[0]?.fxRateToBase, '1.25')
  assert.equal(rowsOf(unstamped, 'purchase-orders')[0]?.fxRateToBase, '1.25')
})
