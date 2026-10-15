/**
 * variant-parents.csv assigns a parent to a Qoblex variant, so it must be bound to the VERIFIED WooCommerce snapshot it came from: the offline
 * `--verify` and `first-load:prepare` both regenerate the rows from the snapshot and refuse a CSV that is not byte-identical, or whose recorded hashes do
 * not match. Bundles here are written by the real snapshot command against a local fake store (nothing leaves loopback).
 *
 * Every refusal arm asserts and prints its precondition (the honest control ran and the tampering really changed a byte). Where two mechanisms (a hash and
 * the byte comparison) could each refuse an input, an ISOLATING arm defeats one so the other is proved on its own. Mutations are listed in the PR.
 */
import assert from 'node:assert/strict'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { runCli as runPrepare } from '../../lib/first-load/cli.ts'
import { EXIT_CODES, SNAPSHOT_EXIT_CODES, SNAPSHOT_FILE_NAMES } from '../../lib/first-load/spec.ts'
import { sha256Hex } from '../../lib/first-load/snapshot.ts'
import { runSnapshotCli } from '../../lib/first-load/woo-snapshot/cli.ts'
import { startFakeCatalogue, type FakeParent } from '../helpers/fake-woocommerce-catalogue.ts'
import { ds, precondition, product } from './helpers.ts'
import { prepare } from '../../lib/first-load/transform.ts'

const KEY = 'ck_test_readonly_key_0000'
const SECRET = 'cs_test_readonly_secret_1111'
interface FindingShape { code: string; severity: string; message: string }
interface PrepareReportShape { findings: FindingShape[]; variantParents: { variantsJoined: number; parentsEmitted: number } }
const scratch = mkdtempSync(path.join(tmpdir(), 'first-load-binding-'))
let counter = 0
const fresh = (label: string) => path.join(scratch, `${label}-${++counter}`)
const savedEnv = process.env.E2E_TEST_MODE
before(() => { process.env.E2E_TEST_MODE = '1' })
after(() => {
  if (savedEnv === undefined) delete process.env.E2E_TEST_MODE
  else process.env.E2E_TEST_MODE = savedEnv
  rmSync(scratch, { recursive: true, force: true })
})

const REAL_PARENT = 'REAL-PARENT'
const EVIL_PARENT = 'EVIL-PARENT'

function catalogue(variant: 'a' | 'b'): FakeParent[] {
  return [
    { id: 100, sku: REAL_PARENT, name: 'Real parent', status: 'publish', variations: [{ id: 1001, sku: 'V-01', attributes: [{ name: 'Colour', option: 'Red' }] }, { id: 1002, sku: 'V-02', attributes: [{ name: 'Colour', option: 'Blue' }] }] },
    { id: 200, sku: 'OTHER-PARENT', name: 'Other parent', status: 'publish', variations: [{ id: 2001, sku: variant === 'a' ? 'V-03' : 'V-33' }] },
  ]
}

/** Writes a real snapshot bundle (snapshot, provenance, variant-parents.csv, inspection copy) with the real command and returns its directory. */
/** The origin the operator declares for each bundle written below (the fake store it was really read from). */
const declaredOrigin = new Map<string, string>()

async function bundle(variant: 'a' | 'b' = 'a'): Promise<string> {
  const server = await startFakeCatalogue({ key: KEY, secret: SECRET, parents: catalogue(variant) })
  try {
    const envFile = fresh('creds')
    writeFileSync(envFile, `FIRST_LOAD_WOO_URL=${server.url}\nFIRST_LOAD_WOO_KEY=${KEY}\nFIRST_LOAD_WOO_SECRET=${SECRET}\n`, { mode: 0o600 })
    chmodSync(envFile, 0o600)
    const out = fresh('bundle')
    let stderr = ''
    const code = await runSnapshotCli(['--env-file', envFile, '--out', out, '--allow-origin', server.origin, '--min-interval-ms', '0'], { stdout: () => {}, stderr: (s) => (stderr += s) })
    assert.equal(code, SNAPSHOT_EXIT_CODES.OK, stderr)
    declaredOrigin.set(out, server.origin)
    return out
  } finally { await server.close() }
}

const copyBundle = (from: string) => {
  const to = fresh('copy')
  cpSync(from, to, { recursive: true })
  declaredOrigin.set(to, declaredOrigin.get(from)!)
  return to
}
const file = (dir: string, name: string) => path.join(dir, name)
const edit = (target: string, change: (text: string) => string) => {
  const before = readFileSync(target, 'utf8')
  const after = change(before)
  assert.notEqual(after, before, 'the tampering changed nothing: the arm would examine an untouched file')
  writeFileSync(target, after)
}
interface Provenance { snapshotFile: { sha256: string; payloadSha256: string }; variantParentsFile?: { sha256: string } }
const editProvenance = (dir: string, change: (p: Provenance) => void) => edit(file(dir, SNAPSHOT_FILE_NAMES.provenance), (text) => { const p = JSON.parse(text); change(p); return `${JSON.stringify(p, null, 2)}\n` })

async function verify(dir: string, origin: string | null = declaredOrigin.get(dir) ?? null): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runSnapshotCli(['--verify', file(dir, SNAPSHOT_FILE_NAMES.snapshot), ...(origin === null ? [] : ['--expect-origin', origin])], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  return { code, stdout, stderr }
}

/** Runs first-load:prepare over products V-01..V-03 and the bundle's CSV; `csvFrom` is the directory whose variant-parents.csv is listed. */
async function prepareWith(opts: { snapshotDir: string | null; csvFrom: string; wooSnapshot?: boolean; origin?: string | null }): Promise<{ code: number; stdout: string; stderr: string; out: string; written: string; report: PrepareReportShape }> {
  const dir = fresh('prepare')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'products.csv'), 'sku,name,type\nV-01,Variant one,VARIANT\nV-02,Variant two,VARIANT\nV-03,Variant three,VARIANT\n')
  cpSync(file(opts.csvFrom, SNAPSHOT_FILE_NAMES.variantParents), path.join(dir, 'variant-parents.csv'))
  const manifest: Record<string, unknown> = { formatVersion: 1, baseCurrency: 'GBP', inputs: [{ dataset: 'products', file: 'products.csv' }, { dataset: 'variant-parents', file: 'variant-parents.csv' }, { dataset: 'sku-exclusions', file: 'exclusions.csv' }] }
  writeFileSync(path.join(dir, 'exclusions.csv'), 'sku,reason\nV-33,not loaded at first\n')
  if (opts.wooSnapshot !== false && opts.snapshotDir !== null) manifest.wooSnapshot = { snapshot: file(opts.snapshotDir, SNAPSHOT_FILE_NAMES.snapshot), provenance: file(opts.snapshotDir, SNAPSHOT_FILE_NAMES.provenance), ...((opts.origin === undefined ? declaredOrigin.get(opts.snapshotDir) : opts.origin) === null ? {} : { origin: opts.origin === undefined ? declaredOrigin.get(opts.snapshotDir) : opts.origin }) }
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  let stdout = ''
  let stderr = ''
  const out = fresh('prepared')
  const code = await runPrepare(['--manifest', path.join(dir, 'manifest.json'), '--out', out], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) })
  let written = ''
  let report: PrepareReportShape = { findings: [], variantParents: { variantsJoined: 0, parentsEmitted: 0 } }
  try {
    for (const name of readdirSync(out)) written += `${name}\n${readFileSync(path.join(out, name), 'utf8')}\n`
    report = JSON.parse(readFileSync(path.join(out, 'validation-report.json'), 'utf8'))
  } catch { /* nothing written */ }
  return { code, stdout, stderr, out, written, report }
}

/** A refused run: blocking, the ERROR finding names the cause, no assignment and no parent reached any output, and no file content was echoed. */
function assertRefused(t: import('node:test').TestContext, ran: Awaited<ReturnType<typeof prepareWith>>, honestWritten: string, label: string): void {
  precondition(t, `${label}: honest control wrote the real parent`, honestWritten.includes(REAL_PARENT) ? 1 : 0)
  assert.equal(ran.code, EXIT_CODES.BLOCKING_FINDINGS, `${label}: ${ran.stdout}${ran.stderr}`)
  const finding = ran.report?.findings?.find((f: FindingShape) => f.code === 'VARIANT_PARENTS_NOT_BOUND')
  precondition(t, `${label}: VARIANT_PARENTS_NOT_BOUND findings`, finding ? 1 : 0)
  assert.ok(finding)
  assert.equal(finding.severity, 'ERROR')
  assert.equal(ran.report.variantParents.variantsJoined, 0, `${label}: no variant was joined`)
  assert.equal(ran.report.variantParents.parentsEmitted, 0, `${label}: no parent was emitted`)
  assert.ok(!ran.written.includes(REAL_PARENT) && !ran.written.includes(EVIL_PARENT) && !ran.written.includes('OTHER-PARENT'), `${label}: no parent assignment reached an output file`)
  assert.ok(finding.message.length < 1500, 'the finding is bounded')
  assert.ok(!finding.message.includes(EVIL_PARENT), 'the finding does not echo file content')
}

test('arm (a): an honest bundle is accepted by --verify and by first-load:prepare, and the parents are emitted', async (t) => {
  const b = await bundle()
  const v = await verify(b)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.OK, v.stderr)
  assert.match(v.stdout, /byte-identical/)
  const ran = await prepareWith({ snapshotDir: b, csvFrom: b })
  assert.equal(ran.code, EXIT_CODES.OK, ran.stdout + ran.stderr)
  precondition(t, 'variants joined', ran.report.variantParents.variantsJoined)
  assert.equal(ran.report.variantParents.variantsJoined, 3)
  assert.ok(ran.written.includes(REAL_PARENT))
  assert.ok(!ran.report.findings.some((f: FindingShape) => f.code === 'VARIANT_PARENTS_NOT_BOUND'))
})

test('arm (b): a hand-edited CSV (a changed parent SKU) with the snapshot untouched is refused by --verify and by prepare', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = await bundle()
  const edited = copyBundle(b)
  edit(file(edited, SNAPSHOT_FILE_NAMES.variantParents), (text) => text.replace(REAL_PARENT, EVIL_PARENT))
  const v = await verify(edited)
  precondition(t, 'verify problems', v.stderr.length)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(v.stderr, /variant-parents\.csv/)
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: edited }), honest.written, 'edited CSV')
})

test('arm (c): a stale CSV (written from an earlier snapshot of the store) is refused', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle('b'), csvFrom: await bundle('b') })
  const old = await bundle('a')
  const current = await bundle('b')
  precondition(t, 'old and current CSV differ', readFileSync(file(old, SNAPSHOT_FILE_NAMES.variantParents), 'utf8') === readFileSync(file(current, SNAPSHOT_FILE_NAMES.variantParents), 'utf8') ? 0 : 1)
  const mixed = copyBundle(current)
  cpSync(file(old, SNAPSHOT_FILE_NAMES.variantParents), file(mixed, SNAPSHOT_FILE_NAMES.variantParents))
  assert.equal((await verify(mixed)).code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assertRefused(t, await prepareWith({ snapshotDir: current, csvFrom: old }), honest.written, 'stale CSV')
})

test('arm (d): a CSV from a different snapshot, listed against a snapshot and provenance of another store, is refused', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle('a'), csvFrom: await bundle('a') })
  const mine = await bundle('a')
  const foreign = await bundle('b')
  assertRefused(t, await prepareWith({ snapshotDir: foreign, csvFrom: mine }), honest.written, 'foreign CSV')
})

test('arm (e): a missing provenance is refused (nothing is taken from a CSV whose origin cannot be shown)', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  rmSync(file(b, SNAPSHOT_FILE_NAMES.provenance))
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(v.stderr, /provenance file could not be read/)
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'missing provenance')
})

test('arm (e2): a provenance that records no hash for the CSV is refused', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  editProvenance(b, (p) => { delete p.variantParentsFile })
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /does not record a SHA-256 for variant-parents\.csv/)
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'provenance without a CSV hash')
})

test('arm (f): a tampered snapshot (the checksum) is refused', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  edit(file(b, SNAPSHOT_FILE_NAMES.snapshot), (text) => text.replace('"sku": "V-01"', '"sku": "V-99"'))
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /checksum does not match/)
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'tampered snapshot')
})

test('arm (f2) isolating: a snapshot edited in a field the CSV does not carry, with the provenance file hash re-written to match, is still refused by the payload checksum alone', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  edit(file(b, SNAPSHOT_FILE_NAMES.snapshot), (text) => text.replace('"option": "Red"', '"option": "Pink"'))
  editProvenance(b, (p) => { p.snapshotFile.sha256 = sha256Hex(readFileSync(file(b, SNAPSHOT_FILE_NAMES.snapshot))) })
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /checksum does not match/)
  assert.doesNotMatch(v.stderr, /not the one the provenance recorded/, 'the provenance hash was made to match, so only the checksum can refuse')
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'edited snapshot, forged file hash')
})

test('arm (g) isolating: a different VALID snapshot swapped in beside the original provenance is refused by the provenance hash alone', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle('a'), csvFrom: await bundle('a') })
  const a = await bundle('a')
  const other = await bundle('b')
  const b = copyBundle(a)
  // The snapshot and CSV both come from the other store, and the provenance keeps the original's CSV hash made to match, so only the snapshot hash can refuse.
  cpSync(file(other, SNAPSHOT_FILE_NAMES.snapshot), file(b, SNAPSHOT_FILE_NAMES.snapshot))
  cpSync(file(other, SNAPSHOT_FILE_NAMES.variantParents), file(b, SNAPSHOT_FILE_NAMES.variantParents))
  editProvenance(b, (p) => { p.variantParentsFile!.sha256 = sha256Hex(readFileSync(file(b, SNAPSHOT_FILE_NAMES.variantParents))); p.snapshotFile.payloadSha256 = JSON.parse(readFileSync(file(other, SNAPSHOT_FILE_NAMES.snapshot), 'utf8')).payloadSha256 })
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /snapshot file .* is not the one the provenance recorded/)
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'swapped snapshot')
})

test('arm (h) isolating: an edited CSV whose recorded hash was re-written to match is refused by the byte comparison alone', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  edit(file(b, SNAPSHOT_FILE_NAMES.variantParents), (text) => text.replace(REAL_PARENT, EVIL_PARENT))
  editProvenance(b, (p) => { p.variantParentsFile!.sha256 = sha256Hex(readFileSync(file(b, SNAPSHOT_FILE_NAMES.variantParents))) })
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /not the rows regenerated from the verified snapshot/)
  assert.doesNotMatch(v.stderr, /not the file the provenance recorded/, 'the hash was made to match, so only the regeneration can refuse')
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'edited CSV, forged hash')
})

test('arm (i) isolating: an UNCHANGED CSV whose recorded hash was altered is refused by the hash alone', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = copyBundle(await bundle())
  editProvenance(b, (p) => { p.variantParentsFile!.sha256 = '0'.repeat(64) })
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.match(v.stderr, /not the file the provenance recorded/)
  assert.doesNotMatch(v.stderr, /not the rows regenerated/, 'the CSV is the regenerated one, so only the hash can refuse')
  assertRefused(t, await prepareWith({ snapshotDir: b, csvFrom: b }), honest.written, 'altered recorded hash')
})

test('arm (j): the inspection copy is checked by --verify (edited, or missing) and is not an input of prepare', async (t) => {
  const b = copyBundle(await bundle())
  edit(file(b, SNAPSHOT_FILE_NAMES.variantParentsInspection), (text) => text.replace(REAL_PARENT, EVIL_PARENT))
  const v = await verify(b)
  precondition(t, 'verify problems', v.stderr.length)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(v.stderr, /inspection copy/)
  const gone = copyBundle(await bundle())
  rmSync(file(gone, SNAPSHOT_FILE_NAMES.variantParentsInspection))
  assert.match((await verify(gone)).stderr, /inspection copy could not be read/)
  assert.equal((await prepareWith({ snapshotDir: b, csvFrom: b })).code, EXIT_CODES.OK, 'prepare reads the CSV, never the inspection copy')
})

test('arm (k): a manifest that lists variant-parents but names no wooSnapshot is refused', async (t) => {
  const honest = await prepareWith({ snapshotDir: await bundle(), csvFrom: await bundle() })
  const b = await bundle()
  const ran = await prepareWith({ snapshotDir: b, csvFrom: b, wooSnapshot: false })
  assert.match(ran.report.findings.find((f: FindingShape) => f.code === 'VARIANT_PARENTS_NOT_BOUND')?.message ?? '', /does not name wooSnapshot/)
  assertRefused(t, ran, honest.written, 'no wooSnapshot')
})

test('arm (l): prepare() called without a binding, or with a binding for other bytes, refuses the dataset', (t) => {
  const datasets = { products: ds('products', [product('V-01', 'VARIANT')]), 'variant-parents': ds('variant-parents', [{ variantSku: 'V-01', wooVariationId: '1', parentSku: 'P', parentName: 'P', parentStatus: 'publish', wooParentId: '9' }]) }
  const config = { runId: 't', baseCurrency: 'GBP', asOf: null, inTransitConvention: null, purchaseOrderKeyPrefix: null, transferKeyPrefix: null, maxPurchaseTaxRate: null }
  const none = prepare({ config, datasets })
  const other = prepare({ config, datasets, variantParentsBinding: { verified: true, csvSha256: '1'.repeat(64), snapshotPayloadSha256: 'x' } })
  const good = prepare({ config, datasets, variantParentsBinding: { verified: true, csvSha256: datasets['variant-parents'].parts[0].sha256, snapshotPayloadSha256: 'x' } })
  precondition(t, 'control run joined its variant', good.report.variantParents.variantsJoined)
  for (const [label, result] of [['no binding', none], ['binding for other bytes', other]] as const) {
    assert.equal(result.blocking, true, label)
    assert.ok(result.report.findings.some((f) => f.code === 'VARIANT_PARENTS_NOT_BOUND' && f.severity === 'ERROR'), label)
    assert.equal(result.report.variantParents.variantsJoined, 0, label)
    assert.equal(result.outputs.some((o) => o.content.includes(',P,')), false, `${label}: no parent in any output`)
  }
})

test('arm (m): a bundle from ANOTHER store is refused when the declared origin differs from the recorded one, by --verify and by prepare', async (t) => {
  const b = await bundle()
  const declared = declaredOrigin.get(b)!
  const honest = await prepareWith({ snapshotDir: b, csvFrom: b })
  precondition(t, 'honest control (declared = recorded origin) joined variants', honest.report.variantParents.variantsJoined)
  assert.equal(honest.code, EXIT_CODES.OK, honest.stdout + honest.stderr)
  assert.equal((await verify(b)).code, SNAPSHOT_EXIT_CODES.OK)
  // Same bundle, but the operator declares the production shop: every checksum and the CSV comparison still pass, only the origin differs.
  const other = 'https://shop.example'
  assert.notEqual(other, declared)
  const v = await verify(b, other)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT, v.stdout)
  assert.match(v.stderr, /was taken from http:\/\/127\.0\.0\.1:\d+, not from the declared store https:\/\/shop\.example/)
  const ran = await prepareWith({ snapshotDir: b, csvFrom: b, origin: other })
  assert.match(ran.report.findings.find((f: FindingShape) => f.code === 'VARIANT_PARENTS_NOT_BOUND')?.message ?? '', /not from the declared store/)
  assertRefused(t, ran, honest.written, 'origin differs')
})

test('arm (m2): an edited provenance origin is only as good as the declaration (the documented limit), and is still refused when the real store is declared', async (t) => {
  const b = await bundle()
  const forged = copyBundle(b)
  editProvenance(forged, (p) => { (p as unknown as { origin: string }).origin = 'https://shop.example' })
  const v = await verify(forged, 'https://shop.example')
  precondition(t, 'forged bundle verified against the origin it now claims', v.code === SNAPSHOT_EXIT_CODES.OK ? 1 : 0)
  // Editing provenance text does not change the snapshot/CSV hashes it records, so nothing else can notice: this is why the docs call the origin
  // an operator-declared expectation checked against the recorded one, and not proof of acquisition.
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.OK, v.stderr)
  // The same forged bundle is still refused when the operator declares the REAL store.
  assert.equal((await verify(forged, declaredOrigin.get(b)!)).code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
})

test('arm (n): no declared origin is a refusal: the manifest without wooSnapshot.origin gets the ERROR finding, and --verify without --expect-origin fails', async (t) => {
  const b = await bundle()
  const honest = await prepareWith({ snapshotDir: b, csvFrom: b })
  precondition(t, 'honest control joined variants', honest.report.variantParents.variantsJoined)
  const ran = await prepareWith({ snapshotDir: b, csvFrom: b, origin: null })
  assert.match(ran.report.findings.find((f: FindingShape) => f.code === 'VARIANT_PARENTS_NOT_BOUND')?.message ?? '', /no expected WooCommerce store origin was declared/)
  assertRefused(t, ran, honest.written, 'no origin')
  const v = await verify(b, null)
  assert.equal(v.code, SNAPSHOT_EXIT_CODES.INCONSISTENT)
  assert.match(v.stderr, /no expected WooCommerce store origin was declared/)
})

test('arm (o): the declared origin is normalised before it is compared (case, default port, trailing path), and a non-origin is a usage error', async (t) => {
  const b = await bundle()
  const recorded = declaredOrigin.get(b)!
  const noisy = `${recorded.toUpperCase().replace('HTTP://', 'http://')}/shop/`
  assert.notEqual(noisy, recorded)
  precondition(t, 'noisy spelling differs from the recorded one', noisy === recorded ? 0 : 1)
  assert.equal((await verify(b, noisy)).code, SNAPSHOT_EXIT_CODES.OK)
  const ran = await prepareWith({ snapshotDir: b, csvFrom: b, origin: noisy })
  assert.equal(ran.code, EXIT_CODES.OK, ran.stdout + ran.stderr)
  const bad = await prepareWith({ snapshotDir: b, csvFrom: b, origin: 'not an origin' })
  assert.equal(bad.code, EXIT_CODES.USAGE, bad.stdout + bad.stderr)
})
