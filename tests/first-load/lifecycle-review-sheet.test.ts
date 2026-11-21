/**
 * `first-load:lifecycle-review`: the owner lifecycle review sheet. Rows (the review set and every product), columns, the drop-down, the highlighting, the
 * SKU mismatches tab, formula safety, the WMS read or not read, the binding, the output files and the refusals. Synthetic data only: the WooCommerce store
 * is a local fake (tests/first-load/lifecycle-review-fixture.ts) and the WMS is a fake reader (the connector's own reader has its own test).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { EXIT_CODES } from '../../lib/first-load/spec.ts'
import { runLifecycleReviewCli, WmsReadFailed, type WmsReader } from '../../lib/first-load/lifecycle-review/cli.ts'
import { ALL_PRODUCTS_TAB, BINDING_TAB, LIFECYCLE_REVIEW_FILE_NAMES, MISMATCH_TAB, NOTES_TAB, REVIEW_TAB, parseGeneration } from '../../lib/first-load/lifecycle-review/generation.ts'
import { readXlsx, unzip, type ReadSheet } from '../../lib/first-load/lifecycle-review/xlsx.ts'
import { buildFixture, fakeWms, FORMULA_NAME, type Fixture } from './lifecycle-review-fixture.ts'
import { precondition } from './helpers.ts'

let fx: Fixture
before(async () => { fx = await buildFixture() })
after(() => fx.cleanup())

const reader = (listing = fakeWms(), calls: string[] = []): WmsReader => ({ flag: '--mintsoft-env-file', label: 'Mintsoft', read: async (file) => { calls.push(file); return listing } })

async function generate(extra: string[] = [], wms: WmsReader | undefined = reader(), manifest = fx.manifestPath): Promise<{ code: number; out: string; stdout: string; stderr: string }> {
  const out = fx.fresh('review')
  let stdout = ''
  let stderr = ''
  const code = await runLifecycleReviewCli(['--manifest', manifest, '--out', out, ...extra], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, wms ? { wms } : {})
  return { code, out, stdout, stderr }
}
const withWms = ['--mintsoft-env-file', '/nonexistent/only-passed-to-the-fake']

/** A tab as header -> values per row. */
function table(sheet: ReadSheet): { header: string[]; rows: Array<Record<string, string>> } {
  const head = sheet.rows.get(1)!
  const width = Math.max(...head.keys()) + 1
  const header = Array.from({ length: width }, (_, i) => head.get(i)?.text ?? '')
  const rows: Array<Record<string, string>> = []
  for (const [r, cells] of [...sheet.rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (r === 1) continue
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells.get(i)?.text ?? ''])))
  }
  return { header, rows }
}
const tabs = (dir: string) => {
  const sheets = readXlsx(readFileSync(path.join(dir, LIFECYCLE_REVIEW_FILE_NAMES.sheet)))
  return Object.fromEntries(sheets.map((s) => [s.name, s])) as Record<string, ReadSheet>
}

test('the sheet lists exactly the review set (Woo draft/private/pending, Qoblex Archived, WMS discontinued) and every product on All products', async (t) => {
  const r = await generate(withWms)
  assert.equal(r.code, EXIT_CODES.OK, r.stderr)
  const s = tabs(r.out)
  assert.deepEqual(Object.keys(s), [REVIEW_TAB, ALL_PRODUCTS_TAB, MISMATCH_TAB, NOTES_TAB, BINDING_TAB])
  assert.equal(s[BINDING_TAB].state, 'hidden')
  const review = table(s[REVIEW_TAB])
  precondition(t, 'review rows', review.rows.length)
  const why = Object.fromEntries(review.rows.map((row) => [row['IMS SKU'] || `(${row['Woo SKU'] || row['Mintsoft SKU']})`, row['Why in review']]))
  assert.deepEqual(Object.keys(why).sort(), ['(EXT-1)', '(MS-ONLY)', 'NEW-1', 'NEW-ARCH', 'SIM-DRAFT', 'SIM-PRIV', 'VAR-02'])
  assert.equal(why['SIM-PRIV'], 'WooCommerce private; Qoblex Archived')
  assert.equal(why['NEW-ARCH'], 'Qoblex Archived')
  assert.equal(why['NEW-1'], 'Mintsoft discontinued', 'the sheet names the WMS as the operator knows it')
  assert.match(why['(EXT-1)'], /WooCommerce draft \(not loaded into IMS: no decision possible\)/)
  const all = table(s[ALL_PRODUCTS_TAB])
  assert.deepEqual(all.rows.map((row) => row['IMS SKU'] || `(${row['Woo SKU'] || row['Mintsoft SKU']})`).sort(), ['(CASE-1)', '(EXT-1)', '(MS-ONLY)', 'NEW-1', 'NEW-ARCH', 'Q-ONLY', 'SIM-DRAFT', 'SIM-PRIV', 'SIM-PUB', 'VAR-01', 'VAR-02', 'VAR-PARENT', 'case-1'].sort())
  assert.ok(!all.header.includes('New IMS status'), 'decisions are only taken on the Review tab')
})

test('the columns carry the SKU in each system, the Woo name (or the marked Qoblex name), type, parent, states, stock per system and warehouse, and the current lifecycle', async () => {
  const r = await generate(withWms)
  const review = table(tabs(r.out)[REVIEW_TAB])
  for (const h of ['IMS SKU', 'Name', 'Name source', 'IMS lifecycle the first load would set', 'New IMS status', 'Override reason', 'Qoblex SKU', 'Woo SKU', 'Woo id', 'Mintsoft SKU', 'Mintsoft product id', 'Type', 'Parent SKU', 'Qoblex state', 'Woo status', 'Woo parent status', 'Mintsoft status', 'Qoblex stock total', 'Qoblex stock CAMB', 'Qoblex stock MIL1', 'Woo stock', 'Mintsoft physical stock', 'SKU check', 'Sheet id']) assert.ok(review.header.includes(h), h)
  const row = (sku: string) => review.rows.find((x) => x['IMS SKU'] === sku)!
  assert.deepEqual([row('NEW-ARCH')['Qoblex state'], row('NEW-ARCH')['Woo status'], row('NEW-ARCH')['Qoblex stock total'], row('NEW-ARCH')['Qoblex stock MIL1'], row('NEW-ARCH')['Woo stock'], row('NEW-ARCH')['Mintsoft physical stock']], ['Archived', 'publish', '3', '3', '2', '3'])
  assert.equal(row('NEW-ARCH')['IMS lifecycle the first load would set'], 'ACTIVE (Active)', 'Qoblex Archived, Woo publish: WooCommerce wins today')
  assert.equal(row('SIM-DRAFT')['IMS lifecycle the first load would set'], 'DRAFT (Do not sell yet)')
  assert.deepEqual([row('VAR-02').Name, row('VAR-02')['Name source'], row('VAR-02').Type, row('VAR-02')['Parent SKU'], row('VAR-02')['Woo status'], row('VAR-02')['Woo parent status'], row('VAR-02')['Woo stock']], ['Mug - Blue', 'WooCommerce', 'VARIANT', 'VAR-PARENT', 'private', 'publish', 'not read'])
  assert.deepEqual([row('SIM-PRIV')['Woo stock'], row('SIM-PRIV')['Woo id']], ['not managed', '203'])
  assert.deepEqual([row('NEW-1')['Qoblex SKU'], row('NEW-1')['Woo SKU'], row('NEW-1')['Mintsoft SKU'], row('NEW-1')['Mintsoft product id'], row('NEW-1')['Mintsoft status']], ['OLD-1', 'NEW-1', 'OLD-1', '15', 'discontinued'])
  const all = table(tabs(r.out)[ALL_PRODUCTS_TAB])
  const qOnly = all.rows.find((x) => x['IMS SKU'] === 'Q-ONLY')!
  assert.deepEqual([qOnly.Name, qOnly['Name source'], qOnly['Qoblex state'], qOnly['IMS lifecycle the first load would set']], ['Only in Qoblex', 'Qoblex (not in WooCommerce)', 'Inactive', 'EOL (Discontinued)'])
  assert.equal(all.rows.find((x) => x['IMS SKU'] === 'VAR-PARENT')!['SKU check'], '', 'a VARIABLE parent is expected only in WooCommerce and IMS')
})

test('the New IMS status column carries a drop-down of exactly the four owner statuses over every Review row', async () => {
  const r = await generate(withWms)
  const xml = unzip(readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.sheet))).get('xl/worksheets/sheet1.xml')!.toString('utf8')
  const review = table(tabs(r.out)[REVIEW_TAB])
  const col = String.fromCharCode(65 + review.header.indexOf('New IMS status'))
  assert.match(xml, new RegExp(`<dataValidation type="list"[^>]*showErrorMessage="1"[^>]*sqref="${col}2:${col}${review.rows.length + 1}"><formula1>"Discontinued,Archived,Do not sell yet,Active"</formula1>`))
  assert.ok(review.rows.every((row) => row['New IMS status'] === '' && row['Override reason'] === ''), 'both decision columns start empty')
})

test('a row holding stock anywhere is filled; the SKU cells of a row with a mismatch are filled differently; the mismatches tab lists every flag', async () => {
  const r = await generate(withWms)
  const bytes = readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.sheet))
  const xml = unzip(bytes).get('xl/worksheets/sheet2.xml')!.toString('utf8')
  const all = table(tabs(r.out)[ALL_PRODUCTS_TAB])
  // The style table (xlsx.ts styleIndex): 1 + fill*4 (+2 bold, +1 quotePrefix); stock is fill 2, mismatch fill 3.
  const styleOf = (sku: string, column: string) => {
    const rowNo = all.rows.findIndex((x) => x['IMS SKU'] === sku) + 2
    const letter = String.fromCharCode(65 + all.header.indexOf(column))
    return Number(new RegExp(`<c r="${letter}${rowNo}" s="(\\d+)"`).exec(xml)?.[1] ?? '0')
  }
  assert.equal(all.rows.find((x) => x['IMS SKU'] === 'NEW-ARCH')!['Stock > 0'], 'yes')
  assert.equal(styleOf('NEW-ARCH', 'Name'), 9, 'stock row: yellow')
  assert.equal(styleOf('SIM-DRAFT', 'Type'), 1, 'no stock, no fill')
  assert.equal(styleOf('SIM-DRAFT', 'Name'), 2, 'no fill, quote-prefixed (its Woo title starts with =)')
  assert.equal(styleOf('NEW-1', 'IMS SKU'), 13, 'mismatch: the SKU cells are orange')
  assert.equal(styleOf('NEW-1', 'Name'), 1)
  const flags = table(tabs(r.out)[MISMATCH_TAB]).rows
  const detailOf = (pred: (row: Record<string, string>) => boolean) => flags.filter(pred).map((row) => `${row.Check}: ${row.Detail}`)
  assert.deepEqual(detailOf((x) => x['IMS SKU'] === 'NEW-1'), [
    'RENAMED: Qoblex holds "OLD-1"; IMS loads it as "NEW-1" (sku-renames): fix the SKU in Qoblex if it is kept',
    'RENAMED: Mintsoft still holds the pre-rename SKU "OLD-1": fix it there',
  ])
  assert.deepEqual(detailOf((x) => x['IMS SKU'] === 'case-1'), ['CASE_OR_WHITESPACE: WooCommerce holds "CASE-1", which differs from "case-1" only in letter case or whitespace (never joined)'])
  assert.deepEqual(detailOf((x) => x['Woo SKU'] === 'CASE-1'), [
    'CASE_OR_WHITESPACE: Qoblex holds "case-1", which differs from "CASE-1" only in letter case or whitespace (never joined)',
    'CASE_OR_WHITESPACE: Mintsoft holds "case-1", which differs from "CASE-1" only in letter case or whitespace (never joined)',
    'CASE_OR_WHITESPACE: IMS holds "case-1", which differs from "CASE-1" only in letter case or whitespace (never joined)',
  ])
  assert.deepEqual(detailOf((x) => x['Mintsoft SKU'] === 'MS-ONLY'), ['MISSING: not in Qoblex', 'MISSING: not in WooCommerce', 'MISSING: not loaded into IMS'])
  assert.deepEqual(detailOf((x) => x['IMS SKU'] === 'Q-ONLY'), ['MISSING: not in WooCommerce', 'MISSING: not in Mintsoft'])
})

test('formula-safe: no cell is a formula, and a Woo title that starts with = is written as quote-prefixed text and reads back exactly', async () => {
  const r = await generate(withWms)
  const parts = unzip(readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.sheet)))
  for (const [name, data] of parts) if (name.startsWith('xl/worksheets/')) assert.ok(!/<f[\s>]/.test(data.toString('utf8')), `${name} has no formula`)
  const review = table(tabs(r.out)[REVIEW_TAB])
  assert.equal(review.rows.find((x) => x['IMS SKU'] === 'SIM-DRAFT')!.Name, FORMULA_NAME)
  assert.ok(parts.get('xl/styles.xml')!.toString('utf8').includes('quotePrefix="1"'))
})

test('the generation record binds the sheet: its digest is recomputed, the sheet id is on every decidable Review row and in the hidden tab, and the review set has the stock figures', async () => {
  const r = await generate(withWms)
  const gen = parseGeneration(readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.generation), 'utf8'))
  assert.ok(gen.ok, gen.ok ? '' : gen.problem)
  if (!gen.ok) return
  assert.deepEqual(gen.value.body.review.map((e) => e.sku), ['NEW-1', 'NEW-ARCH', 'SIM-DRAFT', 'SIM-PRIV', 'VAR-02'])
  assert.deepEqual(gen.value.body.review.find((e) => e.sku === 'NEW-ARCH'), { sku: 'NEW-ARCH', proposed: 'ACTIVE', qoblexStock: '3', wooStock: { kind: 'qty', qty: '2' }, wmsStock: { kind: 'qty', qty: '3' } })
  assert.equal(gen.value.body.inputs.wms.read, true)
  const s = tabs(r.out)
  const review = table(s[REVIEW_TAB])
  assert.deepEqual([...new Set(review.rows.filter((x) => x['IMS SKU'] !== '').map((x) => x['Sheet id']))], [gen.value.sheetId])
  assert.ok(review.rows.filter((x) => x['IMS SKU'] === '').every((x) => x['Sheet id'] === ''), 'an undecidable row carries no sheet id, so it reads back blank')
  const binding = table(s[BINDING_TAB])
  assert.deepEqual([binding.header, binding.rows[0]], [['sheetId', gen.value.sheetId], { sheetId: 'generationDigest', [gen.value.sheetId]: gen.value.digest }])
  assert.match(r.stdout, new RegExp(`sheet ${gen.value.sheetId} written`))
  // Deterministic: the same inputs give the same sheet and the same record.
  const again = await generate(withWms)
  assert.ok(readFileSync(path.join(again.out, LIFECYCLE_REVIEW_FILE_NAMES.sheet)).equals(readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.sheet))))
})

test('without the WMS env file nothing is read from it: its columns read "not read", the Notes say Archived cannot be cleared, and its stock is unknown in the record', async () => {
  const calls: string[] = []
  const r = await generate([], reader(fakeWms(), calls))
  assert.equal(r.code, EXIT_CODES.OK, r.stderr)
  assert.deepEqual(calls, [], 'the reader was never called')
  const s = tabs(r.out)
  const review = table(s[REVIEW_TAB])
  assert.ok(review.rows.every((x) => x['Mintsoft SKU'] === 'not read' && x['Mintsoft physical stock'] === 'not read' && x['Mintsoft status'] === 'not read'))
  assert.ok(!review.rows.some((x) => x['Why in review'].includes('Mintsoft')), 'nothing is reviewed for a WMS status that was not read')
  const notes = [...s[NOTES_TAB].rows.values()].map((cells) => cells.get(0)!.text).join('\n')
  assert.match(notes, /Mintsoft: NOT READ/)
  assert.match(r.stdout, /Mintsoft: NOT READ/)
  const gen = parseGeneration(readFileSync(path.join(r.out, LIFECYCLE_REVIEW_FILE_NAMES.generation), 'utf8'))
  assert.ok(gen.ok && gen.value.body.inputs.wms.read === false && gen.value.body.review.every((e) => e.wmsStock.kind === 'unknown'))
})

test('the files are mode 600 in a new directory; a non-empty output directory, an unverified snapshot, a missing stock export or a failed WMS read write nothing', async () => {
  const r = await generate(withWms)
  for (const name of Object.values(LIFECYCLE_REVIEW_FILE_NAMES)) assert.equal(statSync(path.join(r.out, name)).mode & 0o777, 0o600, name)
  const busy = fx.fresh('busy')
  mkdirSync(busy)
  writeFileSync(path.join(busy, 'x'), 'x')
  let stderr = ''
  assert.equal(await runLifecycleReviewCli(['--manifest', fx.manifestPath, '--out', busy], { stdout: () => {}, stderr: (s) => (stderr += s) }), EXIT_CODES.OUTPUT_FAILED)
  const cases: Array<[string, string, RegExp]> = [
    ['unverified snapshot', fx.writeManifest((m) => { (m.wooSnapshot as Record<string, unknown>).origin = 'https://another.example' }), /not verified/],
    ['no stock export', fx.writeManifest((m) => { m.inputs = (m.inputs as Array<{ dataset: string }>).filter((i) => i.dataset !== 'stock-lots') }), /no stock-lots dataset/],
  ]
  for (const [label, manifest, why] of cases) {
    const bad = await generate(withWms, reader(), manifest)
    assert.equal(bad.code, EXIT_CODES.INPUT_UNUSABLE, label)
    assert.match(bad.stderr, why, label)
    assert.equal(existsSync(bad.out), false, `${label}: nothing written`)
  }
  const failing: WmsReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async () => { throw new WmsReadFailed('the product list page 1 could not be read') } }
  const failed = await generate(withWms, failing)
  assert.equal(failed.code, EXIT_CODES.INPUT_UNUSABLE)
  assert.match(failed.stderr, /Mintsoft: the product list page 1 could not be read/)
  assert.equal(existsSync(failed.out), false)
})

test('the manifest decisions are ignored when generating (the sheet shows the lifecycle before any decision), and an unknown option is a usage error that names no credential', async () => {
  const generation = (await generate(withWms)).out
  const manifest = fx.writeManifest((m) => {
    m.lifecycleReview = { generation: path.join(generation, LIFECYCLE_REVIEW_FILE_NAMES.generation) }
    ;(m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file: path.join(generation, 'missing.csv') })
  })
  const r = await generate(withWms, reader(), manifest)
  assert.equal(r.code, EXIT_CODES.OK, r.stderr)
  let stderr = ''
  assert.equal(await runLifecycleReviewCli(['--manifest', fx.manifestPath, '--out', fx.fresh('x'), '--api-key', 'secret-value'], { stdout: () => {}, stderr: (s) => (stderr += s) }), EXIT_CODES.USAGE)
  assert.match(stderr, /unknown argument "--api-key"/)
  assert.ok(!stderr.includes('secret-value'))
})

test('the document states exactly the command\'s exit codes, the Mintsoft credentials keys and the wrapper\'s option name', async () => {
  const doc = readFileSync(path.join(process.cwd(), 'docs/first-load-input-spec.md'), 'utf8')
  const sectionOf = (heading: string) => { const start = doc.indexOf(heading); assert.ok(start >= 0, heading); const rest = doc.slice(start + heading.length); const end = rest.search(/\n#{2,3} /); return end < 0 ? rest : rest.slice(0, end) }
  const firstCells = (text: string) => text.split('\n').filter((l) => /^\| [^-]/.test(l)).slice(1).map((l) => l.split('|')[1].trim())
  const { LIFECYCLE_REVIEW_EXIT_CODE_TABLE } = await import('../../lib/first-load/lifecycle-review/cli.ts')
  const rows = sectionOf('### Lifecycle review exit codes').split('\n').filter((l) => /^\| \d/.test(l)).map((l) => l.split('|').slice(1, 3).map((c) => c.trim()))
  assert.deepEqual(rows, LIFECYCLE_REVIEW_EXIT_CODE_TABLE.map((r) => [String(r.code), r.name]))
  const { LIFECYCLE_REVIEW_MINTSOFT_KEYS } = await import('../../lib/connectors/mintsoft/lifecycle-review-read.ts')
  const section = sectionOf('## Owner lifecycle review sheet')
  assert.deepEqual(firstCells(section.slice(section.indexOf('| Variable |'), section.indexOf('These are keys'))).map((c) => c.replace(/`/g, '')), Object.values(LIFECYCLE_REVIEW_MINTSOFT_KEYS))
  const script = readFileSync(path.join(process.cwd(), 'scripts/first-load-lifecycle-review.ts'), 'utf8')
  assert.ok(script.includes("flag: '--mintsoft-env-file'") && section.includes('--mintsoft-env-file'), 'the documented option is the one the wrapper registers')
  assert.ok(script.includes('readMintsoftReviewListing(readMintsoftReviewConfig(envFile))'), 'the wrapper supplies the GET-only reader')
})
