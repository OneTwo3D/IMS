/**
 * Variant parents are only as good as the WooCommerce snapshot they came from. The runner re-verifies the bundle (it reuses
 * verifyWooSnapshotBundle, it does not re-implement it) and refuses a prepared run whose variant parents are unbound or unverified.
 * The bundle is written by the real snapshot command against a LOCAL fake store (nothing leaves loopback).
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { ingestDataset } from '../../lib/first-load/ingest.ts'
import { bindingFromVerification, verifyWooSnapshotBundle } from '../../lib/first-load/snapshot.ts'
import { SNAPSHOT_EXIT_CODES, SNAPSHOT_FILE_NAMES } from '../../lib/first-load/spec.ts'
import { prepare } from '../../lib/first-load/transform.ts'
import { runSnapshotCli } from '../../lib/first-load/woo-snapshot/cli.ts'
import { parseApplyManifest } from '../../lib/first-load/apply/manifest.ts'
import { loadPreparedRun } from '../../lib/first-load/apply/prepared.ts'
import { startFakeCatalogue } from '../helpers/fake-woocommerce-catalogue.ts'
import { WAREHOUSES, preparedFiles, withReport, type FileMap } from './apply-helpers.ts'
import { config, ds, lot, precondition, product } from './helpers.ts'

const KEY = 'ck_test_readonly_key_0000'
const SECRET = 'cs_test_readonly_secret_1111'
const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-apply-woo-'))
const savedEnv = process.env.E2E_TEST_MODE
before(() => { process.env.E2E_TEST_MODE = '1' })
after(() => {
  if (savedEnv === undefined) delete process.env.E2E_TEST_MODE
  else process.env.E2E_TEST_MODE = savedEnv
  rmSync(scratch, { recursive: true, force: true })
})
const ATTESTED = { products: { publish: 1, draft: 0, private: 0, pending: 0 }, variations: { publish: 2, draft: 0, private: 0, pending: 0 } }

type Bundle = { snapshot: Uint8Array; provenance: Uint8Array; csv: Uint8Array; origin: string }
const cache = new Map<string, Promise<Bundle>>()
function snapshotBundle(sku2 = 'V-02'): Promise<Bundle> {
  if (!cache.has(sku2)) cache.set(sku2, writeBundle(sku2))
  return cache.get(sku2)!
}

async function writeBundle(sku2: string): Promise<Bundle> {
  const server = await startFakeCatalogue({
    key: KEY,
    secret: SECRET,
    parents: [{ id: 100, sku: 'REAL-PARENT', name: 'Real parent', status: 'publish', variations: [{ id: 1001, sku: 'V-01' }, { id: 1002, sku: sku2 }] }],
  })
  try {
    const envFile = path.join(scratch, `creds-${sku2}`)
    writeFileSync(envFile, `FIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    const out = path.join(scratch, `bundle-${sku2}`)
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', envFile, '--out', out, '--allow-origin', server.origin, '--min-interval-ms', '0'], { stdout: () => {}, stderr: (s) => (stderr += s) })
    assert.equal(code, SNAPSHOT_EXIT_CODES.OK, stderr)
    const read = (name: string) => new Uint8Array(readFileSync(path.join(out, name)))
    return { snapshot: read(SNAPSHOT_FILE_NAMES.snapshot), provenance: read(SNAPSHOT_FILE_NAMES.provenance), csv: read(SNAPSHOT_FILE_NAMES.variantParents), origin: server.origin }
  } finally { await server.close() }
}

function preparedWithParents(bundle: { snapshot: Uint8Array; provenance: Uint8Array; csv: Uint8Array; origin: string }): FileMap {
  const vp = ingestDataset('variant-parents', bundle.csv, 'variant-parents.csv', null)
  const binding = bindingFromVerification(verifyWooSnapshotBundle({ snapshotBytes: bundle.snapshot, provenanceBytes: bundle.provenance, csvBytes: bundle.csv, expectedOrigin: bundle.origin, visibilityChecked: ATTESTED }))
  assert.equal(binding.verified, true, 'the honest bundle verifies (control)')
  const result = prepare({
    config: config(),
    datasets: {
      products: ds('products', [product('V-01', 'VARIANT'), product('V-02', 'VARIANT')]),
      'stock-lots': ds('stock-lots', [lot('V-01', '4', '2'), lot('V-02', '5', '3')]),
      'variant-parents': vp,
    },
    variantParentsBinding: binding,
  })
  assert.equal(result.blocking, false, JSON.stringify(result.report.findings.filter((f) => f.severity === 'ERROR')))
  return preparedFiles(result)
}

function manifestFor(bundle: { origin: string }, over: Record<string, unknown> = {}, woo: Record<string, unknown> | null = {}) {
  return parseApplyManifest(JSON.stringify({
    formatVersion: 1, runId: 'woo-run', preparedDir: '/p', baseCurrency: 'GBP', steps: ['products', 'opening-stock'],
    expectWarehouses: { MAIN: WAREHOUSES['ZQSENT-MAIN'] }, restorePointDir: '/r',
    ...(woo === null ? {} : { wooSnapshot: { snapshot: '/s', provenance: '/p', variantParents: '/v', origin: bundle.origin, visibilityChecked: ATTESTED, ...woo } }),
    ...over,
  }))
}

test('control: a run with variant parents loads when the manifest names the verified snapshot bundle; the VARIABLE parent is a product row', async (t) => {
  const bundle = await snapshotBundle()
  const files = preparedWithParents(bundle)
  const loaded = loadPreparedRun({ manifest: manifestFor(bundle, { acceptZeroCost: undefined }), files, woo: { snapshot: bundle.snapshot, provenance: bundle.provenance, variantParents: bundle.csv } })
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.problems.join('; '))
  if (loaded.ok) {
    precondition(t, 'bound variant parents', loaded.run.variantParents ? 1 : 0)
    assert.ok(loaded.run.steps[0].units.some((u) => u.key === 'REAL-PARENT'))
    const digestA = loaded.run.manifestDigest
    const again = loadPreparedRun({ manifest: manifestFor(bundle, { acceptZeroCost: undefined }), files, woo: { snapshot: bundle.snapshot, provenance: bundle.provenance, variantParents: bundle.csv } })
    assert.ok(again.ok && again.run.manifestDigest === digestA, 'same inputs, same digest')
  }
})

test('unbound or unverified variant parents are refused: no bundle named, the file edited, the snapshot of another store, a wrong origin, a wrong attestation, an unreadable file', async (t) => {
  const bundle = await snapshotBundle()
  const other = await snapshotBundle('V-33')
  const files = preparedWithParents(bundle)
  const woo = { snapshot: bundle.snapshot, provenance: bundle.provenance, variantParents: bundle.csv }
  const text = (u: Uint8Array) => new TextDecoder().decode(u)
  const edited = new TextEncoder().encode(text(bundle.csv).replace('REAL-PARENT', 'EVIL-PARENT'))
  const arms: Array<[string, ReturnType<typeof manifestFor>, typeof woo | null, RegExp]> = [
    ['no wooSnapshot in the apply manifest', manifestFor(bundle, {}, null), null, /must name the verified snapshot bundle/],
    ['variant-parents.csv edited', manifestFor(bundle), { ...woo, variantParents: edited }, /snapshot is not verified \(\d+ problem/],
    ['snapshot and provenance of another snapshot', manifestFor(bundle), { snapshot: other.snapshot, provenance: other.provenance, variantParents: bundle.csv }, /snapshot is not verified/],
    ['CSV of another snapshot, bundle of this one', manifestFor(bundle), { ...woo, variantParents: other.csv }, /snapshot is not verified/],
    ['declared origin differs', manifestFor({ origin: 'https://other-shop.example' }), woo, /snapshot is not verified \(\d+ problem/],
    ['attestation differs', manifestFor(bundle, {}, { visibilityChecked: { products: { publish: 9, draft: 0, private: 0, pending: 0 }, variations: ATTESTED.variations } }), woo, /snapshot is not verified \(\d+ problem/],
  ]
  precondition(t, 'refusal arms', arms.length)
  for (const [label, manifest, bytes, pattern] of arms) {
    const loaded = loadPreparedRun({ manifest, files, woo: bytes })
    assert.ok(!loaded.ok && loaded.problems.some((p) => pattern.test(p)), `${label}: ${loaded.ok ? 'was accepted' : JSON.stringify(loaded.problems)}`)
    // Snapshot values (SKUs, ids) never reach the text: only the number of problems does.
    if (!loaded.ok) assert.ok(!/EVIL-PARENT|REAL-PARENT|V-33/.test(loaded.problems.join('\n')), `${label}: a snapshot value is printed`)
  }
  const unreadable = loadPreparedRun({ manifest: manifestFor(bundle), files, woo: { ...woo, provenance: null } })
  assert.ok(!unreadable.ok && unreadable.problems.some((p) => /snapshot is not verified/.test(p)))
})

test('the prepared run must have read exactly the verified CSV: a bundle that verifies, but is not the file the tool recorded reading, is refused', async () => {
  const bundle = await snapshotBundle()
  const files = withReport(preparedWithParents(bundle), (r) => {
    const input = r.inputs.find((i) => i.dataset === 'variant-parents')!
    input.sha256 = 'b'.repeat(64)
    input.parts[0].sha256 = 'b'.repeat(64)
  })
  const loaded = loadPreparedRun({ manifest: manifestFor(bundle), files, woo: { snapshot: bundle.snapshot, provenance: bundle.provenance, variantParents: bundle.csv } })
  assert.ok(!loaded.ok && loaded.problems.some((p) => /not the file of the verified snapshot bundle/.test(p)), loaded.ok ? 'accepted' : JSON.stringify(loaded.problems))
})

test('an apply manifest with a wooSnapshot but no variant parents in the run is refused as an unused input', async () => {
  const bundle = await snapshotBundle()
  const plain = preparedFiles(prepare({ config: config(), datasets: { products: ds('products', [product('A')]) } }))
  const loaded = loadPreparedRun({ manifest: manifestFor(bundle, { steps: ['products'], expectWarehouses: undefined }), files: plain, woo: { snapshot: bundle.snapshot, provenance: bundle.provenance, variantParents: bundle.csv } })
  assert.ok(!loaded.ok && loaded.problems.some((p) => /used no variant parents/.test(p)))
})
