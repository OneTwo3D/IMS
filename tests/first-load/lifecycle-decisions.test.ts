/**
 * The lifecycle-decisions dataset: the owner's filled review sheet (or its CSV export) read back by first-load:prepare. Precedence over the Woo-derived
 * and the Qoblex lifecycle, every row reported, the refusals (unknown SKU, bad status, duplicates, a SKU not loaded), the archived-with-stock rule, blank
 * rows blocking a real prepare and only reported by a dry run, and the binding to ONE sheet generation. Synthetic data only.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { loadPrepareRun, runCli as runPrepare } from '../../lib/first-load/cli.ts'
import { serializeCsv } from '../../lib/first-load/csv.ts'
import { EXIT_CODES } from '../../lib/first-load/spec.ts'
import { prepare, type PrepareResult } from '../../lib/first-load/transform.ts'
import { runLifecycleReviewCli, type WmsReader } from '../../lib/first-load/lifecycle-review/cli.ts'
import { BINDING_TAB, LIFECYCLE_REVIEW_FILE_NAMES, REVIEW_TAB } from '../../lib/first-load/lifecycle-review/generation.ts'
import { readXlsx, writeXlsx, type ReadSheet, type XCell, type XSheet } from '../../lib/first-load/lifecycle-review/xlsx.ts'
import { buildFixture, fakeWms, QOBLEX_PRODUCTS, QOBLEX_STOCK, type Fixture } from './lifecycle-review-fixture.ts'
import { precondition } from './helpers.ts'

let fx: Fixture
let withWms: string
let withoutWms: string
const wms: WmsReader = { flag: '--mintsoft-env-file', label: 'Mintsoft', read: async () => fakeWms() }

async function generate(args: string[]): Promise<string> {
  const out = fx.fresh('review')
  let stderr = ''
  const code = await runLifecycleReviewCli(['--manifest', fx.manifestPath, '--out', out, ...args], { stdout: () => {}, stderr: (s) => (stderr += s) }, { wms })
  assert.equal(code, EXIT_CODES.OK, stderr)
  return out
}
before(async () => {
  fx = await buildFixture()
  withWms = await generate(['--mintsoft-env-file', '/only/for/the/fake'])
  withoutWms = await generate([])
})
after(() => fx.cleanup())

type Decision = { status: string; reason?: string }
const sheetOf = (dir: string) => readFileSync(path.join(dir, LIFECYCLE_REVIEW_FILE_NAMES.sheet))
const generationOf = (dir: string) => path.join(dir, LIFECYCLE_REVIEW_FILE_NAMES.generation)

/** The Review tab as a grid of texts (row 1 the header). */
function grid(sheet: ReadSheet): string[][] {
  const width = Math.max(...[...sheet.rows.values()].flatMap((cells) => [...cells.keys()])) + 1
  const last = Math.max(...sheet.rows.keys())
  return Array.from({ length: last }, (_, r) => Array.from({ length: width }, (_, c) => sheet.rows.get(r + 1)?.get(c)?.text ?? ''))
}

/** The owner fills the sheet and saves it again (as another program would: a fresh workbook with the same tabs). `keepBinding: false` drops the hidden tab. */
function fill(dir: string, decisions: Record<string, Decision>, opts: { keepBinding?: boolean; formulaIn?: string } = {}): Buffer {
  const sheets = readXlsx(sheetOf(dir))
  const review = grid(sheets.find((s) => s.name === REVIEW_TAB)!)
  const [header, ...rows] = review
  const sku = header.indexOf('IMS SKU')
  const status = header.indexOf('New IMS status')
  const reason = header.indexOf('Override reason')
  for (const row of rows) {
    const d = decisions[row[sku]]
    if (d) { row[status] = d.status; row[reason] = d.reason ?? '' }
  }
  const out: XSheet[] = [{ name: REVIEW_TAB, rows: [header, ...rows].map((r) => r.map((v): XCell => ({ v }))) }]
  if (opts.keepBinding !== false) out.push({ name: BINDING_TAB, state: 'hidden', rows: grid(sheets.find((s) => s.name === BINDING_TAB)!).map((r) => r.map((v): XCell => ({ v }))) })
  return writeXlsx(out)
}

/** A CSV export of the filled Review tab (every column, as a spreadsheet exports it), optionally with rows added or removed. */
function csvExport(dir: string, decisions: Record<string, Decision>, change?: (rows: string[][], header: string[]) => void): Buffer {
  const [header, ...rows] = grid(readXlsx(fill(dir, decisions)).find((s) => s.name === REVIEW_TAB)!)
  change?.(rows, header)
  return Buffer.from(`﻿${serializeCsv(header, rows)}`, 'utf8')
}

function writeDecisions(bytes: Buffer, ext: 'xlsx' | 'csv'): string {
  const target = `${fx.fresh('decisions')}.${ext}`
  writeFileSync(target, bytes)
  return target
}

function manifestWith(generation: string | null, decisions: string | null, change?: (m: Record<string, unknown>) => void): string {
  return fx.writeManifest((m) => {
    if (generation !== null) m.lifecycleReview = { generation }
    if (decisions !== null) (m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file: decisions })
    change?.(m)
  })
}

type Input = Parameters<typeof prepare>[0]
/** Runs prepare as first-load:prepare does; `change` may alter the input first (a hand-made binding, a different snapshot), as a test seam. */
function prepareWith(manifest: string, dryRun = false, change?: (input: Input) => void): PrepareResult {
  let stderr = ''
  const loaded = loadPrepareRun(manifest, { stdout: () => {}, stderr: (s) => (stderr += s) }, { runId: 't' })
  assert.ok(loaded.ok, stderr)
  if (!loaded.ok) throw new Error(stderr)
  const { config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding, lifecycleReviewInputs } = loaded.run
  const input: Input = { config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding: structuredClone(lifecycleDecisionsBinding), lifecycleReviewInputs, dryRun }
  change?.(input)
  return prepare(input)
}
const sheetIdOf = (dir: string) => JSON.parse(readFileSync(generationOf(dir), 'utf8')).sheetId as string
/** A canonical lifecycle-decisions file (sku, status, reason, sheetId) for the sheet `dir`. */
const canonical = (dir: string, rows: Array<[string, string, string?, string?]>): Buffer => Buffer.from(serializeCsv(['sku', 'status', 'reason', 'sheetId'], rows.map(([sku, status, reason = '', id = sheetIdOf(dir)]) => [sku, status, reason, id])))
const generationIn = (input: Input) => {
  const binding = input.lifecycleDecisionsBinding
  assert.ok(binding?.verified === true, 'precondition: the binding is verified')
  if (binding?.verified !== true) throw new Error('unverified')
  return binding
}

const findings = (r: PrepareResult, code: string) => r.report.findings.filter((f) => f.code === code)
const lifecycleOf = (r: PrepareResult, sku: string) => r.catalogue.find((e) => e.sku === sku)
const disp = (r: PrepareResult, code: string) => r.report.dispositions.filter((d) => d.dataset === 'lifecycle-decisions' && d.code === code).map((d) => `${d.outcome} ${d.key}`)
const emitted = (r: PrepareResult, code: string) => r.report.accountingByCode.filter((a) => a.dataset === 'lifecycle-decisions' && a.outcome === 'EMITTED' && a.code === code).reduce((n, a) => n + a.count, 0)

const ALL_DECIDED: Record<string, Decision> = {
  'NEW-1': { status: 'Active' },
  'NEW-ARCH': { status: 'Discontinued' },
  'SIM-DRAFT': { status: 'Active' },
  'SIM-PRIV': { status: 'Do not sell yet' },
  'VAR-02': { status: 'active' },
}

test('decisions have the HIGHEST precedence: each applied row sets the lifecycle over the Woo-derived and the Qoblex one, and is reported', (t) => {
  const baseline = prepareWith(fx.manifestPath)
  assert.equal(lifecycleOf(baseline, 'SIM-DRAFT')?.lifecycle, 'DRAFT', 'precondition: Woo draft gives DRAFT')
  assert.equal(lifecycleOf(baseline, 'VAR-02')?.lifecycle, 'DRAFT', 'precondition: the variation is private in Woo')
  assert.equal(lifecycleOf(baseline, 'NEW-ARCH')?.lifecycle, 'ACTIVE', 'precondition: Woo publish beats Qoblex Archived')
  const r = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx')))
  precondition(t, 'decisions applied', emitted(r, 'LIFECYCLE_DECIDED'))
  assert.equal(emitted(r, 'LIFECYCLE_DECIDED'), 5)
  assert.deepEqual(['NEW-1', 'NEW-ARCH', 'SIM-DRAFT', 'SIM-PRIV', 'VAR-02'].map((sku) => [sku, lifecycleOf(r, sku)?.lifecycle, lifecycleOf(r, sku)?.lifecycleSource]), [
    ['NEW-1', 'ACTIVE', 'decision'], ['NEW-ARCH', 'EOL', 'decision'], ['SIM-DRAFT', 'ACTIVE', 'decision'], ['SIM-PRIV', 'DRAFT', 'decision'], ['VAR-02', 'ACTIVE', 'decision'],
  ])
  assert.deepEqual([lifecycleOf(r, 'SIM-PUB')?.lifecycle, lifecycleOf(r, 'SIM-PUB')?.lifecycleSource], ['ACTIVE', 'qoblex'], 'a product outside the review set keeps the lifecycle it had')
  assert.equal(lifecycleOf(baseline, 'SIM-DRAFT')?.lifecycleSource, 'woo', 'precondition: the baseline took SIM-DRAFT from WooCommerce, which the decision then overrode')
  assert.deepEqual(findings(r, 'LIFECYCLE_FROM_DECISION').map((f) => f.message), [
    'NEW-1: owner decision Active, loaded as ACTIVE (the first load would otherwise set ACTIVE)',
    'NEW-ARCH: owner decision Discontinued, loaded as EOL (the first load would otherwise set ACTIVE)',
    'SIM-DRAFT: owner decision Active, loaded as ACTIVE (the first load would otherwise set DRAFT)',
    'SIM-PRIV: owner decision Do not sell yet, loaded as DRAFT (the first load would otherwise set DRAFT)',
    'VAR-02: owner decision Active, loaded as ACTIVE (the first load would otherwise set DRAFT)',
  ])
  assert.deepEqual(findings(r, 'LIFECYCLE_DECISION_MISSING'), [])
  assert.deepEqual(findings(r, 'LIFECYCLE_DECISIONS_NOT_BOUND'), [])
  assert.deepEqual(findings(r, 'LIFECYCLE_REVIEW_INPUTS_CHANGED'), [])
  assert.ok(r.report.accountingBalanced)
})

test('the decided lifecycle is what the products import file carries (end to end through the CLI)', async () => {
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx'))
  const out = fx.fresh('prepared')
  let stderr = ''
  const code = await runPrepare(['--manifest', manifest, '--out', out], { stdout: () => {}, stderr: (s) => (stderr += s) })
  const report = JSON.parse(readFileSync(path.join(out, 'validation-report.json'), 'utf8')) as PrepareResult['report']
  assert.equal(code, EXIT_CODES.OK, `${stderr}${report.findings.filter((f) => f.severity === 'ERROR').map((f) => f.message).join('\n')}${report.dispositions.filter((d) => d.outcome === 'REJECTED').map((d) => `${d.dataset} ${d.key} ${d.code}`).join('\n')}`)
  const products = readFileSync(path.join(out, report.outputs.find((o) => o.target === 'products')!.name), 'utf8').split('\r\n').filter(Boolean).map((l) => l.split(','))
  const col = (name: string) => products[0].indexOf(name)
  const lifecycle = Object.fromEntries(products.slice(1).map((cells) => [cells[col('sku')], cells[col('lifecycleStatus')]]))
  assert.deepEqual([lifecycle['SIM-DRAFT'], lifecycle['VAR-02'], lifecycle['NEW-ARCH']], ['ACTIVE', 'ACTIVE', 'EOL'])
})

test('Archived for a SKU holding stock (Qoblex, Woo or WMS) is REFUSED unless the override reason is filled; then it is applied and reported', () => {
  const refused = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'NEW-ARCH': { status: 'Archived' } }), 'xlsx')))
  assert.deepEqual(disp(refused, 'ARCHIVED_WITH_STOCK'), ['REJECTED NEW-ARCH'])
  assert.match(refused.report.dispositions.find((d) => d.code === 'ARCHIVED_WITH_STOCK')!.reason, /Qoblex stock at generation MIL1 3, Qoblex stock in this run MIL1 3, WooCommerce stock at generation 2, WMS physical stock at generation 3/)
  assert.ok(refused.blocking)
  assert.equal(lifecycleOf(refused, 'NEW-ARCH')?.lifecycle, 'ACTIVE', 'a refused decision changes nothing')
  const overridden = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'NEW-ARCH': { status: 'Archived', reason: 'stock to be written off (synthetic)' } }), 'xlsx')))
  assert.deepEqual(disp(overridden, 'ARCHIVED_WITH_STOCK'), [])
  assert.equal(lifecycleOf(overridden, 'NEW-ARCH')?.lifecycle, 'ARCHIVED')
  assert.deepEqual(findings(overridden, 'ARCHIVED_WITH_STOCK_OVERRIDE').map((f) => f.message), ['NEW-ARCH is archived although Qoblex stock at generation MIL1 3, Qoblex stock in this run MIL1 3, WooCommerce stock at generation 2, WMS physical stock at generation 3; override reason: stock to be written off (synthetic)'])
  assert.equal(findings(overridden, 'ARCHIVED_WITH_STOCK_OVERRIDE')[0].severity, 'WARNING')
})

test('Archived is cleared only by figures that were READ: no stock anywhere is applied; a WMS not read needs a reason; a variation\'s own Woo stock (MED-5) refuses it', () => {
  const clean = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' }, 'VAR-02': { status: 'Archived' } }), 'xlsx')))
  assert.equal(lifecycleOf(clean, 'SIM-PRIV')?.lifecycle, 'ARCHIVED', 'Qoblex 0, Woo not managed, WMS 0: nothing holds stock')
  assert.deepEqual(disp(clean, 'ARCHIVED_WITH_STOCK'), ['REJECTED VAR-02'])
  assert.match(clean.report.dispositions.find((d) => d.key === 'VAR-02')!.reason, /^Archived is refused: WooCommerce stock at generation 3 \(/)
  const noWms = prepareWith(manifestWith(generationOf(withoutWms), writeDecisions(fill(withoutWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' } }), 'xlsx')))
  assert.deepEqual(disp(noWms, 'ARCHIVED_WITH_STOCK'), ['REJECTED SIM-PRIV'])
  assert.match(noWms.report.dispositions.find((d) => d.key === 'SIM-PRIV')!.reason, /WMS physical stock at generation not read/)
})

test('a fresher Qoblex stock export counts too: stock that appeared after the sheet was generated refuses Archived', () => {
  const stock = path.join(fx.root, 'qoblex', 'stock-later.csv')
  writeFileSync(stock, `${QOBLEX_STOCK}SIM-PRIV,CAMB,2,1.00\r\n`)
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' } }), 'xlsx'), (m) => {
    for (const input of m.inputs as Array<{ dataset: string; file: string }>) if (input.dataset === 'stock-lots') input.file = stock
  })
  const r = prepareWith(manifest)
  assert.deepEqual(disp(r, 'ARCHIVED_WITH_STOCK'), ['REJECTED SIM-PRIV'])
  assert.match(r.report.dispositions.find((d) => d.key === 'SIM-PRIV')!.reason, /Qoblex stock in this run CAMB 2/)
  assert.deepEqual(findings(r, 'LIFECYCLE_REVIEW_INPUTS_CHANGED').map((f) => f.severity), ['WARNING'], 'a run on other inputs than the sheet is never silent')
  assert.match(findings(r, 'LIFECYCLE_REVIEW_INPUTS_CHANGED')[0].message, /the stock-lots file\(s\)/)
})

test('refused rows: an unknown SKU (added to the export), a status that is not one of the four, a SKU listed twice', () => {
  const bytes = csvExport(withWms, { ...ALL_DECIDED, 'SIM-DRAFT': { status: 'Retired' } }, (rows, header) => {
    const sku = header.indexOf('IMS SKU')
    const sheetId = header.indexOf('Sheet id')
    const status = header.indexOf('New IMS status')
    const template = rows.find((r) => r[sku] === 'NEW-1')!
    rows.push(template.map((v, i) => (i === sku ? 'SIM-PUB' : i === status ? 'Archived' : v)))
    rows.push(template.map((v, i) => (i === sku ? 'NOPE-404' : v)))
    rows.push(template.map((v, i) => (i === status ? 'Discontinued' : i === sheetId ? v : v)))
  })
  const r = prepareWith(manifestWith(generationOf(withWms), writeDecisions(bytes, 'csv')))
  assert.deepEqual(disp(r, 'UNKNOWN_SKU').sort(), ['REJECTED NOPE-404', 'REJECTED SIM-PUB'])
  assert.deepEqual(disp(r, 'BAD_STATUS'), ['REJECTED SIM-DRAFT'])
  assert.deepEqual(disp(r, 'DUPLICATE_DECISION'), ['REJECTED NEW-1', 'REJECTED NEW-1'])
  assert.notEqual(lifecycleOf(r, 'NEW-1')?.lifecycleSource, 'decision', 'neither of two conflicting rows is applied')
  assert.equal(lifecycleOf(r, 'SIM-DRAFT')?.lifecycle, 'DRAFT')
  assert.ok(r.blocking)
  assert.deepEqual(findings(r, 'LIFECYCLE_DECISION_MISSING'), [], 'a refused row is reported as refused, not again as missing')
  assert.ok(r.report.accountingBalanced, 'every row has exactly one disposition')
})

test('a review-set row left blank BLOCKS a real prepare (ERROR) and is only reported by a dry run (WARNING); a row deleted from the export counts as blank', async () => {
  const partial = Object.fromEntries(Object.entries(ALL_DECIDED).filter(([sku]) => sku !== 'NEW-1'))
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, partial), 'xlsx'))
  const real = prepareWith(manifest)
  assert.deepEqual(findings(real, 'LIFECYCLE_DECISION_MISSING').map((f) => [f.severity, f.keys]), [['ERROR', ['NEW-1']]])
  assert.ok(real.blocking)
  assert.equal(real.outputs.length, 0)
  assert.deepEqual(disp(real, 'UNDECIDED'), ['EXCLUDED NEW-1'])
  const dry = prepareWith(manifest, true)
  assert.deepEqual(findings(dry, 'LIFECYCLE_DECISION_MISSING').map((f) => [f.severity, f.keys]), [['WARNING', ['NEW-1']]])
  assert.match(findings(dry, 'LIFECYCLE_DECISION_MISSING')[0].message, /a real prepare is BLOCKED/)
  // Through the CLI: the real run exits BLOCKING_FINDINGS, the dry run does not block on it.
  let stdout = ''
  assert.equal(await runPrepare(['--manifest', manifest, '--out', fx.fresh('blocked')], { stdout: () => {}, stderr: () => {} }), EXIT_CODES.BLOCKING_FINDINGS)
  assert.equal(await runPrepare(['--manifest', manifest, '--dry-run'], { stdout: (s) => (stdout += s), stderr: () => {} }), EXIT_CODES.OK)
  assert.match(stdout, /LIFECYCLE_DECISION_MISSING/)
  const deleted = csvExport(withWms, ALL_DECIDED, (rows, header) => { rows.splice(rows.findIndex((r) => r[header.indexOf('IMS SKU')] === 'SIM-PRIV'), 1) })
  const gone = prepareWith(manifestWith(generationOf(withWms), writeDecisions(deleted, 'csv')))
  assert.deepEqual(findings(gone, 'LIFECYCLE_DECISION_MISSING').map((f) => f.keys), [['SIM-PRIV']])
  // The review named but no decisions file at all: every review-set product is undecided.
  const none = prepareWith(manifestWith(generationOf(withWms), null))
  assert.deepEqual(findings(none, 'LIFECYCLE_DECISION_MISSING').map((f) => f.keys), [['NEW-1', 'NEW-ARCH', 'SIM-DRAFT', 'SIM-PRIV', 'VAR-02']])
})

test('the CSV export of the Review tab and a canonical lifecycle-decisions file read back the same decisions as the .xlsx', () => {
  const fromCsv = prepareWith(manifestWith(generationOf(withWms), writeDecisions(csvExport(withWms, ALL_DECIDED), 'csv')))
  const sheetId = JSON.parse(readFileSync(generationOf(withWms), 'utf8')).sheetId as string
  const canonical = serializeCsv(['sku', 'status', 'reason', 'sheetId'], Object.entries(ALL_DECIDED).map(([sku, d]) => [sku, d.status, d.reason ?? '', sheetId]))
  const fromCanonical = prepareWith(manifestWith(generationOf(withWms), writeDecisions(Buffer.from(canonical), 'csv')))
  for (const r of [fromCsv, fromCanonical]) {
    assert.equal(emitted(r, 'LIFECYCLE_DECIDED'), 5)
    assert.deepEqual(findings(r, 'LIFECYCLE_DECISION_MISSING'), [])
    assert.deepEqual(findings(r, 'LIFECYCLE_DECISIONS_NOT_BOUND'), [])
  }
})

test('the decisions are BOUND to one sheet generation: another sheet, a missing hidden tab, an edited record or no lifecycleReview refuses them all', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['decisions made on another generation', manifestWith(generationOf(withWms), writeDecisions(fill(withoutWms, ALL_DECIDED), 'xlsx')), /made on another sheet/],
    ['the hidden binding tab deleted', manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED, { keepBinding: false }), 'xlsx')), /hidden binding tab is missing/],
    ['a CSV whose sheet ids were cleared', manifestWith(generationOf(withWms), writeDecisions(csvExport(withWms, ALL_DECIDED, (rows, header) => { for (const r of rows) r[header.indexOf('Sheet id')] = '' }), 'csv')), /no decision row carries a Sheet id/],
    ['no lifecycleReview in the manifest', manifestWith(null, writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx')), /does not name lifecycleReview\.generation/],
  ]
  const edited = path.join(fx.root, 'edited.generation.json')
  writeFileSync(edited, readFileSync(generationOf(withWms), 'utf8').replace('"qoblexStock": "3"', '"qoblexStock": "0"'))
  assert.notEqual(readFileSync(edited, 'utf8'), readFileSync(generationOf(withWms), 'utf8'), 'precondition: the record was edited')
  cases.push(['an edited generation record', manifestWith(edited, writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx')), /digest does not match/])
  for (const [label, manifest, why] of cases) {
    const r = prepareWith(manifest)
    const refusal = findings(r, 'LIFECYCLE_DECISIONS_NOT_BOUND')
    assert.equal(refusal.length, 1, label)
    assert.equal(refusal[0].severity, 'ERROR', label)
    assert.match(refusal[0].message, why, label)
    assert.equal(emitted(r, 'LIFECYCLE_DECIDED'), 0, `${label}: nothing applied`)
    assert.equal(lifecycleOf(r, 'SIM-DRAFT')?.lifecycle, 'DRAFT', label)
    assert.ok(r.report.accountingBalanced, label)
  }
})

test('a decision cell that holds a formula makes the file unusable (exit 3): a decision is typed or picked, never computed', async () => {
  const sheets = readXlsx(fill(withWms, ALL_DECIDED))
  const review = grid(sheets.find((s) => s.name === REVIEW_TAB)!)
  // Rebuild with a formula element in the status cell of row 2 (the writer never writes one, so it is spliced into the XML).
  const header = review[0]
  const col = header.indexOf('New IMS status')
  const bytes = writeXlsx([{ name: REVIEW_TAB, rows: review.map((r) => r.map((v): XCell => ({ v }))) }, { name: BINDING_TAB, state: 'hidden', rows: grid(sheets.find((s) => s.name === BINDING_TAB)!).map((r) => r.map((v): XCell => ({ v }))) }])
  const { unzip, zip } = await import('../../lib/first-load/lifecycle-review/xlsx.ts')
  const parts = unzip(bytes)
  const letter = String.fromCharCode(65 + col)
  const rowNo = review.findIndex((r) => r[header.indexOf('IMS SKU')] === 'NEW-1') + 1
  const xml = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8').replace(new RegExp(`<c r="${letter}${rowNo}" s="(\\d+)" t="inlineStr"><is><t xml:space="preserve">([^<]*)</t></is></c>`), `<c r="${letter}${rowNo}" t="str"><f>"Act"&amp;"ive"</f><v>Active</v></c>`)
  assert.ok(xml.includes('<f>'), 'precondition: the formula was spliced in')
  parts.set('xl/worksheets/sheet1.xml', Buffer.from(xml))
  const manifest = manifestWith(generationOf(withWms), writeDecisions(zip([...parts.entries()]), 'xlsx'))
  let stderr = ''
  assert.equal(await runPrepare(['--manifest', manifest, '--dry-run'], { stdout: () => {}, stderr: (s) => (stderr += s) }), EXIT_CODES.INPUT_UNUSABLE)
  assert.match(stderr, /holds a formula/)
})

// [mutation: U+FFFD is not refused in a decision cell, or is refused in a column that is not read (a name)] (#1123 R1 MED-2)
test('#1123 MED-2: U+FFFD in a decision cell (.xlsx, Review CSV or canonical CSV) makes the file unusable (exit 3); in a product name it is ignored', async () => {
  const { readDecisionFile } = await import('../../lib/first-load/lifecycle-review/read-back.ts')
  const named = readXlsx(fill(withWms, ALL_DECIDED))
  const review = grid(named.find((s) => s.name === REVIEW_TAB)!)
  const nameCol = review[0].indexOf('Name')
  assert.ok(nameCol >= 0, 'precondition: the Name column')
  review[1][nameCol] = 'Mug \ufffd lost'
  const withLostName = writeXlsx([{ name: REVIEW_TAB, rows: review.map((r) => r.map((v): XCell => ({ v }))) }, { name: BINDING_TAB, state: 'hidden', rows: grid(named.find((s) => s.name === BINDING_TAB)!).map((r) => r.map((v): XCell => ({ v }))) }])
  assert.equal(readDecisionFile(withLostName).ok, true, 'a lost character in a product name is not a decision')
  const lostReason = fill(withWms, { ...ALL_DECIDED, 'NEW-ARCH': { status: 'Archived', reason: 'write\ufffdoff' } })
  const xlsx = readDecisionFile(lostReason)
  assert.equal(xlsx.ok, false)
  assert.match(!xlsx.ok ? xlsx.problems.join('; ') : '', /^row \d+: the Override reason cell holds U\+FFFD, a character lost in a conversion/)
  const csv = readDecisionFile(csvExport(withWms, { ...ALL_DECIDED, 'SIM-DRAFT': { status: 'Act\ufffdve' } }))
  assert.match(!csv.ok ? csv.problems.join('; ') : '', /^line \d+: the New IMS status cell holds U\+FFFD/)
  const canon = readDecisionFile(canonical(withWms, [['SIM\ufffdDRAFT', 'Active']]))
  assert.match(!canon.ok ? canon.problems.join('; ') : '', /^line 2: the sku cell holds U\+FFFD/)
  let stderr = ''
  assert.equal(await runPrepare(['--manifest', manifestWith(generationOf(withWms), writeDecisions(lostReason, 'xlsx')), '--dry-run'], { stdout: () => {}, stderr: (s) => (stderr += s) }), EXIT_CODES.INPUT_UNUSABLE)
  assert.match(stderr, /Override reason cell holds U\+FFFD/)
})

test('the manifest refuses a column map or a second file for lifecycle-decisions, and a malformed lifecycleReview (usage, exit 2)', async () => {
  const decisions = writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx')
  for (const [label, manifest, why] of [
    ['a column map', manifestWith(generationOf(withWms), null, (m) => { (m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file: decisions, columnMap: 'qoblex/qoblex.map.json' }) }), /takes no columnMap/],
    ['two files', manifestWith(generationOf(withWms), decisions, (m) => { (m.inputs as unknown[]).push({ dataset: 'lifecycle-decisions', file: writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx') }) }), /may be listed once/],
    ['lifecycleReview without generation', manifestWith(null, decisions, (m) => { m.lifecycleReview = { sheet: 'x' } }), /lifecycleReview must be an object/],
  ] as const) {
    let stderr = ''
    assert.equal(await runPrepare(['--manifest', manifest, '--dry-run'], { stdout: () => {}, stderr: (s) => (stderr += s) }), EXIT_CODES.USAGE, label)
    assert.match(stderr, why, label)
  }
})

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// #1122 R1: the review set recomputed from this run (MED-1), any single warehouse (MED-2), VARIABLE parents (MED-3), protection (MED-4), L6, L13
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const withProducts = (text: string) => (m: Record<string, unknown>) => {
  const file = path.join(fx.root, 'qoblex', `products-${Math.random().toString(16).slice(2)}.csv`)
  writeFileSync(file, text)
  for (const input of m.inputs as Array<{ dataset: string; file: string }>) if (input.dataset === 'products') input.file = file
}
const LATER_PRODUCTS = QOBLEX_PRODUCTS.replace('Simple published,SIM-PUB,Active,simple', 'Simple published,SIM-PUB,Archived,simple')

// [mutation: the review set is not recomputed (the generation's is trusted), or a new member is only a WARNING in a real prepare] (MED-1)
test('MED-1: a product that became Archived in a fresher Qoblex export is in THIS run\'s review set: undecided it blocks a real prepare (ERROR naming it), a dry run warns, a decision row settles it', () => {
  assert.ok(LATER_PRODUCTS !== QOBLEX_PRODUCTS, 'precondition: the export changed')
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx'), withProducts(LATER_PRODUCTS))
  const real = prepareWith(manifest)
  assert.deepEqual(findings(real, 'LIFECYCLE_REVIEW_SET_CHANGED').map((f) => [f.severity, f.keys]), [['ERROR', ['SIM-PUB']]])
  assert.match(findings(real, 'LIFECYCLE_REVIEW_SET_CHANGED')[0].message, /SIM-PUB \(Qoblex Archived\).*generate the sheet again and have it filled, or add a decision row/)
  assert.ok(real.blocking)
  assert.match(findings(real, 'LIFECYCLE_REVIEW_INPUTS_CHANGED')[0].message, /the products file\(s\)\)\. Stale figures an Archived decision is checked against: the WMS physical stock \(read when the sheet was generated; this run does not read the WMS\)/)
  const dry = prepareWith(manifest, true)
  assert.deepEqual(findings(dry, 'LIFECYCLE_REVIEW_SET_CHANGED').map((f) => f.severity), ['WARNING'])
  assert.match(findings(dry, 'LIFECYCLE_REVIEW_SET_CHANGED')[0].message, /A real prepare is BLOCKED until then/)
  // Decided in the decisions file (a canonical row for the new member): settled, applied, and Archived is checked against THIS run's figures.
  const decided = prepareWith(manifestWith(generationOf(withWms), writeDecisions(canonical(withWms, [...Object.entries(ALL_DECIDED).map(([sku, d]): [string, string] => [sku, d.status]), ['SIM-PUB', 'Do not sell yet']]), 'csv'), withProducts(LATER_PRODUCTS)))
  assert.deepEqual(findings(decided, 'LIFECYCLE_REVIEW_SET_CHANGED'), [])
  assert.deepEqual([lifecycleOf(decided, 'SIM-PUB')?.lifecycle, lifecycleOf(decided, 'SIM-PUB')?.lifecycleSource], ['DRAFT', 'decision'])
  const archived = prepareWith(manifestWith(generationOf(withWms), writeDecisions(canonical(withWms, [...Object.entries(ALL_DECIDED).map(([sku, d]): [string, string] => [sku, d.status]), ['SIM-PUB', 'Archived']]), 'csv'), withProducts(LATER_PRODUCTS)))
  assert.equal(archived.report.dispositions.find((d) => d.key === 'SIM-PUB' && d.dataset === 'lifecycle-decisions')!.reason, 'Archived is refused: Qoblex stock in this run MIL1 5, WooCommerce stock in this run 7, WMS physical stock at generation not read (not on the review sheet) (a figure that was not read cannot prove there is no stock). Fill the Override reason to archive it anyway')
})

// [mutation: the recompute ignores the WooCommerce own or parent status] (MED-1, L10)
test('MED-1: a product that became draft in a fresher WooCommerce snapshot, and the variations of a parent that became draft, join this run\'s review set', () => {
  const r = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx')), false, (input) => {
    const snapshot = structuredClone(input.lifecycleReviewInputs!.snapshot)
    for (const p of snapshot.products) if (p.sku === 'SIM-PUB' || p.sku === 'VAR-PARENT') p.status = 'draft'
    for (const p of snapshot.parents) if (p.sku === 'VAR-PARENT') p.status = 'draft'
    input.lifecycleReviewInputs = { ...input.lifecycleReviewInputs!, snapshot }
  })
  const changed = findings(r, 'LIFECYCLE_REVIEW_SET_CHANGED')
  assert.deepEqual(changed.map((f) => f.keys), [['SIM-PUB', 'VAR-01', 'VAR-PARENT']])
  assert.match(changed[0].message, /SIM-PUB \(WooCommerce draft\), VAR-01 \(WooCommerce parent draft\), VAR-PARENT \(WooCommerce draft\)/)
})

/** A fresher WooCommerce snapshot (a test seam: this run's snapshot changed, and the generation names another one, as a real re-snapshot would). */
const fresherSnapshot = (change: (products: Array<{ sku: string; status: string; manageStock: boolean | 'parent'; stockQuantity: number | null }>) => void) => (input: Input) => {
  const snapshot = structuredClone(input.lifecycleReviewInputs!.snapshot)
  change(snapshot.products as Array<{ sku: string; status: string; manageStock: boolean | 'parent'; stockQuantity: number | null }>)
  input.lifecycleReviewInputs = { ...input.lifecycleReviewInputs!, snapshot }
  generationIn(input).generation.inputs.snapshotPayloadSha256 = 'f'.repeat(64)
}

// [mutation: this run's WooCommerce stock is only taken for products still in the review set] (#1123 R1 MED-1)
test('#1123 MED-1: a product draft with stock 0 at generation and published with stock since has LEFT the review set; Archived is still checked against this run\'s WooCommerce stock', () => {
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-DRAFT': { status: 'Archived' } }), 'xlsx'))
  const unchanged = prepareWith(manifest, false, fresherSnapshot(() => {}))
  assert.equal(lifecycleOf(unchanged, 'SIM-DRAFT')?.lifecycle, 'ARCHIVED', 'precondition: with no stock anywhere, Archived is applied on another snapshot')
  const published = prepareWith(manifest, false, fresherSnapshot((products) => {
    const p = products.find((x) => x.sku === 'SIM-DRAFT')!
    p.status = 'publish'
    p.manageStock = true
    p.stockQuantity = 10
  }))
  assert.deepEqual(findings(published, 'LIFECYCLE_REVIEW_SET_CHANGED'), [], 'precondition: SIM-DRAFT is no longer in this run\'s review set')
  assert.deepEqual(disp(published, 'ARCHIVED_WITH_STOCK'), ['REJECTED SIM-DRAFT'])
  assert.match(published.report.dispositions.find((d) => d.dataset === 'lifecycle-decisions' && d.key === 'SIM-DRAFT')!.reason, /^Archived is refused: WooCommerce stock in this run 10 \(/)
  assert.notEqual(lifecycleOf(published, 'SIM-DRAFT')?.lifecycle, 'ARCHIVED')
})

// [mutation: a carried WMS-discontinued row reads its WooCommerce stock as "not read"] (#1123 R1 L4)
test('#1123 L4: a WMS-discontinued row carried into this run\'s review set takes this run\'s WooCommerce figure: 0 clears Archived, stock refuses it', () => {
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'NEW-1': { status: 'Archived' } }), 'xlsx'))
  const zero = prepareWith(manifest, false, fresherSnapshot(() => {}))
  assert.deepEqual(disp(zero, 'ARCHIVED_WITH_STOCK'), [])
  assert.equal(lifecycleOf(zero, 'NEW-1')?.lifecycle, 'ARCHIVED', 'WooCommerce 0 in this run, WMS 0 and no Qoblex stock: nothing holds stock')
  const stocked = prepareWith(manifest, false, fresherSnapshot((products) => { products.find((x) => x.sku === 'NEW-1')!.stockQuantity = 4 }))
  assert.deepEqual(disp(stocked, 'ARCHIVED_WITH_STOCK'), ['REJECTED NEW-1'])
  assert.match(stocked.report.dispositions.find((d) => d.dataset === 'lifecycle-decisions' && d.key === 'NEW-1')!.reason, /^Archived is refused: WooCommerce stock in this run 4 \(/)
})

// [mutation: a run without the recompute inputs is silently accepted] (MED-1)
test('MED-1: a run that cannot recompute the review set (no verified snapshot handed over) is an ERROR in a real prepare and a WARNING in a dry run', () => {
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx'))
  const drop = (input: Input) => { input.lifecycleReviewInputs = undefined }
  assert.deepEqual(findings(prepareWith(manifest, false, drop), 'LIFECYCLE_REVIEW_SET_UNCHECKED').map((f) => f.severity), ['ERROR'])
  assert.deepEqual(findings(prepareWith(manifest, true, drop), 'LIFECYCLE_REVIEW_SET_UNCHECKED').map((f) => f.severity), ['WARNING'])
  assert.deepEqual(findings(prepareWith(manifest), 'LIFECYCLE_REVIEW_SET_UNCHECKED'), [], 'the CLI hands them over')
})

// [mutation: the Archived check sums the warehouses (this run's stock-lots or the sheet's figures)] (MED-2)
test('MED-2: Archived is refused when ANY single Qoblex warehouse is above zero, in this run or at generation, although the total is 0', () => {
  const stock = path.join(fx.root, 'qoblex', 'stock-split.csv')
  writeFileSync(stock, `${QOBLEX_STOCK}SIM-PRIV,MIL1,5,1.00\r\nSIM-PRIV,CAMB,-5,1.00\r\n`)
  const decisions = writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' } }), 'xlsx')
  const now = prepareWith(manifestWith(generationOf(withWms), decisions, (m) => { for (const input of m.inputs as Array<{ dataset: string; file: string }>) if (input.dataset === 'stock-lots') input.file = stock }))
  assert.match(now.report.dispositions.find((d) => d.dataset === 'lifecycle-decisions' && d.key === 'SIM-PRIV')!.reason, /^Archived is refused: Qoblex stock in this run MIL1 5 \(/)
  const atGeneration = prepareWith(manifestWith(generationOf(withWms), decisions), false, (input) => {
    const entry = generationIn(input).generation.review.find((e) => e.sku === 'SIM-PRIV')!
    entry.qoblexByWarehouse = { MIL1: '4', CAMB: '-4' }
    entry.qoblexStock = '0'
  })
  assert.match(atGeneration.report.dispositions.find((d) => d.dataset === 'lifecycle-decisions' && d.key === 'SIM-PRIV')!.reason, /^Archived is refused: Qoblex stock at generation MIL1 4 \(/)
})

/** The sheet's review set with the VARIABLE parent VAR-PARENT and its other variation VAR-01 added (a hand-made generation, as if the parent were draft). */
const withParentInReview = (input: Input) => {
  const review = generationIn(input).generation.review
  review.push(
    { sku: 'VAR-PARENT', proposed: 'ACTIVE', reasons: ['WooCommerce draft'], qoblexStock: '0', qoblexByWarehouse: {}, wooStock: { kind: 'unmanaged' }, wmsStock: { kind: 'absent' }, variations: [
      { sku: 'VAR-01', qoblexByWarehouse: {}, wooStock: { kind: 'qty', qty: '0' }, wmsStock: { kind: 'qty', qty: '0' } },
      { sku: 'VAR-02', qoblexByWarehouse: { CAMB: '0' }, wooStock: { kind: 'qty', qty: '3' }, wmsStock: { kind: 'qty', qty: '0' } },
    ] },
    { sku: 'VAR-01', proposed: 'ACTIVE', reasons: ['WooCommerce parent draft'], qoblexStock: '0', qoblexByWarehouse: {}, wooStock: { kind: 'qty', qty: '0' }, wmsStock: { kind: 'qty', qty: '0' } },
  )
}
const decide = (rows: Array<[string, string, string?]>) => manifestWith(generationOf(withWms), writeDecisions(canonical(withWms, [...Object.entries(ALL_DECIDED).filter(([sku]) => !rows.some((r) => r[0] === sku)).map(([sku, d]): [string, string] => [sku, d.status]), ...rows]), 'csv'))

// [mutation: Archived on a VARIABLE parent is not checked against its variations' lifecycles or stock] (MED-3)
test('MED-3: Archived on a VARIABLE parent is refused while any variation loads with another lifecycle (no override lifts it), and its variations\' stock counts as its own', () => {
  const mixed = prepareWith(decide([['VAR-PARENT', 'Archived', 'synthetic'], ['VAR-01', 'Active'], ['VAR-02', 'Archived', 'synthetic write-off']]), false, withParentInReview)
  assert.deepEqual(disp(mixed, 'VARIATION_NOT_ARCHIVED'), ['REJECTED VAR-PARENT'])
  assert.match(mixed.report.dispositions.find((d) => d.code === 'VARIATION_NOT_ARCHIVED')!.reason, /its variation\(s\) VAR-01 \(ACTIVE\) would still load with another lifecycle/)
  assert.notEqual(lifecycleOf(mixed, 'VAR-PARENT')?.lifecycle, 'ARCHIVED')
  const stocked = prepareWith(decide([['VAR-PARENT', 'Archived'], ['VAR-01', 'Archived'], ['VAR-02', 'Archived', 'synthetic write-off']]), false, withParentInReview)
  assert.deepEqual(disp(stocked, 'ARCHIVED_WITH_STOCK'), ['REJECTED VAR-PARENT'])
  assert.match(stocked.report.dispositions.find((d) => d.key === 'VAR-PARENT' && d.dataset === 'lifecycle-decisions')!.reason, /^Archived is refused: variation VAR-02: WooCommerce stock at generation 3 \(/)
  const overridden = prepareWith(decide([['VAR-PARENT', 'Archived', 'synthetic: the variation stock is written off'], ['VAR-01', 'Archived'], ['VAR-02', 'Archived', 'synthetic write-off']]), false, withParentInReview)
  assert.deepEqual(['VAR-PARENT', 'VAR-01', 'VAR-02'].map((sku) => lifecycleOf(overridden, sku)?.lifecycle), ['ARCHIVED', 'ARCHIVED', 'ARCHIVED'])
  assert.match(findings(overridden, 'ARCHIVED_WITH_STOCK_OVERRIDE').find((f) => f.keys?.[0] === 'VAR-PARENT')!.message, /variation VAR-02: WooCommerce stock at generation 3; override reason: synthetic: the variation stock is written off/)
})

// [mutation: a decided row with a blank sheet id is accepted beside rows that carry it] (L6)
test('L6: a decided row without a Sheet id refuses the whole file, even when every other row carries the right one', () => {
  const rows = Object.entries(ALL_DECIDED).map(([sku, d], i): [string, string, string, string] => [sku, d.status, '', i === 0 ? '' : sheetIdOf(withWms)])
  const r = prepareWith(manifestWith(generationOf(withWms), writeDecisions(canonical(withWms, rows), 'csv')))
  assert.match(findings(r, 'LIFECYCLE_DECISIONS_NOT_BOUND')[0].message, /1 decided row\(s\) carry no Sheet id \(line\(s\) 2\)/)
  assert.equal(emitted(r, 'LIFECYCLE_DECIDED'), 0)
})

// [mutation: the file-SHA binding, SKU_EXCLUDED, the exact-case PRODUCT_NOT_LOADED check or the exclusions in the missing list are removed] (L13)
test('L13: other bytes than the bound ones, a decided SKU on sku-exclusions, a SKU the catalogue holds in another letter case', () => {
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx'))
  const otherBytes = prepareWith(manifest, false, (input) => { generationIn(input).fileSha256 = 'f'.repeat(64) })
  assert.match(findings(otherBytes, 'LIFECYCLE_DECISIONS_NOT_BOUND')[0].message, /the lifecycle-decisions bytes read are not the bytes that were bound/)
  const exclusions = path.join(fx.root, 'qoblex', 'exclusions.csv')
  writeFileSync(exclusions, 'sku,reason\r\nSIM-DRAFT,synthetic: not loaded\r\n')
  const excluding = (m: Record<string, unknown>) => { (m.inputs as unknown[]).push({ dataset: 'sku-exclusions', file: exclusions }) }
  const excluded = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, ALL_DECIDED), 'xlsx'), excluding))
  assert.deepEqual(disp(excluded, 'SKU_EXCLUDED'), ['EXCLUDED SIM-DRAFT'])
  const undecided = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, Object.fromEntries(Object.entries(ALL_DECIDED).filter(([sku]) => sku !== 'SIM-DRAFT'))), 'xlsx'), excluding))
  assert.deepEqual(findings(undecided, 'LIFECYCLE_DECISION_MISSING'), [], 'an excluded SKU is not missing a decision')
  const lower = prepareWith(manifestWith(generationOf(withWms), writeDecisions(canonical(withWms, [...Object.entries(ALL_DECIDED).map(([sku, d]): [string, string] => [sku, d.status]), ['sim-pub', 'Active']]), 'csv')), false, (input) => {
    generationIn(input).generation.review.push({ sku: 'sim-pub', proposed: 'ACTIVE', reasons: ['Qoblex Archived'], qoblexStock: '0', qoblexByWarehouse: {}, wooStock: { kind: 'absent' }, wmsStock: { kind: 'absent' } })
  })
  assert.deepEqual(disp(lower, 'PRODUCT_NOT_LOADED'), ['REJECTED sim-pub'])
  assert.equal(lifecycleOf(lower, 'SIM-PUB')?.lifecycleSource, 'qoblex', 'the decision for another letter case is not applied to SIM-PUB')
})

// [mutation: the reader refuses a protected sheet] (MED-4)
test('MED-4: the filled sheet still reads when the program that saved it kept the protection (Excel\'s hashed form, LibreOffice\'s legacy form)', async () => {
  const { unzip, zip } = await import('../../lib/first-load/lifecycle-review/xlsx.ts')
  for (const protection of [
    '<sheetProtection algorithmName="SHA-512" hashValue="c2FsdA==" saltValue="c2FsdA==" spinCount="100000" sheet="1" objects="1" scenarios="1" autoFilter="0"/>',
    '<sheetProtection sheet="true" password="CC1A" objects="true" scenarios="true" formatColumns="false" autoFilter="false"/>',
  ]) {
    const parts = unzip(fill(withWms, ALL_DECIDED))
    const xml = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8').replace('</sheetData>', `</sheetData>${protection}`)
    assert.ok(xml.includes('sheetProtection'), 'precondition: the protection was spliced in')
    parts.set('xl/worksheets/sheet1.xml', Buffer.from(xml))
    const r = prepareWith(manifestWith(generationOf(withWms), writeDecisions(zip([...parts.entries()]), 'xlsx')))
    assert.equal(emitted(r, 'LIFECYCLE_DECIDED'), 5)
  }
})

// [mutation: the read-back's last row is Math.max(...rows) again (a RangeError past about 125,000 rows)] (L2)
test('L2: a Review tab with 200,000 rows reads back (no spread of every row number into one call)', async () => {
  const { readDecisionFile } = await import('../../lib/first-load/lifecycle-review/read-back.ts')
  const rows: XCell[][] = [[{ v: 'IMS SKU' }, { v: 'New IMS status' }, { v: 'Override reason' }, { v: 'Sheet id' }]]
  for (let i = 0; i < 200_000; i++) rows.push([{ v: `S${i}` }])
  const read = readDecisionFile(writeXlsx([{ name: REVIEW_TAB, rows }, { name: BINDING_TAB, state: 'hidden', rows: [[{ v: 'sheetId' }, { v: 'LR-0' }], [{ v: 'generationDigest' }, { v: 'x' }]] }]))
  assert.ok(read.ok, read.ok ? '' : read.problems.join('; '))
  if (read.ok) assert.equal(read.canonicalCsv.split('\r\n').filter(Boolean).length, 200_001)
})
