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

const ALL_ON = new Map<string, string>([['xero_sync_enabled', 'true'], ['xero_daily_batch_enabled', 'true'], ['wc_stock_sync_enabled', 'true'], ['wc_fx_push_enabled', 'true']])

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
    evidenceUnrecorded: 0,
    ...overrides,
  }
}

const MINTSOFT_LIVE_ENV = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: CUTOFF, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }

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
  assert.equal(clean.verdict, 'ok', 'precondition: with no evidence the same installation is clean, so the evidence is what fails it')

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

test('ARM (a2): evidence that predates the cut-off or is not current does not fail (no false finding for pre-cutoff orders)', () => {
  const evidence = { ...cleanEvidence(), MINTSOFT_ORDER_ID: { counted: 0, total: 40, unpaid: 2, floor: '2026-10-10T00:00:00.000Z' } }
  const report = evaluateWritersCheck(inputs({ env: MINTSOFT_LIVE_ENV, evidence }))
  assert.equal(report.verdict, 'ok')
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
    inputs({ evidence, env: { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89' }, pluginEnabled: { woocommerce: true, mintsoft: false, xero: true } }),
    inputs({ evidence, env: { ...MINTSOFT_LIVE_ENV, MINTSOFT_WRITES_LIVE_FROM: '2026-12-01T00:00:00Z' } }),
  ]) {
    const result = evaluateWritersCheck(variant)
    assert.equal(result.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, false)
    // Other Mintsoft operations may still be claimed by the legacy path; the EVIDENCE must not be what fails.
    assert.ok(!result.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer'))
  }
})

test('ARM (b): xero.sales.invoice owned by IMS in any phase fails; the real map does not', () => {
  const env = { XERO_WRITE_ALLOWED_TENANT: 'tenant-1', XERO_WRITES_LIVE_FROM: CUTOFF, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }
  const real = evaluateWritersCheck(inputs({ env }))
  assert.equal(real.operations.find((op) => op.key === 'xero.sales.invoice')?.imsCanWrite, false, 'precondition: the producer decision keeps IMS off the sales invoice')
  assert.equal(real.findings.filter((f) => f.code === 'ims-owns-forbidden-row').length, 0)
  assert.equal(real.verdict, 'ok')

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
  // Switching the master off removes the claim.
  const off = evaluateWritersCheck(inputs({ env, settings: new Map([['xero_sync_enabled', 'false']]) }))
  assert.equal(off.verdict, 'ok')
  // A per-type mode of 'off' removes only that type.
  const oneOff = evaluateWritersCheck(inputs({ env, settings: new Map([['xero_sync_enabled', 'true'], ['xero_sync_sales_invoice', 'off']]) }))
  assert.ok(!oneOff.findings.some((f) => f.subject === 'xero.sales.invoice' && f.code === 'ims-writes-owned-elsewhere'))
  assert.ok(oneOff.findings.some((f) => f.subject === 'xero.sales.credit-note' && f.code === 'ims-writes-owned-elsewhere'))
})

test('owners: an undecided owner fails, nobody warns, an operator button warns, IMS-owned is clean', () => {
  const env = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89' }
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
