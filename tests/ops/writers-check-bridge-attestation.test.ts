import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BRIDGE_HEADER_FOR_TESTS,
  sampleReport,
} from './bridge-status-fixtures'
import { evaluateWritersCheck, type WritersCheckInputs } from '../../lib/ops/writers-check'
import { NATIVE_EMAIL_VIOLATION, readStepEvidence, STEP_EVIDENCE_READERS } from '../../lib/ops/writers-check-step-evidence'

/** The two readers under test never use the shared probe; the reader context just requires one. */
const noProbe = async () => ({ ok: false as const, reason: 'unreachable' as const, message: 'unused' })
import { bridgeLastTriggerReadable, bridgePayloadFromReport, bridgeStatusFreshnessError, bridgeUnitViolations, parseBridgeStatusOutput, readBridgePayload } from '../../lib/domain/writer-attestation/bridge-status'
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
    out[kind] = kind === 'BRIDGE_ATTESTATION' ? { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T23:55:00.000Z', generatedAt: '2026-12-02T00:00:00.000Z' }
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
  assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith(null), now: NOW, probeOnce: noProbe }), { state: 'absent' })
  assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload }), now: NOW, probeOnce: noProbe }), {
    state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T23:55:01.000Z', generatedAt: '2026-12-20T11:55:00.000Z', journalEarliestAt: '2026-10-01T00:00:00.000Z',
  })
  const bad = parseBridgeStatusOutput(sampleReport({ units: { 'wc-mintsoft-webhook.service': 'LoadState=loaded ActiveState=active UnitFileState=enabled' } }))
  assert.ok(bad.ok)
  if (!bad.ok) return
  const failing = await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload: bridgePayloadFromReport(bad.report, '') }), now: NOW, probeOnce: noProbe })
  assert.equal(failing.state, 'present')
  assert.deepEqual((failing.state === 'present' ? (failing.violations ?? []).length : -1), 2)
  for (const garbage of [{}, null, 'text', { schema: 2 }, { ...payload, units: {} }, { ...payload, generatedAt: 'x' }]) {
    assert.deepEqual(await STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload: garbage }), now: NOW, probeOnce: noProbe }), { state: 'unreadable' })
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
  const at = (lastTriggerAt: string | null) => evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt, generatedAt: '2026-12-02T00:00:00.000Z', journalEarliestAt: '2026-10-01T00:00:00.000Z' } }))
  assert.deepEqual(bridgeFindings(at('2026-11-30T23:59:59.000Z')), [])
  assert.deepEqual(bridgeFindings(at(null)), [])
  for (const late of ['2026-12-01T00:00:00.000Z', '2026-12-01T00:00:01.000Z', '2026-12-10T00:00:00.000Z']) {
    const found = bridgeFindings(at(late))
    assert.ok(found.some((f) => f.code === 'step-evidence-violation' && /not before/.test(f.message)), late)
  }
  assert.ok(bridgeFindings(at('2026-12-10T00:00:00.000Z')).every((f) => f.severity === 'fail'))
})

test('P2-M: an unmasked or active unit fails, and so does a reading that carries no report facts (fail closed)', () => {
  const bad = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: ['bridge-unit-not-masked:wc-mintsoft-webhook.service'], lastTriggerAt: null, journalEarliestAt: '2000-01-01T00:00:00.000Z' } }))
  assert.ok(bridgeFindings(bad).some((f) => f.code === 'step-evidence-violation' && /not-masked/.test(f.message)))
  const bare = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-02T00:00:00.000Z' } }))
  assert.ok(bridgeFindings(bare).some((f) => f.code === 'unreadable'), 'a present reading without facts is not a pass')
  assert.notEqual(bad.exitCode, 0)
})

test('the report is NOT required to be recorded before S (the runbook takes it after S): a report recorded after S with a clean state passes', () => {
  const report = evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: { state: 'present', at: '2026-12-19T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T00:00:00.000Z', generatedAt: '2026-12-19T00:00:00.000Z' } }))
  assert.deepEqual(bridgeFindings(report), [])
})

test('NATIVE_EMAIL_EXCLUSIVE reader: not read from the store before step W; both on and both off are violations; exactly one passes; an unreadable store is unreadable (MUTATION: treat unreadable as off => red)', async () => {
  // The switch row, and (the second argument) the switch-on stamp row: a valid stamp by default.
  const dbWith = (value: string | null, stamp: string | null = '2026-12-08T00:00:00Z') => ({ setting: { findUnique: async ({ where }: { where: { key: string } }) => {
    const v = where.key === 'storefront_customer_email_enabled_at' ? stamp : value
    return v === null ? null : { value: v }
  } } }) as never
  const on = { ok: true as const, enabled: { customer_processing_order: true, customer_completed_order: false } }
  const off = { ok: true as const, enabled: { customer_processing_order: false, customer_completed_order: false } }
  let reads = 0
  const read = (state: unknown) => async () => { reads += 1; return state as never }
  const reader = STEP_EVIDENCE_READERS.NATIVE_EMAIL_EXCLUSIVE
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, probeOnce: noProbe, env: {}, readNativeEmail: read(on) }), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.imsOnBeforeStepW] })
  assert.equal(reads, 0, 'no WC_WRITES_LIVE_FROM: the store is not asked')
  const env = { WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(on) }), { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOn}:customer_processing_order`] })
  assert.deepEqual(await reader({ db: dbWith(null), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(off) }), { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOff}:customer_processing_order`, `${NATIVE_EMAIL_VIOLATION.bothOff}:customer_completed_order`] })
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(off) }), { state: 'probed', violations: [] })
  assert.deepEqual(await reader({ db: dbWith('false'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read({ ok: true, enabled: { customer_processing_order: true, customer_completed_order: true } }) }), { state: 'probed', violations: [] })
  // JUDGED PER E-MAIL (MUTATION: "either native on counts as sending" => red): IMS off with processing OFF and completed ON leaves the confirmation with NO sender.
  assert.deepEqual(await reader({ db: dbWith('false'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read({ ok: true, enabled: { customer_processing_order: false, customer_completed_order: true } }) }), { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOff}:customer_processing_order`] })
  assert.deepEqual(await reader({ db: dbWith('false'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(on) }), { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOff}:customer_completed_order`] })
  // BEFORE STEP W the store is not asked, but the IMS switch being ON is itself a violation (unset, unreadable and future live-from alike).
  reads = 0
  for (const early of [{}, { WC_WRITES_LIVE_FROM: 'soon' }, { WC_WRITES_LIVE_FROM: '2027-01-01T00:00:00Z' }]) {
    assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, probeOnce: noProbe, env: early, readNativeEmail: read(off) }), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.imsOnBeforeStepW] })
    assert.deepEqual(await reader({ db: dbWith('false'), now: NOW, probeOnce: noProbe, env: early, readNativeEmail: read(off) }), { state: 'absent' })
  }
  assert.equal(reads, 0)
  assert.deepEqual(await reader({ db: dbWith('true'), now: NOW, probeOnce: noProbe, env, readNativeEmail: read({ ok: false }) }), { state: 'unreadable' })
  // The switch ON with NO (or an unreadable) switch-on stamp is a violation: IMS sends nothing (fails closed) while the native e-mails are off (MUTATION: drop the stamp check => red).
  for (const stamp of [null, 'garbage']) {
    assert.deepEqual(await reader({ db: dbWith('true', stamp), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(off) } as never), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.onWithoutStamp] }, String(stamp))
    assert.deepEqual(await reader({ db: dbWith('true', stamp), now: NOW, probeOnce: noProbe, env: {}, readNativeEmail: read(off) }), { state: 'probed', violations: [NATIVE_EMAIL_VIOLATION.imsOnBeforeStepW, NATIVE_EMAIL_VIOLATION.onWithoutStamp] })
  }
  assert.deepEqual(await reader({ db: dbWith('false', null), now: NOW, probeOnce: noProbe, env, readNativeEmail: read(on) }), { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOff}:customer_completed_order`] }, 'switch off: the stamp is irrelevant')
  const thrown = await readStepEvidence({ db: dbWith('true'), now: NOW, env, readNativeEmail: async () => { throw new Error('network') } })
  assert.deepEqual(thrown.NATIVE_EMAIL_EXCLUSIVE, { state: 'unreadable' })
})

test('P2-W: both-on and an unreadable native state FAIL the check; before W the kind is not required (MUTATION: drop the requirement => red)', () => {
  const W = { ...STEP_M, WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }
  const find = (report: ReturnType<typeof evaluateWritersCheck>) => report.findings.filter((f) => f.subject === 'NATIVE_EMAIL_EXCLUSIVE')
  assert.deepEqual(find(evaluateWritersCheck(inputs(W, clean()))), [])
  const both = find(evaluateWritersCheck(inputs(W, { ...clean(), NATIVE_EMAIL_EXCLUSIVE: { state: 'probed', violations: [`${NATIVE_EMAIL_VIOLATION.bothOn}:customer_processing_order`] } })))
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
    assert.equal(parsed.report.journalExit, 1, 'the journalctl exit status is reported (here the fake journal fails)')
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// o3d-pdnzu items 1 to 3 (and the forgery note).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const reading = (over: Record<string, unknown>) => ({ state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: '2026-11-30T23:55:00.000Z', generatedAt: '2026-12-02T00:00:00.000Z', ...over }) as StepEvidenceReading

test('ITEM 1: a report generated, or recorded, before S is not evidence about the host after S (MUTATION: drop the >= S comparison on either time => red)', () => {
  const generatedBefore = bridgeFindings(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ generatedAt: '2026-11-30T23:59:59.000Z' }) })))
  assert.ok(generatedBefore.some((f) => f.code === 'attestation-missing' && /generated before MINTSOFT_WRITES_LIVE_FROM/.test(f.message)), JSON.stringify(generatedBefore))
  const recordedBefore = bridgeFindings(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ at: '2026-11-30T23:59:59.000Z' }) })))
  assert.ok(recordedBefore.some((f) => f.code === 'attestation-missing' && /recorded before/.test(f.message)), JSON.stringify(recordedBefore))
  // exactly at S passes (>=), as does later
  assert.deepEqual(bridgeFindings(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ generatedAt: M_AT, at: M_AT }) }))), [])
  // no generation time on the reading: no facts, not a pass
  assert.ok(bridgeFindings(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ generatedAt: undefined }) }))).some((f) => f.code === 'unreadable'))
  // the reader hands the report's own generation time to the evaluator
  assert.notEqual(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ generatedAt: '2026-11-30T23:59:59.000Z' }) })).exitCode, 0)
})

test('ITEM 2: UnitFileState must be exactly `masked`: masked-runtime (lost at reboot) and anything else is a violation naming the unit (MUTATION: ignore UnitFileState => red)', () => {
  const report = (state: string) => { const p = parseBridgeStatusOutput(sampleReport({ units: { 'wc-mintsoft-webhook.service': `LoadState=masked ActiveState=inactive UnitFileState=${state}` } })); assert.ok(p.ok); return p.ok ? p.report : null! }
  assert.deepEqual(bridgeUnitViolations(report('masked')), [])
  assert.deepEqual(bridgeUnitViolations(report('masked-runtime')), ['bridge-unit-not-persistently-masked:wc-mintsoft-webhook.service'])
  assert.deepEqual(bridgeUnitViolations(report('enabled')), ['bridge-unit-not-persistently-masked:wc-mintsoft-webhook.service'])
  assert.deepEqual(bridgeUnitViolations(report('none')), ['bridge-unit-not-persistently-masked:wc-mintsoft-webhook.service'])
})

test('ITEM 3: `never` is believed only with journal_exit: 0; `unknown`, a `never` without the journal proof and a failed journal read are UNREADABLE (MUTATION: accept never outright => red)', async () => {
  const parsed = (options: Parameters<typeof sampleReport>[0]) => { const p = parseBridgeStatusOutput(sampleReport(options)); assert.ok(p.ok, JSON.stringify(options)); return p.ok ? p.report : null! }
  assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: 'never', journalExit: 0 })), true)
  assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: 'never', journalExit: 1 })), false)
  assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: 'never', journalExit: null })), false, 'a report from the older script has no proof')
  assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: 'unknown' })), false)
  assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: '2026-11-30T23:55:01Z', journalExit: 1 })), true, 'a time is a time')
  assert.equal(parsed({ lastTrigger: 'unknown' }).lastTriggerAt, null)
  assert.equal(parseBridgeStatusOutput(`${sampleReport()}journal_exit: 0\n`).ok, false, 'journal_exit twice is refused')
  assert.equal(parseBridgeStatusOutput(sampleReport().replace('journal_exit: 0', 'journal_exit: x')).ok, false)
  const dbWith = (report: ReturnType<typeof parsed>) => ({ writerAttestation: { findFirst: async () => ({ attestedAt: new Date('2026-12-02T00:00:00Z'), payload: bridgePayloadFromReport(report, '') }) } }) as never
  const read = (options: Parameters<typeof sampleReport>[0]) => STEP_EVIDENCE_READERS.BRIDGE_ATTESTATION({ db: dbWith(parsed(options)), now: NOW, probeOnce: noProbe })
  assert.deepEqual(await read({ lastTrigger: 'never', journalExit: 0 }), { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: null, generatedAt: '2026-12-20T11:55:00.000Z', journalEarliestAt: '2026-10-01T00:00:00.000Z' })
  for (const bad of [{ lastTrigger: 'unknown' }, { lastTrigger: 'never', journalExit: null }, { lastTrigger: 'never', journalExit: 2 }]) assert.deepEqual(await read(bad), { state: 'unreadable' }, JSON.stringify(bad))
  // `never` also needs a READABLE, PERSISTENT journal with an earliest entry (exit 0 alone is not proof)
  for (const bad of [{ journalReadable: 0 as const }, { journalPersistent: 0 as const }, { journalEarliest: null }, { journalReadable: null }, { journalPersistent: null }]) {
    assert.equal(bridgeLastTriggerReadable(parsed({ lastTrigger: 'never', journalExit: 0, ...bad })), false, JSON.stringify(bad))
    assert.deepEqual(await read({ lastTrigger: 'never', journalExit: 0, ...bad }), { state: 'unreadable' }, JSON.stringify(bad))
  }
  // A payload stored before the two fields existed: a time still reads, a `never` is unproven.
  const old = (lastTriggerAt: string | null) => ({ schema: 1, host: 'h', generatedAt: '2026-12-02T00:00:00.000Z', lastTriggerAt, units: Object.fromEntries(['wc-mintsoft-order-sweep.timer', 'wc-mintsoft-order-sweep.service', 'wc-mintsoft-webhook.service'].map((u) => [u, { loadState: 'masked', activeState: 'inactive', unitFileState: 'masked' }])) })
  assert.equal(bridgeLastTriggerReadable(readBridgePayload(old('2026-11-30T00:00:00.000Z'))!), true)
  assert.equal(bridgeLastTriggerReadable(readBridgePayload(old(null))!), false)
})

/** The script's test seams are refused unless this variable is set (only the tests set it). */
const SEAM_ENV = { ...process.env, BRIDGE_WRITERS_STATUS_TEST_SEAMS: '1' }
/** A stand-in for /proc/sys/kernel/random/boot_id holding the boot id the fake journals report as current. */
function kernelBootId(dir: string, value = '01234567-89ab-cdef-0123-456789abcdef'): string {
  const path = join(dir, `kernel-boot-id-${value.length}-${value.slice(0, 4)}`)
  writeFileSync(path, `${value}\n`)
  return path
}

test('ITEM 3: the real script reports the journalctl exit status, folds the webhook service\'s timestamps into last_trigger, and writes `unknown` (never `never`) when the times were lost and the journal could not be read', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-status-'))
  try {
    const script = join(process.cwd(), 'scripts/bridge/bridge_writers_status.py')
    const systemctl = (webhookTimes: string) => {
      const path = join(dir, `systemctl-${webhookTimes.length}`)
      writeFileSync(path, [
        '#!/bin/sh',
        'for last; do unit="$last"; done',
        'case "$unit" in',
        '  wc-mintsoft-order-sweep.timer) printf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\nLastTriggerUSec=n/a\\n";;',
        '  wc-mintsoft-order-sweep.service) printf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\nExecMainStartTimestamp=n/a\\nInactiveExitTimestamp=n/a\\n";;',
        `  *) printf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\n${webhookTimes}";;`,
        'esac',
      ].join('\n'))
      chmodSync(path, 0o755)
      return path
    }
    const journal = (body: string) => { const path = join(dir, `journal-${body.length}`); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }
    const jdir = join(dir, 'persistent-journal')
    mkdirSync(jdir)
    // The journal facts are the test's (a readable, persistent journal), so these arms isolate what they are about.
    const run = (sys: string, jrn: string) => execFileSync('python3', ['-I', script, '--systemctl', sys, '--journalctl', jrn, '--assume-groups', 'systemd-journal', '--journal-dir', jdir, '--journald-conf', join(dir, 'none.conf'), '--kernel-boot-id', kernelBootId(dir)], { encoding: 'utf8', env: SEAM_ENV })
    // 1. times lost (a reboot) and the journal unreadable: `unknown`, with the exit status printed
    const lost = run(systemctl(''), journal('exit 1'))
    assert.match(lost, /^journal_exit: 1$/m)
    assert.match(lost, /^last_trigger: unknown$/m)
    assert.doesNotMatch(lost, /last_trigger: never/)
    // 2. nothing found and every journal read succeeded: the one case in which `never` is proven
    const never = run(systemctl(''), journal('case "$*" in *--list-boots*) printf \'[{"index":0,"boot_id":"0123456789abcdef0123456789abcdef","first_entry":1760000000000000}]\';; esac; exit 0'))
    assert.match(never, /^journal_exit: 0$/m)
    assert.match(never, /^last_trigger: never$/m)
    // 3. the WEBHOOK service's own timestamps count (it had no time property before)
    const webhook = run(systemctl('ExecMainStartTimestamp=Wed 2026-12-02 08:00:00 UTC\\nInactiveExitTimestamp=n/a\\n'), journal('exit 0'))
    assert.match(webhook, /^last_trigger: 2026-12-02T08:00:00Z$/m)
    // every output is accepted by the parser; `unknown` and a proven `never` read as the evaluator will judge them
    const parsedLost = parseBridgeStatusOutput(lost)
    assert.ok(parsedLost.ok && !bridgeLastTriggerReadable(parsedLost.report))
    const parsedNever = parseBridgeStatusOutput(never)
    assert.ok(parsedNever.ok && bridgeLastTriggerReadable(parsedNever.report))
    // a journal entry of the webhook unit after S counts too
    const withEntry = run(systemctl(''), journal('printf \'{"__REALTIME_TIMESTAMP":"1796198400000000"}\\n\''))
    assert.match(withEntry, /^last_trigger: 2026-12-02T08:00:00Z$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FORGERY NOTE: the check\'s own "cannot see" list and the script say the pasted report is the owner\'s word plus a transcript, not host evidence', async () => {
  const { WRITERS_CHECK_CANNOT_SEE } = await import('../../lib/security/writers-check-constants')
  assert.ok(WRITERS_CHECK_CANNOT_SEE.some((line) => /plain pasted text/.test(line) && /not evidence signed by the host/i.test(line) && /forgery/.test(line)))
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('scripts/bridge/bridge_writers_status.py', 'utf8'), /not evidence signed by this host/)
})

test('NEVER proof: the evaluator believes `never` only when the journal\'s earliest entry is BEFORE S (MUTATION: drop the earliest-before-S comparison => red)', () => {
  const never = (journalEarliestAt: string | null | undefined) => bridgeFindings(evaluateWritersCheck(inputs(STEP_M, { ...clean(), BRIDGE_ATTESTATION: reading({ lastTriggerAt: null, journalEarliestAt }) })))
  assert.deepEqual(never('2026-10-01T00:00:00.000Z'), [], 'a journal reaching back before S: never is proven')
  for (const bad of ['2026-12-01T00:00:00.000Z', '2026-12-05T00:00:00.000Z', null, undefined]) {
    assert.ok(never(bad).some((f) => f.code === 'unreadable' && /does not reach back before/.test(f.message)), String(bad))
  }
  // a journal that began after S (a reboot with a volatile journal) is the reviewer's scenario
})

test('NEVER proof: the script reports journal_readable / journal_persistent / journal_earliest / boot, and prints `never` only for a readable persistent journal with entries', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-status-'))
  try {
    const script = join(process.cwd(), 'scripts/bridge/bridge_writers_status.py')
    const systemctl = join(dir, 'systemctl')
    writeFileSync(systemctl, '#!/bin/sh\nprintf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\n"\n')
    chmodSync(systemctl, 0o755)
    const boots = '[{"index":-1,"boot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","first_entry":1760000000000000,"last_entry":1764000000000000},{"index":0,"boot_id":"0123456789abcdef0123456789abcdef","first_entry":1764547200000000,"last_entry":1766000000000000}]'
    const journal = (header: number, listBoots: string) => {
      const path = join(dir, `journalctl-${header}-${listBoots.length}`)
      writeFileSync(path, `#!/bin/sh\ncase "$*" in\n  *--header*) exit ${header};;\n  *--list-boots*) printf '%s' '${listBoots}'; exit 0;;\n  *) exit 0;;\nesac\n`)
      chmodSync(path, 0o755)
      return path
    }
    const persistentDir = join(dir, 'var-log-journal')
    mkdirSync(persistentDir)
    const conf = join(dir, 'journald.conf')
    writeFileSync(conf, '[Journal]\n')
    const run = (jrn: string, extra: string[]) => execFileSync('python3', ['-I', script, '--systemctl', systemctl, '--journalctl', jrn, '--assume-groups', 'systemd-journal', '--journald-conf', conf, '--kernel-boot-id', kernelBootId(dir), ...extra], { encoding: 'utf8', env: SEAM_ENV })
    // readable + persistent + entries, nothing triggered: `never`, with the evidence printed
    const ok = run(journal(0, boots), ['--journal-dir', persistentDir])
    assert.match(ok, /^journal_readable: 1$/m)
    assert.match(ok, /^journal_persistent: 1$/m)
    assert.match(ok, /^journal_earliest: 2025-10-09T08:53:20Z$/m)
    assert.match(ok, /^boot_id: 0123456789abcdef0123456789abcdef$/m)
    assert.match(ok, /^boot_started: 2025-12-01T00:00:00Z$/m)
    assert.match(ok, /^last_trigger: never$/m)
    const parsedOk = parseBridgeStatusOutput(ok)
    assert.ok(parsedOk.ok && bridgeLastTriggerReadable(parsedOk.report) && parsedOk.report.journalEarliestAt === '2025-10-09T08:53:20.000Z')
    // a volatile journal (no /var/log/journal): not persistent, so `unknown`
    const volatile = run(journal(0, boots), ['--journal-dir', join(dir, 'missing')])
    assert.match(volatile, /^journal_persistent: 0$/m)
    assert.match(volatile, /^last_trigger: unknown$/m)
    // Storage=volatile in journald.conf even though the directory exists
    writeFileSync(conf, '[Journal]\nStorage=volatile\n')
    assert.match(run(journal(0, boots), ['--journal-dir', persistentDir]), /^journal_persistent: 0$/m)
    writeFileSync(conf, '[Journal]\n')
    // `journalctl --header` failing: not readable, so `unknown`, no earliest entry
    const unreadable = run(journal(1, boots), ['--journal-dir', persistentDir])
    assert.match(unreadable, /^journal_readable: 0$/m)
    assert.match(unreadable, /^journal_earliest: none$/m)
    assert.match(unreadable, /^last_trigger: unknown$/m)
    // a user outside root / systemd-journal / adm: not readable even though journalctl exits 0
    const outsider = execFileSync('python3', ['-I', script, '--systemctl', systemctl, '--journalctl', journal(0, boots), '--assume-groups', 'users', '--journald-conf', conf, '--journal-dir', persistentDir, '--kernel-boot-id', kernelBootId(dir)], { encoding: 'utf8', env: SEAM_ENV })
    if (process.geteuid?.() !== 0) {
      assert.match(outsider, /^journal_readable: 0$/m)
      assert.match(outsider, /^last_trigger: unknown$/m)
    }
    const parsedUnreadable = parseBridgeStatusOutput(unreadable)
    assert.ok(parsedUnreadable.ok && !bridgeLastTriggerReadable(parsedUnreadable.report))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o3d-3634b: the test seams (--assume-groups and the others) are refused outside the tests, so a non-privileged run can never count as privileged (MUTATION: honour the flag without the environment variable => red)', { skip: process.platform === 'win32' }, () => {
  const script = join(process.cwd(), 'scripts/bridge/bridge_writers_status.py')
  const env = { ...process.env }
  delete env.BRIDGE_WRITERS_STATUS_TEST_SEAMS
  for (const flag of [['--assume-groups', 'systemd-journal'], ['--kernel-boot-id', '/dev/null'], ['--journal-dir', '/tmp'], ['--journald-conf', '/dev/null']]) {
    const done = spawnSync('python3', ['-I', script, '--systemctl', 'true', '--journalctl', 'true', ...flag], { encoding: 'utf8', env })
    assert.equal(done.status, 2, flag.join(' '))
    assert.equal(done.stdout, '', 'nothing is printed')
    assert.match(done.stderr, /test seams/)
  }
})

test('o3d-3634b: the journal proof reads the SYSTEM journal only, honours /run and /usr/lib journald drop-ins, and refuses a journal whose current boot is not this boot (MUTATION: drop --system / a drop-in root / the boot check => red)', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-status-'))
  try {
    const script = join(process.cwd(), 'scripts/bridge/bridge_writers_status.py')
    const systemctl = join(dir, 'systemctl')
    writeFileSync(systemctl, '#!/bin/sh\nprintf "LoadState=masked\\nActiveState=inactive\\nUnitFileState=masked\\n"\n')
    chmodSync(systemctl, 0o755)
    const bootId = '0123456789abcdef0123456789abcdef'
    const system = `[{"index":0,"boot_id":"${bootId}","first_entry":1764547200000000}]`
    const everything = `[{"index":-5,"boot_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","first_entry":1700000000000000},{"index":0,"boot_id":"${bootId}","first_entry":1764547200000000}]`
    const journalctl = join(dir, 'journalctl')
    // A user's own journal files (no --system) reach back to 2023; the system journal only to December 2025. Every call's arguments are recorded.
    writeFileSync(journalctl, `#!/bin/sh\necho "$*" >> '${join(dir, 'calls')}'\ncase "$*" in\n  *--header*) exit 0;;\n  *--list-boots*) case "$*" in *--system*) printf '%s' '${system}';; *) printf '%s' '${everything}';; esac; exit 0;;\n  *) exit 0;;\nesac\n`)
    chmodSync(journalctl, 0o755)
    const persistentDir = join(dir, 'var-log-journal')
    mkdirSync(persistentDir)
    const conf = join(dir, 'journald.conf')
    writeFileSync(conf, '[Journal]\n')
    const run = (kernelId: string) => execFileSync('python3', ['-I', script, '--systemctl', systemctl, '--journalctl', journalctl, '--assume-groups', 'systemd-journal', '--journald-conf', conf, '--journal-dir', persistentDir, '--kernel-boot-id', kernelBootId(dir, kernelId)], { encoding: 'utf8', env: SEAM_ENV })
    const ok = run('01234567-89ab-cdef-0123-456789abcdef')
    assert.match(ok, /^journal_earliest: 2025-12-01T00:00:00Z$/m, 'the user journal (2023) is not the earliest entry')
    assert.match(ok, /^last_trigger: never$/m)
    const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((line) => line && !line.includes('--header'))
    assert.ok(calls.length >= 4 && calls.every((line) => line.includes('--system')), `every journal read is the system journal: ${calls.join(' | ')}`)
    // The journal's current boot is not this boot (a copied or stale journal): its history is not this host's, so no earliest entry and no `never`.
    const stale = run('ffffffff-ffff-ffff-ffff-ffffffffffff')
    assert.match(stale, /^journal_earliest: none$/m)
    assert.match(stale, /^last_trigger: unknown$/m)
    const parsedStale = parseBridgeStatusOutput(stale)
    assert.ok(parsedStale.ok && !bridgeLastTriggerReadable(parsedStale.report))
    // /run and /usr/lib drop-ins: a Storage=volatile in either (a same-named file in /etc shadows it) makes the journal not persistent.
    const root = (name: string) => { const r = join(dir, name); mkdirSync(join(r, 'journald.conf.d'), { recursive: true }); return r }
    const etc = root('etc'); const runRoot = root('run'); const usr = root('usr')
    const driver = join(dir, 'drive.py')
    writeFileSync(driver, [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("b", ${JSON.stringify(script)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'roots = sys.argv[2:]',
      'print(json.dumps(m.journal_persistent(sys.argv[1], m.journald_conf_files(roots))))',
    ].join('\n'))
    const persistent = () => JSON.parse(execFileSync('python3', ['-I', driver, persistentDir, etc, runRoot, usr], { encoding: 'utf8' }))
    assert.equal(persistent(), 1, 'no drop-in: persistent')
    writeFileSync(join(usr, 'journald.conf.d', '10-vendor.conf'), '[Journal]\nStorage=volatile\n')
    assert.equal(persistent(), 0, '/usr/lib drop-in is read')
    writeFileSync(join(etc, 'journald.conf.d', '10-vendor.conf'), '[Journal]\nStorage=persistent\n')
    assert.equal(persistent(), 1, 'the /etc file of the same name shadows the /usr/lib one')
    writeFileSync(join(runRoot, 'journald.conf.d', '20-run.conf'), '[Journal]\nStorage=none\n')
    assert.equal(persistent(), 0, '/run drop-in is read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o3d-3634b: `never` also needs a coherent current boot in the report: reported, not before the earliest entry, not after the report (MUTATION: drop the boot check => red)', () => {
  const never = (edit: (text: string) => string) => {
    const p = parseBridgeStatusOutput(edit(sampleReport({ lastTrigger: 'never' })))
    assert.ok(p.ok)
    return bridgeLastTriggerReadable(p.report)
  }
  assert.equal(never((t) => t), true)
  assert.equal(never((t) => t.replace(/^boot_id: .*$/m, 'boot_id: unknown')), false)
  assert.equal(never((t) => t.replace(/^boot_started: .*$/m, 'boot_started: unknown')), false)
  assert.equal(never((t) => t.replace(/^boot_started: .*$/m, 'boot_started: 2026-09-01T00:00:00Z')), false, 'the current boot began before the earliest entry')
  assert.equal(never((t) => t.replace(/^boot_started: .*$/m, 'boot_started: 2027-01-01T00:00:00Z')), false, 'the current boot begins after the report')
})
