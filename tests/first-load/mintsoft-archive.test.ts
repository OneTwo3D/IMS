/**
 * `first-load:mintsoft-archive`: the dry-run planner for archiving, in the WMS, every product the owner set to Archived on the lifecycle review sheet.
 * Synthetic data only: the WooCommerce store is the review fixture's local fake and the WMS census is a FAKE reader (no request of any kind); the
 * connector's own census reader is tested over a loopback double in tests/connectors/mintsoft-lifecycle-review-read.test.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { serializeCsv } from '../../lib/first-load/csv.ts'
import { EXIT_CODES } from '../../lib/first-load/spec.ts'
import { runLifecycleReviewCli, type WmsReader } from '../../lib/first-load/lifecycle-review/cli.ts'
import { LIFECYCLE_REVIEW_FILE_NAMES } from '../../lib/first-load/lifecycle-review/generation.ts'
import { MINTSOFT_ARCHIVE_EXIT_CODE_TABLE, runMintsoftArchiveCli, WmsCensusFailed, type WmsCensusReader } from '../../lib/first-load/mintsoft-archive/cli.ts'
import { buildArchivePlan, type WmsCensus } from '../../lib/first-load/mintsoft-archive/plan.ts'
import type { CatalogueEntry } from '../../lib/first-load/transform.ts'
import { buildFixture, fakeWms, type Fixture } from './lifecycle-review-fixture.ts'

let fx: Fixture
let sheetDir: string
before(async () => {
  fx = await buildFixture()
  sheetDir = fx.fresh('review')
  const wms: WmsReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async () => fakeWms() }
  let stderr = ''
  const code = await runLifecycleReviewCli(['--manifest', fx.manifestPath, '--out', sheetDir, '--mintsoft-env-file', '/only/for/the/fake'], { stdout: () => {}, stderr: (s) => (stderr += s) }, { wms })
  assert.equal(code, EXIT_CODES.OK, stderr)
})
after(() => fx.cleanup())

const sheetId = () => JSON.parse(readFileSync(path.join(sheetDir, LIFECYCLE_REVIEW_FILE_NAMES.generation), 'utf8')).sheetId as string
/** Every decidable review row, decided (the review fixture's five), as a canonical lifecycle-decisions file, and a manifest naming it. */
function manifestWith(decisions: Record<string, [string, string?]>): string {
  const base: Record<string, [string, string?]> = { 'NEW-1': ['Active'], 'NEW-ARCH': ['Discontinued'], 'SIM-DRAFT': ['Active'], 'SIM-PRIV': ['Do not sell yet'], 'VAR-02': ['Active'], ...decisions }
  const file = `${fx.fresh('decisions')}.csv`
  writeFileSync(file, serializeCsv(['sku', 'status', 'reason', 'sheetId'], Object.entries(base).map(([sku, [status, reason = '']]) => [sku, status, reason, sheetId()])))
  return fx.writeManifest((m) => {
    m.lifecycleReview = { generation: path.join(sheetDir, LIFECYCLE_REVIEW_FILE_NAMES.generation) }
    ;(m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file })
  })
}
const ALL_ARCHIVED: Record<string, [string, string?]> = {
  'NEW-1': ['Archived'], 'NEW-ARCH': ['Archived', 'synthetic write-off'], 'SIM-DRAFT': ['Archived'], 'SIM-PRIV': ['Archived'], 'VAR-02': ['Archived', 'synthetic write-off'],
}

/** The WMS as a fake census: each Archived SKU in another state. */
function census(change?: (c: { products: Array<WmsCensus['products'][number]>; physical: Map<string, number> }) => void): WmsCensus {
  const products: Array<WmsCensus['products'][number]> = [
    { sku: 'SIM-PRIV', productId: '13', bundle: false, status: 'active' },
    { sku: 'SIM-DRAFT', productId: '12', bundle: false, status: 'discontinued' },
    { sku: 'NEW-ARCH', productId: '14', bundle: false, status: 'active' },
    { sku: 'OLD-1', productId: '15', bundle: false, status: 'active' },
    { sku: 'VAR-02', productId: '17', bundle: true, status: 'active' },
  ]
  const physical = new Map([['NEW-ARCH', 3], ['SIM-DRAFT', 2]])
  change?.({ products, physical })
  return { products, physical, warehouses: ['5'] }
}
function reader(c: WmsCensus | (() => never) = census(), calls: string[] = []): WmsCensusReader {
  return { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async (file) => { calls.push(file); return typeof c === 'function' ? c() : c } }
}
async function run(args: string[], r = reader()): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runMintsoftArchiveCli(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, r)
  return { code, stdout, stderr }
}
const ENV = ['--mintsoft-env-file', '/only/for/the/fake']
const rowOf = (stdout: string, sku: string) => stdout.split('\n').find((l) => l.trimStart().startsWith(`${sku} `))?.trim().split(/\s+/)

test('the dry run lists every Archived SKU with the Mintsoft product id, the current DisCont and the stock, and why each would or would not change', async () => {
  const calls: string[] = []
  const r = await run(['--manifest', manifestWith(ALL_ARCHIVED), ...ENV], reader(census(), calls))
  assert.equal(r.code, EXIT_CODES.BLOCKING_FINDINGS, r.stderr)
  assert.deepEqual(calls, ['/only/for/the/fake'], 'the census is read once, from the named file')
  assert.match(r.stdout, /DRY RUN: nothing was written/)
  assert.deepEqual(rowOf(r.stdout, 'SIM-PRIV')!.slice(0, 5), ['SIM-PRIV', 'WOULD_ARCHIVE', '13', 'false', '0'])
  assert.deepEqual(rowOf(r.stdout, 'SIM-DRAFT')!.slice(0, 5), ['SIM-DRAFT', 'SKIP_ALREADY_DISCONTINUED', '12', 'true', '2'])
  assert.deepEqual(rowOf(r.stdout, 'NEW-ARCH')!.slice(0, 5), ['NEW-ARCH', 'REFUSED_STOCK', '14', 'false', '3'])
  assert.deepEqual(rowOf(r.stdout, 'VAR-02')!.slice(0, 5), ['VAR-02', 'REFUSED_BUNDLE', '17', 'false', '0'])
  assert.deepEqual(rowOf(r.stdout, 'NEW-1')!.slice(0, 5), ['NEW-1', 'REFUSED_NOT_FOUND', '-', '-', '-'])
  assert.match(r.stdout, /NEW-1 .*Mintsoft still holds the pre-rename SKU "OLD-1": fix the SKU there first/)
  assert.match(r.stdout, /would archive 1; already discontinued 1; not a Mintsoft product 0; refused 3 \(not found 1, bundle 1, no flag 0, stock 1\)/)
  assert.match(r.stdout, /plan token: MSA-[0-9a-f]{16} /)
})

test('only Archived decisions are planned; a plan with nothing refused exits 0; the token is stable and changes with any figure', async () => {
  const manifest = manifestWith({ 'SIM-PRIV': ['Archived'] })
  const a = await run(['--manifest', manifest, ...ENV])
  assert.equal(a.code, EXIT_CODES.OK, a.stderr)
  assert.match(a.stdout, /1 product\(s\) the owner set to Archived/)
  for (const sku of ['NEW-1', 'NEW-ARCH', 'SIM-DRAFT', 'VAR-02']) assert.equal(rowOf(a.stdout, sku), undefined, `${sku} was not decided Archived`)
  const token = (s: string) => /plan token: (MSA-[0-9a-f]{16})/.exec(s)![1]
  const b = await run(['--manifest', manifest, ...ENV])
  assert.equal(token(a.stdout), token(b.stdout), 'the same plan gives the same token')
  const stocked = await run(['--manifest', manifest, ...ENV], reader(census((c) => c.physical.set('SIM-PRIV', 1))))
  assert.equal(stocked.code, EXIT_CODES.BLOCKING_FINDINGS)
  assert.deepEqual(rowOf(stocked.stdout, 'SIM-PRIV')!.slice(0, 5), ['SIM-PRIV', 'REFUSED_STOCK', '13', 'false', '1'], 'stock of 1 refuses (the boundary)')
  assert.notEqual(token(stocked.stdout), token(a.stdout), 'a figure that changed gives another token')
  const unflagged = await run(['--manifest', manifest, ...ENV], reader(census((c) => { c.products[0] = { ...c.products[0], status: 'not stated' } })))
  assert.deepEqual(rowOf(unflagged.stdout, 'SIM-PRIV')!.slice(0, 5), ['SIM-PRIV', 'REFUSED_FLAG_NOT_STATED', '13', '-', '0'])
})

test('--execute is refused before anything is read: the write is not built', async () => {
  const calls: string[] = []
  const r = await run(['--manifest', manifestWith(ALL_ARCHIVED), ...ENV, '--execute'], reader(census(), calls))
  assert.equal(r.code, EXIT_CODES.USAGE)
  assert.match(r.stderr, /--execute is refused: the Mintsoft write is NOT BUILT/)
  assert.deepEqual(calls, [])
  assert.equal(r.stdout, '')
})

test('the plan is refused (exit 3, the census never read) unless the decisions would import: unbound, refused, missing, or no decisions at all', async () => {
  const cases: Array<[string, string, RegExp]> = [
    ['no decisions', fx.manifestPath, /names no lifecycle-decisions input/],
    ['a refused decision (Archived with stock, no reason)', manifestWith({ 'NEW-ARCH': ['Archived'] }), /decision NEW-ARCH refused \(ARCHIVED_WITH_STOCK\)/],
    ['an undecided review row', manifestWith({ 'NEW-1': [''] }), /LIFECYCLE_DECISION_MISSING/],
    ['another sheet id', fx.writeManifest((m) => {
      const file = `${fx.fresh('decisions')}.csv`
      writeFileSync(file, serializeCsv(['sku', 'status', 'reason', 'sheetId'], [['SIM-PRIV', 'Archived', '', 'LR-0000000000000000']]))
      m.lifecycleReview = { generation: path.join(sheetDir, LIFECYCLE_REVIEW_FILE_NAMES.generation) }
      ;(m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file })
    }), /LIFECYCLE_DECISIONS_NOT_BOUND/],
  ]
  for (const [label, manifest, why] of cases) {
    const calls: string[] = []
    const r = await run(['--manifest', manifest, ...ENV], reader(census(), calls))
    assert.equal(r.code, EXIT_CODES.INPUT_UNUSABLE, `${label}: ${r.stderr}`)
    assert.match(r.stderr, why, label)
    assert.deepEqual(calls, [], `${label}: nothing requested`)
  }
  const failing = await run(['--manifest', manifestWith(ALL_ARCHIVED), ...ENV], reader(() => { throw new WmsCensusFailed('the product list page 1 could not be read') }))
  assert.equal(failing.code, EXIT_CODES.INPUT_UNUSABLE)
  assert.match(failing.stderr, /Mintsoft: the product list page 1 could not be read/)
})

test('usage: --manifest and the credentials file are required, an unknown option names no credential, --help prints the exit codes', async () => {
  assert.equal((await run(['--manifest', fx.manifestPath])).code, EXIT_CODES.USAGE)
  assert.equal((await run([...ENV])).code, EXIT_CODES.USAGE)
  const unknown = await run(['--manifest', fx.manifestPath, ...ENV, '--api-key', 'ms_secret_value'])
  assert.equal(unknown.code, EXIT_CODES.USAGE)
  assert.ok(!unknown.stderr.includes('ms_secret_value'))
  const help = await run(['--help'])
  assert.equal(help.code, EXIT_CODES.OK)
  for (const row of MINTSOFT_ARCHIVE_EXIT_CODE_TABLE) assert.ok(help.stdout.includes(`  ${row.code}  ${row.name}: `), row.name)
})

test('the plan: a VARIABLE parent and a NON_INVENTORY product the WMS does not hold are skipped; a case-only near match is named, never matched; non-decision ARCHIVED is not planned', () => {
  const entry = (sku: string, type: CatalogueEntry['type'], lifecycleSource: CatalogueEntry['lifecycleSource'] = 'decision'): CatalogueEntry => ({ sku, name: sku, type, parentSku: '', lifecycle: 'ARCHIVED', lifecycleSource })
  const plan = buildArchivePlan({
    sheetId: 'LR-0123456789abcdef',
    catalogue: [entry('PARENT', 'VARIABLE'), entry('SERVICE', 'NON_INVENTORY'), entry('mug-1', 'SIMPLE'), entry('FROM-QOBLEX', 'SIMPLE', 'qoblex'), entry('FROM-WOO', 'SIMPLE', 'woo')],
    skuRenames: [],
    census: { products: [{ sku: 'MUG-1 ', productId: '9', bundle: false, status: 'active' }, { sku: 'FROM-QOBLEX', productId: '10', bundle: false, status: 'active' }], physical: new Map(), warehouses: ['5'] },
    wmsLabel: 'WMS',
  })
  assert.deepEqual(plan.rows.map((r) => [r.sku, r.outcome]), [['PARENT', 'SKIP_NOT_A_WMS_PRODUCT'], ['SERVICE', 'SKIP_NOT_A_WMS_PRODUCT'], ['mug-1', 'REFUSED_NOT_FOUND']])
  assert.match(plan.rows[2].reason, /WMS holds "MUG-1 ", which differs only in letter case or whitespace \(never matched\)/)
  assert.match(plan.token, /^MSA-[0-9a-f]{16}$/)
  assert.equal(plan.token, `MSA-${plan.digest.slice(0, 16)}`)
})

test('the document states exactly the planner\'s exit codes', () => {
  const doc = readFileSync(path.join(process.cwd(), 'docs/first-load-input-spec.md'), 'utf8')
  const start = doc.indexOf('### Mintsoft archive exit codes')
  assert.ok(start >= 0, 'the section exists')
  const section = doc.slice(start, doc.indexOf('\n## ', start) < 0 ? undefined : doc.indexOf('\n## ', start))
  const rows = section.split('\n').filter((l) => /^\| \d/.test(l)).map((l) => l.split('|').slice(1, 3).map((c) => c.trim()))
  assert.deepEqual(rows, MINTSOFT_ARCHIVE_EXIT_CODE_TABLE.map((r) => [String(r.code), r.name]))
})
