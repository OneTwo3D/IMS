import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { afterEach } from 'node:test'

import { runPackCli, type PackCliDeps } from '../../scripts/reconciliation-pack.ts'
import { parsePackArgs } from '../../lib/reconciliation-pack/cli.ts'
import { PACK_CLI_CODES, PACK_CLI_FLAGS } from '../../lib/reconciliation-pack/constants.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, allFiles, cleanup, realEvidence, scratchDir } from './helpers.ts'
import { ASOF, sha256, stockCsv, writeExport } from './qoblex-fixtures.ts'
import { fakeStore } from './woo-fixtures.ts'

/**
 * THE COMMAND WITH A QOBLEX EXPORT: nothing is read without --qoblex-export, the export is read once, every IMS statement is a read, and no
 * input, path or secret reaches any output. Mutations are listed in the PR.
 */

const bases: string[] = []
afterEach(() => cleanup(bases))
const SID = '7000000000000000001'
const cuid = (n: number) => `c${String(n).padStart(24, '0')}`

type Rig = { sent: string[]; out: string[]; err: string[]; deps: Partial<PackCliDeps>; wooCalls: number }
function rig(over: { qty?: string; value?: string; wooSkus?: string[]; imsSkus?: string[] } = {}): Rig {
  const r: Rig = { sent: [], out: [], err: [], deps: {}, wooCalls: 0 }
  const imsSkus = over.imsSkus ?? ['SKU-1', 'SKU-2', 'SKU-3']
  const client: ImsQueryClient = {
    async query(sql) {
      r.sent.push(sql)
      if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
      if (/pg_control_system/.test(sql)) return { rows: [{ sid: SID, db: 'ims' }] }
      if (/FROM inventory_snapshot_runs/.test(sql)) return { rows: [{ stock_count: '2', snapshot_count: '2' }] }
      if (/FROM inventory_snapshots/.test(sql)) return { rows: [
        { product_id: cuid(1), warehouse_id: cuid(101), qty: over.qty ?? '10', value: over.value ?? '25', reliable: true },
        { product_id: cuid(2), warehouse_id: cuid(102), qty: '4', value: '40', reliable: true },
      ] }
      if (/FROM accounting_account_balance_snapshots/.test(sql)) return { rows: [] }
      if (/FROM products/.test(sql)) return { rows: imsSkus.map((sku, i) => ({ id: cuid(i + 1), sku, type: 'SIMPLE', active: true, lifecycle: 'ACTIVE' })) }
      if (/FROM warehouses/.test(sql)) return { rows: [{ id: cuid(101), code: 'MIL1', active: true }, { id: cuid(102), code: 'CAMBRIDGE', active: true }, { id: cuid(103), code: 'RXT2', active: true }] }
      if (/FROM external_wms_bindings/.test(sql)) return { rows: [{ connector: 'x', warehouse_id: cuid(103), warehouse_code: 'RXT2', external_id: '9', active: true, mode: 'NOTIFICATION_ONLY', confirmed: false }] }
      return { rows: [] }
    },
  }
  const store = fakeStore({ products: (over.wooSkus ?? ['SKU-1', 'SKU-2', 'SKU-3']).map((sku, i) => ({ id: i + 1, sku, status: 'publish', type: 'simple' })) })
  const counted = { get: (c: Parameters<typeof store.get>[0], p: Parameters<typeof store.get>[1]) => { r.wooCalls += 1; return store.get(c, p) } }
  r.deps = {
    now: () => NOW,
    openIms: async () => ({ client, close: async () => undefined }),
    runInvariant: async () => realEvidence(),
    disconnect: async () => undefined,
    liveness: healthyLiveness(),
    basis: fakeBasisPort(goodState()),
    woo: counted,
  }
  return r
}
const run = (r: Rig, argv: string[], extra: Partial<Parameters<typeof runPackCli>[0]> = {}) => runPackCli({
  argv, env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', deps: r.deps,
  stdout: (t) => r.out.push(t), stderr: (t) => r.err.push(t), ...extra,
})
const args = (dir: string, ...more: string[]) => {
  const at = more.indexOf('--items')
  const items = at >= 0 ? more[at + 1]! : 'R2,R5,R14'
  const rest = at >= 0 ? [...more.slice(0, at), ...more.slice(at + 2)] : more
  return ['--phase', 'P1', '--as-of', ASOF, '--items', items, '--report-dir', dir, ...rest]
}
const line = (r: Rig, id: string) => r.out.find((l) => l.startsWith(`${id} `))
void D

// [mutation: the source built without the flag / the Qoblex check moved after the runner]
test('WITHOUT --qoblex-export the Qoblex items read nothing: no IMS statement for them, no storefront request, QOBLEX_EXPORT_OFF (VENDOR_READS_OFF for R14 without the opt-in)', async () => {
  const dir = scratchDir(bases)
  const exportDir = writeExport(bases)
  void exportDir
  for (const more of [[], ['--vendor-reads-only']]) {
    const r = rig()
    assert.equal(await run(r, args(dir, ...more)), 5)
    assert.equal(line(r, 'R2'), 'R2 inconclusive QOBLEX_EXPORT_OFF')
    assert.equal(line(r, 'R5'), 'R5 inconclusive QOBLEX_EXPORT_OFF')
    assert.equal(line(r, 'R14'), more.length === 0 ? 'R14 inconclusive VENDOR_READS_OFF' : 'R14 inconclusive QOBLEX_EXPORT_OFF')
    assert.ok(!r.sent.some((sql) => /inventory_snapshots|FROM products|FROM warehouses|external_wms_bindings/.test(sql)), 'and the IMS side of the Qoblex items was not read')
    assert.equal(r.wooCalls, 0)
  }
})

test('WITH --qoblex-export: R2 and R5 pass on agreeing data, R14 is not a pass without a Mintsoft source (LEG_UNAVAILABLE), and every IMS statement is a read', async () => {
  const dir = scratchDir(bases)
  const exportDir = writeExport(bases)
  const r = rig()
  assert.equal(await run(r, args(dir, '--qoblex-export', exportDir, '--vendor-reads-only')), 5)
  assert.equal(line(r, 'R2'), 'R2 pass -')
  assert.equal(line(r, 'R5'), 'R5 pass -')
  assert.equal(line(r, 'R14'), 'R14 inconclusive LEG_UNAVAILABLE')
  assert.ok(!r.sent.some((sql) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|COMMIT)\b/i.test(sql)), 'nothing was written to the database')
  assert.ok(r.sent.every((sql) => /^\s*(SELECT|SET LOCAL|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)/i.test(sql)), r.sent.filter((sql) => !/^\s*(SELECT|SET LOCAL|BEGIN|ROLLBACK)/i.test(sql)).join('\n'))
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const items = chain.head!.record.items
  assert.deepEqual(items.find((i) => i.id === 'R2')!.sources.slice().sort(), ['ims-database', 'qoblex-file'])
  assert.deepEqual(items.find((i) => i.id === 'R14')!.sources.slice().sort(), ['ims-database', 'qoblex-file', 'woocommerce-api'])
  // with a Mintsoft SKU source wired, R14 passes
  const full = rig()
  full.deps.wmsSkus = async () => ({ ok: true, skus: ['SKU-1', 'SKU-2', 'SKU-3'] })
  assert.equal(await run(full, args(scratchDir(bases), '--qoblex-export', exportDir, '--vendor-reads-only')), 5)
  assert.equal(line(full, 'R14'), 'R14 pass -')
  // but not without the opt-in: the source is never asked
  const quiet = rig()
  let asked = 0
  quiet.deps.wmsSkus = async () => { asked += 1; return { ok: true, skus: [] } }
  await run(quiet, args(scratchDir(bases), '--qoblex-export', exportDir))
  assert.equal(asked, 0)
  assert.equal(line(quiet, 'R14'), 'R14 inconclusive VENDOR_READS_OFF')
})

test('a difference is a fail with the identities named, an IDENTITY SWAP across warehouses is two, and a partial run never exits 0 or 1 (the unselected items are inconclusive: 5)', async () => {
  const exportDir = writeExport(bases)
  const r = rig({ qty: '11' })
  assert.equal(await run(r, args(scratchDir(bases), '--items', 'R2', '--qoblex-export', exportDir)), 5)
  assert.equal(line(r, 'R2'), 'R2 fail DIFFERENCES')
  const swapped = writeExport(bases, { stock: stockCsv([{ sku: 'SKU-1', location: 'CAMBRIDGE', qty: '10', unitCost: '2.5' }, { sku: 'SKU-2', location: 'MIL1', qty: '4', unitCost: '10' }]) })
  const s = rig()
  assert.equal(await run(s, args(scratchDir(bases), '--items', 'R2', '--qoblex-export', swapped)), 5)
  assert.equal(line(s, 'R2'), 'R2 fail DIFFERENCES')
})

// [mutation: the freshness check skipped / run asOf not passed to the source]
test('a stale export, an export for another day, an unreadable export are inconclusive with their closed reason', async () => {
  const cases: Array<[string, Parameters<typeof writeExport>[1], string]> = [
    ['another day', { asOf: '2026-10-18' }, 'QOBLEX_EXPORT_STALE'],
    ['before the day ended', { exportedAt: '2026-10-19T20:00:00Z' }, 'QOBLEX_EXPORT_STALE'],
    ['unlisted location', { stock: stockCsv([{ sku: 'SKU-1', location: 'ELSEWHERE', qty: '1', unitCost: '1' }]) }, 'NO_POPULATION_RECORD'],
    ['bad row', { stock: stockCsv([{ sku: 'SKU-1', location: 'MIL1', qty: 'x', unitCost: '1' }]) }, 'BAD_VALUE'],
  ]
  for (const [label, options, reason] of cases) {
    const r = rig()
    await run(r, args(scratchDir(bases), '--items', 'R2,R5', '--qoblex-export', writeExport(bases, options)))
    assert.equal(line(r, 'R2'), `R2 inconclusive ${reason}`, label)
    assert.equal(line(r, 'R5'), `R5 inconclusive ${reason}`, label)
    assert.ok(!r.sent.some((sql) => /inventory_snapshots/.test(sql)), `${label}: IMS snapshot not read`)
  }
  const gone = rig()
  await run(gone, args(scratchDir(bases), '--items', 'R2', '--qoblex-export', path.join(scratchDir(bases), 'missing')))
  assert.equal(line(gone, 'R2'), 'R2 inconclusive SOURCE_UNREADABLE')
})

test('the flags parse, are documented, are refused with a credential shape, and cannot be combined with --basis-only', () => {
  const ok = parsePackArgs(['--phase', 'P1', '--qoblex-export', '/var/tmp/x', '--sku-exclusions', '/var/tmp/e.json'], NOW)
  assert.ok(!('code' in ok) && ok.qoblexExport === '/var/tmp/x' && ok.skuExclusions === '/var/tmp/e.json')
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--qoblex-export', '/a', '--qoblex-export', '/b'], NOW), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--qoblex-export'], NOW), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--qoblex-export', 'https://user:pw@example.com/x'], NOW), { code: 'CREDENTIAL_ARGUMENT' })
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--basis-only', '--qoblex-export', '/a'], NOW), { code: 'BAD_ARGUMENTS' })
  assert.deepEqual(parsePackArgs(['--phase', 'P1', '--basis-only', '--sku-exclusions', '/a'], NOW), { code: 'BAD_ARGUMENTS' })
  for (const flag of ['--qoblex-export', '--sku-exclusions']) assert.ok(PACK_CLI_FLAGS.some((f) => f.flag === flag && f.meaning.length > 40), flag)
  assert.ok('EXCLUSION_FILE_UNREADABLE' in PACK_CLI_CODES)
})

// [mutation: a named exclusion file that cannot be read is treated as none / an untrusted file's entries used]
test('--sku-exclusions: a named file that cannot be read is a refusal (exit 2); an untrusted file is read as nothing, so R14 reports every missing SKU', async () => {
  const exportDir = writeExport(bases)
  const missing = rig()
  assert.equal(await run(missing, args(scratchDir(bases), '--qoblex-export', exportDir, '--sku-exclusions', path.join(scratchDir(bases), 'nope.json'))), 2)
  assert.ok(missing.err.join('\n').includes('EXCLUSION_FILE_UNREADABLE'))
  assert.ok(!missing.sent.some((sql) => /inventory_snapshots/.test(sql)), 'refused before anything was read')

  const folder = scratchDir(bases)
  const exclusions = path.join(folder, 'exclusions.json')
  writeFileSync(exclusions, JSON.stringify({ schemaVersion: 1, exclusions: [{ sku: 'SKU-3', system: 'woocommerce', acceptedBy: 'owner', acceptedAt: '2026-10-01T00:00:00Z', reason: 'not on the shop on purpose', expiresAt: '2026-12-01T00:00:00Z' }] }), { mode: 0o644 })
  const wooLacks = { wooSkus: ['SKU-1', 'SKU-2'] }
  const accepted = rig(wooLacks)
  accepted.deps.wmsSkus = async () => ({ ok: true, skus: ['SKU-1', 'SKU-2', 'SKU-3'] })
  await run(accepted, args(scratchDir(bases), '--items', 'R14', '--qoblex-export', exportDir, '--vendor-reads-only', '--sku-exclusions', exclusions))
  assert.equal(line(accepted, 'R14'), 'R14 pass -')
  chmodSync(exclusions, 0o666)
  const untrusted = rig(wooLacks)
  untrusted.deps.wmsSkus = async () => ({ ok: true, skus: ['SKU-1', 'SKU-2', 'SKU-3'] })
  await run(untrusted, args(scratchDir(bases), '--items', 'R14', '--qoblex-export', exportDir, '--vendor-reads-only', '--sku-exclusions', exclusions))
  assert.equal(line(untrusted, 'R14'), 'R14 fail DIFFERENCES')
})

// [mutation: a token passed through unsanitised / the export path or a file's text reaches an output]
test('SECRETS SCAN: a credential-shaped SKU is digested, and neither the export path, a manifest value nor a file\'s text reaches any output', async () => {
  const secret = 'ck_live_SECRETSKUVALUE123456789abcdefgh'
  const exportDir = writeExport(bases, { stock: stockCsv([{ sku: secret, location: 'MIL1', qty: '10', unitCost: '2.5' }, { sku: 'SKU-2', location: 'CAMBRIDGE', qty: '4', unitCost: '10' }]) })
  const dir = scratchDir(bases)
  const r = rig()
  assert.equal(await run(r, args(dir, '--items', 'R2', '--qoblex-export', exportDir)), 5)
  const chain = readPackChain(dir)
  assert.ok(chain.ok && chain.head)
  const published = allFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n')
  const everything = `${r.out.join('\n')}\n${r.err.join('\n')}\n${published}`
  assert.ok(published.includes('sku#'), 'the SKU was digested')
  for (const text of [secret, 'SECRETSKUVALUE', exportDir, path.basename(exportDir), 'exportedAt', 'stock.csv', 'manifest.json', EXPORTED_TEXT]) assert.ok(!everything.includes(text), `output contains ${text}`)
})
const EXPORTED_TEXT = '2026-10-20T08:00:00Z'

// [mutation: the run's cycle date not given to the source]
test('the export is judged against the run\'s OWN cycle date: an export for the 19th is stale for a run of the 18th', async () => {
  const r = rig()
  await run(r, ['--phase', 'P1', '--as-of', '2026-10-18', '--items', 'R2', '--report-dir', scratchDir(bases), '--qoblex-export', writeExport(bases)])
  assert.equal(line(r, 'R2'), 'R2 inconclusive QOBLEX_EXPORT_STALE')
})

// [mutation: the native-map digest check removed from the source]
test('a column map that is not the native one (here one that skips a row kind) cannot make R2, R5 or R14 pass', async () => {
  const nativeDir = path.join(process.cwd(), 'tests/first-load/fixtures/qoblex-native')
  const clean = readFileSync(path.join(nativeDir, 'stock-on-hand.csv'), 'utf8').split('\r\n').filter((line) => !/^"[^"]*","[^"]*","SYN-[0-9A-Z-]*","[^"]*","[Uu]nknown"/.test(line)).join('\r\n')
  const m = JSON.parse(readFileSync(path.join(nativeDir, 'maps/qoblex-stock-on-hand.map.json'), 'utf8'))
  m.datasets['stock-lots'].rowSelect = { column: 'Product Type', keep: ['simple'], skip: ['variable'] }
  m.datasets.products.rowSelect = { column: 'Product Type', keep: ['simple'], skip: ['variable'] }
  const map = JSON.stringify(m)
  const exportDir = writeExport(bases, {
    stock: clean, products: null, locations: ['MIL1', 'CAMBRIDGE', 'RESTOCK', 'QUARANTINE-CAMBRIDGE', 'RXT2'].map((code) => ({ code, company: 'ACME', threePl: false })),
    extra: { 'map.json': map, 'stock.csv': clean },
    patch: (man) => { const ref = { file: 'stock.csv', sha256: sha256(clean), columnMap: { file: 'map.json', sha256: sha256(map) } }; man.stock = ref; man.products = ref },
  })
  const r = rig()
  r.deps.wmsSkus = async () => ({ ok: true, skus: [] })
  await run(r, args(scratchDir(bases), '--qoblex-export', exportDir, '--vendor-reads-only'))
  for (const id of ['R2', 'R5', 'R14']) assert.equal(line(r, id), `${id} inconclusive COLUMN_MAP_NOT_NATIVE`, id)
})
