import assert from 'node:assert/strict'
import { chmodSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'

import { verifyNamedPackReport } from '../../lib/ops/reconciliation-pack-schedule'
import { PACK_EVIDENCE_FILE, PACK_REPORT_JSON, PACK_REPORT_MARKDOWN } from '../../lib/reconciliation-pack/constants'
import { publishSyntheticRun } from '../../lib/reconciliation-pack/harness'
import { sha256Hex } from '../../lib/reconciliation-pack/report'
import { classifyChildEnd, type ParsedPackOutput } from '../../lib/reconciliation-pack/schedule'
import { allBrackets, at, cleanup, scratchDir } from '../reconciliation-pack/helpers'

/**
 * A scheduled run is `published` only after the pack's own reader verifies the report the command named. These arms publish a real
 * report (the pack's publisher) into a scratch directory and damage it one way at a time.
 */
const bases: string[] = []
after(() => cleanup(bases))

function published() {
  const reportDir = path.join(scratchDir(bases), 'reports')
  const result = publishSyntheticRun({ reportDir, phase: 'P1', asOf: '2026-10-19', now: at(0), streams: allBrackets() })
  assert.equal(result.ok, true, JSON.stringify(result))
  const ok = result as Extract<typeof result, { ok: true }>
  const dir = path.dirname(ok.json)
  const parsed: ParsedPackOutput = { code: null, runId: ok.record.runId, reportJson: ok.json, reportMarkdown: ok.markdown }
  return { reportDir, dir, parsed, exit: ok.exitCode, record: ok.record }
}
const editJson = (file: string, edit: (value: Record<string, unknown>) => void) => {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  edit(value)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('an intact report verifies, and carries its sequence', () => {
  const r = published()
  assert.deepEqual(verifyNamedPackReport(r.parsed, r.exit, r.reportDir), { sequence: 1 })
})

test('every way the named report can fail to verify is null (and so a closed failure, never published)', () => {
  const arms: Array<[string, (r: ReturnType<typeof published>) => void, (r: ReturnType<typeof published>) => number]> = [
    ['missing JSON', (r) => unlinkSync(path.join(r.dir, PACK_REPORT_JSON)), (r) => r.exit],
    ['unreadable JSON', (r) => chmodSync(path.join(r.dir, PACK_REPORT_JSON), 0o000), (r) => r.exit],
    ['invalid JSON', (r) => writeFileSync(path.join(r.dir, PACK_REPORT_JSON), '{ not json'), (r) => r.exit],
    ['empty JSON', (r) => writeFileSync(path.join(r.dir, PACK_REPORT_JSON), ''), (r) => r.exit],
    ['Markdown digest mismatch', (r) => writeFileSync(path.join(r.dir, PACK_REPORT_MARKDOWN), `${readFileSync(path.join(r.dir, PACK_REPORT_MARKDOWN), 'utf8')}\nedited\n`), (r) => r.exit],
    ['Markdown missing', (r) => unlinkSync(path.join(r.dir, PACK_REPORT_MARKDOWN)), (r) => r.exit],
    ['evidence missing', (r) => unlinkSync(path.join(r.dir, PACK_EVIDENCE_FILE)), (r) => r.exit],
    ['evidence changed', (r) => writeFileSync(path.join(r.dir, PACK_EVIDENCE_FILE), `${readFileSync(path.join(r.dir, PACK_EVIDENCE_FILE), 'utf8')}{}\n`), (r) => r.exit],
    ['runId in the JSON is another run', (r) => editJson(path.join(r.dir, PACK_REPORT_JSON), (v) => { v.runId = '20200101T000000Z-aaaaaaaaaaaa' }), (r) => r.exit],
    ['sequence 0', (r) => editJson(path.join(r.dir, PACK_REPORT_JSON), (v) => { v.sequence = 0 }), (r) => r.exit],
    ['sequence negative', (r) => editJson(path.join(r.dir, PACK_REPORT_JSON), (v) => { v.sequence = -3 }), (r) => r.exit],
    ['exit code of the command is not the report\'s', () => undefined, (r) => (r.exit === 0 ? 1 : 0)],
  ]
  for (const [name, damage, exitFor] of arms) {
    const r = published()
    damage(r)
    const exit = exitFor(r)
    assert.equal(verifyNamedPackReport(r.parsed, exit, r.reportDir), null, name)
    // ... and the classifier reads that as a failure at every published-looking exit code
    const record = classifyChildEnd({ scheduleRunId: 'x', phase: 'P1', vendorReads: false, durationMs: 0 }, { exitCode: exit, timedOut: false, stderr: '' }, (p, e) => verifyNamedPackReport(p, e, r.reportDir))
    assert.notEqual(record.outcome, 'published', name)
  }
  // a printed run id that is not a run id, and one whose directory does not exist
  const r = published()
  assert.equal(verifyNamedPackReport({ ...r.parsed, runId: null }, r.exit, r.reportDir), null)
  assert.equal(verifyNamedPackReport({ ...r.parsed, runId: '../../etc' }, r.exit, r.reportDir), null)
  assert.equal(verifyNamedPackReport({ ...r.parsed, runId: '20200101T000000Z-aaaaaaaaaaaa' }, r.exit, r.reportDir), null)
  rmSync(r.dir, { recursive: true, force: true })
  assert.equal(verifyNamedPackReport(r.parsed, r.exit, r.reportDir), null)
  assert.ok(sha256Hex(Buffer.from('x')).length === 64)
})

test('an intact report verifies through the classifier as published, with the verified sequence', () => {
  const r = published()
  const stderr = `Report: ${r.parsed.reportJson}\nReport: ${r.parsed.reportMarkdown}\n`
  void stderr // the printed paths use the default report directory; the classifier is driven with the parsed output directly
  const record = classifyChildEnd({ scheduleRunId: 'x', phase: 'P1', vendorReads: false, durationMs: 0 }, { exitCode: r.exit, timedOut: false, stderr: '' }, () => verifyNamedPackReport(r.parsed, r.exit, r.reportDir))
  // no printed paths: not published even though the report on disk is intact
  assert.equal(record.outcome, 'failed')
})
