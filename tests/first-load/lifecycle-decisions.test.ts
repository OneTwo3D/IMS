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
import { buildFixture, fakeWms, QOBLEX_STOCK, type Fixture } from './lifecycle-review-fixture.ts'
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

function prepareWith(manifest: string, dryRun = false): PrepareResult {
  let stderr = ''
  const loaded = loadPrepareRun(manifest, { stdout: () => {}, stderr: (s) => (stderr += s) }, { runId: 't' })
  assert.ok(loaded.ok, stderr)
  if (!loaded.ok) throw new Error(stderr)
  const { config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding } = loaded.run
  return prepare({ config, datasets, variantParentsBinding, productStatusBinding, lifecycleDecisionsBinding, dryRun })
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
  assert.match(refused.report.dispositions.find((d) => d.code === 'ARCHIVED_WITH_STOCK')!.reason, /Qoblex stock at generation 3, Qoblex stock in this run 3, WooCommerce stock 2, WMS physical stock 3/)
  assert.ok(refused.blocking)
  assert.equal(lifecycleOf(refused, 'NEW-ARCH')?.lifecycle, 'ACTIVE', 'a refused decision changes nothing')
  const overridden = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'NEW-ARCH': { status: 'Archived', reason: 'stock to be written off (synthetic)' } }), 'xlsx')))
  assert.deepEqual(disp(overridden, 'ARCHIVED_WITH_STOCK'), [])
  assert.equal(lifecycleOf(overridden, 'NEW-ARCH')?.lifecycle, 'ARCHIVED')
  assert.deepEqual(findings(overridden, 'ARCHIVED_WITH_STOCK_OVERRIDE').map((f) => f.message), ['NEW-ARCH is archived although Qoblex stock at generation 3, Qoblex stock in this run 3, WooCommerce stock 2, WMS physical stock 3; override reason: stock to be written off (synthetic)'])
  assert.equal(findings(overridden, 'ARCHIVED_WITH_STOCK_OVERRIDE')[0].severity, 'WARNING')
})

test('Archived is cleared only by figures that were READ: no stock anywhere is applied; a WMS not read, or a variation whose Woo stock the snapshot lacks, needs a reason', () => {
  const clean = prepareWith(manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' }, 'VAR-02': { status: 'Archived' } }), 'xlsx')))
  assert.equal(lifecycleOf(clean, 'SIM-PRIV')?.lifecycle, 'ARCHIVED', 'Qoblex 0, Woo not managed, WMS 0: nothing holds stock')
  assert.deepEqual(disp(clean, 'ARCHIVED_WITH_STOCK'), ['REJECTED VAR-02'])
  assert.match(clean.report.dispositions.find((d) => d.key === 'VAR-02')!.reason, /WooCommerce stock not read/)
  const noWms = prepareWith(manifestWith(generationOf(withoutWms), writeDecisions(fill(withoutWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' } }), 'xlsx')))
  assert.deepEqual(disp(noWms, 'ARCHIVED_WITH_STOCK'), ['REJECTED SIM-PRIV'])
  assert.match(noWms.report.dispositions.find((d) => d.key === 'SIM-PRIV')!.reason, /WMS physical stock not read/)
})

test('a fresher Qoblex stock export counts too: stock that appeared after the sheet was generated refuses Archived', () => {
  const stock = path.join(fx.root, 'qoblex', 'stock-later.csv')
  writeFileSync(stock, `${QOBLEX_STOCK}SIM-PRIV,CAMB,2,1.00\r\n`)
  const manifest = manifestWith(generationOf(withWms), writeDecisions(fill(withWms, { ...ALL_DECIDED, 'SIM-PRIV': { status: 'Archived' } }), 'xlsx'), (m) => {
    for (const input of m.inputs as Array<{ dataset: string; file: string }>) if (input.dataset === 'stock-lots') input.file = stock
  })
  const r = prepareWith(manifest)
  assert.deepEqual(disp(r, 'ARCHIVED_WITH_STOCK'), ['REJECTED SIM-PRIV'])
  assert.match(r.report.dispositions.find((d) => d.key === 'SIM-PRIV')!.reason, /Qoblex stock in this run 2/)
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
