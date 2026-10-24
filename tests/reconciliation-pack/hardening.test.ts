import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { writeExclusive } from '../../lib/ops/published-report.ts'
import { compareKeyed } from '../../lib/reconciliation-pack/compare.ts'
import { PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants.ts'
import { defaultItems, newRunId, publishSyntheticRun } from '../../lib/reconciliation-pack/harness.ts'
import { ReportInvalid, buildReport, deriveExitCode, parseReport, sha256Hex, verifyEvidence, type ItemInput, type ReportInput } from '../../lib/reconciliation-pack/report.ts'
import { canonicalKey } from '../../lib/reconciliation-pack/identity.ts'
import { readPackChain } from '../../lib/reconciliation-pack/trend.ts'
import { NOW, at, cleanup, itemFromComparison, key, scratchDir } from './helpers.ts'

/** A small evidence cap, so the cut is exercised without a hundred thousand entries. */
const CAP = 40
const bases: string[] = []
after(() => cleanup(bases))
const fresh = () => path.join(scratchDir(bases), 'reports')
const publish = (reportDir: string, minutes: number, over: Partial<Parameters<typeof publishSyntheticRun>[0]> = {}) => publishSyntheticRun({ reportDir, phase: 'P1', asOf: '2026-10-19', now: at(minutes), ...over })
const chainCode = (dir: string) => { const c = readPackChain(dir); return c.ok ? 'ok' : c.code }

/** Write a valid pair by hand (what a buggy or hostile writer could do), bypassing the publisher's own refusals. */
function forge(reportDir: string, input: ReportInput, sequence: number, previous: string | null): string {
  const { body, evidenceText, markdown } = buildReport(input, sequence, previous)
  const record = { ...body, companionMarkdownSha256: sha256Hex(markdown) }
  const dir = path.join(reportDir, input.runId)
  mkdirSync(dir, { mode: 0o700 })
  writeExclusive(path.join(dir, PACK_EVIDENCE_FILE), evidenceText)
  writeExclusive(path.join(dir, PACK_REPORT_MARKDOWN), markdown)
  writeExclusive(path.join(dir, PACK_REPORT_JSON), `${JSON.stringify(record, null, 2)}\n`)
  return dir
}
function input(system: string, minutes: number, items?: ItemInput[]): ReportInput {
  return { runId: newRunId(at(minutes)), systemIdentifier: system, phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: [], items: items ?? defaultItems('P1') }
}
function swapReport() {
  const { item } = itemFromComparison('R4', { ims: [{ key: key('A'), value: '5' }, { key: key('B'), value: '7' }], vendor: [{ key: key('A'), value: '5' }, { key: key('C'), value: '7' }] })
  return buildReport(input('7000000000000000001', 0, defaultItems('P1', { R4: item })), 1, null)
}

test('a key part is a non-empty plain string or a safe whole number, or the row is refused', () => {
  const run = (raw: unknown) => compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: { rule: 'exact' }, ims: [{ key: [{ kind: 'sku', raw }], value: '1' }], vendor: [{ key: [{ kind: 'sku', raw }], value: '1' }] })
  for (const bad of ['a\u0001sku:b', 'line\nbreak', '', 'x'.repeat(513), {}, { id: 'A' }, [], ['A'], null, undefined, true, BigInt(10), new Date(0), NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(run(bad), { status: 'unreadable', reason: 'BAD_KEY' }, String(typeof bad === 'bigint' ? 'bigint' : JSON.stringify(bad) ?? String(bad)))
  }
  for (const good of ['A', 'x'.repeat(512), 0, 7, Number.MAX_SAFE_INTEGER]) assert.equal(run(good).status, 'compared', String(good))
})

test('two different whole-number identities are two identities (never one shared form)', () => {
  const side = (raw: number) => [{ key: [{ kind: 'vendor-id' as const, raw }], value: '1' }]
  const result = compareKeyed({ imsComplete: true, vendorComplete: true, mode: 'values', tolerance: { rule: 'exact' }, ims: side(7), vendor: side(8) })
  assert.equal(result.status === 'compared' && result.buckets.bothEqual.length, 0)
  assert.equal(result.status === 'compared' && result.buckets.onlyIms.length, 1)
  assert.equal(result.status === 'compared' && result.buckets.onlyVendor.length, 1)
})

test('a capped listing of a non-finding bucket cannot pass', () => {
  const rows = Array.from({ length: CAP + 1 }, (_, i) => ({ key: key(`X${i}`), value: '1' }))
  const { item } = itemFromComparison('R4', { ims: [...rows, { key: key('OK'), value: '1' }], vendor: [{ key: key('OK'), value: '1' }], excluded: new Set(rows.map((r) => canonicalKey(r.key))) })
  assert.equal(item.outcome, 'pass', 'precondition: the comparison itself passes')
  assert.throws(() => buildReport(input('7000000000000000001', 0, defaultItems('P1', { R4: item })), 1, null, { maxLinesPerItem: CAP }), ReportInvalid)
})

test('deriveExitCode: a run in which nothing applicable exists or passed is inconclusive, never all-pass', () => {
  assert.equal(deriveExitCode([]), 5)
  assert.equal(deriveExitCode([{ outcome: 'not-applicable', applicability: 'not-applicable' }]), 5)
  assert.equal(deriveExitCode([{ outcome: 'pass', applicability: 'listed-only' }]), 5)
  assert.equal(deriveExitCode([{ outcome: 'pass', applicability: 'applicable' }]), 0)
})

// A deliberately loose view of a JSON document, so a test can corrupt any field of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>
function editReport(edit: (v: Loose) => void): string {
  const { body, markdown } = swapReport()
  const value = { ...JSON.parse(JSON.stringify(body)), companionMarkdownSha256: sha256Hex(markdown) } as Loose
  edit(value)
  return JSON.stringify(value)
}

test('parseReport re-derives and cross-checks every field it reads', () => {
  assert.equal(parseReport(editReport(() => {})).sequence, 1)
  assert.throws(() => parseReport(editReport((v) => { v.summary.pass += 1 })), ReportInvalid, 'summary')
  assert.throws(() => parseReport(editReport((v) => { v.exitCode = 0 })), ReportInvalid, 'exit code')
  assert.throws(() => parseReport(editReport((v) => { v.sequence = 2 })), ReportInvalid, 'sequence 2 with no predecessor')
  assert.throws(() => parseReport(editReport((v) => { v.previousReportSha256 = 'a'.repeat(64) })), ReportInvalid, 'sequence 1 with a predecessor')
  assert.throws(() => parseReport(editReport((v) => { v.items[3].bothEqualSha256 = null })), ReportInvalid, 'bothEqual count without digest')
  assert.throws(() => parseReport(editReport((v) => { v.items[3].counts.onlyIms = 9 })), ReportInvalid, 'counts against evidenceLines')
  assert.throws(() => parseReport(editReport((v) => { v.items[2].reasons = ['free text'] })), ReportInvalid, 'reason')
  assert.throws(() => parseReport(editReport((v) => { v.items[2].applicability = 'applicable'; v.items[6].applicability = 'applicable' })), ReportInvalid, 'applicability')
  assert.throws(() => parseReport(editReport((v) => { v.extra = 1 })), ReportInvalid)
})

test('verifyEvidence: digest, line count, per-bucket counts and every key are each checked on their own', () => {
  const { body, evidenceText, markdown } = swapReport()
  const record = { ...body, companionMarkdownSha256: sha256Hex(markdown) }
  verifyEvidence(evidenceText, record)
  const withDigest = (text: string, extra: Partial<typeof record.evidence> = {}) => ({ ...record, evidence: { ...record.evidence, sha256: sha256Hex(text), ...extra } })
  assert.throws(() => verifyEvidence(evidenceText.replace('"ims":"7"', '"ims":"8"'), record), ReportInvalid, 'digest only')
  const lines = evidenceText.trim().split('\n')
  // same line count, same digest (recomputed), but a line moved to another bucket => counts differ from the items
  const moved = `${lines[0]!.replace('onlyIms', 'onlyVendor')}\n${lines[1]}\n`
  assert.throws(() => verifyEvidence(moved, withDigest(moved)), ReportInvalid, 'bucket counts')
  // same shape, but a key that is not a sanitised token
  const forged = `${lines[0]!.replace('B|MAIN', 'victim@example.com')}\n${lines[1]}\n`
  assert.throws(() => verifyEvidence(forged, withDigest(forged)), ReportInvalid, 'key')
  const valued = `${lines[0]!.replace('"ims":"7"', '"ims":"7e3"')}\n${lines[1]}\n`
  assert.throws(() => verifyEvidence(valued, withDigest(valued)), ReportInvalid, 'value')
})

test('a read-back that does not find our report at the head is not published, and what this run wrote is removed', () => {
  const dir = fresh()
  const result = publish(dir, 0, { hooks: { afterCommit: () => { renameSync(path.join(dir, readdirOf(dir)[0]!, PACK_EVIDENCE_FILE), path.join(dir, 'moved-away')) } } })
  assert.deepEqual([result.ok, result.ok ? 0 : result.exitCode, result.ok ? '' : result.code], [false, 3, 'PAIR_INVALID'])
  assert.deepEqual(readdirOf(dir), [])
  assert.equal(chainCode(dir), 'ok')
})
const readdirOf = (dir: string) => readPackChainDirs(dir)
function readPackChainDirs(dir: string): string[] {
  return readdirSync(dir).filter((n: string) => /^\d{8}T/.test(n)).sort()
}

test('ORDER: the run lock is taken before the chain is read', () => {
  const steps: string[] = []
  publish(fresh(), 0, { hooks: { onStep: (step) => steps.push(step) } })
  assert.deepEqual(steps, ['locked', 'chain-read'])
})

test('a run for a different system is REFUSED (exit 2), not published and then found wrong', () => {
  const dir = fresh()
  publish(dir, 0)
  const before = readdirOf(dir)
  const result = publish(dir, 1, { systemIdentifier: '7000000000000000004' })
  assert.deepEqual([result.ok, result.ok ? 0 : result.exitCode, result.ok ? '' : result.kind], [false, 2, 'refused'])
  assert.deepEqual(readdirOf(dir), before)
})

test('a properly linked chain that changes system identifier midway is refused by the reader', () => {
  const dir = fresh()
  mkdirSync(dir, { mode: 0o700 })
  const first = forge(dir, input('7000000000000000002', 0), 1, null)
  const firstSha = sha256Hex(readFileSync(path.join(first, PACK_REPORT_JSON)))
  forge(dir, input('7000000000000000003', 1), 2, firstSha)
  assert.equal(chainCode(dir), 'SYSTEM_MISMATCH')
  // control: the same forge with one system is a valid chain
  const ok = fresh()
  mkdirSync(ok, { mode: 0o700 })
  const a = forge(ok, input('7000000000000000002', 0), 1, null)
  forge(ok, input('7000000000000000002', 1), 2, sha256Hex(readFileSync(path.join(a, PACK_REPORT_JSON))))
  assert.equal(chainCode(ok), 'ok')
})

test('a run directory that is group-readable (0750) is not a published directory', () => {
  const dir = fresh()
  publish(dir, 0)
  const run = path.join(dir, readdirOf(dir)[0]!)
  chmodSync(run, 0o750)
  assert.equal(chainCode(dir), 'PAIR_INVALID')
  chmodSync(run, 0o700)
  assert.equal(chainCode(dir), 'ok')
  writeFileSync(path.join(dir, 'README'), 'not a run directory')
  assert.equal(chainCode(dir), 'ok', 'unrelated names are ignored, not trusted as reports')
})
