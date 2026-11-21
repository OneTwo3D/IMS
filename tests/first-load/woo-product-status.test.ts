/**
 * Every WooCommerce product's OWN status, from the read-only snapshot, into the first load's lifecycle (o3d-hwu72):
 *   - the walk reads ALL products (any type, every status) with their status, SKU, id, name, type and stock quantity, GET only, 100 to a page;
 *   - the snapshot carries them, the proof's per-status totals cover all product types, and the operator's visibility attestation must match them;
 *   - `woo-product-status.csv` is bound to the verified snapshot exactly like variant-parents.csv (byte-identical regeneration, sha in provenance, refused
 *     when stale or unbound, a clear message for a format-1 snapshot);
 *   - first-load:prepare takes the lifecycle of a simple/KIT/BOM product from it (private/draft/pending -> DRAFT, publish -> ACTIVE, a Qoblex EOL stays EOL),
 *     and LIFECYCLE_NOT_FROM_WOO fires only for a product WooCommerce does not hold;
 *   - L1: a joined variation's own status beats a woo-products / woo-product-status row for its SKU; L2: a SKU repeated with conflicting statuses is refused.
 * The store is a local fake on 127.0.0.1 (nothing leaves loopback); every datum is synthetic. Mutations are listed in the PR.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { runCli as runPrepare } from '../../lib/first-load/cli.ts'
import { EXIT_CODES, SNAPSHOT_EXIT_CODES, SNAPSHOT_FILE_NAMES } from '../../lib/first-load/spec.ts'
import { parseSnapshotFile, renderProductStatusCsv, sha256Hex } from '../../lib/first-load/snapshot.ts'
import { runSnapshotCli } from '../../lib/first-load/woo-snapshot/cli.ts'
import { startFakeCatalogue, type FakeCatalogue, type FakeParent, type FakeProduct } from '../helpers/fake-woocommerce-catalogue.ts'
import { ds, findingCodes, precondition, product, rowsOf, run, runBare } from './helpers.ts'

const KEY = 'ck_test_readonly_key_0000'
const SECRET = 'cs_test_readonly_secret_1111'
const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-product-status-'))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)
const savedEnv = process.env.E2E_TEST_MODE
before(() => { process.env.E2E_TEST_MODE = '1' })
after(() => {
  if (savedEnv === undefined) delete process.env.E2E_TEST_MODE
  else process.env.E2E_TEST_MODE = savedEnv
  rmSync(scratch, { recursive: true, force: true })
})

const PARENTS: FakeParent[] = [
  { id: 100, sku: 'VAR-PARENT', name: 'Variable parent', status: 'publish', variations: [{ id: 1001, sku: 'VAR-01' }, { id: 1002, sku: 'VAR-02', status: 'private' }] },
]
/** Every other top-level product: simples in each status, a grouped and an external product, one without a SKU, one that manages stock. */
const OTHERS: FakeProduct[] = [
  { id: 201, sku: 'SIM-PUB', name: 'Simple published', status: 'publish', manage_stock: true, stock_quantity: 7 },
  { id: 202, sku: 'SIM-PRIV', name: 'Simple private', status: 'private' },
  { id: 203, sku: 'SIM-DRAFT', name: 'Simple draft', status: 'draft', manage_stock: true, stock_quantity: 0 },
  { id: 204, sku: 'SIM-PEND', name: 'Simple pending', status: 'pending' },
  { id: 205, sku: 'GRP-1', name: 'Grouped', type: 'grouped', status: 'publish' },
  { id: 206, sku: 'EXT-1', name: 'External', type: 'external', status: 'draft' },
  { id: 207, sku: '', name: 'No SKU yet', status: 'draft' },
  { id: 208, sku: 'SIM-EOL', name: 'Simple that Qoblex calls inactive', status: 'publish', manage_stock: true, stock_quantity: 3 },
]
/** What the shop admin shows: 1 variable + 8 others. */
const ALL_PRODUCTS = { publish: 4, draft: 3, private: 1, pending: 1 }
const ATTESTED = { allProducts: ALL_PRODUCTS, products: { publish: 1, draft: 0, private: 0, pending: 0 }, variations: { publish: 1, draft: 0, private: 1, pending: 0 } }

const origins = new Map<string, string>()
async function bundle(opts: { others?: FakeProduct[]; pageSizeCap?: number; into?: { server?: FakeCatalogue } } = {}): Promise<{ dir: string; origin: string; requests: FakeCatalogue['requests'] }> {
  const server = await startFakeCatalogue({ key: KEY, secret: SECRET, parents: PARENTS, products: opts.others ?? OTHERS, pageSizeCap: opts.pageSizeCap })
  try {
    const envFile = fresh('creds')
    writeFileSync(envFile, `FIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    const out = fresh('bundle')
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', envFile, '--out', out, '--allow-origin', server.origin, '--min-interval-ms', '0'], { stdout: () => {}, stderr: (s) => (stderr += s) })
    assert.equal(code, SNAPSHOT_EXIT_CODES.OK, stderr)
    origins.set(out, server.origin)
    return { dir: out, origin: server.origin, requests: [...server.requests] }
  } finally { await server.close() }
}
const file = (dir: string, name: string) => path.join(dir, name)
const copy = (from: string) => { const to = fresh('copy'); cpSync(from, to, { recursive: true }); origins.set(to, origins.get(from)!); return to }
const edit = (target: string, change: (text: string) => string) => {
  const before = readFileSync(target, 'utf8')
  const after = change(before)
  assert.notEqual(after, before, 'the tampering changed nothing')
  writeFileSync(target, after)
}

async function verify(dir: string, visibility: unknown = ATTESTED): Promise<{ code: number; stdout: string; stderr: string }> {
  const attest = fresh('attest.json')
  writeFileSync(attest, JSON.stringify(visibility))
  let stdout = ''
  let stderr = ''
  const code = await runSnapshotCli(['--verify', file(dir, SNAPSHOT_FILE_NAMES.snapshot), '--expect-origin', origins.get(dir)!, '--expect-visibility', attest], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

interface Finding { code: string; severity: string; message: string }
interface ReportShape { findings: Finding[]; wooProductStatus: { supplied: boolean; bound: boolean; rowsRead: number; productsMatched: number }; accountingByCode: Array<{ dataset: string; outcome: string; code: string; count: number }> }

/** first-load:prepare over Qoblex products for the bundle's SKUs, with the CSV listed from `csvFrom`. */
async function prepareWith(opts: { snapshotDir: string; csvFrom: string; qoblex?: string; wooSnapshot?: boolean }): Promise<{ code: number; stderr: string; out: string; report: ReportShape }> {
  const dir = fresh('prepare')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'products.csv'), opts.qoblex ?? 'sku,name,type,lifecycleStatus\nSIM-PUB,Pub,SIMPLE,ARCHIVED\nSIM-PRIV,Priv,SIMPLE,ACTIVE\nSIM-DRAFT,Draft,SIMPLE,ACTIVE\nSIM-PEND,Pend,SIMPLE,ACTIVE\nSIM-EOL,Eol,SIMPLE,EOL\nQ-ONLY,Only in Qoblex,SIMPLE,ACTIVE\n')
  cpSync(file(opts.csvFrom, SNAPSHOT_FILE_NAMES.productStatus), path.join(dir, 'woo-product-status.csv'))
  const manifest: Record<string, unknown> = { formatVersion: 1, baseCurrency: 'GBP', inputs: [{ dataset: 'products', file: 'products.csv' }, { dataset: 'woo-product-status', file: 'woo-product-status.csv' }] }
  if (opts.wooSnapshot !== false) manifest.wooSnapshot = { snapshot: file(opts.snapshotDir, SNAPSHOT_FILE_NAMES.snapshot), provenance: file(opts.snapshotDir, SNAPSHOT_FILE_NAMES.provenance), origin: origins.get(opts.snapshotDir), visibilityChecked: ATTESTED }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  let stderr = ''
  const out = fresh('prepared')
  const code = await runPrepare(['--manifest', path.join(dir, 'manifest.json'), '--out', out], { stdout: () => {}, stderr: (s) => (stderr += s) })
  let report: ReportShape = { findings: [], wooProductStatus: { supplied: false, bound: false, rowsRead: 0, productsMatched: 0 }, accountingByCode: [] }
  try { report = JSON.parse(readFileSync(path.join(out, 'validation-report.json'), 'utf8')) } catch { /* nothing written */ }
  return { code, stderr, out, report }
}
const emittedIn = (report: ReportShape, dataset: string, code: string): number => report.accountingByCode.filter((a) => a.dataset === dataset && a.outcome === 'EMITTED' && a.code === code).reduce((n, a) => n + a.count, 0)
const productsOut = (out: string): Map<string, string> => {
  const name = readdirSync(out).find((n) => /products-\d+-of-\d+\.csv$/.test(n))
  const map = new Map<string, string>()
  if (!name) return map
  const lines = readFileSync(path.join(out, name), 'utf8').split('\r\n').filter(Boolean)
  const header = lines[0].split(',')
  const sku = header.indexOf('sku')
  const lifecycle = header.indexOf('lifecycleStatus')
  for (const line of lines.slice(1)) { const cells = line.split(','); map.set(cells[sku], cells[lifecycle]) }
  return map
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The walk and the snapshot
// ---------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: the walk keeps asking for type=variable only (the products list is not all products)]
test('the walk reads EVERY product of every type and status with its stock, 100 to a page, GET only, and the proof counts all of them', async (t) => {
  const b = await bundle({ pageSizeCap: 3 })
  const parsed = parseSnapshotFile(readFileSync(file(b.dir, SNAPSHOT_FILE_NAMES.snapshot), 'utf8'))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  precondition(t, 'products in the snapshot', parsed.payload.products.length)
  assert.equal(parsed.payload.products.length, 9, 'one variable product and eight others')
  assert.deepEqual(parsed.payload.products.map((p) => p.type).filter((x, i, a) => a.indexOf(x) === i).sort(), ['external', 'grouped', 'simple', 'variable'])
  assert.deepEqual(parsed.payload.products.find((p) => p.id === 201), { id: 201, sku: 'SIM-PUB', name: 'Simple published', type: 'simple', status: 'publish', manageStock: true, stockQuantity: 7 })
  assert.deepEqual(parsed.payload.products.find((p) => p.id === 202), { id: 202, sku: 'SIM-PRIV', name: 'Simple private', type: 'simple', status: 'private', manageStock: false, stockQuantity: null })
  assert.equal(parsed.payload.products.find((p) => p.id === 203)?.stockQuantity, 0, 'a managed zero is zero, not unknown')
  assert.deepEqual(['draft', 'pending', 'private', 'publish'].map((s) => parsed.payload.products.filter((p) => p.status === s).length), [3, 1, 1, 4])
  // the dataset: a row per product WITH a SKU, the variable parent included, the one without a SKU only counted
  const csv = readFileSync(file(b.dir, SNAPSHOT_FILE_NAMES.productStatus), 'utf8')
  assert.equal(csv, renderProductStatusCsv(parsed.payload))
  assert.equal(csv.split('\r\n').filter(Boolean).length, 1 + 8)
  assert.match(csv, /SIM-PUB,201,simple,publish,7,Simple published/)
  assert.match(csv, /SIM-PRIV,202,simple,private,,Simple private/)
  assert.match(csv, /VAR-PARENT,100,variable,publish,,Variable parent/)
  const provenance = JSON.parse(readFileSync(file(b.dir, SNAPSHOT_FILE_NAMES.provenance), 'utf8'))
  assert.deepEqual(provenance.proof.allProducts.statusTotals, ALL_PRODUCTS)
  assert.equal(provenance.proof.allProducts.rowsRead, provenance.proof.allProducts.totalHeader)
  assert.equal(provenance.proof.allProducts.withoutSku, 1)
  assert.deepEqual(provenance.proof.allProducts.byType, { external: 1, grouped: 1, simple: 6, variable: 1 })
  assert.equal(provenance.productStatusFile.sha256, sha256Hex(csv))
  assert.equal(provenance.productStatusFile.rows, 8)
  assert.equal(provenance.formatVersion, 2)
  // GET only, every walk page asks for 100 (the store grants 3 here, so the walk pages)
  assert.ok(b.requests.every((q) => q.method === 'GET'))
  const walkPages = b.requests.filter((q) => q.path.endsWith('/products') && q.query.status === 'any' && q.query.type === undefined)
  precondition(t, 'all-product walk pages (two walks)', walkPages.length)
  assert.ok(walkPages.every((q) => q.query.per_page === '100'), 'per_page=100')
  assert.equal(walkPages.length, 2 * 3, 'nine products at 3 a page is 3 pages, walked twice (the verifying walk)')
  assert.ok(!b.requests.some((q) => /\/products\/\d+$/.test(q.path)), 'no per-product request: every status and stock figure came from the list')
})

// [mutation: the attestation's allProducts counts are not compared with the proof]
test('the visibility attestation must match the all-products counts too, and allProducts is a required key', async (t) => {
  const b = await bundle()
  const ok = await verify(b.dir)
  precondition(t, 'honest verify exit', ok.code === 0 ? 1 : 0)
  assert.equal(ok.code, SNAPSHOT_EXIT_CODES.OK, ok.stderr)
  assert.match(ok.stdout, /9 product\(s\) of any type \(1 variable\)/)
  // the key sees less than the shop holds for SIMPLE products: only the all-products count differs
  const less = await verify(b.dir, { ...ATTESTED, allProducts: { ...ALL_PRODUCTS, draft: 5 } })
  assert.equal(less.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(less.stderr, /different products of every type than the shop's admin counts attested \(draft: snapshot saw 3, attested 5\)/)
  const old: Record<string, unknown> = { ...ATTESTED }
  delete old.allProducts
  assert.equal((await verify(b.dir, old)).code, SNAPSHOT_EXIT_CODES.USAGE, 'an attestation without allProducts is refused')
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: the woo-product-status byte comparison, or the provenance hash check, is dropped]
test('woo-product-status.csv is bound to the verified snapshot: an edited file, a forged hash, a file of another snapshot and a missing file are refused', async (t) => {
  const b = await bundle()
  const other = await bundle({ others: OTHERS.filter((p) => p.id !== 202) })
  precondition(t, 'honest control exit', (await verify(b.dir)).code === 0 ? 1 : 0)
  // edited bytes
  const edited = copy(b.dir)
  edit(file(edited, SNAPSHOT_FILE_NAMES.productStatus), (text) => text.replace('SIM-PRIV,202,simple,private', 'SIM-PRIV,202,simple,publish'))
  const e = await verify(edited)
  assert.equal(e.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(e.stderr, /woo-product-status\.csv .*is not the file the provenance recorded/)
  assert.match(e.stderr, /woo-product-status\.csv is not the rows regenerated from the verified snapshot/)
  // the byte comparison alone: the hash in the provenance is forged to match the edited file
  const forged = copy(edited)
  const provenancePath = file(forged, SNAPSHOT_FILE_NAMES.provenance)
  edit(provenancePath, (text) => { const p = JSON.parse(text); p.productStatusFile.sha256 = sha256Hex(readFileSync(file(forged, SNAPSHOT_FILE_NAMES.productStatus))); return `${JSON.stringify(p, null, 2)}\n` })
  const f = await verify(forged)
  assert.equal(f.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.ok(!/is not the file the provenance recorded/.test(f.stderr), 'the hash was forged, so only the byte comparison can refuse')
  assert.match(f.stderr, /woo-product-status\.csv is not the rows regenerated from the verified snapshot/)
  // the CSV of another snapshot
  const foreign = copy(b.dir)
  cpSync(file(other.dir, SNAPSHOT_FILE_NAMES.productStatus), file(foreign, SNAPSHOT_FILE_NAMES.productStatus))
  assert.equal((await verify(foreign)).code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  // a provenance that does not record the file
  const unrecorded = copy(b.dir)
  edit(file(unrecorded, SNAPSHOT_FILE_NAMES.provenance), (text) => { const p = JSON.parse(text); delete p.productStatusFile; return `${JSON.stringify(p, null, 2)}\n` })
  assert.match((await verify(unrecorded)).stderr, /does not record a SHA-256 for woo-product-status\.csv/)
  // a missing file
  const missing = copy(b.dir)
  rmSync(file(missing, SNAPSHOT_FILE_NAMES.productStatus))
  assert.match((await verify(missing)).stderr, /woo-product-status\.csv could not be read/)
})

// [mutation: a version-1 snapshot is accepted, or its message is the bare "formatVersion must be 2"]
test('an old (format 1) snapshot is refused with a message that says it predates the all-products status', async (t) => {
  const b = await bundle()
  const old = copy(b.dir)
  edit(file(old, SNAPSHOT_FILE_NAMES.snapshot), (text) => text.replace('"formatVersion": 2', '"formatVersion": 1'))
  const v = await verify(old)
  precondition(t, 'old snapshot exit', v.code)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(v.stderr, /the snapshot is format 1: it was taken before every product's own status and stock were read/)
  assert.match(v.stderr, /Re-run first-load:woo-snapshot/)
  // an old provenance beside a new snapshot says so as well
  const oldProv = copy(b.dir)
  edit(file(oldProv, SNAPSHOT_FILE_NAMES.provenance), (text) => text.replace('"formatVersion": 2', '"formatVersion": 1'))
  assert.match((await verify(oldProv)).stderr, /the provenance is format 1, not 2/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// first-load:prepare with a real bundle
// ---------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: simple products keep the Qoblex lifecycle, or publish no longer keeps an EOL]
test('prepare takes the lifecycle of simple products from the bound snapshot: private/draft/pending -> DRAFT, publish -> ACTIVE, a Qoblex EOL stays EOL; only a product Woo does not hold is warned about', async (t) => {
  const b = await bundle()
  const ran = await prepareWith({ snapshotDir: b.dir, csvFrom: b.dir })
  assert.equal(ran.code, EXIT_CODES.OK, ran.stderr)
  const lifecycle = productsOut(ran.out)
  precondition(t, 'products written', lifecycle.size)
  assert.equal(lifecycle.get('SIM-PUB'), 'ACTIVE', 'Qoblex ARCHIVED, Woo publish: Woo is gospel')
  assert.equal(lifecycle.get('SIM-PRIV'), 'DRAFT')
  assert.equal(lifecycle.get('SIM-DRAFT'), 'DRAFT')
  assert.equal(lifecycle.get('SIM-PEND'), 'DRAFT')
  assert.equal(lifecycle.get('SIM-EOL'), 'EOL', 'Woo publish does not revive a Qoblex EOL')
  assert.equal(lifecycle.get('Q-ONLY'), 'ACTIVE', 'absent from Woo: the Qoblex lifecycle')
  const warning = ran.report.findings.find((f) => f.code === 'LIFECYCLE_NOT_FROM_WOO')
  assert.match(warning?.message ?? '', /^1 simple, KIT or BOM product\(s\) keep the lifecycle derived from the Qoblex State: WooCommerce has no product with that SKU/)
  assert.deepEqual(ran.report.wooProductStatus, { supplied: true, bound: true, rowsRead: 8, productsMatched: 5 })
  // every row reported
  assert.equal(emittedIn(ran.report, 'woo-product-status', 'WOO_STATUS_ROW'), 8)
})

// [mutation: the binding is not required for woo-product-status]
test('prepare refuses woo-product-status that is unbound, stale, edited or from another snapshot: no lifecycle is taken and the run is blocked', async (t) => {
  const b = await bundle()
  const honest = await prepareWith({ snapshotDir: b.dir, csvFrom: b.dir })
  precondition(t, 'honest control took a lifecycle', productsOut(honest.out).get('SIM-PRIV') === 'DRAFT' ? 1 : 0)
  const edited = copy(b.dir)
  edit(file(edited, SNAPSHOT_FILE_NAMES.productStatus), (text) => text.replace('SIM-PRIV,202,simple,private', 'SIM-PRIV,202,simple,publish'))
  const stale = copy(b.dir)
  const other = await bundle({ others: OTHERS.filter((p) => p.id !== 202) })
  cpSync(file(other.dir, SNAPSHOT_FILE_NAMES.productStatus), file(stale, SNAPSHOT_FILE_NAMES.productStatus))
  const arms: Array<[string, Awaited<ReturnType<typeof prepareWith>>, RegExp]> = [
    ['no wooSnapshot in the manifest', await prepareWith({ snapshotDir: b.dir, csvFrom: b.dir, wooSnapshot: false }), /does not name wooSnapshot/],
    ['edited csv', await prepareWith({ snapshotDir: b.dir, csvFrom: edited }), /not the file the provenance recorded|not the rows regenerated/],
    ['csv of another snapshot', await prepareWith({ snapshotDir: b.dir, csvFrom: stale }), /not the file the provenance recorded|not the rows regenerated/],
  ]
  for (const [label, ran, pattern] of arms) {
    assert.equal(ran.code, EXIT_CODES.BLOCKING_FINDINGS, `${label}: ${ran.stderr}`)
    const finding = ran.report.findings.find((f) => f.code === 'PRODUCT_STATUS_NOT_BOUND')
    assert.equal(finding?.severity, 'ERROR', label)
    assert.match(finding?.message ?? '', pattern, label)
    assert.equal(ran.report.wooProductStatus.bound, false, label)
    assert.equal(productsOut(ran.out).size, 0, `${label}: nothing was written`)
    assert.equal(emittedIn(ran.report, 'woo-product-status', 'WOO_STATUS_ROW'), 0, label)
    assert.equal(ran.report.accountingByCode.filter((a) => a.dataset === 'woo-product-status' && a.code === 'NOT_BOUND_TO_SNAPSHOT').reduce((n, a) => n + a.count, 0), ran.report.wooProductStatus.rowsRead, `${label}: every row is reported as excluded`)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The transform: precedence (L1), conflicts (L2)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const vp = (variant: string, parent: string, parentStatus: string, variationStatus: string) => ({ variantSku: variant, wooVariationId: '1001', parentSku: parent, parentName: `Parent ${parent}`, parentStatus, wooParentId: '5001', variationStatus })
const lifecycleOf = (r: ReturnType<typeof run>, sku: string): string => rowsOf(r, 'products').find((row) => row.sku === sku)?.lifecycleStatus ?? '(no row)'

// [mutation: the simple/KIT/BOM loop no longer skips a product that has a parentSku, so a woo-product-status row overrides the variation's own status]
test('L1 precedence: a joined KIT variation takes its OWN variationStatus (private -> DRAFT) over a woo-products or woo-product-status row that says publish', (t) => {
  for (const dataset of ['woo-products', 'woo-product-status'] as const) {
    const r = run({
      products: ds('products', [product('C1', 'SIMPLE'), product('K-01', 'KIT', { lifecycleStatus: 'ACTIVE' })]),
      'recipe-lines': ds('recipe-lines', [{ parentSku: 'K-01', componentSku: 'C1', qty: '1' }]),
      'variant-parents': ds('variant-parents', [vp('K-01', 'K', 'publish', 'private')]),
      [dataset]: ds(dataset, [{ sku: 'K-01', status: 'publish' }]),
    })
    precondition(t, `${dataset}: variation joined`, r.report.accountingByCode.filter((a) => a.dataset === 'variant-parents' && a.code === 'VARIATION_JOINED').reduce((n, a) => n + a.count, 0))
    assert.equal(r.blocking, false, JSON.stringify(r.report.findings.filter((f) => f.severity === 'ERROR')))
    assert.equal(lifecycleOf(r, 'K-01'), 'DRAFT', dataset)
    // and the other way round: variation publish beats a private row
    const back = run({
      products: ds('products', [product('C1', 'SIMPLE'), product('K-01', 'KIT', { lifecycleStatus: 'ACTIVE' })]),
      'recipe-lines': ds('recipe-lines', [{ parentSku: 'K-01', componentSku: 'C1', qty: '1' }]),
      'variant-parents': ds('variant-parents', [vp('K-01', 'K', 'publish', 'publish')]),
      [dataset]: ds(dataset, [{ sku: 'K-01', status: 'private' }]),
    })
    assert.equal(lifecycleOf(back, 'K-01'), 'ACTIVE', `${dataset}, reversed`)
  }
})

// [mutation: the last row wins again (no conflict check), or a repeat with the SAME status is refused]
test('L2: a SKU repeated with conflicting statuses is refused (blocking, none taken); a repeat with the same status is fine', (t) => {
  for (const dataset of ['woo-products', 'woo-product-status'] as const) {
    const base = { products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'ACTIVE' }), product('S-2', 'SIMPLE', { lifecycleStatus: 'ACTIVE' })]) }
    const r = run({ ...base, [dataset]: ds(dataset, [{ sku: 'S-1', status: 'publish' }, { sku: 's-1', status: 'private' }, { sku: 'S-2', status: 'private' }, { sku: 'S-2', status: 'private' }]) })
    precondition(t, `${dataset}: findings`, r.report.findings.length)
    const conflict = r.report.findings.find((f) => f.code === 'LIFECYCLE_WOO_STATUS_CONFLICT')
    assert.equal(conflict?.severity, 'ERROR', dataset)
    assert.ok(conflict?.message.includes('S-1: private / publish'), conflict?.message)
    assert.ok(!conflict?.message.includes('S-2'), 'the repeat with the same status is not a conflict')
    assert.equal(r.blocking, true)
    assert.equal(lifecycleOf(r, 'S-1'), '(no row)', 'a blocked run writes nothing')
    // the lifecycle the refused SKU would have had is not taken: it is in no LIFECYCLE_TAKEN_FROM_WOO
    assert.ok(!r.report.findings.some((f) => f.code === 'LIFECYCLE_TAKEN_FROM_WOO' && f.keys?.includes('S-1')), dataset)
    assert.ok(r.report.findings.some((f) => f.code === 'LIFECYCLE_TAKEN_FROM_WOO' && f.keys?.includes('S-2')), `${dataset}: the non-conflicting SKU is still taken`)
    // L4: a conflicted SKU is refused, not reported as absent from WooCommerce
    assert.ok(!r.report.findings.find((f) => f.code === 'LIFECYCLE_NOT_FROM_WOO')?.keys?.includes('S-1'), `${dataset}: the conflicted SKU is not listed as absent`)
  }
})

// [mutation: woo-products wins over the bound snapshot, or the old behaviour (NOT_FROM_WOO only when no status at all) returns]
test('the bound woo-product-status wins over a woo-products row; LIFECYCLE_NOT_FROM_WOO lists exactly the SKUs neither dataset holds', () => {
  const r = run({
    products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'ACTIVE' }), product('S-2', 'SIMPLE', { lifecycleStatus: 'ARCHIVED' }), product('S-3', 'SIMPLE')]),
    'woo-products': ds('woo-products', [{ sku: 'S-1', status: 'publish' }, { sku: 'S-2', status: 'publish' }]),
    'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'draft' }]),
  })
  assert.equal(lifecycleOf(r, 'S-1'), 'DRAFT')
  assert.equal(lifecycleOf(r, 'S-2'), 'ACTIVE')
  const warning = r.report.findings.find((f) => f.code === 'LIFECYCLE_NOT_FROM_WOO')
  assert.deepEqual(warning?.keys, ['S-3'])
  assert.deepEqual(findingCodes(r, 'ERROR'), [])
})

// [mutation: conflicts are decided per dataset before the merge, so a woo-products conflict beats the snapshot's status or blocks for a non-catalogue SKU]
test('M2: the conflict is decided after merging: ignored when the bound snapshot has the SKU, a WARNING for a SKU that is no catalogue simple/KIT/BOM, an ERROR only for a product left without a status', () => {
  const dup = (sku: string) => [{ sku, status: 'publish' }, { sku, status: 'private' }]
  const covered = run({
    products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'ACTIVE' })]),
    'woo-products': ds('woo-products', dup('S-1')),
    'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'draft' }]),
  })
  assert.deepEqual(findingCodes(covered).filter((c) => c.startsWith('LIFECYCLE_WOO_STATUS_CONFLICT')), [], 'the snapshot states the SKU: no conflict')
  assert.equal(lifecycleOf(covered, 'S-1'), 'DRAFT', "the snapshot's status is not discarded")
  assert.equal(covered.blocking, false)
  const unused = run({
    products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'ACTIVE' }), product('P-01', 'VARIANT'), product('X-1', 'SIMPLE')]),
    'variant-parents': ds('variant-parents', [vp('P-01', 'P', 'publish', 'publish')]),
    'woo-products': ds('woo-products', [...dup('P-01'), { sku: 'S-1', status: 'publish' }, { sku: 'X-1', status: 'publish' }]),
  })
  const warn = unused.report.findings.find((f) => f.code === 'LIFECYCLE_WOO_STATUS_CONFLICT_UNUSED')
  assert.equal(warn?.severity, 'WARNING')
  assert.deepEqual(warn?.keys, ['P-01'])
  assert.ok(!findingCodes(unused, 'ERROR').includes('LIFECYCLE_WOO_STATUS_CONFLICT'))
  assert.equal(unused.blocking, false)
  const blocked = run({ products: ds('products', [product('S-1', 'SIMPLE')]), 'woo-products': ds('woo-products', dup('S-1')) })
  assert.equal(blocked.report.findings.find((f) => f.code === 'LIFECYCLE_WOO_STATUS_CONFLICT')?.severity, 'ERROR')
  assert.equal(blocked.blocking, true)
})

// [mutation: the sha comparison of the bytes read against the bytes verified is dropped in loadProductStatus]
test('M3: prepare refuses woo-product-status whose bytes are not the ones the binding verified, and one with no or an unverified binding', () => {
  const datasets = { products: ds('products', [product('S-1', 'SIMPLE', { lifecycleStatus: 'ACTIVE' })]), 'woo-product-status': ds('woo-product-status', [{ sku: 'S-1', status: 'private' }]) }
  const sha = datasets['woo-product-status'].parts[0].sha256
  const good = runBare(datasets, {}, undefined, { verified: true, csvSha256: sha, snapshotPayloadSha256: 'x' })
  assert.equal(lifecycleOf(good, 'S-1'), 'DRAFT', 'control: the matching binding is accepted')
  const cases: Array<[string, Parameters<typeof runBare>[3], RegExp]> = [
    ['bytes differ from the verified ones', { verified: true, csvSha256: 'b'.repeat(64), snapshotPayloadSha256: 'x' }, /bytes read are not the bytes that were verified/],
    ['binding unverified', { verified: false, problems: ['a problem named by the verifier'] }, /a problem named by the verifier/],
    ['no binding at all', undefined, /no proof was given/],
  ]
  for (const [label, binding, pattern] of cases) {
    const r = runBare(datasets, {}, undefined, binding)
    const finding = r.report.findings.find((f) => f.code === 'PRODUCT_STATUS_NOT_BOUND')
    assert.equal(finding?.severity, 'ERROR', label)
    assert.match(finding?.message ?? '', pattern, label)
    assert.equal(r.blocking, true, label)
    assert.equal(r.report.wooProductStatus.bound, false, label)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// H1: stock moves between the walks
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function walkWith(intercept: NonNullable<Parameters<typeof startFakeCatalogue>[0]['intercept']>): Promise<{ code: number; stderr: string; out: string; rounds: number | null; stock: number | null | undefined }> {
  const server = await startFakeCatalogue({ key: KEY, secret: SECRET, parents: PARENTS, products: OTHERS, intercept })
  try {
    const envFile = fresh('creds')
    writeFileSync(envFile, `FIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    const out = fresh('bundle')
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', envFile, '--out', out, '--allow-origin', server.origin, '--min-interval-ms', '0'], { stdout: () => {}, stderr: (x) => (stderr += x) })
    let rounds: number | null = null
    let stock: number | null | undefined
    if (code === 0) {
      rounds = JSON.parse(readFileSync(file(out, SNAPSHOT_FILE_NAMES.provenance), 'utf8')).verificationRounds
      const parsed = parseSnapshotFile(readFileSync(file(out, SNAPSHOT_FILE_NAMES.snapshot), 'utf8'))
      if (parsed.ok) stock = parsed.payload.products.find((p) => p.id === 201)?.stockQuantity
    }
    return { code, stderr, out, rounds, stock }
  } finally { await server.close() }
}
const mutateRows = (change: (row: Record<string, unknown>) => void) => (c: { probe: boolean; route: string; attempt: number }, res: { status: number; headers: Record<string, string>; body: unknown }) => {
  if (c.probe || c.route !== 'products' || c.attempt % 2 !== 0) return res
  return { ...res, body: (res.body as Array<Record<string, unknown>>).map((row) => { const copy = { ...row }; change(copy); return copy }) }
}

// [mutation: the walks are compared by the full payload hash, stock included]
test('H1: stock that changes between the two walks does not fail the walk; the file keeps the FIRST walk\'s figures', async (t) => {
  const r = await walkWith(mutateRows((row) => { if (row.id === 201) row.stock_quantity = 99; if (row.id === 203) row.manage_stock = false }))
  precondition(t, 'walk exit', r.code === 0 ? 1 : 0)
  assert.equal(r.code, SNAPSHOT_EXIT_CODES.OK, r.stderr)
  assert.equal(r.rounds, 1, 'verified in the first round')
  assert.equal(r.stock, 7, "walk A's stock (7), not walk B's (99)")
})

// [mutation: the stock-free comparison also ignores status]
test('H1: a status change between the two walks still fails the walk (every round differs: nothing is written)', async (t) => {
  const r = await walkWith(mutateRows((row) => { if (row.id === 202) row.status = 'publish' }))
  precondition(t, 'walk exit', r.code)
  assert.equal(r.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, r.stderr)
  assert.match(r.stderr, /two complete walks read different catalogues/)
  assert.equal(existsSync(r.out), false)
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// L3 / L8: the probes and the requested fields
// ---------------------------------------------------------------------------------------------------------------------------------------------------

// [mutation: the all-products probe is dropped, or _fields removes a field the payload uses]
test('L3/L8: every status is asked for by name for ALL products (no type filter) and for the variable ones, with _fields=id; the list asks only for the fields the payload uses', async (t) => {
  const b = await bundle()
  const probes = b.requests.filter((q) => q.path.endsWith('/products') && q.query.status !== 'any' && q.query.status !== undefined)
  precondition(t, 'status probes on /products', probes.length)
  for (const status of ['publish', 'draft', 'private', 'pending']) {
    assert.ok(probes.some((q) => q.query.status === status && q.query.type === undefined && q.query.per_page === '1'), `all-products probe for ${status}`)
    assert.ok(probes.some((q) => q.query.status === status && q.query.type === 'variable' && q.query.per_page === '1'), `variable probe for ${status}`)
  }
  assert.ok(probes.every((q) => q.query._fields === 'id'))
  const lists = b.requests.filter((q) => q.path.endsWith('/products') && q.query.status === 'any')
  precondition(t, 'list pages', lists.length)
  for (const field of ['id', 'sku', 'name', 'type', 'status', 'manage_stock', 'stock_quantity', 'variations']) assert.ok(lists.every((q) => (q.query._fields ?? '').split(',').includes(field)), field)
  const varPages = b.requests.filter((q) => /\/variations$/.test(q.path) && q.query.status === 'any')
  for (const field of ['id', 'sku', 'status', 'attributes']) assert.ok(varPages.every((q) => (q.query._fields ?? '').split(',').includes(field)), `variation ${field}`)
})
