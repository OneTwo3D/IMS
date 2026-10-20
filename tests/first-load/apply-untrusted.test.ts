import assert from 'node:assert/strict'
import test from 'node:test'

import { REHEARSAL_RECORD_FORMAT_VERSION, type ApplyExitName } from '../../lib/first-load/apply/constants.ts'
import { checkRecordBinding, checkRecordReportFile, checkRecordSchema, rehearsalCommandExit, restorePointPath, validateChildReport } from '../../lib/first-load/apply/cli.ts'
import { ApplyManifestError, parseApplyManifest } from '../../lib/first-load/apply/manifest.ts'
import { checkRehearsalGate } from '../../lib/first-load/apply/orchestrate.ts'
import { loadPreparedRun } from '../../lib/first-load/apply/prepared.ts'
import { parseBaseline, censusItems } from '../../lib/first-load/apply/verify-core.ts'
import { manifest, manifestText, prepareSynthetic, preparedFiles, withReport, type FileMap } from './apply-helpers.ts'
import { precondition } from './helpers.ts'

/**
 * EVERY FIELD READ FROM A FILE THAT REACHES TEXT. A prepared report, an apply manifest, a rehearsal record, a child report and the baseline kept in the database are all files or rows
 * this runner has not verified when it first reads them; whatever it prints (problems, stderr, reports) must not carry a value from them. Each arm below puts a MARKER in ONE field and
 * asserts (1) the field produced a refusal, so the arm is not vacuous, and (2) the marker is in no string that came out. The docs list the fields (docs/first-load-apply.md, "Fields read
 * from an unverified file"); each row has an arm here.
 */
const MARKER = 'ZQLEAK-7c1e9'
const honest: FileMap = preparedFiles(prepareSynthetic())
const encode = (s: string) => new TextEncoder().encode(s)

function preparedProblems(files: FileMap, overrides: Record<string, unknown> = {}): string[] {
  const loaded = loadPreparedRun({ manifest: manifest(overrides), files, woo: null })
  return loaded.ok ? [] : loaded.problems
}

function manifestProblems(edit: (m: Record<string, unknown>) => void): string[] {
  const m = JSON.parse(manifestText()) as Record<string, unknown>
  edit(m)
  try {
    parseApplyManifest(JSON.stringify(m))
    return []
  } catch (error) {
    assert.ok(error instanceof ApplyManifestError, 'only a closed manifest error escapes')
    return (error as ApplyManifestError).problems
  }
}

test('the prepared report and directory: a marker in every field the loader reads is never printed (and each field is refused)', (t) => {
  const arms: Array<[string, FileMap, Record<string, unknown>?]> = [
    ['an ERROR finding code', withReport(honest, (r) => { r.findings.push({ severity: 'ERROR', code: MARKER, message: MARKER, keys: [MARKER] }) })],
    ['an output file name', withReport(honest, (r) => { r.outputs[0]!.name = MARKER })],
    ['an output target', withReport(honest, (r) => { (r.outputs[0] as { target: string }).target = MARKER })],
    ['an output sha256', withReport(honest, (r) => { r.outputs[0]!.sha256 = MARKER })],
    ['the planned row count', withReport(honest, (r) => { (r.plannedOutputRows as Record<string, unknown>).products = MARKER })],
    ['the verdict', withReport(honest, (r) => { r.verdict = MARKER })],
    ['the tool', withReport(honest, (r) => { r.tool = MARKER })],
    ['the base currency', withReport(honest, (r) => { r.config.baseCurrency = MARKER })],
    ['the opening quantity total', withReport(honest, (r) => { r.stock.totals.openingQty = MARKER })],
    ['the opening value total', withReport(honest, (r) => { r.stock.totals.openingValueBase = MARKER })],
    ['a warehouse code the report lists', withReport(honest, (r) => { r.warehouseCodesUsed = [MARKER] })],
    ['a stray file name in the directory', new Map([...honest, [`${MARKER}.csv`, encode('x')]])],
    ['a stray file name with a path-like marker', new Map([...honest, [`..${MARKER}`, encode('x')]])],
  ]
  // Mutation: print finding.code / entry.name / the claimed value / the report's totals again and the matching arm is red.
  for (const [label, files, overrides] of arms) {
    const problems = preparedProblems(files, overrides)
    assert.ok(problems.length > 0, `${label}: the field is refused`)
    assert.ok(!problems.join('\n').includes(MARKER), `${label}: the marker is not printed: ${JSON.stringify(problems)}`)
  }
  precondition(t, 'prepared arms', arms.length)
})

test('a report that is not JSON, and a prepared directory read error, print no fragment of the file', () => {
  const garbage = new Map(honest); garbage.set('validation-report.json', encode(`oops ${MARKER}`))
  const problems = preparedProblems(garbage)
  assert.ok(problems.length > 0)
  assert.ok(!problems.join('\n').includes(MARKER))
})

test('the apply manifest: a marker in every field is never printed (and each field is refused)', (t) => {
  const arms: Array<[string, (m: Record<string, unknown>) => void]> = [
    ['an unknown key', (m) => { m[MARKER] = 1 }],
    ['the run id', (m) => { m.runId = MARKER + '!!' }],
    ['the base currency', (m) => { m.baseCurrency = MARKER }],
    ['a step', (m) => { m.steps = [MARKER] }],
    ['a warehouse code', (m) => { m.expectWarehouses = { [`${MARKER} !!`]: { type: 'STANDARD', availableForSale: true, syncToStore: false } } }],
    ['a warehouse profile key', (m) => { m.expectWarehouses = { OKCODE: { [MARKER]: 1, type: 'STANDARD', availableForSale: true, syncToStore: false } } }],
    ['a warehouse type', (m) => { m.expectWarehouses = { OKCODE: { type: MARKER, availableForSale: true, syncToStore: false } } }],
    ['an accepted zero-cost entry', (m) => { m.acceptZeroCost = [MARKER] }],
    ['a currency in fxRates', (m) => { m.fxRates = { [MARKER]: '1.25' } }],
    ['a rate in fxRates', (m) => { m.fxRates = { EUR: MARKER } }],
    ['a rate that is a number', (m) => { m.fxRates = { EUR: 1.25 } }],
    ['a forbidden SKU', (m) => { m.forbidSkus = [{ sku: MARKER }] }],
    ['the prepared directory', (m) => { m.preparedDir = { dir: MARKER } }],
    ['the restore directory', (m) => { m.restorePointDir = MARKER }],
    ['a wooSnapshot key', (m) => { m.wooSnapshot = { [MARKER]: 'x' } }],
    ['a wooSnapshot path', (m) => { m.wooSnapshot = { snapshot: 5, provenance: MARKER, variantParents: 'v', origin: MARKER, visibilityChecked: { [MARKER]: 1 } } }],
    ['the visibility attestation', (m) => { m.wooSnapshot = { snapshot: 's', provenance: 'p', variantParents: 'v', origin: 'https://shop.example', visibilityChecked: { products: { [MARKER]: 1 }, variations: MARKER } } }],
  ]
  for (const [label, edit] of arms) {
    const problems = manifestProblems(edit)
    assert.ok(problems.length > 0, `${label}: the field is refused`)
    assert.ok(!problems.join('\n').includes(MARKER), `${label}: the marker is not printed: ${JSON.stringify(problems)}`)
  }
  // Not JSON at all: the parser's own message quotes a fragment of the text.
  try { parseApplyManifest(`oops ${MARKER}`); assert.fail('parsed') } catch (error) { assert.ok(error instanceof ApplyManifestError); assert.ok(!(error as ApplyManifestError).problems.join('\n').includes(MARKER)) }
  precondition(t, 'manifest arms', arms.length + 1)
})

test('the baseline kept in the database: a marker as a table name is no baseline, so it can never reach the census text', (t) => {
  const D32 = 'a'.repeat(32)
  const arms: unknown[] = [
    { tables: { [MARKER]: 1 }, digests: {}, heldIds: [] },
    { tables: { ok: 1 }, digests: { [MARKER]: D32 }, heldIds: [] },
    { tables: { ok: 1 }, digests: { ok: MARKER }, heldIds: [] },
    { tables: { ok: 1 }, digests: {}, heldIds: [MARKER, 5] },
  ]
  for (const raw of arms) assert.equal(parseBaseline(raw), null, JSON.stringify(raw))
  // The held ids are compared and counted, never printed: a marker id only changes the counts.
  const items = censusItems({ tables: { ok: 1 }, digests: {}, heldIds: [MARKER] }, { tables: { ok: 1 }, digests: {}, heldIds: ['other'] })
  assert.ok(!JSON.stringify(items).includes(MARKER))
  precondition(t, 'baseline arms', arms.length + 1)
})

test('the rehearsal record and the child report: a marker in every field is never printed', (t) => {
  const record = { formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: 'd'.repeat(64), verdict: 'OK', systemId: 's', finishedAt: new Date().toISOString(), schemaHash: 'e'.repeat(64), loadExit: 'OK', targetUnchanged: true, teardownComplete: true, report: { file: 'r.json', sha256: 'a'.repeat(64), verificationItems: 17, verificationFailed: 0 } }
  const texts: string[] = []
  const fields = Object.keys(record) as Array<keyof typeof record>
  for (const field of fields) {
    const bad = { ...record, [field]: MARKER }
    texts.push(...checkRehearsalGate(bad, { manifestDigest: record.manifestDigest, systemId: 's', now: new Date(), maxAgeHours: 24 }), ...checkRecordBinding(bad), ...checkRecordSchema(bad, 'e'.repeat(64)))
  }
  for (const field of Object.keys(record.report) as Array<keyof typeof record.report>) {
    const bad = { ...record, report: { ...record.report, [field]: MARKER } }
    texts.push(...checkRecordBinding(bad), ...checkRecordReportFile(bad, 'b'.repeat(64), { tool: MARKER }, record.manifestDigest, ['suppliers']))
  }
  assert.ok(texts.length > 0)
  assert.ok(!texts.join('\n').includes(MARKER), 'no field of the record is printed')
  // The child report: a marker anywhere makes it invalid (null), and nothing is returned that could be printed.
  const child = { tool: 'first-load-apply', mode: 'apply', manifestDigest: record.manifestDigest, exit: { name: 'OK' }, verification: [], steps: [], accountingBalanced: true, problems: [MARKER], target: { database: MARKER } }
  const facts = validateChildReport(child, record.manifestDigest, ['suppliers'])
  assert.equal(JSON.stringify(facts ?? {}).includes(MARKER), false)
  assert.equal(validateChildReport({ ...child, exit: { name: MARKER } }, record.manifestDigest, []), null)
  precondition(t, 'record arms', texts.length)
})

test('a restore point is accepted on a resume only at the one path this load composes (a path from the database is never opened, hashed or printed)', () => {
  assert.equal(restorePointPath('/restore/', 'run-1'), '/restore/first-load-run-1.dump')
  assert.equal(restorePointPath('/restore', 'run-1'), restorePointPath('/restore/', 'run-1'))
  assert.notEqual(restorePointPath('/restore', 'run-1'), `/restore/${MARKER}`)
})

test('a rehearsal whose record could not be published is not a success: the closed exit code, for every load exit', () => {
  // Mutation: return loadExit unchanged and the OK arm is green.
  assert.equal(rehearsalCommandExit('OK', false), 'INTERNAL')
  assert.equal(rehearsalCommandExit('OK', true), 'OK')
  for (const name of ['VERIFY_FAILED', 'USAGE', 'PRECONDITION_REFUSED', 'STEP_FAILED', 'CONFLICT', 'INTERNAL', 'REHEARSAL_TEARDOWN_INCOMPLETE', 'APPLIED_UNVERIFIED'] as ApplyExitName[]) {
    assert.equal(rehearsalCommandExit(name, true), name)
    assert.equal(rehearsalCommandExit(name, false), name, 'a failing exit stays what it was')
  }
})
