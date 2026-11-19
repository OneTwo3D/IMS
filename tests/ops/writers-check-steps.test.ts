import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateWritersCheck, type WritersCheckInputs } from '../../lib/ops/writers-check'
import { readStepEvidence, STEP_EVIDENCE_READERS } from '../../lib/ops/writers-check-step-evidence'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map'
import {
  EVIDENCE_CONTESTS,
  STEP_EVIDENCE_KINDS,
  WRITERS_CHECK_EXIT_CODES,
  deriveBridgeContests,
  type StepEvidenceKind,
  type StepEvidenceReading,
} from '../../lib/security/writers-check-constants'

/**
 * PER-STEP PHASES, THE STEP CONSISTENCY RULES, THE NO-WRITER FINDING AND THE STEP EVIDENCE (o3d-zvec.3 PR A).
 * Every arm names the mutation it is built to catch.
 */

const NOW = new Date('2026-12-20T12:00:00Z')
const M_AT = '2026-12-01T00:00:00Z'
const W_AT = '2026-12-08T00:00:00Z'
const X_AT = '2026-12-15T00:00:00Z'
const GRANTS = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test' }
const XERO_GRANT = { XERO_WRITE_ALLOWED_TENANT: 'tenant-1' }
const ENFORCE = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }
const SETTINGS_ON = new Map<string, string>([
  ['xero_sync_enabled', 'true'], ['xero_daily_batch_enabled', 'true'], ['wc_stock_sync_enabled', 'true'], ['wc_fx_push_enabled', 'true'],
  ['trackship_refire_enabled', 'true'], ['mintsoft_parent_sku_delete_enabled', 'true'], ['wc_invoice_document_enabled', 'true'],
  ['wc_invoice_note_enabled', 'true'], ['wc_withdrawal_outcome_enabled', 'true'],
])

function clean(): Record<StepEvidenceKind, StepEvidenceReading> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  for (const kind of STEP_EVIDENCE_KINDS) {
    out[kind] = kind === 'BRIDGE_ATTESTATION' ? { state: 'present', at: '2026-12-02T00:00:00.000Z', violations: [], lastTriggerAt: null, generatedAt: '2026-12-02T00:00:00.000Z', journalEarliestAt: '2000-01-01T00:00:00.000Z' }
      : kind.startsWith('QOBLEX') ? { state: 'present', at: '2026-11-01T00:00:00.000Z' }
      : kind === 'BRIDGE_PROBE' ? { state: 'probed', violations: [] }
      : { state: 'counted', counted: 0, floor: M_AT }
  }
  return out
}

function inputs(env: Record<string, string>, overrides: Partial<WritersCheckInputs> = {}): WritersCheckInputs {
  return {
    env: { ...ENFORCE, ...env }, now: NOW, windowDays: 14, settings: SETTINGS_ON, cronEnabled: { 'wms-order-push': true },
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    evidence: Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: 0, total: 0, unpaid: 0, floor: M_AT }])) as never,
    stepEvidence: clean(), evidenceUnrecorded: 0, unknownEvidenceKinds: 0, ...overrides,
  }
}

const STEP_M = { ...GRANTS, MINTSOFT_WRITES_LIVE_FROM: M_AT }
const STEP_MW = { ...STEP_M, WC_WRITES_LIVE_FROM: W_AT }
const STEP_MWX = { ...STEP_MW, ...XERO_GRANT, XERO_WRITES_LIVE_FROM: X_AT }

test('phase is derived per step: P1 with nothing set, then the latest live step; a step in the future is not live', () => {
  assert.equal(evaluateWritersCheck(inputs({})).phase, 'P1')
  assert.equal(evaluateWritersCheck(inputs(STEP_M)).phase, 'P2-M')
  assert.equal(evaluateWritersCheck(inputs(STEP_MW)).phase, 'P2-W')
  assert.equal(evaluateWritersCheck(inputs(STEP_MWX)).phase, 'P2-X')
  const future = evaluateWritersCheck(inputs({ ...STEP_M, WC_WRITES_LIVE_FROM: '2027-01-01T00:00:00Z' }))
  assert.equal(future.phase, 'P2-M')
  assert.deepEqual(future.steps.map((s) => s.state), ['live', 'scheduled', 'unset'])
})

test('P1 is unchanged: no step evidence is required, so an unbuilt source and an empty evidence reading add no finding', () => {
  const unbuilt = Object.fromEntries(STEP_EVIDENCE_KINDS.map((k) => [k, { state: 'not-built' }])) as Record<StepEvidenceKind, StepEvidenceReading>
  const p1 = evaluateWritersCheck(inputs({}, { stepEvidence: unbuilt }))
  assert.equal(p1.verdict, 'ok')
  assert.equal(p1.exitCode, 0)
  assert.equal(evaluateWritersCheck(inputs({}, { stepEvidence: null })).verdict, 'ok')
})

test('wrong order: a later step set while the earlier one is not, or earlier than it, fails (MUTATION: drop the order rule => red)', () => {
  const onlyX = evaluateWritersCheck(inputs({ ...GRANTS, ...XERO_GRANT, XERO_WRITES_LIVE_FROM: X_AT }))
  assert.ok(onlyX.findings.some((f) => f.code === 'step-order' && f.subject === 'XERO_WRITES_LIVE_FROM'), JSON.stringify(onlyX.findings))
  const wButNotM = evaluateWritersCheck(inputs({ ...GRANTS, WC_WRITES_LIVE_FROM: W_AT }))
  assert.ok(wButNotM.findings.some((f) => f.code === 'step-order' && f.subject === 'WC_WRITES_LIVE_FROM'))
  const earlier = evaluateWritersCheck(inputs({ ...STEP_M, WC_WRITES_LIVE_FROM: '2026-11-01T00:00:00Z' }))
  assert.ok(earlier.findings.some((f) => f.code === 'step-order' && /earlier than/.test(f.message)))
  assert.equal(wButNotM.verdict, 'unreadable', 'the verdict is a step gap or worse, never ok')
  assert.ok(!evaluateWritersCheck(inputs(STEP_MWX)).findings.some((f) => f.code === 'step-order'))
})

test('a missing grant: a step set while the grant of a destination its rows write is not (MUTATION: drop the grant rule => red)', () => {
  const noWcGrant = evaluateWritersCheck(inputs({ MINTSOFT_WRITE_ALLOWED: GRANTS.MINTSOFT_WRITE_ALLOWED, MINTSOFT_WRITES_LIVE_FROM: M_AT }))
  assert.ok(noWcGrant.findings.some((f) => f.code === 'step-missing-grant' && f.subject === 'woocommerce'), 'step M writes WooCommerce too (the bridge sweep did)')
  const noMintsoftGrant = evaluateWritersCheck(inputs({ WC_WRITEBACK_ALLOWED_ORIGIN: GRANTS.WC_WRITEBACK_ALLOWED_ORIGIN, MINTSOFT_WRITES_LIVE_FROM: M_AT }))
  assert.ok(noMintsoftGrant.findings.some((f) => f.code === 'step-missing-grant' && f.subject === 'mintsoft'))
  assert.ok(!evaluateWritersCheck(inputs(STEP_M)).findings.some((f) => f.code === 'step-missing-grant'))
})

test('step M with the WooCommerce grant but no WooCommerce live-from is CONSISTENT (the WooCommerce grant belongs to step M)', () => {
  const report = evaluateWritersCheck(inputs(STEP_M))
  assert.ok(!report.findings.some((f) => f.code === 'inconsistent-configuration'), JSON.stringify(report.findings))
  assert.equal(report.destinations.find((d) => d.connector === 'woocommerce')?.phase, 'P2')
})

test('no-writer: IMS owns an automatic row in a live phase but its switch is off => fail; the same row in P1 => nothing (MUTATION: drop the finding => red)', () => {
  const off = new Map(SETTINGS_ON); off.set('trackship_refire_enabled', 'false')
  const report = evaluateWritersCheck(inputs(STEP_M, { settings: off }))
  assert.ok(report.findings.some((f) => f.code === 'no-writer' && f.severity === 'fail' && f.subject === 'woocommerce.order.trackship-refire'), JSON.stringify(report.findings))
  assert.ok(report.findings.some((f) => f.code === 'no-writer' && f.subject === 'woocommerce.order.trackship-reconcile'), 'the reconcile is driven by the same switch')
  assert.equal(report.verdict, 'step-gap')
  assert.equal(report.exitCode, WRITERS_CHECK_EXIT_CODES.find((r) => r.name === 'step-gap')!.code)
  const p1 = evaluateWritersCheck(inputs({}, { settings: off }))
  assert.ok(!p1.findings.some((f) => f.code === 'no-writer'))
  // A row whose step is not live is not a gap: step W/X rows are owned by their incumbent until their step.
  assert.ok(!report.findings.some((f) => f.code === 'no-writer' && f.subject === 'woocommerce.stock'))
  // An operator-triggered row with its switch off is a warning, not a failure.
  const noDelete = new Map(SETTINGS_ON); noDelete.set('xero_document_delete_enabled', 'false')
  const x = evaluateWritersCheck(inputs(STEP_MWX, { settings: noDelete }))
  const billDelete = x.findings.find((f) => f.code === 'no-writer' && f.subject === 'xero.purchase.bill-delete')
  assert.equal(billDelete?.severity, 'warn')
})

test('no-writer: from step M the withdrawal-outcome writer must be switched on (wc_withdrawal_outcome_enabled, default off), like every other IMS-owned row', () => {
  const off = new Map(SETTINGS_ON)
  off.delete('wc_withdrawal_outcome_enabled')
  const report = evaluateWritersCheck(inputs(STEP_M, { settings: off }))
  const finding = report.findings.find((f) => f.code === 'no-writer' && f.subject === 'woocommerce.order.withdrawal-outcome')
  assert.ok(finding, JSON.stringify(report.findings))
  assert.match(finding!.message, /switch is off/)
  assert.notEqual(report.exitCode, 0)
  assert.ok(!evaluateWritersCheck(inputs(STEP_M)).findings.some((f) => f.subject === 'woocommerce.order.withdrawal-outcome'), 'switched on: no finding')
})

test('the invoice note has its OWN switch: xero_sync_sales_invoice (which defaults on) no longer makes it writable', () => {
  const noteOff = new Map(SETTINGS_ON)
  noteOff.delete('wc_invoice_note_enabled')
  const report = evaluateWritersCheck(inputs(STEP_MWX, { settings: noteOff }))
  assert.equal(report.operations.find((op) => op.key === 'woocommerce.order.invoice-note')?.imsCanWrite, false)
  assert.ok(report.findings.some((f) => f.code === 'no-writer' && f.subject === 'woocommerce.order.invoice-note'))
  const onWithoutXeroMode = new Map(SETTINGS_ON)
  onWithoutXeroMode.set('xero_sync_sales_invoice', 'off')
  assert.equal(evaluateWritersCheck(inputs(STEP_MWX, { settings: onWithoutXeroMode })).operations.find((op) => op.key === 'woocommerce.order.invoice-note')?.imsCanWrite, true, 'the Xero document mode is not the note\'s switch')
})

test('"evidence source not built" FAILS closed in every phase that requires it; it never passes vacuously', () => {
  const unbuilt = { ...clean(), BRIDGE_PROBE: { state: 'not-built' } as const, MINTSOFT_FOREIGN_ORDER: { state: 'not-built' } as const }
  const m = evaluateWritersCheck(inputs(STEP_M, { stepEvidence: unbuilt }))
  const notBuilt = m.findings.filter((f) => f.code === 'evidence-source-not-built')
  assert.deepEqual(notBuilt.map((f) => f.subject).sort(), ['BRIDGE_PROBE', 'MINTSOFT_FOREIGN_ORDER'])
  assert.match(notBuilt[0]!.message, /Evidence source not built/)
  assert.equal(m.verdict, 'unreadable')
  // The same reading in a phase that does not require the kind does not fail: stock drift is required from step W only.
  const drift = evaluateWritersCheck(inputs(STEP_M, { stepEvidence: { ...clean(), STOCK_DRIFT: { state: 'not-built' } } }))
  assert.ok(!drift.findings.some((f) => f.subject === 'STOCK_DRIFT'))
  const w = evaluateWritersCheck(inputs(STEP_MW, { stepEvidence: { ...clean(), STOCK_DRIFT: { state: 'not-built' } } }))
  assert.ok(w.findings.some((f) => f.code === 'evidence-source-not-built' && f.subject === 'STOCK_DRIFT'))
  // A reading that was not returned at all is unreadable when required.
  const missing = clean() as Partial<Record<StepEvidenceKind, StepEvidenceReading>>
  delete missing.XEROOM_NOTE
  assert.ok(evaluateWritersCheck(inputs(STEP_MWX, { stepEvidence: missing })).findings.some((f) => f.code === 'unreadable' && f.subject === 'XEROOM_NOTE'))
  assert.ok(evaluateWritersCheck(inputs(STEP_MWX, { stepEvidence: null })).findings.filter((f) => f.code === 'unreadable').length >= STEP_EVIDENCE_KINDS.length)
})

test('"not-probed" is a fail in EVERY phase, P1 included (MUTATION: treat it as clean => red)', () => {
  for (const env of [{}, STEP_M, STEP_MWX]) {
    const report = evaluateWritersCheck(inputs(env, { stepEvidence: { ...clean(), BRIDGE_PROBE: { state: 'not-probed' } } }))
    assert.ok(report.findings.some((f) => f.code === 'evidence-not-probed' && f.severity === 'fail' && f.subject === 'BRIDGE_PROBE'), JSON.stringify(env))
    assert.equal(report.verdict, 'unreadable')
  }
})

test('attestations: absent fails; present but recorded after the step went live fails; present before passes (the Qoblex confirmations)', () => {
  const absent = evaluateWritersCheck(inputs(STEP_MW, { stepEvidence: { ...clean(), QOBLEX_STOCK_PUSH_STOPPED: { state: 'absent' } } }))
  assert.ok(absent.findings.some((f) => f.code === 'attestation-missing' && f.subject === 'QOBLEX_STOCK_PUSH_STOPPED'))
  assert.equal(absent.verdict, 'step-gap')
  const late = evaluateWritersCheck(inputs(STEP_MW, { stepEvidence: { ...clean(), QOBLEX_STOCK_PUSH_STOPPED: { state: 'present', at: '2026-12-09T00:00:00.000Z' } } }))
  assert.ok(late.findings.some((f) => f.code === 'attestation-missing' && /after WC_WRITES_LIVE_FROM/.test(f.message)))
  const ok = evaluateWritersCheck(inputs(STEP_MW))
  assert.ok(!ok.findings.some((f) => f.subject === 'QOBLEX_STOCK_PUSH_STOPPED'))
  // Not required before its step: step M alone does not need the stock confirmation.
  assert.ok(!evaluateWritersCheck(inputs(STEP_M, { stepEvidence: { ...clean(), QOBLEX_STOCK_PUSH_STOPPED: { state: 'absent' } } })).findings.some((f) => f.subject === 'QOBLEX_STOCK_PUSH_STOPPED'))
  const xero = evaluateWritersCheck(inputs(STEP_MWX, { stepEvidence: { ...clean(), QOBLEX_XERO_STOPPED: { state: 'absent' } } }))
  assert.ok(xero.findings.some((f) => f.code === 'attestation-missing' && f.subject === 'QOBLEX_XERO_STOPPED'))
  assert.equal(xero.verdict, 'step-gap', 'P2-X without the Qoblex confirmation fails')
  // The producer decision holds the step-X writes too: IMS cannot write them, so the confirmation is enforced in both places.
  assert.equal(xero.operations.find((op) => op.key === 'xero.purchase.bill')?.imsCanWrite, false)
  assert.equal(evaluateWritersCheck(inputs(STEP_MWX)).operations.find((op) => op.key === 'xero.purchase.bill')?.imsCanWrite, true)
})

test('counted evidence and probe violations are double claims: a foreign Mintsoft order, a drift, a Xeroom note, a probe that reports the bridge still active', () => {
  for (const [env, kind, reading] of [
    [STEP_M, 'MINTSOFT_FOREIGN_ORDER', { state: 'counted', counted: 1, floor: M_AT }],
    [STEP_MW, 'STOCK_DRIFT', { state: 'counted', counted: 3, floor: W_AT }],
    [STEP_MWX, 'XEROOM_NOTE', { state: 'counted', counted: 1, floor: X_AT }],
    [STEP_M, 'BRIDGE_PROBE', { state: 'probed', violations: ['routes-registered'] }],
  ] as const) {
    const report = evaluateWritersCheck(inputs(env, { stepEvidence: { ...clean(), [kind]: reading } }))
    assert.ok(report.findings.some((f) => f.code === 'step-evidence-violation' && f.subject === kind), kind)
    assert.equal(report.verdict, 'double-claim', kind)
    assert.equal(report.exitCode, 1)
  }
})

test('contests are derived from the map: every row the bridge owns in P1 and IMS in P2; the marker contests nothing', () => {
  const derived = deriveBridgeContests()
  const expected = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).filter((r) => r.owners.P1 === 'woo-mintsoft-plugin' && r.owners.P2 === 'IMS').map((r) => `${r.destination}.${r.operation}`)
  assert.deepEqual(derived, expected)
  for (const key of ['mintsoft.order.create', 'woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.partial-shipment', 'woocommerce.order.withdrawal-outcome', 'woocommerce.product.meta']) assert.ok(derived.includes(key), key)
  assert.deepEqual([...EVIDENCE_CONTESTS.MINTSOFT_ORDER_ID], derived)
  assert.deepEqual([...EVIDENCE_CONTESTS.XEROOM_MARKER], [])
  // A new bridge-owned row in a mutated map is contested without touching the check.
  const extra: OwnershipRow = { destination: 'mintsoft', operation: 'order.merge', owners: { P0: 'nobody', P1: 'woo-mintsoft-plugin', P2: 'IMS' }, step: 'mintsoft', obligationTime: 'not-applicable', note: 'fixture' }
  assert.ok(deriveBridgeContests([...(WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]), extra]).includes('mintsoft.order.merge'))
})

test('bridge evidence on a WooCommerce fulfilment row is a double claim once IMS can write it (the bridge sweep also wrote WooCommerce)', () => {
  const evidence = Object.fromEntries(['MINTSOFT_ORDER_ID', 'MINTSOFT_OTHER_META', 'XEROOM_MARKER', 'XERO_FOREIGN_NUMBER'].map((k) => [k, { counted: k === 'MINTSOFT_ORDER_ID' ? 2 : 0, total: 2, unpaid: 0, floor: M_AT }])) as never
  const report = evaluateWritersCheck(inputs(STEP_M, { evidence }))
  const subjects = report.findings.filter((f) => f.code === 'incumbent-evidence-vs-ims-writer').map((f) => f.subject)
  assert.ok(subjects.includes('woocommerce.order.status') && subjects.includes('mintsoft.order.create'), subjects.join(','))
})

test('the readers: the bridge attestation is built (a writers:attest input; absent until one is recorded); every step source is NOT DUE until its step is live; the attestation kinds read the newest attestation; a throwing reader is unreadable', async () => {
  const rows: Record<string, Date | null> = { 'qoblex-stock-push-stopped': new Date('2026-12-02T00:00:00Z'), 'qoblex-xero-stopped': null }
  const db = { writerAttestation: { findFirst: async (args: { where: { kind: string } }) => { const at = rows[args.where.kind]; return at ? { attestedAt: at } : null } } }
  const read = await readStepEvidence({ db: db as never, now: NOW, env: {} })
  assert.deepEqual(read.QOBLEX_STOCK_PUSH_STOPPED, { state: 'present', at: '2026-12-02T00:00:00.000Z' })
  assert.deepEqual(read.QOBLEX_XERO_STOPPED, { state: 'absent' })
  assert.deepEqual(read.BRIDGE_ATTESTATION, { state: 'absent' }, 'built: no bridge report recorded reads absent, not not-built')
  for (const kind of ['BRIDGE_PROBE', 'MINTSOFT_FOREIGN_ORDER', 'STOCK_DRIFT', 'XEROOM_NOTE'] as const) assert.deepEqual(read[kind], { state: 'not-due' }, `${kind}: no step is live, so nothing is asked of the store or Mintsoft`)
  const broken = await readStepEvidence({ db: { writerAttestation: { findFirst: async () => { throw new Error('no table') } } } as never, now: NOW, env: {} })
  assert.deepEqual(broken.QOBLEX_XERO_STOPPED, { state: 'unreadable' })
  assert.equal(Object.keys(STEP_EVIDENCE_READERS).length, STEP_EVIDENCE_KINDS.length)
})

test('P1 NEVER asks a vendor: with no live-from set the probe and the Mintsoft reader are not called at all (so a store without the 1.5.0 plugin cannot fail the daily P1 check)', async () => {
  let calls = 0
  const db = { writerAttestation: { findFirst: async () => null } }
  await readStepEvidence({ db: db as never, now: NOW, env: {}, probe: async () => { calls += 1; return { ok: false, reason: 'http_status', message: '' } }, foreignOrders: async () => { calls += 1; return { foreign: 0 } } })
  assert.equal(calls, 0)
})

test('a live-from still in the FUTURE is not-due: nothing is asked of the store or Mintsoft until it is reached (the evaluator counts a step live only then)', async () => {
  let calls = 0
  const db = { writerAttestation: { findFirst: async () => null } }
  const future = new Date(NOW.getTime() + 3_600_000).toISOString()
  const read = await readStepEvidence({ db: db as never, now: NOW, env: { MINTSOFT_WRITES_LIVE_FROM: future }, probe: async () => { calls += 1; return { ok: false, reason: 'http_status', message: '' } }, foreignOrders: async () => { calls += 1; return { foreign: 0 } } })
  assert.equal(calls, 0)
  assert.deepEqual([read.BRIDGE_PROBE, read.MINTSOFT_FOREIGN_ORDER], [{ state: 'not-due' }, { state: 'not-due' }])
})

test('step M live: the probe and the foreign-order reader are asked once each; the probe\'s violations and the foreign count become the readings; an unanswered probe is not-probed; a throwing Mintsoft read is unreadable', async () => {
  const db = { writerAttestation: { findFirst: async () => null } }
  const env = { MINTSOFT_WRITES_LIVE_FROM: M_AT }
  const probeOk = async () => ({ ok: true as const, probe: { generatedAt: 1, bridge: { slug: 'wc-mintsoft-sync', pluginActive: false, routesRegistered: true, orderSyncEnabled: false, productWebhook: { total: 1, active: 0 }, pendingProductJobs: 0, latestMintsoftWrite: 0 }, xeroom: { orderNoteOff: false, orderNoteOffPresent: false } } })
  let probes = 0
  const read = await readStepEvidence({ db: db as never, now: NOW, env, probe: async () => { probes += 1; return probeOk() }, foreignOrders: async (since) => { assert.equal(since.toISOString(), '2026-12-01T00:00:00.000Z'); return { foreign: 2 } } })
  assert.deepEqual(read.BRIDGE_PROBE, { state: 'probed', violations: ['bridge-routes-registered'] })
  assert.deepEqual(read.MINTSOFT_FOREIGN_ORDER, { state: 'counted', counted: 2, floor: '2026-12-01T00:00:00.000Z' })
  assert.deepEqual(read.XEROOM_NOTE, { state: 'not-due' }, 'step X is not live')
  assert.equal(probes, 1)
  const down = await readStepEvidence({ db: db as never, now: NOW, env, probe: async () => ({ ok: false, reason: 'http_status', message: 'x' }), foreignOrders: async () => { throw new Error('mintsoft down') } })
  assert.deepEqual(down.BRIDGE_PROBE, { state: 'not-probed' })
  assert.deepEqual(down.MINTSOFT_FOREIGN_ORDER, { state: 'unreadable' })
  const thrown = await readStepEvidence({ db: db as never, now: NOW, env, probe: async () => { throw new Error('boom') }, foreignOrders: async () => ({ foreign: 0 }) })
  assert.deepEqual(thrown.BRIDGE_PROBE, { state: 'not-probed' }, 'a probe that throws is not-probed, never a pass')
  assert.deepEqual((await readStepEvidence({ db: db as never, now: NOW, env: { MINTSOFT_WRITES_LIVE_FROM: 'garbage' } })).BRIDGE_PROBE, { state: 'unreadable' })
})

test('step X live: Xeroom\'s note reading comes from the probe\'s option (on = violation, off = clean), the same single probe', async () => {
  const db = { writerAttestation: { findFirst: async () => null } }
  const env = { MINTSOFT_WRITES_LIVE_FROM: M_AT, WC_WRITES_LIVE_FROM: W_AT, XERO_WRITES_LIVE_FROM: X_AT }
  const answer = (off: boolean) => async () => ({ ok: true as const, probe: { generatedAt: 1, bridge: { slug: 'wc-mintsoft-sync', pluginActive: false, routesRegistered: false, orderSyncEnabled: false, productWebhook: { total: 0, active: 0 }, pendingProductJobs: 0, latestMintsoftWrite: 0 }, xeroom: { orderNoteOff: off, orderNoteOffPresent: true } } })
  assert.deepEqual((await readStepEvidence({ db: db as never, now: NOW, env, probe: answer(false), foreignOrders: async () => ({ foreign: 0 }) })).XEROOM_NOTE, { state: 'probed', violations: ['xeroom-note-on'] })
  assert.deepEqual((await readStepEvidence({ db: db as never, now: NOW, env, probe: answer(true), foreignOrders: async () => ({ foreign: 0 }) })).XEROOM_NOTE, { state: 'probed', violations: [] })
})

test('step W live: the drift reader needs the owner\'s confirmation, 24 hours of complete runs after it, a recent run, and then counts the events since the confirmation', async () => {
  const attestedAt = new Date('2026-12-08T00:00:00Z')
  const runs = { first: new Date('2026-12-08T01:00:00Z'), last: new Date('2026-12-20T08:00:00Z') }
  let events = 0
  const mk = (over: { attested?: Date | null; first?: Date | null; last?: Date | null } = {}) => ({
    writerAttestation: { findFirst: async () => ((over.attested === undefined ? attestedAt : over.attested) ? { attestedAt: over.attested === undefined ? attestedAt : over.attested } : null) },
    wcStockDriftRun: { findFirst: async (args: { orderBy: { startedAt: string } }) => { const at = args.orderBy.startedAt === 'asc' ? (over.first === undefined ? runs.first : over.first) : (over.last === undefined ? runs.last : over.last); return at ? { startedAt: at } : null } },
    wcStockDriftEvent: { count: async (args: { where: { observedAt: { gte: Date } } }) => { assert.equal(args.where.observedAt.gte.toISOString(), attestedAt.toISOString()); return events } },
  })
  const drift = async (db: ReturnType<typeof mk>) => (await readStepEvidence({ db: db as never, now: NOW, env: { MINTSOFT_WRITES_LIVE_FROM: M_AT, WC_WRITES_LIVE_FROM: W_AT }, probe: async () => ({ ok: false, reason: 'unreachable', message: '' }), foreignOrders: async () => ({ foreign: 0 }) })).STOCK_DRIFT
  assert.deepEqual(await drift(mk()), { state: 'counted', counted: 0, floor: attestedAt.toISOString() })
  events = 3
  assert.deepEqual(await drift(mk()), { state: 'counted', counted: 3, floor: attestedAt.toISOString() })
  assert.deepEqual(await drift(mk({ attested: null })), { state: 'not-probed' }, 'nothing to measure the quiet from')
  assert.deepEqual(await drift(mk({ first: null })), { state: 'not-probed' }, 'the observer has not run since the confirmation')
  assert.deepEqual(await drift(mk({ last: new Date('2026-12-20T05:00:00Z') })), { state: 'not-probed' }, 'the latest complete run is over 6 hours old')
  assert.deepEqual(await drift(mk({ last: new Date('2026-12-08T20:00:00Z'), first: new Date('2026-12-08T01:00:00Z') })), { state: 'not-probed' }, 'less than 24 hours of watching')
  assert.deepEqual((await readStepEvidence({ db: { writerAttestation: { findFirst: async () => ({ attestedAt }) } } as never, now: NOW, env: { MINTSOFT_WRITES_LIVE_FROM: M_AT, WC_WRITES_LIVE_FROM: W_AT }, probe: async () => ({ ok: false, reason: 'unreachable', message: '' }), foreignOrders: async () => ({ foreign: 0 }) })).STOCK_DRIFT, { state: 'unreadable' }, 'no observer tables at all')
})

test('a "not-due" reading where the evaluator REQUIRES the kind fails closed (the reader and the check disagree about the step)', () => {
  const report = evaluateWritersCheck(inputs(STEP_M, { stepEvidence: { ...clean(), BRIDGE_PROBE: { state: 'not-due' } } }))
  assert.ok(report.findings.some((f) => f.code === 'unreadable' && f.subject === 'BRIDGE_PROBE'))
  assert.notEqual(report.exitCode, 0)
  assert.ok(!evaluateWritersCheck(inputs({}, { stepEvidence: { ...clean(), BRIDGE_PROBE: { state: 'not-due' } } })).findings.some((f) => f.subject === 'BRIDGE_PROBE'), 'in P1 it is simply not required')
})

test('P2-W FAILS without the qoblex-stock-push-stopped confirmation EVEN WHEN wc_stock_sync_enabled is already on, and IMS is not counted as able to write stock (MUTATION: drop the requirement or the per-operation delivery check => red)', () => {
  assert.equal(SETTINGS_ON.get('wc_stock_sync_enabled'), 'true', 'precondition: the stock switch is already on (turned on in P1, where stock is shadowed)')
  const absent = evaluateWritersCheck(inputs(STEP_MW, { stepEvidence: { ...clean(), QOBLEX_STOCK_PUSH_STOPPED: { state: 'absent' } } }))
  assert.equal(absent.phase, 'P2-W')
  assert.ok(absent.findings.some((f) => f.code === 'attestation-missing' && f.subject === 'QOBLEX_STOCK_PUSH_STOPPED' && f.severity === 'fail'), JSON.stringify(absent.findings))
  assert.equal(absent.verdict, 'step-gap')
  assert.notEqual(absent.exitCode, 0)
  assert.equal(absent.operations.find((op) => op.key === 'woocommerce.stock')?.imsCanWrite, false, 'the producer holds the stock push without the confirmation')
  const present = evaluateWritersCheck(inputs(STEP_MW))
  assert.equal(present.operations.find((op) => op.key === 'woocommerce.stock')?.imsCanWrite, true)
  assert.ok(!present.findings.some((f) => f.subject === 'QOBLEX_STOCK_PUSH_STOPPED'))
})

test('the legacy single-variable configuration is flagged: WC_WRITES_LIVE_FROM without MINTSOFT_WRITES_LIVE_FROM fails; MINTSOFT_WRITES_LIVE_FROM with the WooCommerce grant but no WC_WRITES_LIVE_FROM warns', () => {
  // (a) the old stage/e2e shape: the WooCommerce variable alone.
  const wcOnly = evaluateWritersCheck(inputs({ ...GRANTS, WC_WRITES_LIVE_FROM: W_AT }))
  const legacyA = wcOnly.findings.find((f) => f.code === 'legacy-live-from')
  assert.ok(legacyA, JSON.stringify(wcOnly.findings))
  assert.equal(legacyA.severity, 'fail')
  assert.match(legacyA.message, /MINTSOFT_WRITES_LIVE_FROM/)
  assert.match(legacyA.message, /docs\/installation\.md/)
  assert.notEqual(wcOnly.exitCode, 0)
  // (b) the Mintsoft variable with the WooCommerce grant: formerly held, now step M writes WooCommerce. A warning only: it is also the intended step-M configuration.
  const mintsoftWithGrant = evaluateWritersCheck(inputs(STEP_M))
  const legacyB = mintsoftWithGrant.findings.find((f) => f.code === 'legacy-live-from')
  assert.ok(legacyB)
  assert.equal(legacyB.severity, 'warn')
  assert.ok(!mintsoftWithGrant.findings.some((f) => f.severity === 'fail' && f.code === 'legacy-live-from'), 'a warning is not a failure of its own')
  // The designed configurations raise nothing.
  assert.ok(!evaluateWritersCheck(inputs({})).findings.some((f) => f.code === 'legacy-live-from'), 'P1')
  assert.ok(!evaluateWritersCheck(inputs(STEP_MW)).findings.some((f) => f.code === 'legacy-live-from'), 'steps M and W')
  assert.ok(!evaluateWritersCheck(inputs(STEP_MWX)).findings.some((f) => f.code === 'legacy-live-from'), 'steps M, W and X')
})

test('the startup finding is the same pure function: a legacy environment names itself, a designed one is silent', async () => {
  const { legacyLiveFromFindings } = await import('../../lib/security/live-from-legacy-config')
  assert.deepEqual(legacyLiveFromFindings({}), [])
  assert.deepEqual(legacyLiveFromFindings({ WC_WRITES_LIVE_FROM: W_AT, MINTSOFT_WRITES_LIVE_FROM: M_AT }), [])
  assert.deepEqual(legacyLiveFromFindings({ WC_WRITES_LIVE_FROM: '' }), [], 'empty is unset')
  assert.deepEqual(legacyLiveFromFindings({ WC_WRITES_LIVE_FROM: W_AT }).map((f) => f.code), ['legacy-wc-only-live-from'])
  assert.deepEqual(legacyLiveFromFindings({ MINTSOFT_WRITES_LIVE_FROM: M_AT, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test' }).map((f) => f.code), ['legacy-mintsoft-live-from-with-wc-grant'])
  assert.deepEqual(legacyLiveFromFindings({ MINTSOFT_WRITES_LIVE_FROM: M_AT }), [], 'no WooCommerce grant: nothing changes for WooCommerce')
})
