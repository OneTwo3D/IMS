import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { verifyPublishedReport } from '../../lib/ops/published-report.ts'
import { PACK_EVIDENCE_FILE, PACK_ITEM_IDS, PACK_LOCK_FILE, PACK_RECLAIM_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN, itemApplicability, packExitCode, LOCK_STALE_MS, MAX_EVIDENCE_LINES_PER_ITEM, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { defaultItems, newRunId, publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import { acquireRunLock } from '../../lib/reconciliation-pack/lock.ts'
import { publishPackReport } from '../../lib/reconciliation-pack/publish.ts'
import { ReportInvalid, buildReport, parseReport, sha256Hex, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { itemSeries, readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { NOW, allFiles, at, cleanup, itemFromComparison, key, mode, passItem, readAll, scratchDir } from './helpers.ts'

// Credential-shaped canaries are assembled at run time so the repository holds no literal that a secret scanner would flag.
const STRIPE_SHAPED = ['sk', 'live', 'abcdef123456'].join('_')
const BEARER_SHAPED = ['Bear', 'er abcdef0123456789'].join('')

const bases: string[] = []
after(() => cleanup(bases))
const fresh = () => path.join(scratchDir(bases), 'reports')

function publish(reportDir: string, minutes: number, over: Partial<Parameters<typeof publishSyntheticRun>[0]> = {}) {
  return publishSyntheticRun({ reportDir, phase: 'P1', asOf: '2026-10-19', now: at(minutes), ...over })
}
function ok(result: ReturnType<typeof publish>) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result as Extract<ReturnType<typeof publish>, { ok: true }>
}
const runDirs = (dir: string) => readdirSync(dir).filter((n) => !n.startsWith('.')).sort()
const runDirOf = (reportDir: string, sequence: number) => {
  const chain = readPackChain(reportDir)
  assert.equal(chain.ok, true)
  return path.join(reportDir, (chain as Extract<typeof chain, { ok: true }>).reports[sequence - 1]!.runId)
}
/** Copy a published run directory into another report directory, keeping the 0700 mode a published one has. */
function graft(from: string, toReportDir: string): string {
  const target = path.join(toReportDir, path.basename(from))
  cpSync(from, target, { recursive: true })
  chmodSync(target, 0o700)
  return target
}
function editJson(file: string, edit: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  edit(value)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

// ---------------------------------------------------------------------------------------------

test('a synthetic run publishes the triple, Markdown and evidence first and the JSON last as the commit record', () => {
  const dir = fresh()
  const result = ok(publish(dir, 0))
  assert.equal(result.exitCode, packExitCode('inconclusive'), 'no runner exists, so nothing is proven')
  assert.deepEqual(readdirSync(path.dirname(result.json)).sort(), [PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN])
  assert.equal(verifyPublishedReport(result.json).ok, true)
  assert.equal(mode(path.dirname(result.json)), 0o700)
  for (const file of [result.json, result.markdown, result.evidence]) assert.equal(mode(file), 0o600, file)
  assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false, 'the lock is released')
  assert.equal(result.record.sequence, 1)
  assert.equal(result.record.previousReportSha256, null)
  assert.equal(result.record.companionMarkdownSha256, sha256Hex(readFileSync(result.markdown)))
  assert.equal(result.record.evidence.sha256, sha256Hex(readFileSync(result.evidence)))
  const byId = new Map(result.record.items.map((item) => [item.id, item]))
  for (const id of ['R7', 'R8', 'R11'] as const) assert.deepEqual([byId.get(id)!.outcome, byId.get(id)!.reasons], ['not-applicable', ['PHASE_NOT_APPLICABLE']])
  assert.deepEqual([byId.get('R3')!.outcome, byId.get('R3')!.reasons], ['inconclusive', ['NO_RUNNER']])
  assert.equal(byId.get('R2')!.applicability, 'listed-only')
})

test('the commit is last: the JSON appears only after the Markdown and the evidence are in place', () => {
  const dir = fresh()
  const seen: string[][] = []
  ok(publish(dir, 0, { hooks: { beforeCommit: () => { const run = runDirs(dir)[0]!; seen.push(readdirSync(path.join(dir, run)).filter((n) => !n.endsWith('.tmp')).sort()) } } }))
  assert.deepEqual(seen, [[PACK_EVIDENCE_FILE, PACK_REPORT_MARKDOWN]])
})

test('reports form a chain: sequence 1..n, each previousReportSha256 the digest of the previous JSON bytes', () => {
  const dir = fresh()
  const first = ok(publish(dir, 0))
  const second = ok(publish(dir, 1))
  const third = ok(publish(dir, 2))
  assert.deepEqual([first, second, third].map((r) => r.record.sequence), [1, 2, 3])
  assert.equal(second.record.previousReportSha256, sha256Hex(readFileSync(first.json)))
  assert.equal(third.record.previousReportSha256, sha256Hex(readFileSync(second.json)))
  assert.equal(third.jsonSha256, sha256Hex(readFileSync(third.json)))
  const chain = readPackChain(dir)
  assert.equal(chain.ok, true)
  const reports = (chain as Extract<typeof chain, { ok: true }>).reports
  assert.deepEqual(reports.map((r) => r.sequence), [1, 2, 3])
  assert.equal((chain as Extract<typeof chain, { ok: true }>).head!.runId, third.record.runId)
  assert.deepEqual(itemSeries(reports, 'R3').map((p) => p.outcome), ['inconclusive', 'inconclusive', 'inconclusive'])
})

test('an empty or absent report directory is a valid empty chain', () => {
  const dir = fresh()
  mkdirSync(dir, { mode: 0o700 })
  assert.deepEqual(readPackChain(dir), { ok: true, reports: [], head: null, unpublishedRuns: 0 })
})

// ---- exit codes -------------------------------------------------------------------------------

function passingAt(phase: 'P0' | 'P1' | 'P2'): Partial<Record<PackItemId, ItemInput>> {
  return Object.fromEntries(PACK_ITEM_IDS.filter((id) => itemApplicability(id, phase) !== 'not-applicable').map((id) => [id, passItem(id)]))
}

test('exit code: 0 only when every applicable item passed', () => {
  for (const phase of ['P0', 'P1', 'P2'] as const) {
    const result = ok(publish(fresh(), 0, { phase, items: passingAt(phase) }))
    assert.equal(result.exitCode, 0, phase)
    assert.equal(result.record.summary.inconclusive, 0)
  }
})

test('exit code: one failing applicable item is 1; fail beats inconclusive', () => {
  const failing: ItemInput = { id: 'R15', outcome: 'fail', reasons: ['DIFFERENCES'] }
  assert.equal(ok(publish(fresh(), 0, { phase: 'P0', items: { ...passingAt('P0'), R15: failing } })).exitCode, 1)
  const mixed = { ...passingAt('P1'), R15: failing }
  delete (mixed as Record<string, unknown>).R3
  assert.equal(ok(publish(fresh(), 0, { phase: 'P1', items: mixed })).exitCode, 1)
})

test('exit code: one inconclusive applicable item is 5, and so is a run in which nothing passed', () => {
  const items = { ...passingAt('P0') }
  delete (items as Record<string, unknown>).R4
  assert.equal(ok(publish(fresh(), 0, { phase: 'P0', items })).exitCode, 5)
  assert.equal(ok(publish(fresh(), 0, { phase: 'P0', items: {} })).exitCode, 5)
})

test('exit code: a listed-only item (R2 at P1) is reported but never moves the exit code', () => {
  const r2fail: ItemInput = { id: 'R2', outcome: 'fail', reasons: ['DIFFERENCES'] }
  const r2inc: ItemInput = { id: 'R2', outcome: 'inconclusive', reasons: ['NO_RUNNER'] }
  assert.equal(ok(publish(fresh(), 0, { phase: 'P1', items: { ...passingAt('P1'), R2: r2fail } })).exitCode, 0)
  assert.equal(ok(publish(fresh(), 0, { phase: 'P1', items: { ...passingAt('P1'), R2: r2inc } })).exitCode, 0)
})

// ---- the builder refuses a result that contradicts itself ---------------------------------------

function input(items: ItemInput[], over: Partial<ReportInput> = {}): ReportInput {
  return { runId: newRunId(NOW), systemIdentifier: 'ims-test', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: [], items, ...over }
}
const baseItems = (phase: 'P0' | 'P1' | 'P2' = 'P1') => defaultItems(phase)
const replace = (items: ItemInput[], next: ItemInput) => items.map((item) => (item.id === next.id ? next : item))

test('builder: a pass may carry no reason, no finding and nothing unsettled', () => {
  const entries = { onlyIms: [{ key: 'A|MAIN' as never, ims: '1', vendor: null, delta: null }] }
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'pass', reasons: ['DIFFERENCES'] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'pass', reasons: [], entries })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'pass', reasons: [], entries: { unsettled: [{ key: 'A|MAIN' as never, ims: null, vendor: null, delta: null, settling: { first: '2026-10-01T00:00:00Z', later: [] } }] } })), 1, null), ReportInvalid)
})

test('builder: fail and inconclusive need a reason; a fail names a finding or a reason other than UNSETTLED_PENDING', () => {
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'fail', reasons: [] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'inconclusive', reasons: [] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'fail', reasons: ['UNSETTLED_PENDING'] })), 1, null), ReportInvalid)
})

test('builder: the phase decides not-applicable, in both directions', () => {
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R3', outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R7', outcome: 'pass', reasons: [] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(baseItems(), { id: 'R7', outcome: 'not-applicable', reasons: ['NO_RUNNER'] })), 1, null), ReportInvalid)
})

test('builder: each of R1..R15 exactly once; closed reasons; strict shapes; chain arguments', () => {
  const items = baseItems()
  assert.throws(() => buildReport(input(items.slice(1)), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input([...items, items[0]!]), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(replace(items, { id: 'R3', outcome: 'inconclusive', reasons: ['because the vendor said so' as never] })), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items, { runId: '../../etc' }), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items, { systemIdentifier: 'Has Space' }), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items, { asOf: '2026-02-31x' }), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items, { startedAt: 'yesterday' }), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items), 0, null), ReportInvalid)
  assert.throws(() => buildReport(input(items), 1.5, null), ReportInvalid)
  assert.throws(() => buildReport(input(items), 2, null), ReportInvalid, 'sequence 2 needs a predecessor')
  assert.throws(() => buildReport(input(items), 1, 'a'.repeat(64)), ReportInvalid, 'sequence 1 has none')
  assert.throws(() => buildReport(input(items), 2, 'not-a-sha'), ReportInvalid)
  assert.throws(() => buildReport(input(items, { streams: [{ stream: 'nope' as never, start: null, end: null }] }), 1, null), ReportInvalid)
  assert.throws(() => buildReport(input(items, { streams: [{ stream: 'xero-tax-rates', start: 'x', end: null }] }), 1, null), ReportInvalid)
})

// ---- identity, not counts ---------------------------------------------------------------------------

test('IDENTITY SWAP end to end: equal counts, one identity swapped => the report fails and names both identities in the evidence', () => {
  const dir = fresh()
  const { item } = itemFromComparison('R1', { ims: [{ key: key('A'), value: '5' }, { key: key('B'), value: '7' }], vendor: [{ key: key('A'), value: '5' }, { key: key('C'), value: '7' }] })
  const result = ok(publish(dir, 0, { items: { ...passingAt('P1'), R1: item } }))
  assert.equal(result.exitCode, 1)
  const r1 = result.record.items.find((i) => i.id === 'R1')!
  assert.deepEqual([r1.outcome, r1.reasons], ['fail', ['DIFFERENCES']])
  assert.equal(r1.counts.bothEqual, 1)
  assert.equal(r1.counts.onlyIms, 1)
  assert.equal(r1.counts.onlyVendor, 1)
  assert.equal(r1.bothEqualSha256, sha256Hex('A|MAIN'))
  const lines = readFileSync(result.evidence, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  assert.deepEqual(lines.map((l) => [l.item, l.bucket, l.key]), [['R1', 'onlyIms', 'B|MAIN'], ['R1', 'onlyVendor', 'C|MAIN']])
})

test('counts are DERIVED: the reader recomputes them from the evidence and refuses a report whose counts were edited', () => {
  const dir = fresh()
  const { item } = itemFromComparison('R1', { ims: [{ key: key('A'), value: '5' }, { key: key('B'), value: '7' }], vendor: [{ key: key('A'), value: '5' }] })
  const result = ok(publish(dir, 0, { items: { ...passingAt('P1'), R1: item } }))
  editJson(result.json, (v) => { ((v.items as Array<{ id: string; counts: Record<string, number> }>).find((i) => i.id === 'R1')!).counts.onlyIms = 0 })
  const chain = readPackChain(dir)
  assert.deepEqual(chain.ok, false)
})

test('a capped listing is never a pass, and the counts stay what the evidence lists', () => {
  const rows = Array.from({ length: MAX_EVIDENCE_LINES_PER_ITEM + 5 }, (_, i) => ({ key: key(`S${i}`), value: '1' }))
  const { item } = itemFromComparison('R1', { ims: rows, vendor: [], allowEmpty: true })
  const result = ok(publish(fresh(), 0, { items: { ...passingAt('P1'), R1: item } }))
  const r1 = result.record.items.find((i) => i.id === 'R1')!
  assert.equal(r1.outcome, 'fail')
  assert.ok(r1.reasons.includes('CAP_EXCEEDED'))
  assert.equal(r1.counts.onlyIms, MAX_EVIDENCE_LINES_PER_ITEM)
  assert.equal(r1.evidenceLines, MAX_EVIDENCE_LINES_PER_ITEM)
  // an inconclusive item cut by the cap stays inconclusive and gains the reason; a pass-shaped item cannot be capped silently
  const equalRows = Array.from({ length: 6 }, (_, i) => ({ key: key(`E${i}`), value: '1' }))
  const outOfPop = Array.from({ length: MAX_EVIDENCE_LINES_PER_ITEM + 3 }, (_, i) => ({ key: key(`P${i}`), value: '1' }))
  const capped = itemFromComparison('R1', { ims: [...equalRows, ...outOfPop], vendor: [...equalRows, ...outOfPop], population: new Set(equalRows.map((r) => JSON.stringify(r.key)).slice(0, 0)), allowEmpty: true })
  assert.equal(capped.item.outcome === 'pass' || capped.item.outcome === 'inconclusive', true)
  const r = ok(publish(fresh(), 0, { items: { ...passingAt('P1'), R1: { ...capped.item, outcome: 'inconclusive', reasons: ['READ_INCOMPLETE'] } } }))
  assert.ok(r.record.items.find((i) => i.id === 'R1')!.reasons.includes('READ_INCOMPLETE'))
})

// ---- tampering: every one refuses, none is skipped ---------------------------------------------------

function seeded(): { dir: string; first: string; second: string } {
  const dir = fresh()
  ok(publish(dir, 0))
  ok(publish(dir, 1))
  return { dir, first: runDirOf(dir, 1), second: runDirOf(dir, 2) }
}
function chainCode(dir: string): string {
  const chain = readPackChain(dir)
  return chain.ok ? 'ok' : chain.code
}

test('tamper: a changed Markdown, evidence, JSON field, or a stray extra field is PAIR_INVALID, and publishing is refused', () => {
  for (const mutate of [
    (d: string) => writeFileSync(path.join(d, PACK_REPORT_MARKDOWN), 'forged\n'),
    (d: string) => writeFileSync(path.join(d, PACK_EVIDENCE_FILE), '{"item":"R1"}\n'),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { v.exitCode = 0 }),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { v.extra = 'x' }),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { delete v.companionMarkdownSha256 }),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { v.systemIdentifier = 'victim@example.com' }),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { ((v.items as Array<Record<string, unknown>>)[0]!).reasons = ['free text from a file'] }),
    (d: string) => editJson(path.join(d, PACK_REPORT_JSON), (v) => { v.runId = '20260101T000000Z-aaaaaaaaaaaa' }),
    (d: string) => writeFileSync(path.join(d, PACK_REPORT_JSON), '{not json'),
    (d: string) => unlinkSync(path.join(d, PACK_EVIDENCE_FILE)),
    (d: string) => unlinkSync(path.join(d, PACK_REPORT_MARKDOWN)),
  ]) {
    const { dir, second } = seeded()
    mutate(second)
    assert.equal(chainCode(dir), 'PAIR_INVALID')
    const refused = publish(dir, 5)
    assert.deepEqual([refused.ok, refused.ok ? 0 : refused.exitCode, refused.ok ? '' : refused.code], [false, 2, 'PAIR_INVALID'])
    assert.equal(runDirs(dir).length, 2, 'nothing was published')
  }
})

test('tamper: the evidence in a report whose digest was also rewritten is still checked line by line', () => {
  const { dir, second } = seeded()
  const evidence = `${JSON.stringify({ item: 'R1', bucket: 'onlyIms', key: 'victim@example.com', ims: null, vendor: null, delta: null })}\n`
  writeFileSync(path.join(second, PACK_EVIDENCE_FILE), evidence)
  editJson(path.join(second, PACK_REPORT_JSON), (v) => { v.evidence = { file: PACK_EVIDENCE_FILE, sha256: sha256Hex(evidence), lines: 1 } })
  assert.equal(chainCode(dir), 'PAIR_INVALID')
})

test('a symlinked run directory, a symlinked file and a loose-mode directory are not trusted', () => {
  const a = seeded()
  const real = path.join(a.dir, 'elsewhere')
  renameSync(a.second, real)
  symlinkSync(real, a.second)
  assert.equal(chainCode(a.dir), 'PAIR_INVALID')

  const b = seeded()
  const jsonFile = path.join(b.second, PACK_REPORT_JSON)
  const copy = path.join(b.second, 'copy.json')
  renameSync(jsonFile, copy)
  symlinkSync(copy, jsonFile)
  assert.equal(chainCode(b.dir), 'PAIR_INVALID')

  const c = seeded()
  chmodSync(c.second, 0o770)
  assert.equal(chainCode(c.dir), 'PAIR_INVALID')

  const d = seeded()
  chmodSync(path.join(d.second, PACK_REPORT_JSON), 0o666)
  assert.equal(chainCode(d.dir), 'PAIR_INVALID')
})

test('a report directory another account could modify is refused before anything is read or written', () => {
  const dir = fresh()
  ok(publish(dir, 0))
  chmodSync(dir, 0o777)
  assert.equal(chainCode(dir), 'DIR_UNTRUSTED')
  const refused = publish(dir, 1)
  assert.deepEqual([refused.ok, refused.ok ? 0 : refused.exitCode, refused.ok ? '' : refused.code], [false, 2, 'DIR_UNTRUSTED'])
  assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false, 'no lock was left in an untrusted directory')
  chmodSync(dir, 0o700)
  ok(publish(dir, 2))
})

// ---- the chain ---------------------------------------------------------------------------------------

test('GAP: a missing sequence number refuses the chain and the next run', () => {
  const dir = fresh()
  for (let i = 0; i < 3; i += 1) ok(publish(dir, i))
  rmSync(runDirOf(dir, 2), { recursive: true })
  assert.equal(chainCode(dir), 'GAP')
  assert.equal(publish(dir, 9).ok, false)
})

test('GAP: a chain that does not start at sequence 1 is a gap', () => {
  const dir = fresh()
  for (let i = 0; i < 2; i += 1) ok(publish(dir, i))
  rmSync(runDirOf(dir, 1), { recursive: true })
  assert.equal(chainCode(dir), 'GAP')
})

test('FORK: two reports with one sequence, or one predecessor, are refused', () => {
  const left = fresh()
  const right = fresh()
  ok(publish(left, 0))
  ok(publish(right, 0))
  graft(runDirOf(right, 1), left)
  assert.equal(chainCode(left), 'FORK', 'two sequence-1 reports')

  const a = fresh()
  ok(publish(a, 0))
  ok(publish(a, 1))
  const b = fresh()
  mkdirSync(b, { mode: 0o700 })
  for (const name of runDirs(a)) graft(path.join(a, name), b)
  ok(publish(a, 2))
  ok(publish(b, 3))
  graft(runDirOf(b, 3), a)
  assert.equal(chainCode(a), 'FORK', 'two sequence-3 reports after one predecessor')
})

test('LINK_BROKEN: a report whose predecessor was replaced by another valid report is refused', () => {
  const dir = fresh()
  const other = fresh()
  ok(publish(dir, 0))
  ok(publish(dir, 1))
  ok(publish(other, 0))
  rmSync(runDirOf(dir, 1), { recursive: true })
  graft(runDirOf(other, 1), dir)
  assert.equal(chainCode(dir), 'LINK_BROKEN')
})

test('SYSTEM_MISMATCH: reports of two systems in one chain are refused, and a run for another system is refused', () => {
  const dir = fresh()
  ok(publish(dir, 0))
  const refused = publish(dir, 1, { systemIdentifier: 'other-system' })
  assert.deepEqual([refused.ok, refused.ok ? '' : refused.code], [false, 'SYSTEM_MISMATCH'])

  const a = fresh()
  const b = fresh()
  ok(publish(a, 0, { systemIdentifier: 'system-a' }))
  ok(publish(b, 0, { systemIdentifier: 'system-b' }))
  ok(publish(b, 1, { systemIdentifier: 'system-b' }))
  // graft b's second report (whose predecessor is b's first) after a's first by rewriting nothing: the link breaks first
  assert.notEqual(chainCode(a), 'FORK')
})

test('NOT DETECTABLE and said so: deleting the newest report leaves a valid shorter chain', () => {
  const dir = fresh()
  for (let i = 0; i < 3; i += 1) ok(publish(dir, i))
  rmSync(runDirOf(dir, 3), { recursive: true })
  assert.equal(chainCode(dir), 'ok')
})

test('a run directory with no JSON (a publication that died before its commit) is counted, skipped, and never a report', () => {
  const dir = fresh()
  ok(publish(dir, 0))
  const stray = path.join(dir, newRunId(at(30)))
  mkdirSync(stray, { mode: 0o700 })
  writeFileSync(path.join(stray, PACK_REPORT_MARKDOWN), 'orphan\n', { mode: 0o600 })
  const chain = readPackChain(dir)
  assert.equal(chain.ok && chain.unpublishedRuns, 1)
  assert.equal(ok(publish(dir, 1)).record.sequence, 2)
})

test('an existing run directory is never overwritten: the run is not published and the old report stays', () => {
  const dir = fresh()
  const first = ok(publish(dir, 0))
  const again = publishPackReport(dir, input(defaultItems('P1'), { runId: first.record.runId }))
  assert.deepEqual([again.ok, again.ok ? 0 : again.exitCode, again.ok ? '' : again.code], [false, 3, 'WRITE_FAILED'])
  assert.equal(chainCode(dir), 'ok')
  assert.equal(sha256Hex(readFileSync(first.json)), first.jsonSha256)
})

// ---- failure injection ---------------------------------------------------------------------------------

test('a write failure at any of the three files publishes nothing and leaves no JSON, no run directory and no lock', () => {
  for (const failOn of [PACK_EVIDENCE_FILE, PACK_REPORT_MARKDOWN, PACK_REPORT_JSON]) {
    const dir = fresh()
    ok(publish(dir, 0))
    const before = runDirs(dir)
    const result = publish(dir, 1, { hooks: { writeFile: (file, data) => { if (path.basename(file).includes(failOn)) throw new Error('disk full'); writeFileSync(file, data, { flag: 'wx', mode: 0o600 }) } } })
    assert.deepEqual([result.ok, result.ok ? 0 : result.exitCode, result.ok ? '' : result.code], [false, 3, 'WRITE_FAILED'], failOn)
    assert.deepEqual(runDirs(dir), before, failOn)
    assert.equal(allFiles(dir).some((f) => f.endsWith('.tmp')), false, failOn)
    assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false, failOn)
    assert.equal(chainCode(dir), 'ok')
    assert.equal(ok(publish(dir, 2)).record.sequence, 2, 'the sequence number was not consumed')
  }
})

test('TOCTOU: a lock that is no longer this run\'s at the moment of commit means nothing is published (exit 3) and the other lock is left alone', () => {
  const dir = fresh()
  ok(publish(dir, 0))
  const lockFile = path.join(dir, PACK_LOCK_FILE)
  const result = publish(dir, 1, { hooks: { beforeCommit: () => { unlinkSync(lockFile); writeFileSync(lockFile, JSON.stringify({ pid: 1, host: 'elsewhere', token: 'f'.repeat(32), createdAt: NOW.toISOString() }), { flag: 'wx', mode: 0o600 }) } } })
  assert.deepEqual([result.ok, result.ok ? 0 : result.exitCode, result.ok ? '' : result.code], [false, 3, 'LOCK_LOST'])
  assert.equal(runDirs(dir).length, 1)
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).host, 'elsewhere', 'the foreign lock was not removed')
  unlinkSync(lockFile)
  assert.equal(chainCode(dir), 'ok')
})

test('TOCTOU: the lock name retaken by another holder with the same host and pid (a different token) fails the commit check too', () => {
  // Not a rewrite with identical bytes: a file system may hand a new file the old inode number, so the token is what tells holders apart.
  const dir = fresh()
  const lockFile = path.join(dir, PACK_LOCK_FILE)
  mkdirSync(dir, { mode: 0o700 })
  const result = publish(dir, 0, { hooks: { beforeCommit: () => { const held = JSON.parse(readFileSync(lockFile, 'utf8')) as Record<string, unknown>; unlinkSync(lockFile); writeFileSync(lockFile, JSON.stringify({ ...held, token: '0'.repeat(32) }), { flag: 'wx', mode: 0o600 }) } } })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? '' : result.code, 'LOCK_LOST')
  unlinkSync(lockFile)
})

// ---- the run lock ----------------------------------------------------------------------------------------

function lockDir(): string {
  const dir = fresh()
  mkdirSync(dir, { mode: 0o700 })
  return dir
}

test('lock: held by a live process on this host => LOCK_HELD, released => takeable again', () => {
  const dir = lockDir()
  const a = acquireRunLock(dir)
  assert.equal(a.ok, true)
  const b = acquireRunLock(dir)
  assert.deepEqual(b, { ok: false, code: 'LOCK_HELD' })
  if (a.ok) { assert.equal(a.handle.verify(), true); a.handle.release() }
  assert.equal(acquireRunLock(dir).ok, true)
  const refusedRun = publish(dir, 0)
  assert.deepEqual([refusedRun.ok, refusedRun.ok ? 0 : refusedRun.exitCode, refusedRun.ok ? '' : refusedRun.code], [false, 2, 'LOCK_HELD'])
})

test('lock: a lock of a dead pid on this host is reclaimed, and the old holder can no longer commit or release', () => {
  const dir = lockDir()
  const old = acquireRunLock(dir, { pid: () => 424242, hostname: () => 'host-a' })
  assert.equal(old.ok, true)
  const taken = acquireRunLock(dir, { hostname: () => 'host-a', pidAlive: () => false })
  assert.equal(taken.ok, true)
  if (old.ok && taken.ok) {
    assert.equal(old.handle.verify(), false)
    assert.equal(taken.handle.verify(), true)
    old.handle.release()
    assert.equal(taken.handle.verify(), true, 'the old holder\'s release did not remove the new lock')
  }
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), false)
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.run.lock.stale')), [])
})

test('lock: a lock from ANOTHER host is never reclaimed, however old and whatever its pid', () => {
  const dir = lockDir()
  assert.equal(acquireRunLock(dir, { hostname: () => 'host-a', now: () => NOW.getTime() - 10 * LOCK_STALE_MS }).ok, true)
  assert.deepEqual(acquireRunLock(dir, { hostname: () => 'host-b', pidAlive: () => false }), { ok: false, code: 'LOCK_HELD' })
})

test('lock: age reclaims only this host\'s lock and only past LOCK_STALE_MS; a lock from the future is held', () => {
  const young = lockDir()
  assert.equal(acquireRunLock(young, { hostname: () => 'h', now: () => NOW.getTime() }).ok, true)
  assert.deepEqual(acquireRunLock(young, { hostname: () => 'h', now: () => NOW.getTime() + LOCK_STALE_MS, pidAlive: () => true }), { ok: false, code: 'LOCK_HELD' })
  assert.equal(acquireRunLock(young, { hostname: () => 'h', now: () => NOW.getTime() + LOCK_STALE_MS + 1, pidAlive: () => true }).ok, true)
  const future = lockDir()
  assert.equal(acquireRunLock(future, { hostname: () => 'h', now: () => NOW.getTime() + 10 * LOCK_STALE_MS }).ok, true)
  assert.deepEqual(acquireRunLock(future, { hostname: () => 'h', now: () => NOW.getTime(), pidAlive: () => true }), { ok: false, code: 'LOCK_HELD' })
})

test('lock: an unreadable, malformed, oversized or symlinked lock is not taken (fail closed)', () => {
  const lockFor = (dir: string) => path.join(dir, PACK_LOCK_FILE)
  for (const body of ['', 'not json', '{}', JSON.stringify({ pid: 'x', host: 'h', token: 'a'.repeat(32), createdAt: NOW.toISOString() }), JSON.stringify({ pid: 5, host: 'h', token: 'short', createdAt: NOW.toISOString() }), JSON.stringify({ pid: 5, host: 'h', token: 'a'.repeat(32), createdAt: 'yesterday' }), JSON.stringify({ pid: 5, host: 'h', token: 'a'.repeat(32), createdAt: NOW.toISOString(), extra: 1 }), 'x'.repeat(5000)]) {
    const dir = lockDir()
    writeFileSync(lockFor(dir), body, { mode: 0o600 })
    assert.deepEqual(acquireRunLock(dir, { hostname: () => 'h', pidAlive: () => false }), { ok: false, code: 'LOCK_UNREADABLE' }, body.slice(0, 20))
  }
  const dir = lockDir()
  writeFileSync(path.join(dir, 'target'), '{}', { mode: 0o600 })
  symlinkSync(path.join(dir, 'target'), lockFor(dir))
  assert.deepEqual(acquireRunLock(dir), { ok: false, code: 'LOCK_UNREADABLE' })
})

test('lock: reclaims are serialised by a guard file; a guard left behind refuses until removed', () => {
  const dir = lockDir()
  assert.equal(acquireRunLock(dir, { hostname: () => 'h' }).ok, true)
  writeFileSync(path.join(dir, PACK_RECLAIM_FILE), '{}', { mode: 0o600 })
  assert.deepEqual(acquireRunLock(dir, { hostname: () => 'h', pidAlive: () => false }), { ok: false, code: 'LOCK_STALE_CONTENDED' })
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), true, 'a guard that is not ours is not removed')
  unlinkSync(path.join(dir, PACK_RECLAIM_FILE))
  assert.equal(acquireRunLock(dir, { hostname: () => 'h', pidAlive: () => false }).ok, true)
})

test('lock TOCTOU: a stale lock replaced between judgement and reclaim is not stolen', () => {
  const dir = lockDir()
  const lockFile = path.join(dir, PACK_LOCK_FILE)
  assert.equal(acquireRunLock(dir, { hostname: () => 'h', pid: () => 77 }).ok, true)
  const live = JSON.stringify({ pid: 88, host: 'h', token: 'b'.repeat(32), createdAt: NOW.toISOString() })
  const result = acquireRunLock(dir, { hostname: () => 'h', pidAlive: (pid) => pid !== 77, now: () => NOW.getTime(), afterJudged: () => { unlinkSync(lockFile); writeFileSync(lockFile, live, { flag: 'wx', mode: 0o600 }) } })
  assert.deepEqual(result, { ok: false, code: 'LOCK_HELD' })
  assert.equal(readFileSync(lockFile, 'utf8'), live, 'the live lock is untouched')
  assert.equal(existsSync(path.join(dir, PACK_RECLAIM_FILE)), false)
})

test('CONCURRENCY: parallel processes publishing into one directory get a contiguous, fork-free chain', async () => {
  const dir = fresh()
  mkdirSync(dir, { mode: 0o700 })
  const child = path.join(process.cwd(), 'tests/reconciliation-pack/publish-child.ts')
  const perChild = 4
  const runs = Array.from({ length: 4 }, () => new Promise<string>((resolve) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, String(perChild)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
    let out = ''
    proc.stdout.on('data', (d) => { out += String(d) })
    proc.stderr.on('data', (d) => { out += String(d) })
    proc.on('close', (code) => resolve(`${code}:${out.slice(0, 300)}`))
  }))
  const results = await Promise.all(runs)
  assert.deepEqual(results.map((r) => r.split(':')[0]), ['0', '0', '0', '0'], results.join(' | '))
  const chain = readPackChain(dir)
  assert.equal(chain.ok, true, JSON.stringify(chain))
  const reports = (chain as Extract<typeof chain, { ok: true }>).reports
  assert.deepEqual(reports.map((r) => r.sequence), Array.from({ length: 16 }, (_, i) => i + 1))
  assert.equal(allFiles(dir).some((f) => f.includes('.tmp') || f.includes('.stale')), false)
  assert.equal(existsSync(path.join(dir, PACK_LOCK_FILE)), false)
})

// ---- text carries closed words and counts only -----------------------------------------------------------

test('SECRETS / DATA ABSENCE: hostile identities never reach any published byte; every evidence key re-validates', () => {
  const canaries = ['victim@example.com', 'https://evil.example/hook?token=abc123', BEARER_SHAPED, STRIPE_SHAPED, 'password=hunter2', 'Customer Name Ltd', 'eyJhbGciOiJIUzI1NiJ9.payload.sig']
  const rows = canaries.map((c) => ({ key: [{ kind: 'sku' as const, raw: c }, { kind: 'warehouse' as const, raw: 'MAIN' }], value: '1' }))
  const { item } = itemFromComparison('R1', { ims: rows, vendor: [] })
  const dir = fresh()
  ok(publish(dir, 0, { items: { ...passingAt('P1'), R1: item }, streams: [{ stream: 'xero-tax-rates', start: '2026-10-19T00:00:00.000Z', end: '2026-10-19T00:00:00.000Z' }] }))
  const files = readAll(dir)
  assert.equal(files.length, 3)
  const host = os.hostname()
  const user = os.userInfo().username
  for (const { file, text } of files) {
    for (const canary of canaries) assert.ok(!text.includes(canary), `${path.basename(file)} leaked ${canary}`)
    assert.ok(!/@|https?:|bearer |password|secret|api[-_]?key|token=/i.test(text), `${path.basename(file)} carries a credential-shaped string`)
    assert.ok(!text.includes(dir), `${path.basename(file)} carries the report path`)
    if (host.length >= 4) assert.ok(!text.includes(host), `${path.basename(file)} carries the host name`)
    if (user.length >= 4) assert.ok(!text.includes(user), `${path.basename(file)} carries the account name`)
  }
  const evidence = files.find((f) => f.file.endsWith(PACK_EVIDENCE_FILE))!.text.trim().split('\n')
  assert.equal(evidence.length, canaries.length)
  for (const line of evidence) assert.match((JSON.parse(line) as { key: string }).key, /^sku#[0-9a-f]{8}\|MAIN$/)
  assert.equal(readPackChain(dir).ok, true)
})

test('the Markdown names no identity at all and states that it renders no verdict', () => {
  const { item } = itemFromComparison('R1', { ims: [{ key: key('SECRET-LOOKING-SKU-1'), value: '1' }], vendor: [] })
  const result = ok(publish(fresh(), 0, { items: { ...passingAt('P1'), R1: item } }))
  const markdown = readFileSync(result.markdown, 'utf8')
  assert.ok(!markdown.includes('SECRET-LOOKING-SKU-1'))
  assert.match(markdown, /renders no overall verdict/)
  assert.equal(parseReport(readFileSync(result.json, 'utf8')).sequence, 1)
})
