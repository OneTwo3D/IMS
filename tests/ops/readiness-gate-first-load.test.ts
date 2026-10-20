import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { APPLY_REPORT_MAX_AGE_DAYS, CHECK_CATALOGUE, READINESS_GATE_DOC_BLOCKS, checkDefinition } from '../../lib/ops/readiness-gate-constants.ts'
import { assessApplyReport, applyReportProblems, decideVerdict, type ApplyEvidence } from '../../lib/ops/readiness-gate.ts'
import { readApplyReports } from '../../lib/ops/readiness-gate-collect.ts'
import { PRECONDITION_IDS } from '../../lib/first-load/apply/constants.ts'
import { VERIFICATION_IDS } from '../../lib/first-load/apply/verify-core.ts'
import { APPLY_RUN, APPLY_SYSTEM_ID, DAY, NOW, NO_ACCEPTANCES, allPassing, applyEvidence, greenApplyReport } from '../helpers/readiness-gate-fixtures.ts'
import { precondition } from '../first-load/helpers.ts'

/**
 * THE FIRST-LOAD CHECK OF THE READINESS GATE. A report speaks for a database only by IDENTITY (the database's run record names the run and digest; the report names the same ones and
 * the same cluster), never by being the newest. Every guard has a named mutation that turns an arm red; the table is in docs/first-load-apply.md ("The readiness gate").
 */

const POISON = 'POISON-FROM-AN-UNVERIFIED-FILE'
const problemsOf = (over: Record<string, unknown>) => applyReportProblems({ parsed: greenApplyReport(over), markdownDigestOk: true }, { systemId: APPLY_SYSTEM_ID }, NOW)

test('control: the green report is intact, and the evidence around it passes', (t) => {
  assert.deepEqual(problemsOf({}), [])
  const result = assessApplyReport(applyEvidence(), NOW)
  assert.equal(result.kind, 'pass', JSON.stringify(result))
  precondition(t, 'preconditions in the fixture', PRECONDITION_IDS.length)
  precondition(t, 'verification items in the fixture', VERIFICATION_IDS.length)
})

test('every single defect in a report is a failure with its closed code [mutation: remove the matching guard in applyReportProblems]', (t) => {
  const sound = greenApplyReport()
  const withPrecondition = (id: string, result: string) => ({ preconditions: (sound.preconditions as Array<{ id: string }>).map((p) => (p.id === id ? { ...p, result } : p)) })
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['not an apply report tool', { tool: 'something-else' }, 'tool'],
    ['an older format (no preconditions per check id)', { formatVersion: 1 }, 'format-version'],
    ['a rehearsal report', { mode: 'rehearse' }, 'mode'],
    ['exit name not OK', { exit: { code: 1, name: 'VERIFY_FAILED' } }, 'exit-not-ok'],
    ['exit code not 0 under the name OK', { exit: { code: 3, name: 'OK' } }, 'exit-not-ok'],
    ['no exit', { exit: undefined }, 'exit-not-ok'],
    ['problems recorded', { problems: ['x'] }, 'problems-recorded'],
    ['problems missing', { problems: undefined }, 'problems-recorded'],
    ['no steps', { steps: [] }, 'steps'],
    ['a step not DONE', { steps: [{ step: 'suppliers', status: 'FAILED', emitted: 1, created: 1, updated: 0, skippedExisting: 0, failed: 0 }] }, 'steps'],
    ['a PENDING step that created something (not a verification-only report)', { steps: [{ step: 'suppliers', status: 'PENDING', emitted: 1, created: 1, updated: 0, skippedExisting: 0, failed: 0 }] }, 'steps'],
    ['a RUNNING step', { steps: [{ step: 'suppliers', status: 'RUNNING', emitted: 1, created: 0, updated: 0, skippedExisting: 1, failed: 0 }] }, 'steps'],
    ['a step with a failed unit', { steps: [{ step: 'suppliers', status: 'DONE', emitted: 1, created: 0, updated: 0, skippedExisting: 0, failed: 1 }] }, 'steps'],
    ['a step whose accounting does not balance', { steps: [{ step: 'suppliers', status: 'DONE', emitted: 9, created: 1, updated: 0, skippedExisting: 0, failed: 0 }] }, 'steps'],
    ['a step with a non-integer count', { steps: [{ step: 'suppliers', status: 'DONE', emitted: 1.5, created: 1.5, updated: 0, skippedExisting: 0, failed: 0 }] }, 'steps'],
    ['accounting not balanced', { accountingBalanced: false }, 'accounting'],
    ['a verification item missing', { verification: (sound.verification as unknown[]).slice(1) }, 'verification'],
    ['a verification item failed', { verification: (sound.verification as Array<Record<string, unknown>>).map((v, i) => (i === 0 ? { ...v, result: 'fail' } : v)) }, 'verification'],
    ['a verification item twice', { verification: (sound.verification as unknown[]).map((v, i, all) => (i === 1 ? all[0] : v)) }, 'verification'],
    ['no restore point', { restorePoint: null }, 'restore-point'],
    ['a restore point pg_restore did not list', { restorePoint: { ...(sound.restorePoint as object), listed: false } }, 'restore-point'],
    ['a restore point with no bytes', { restorePoint: { ...(sound.restorePoint as object), bytes: 0 } }, 'restore-point'],
    ['a restore point digest that is not a digest', { restorePoint: { ...(sound.restorePoint as object), sha256: 'zz' } }, 'restore-point'],
    ['preconditions absent', { preconditions: [] }, 'preconditions'],
    ['preconditions in another order', { preconditions: [...(sound.preconditions as unknown[])].reverse() }, 'preconditions'],
    ['a precondition refused', withPrecondition('check:barcode-free', 'refused'), 'preconditions'],
    ['a pre-load rail not evaluated', withPrecondition('rail:crons', 'not-applicable'), 'preconditions'],
    ['the producer-hold rail refused', withPrecondition('rail:producer-hold', 'refused'), 'preconditions'],
    ['another cluster', { target: { database: 'ims', systemId: '1'.repeat(19), migrations: 10 } }, 'system-id'],
    ['no target', { target: null }, 'system-id'],
    ['older than the limit', { window: { start: '2026-01-01T00:00:00.000Z', end: new Date(NOW.getTime() - (APPLY_REPORT_MAX_AGE_DAYS + 1) * DAY).toISOString() } }, 'age'],
    ['finished in the future', { window: { start: NOW.toISOString(), end: new Date(NOW.getTime() + 3_600_000).toISOString() } }, 'future'],
    ['no window', { window: null }, 'window'],
    ['an unreadable window end', { window: { start: 'x', end: 'tomorrow' } }, 'window'],
  ]
  precondition(t, 'defect cases', cases.length)
  for (const [label, over, code] of cases) assert.ok(problemsOf(over).includes(code), `${label}: expected ${code}, got ${problemsOf(over).join(',')}`)
  assert.ok(applyReportProblems({ parsed: greenApplyReport(), markdownDigestOk: false }, { systemId: APPLY_SYSTEM_ID }, NOW).includes('markdown-digest'))
  assert.deepEqual(applyReportProblems({ parsed: 'text', markdownDigestOk: true }, { systemId: APPLY_SYSTEM_ID }, NOW), ['not-an-object'])
})

test('the run record decides which report counts: no record, two records, a record that is not VERIFIED, or a report of another run all fail [mutation: select by newest report]', (t) => {
  const row = { ...APPLY_RUN }
  const cases: Array<[string, Partial<ApplyEvidence>]> = [
    ['no run record', { runs: [] }],
    ['two run records', { runs: [row, { ...row, runId: 'other' }] }],
    ['RUNNING', { runs: [{ ...row, status: 'RUNNING' }] }],
    ['STEP_FAILED', { runs: [{ ...row, status: 'STEP_FAILED' }] }],
    ['APPLIED (not verified)', { runs: [{ ...row, status: 'APPLIED' }] }],
    ['VERIFY_FAILED after an earlier OK report', { runs: [{ ...row, status: 'VERIFY_FAILED' }] }],
    ['a status this build does not know', { runs: [{ ...row, status: POISON }] }],
    ['the report names another run id', { runs: [{ ...row, runId: 'someone-elses-run' }] }],
    ['the report names another load digest', { runs: [{ ...row, manifestDigest: 'e'.repeat(64) }] }],
    ['the report is about another cluster', { systemId: '9'.repeat(19) }],
    ['no report at all', { reports: [] }],
  ]
  precondition(t, 'cases', cases.length)
  for (const [label, over] of cases) {
    const result = assessApplyReport(applyEvidence(over), NOW)
    assert.equal(result.kind, 'fail', `${label}: ${JSON.stringify(result)}`)
    assert.ok(!JSON.stringify(result).includes(POISON), `${label}: nothing from the unverified side reaches the text`)
  }
  assert.equal(assessApplyReport(applyEvidence({ systemId: '' }), NOW).kind, 'unreadable', 'an unreadable cluster identifier is unreadable, not a pass')
})

test('ORDER IS NOT DECIDED BY TIME: any intact report naming the VERIFIED run passes, whatever else is on disk and whenever it was written', (t) => {
  const bad = { parsed: greenApplyReport({ exit: { code: 4, name: 'STEP_FAILED' } }), markdownDigestOk: true }
  const good = { parsed: greenApplyReport(), markdownDigestOk: true }
  const later = { parsed: greenApplyReport({ exit: { code: 4, name: 'STEP_FAILED' }, window: { start: NOW.toISOString(), end: NOW.toISOString() } }), markdownDigestOk: true }
  precondition(t, 'orders tried', 3)
  for (const reports of [[bad, good], [good, bad], [later, good]]) assert.equal(assessApplyReport(applyEvidence({ reports }), NOW).kind, 'pass')
  // And only failing ones fail, with a count and codes only.
  const result = assessApplyReport(applyEvidence({ reports: [bad, later] }), NOW)
  assert.equal(result.kind, 'fail')
  assert.match(JSON.stringify(result), /2 published apply report\(s\) name this run, and none is intact/)
})

test('a report written by a verification-only resume (steps PENDING, every unit already present) is intact', () => {
  assert.deepEqual(problemsOf({ steps: [{ step: 'suppliers', status: 'PENDING', emitted: 3, created: 0, updated: 0, skippedExisting: 3, failed: 0 }] }), [])
})

test('no field of an unverified report reaches the text of a result', () => {
  const poisoned = greenApplyReport({
    exit: { code: 4, name: POISON },
    problems: [POISON],
    steps: [{ step: POISON, status: POISON, emitted: 1, created: 0, updated: 0, skippedExisting: 0, failed: 1 }],
    restorePoint: { path: POISON, sha256: POISON, bytes: 1, listed: true },
    target: { database: POISON, systemId: POISON, migrations: 1 },
    preconditions: [{ id: POISON, result: POISON, detail: POISON }],
    verification: [{ id: POISON, result: POISON, expected: POISON, actual: POISON }],
    window: { start: POISON, end: POISON },
  })
  const result = assessApplyReport(applyEvidence({ reports: [{ parsed: poisoned, markdownDigestOk: true }] }), NOW)
  assert.equal(result.kind, 'fail')
  assert.ok(!JSON.stringify(result).includes(POISON))
})

test('the catalogue: required at P0, listed only at P1 and P2, and a failure blocks P0 alone [mutation: P0 listed-only]', () => {
  const definition = checkDefinition('first-load-apply')!
  assert.deepEqual(definition.requirement, { P0: 'required', P1: 'listed-only', P2: 'listed-only' })
  assert.ok(CHECK_CATALOGUE.some((d) => d.id === 'first-load-apply'))
  const results = { ...allPassing(), 'first-load-apply': { kind: 'fail' as const, reasons: ['x'] } }
  assert.equal(decideVerdict({ phase: 'P0', results, acceptances: NO_ACCEPTANCES, now: NOW }).verdict, 'NO-GO')
  for (const phase of ['P1', 'P2'] as const) assert.equal(decideVerdict({ phase, results, acceptances: NO_ACCEPTANCES, now: NOW }).verdict, 'GO')
  assert.match(READINESS_GATE_DOC_BLOCKS.usage, /--apply-report-dir/)
})

// ---------------------------------------------------------------------------------------------
// The files: trust, one read, no ranking.
// ---------------------------------------------------------------------------------------------

const bases: string[] = []
function scratchBase(prefix: string): string {
  const dir = mkdtempSync(path.join('/var/tmp', prefix))
  bases.push(dir)
  return dir
}
after(() => { for (const dir of bases) rmSync(dir, { recursive: true, force: true }) })

function publishPair(dir: string, stem: string, report: object, markdown = '# apply report\n'): string {
  const json = path.join(dir, `${stem}.json`)
  writeFileSync(path.join(dir, `${stem}.md`), markdown, { mode: 0o600 })
  writeFileSync(json, JSON.stringify({ ...report, companionMarkdownSha256: createHash('sha256').update(markdown).digest('hex') }), { mode: 0o600 })
  return json
}

test('readApplyReports: an untouched location is read; a location another account could have written is refused anywhere in it [mutation: remove the trust check]', (t) => {
  const make = (prepare: (dir: string) => void): ReturnType<typeof readApplyReports> => {
    const dir = scratchBase('ims-gate-apply-')
    chmodSync(dir, 0o700)
    publishPair(dir, 'first-load-apply-apply-run-1-20261001T000000Z', greenApplyReport())
    publishPair(dir, 'first-load-apply-apply-run-1-20261002T000000Z', greenApplyReport())
    prepare(dir)
    return readApplyReports(dir)
  }
  const control = make(() => undefined)
  assert.ok('reports' in control && control.reports.length === 2 && control.reports.every((r) => r.markdownDigestOk))
  const shapes: Array<[string, (d: string) => void]> = [
    ['directory group-writable', (d) => chmodSync(d, 0o770)],
    ['directory world-writable', (d) => chmodSync(d, 0o777)],
    ['one JSON group-writable', (d) => chmodSync(path.join(d, 'first-load-apply-apply-run-1-20261001T000000Z.json'), 0o664)],
    ['one Markdown world-writable', (d) => chmodSync(path.join(d, 'first-load-apply-apply-run-1-20261002T000000Z.md'), 0o666)],
    ['a JSON that is a symlink', (d) => { const j = path.join(d, 'first-load-apply-apply-run-1-20261001T000000Z.json'); const real = path.join(d, 'real-target.json'); writeFileSync(real, '{}', { mode: 0o600 }); rmSync(j); symlinkSync(real, j) }],
    ['a Markdown that is a symlink', (d) => { const m = path.join(d, 'first-load-apply-apply-run-1-20261001T000000Z.md'); const real = path.join(d, 'real-target.md'); writeFileSync(real, 'x', { mode: 0o600 }); rmSync(m); symlinkSync(real, m) }],
  ]
  precondition(t, 'untrusted shapes', shapes.length)
  for (const [label, prepare] of shapes) {
    const found = make(prepare)
    assert.ok('untrusted' in found, `${label}: refused`)
    assert.match(found.untrusted, /proves nothing, so it was not read/, label)
  }
})

test('readApplyReports: a Markdown that does not match the digest the JSON records is flagged; a name that is not a report is never read; an unparseable report is counted', () => {
  const dir = scratchBase('ims-gate-apply-')
  chmodSync(dir, 0o700)
  const json = publishPair(dir, 'first-load-apply-apply-run-1-20261001T000000Z', greenApplyReport())
  writeFileSync(json.replace(/\.json$/, '.md'), '# changed after the JSON recorded its digest\n', { mode: 0o600 })
  writeFileSync(path.join(dir, 'first-load-apply-apply-run-2-20261001T000000Z.json'), '{not json', { mode: 0o600 })
  // Files that are not candidates are not opened at all: a world-writable one here must not refuse the location.
  writeFileSync(path.join(dir, 'first-load-rehearsal-record-run-1.json'), '{}', { mode: 0o666 })
  writeFileSync(path.join(dir, 'notes.txt'), 'x', { mode: 0o666 })
  const found = readApplyReports(dir)
  assert.ok('reports' in found)
  assert.equal(found.reports.length, 1)
  assert.equal(found.reports[0]!.markdownDigestOk, false)
  assert.equal(found.unparseable, 1)
  assert.deepEqual(applyReportProblems(found.reports[0]!, { systemId: APPLY_SYSTEM_ID }, NOW), ['markdown-digest'])
})

test('readApplyReports: a missing directory, an empty one and one with too many candidates are named, not passed', () => {
  assert.ok('none' in readApplyReports('/var/tmp/ims-gate-apply-does-not-exist'))
  const empty = scratchBase('ims-gate-apply-')
  chmodSync(empty, 0o700)
  assert.ok('none' in readApplyReports(empty))
  const crowded = scratchBase('ims-gate-apply-')
  chmodSync(crowded, 0o700)
  for (let i = 0; i < 501; i++) writeFileSync(path.join(crowded, `first-load-apply-apply-r-${i}.json`), '{}', { mode: 0o600 })
  assert.ok('untrusted' in readApplyReports(crowded))
})

test('readApplyReports: the verdict does not depend on file times or names [mutation: pick the newest by mtime]', () => {
  const dir = scratchBase('ims-gate-apply-')
  chmodSync(dir, 0o700)
  const good = publishPair(dir, 'first-load-apply-apply-run-1-20261001T000000Z', greenApplyReport())
  const failed = publishPair(dir, 'first-load-apply-apply-run-1-20261002T000000Z', greenApplyReport({ exit: { code: 4, name: 'STEP_FAILED' } }))
  const verdictAfter = (): string => {
    const found = readApplyReports(dir)
    assert.ok('reports' in found)
    return assessApplyReport(applyEvidence({ reports: found.reports }), NOW).kind
  }
  utimesSync(good, 1_000_000, 1_000_000)
  utimesSync(failed, 2_000_000_000, 2_000_000_000)
  assert.equal(verdictAfter(), 'pass')
  utimesSync(good, 2_000_000_000, 2_000_000_000)
  utimesSync(failed, 1_000_000, 1_000_000)
  assert.equal(verdictAfter(), 'pass')
})

test('the digest, the parse and the Markdown comparison use the bytes of ONE read (absence of a second read of the path)', (t) => {
  const text = readFileSync(path.join(process.cwd(), 'lib/ops/readiness-gate-collect.ts'), 'utf8')
  const start = text.indexOf('export function readApplyReports')
  const body = text.slice(start, text.indexOf('// ----', start))
  precondition(t, 'function body length', body.length)
  assert.match(body, /readTrustedRegularFileBytes\(json, MAX_REPORT_BYTES\)/)
  assert.doesNotMatch(body, /readFileSync|verifyPublishedReport|readTrustedRegularFile\(/, 'no second read of the same path, no helper that re-reads it')
  assert.doesNotMatch(body, /mtimeMs|\bstatSync|\.sort\(\(/, 'no ordering by file time')
})
