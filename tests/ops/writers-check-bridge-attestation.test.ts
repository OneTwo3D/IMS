import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BRIDGE_HEADER_FOR_TESTS,
  sampleReport,
} from './bridge-status-fixtures'
import { evaluateWritersCheck, type WritersCheckInputs } from '../../lib/ops/writers-check'
import { NATIVE_EMAIL_VIOLATION, readStepEvidence, STEP_EVIDENCE_READERS } from '../../lib/ops/writers-check-step-evidence'
import { bridgePayloadFromReport, bridgeStatusFreshnessError, bridgeUnitViolations, parseBridgeStatusOutput, readBridgePayload } from '../../lib/domain/writer-attestation/bridge-status'
import { STEP_EVIDENCE_KINDS, type StepEvidenceKind, type StepEvidenceReading } from '../../lib/security/writers-check-constants'

/**
 * BRIDGE_ATTESTATION (o3d-9f5rr): the pasted output of scripts/bridge/bridge_writers_status.py, its strict parser, its reader and the check's verdict.
 * Each arm names the mutation it is built to catch.
 */

const NOW = new Date('2026-12-20T12:00:00Z')
const M_AT = '2026-12-01T00:00:00Z'
const GRANTS = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test' }
const SETTINGS_ON = new Map<string, string>([['trackship_refire_enabled', 'true'], ['mintsoft_parent_sku_delete_enabled', 'true']])

function clean(): Record<StepEvidenceKind, StepEvidenceReading> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  for (const kind of STEP_EVIDENCE_KINDS) {
    out[kind] = kind === 'BRIDGE_ATTESTATION' ? { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T23:55:00.000Z' }
      : kind.startsWith('QOBLEX') ? { state: 'present', at: '2026-11-01T00:00:00.000Z' }
      : kind === 'BRIDGE_PROBE' || kind === 'NATIVE_EMAIL_EXCLUSIVE' ? { state: 'probed', violations: [] }
      : { state: 'counted', counted: 0, floor: M_AT }
  }
  return out
}

function inputs(env: Record<string, string>, stepEvidence: Record<StepEvidenceKind, StepEvidenceReading>): WritersCheckInputs {
  return {
    env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all', ...env }, now: NOW, windowDays: 14, settings: SETTINGS_ON, cronEnabled: { 'wms-order-push': true },
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    evidence: Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: 0, total: 0, unpaid: 0, floor: M_AT }])) as never,
    stepEvidence, evidenceUnrecorded: 0, unknownEvidenceKinds: 0,
  }
}
const STEP_M = { ...GRANTS, MINTSOFT_WRITES_LIVE_FROM: M_AT }
const bridgeFindings = (report: ReturnType<typeof evaluateWritersCheck>) => report.findings.filter((f) => f.subject === 'BRIDGE_ATTESTATION')

test('the parser reads the script output and refuses anything that is not exactly it (missing unit, repeated unit, unknown line, bad time, no header)', () => {
  const ok = parseBridgeStatusOutput(sampleReport())
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  assert.equal(ok.report.units['wc-mintsoft-order-sweep.timer'].loadState, 'masked')
  assert.equal(ok.report.lastTriggerAt, '2026-11-30T23:55:01.000Z')
  assert.equal(parseBridgeStatusOutput(sampleReport({ lastTrigger: 'never' })).ok && (parseBridgeStatusOutput(sampleReport({ lastTrigger: 'never' })) as { report: { lastTriggerAt: unknown } }).report.lastTriggerAt, null)
  const refused = (text: string) => { const r = parseBridgeStatusOutput(text); assert.equal(r.ok, false, text); return r.ok ? '' : r.error }
  refused('')
  refused(sampleReport().replace(BRIDGE_HEADER_FOR_TESTS, '# something else'))
  refused(sampleReport().split('\n').filter((l) => !l.includes('webhook.service')).join('\n'))
  refused(`${sampleReport()}unit: wc-mintsoft-webhook.service LoadState=masked ActiveState=inactive UnitFileState=masked\n`)
  refused(`${sampleReport()}rm -rf /\n`)
  refused(sampleReport({ lastTrigger: 'yesterday' }))
  refused(sampleReport({ generatedAt: '2026-12-31 10:00' }))
  refused(sampleReport().replace(' UnitFileState=masked', '').replace(' UnitFileState=masked', '').replace(' UnitFileState=masked', ''))
  refused(sampleReport({ extraUnit: 'cron.service' }))
  assert.match(refused(sampleReport({ lastTrigger: '' })), /last_trigger/)
})

test('freshness: a report older than an hour, or stamped in the future, is refused at recording time', () => {
  const parsed = parseBridgeStatusOutput(sampleReport({ generatedAt: '2026-12-20T11:30:00Z' }))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(bridgeStatusFreshnessError(parsed.report, NOW), null)
  assert.match(bridgeStatusFreshnessError(parsed.report, new Date('2026-12-20T13:00:01Z')) ?? '', /older than an hour/)
  assert.match(bridgeStatusFreshnessError(parsed.report, new Date('2026-12-20T11:00:00Z')) ?? '', /future/)
})

test('unit judgement: all three masked and inactive is clean; one active, one unmasked and one not-found each name themselves (MUTATION: judge only the timer => red)', () => {
  const report = (overrides: Record<string, string>) => { const p = parseBridgeStatusOutput(sampleReport({ units: overrides })); assert.ok(p.ok); return p.ok ? p.report : null! }
  assert.deepEqual(bridgeUnitViolations(report({})), [])
  assert.deepEqual(bridgeUnitViolations(report({ 'wc-mintsoft-webhook.service': 'LoadState=loaded ActiveState=active UnitFileState=enabled' })), [
    'bridge-unit-not-masked:wc-mintsoft-webhook.service', 'bridge-unit-not-inactive:wc-mintsoft-webhook.service',
  ])
  assert.deepEqual(bridgeUnitViolations(report({ 'wc-mintsoft-order-sweep.service': 'LoadState=masked ActiveState=active UnitFileState=masked' })), ['bridge-unit-not-inactive:wc-mintsoft-order-sweep.service'])
  assert.deepEqual(bridgeUnitViolations(report({ 'wc-mintsoft-order-sweep.timer': 'LoadState=not-found ActiveState=inactive UnitFileState=none' })), ['bridge-unit-not-masked:wc-mintsoft-order-sweep.timer'])
})

test('the reader: no attestation is absent (not not-built); a clean report is present with its facts; a failing report carries its violations; a payload of another shape is unreadable', async () => {
  const parsed = parseBridgeStatusOutput(sampleReport())
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const payload = bridgePayloadFromReport(parsed.report, sampleReport())
  const dbWith = (row: { attestedAt: Date; payload: unknown } | null) => ({ writerAttestation: { findFirst: async () => row } }) as never
  assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith(null), now: NOW }), { state: 'absent' })
  assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload }), now: NOW }), {
    state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T23:55:01.000Z',
  })
  const bad = parseBridgeStatusOutput(sampleReport({ units: { 'wc-mintsoft-webhook.service': 'LoadState=loaded ActiveState=active UnitFileState=enabled' } }))
  assert.ok(bad.ok)
  if (!bad.ok) return
  const failing = await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload: bridgePayloadFromReport(bad.report, '') }), now: NOW })
  assert.equal(failing.state, 'present')
  assert.deepEqual((failing.state === 'present' ? (failing.violations ?? []).length : -1), 2)
  for (const garbage of [{}, null, 'text', { schema: 2 }, { ...payload, units: {} }, { ...payload, generatedAt: 'x' }]) {
    assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload: garbage }), now: NOW }), { state: 'unreadable' })
  }
  assert.equal(readBridgePayload(payload)?.host, 'bridge-host')
  const broken = await readStepEvidence({ db: { writerAttestation: { findFirst: async () => { throw new Error('no table') } } } as never, now: NOW })
  assert.deepEqual(broken.BRIDGE_ATTESTATION, { state: 'unreadable' })
})

test('NOT DUE IN P1: with no step live the check passes whatever the bridge reading is (absent, unreadable, a failing report) (MUTATION: require it in P1 => red)', () => {
  for (const reading of [{ state: 'absent' }, { state: 'unreadable' }, { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: ['bridge-unit-not-masked:wc-mintsoft-webhook.service'], lastTriggerAt: '2026-12-19T00:00:00.000Z' }] as StepEvidenceReading[]) {
    const report = evaluateWritersCheck(inputs({}, { ...clean(), BRIDGE_ATTESTATION: reading }))
    assert.equal(report.phase, 'P1')
    assert.deepEqual(bridgeFindings(report), [], JSON.stringify(reading))
    assert.equal(report.verdict, 'ok')
  }
})

test('P2-M: a clean report with the last trigger before S passes; absent fails; unreadable fails; NOT-BUILT no longer appears (MUTATION: keep notBuilt => red)', () => {
  const ok = evaluateWritersCheck(inputs(STEP_M, clean()))
  assert.deepEqual(bridgeFindings(ok), [])
  const absent = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'absent' } }))
  assert.ok(bridgeFindings(absent).some((f) => f.code === 'attestation-missing'))
  const unreadable = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'unreadable' } }))
  assert.ok(bridgeFindings(unreadable).some((f) => f.code === 'unreadable'))
  assert.ok(!bridgeFindings(ok).some((f) => f.code === 'evidence-source-not-built'))
})

test('P2-M: a trigger AT or AFTER S fails, one before S passes, "never" passes (MUTATION: compare with > instead of >= or drop the comparison => red)', () => {
  const at = (lastTriggerAt: string | null) => evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt } }))
  assert.deepEqual(bridgeFindings(at('2026-11-30T23:59:59.000Z')), [])
  assert.deepEqual(bridgeFindings(at(null)), [])
  for (const late of ['2026-12-01T00:00:00.000Z', '2026-12-01T00:00:01.000Z', '2026-12-10T00:00:00.000Z']) {
    const found = bridgeFindings(at(late))
    assert.ok(found.some((f) => f.code === 'step-evidence-violation' && /not before/.test(f.message)), late)
  }
  assert.ok(bridgeFindings(at('2026-12-10T00:00:00.000Z')).every((f) => f.severity === 'fail'))
})

test('P2-M: an unmasked or active unit fails, and so does a reading that carries no report facts (fail closed)', () => {
  const bad = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: ['bridge-unit-not-masked:wc-mintsoft-webhook.service'], lastTriggerAt: null } }))
  assert.ok(bridgeFindings(bad).some((f) => f.code === 'step-evidence-violation' && /not-masked/.test(f.message)))
  const bare = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z' } }))
  assert.ok(bridgeFindings(bare).some((f) => f.code === 'unreadable'), 'a present reading without facts is not a pass')
  assert.notEqual(bad.exitCode, 0)
})

test('the report is NOT required to be recorded before S (the runbook takes it after S): a report recorded after S with a clean state passes', () => {
  const report = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-19T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T00:00:00.000Z' } }))
  assert.deepEqual(bridgeFindings(report), [])
})

test('NATIVE_EMAIL_EXCLUSIVE reader: not read from the store before step W; both on and both off are violations; exactly one passes; an unreadable store is unreadable (MUTATION: treat unreadable as off => red)', async () => {
  const dbWith = (value: string | null) => ({ setting: { findUnique: async () => (value === null ? null : { value }) } }) as never
  const on = { ok: true as const, enabled: { customer_processing_order: true, customer_completed_order: false } }
  const off = { ok: true as const, enabled: { customer_processing_order: false, customer_completed_order: false } }
  let reads = 0
  const read = (state: unknown) => async () => { reads += 1; return state as never }
  const reader = STEP_EVIDENCE_READERS.NATIVE_EMAIL_EXCLUSIVE
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, env: {}, readNativeEmail: read(on) }), { state: 'absent' })
  assert.equal(reads, 0, 'no WC_WRITES_LIVE_FROM: the store is not asked')
  const env = { WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, env, readNativeEmail: read(on) }), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.bothOn] })
  assert.deepEqual(await reader({ db: dbWith(null), now: NOW, env, readNativeEmail: read(off) }), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.bothOff] })
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, env, readNativeEmail: read(off) }), { state: 'probed', violations: [] })
  assert.deepEqual(await reader({ db: dbWith('false'), now: NOW, env, readNativeEmail: read(on) }), { state: 'probed', violations: [] })
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, env, readNativeEmail: read({ ok: false }) }), { state: 'unreadable' })
  const thrown = await readStepEvidence({ db: dbWith('true'), now: NOW, env, readNativeEmail: async () => { throw new Error('network') } })
  assert.deepEqual(thrown.NATIVE_EMAIL_EXCLUSIVE, { state: 'unreadable' })
})

test('P2-W: both-on and an unreadable native state FAIL the check; before W the kind is not required (MUTATION: drop the requirement => red)', () => {
  const W = { ...STEP_M, WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }
  const find = (report: ReturnType<typeof evaluateWritersCheck>) => report.findings.filter((f) => f.subject === 'NATIVE_EMAIL_EXCLUSIVE')
  assert.deepEqual(find(evaluateWritersCheck(inputs(W, clean()))), [])
  const both = find(evaluateWritersCheck(inputs(W, { ...clean(), NATIVE_EMAIL_EXCLUSIVE: { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.bothOn] } })))
  assert.ok(both.some((f) => f.code === 'step-evidence-violation' && f.severity === 'fail'))
  const unreadable = find(evaluateWritersCheck(inputs(W, { ...clean(), NATIVE_EMAIL_EXCLUSIVE: { state: 'unreadable' } })))
  assert.ok(unreadable.some((f) => f.code === 'unreadable' && f.severity === 'fail'), 'fail closed')
  assert.equal(evaluateWritersCheck(inputs(W, { ...clean(), NATIVE_EMAIL_EXCLUSIVE: { state: 'unreadable' } })).verdict, 'unreadable')
  assert.deepEqual(find(evaluateWritersCheck(inputs(STEP_M, { ...clean(), NATIVE_EMAIL_EXCLUSIVE: { state: 'unreadable' } }))), [], 'not due in P2-M')
})

test('the real script, run against a fake systemctl, prints exactly what the parser accepts (and the unit states it was given)', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-status-'))
  try {
    const fake = join(dir, 'fake-systemctl')
    writeFileSync(fake, [
      '#!/bin/sh',
      'for last; do unit="$last"; done',
      'case "$unit" in',
      '  wc-mintsoft-order-sweep.timer) printf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\nLastTriggerUSec=Mon 2026-11-30 23:55:01 UTC\\n";;',
      '  wc-mintsoft-order-sweep.service) printf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\nExecMainStartTimestamp=Mon 2026-11-30 23:55:02 UTC\\nInactiveExitTimestamp=n/a\\n";;',
      '  *) printf "LoadState=loaded\\nActiveState=active\\nUnitFileState=\\n";;',
      'esac',
    ].join('\n'))
    chmodSync(fake, 0o755)
    const fakeJournal = join(dir, 'fake-journalctl')
    writeFileSync(fakeJournal, '#!/bin/sh\nexit 1\n')
    chmodSync(fakeJournal, 0o755)
    const out = execFileSync('python3', ['-I', join(process.cwd(), 'scripts/bridge/bridge_writers_status.py'), '--systemctl', fake, '--journalctl', fakeJournal], { encoding: 'utf8' })
    const parsed = parseBridgeStatusOutput(out)
    assert.ok(parsed.ok, out)
    if (!parsed.ok) return
    assert.equal(parsed.report.lastTriggerAt, '2026-11-30T23:55:02.000Z', 'the latest of the timer trigger and the service start')
    assert.equal(parsed.report.units['wc-mintsoft-webhook.service'].activeState, 'active')
    assert.equal(parsed.report.units['wc-mintsoft-webhook.service'].unitFileState, 'none', 'a blank UnitFileState is reported as none')
    assert.deepEqual(bridgeUnitViolations(parsed.report), ['bridge-unit-not-masked:wc-mintsoft-webhook.service', 'bridge-unit-not-inactive:wc-mintsoft-webhook.service'])
    // A systemctl that fails stops the run: nothing on stdout, exit 2 (never a half report).
    const failing = join(dir, 'failing')
    writeFileSync(failing, '#!/bin/sh\nexit 1\n')
    chmodSync(failing, 0o755)
    assert.throws(() => execFileSync('python3', ['-I', join(process.cwd(), 'scripts/bridge/bridge_writers_status.py'), '--systemctl', failing, '--journalctl', fakeJournal], { encoding: 'utf8', stdio: 'pipe' }), (e: { status?: number }) => e.status === 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
