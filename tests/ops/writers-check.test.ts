import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IMS_WRITER_SWITCHES,
  WRITERS_WITHOUT_IMS_SWITCH,
  evaluateWritersCheck,
  evidenceFloors,
  renderWritersCheckText,
  writersCheckCronSlugs,
  writersCheckSettingKeys,
  type EvidenceReading,
  type WritersCheckInputs,
} from '../../lib/ops/writers-check'
import { WRITER_OWNERSHIP_MAP, type OwnershipRow } from '../../lib/security/writer-ownership-map'
import {
  STEP_EVIDENCE_KINDS,
  type StepEvidenceKind,
  type StepEvidenceReading,
  IMS_FORBIDDEN_OWNERSHIP_ROWS,
  WRITERS_CHECK_CANNOT_SEE,
  WRITERS_CHECK_EXIT_CODES,
  WRITERS_CHECK_EVIDENCE_KEYS_FOR_TESTS,
} from '../../lib/security/writers-check-constants'

/**
 * THE COEXISTENCE INTERLOCK, PURE ARMS. Every arm states the mutation it is built to catch.
 */

const NOW = new Date('2026-10-20T12:00:00Z')
const CUTOFF = '2026-10-10T00:00:00Z'

const ALL_ON = new Map<string, string>([['xero_sync_enabled', 'true'], ['xero_daily_batch_enabled', 'true'], ['wc_stock_sync_enabled', 'true'], ['wc_fx_push_enabled', 'true'], ['trackship_refire_enabled', 'true'], ['mintsoft_parent_sku_delete_enabled', 'true'], ['wc_invoice_document_enabled', 'true'], ['wc_invoice_note_enabled', 'true'], ['wc_withdrawal_outcome_enabled', 'true']])

/** Every step evidence source answering clean: attestations present long before any live-from instant, probes clean, no offending rows. */
export function cleanStepEvidence(): Record<StepEvidenceKind, StepEvidenceReading> {
  const out = {} as Record<StepEvidenceKind, StepEvidenceReading>
  for (const kind of STEP_EVIDENCE_KINDS) {
    out[kind] = kind === 'BRIDGE_ATTESTATION' ? { state: 'present', at: '2026-01-01T00:00:00.000Z', violations: [], lastTriggerAt: null }
      : kind.startsWith('QOBLEX') ? { state: 'present', at: '2026-01-01T00:00:00.000Z' }
      : kind === 'BRIDGE_PROBE' ? { state: 'probed', violations: [] }
      : { state: 'counted', counted: 0, floor: '2026-01-01T00:00:00.000Z' }
  }
  return out
}

/** The failing findings that are not the no-writer gap the unbuilt withdrawal-outcome writer causes in every live phase. */
function realFailures(report: ReturnType<typeof evaluateWritersCheck>) {
  return report.findings.filter((f) => f.severity === 'fail' && !(f.code === 'no-writer' && f.subject === 'woocommerce.order.withdrawal-outcome'))
}

function reading(counted: number, total = counted): EvidenceReading {
  return { counted, total, unpaid: 0, floor: '2026-10-10T00:00:00.000Z' }
}

function cleanEvidence(): NonNullable<WritersCheckInputs['evidence']> {
  return Object.fromEntries(WRITERS_CHECK_EVIDENCE_KEYS_FOR_TESTS.map((key) => [key, reading(0)])) as NonNullable<WritersCheckInputs['evidence']>
}

function inputs(overrides: Partial<WritersCheckInputs> = {}): WritersCheckInputs {
  return {
    env: {},
    now: NOW,
    windowDays: 14,
    settings: ALL_ON,
    cronEnabled: { 'wms-order-push': true },
    pluginEnabled: { woocommerce: true, mintsoft: true, xero: true },
    evidence: cleanEvidence(),
    stepEvidence: cleanStepEvidence(),
    evidenceUnrecorded: 0,
    unknownEvidenceKinds: 0,
    ...overrides,
  }
}

const MINTSOFT_LIVE_ENV = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', MINTSOFT_WRITES_LIVE_FROM: CUTOFF, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'all' }

test('precondition: the harness reaches the grant, the switches and the evidence (a held installation is ok, and IMS can write nothing)', () => {
  const report = evaluateWritersCheck(inputs())
  console.log(`# held installation: operations=${report.operations.length} imsCanWrite=${report.operations.filter((op) => op.imsCanWrite).length} verdict=${report.verdict}`)
  assert.equal(report.verdict, 'ok')
  assert.equal(report.exitCode, 0)
  assert.ok(report.operations.length >= 25)
  assert.equal(report.operations.filter((op) => op.imsCanWrite).length, 0)
  assert.ok(report.operations.every((op) => op.imsSwitchedOn || ['xero', 'mintsoft', 'woocommerce'].includes(op.key.split('.')[0]!)))
})

test('ARM (a): IMS live for mintsoft.order.create while orders paid after the cut-off carry the bridge id is a double claim', () => {
  const env = MINTSOFT_LIVE_ENV
  const clean = evaluateWritersCheck(inputs({ env }))
  console.log(`# live, no evidence: imsCanWrite create=${clean.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite} verdict=${clean.verdict}`)
  assert.equal(clean.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, true, 'precondition: IMS can create orders')
  assert.deepEqual(realFailures(clean), [], 'precondition: with no evidence the same installation is clean, so the evidence is what fails it')

  const evidence = { ...cleanEvidence(), MINTSOFT_ORDER_ID: reading(3, 9) }
  const dirty = evaluateWritersCheck(inputs({ env, evidence }))
  // MUTATION: evaluate the IMS writers only (skip the evidence) => verdict ok => this assertion is red.
  assert.equal(dirty.verdict, 'double-claim')
  assert.equal(dirty.exitCode, 1)
  const finding = dirty.findings.find((f) => f.code === 'incumbent-evidence-vs-ims-writer')
  assert.ok(finding, 'the evidence finding is present')
  assert.equal(finding!.subject, 'mintsoft.order.create')
  assert.match(finding!.message, /^3 MINTSOFT_ORDER_ID marks/)
})


const ALL_STEPS_LIVE_ENV = { ...MINTSOFT_LIVE_ENV, WC_WRITES_LIVE_FROM: CUTOFF, XERO_WRITE_ALLOWED_TENANT: 'tenant-1', XERO_WRITES_LIVE_FROM: CUTOFF }

test('ARM (a5): with step X live, Xeroom\'s permanent marker contests nothing, but a Xeroom-written invoice note after the step is a double claim (the invoicing plugin is still writing it)', () => {
  const env = ALL_STEPS_LIVE_ENV
  const clean = evaluateWritersCheck(inputs({ env }))
  const note = clean.operations.find((op) => op.key === 'woocommerce.order.invoice-note')
  assert.equal(note?.imsCanWrite, true, 'precondition: IMS can write the invoice note')
  assert.equal(clean.phase, 'P2-X')
  assert.deepEqual(realFailures(clean), [], 'precondition: with no evidence the same installation is clean')

  // Xeroom marks every order it invoices, for good: the marker alone is not a claim (derived contests: none).
  const marked = evaluateWritersCheck(inputs({ env, evidence: { ...cleanEvidence(), XEROOM_MARKER: reading(4, 9) } }))
  assert.ok(!marked.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer'))

  // MUTATION: ignore the XEROOM_NOTE reading => verdict stays clean => red.
  const dirty = evaluateWritersCheck(inputs({ env, stepEvidence: { ...cleanStepEvidence(), XEROOM_NOTE: { state: 'counted', counted: 2, floor: CUTOFF } } }))
  assert.equal(dirty.verdict, 'double-claim')
  assert.equal(dirty.exitCode, 1)
  assert.ok(dirty.findings.some((f) => f.code === 'step-evidence-violation' && f.subject === 'XEROOM_NOTE'))
})

test('ARM (a6): the WooCommerce writeback the woo-mintsoft plugin owns (status, tracking, partial shipment) is a double claim the moment IMS can write it; the real map is clean while IMS cannot', () => {
  const real = evaluateWritersCheck(inputs({ env: {} }))
  for (const key of ['woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.partial-shipment']) {
    assert.equal(real.operations.find((op) => op.key === key)?.imsCanWrite, false, `precondition: ${key} is held while no grant is set`)
  }
  assert.equal(real.verdict, 'ok')
  const legacyWrite = { WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test' }
  const claimed = evaluateWritersCheck(inputs({ env: legacyWrite }))
  for (const key of ['woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.partial-shipment']) {
    const owner = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).find((row) => `${row.destination}.${row.operation}` === key)!.owners.P1
    assert.equal(owner, 'woo-mintsoft-plugin', `precondition: the map names the plugin as the P1 owner of ${key}`)
    // MUTATION: skip the owned-elsewhere rule for woocommerce => no finding => red.
    assert.ok(claimed.findings.some((f) => f.code === 'ims-writes-owned-elsewhere' && f.severity === 'fail' && f.subject === key), `${key} must be a double claim`)
  }
  assert.equal(claimed.verdict, 'double-claim')
  assert.equal(claimed.exitCode, 1)
  // Switching the plugin's own switch is not the point: a mutated map that hands the row to IMS removes the claim, proving the finding is about ownership.
  const handed = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).map((row) =>
    ['woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.partial-shipment'].includes(`${row.destination}.${row.operation}`)
      ? { ...row, owners: { ...row.owners, P1: 'IMS' as const } }
      : row)
  const cleared = evaluateWritersCheck(inputs({ env: legacyWrite, map: handed }))
  assert.ok(!cleared.findings.some((f) => f.code === 'ims-writes-owned-elsewhere' && ['woocommerce.order.status', 'woocommerce.order.tracking', 'woocommerce.order.partial-shipment'].includes(f.subject ?? '')))
})

test('ARM (a2): evidence that predates the cut-off or is not current does not fail (no false finding for pre-cutoff orders)', () => {
  const evidence = { ...cleanEvidence(), MINTSOFT_ORDER_ID: { counted: 0, total: 40, unpaid: 2, floor: '2026-10-10T00:00:00.000Z' } }
  const report = evaluateWritersCheck(inputs({ env: MINTSOFT_LIVE_ENV, evidence }))
  assert.deepEqual(realFailures(report), [])
  // The floor the reader counts from is the LATER of the cut-off and the window start.
  const floors = evidenceFloors(MINTSOFT_LIVE_ENV, NOW, 14)
  assert.equal(floors.MINTSOFT_ORDER_ID.toISOString(), '2026-10-10T00:00:00.000Z')
  const early = evidenceFloors(MINTSOFT_LIVE_ENV, new Date('2026-10-12T00:00:00Z'), 14)
  assert.equal(early.MINTSOFT_ORDER_ID.toISOString(), '2026-10-10T00:00:00.000Z', 'the window start (09-28) is earlier than the cut-off, so the cut-off bounds it')
  const noCutoff = evidenceFloors({}, NOW, 14)
  assert.equal(noCutoff.MINTSOFT_ORDER_ID.toISOString(), '2026-10-06T12:00:00.000Z', 'with no instant the window alone bounds it')
  // The configured instant bounds the evidence whether or not the producer hold is enforced (legacy evidence before it is not a clash).
  const unenforced = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: CUTOFF }
  assert.equal(evidenceFloors(unenforced, NOW, 14).MINTSOFT_ORDER_ID.toISOString(), '2026-10-10T00:00:00.000Z', 'not enforced: the configured instant still floors it')
  assert.equal(evidenceFloors({ MINTSOFT_WRITES_LIVE_FROM: CUTOFF }, NOW, 14).MINTSOFT_ORDER_ID.toISOString(), '2026-10-10T00:00:00.000Z', 'no grant either: the configured instant still floors it')
  assert.equal(evidenceFloors({ ...unenforced, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, NOW, 14).MINTSOFT_ORDER_ID.toISOString(), '2026-10-10T00:00:00.000Z', 'enforced for another destination only')
  assert.equal(evidenceFloors({ XERO_WRITES_LIVE_FROM: '2026-10-12T00:00:00Z' }, NOW, 14).XERO_FOREIGN_NUMBER.toISOString(), '2026-10-12T00:00:00.000Z', 'the Xero kind reads the Xero instant')
  assert.equal(evidenceFloors({ MINTSOFT_WRITES_LIVE_FROM: '2026-09-01T00:00:00Z' }, NOW, 14).MINTSOFT_ORDER_ID.toISOString(), '2026-10-06T12:00:00.000Z', 'an instant older than the window start is bounded by the window')
  const garbage = evidenceFloors({ MINTSOFT_WRITES_LIVE_FROM: 'tomorrow' }, NOW, 14)
  assert.equal(garbage.MINTSOFT_ORDER_ID.toISOString(), '2026-10-06T12:00:00.000Z', 'an unreadable instant counts the broader window')
})

test('ARM (a4): the schedule flag is NOT a capability: with the wms-order-push job OFF, counted post-cut-off bridge evidence still fails (the route stays callable)', () => {
  const evidence = { ...cleanEvidence(), MINTSOFT_ORDER_ID: reading(3) }
  for (const cronEnabled of [{ 'wms-order-push': false }, { 'wms-order-push': true }, {} as Record<string, boolean>]) {
    const report = evaluateWritersCheck(inputs({ env: MINTSOFT_LIVE_ENV, evidence, cronEnabled }))
    assert.equal(report.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, true, JSON.stringify(cronEnabled))
    assert.equal(report.verdict, 'double-claim', JSON.stringify(cronEnabled))
  }
})

test('ARM (a3): bridge evidence does not fail while IMS cannot write (the healthy first phase)', () => {
  const evidence = { ...cleanEvidence(), MINTSOFT_ORDER_ID: reading(500), MINTSOFT_OTHER_META: reading(20), XEROOM_MARKER: reading(500) }
  const report = evaluateWritersCheck(inputs({ evidence }))
  assert.equal(report.verdict, 'ok')
  // Plugin off, grant absent, or a producer decision of SHADOW each keep IMS from writing; each is ok with the same evidence.
  for (const variant of [
    inputs({ evidence, env: { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: CUTOFF }, pluginEnabled: { woocommerce: true, mintsoft: false, xero: true } }),
    inputs({ evidence, env: { ...MINTSOFT_LIVE_ENV, MINTSOFT_WRITES_LIVE_FROM: '2026-12-01T00:00:00Z' } }),
  ]) {
    const result = evaluateWritersCheck(variant)
    assert.equal(result.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, false)
    // Other Mintsoft operations may still be claimed by the legacy path; the EVIDENCE must not be what fails.
    assert.ok(!result.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer'))
  }
})

test('ARM (b): xero.sales.invoice owned by IMS in any phase fails; the real map does not', () => {
  const env = ALL_STEPS_LIVE_ENV
  const real = evaluateWritersCheck(inputs({ env }))
  assert.equal(real.operations.find((op) => op.key === 'xero.sales.invoice')?.imsCanWrite, false, 'precondition: the producer decision keeps IMS off the sales invoice')
  assert.equal(real.findings.filter((f) => f.code === 'ims-owns-forbidden-row').length, 0)
  assert.deepEqual(realFailures(real), [])

  for (const phase of ['P1', 'P2'] as const) {
    const mutated = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).map((row) =>
      `${row.destination}.${row.operation}` === 'xero.sales.invoice' ? { ...row, owners: { ...row.owners, [phase]: 'IMS' as const } } : row)
    const report = evaluateWritersCheck(inputs({ env, map: mutated }))
    // MUTATION: drop the forbidden-row rule (or leave the map row at xeroom) => verdict ok => red.
    assert.equal(report.verdict, 'double-claim', `IMS owning the row in ${phase} must fail`)
    assert.ok(report.findings.some((f) => f.code === 'ims-owns-forbidden-row' && f.subject === 'xero.sales.invoice' && f.message.includes(phase)))
  }
})

test('ARM (b2): IMS able to post the Xero sales documents (legacy path, no producer hold) while Xeroom owns them is a double claim', () => {
  const env = { XERO_WRITE_ALLOWED_TENANT: 'tenant-1' }
  const report = evaluateWritersCheck(inputs({ env }))
  const claimed = report.findings.filter((f) => f.code === 'ims-writes-owned-elsewhere').map((f) => f.subject)
  console.log(`# legacy xero claims: ${claimed.join(', ')}`)
  for (const key of IMS_FORBIDDEN_OWNERSHIP_ROWS) assert.ok(claimed.includes(key), `${key} must be a double claim`)
  assert.equal(report.verdict, 'double-claim')
  // Switching the master off removes the claim (all three steps are set, in order, with their grants: the legacy path has no producer hold).
  const { PRODUCER_HOLD_ENFORCED_DESTINATIONS: _hold, ...legacyAll } = ALL_STEPS_LIVE_ENV
  void _hold
  const both = legacyAll
  const off = evaluateWritersCheck(inputs({ env: both, settings: new Map([['xero_sync_enabled', 'false']]) }))
  assert.ok(!off.findings.some((f) => f.code === 'ims-writes-owned-elsewhere' && f.subject?.startsWith('xero.')))
  // A per-type mode of 'off' removes only that type.
  const oneOff = evaluateWritersCheck(inputs({ env: both, settings: new Map([['xero_sync_enabled', 'true'], ['xero_sync_sales_invoice', 'off']]) }))
  assert.ok(!oneOff.findings.some((f) => f.subject === 'xero.sales.invoice' && f.code === 'ims-writes-owned-elsewhere'))
  assert.ok(oneOff.findings.some((f) => f.subject === 'xero.sales.credit-note' && f.code === 'ims-writes-owned-elsewhere'))
})

test('xero.inventory.journals stays a capability with every per-type journal mode off: STOCK_IN_TRANSIT, UNEARNED_REV_REVERSAL and ALLOCATION_REVERSAL have no switch and queue as submitted', () => {
  const { PRODUCER_HOLD_ENFORCED_DESTINATIONS: _hold, ...legacyAll } = ALL_STEPS_LIVE_ENV
  void _hold
  const modesOff = ['xero_sync_stock_receipt', 'xero_sync_inventory_adjustment', 'xero_sync_cogs_journal', 'xero_sync_cogs_reversal', 'xero_sync_stock_allocation', 'xero_sync_manufacturing_journal'].map((key): [string, string] => [key, 'off'])
  const report = evaluateWritersCheck(inputs({ env: legacyAll, settings: new Map([['xero_sync_enabled', 'true'], ...modesOff]) }))
  const journals = (r: typeof report) => r.operations.find((op) => op.key === 'xero.inventory.journals')
  assert.equal(journals(report)?.imsSwitchedOn, true, 'the switchless types still post, so IMS can write the journals')
  const syncOff = evaluateWritersCheck(inputs({ env: legacyAll, settings: new Map([['xero_sync_enabled', 'false'], ...modesOff]) }))
  assert.equal(journals(syncOff)?.imsSwitchedOn, false)
})

test('owners: an undecided owner fails, nobody warns, an operator button warns, IMS-owned is clean', () => {
  const env = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', MINTSOFT_WRITES_LIVE_FROM: CUTOFF }
  const base = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])
  const withOwner = (key: string, owner: 'unknown' | 'nobody' | 'operator-manual' | 'IMS') =>
    base.map((row) => `${row.destination}.${row.operation}` === key ? { ...row, owners: { P0: row.owners.P0, P1: owner, P2: owner } } : row)
  const settings = new Map<string, string>()
  const cron = { 'wms-order-push': true }
  const unknown = evaluateWritersCheck(inputs({ env, settings, cronEnabled: cron, map: withOwner('mintsoft.order.hold', 'unknown') }))
  assert.equal(unknown.verdict, 'double-claim')
  assert.ok(unknown.findings.some((f) => f.code === 'ims-writes-undecided' && f.subject === 'mintsoft.order.hold'))
  const nobody = evaluateWritersCheck(inputs({ env, settings, cronEnabled: cron, map: withOwner('mintsoft.order.hold', 'nobody') }))
  assert.ok(nobody.findings.some((f) => f.code === 'ims-writes-where-nobody-owns' && f.severity === 'warn'))
  assert.ok(!nobody.findings.some((f) => f.subject === 'mintsoft.order.hold' && f.severity === 'fail'))
  const operator = evaluateWritersCheck(inputs({ env, settings, cronEnabled: cron, map: withOwner('mintsoft.asn.create', 'operator-manual') }))
  assert.ok(operator.findings.some((f) => f.code === 'operator-capability-overlaps' && f.subject === 'mintsoft.asn.create' && f.severity === 'warn'))
  assert.ok(!operator.findings.some((f) => f.subject === 'mintsoft.asn.create' && f.severity === 'fail'))
  const ims = evaluateWritersCheck(inputs({ env, settings, cronEnabled: cron, map: withOwner('mintsoft.order.hold', 'IMS') }))
  assert.ok(!ims.findings.some((f) => f.subject === 'mintsoft.order.hold'))
})

test('FAIL CLOSED: unreadable grant, instant, enforcement, settings, plugins, evidence and a missing evidence kind each give a non-zero code', () => {
  const unreadable = (label: string, overrides: Partial<WritersCheckInputs>) => {
    const report = evaluateWritersCheck(inputs(overrides))
    console.log(`# unreadable arm ${label}: verdict=${report.verdict} exit=${report.exitCode}`)
    assert.ok(report.findings.some((f) => f.code === 'unreadable'), label)
    assert.notEqual(report.exitCode, 0, label)
    return report
  }
  assert.equal(unreadable('garbage grant', { env: { MINTSOFT_WRITE_ALLOWED: 'perhaps' } }).exitCode, 2)
  assert.equal(unreadable('garbage instant with a grant', { env: { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: 'tomorrow' } }).exitCode, 1, 'IMS can still write on the legacy path, so the double claim outranks')
  assert.equal(unreadable('garbage instant with no grant', { env: { MINTSOFT_WRITES_LIVE_FROM: '2026-10-10' } }).exitCode, 2)
  unreadable('garbage enforcement', { env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoftt' } })
  unreadable('settings unreadable', { settings: null })
  unreadable('cron unreadable', { cronEnabled: null })
  unreadable('plugins unreadable', { pluginEnabled: null })
  unreadable('evidence unreadable', { evidence: null })
  unreadable('evidence kind missing', { evidence: { ...cleanEvidence(), XEROOM_MARKER: undefined } })
  unreadable('unrecorded log unreadable', { evidenceUnrecorded: null })
  // With unreadable settings the writers are assumed switched ON, so a granted destination is reported rather than passed.
  const blind = evaluateWritersCheck(inputs({ settings: null, env: { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89' } }))
  assert.ok(blind.findings.some((f) => f.code === 'ims-writes-owned-elsewhere' && f.subject === 'mintsoft.order.create'))
  assert.equal(blind.exitCode, 1, 'a double claim outranks unreadable')
})

test('evidence gap: orders the import could not record make the check refuse ok', () => {
  const report = evaluateWritersCheck(inputs({ evidenceUnrecorded: 2 }))
  assert.equal(report.verdict, 'evidence-gap')
  assert.equal(report.exitCode, 4)
  assert.match(report.findings.find((f) => f.code === 'evidence-gap')!.message, /^2 storefront order\(s\)/)
})

test('the map is covered: every mapped operation has IMS-side switches or a stated reason, and nothing is stale', () => {
  const mapped = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]).filter((row) => row.destination !== 'customer-email').map((row) => `${row.destination}.${row.operation}`)
  const switches = new Set(IMS_WRITER_SWITCHES.map((entry) => entry.key))
  const reasons = new Set(Object.keys(WRITERS_WITHOUT_IMS_SWITCH))
  console.log(`# coverage: mapped=${mapped.length} switches=${switches.size} without=${reasons.size}`)
  assert.equal(switches.size, IMS_WRITER_SWITCHES.length, 'no duplicate switch declarations')
  for (const key of mapped) assert.equal(Number(switches.has(key)) + Number(reasons.has(key)), 1, `${key} must be in exactly one of the two lists`)
  for (const key of [...switches, ...reasons]) assert.ok(mapped.includes(key), `${key} is declared but not in the map`)
  assert.ok(writersCheckSettingKeys().includes('xero_sync_sales_invoice'))
  assert.deepEqual(writersCheckCronSlugs(), [], 'no switch relies on a schedule flag until its route enforces it (see the cron census)')
  // An unclassified new map row is reported, not skipped.
  const extra = [...(WRITER_OWNERSHIP_MAP as readonly OwnershipRow[]), { ...(WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])[0]!, destination: 'xero' as const, operation: 'brand.new' }]
  const report = evaluateWritersCheck(inputs({ map: extra }))
  assert.equal(report.verdict, 'unreadable')
})

test('the report states what it cannot see, in the text and in the JSON', () => {
  const report = evaluateWritersCheck(inputs())
  assert.deepEqual(report.cannotSee, WRITERS_CHECK_CANNOT_SEE)
  assert.ok(report.cannotSee.some((line) => /leaves no trace/.test(line)))
  const text = renderWritersCheckText(report)
  assert.match(text, /What this check CANNOT see:/)
  for (const line of WRITERS_CHECK_CANNOT_SEE) assert.ok(text.includes(line))
  assert.ok(!/order id|invoice number [A-Z0-9]/.test(JSON.stringify(report.findings)))
})

test('the exit-code table is complete and unique', () => {
  const codes = WRITERS_CHECK_EXIT_CODES.map((row) => row.code)
  assert.equal(new Set(codes).size, codes.length)
  for (const verdict of ['ok', 'double-claim', 'unreadable', 'evidence-gap'] as const) assert.ok(WRITERS_CHECK_EXIT_CODES.some((row) => row.name === verdict))
})

test('OPERATOR-TRIGGERED operations: owned by the operator is a stated warning; owned by ANY OTHER writer is a failing double claim', () => {
  const env = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: CUTOFF }
  const base = (WRITER_OWNERSHIP_MAP as readonly OwnershipRow[])
  const withOwner = (key: string, owner: OwnershipRow['owners']['P1']) =>
    base.map((row) => `${row.destination}.${row.operation}` === key ? { ...row, owners: { P0: row.owners.P0, P1: owner, P2: owner } } : row)
  const run = (owner: OwnershipRow['owners']['P1']) => evaluateWritersCheck(inputs({ env, settings: new Map(), cronEnabled: {}, map: withOwner('mintsoft.asn.create', owner) }))

  const manual = run('operator-manual')
  assert.ok(!manual.findings.some((f) => f.code === 'ims-writes-owned-elsewhere'), 'the operator acting through the button is the owner acting')
  assert.ok(manual.findings.some((f) => f.code === 'operator-capability-overlaps' && f.severity === 'warn' && f.subject === 'mintsoft.asn.create' && /operator-manual/.test(f.message)))
  const text = renderWritersCheckText(manual)
  assert.match(text, /operator-manual operations \(IMS writes them only by an operator action\): .*mintsoft\.asn\.create/)

  // A row that regresses from operator-manual to another writer is a failing finding even though the trigger is an operator button.
  for (const owner of ['woo-mintsoft-plugin', 'mintsoft-native', 'qoblex-native', 'aelia', 'xeroom', 'o3d-ioss-xero', 'woocommerce-native'] as const) {
    const other = run(owner)
    assert.equal(other.verdict, 'double-claim', owner)
    assert.equal(other.exitCode, 1, owner)
    assert.ok(other.findings.some((f) => f.code === 'ims-writes-owned-elsewhere' && f.severity === 'fail' && f.subject === 'mintsoft.asn.create'), owner)
    assert.ok(!other.findings.some((f) => f.code === 'operator-capability-overlaps'), owner)
    assert.doesNotMatch(renderWritersCheckText(other), /operator-manual operations/)
  }
  // And an automatic (non-operator) operation owned by another writer fails as before.
  const auto = evaluateWritersCheck(inputs({ env, settings: new Map(), cronEnabled: {}, map: withOwner('mintsoft.order.hold', 'woo-mintsoft-plugin') }))
  assert.equal(auto.verdict, 'double-claim')
})

test('INCONSISTENT configuration fails: a live-from instant with no grant, and a grant with no live-from instant, are each non-zero; both set (or neither) is not that finding', () => {
  const grant = 'https://api.mintsoft.example|89'
  const find = (env: Record<string, string>) => evaluateWritersCheck(inputs({ env, evidence: cleanEvidence() }))
  const cutoffOnly = find({ MINTSOFT_WRITES_LIVE_FROM: CUTOFF })
  const grantOnly = find({ MINTSOFT_WRITE_ALLOWED: grant })
  for (const report of [cutoffOnly, grantOnly]) {
    assert.ok(report.findings.some((f) => f.code === 'inconsistent-configuration' && f.severity === 'fail' && f.subject === 'mintsoft'), JSON.stringify(report.findings))
    assert.notEqual(report.exitCode, 0)
    assert.notEqual(report.verdict, 'ok')
  }
  assert.equal(cutoffOnly.verdict, 'unreadable', 'no grant: IMS cannot write, so the configuration finding alone decides')
  assert.match(cutoffOnly.findings.find((f) => f.code === 'inconsistent-configuration')!.message, /mintsoft/i)
  assert.equal(find({}).exitCode, 0)
  for (const clean of [find({}), find({ MINTSOFT_WRITE_ALLOWED: grant, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', MINTSOFT_WRITES_LIVE_FROM: CUTOFF })]) {
    assert.ok(!clean.findings.some((f) => f.code === 'inconsistent-configuration'))
  }
  // Garbage stays the unreadable finding, not a second inconsistent one.
  const garbage = find({ MINTSOFT_WRITES_LIVE_FROM: 'tomorrow' })
  assert.ok(garbage.findings.some((f) => f.code === 'unreadable') && !garbage.findings.some((f) => f.code === 'inconsistent-configuration'))
})

test('UNKNOWN evidence kinds: any stored row of a kind this version does not know, or a count that cannot be read, is unreadable (exit 2), and a zero is clean', () => {
  const clean = evaluateWritersCheck(inputs({ unknownEvidenceKinds: 0 }))
  assert.equal(clean.exitCode, 0)
  for (const unknownEvidenceKinds of [1, 7, null]) {
    const report = evaluateWritersCheck(inputs({ unknownEvidenceKinds }))
    assert.equal(report.verdict, 'unreadable', String(unknownEvidenceKinds))
    assert.equal(report.exitCode, 2)
    assert.ok(report.findings.some((f) => f.code === 'unreadable' && /does not know|could not be established/.test(f.message)))
  }
  assert.match(renderWritersCheckText(evaluateWritersCheck(inputs({ unknownEvidenceKinds: 3 }))), /evidence rows of an unknown kind: 3/)
})
