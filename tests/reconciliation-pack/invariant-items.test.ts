import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAcceptanceFile } from '../../lib/ops/readiness-gate.ts'
import { findingToken, runInvariantItem, type InvariantItemContext, type InvariantItemId } from '../../lib/reconciliation-pack/invariant-items.ts'
import { buildReport, type ItemInput } from '../../lib/reconciliation-pack/report.ts'
import { PACK_ITEM_IDS } from '../../lib/reconciliation-pack/constants.ts'

/**
 * R3, R4 AND R15 NEVER PASS ON AN UNFINISHED, UNREADABLE, TRUNCATED OR SELF-CONTRADICTING INVARIANT REPORT.
 * Every shape below is run for every item it applies to, and the assertion is the same: not a pass.
 */

const NOW = new Date('2026-10-20T12:00:00.000Z')
const P = 'cproduct0000000000000001a'
const W = 'cwarehouse000000000000001'
const P2 = 'cproduct0000000000000002b'
const NO_ACCEPTANCES = parseAcceptanceFile(null)
const ctx = (acceptances = NO_ACCEPTANCES): InvariantItemContext => ({ phase: 'P1', now: NOW, acceptances })

type F = Record<string, unknown>
const r3 = (quantity: unknown, layers: unknown, over: F = {}): F => ({ severity: 'warning', code: 'stock_cost_layer_quantity_mismatch', productId: P, warehouseId: W, message: 'm', details: { quantity, remainingCostLayerQty: layers }, ...over })
const r4 = (reserved: unknown, known: unknown, over: F = {}): F => ({ severity: 'critical', code: 'stock_reserved_source_mismatch', productId: P, warehouseId: W, message: 'm', details: { reservedQty: reserved, knownReservedQty: known }, ...over })
/** The accounting and sales reports have no `truncated` or `nextCursor` field at all, exactly as the real ones. */
const plainReport = (findings: F[]): F => { const { truncated: _t, nextCursor: _c, ...rest } = report(findings); return rest }
const report = (findings: F[], over: F = {}): F => ({
  findings, truncated: false, nextCursor: null,
  summary: { total: findings.length, info: findings.filter((f) => f.severity === 'info').length, warning: findings.filter((f) => f.severity === 'warning').length, critical: findings.filter((f) => f.severity === 'critical').length },
  ...over,
})
type Domain = 'inventory' | 'accounting' | 'sales'
const countsOf = (r: unknown): F => {
  const raw = (r as F | null | undefined)?.findings
  const fs = (Array.isArray(raw) ? raw : []).filter((f): f is F => typeof f === 'object' && f !== null)
  const n = (severity: string) => fs.filter((f) => f.severity === severity).length
  return { total: fs.length, info: n('info'), warning: n('warning'), critical: n('critical') }
}
/** A critical-findings entry exactly as lib/cron/invariant-check.ts toCriticalFinding builds it (JSON drops the undefined ids). */
const criticalEntry = (domain: Domain, f: F): F => JSON.parse(JSON.stringify({ domain, code: f.code, message: f.message, details: f.details, productId: f.productId, warehouseId: f.warehouseId, orderId: f.orderId, shipmentId: f.shipmentId, refundId: f.refundId, syncLogId: f.syncLogId }))
/** A run result in the real shape, every count derived from the reports actually listed; the knobs then break one thing at a time. */
function evidence(inventory: F[] = [], over: { inventory?: unknown; accounting?: unknown; sales?: unknown; result?: F; top?: F; total?: F; domains?: Partial<Record<Domain, unknown>>; ok?: unknown; criticalFindings?: unknown } = {}): F {
  const pick = (k: Domain, fallback: F) => (k in over ? over[k] : fallback)
  const reports = { inventory: pick('inventory', report(inventory)), accounting: pick('accounting', plainReport([])), sales: pick('sales', plainReport([])) }
  const dom = { inventory: countsOf(reports.inventory), accounting: countsOf(reports.accounting), sales: countsOf(reports.sales) }
  const sum = (key: string) => (['inventory', 'accounting', 'sales'] as Domain[]).reduce((n, d) => n + (dom[d][key] as number), 0)
  const critical = (['inventory', 'accounting', 'sales'] as Domain[]).flatMap((d) => (Array.isArray((reports[d] as F | null | undefined)?.findings) ? ((reports[d] as F).findings as F[]) : []).filter((f) => f && f.severity === 'critical').map((f) => criticalEntry(d, f)))
  const summary = { total: { total: sum('total'), info: sum('info'), warning: sum('warning'), critical: sum('critical'), ...(over.total ?? {}) }, ...dom, ...(over.domains ?? {}) }
  return { ok: 'ok' in over ? over.ok : sum('critical') === 0, ...(over.top ?? {}), result: { status: 'completed', errors: [], criticalFindings: 'criticalFindings' in over ? over.criticalFindings : critical, summary, reports, ...(over.result ?? {}) } }
}

function assertBuilds(item: ItemInput): void {
  const items = PACK_ITEM_IDS.map((id): ItemInput => id === item.id ? item : { id, outcome: id === 'R7' || id === 'R8' || id === 'R11' ? 'not-applicable' : 'inconclusive', reasons: [id === 'R7' || id === 'R8' || id === 'R11' ? 'PHASE_NOT_APPLICABLE' : 'NO_RUNNER'] })
  const built = buildReport({ runId: '20260101T000000Z-000000000000', systemIdentifier: '1000000000', phase: 'P1', asOf: '2026-10-19', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), streams: [], items: items.map((i) => i.id === 'R2' ? { id: 'R2', outcome: 'inconclusive', reasons: ['NO_RUNNER'] } : i) }, 1, null)
  assert.ok(built.record.items.find((i) => i.id === item.id))
}

test('a clean, finished report passes R3, R4 and R15 on the named proof that nothing is listed', () => {
  for (const id of ['R3', 'R4', 'R15'] as InvariantItemId[]) {
    const item = runInvariantItem(id, evidence(), ctx())
    assert.equal(item.outcome, 'pass', id)
    assert.deepEqual(item.proof, { kind: 'proven-empty', source: 'invariant-report-clean' }, id)
    assert.deepEqual(item.sources, ['invariant-report'])
    assertBuilds(item)
  }
})

test('a flagged level is a bothDiffer identity (R3 and R4), keyed by product and warehouse; an unrelated finding changes nothing', () => {
  const item3 = runInvariantItem('R3', evidence([r3(5, 3), r4(1, 1)]), ctx())
  assert.equal(item3.outcome, 'fail')
  assert.equal(item3.entries!.bothDiffer!.length, 1)
  assert.deepEqual([item3.entries!.bothDiffer![0]!.ims, item3.entries!.bothDiffer![0]!.vendor, item3.entries!.bothDiffer![0]!.delta], ['5', '3', '2'])
  assert.equal(item3.entries!.bothDiffer![0]!.key, `${P}|${W}`)
  assertBuilds(item3)
  const item4 = runInvariantItem('R4', evidence([r3(5, 3), r4(2, 0)]), ctx())
  assert.equal(item4.outcome, 'fail')
  assert.equal(item4.entries!.bothDiffer!.length, 1)
  assertBuilds(item4)
  // The other claim is untouched by it.
  assert.equal(runInvariantItem('R3', evidence([r4(2, 0)]), ctx()).outcome, 'pass')
})

const MIXED = (): F[] => [warning(), { severity: 'info', code: 'i', message: 'm', details: {} }, r4(2, 0)]
type Shape = { name: string; ev: () => unknown; ids: InvariantItemId[] }
const BOTH: InvariantItemId[] = ['R3', 'R4', 'R15']
const SHAPES: Shape[] = [
  { name: 'no evidence at all', ev: () => null, ids: BOTH },
  { name: 'evidence undefined', ev: () => undefined, ids: BOTH },
  { name: 'evidence a string', ev: () => 'completed', ids: BOTH },
  { name: 'evidence a list', ev: () => [], ids: BOTH },
  { name: 'evidence empty object', ev: () => ({}), ids: BOTH },
  { name: 'result missing', ev: () => ({ ok: true }), ids: BOTH },
  { name: 'reports missing', ev: () => ({ ok: true, result: { status: 'completed', errors: [] } }), ids: BOTH },
  { name: 'run status partial_failure', ev: () => evidence([], { result: { status: 'partial_failure' } }), ids: BOTH },
  { name: 'run status failed', ev: () => evidence([], { result: { status: 'failed' } }), ids: BOTH },
  { name: 'run status missing', ev: () => evidence([], { result: { status: undefined } }), ids: BOTH },
  { name: 'run errors listed', ev: () => evidence([], { result: { errors: [{ domain: 'sales', message: 'x' }] } }), ids: BOTH },
  { name: 'run errors not a list', ev: () => evidence([], { result: { errors: 'none' } }), ids: BOTH },
  { name: 'run errors missing', ev: () => evidence([], { result: { errors: undefined } }), ids: BOTH },
  { name: 'inventory report null', ev: () => evidence([], { inventory: null }), ids: BOTH },
  { name: 'inventory report missing', ev: () => evidence([], { inventory: undefined, result: { reports: { accounting: report([]), sales: report([]) } } }), ids: BOTH },
  { name: 'inventory findings not a list', ev: () => evidence([], { inventory: { findings: 'x', truncated: false, summary: { total: 0, warning: 0, critical: 0 } } }), ids: BOTH },
  { name: 'inventory truncated', ev: () => evidence([], { inventory: report([], { truncated: true }) }), ids: BOTH },
  { name: 'inventory truncated flag absent', ev: () => evidence([], { inventory: report([], { truncated: undefined }) }), ids: BOTH },
  { name: 'inventory truncated flag a string', ev: () => evidence([], { inventory: report([], { truncated: 'false' }) }), ids: BOTH },
  { name: 'inventory truncated flag null', ev: () => evidence([], { inventory: report([], { truncated: null }) }), ids: BOTH },
  { name: 'inventory cursor left over', ev: () => evidence([], { inventory: report([], { nextCursor: 'cabc' }) }), ids: BOTH },
  { name: 'truncation marker finding', ev: () => evidence([{ severity: 'warning', code: 'invariant_report_truncated', message: 'm', details: {} }]), ids: BOTH },
  { name: 'summary missing', ev: () => evidence([], { inventory: { findings: [], truncated: false } }), ids: BOTH },
  { name: 'summary total above the list', ev: () => evidence([], { inventory: report([], { summary: { total: 1, warning: 0, critical: 0 } }) }), ids: BOTH },
  { name: 'summary total below the list', ev: () => evidence([r3(5, 3)], { inventory: report([r3(5, 3)], { summary: { total: 0, warning: 1, critical: 0 } }) }), ids: BOTH },
  { name: 'summary warning count above the list', ev: () => evidence([], { inventory: report([], { summary: { total: 0, warning: 3, critical: 0 } }) }), ids: BOTH },
  { name: 'summary counts not numbers', ev: () => evidence([], { inventory: report([], { summary: { total: '0', warning: '0', critical: '0' } }) }), ids: BOTH },
  { name: 'summary counts negative', ev: () => evidence([], { inventory: report([], { summary: { total: -1, warning: 0, critical: 0 } }) }), ids: BOTH },
  { name: 'a finding that is not an object', ev: () => evidence([], { inventory: report([], { findings: [null], summary: { total: 1, warning: 0, critical: 0 } }) }), ids: BOTH },
  { name: 'a finding with no code', ev: () => evidence([{ severity: 'warning', message: 'm' }]), ids: BOTH },
  { name: 'R3 finding with no details', ev: () => evidence([r3(5, 3, { details: undefined })]), ids: ['R3'] },
  { name: 'R3 finding with a missing value', ev: () => evidence([r3(5, undefined)]), ids: ['R3'] },
  { name: 'R3 finding with a value that is not a number', ev: () => evidence([r3('five', 3)]), ids: ['R3'] },
  { name: 'R3 finding with NaN', ev: () => evidence([r3(Number.NaN, 3)]), ids: ['R3'] },
  { name: 'R3 finding with Infinity', ev: () => evidence([r3(Number.POSITIVE_INFINITY, 3)]), ids: ['R3'] },
  { name: 'R3 finding with exponent text', ev: () => evidence([r3('1e3', 3)]), ids: ['R3'] },
  { name: 'R3 finding with no product id', ev: () => evidence([r3(5, 3, { productId: undefined })]), ids: ['R3'] },
  { name: 'R3 finding with an object as warehouse id', ev: () => evidence([r3(5, 3, { warehouseId: {} })]), ids: ['R3'] },
  { name: 'R3 flagged but EQUAL under the pack tolerance', ev: () => evidence([r3(1, 1.00001)]), ids: ['R3'] },
  { name: 'R3 flagged with identical values', ev: () => evidence([r3(2, 2)]), ids: ['R3'] },
  { name: 'R3 the same pair flagged twice', ev: () => evidence([r3(5, 3), r3(5, 4)]), ids: ['R3'] },
  { name: 'R4 flagged but equal', ev: () => evidence([r4(2, 2)]), ids: ['R4'] },
  { name: 'R4 finding with a missing value', ev: () => evidence([r4(2, null)]), ids: ['R4'] },
  { name: 'accounting report null', ev: () => evidence([], { accounting: null }), ids: ['R15'] },
  { name: 'sales report hit its row cap (marker finding)', ev: () => evidence([], { sales: plainReport([{ severity: 'warning', code: 'refund_status_reconciliation_row_cap_reached', message: 'm', details: {} }]) }), ids: ['R15'] },
  { name: 'accounting report flagged truncated', ev: () => evidence([], { accounting: report([], { truncated: true }) }), ids: ['R15'] },
  { name: 'accounting truncated flag a string', ev: () => evidence([], { accounting: report([], { truncated: 'no' }) }), ids: ['R15'] },
  { name: 'sales report truncated', ev: () => evidence([], { sales: report([], { truncated: true }) }), ids: ['R15'] },
  { name: 'sales report missing', ev: () => evidence([], { sales: undefined, result: { reports: { inventory: report([]), accounting: report([]) } } }), ids: ['R15'] },
  { name: 'unknown severity', ev: () => evidence([{ severity: 'urgent', code: 'x', productId: P, message: 'm', details: {} }]), ids: ['R15'] },
  { name: 'critical count above what the reports list', ev: () => evidence([], { total: { critical: 2 } }), ids: BOTH },
  { name: 'critical findings list shorter than the reports', ev: () => evidence([r4(2, 0)], { criticalFindings: [] }), ids: BOTH },
  { name: 'run-wide warning count above what the reports list', ev: () => evidence([], { total: { warning: 2 } }), ids: BOTH },
  { name: 'run-wide warning count below what the reports list', ev: () => evidence([warning()], { total: { warning: 0 } }), ids: BOTH },
  { name: 'run-wide warning count missing', ev: () => evidence([], { total: { warning: undefined } }), ids: BOTH },
  { name: 'unknown severity with matching counts (inventory)', ev: () => evidence([{ severity: 'urgent', code: 'x', productId: P, message: 'm', details: {} }]), ids: BOTH },
  { name: 'unknown severity with matching counts (sales)', ev: () => evidence([], { sales: plainReport([{ severity: 'urgent', code: 'x', message: 'm', details: {} }]) }), ids: ['R15'] },
  { name: 'severity not a known word (case)', ev: () => evidence([{ severity: 'Critical', code: 'x', message: 'm', details: {} }]), ids: BOTH },
  { name: 'critical summary missing', ev: () => evidence([], { result: { summary: undefined } }), ids: BOTH },
  // ---- the whole class: every count, flag and enum of the report, the run summary and the findings ----
  ...(['total', 'info', 'warning', 'critical'] as const).flatMap((key) => [
    { name: `run-wide ${key} above the sum of the domains`, ev: () => evidence(MIXED(), { total: { [key]: 99 } }), ids: BOTH },
    { name: `run-wide ${key} below the sum of the domains`, ev: () => evidence(MIXED(), { total: { [key]: 0 } }), ids: BOTH },
    { name: `run-wide ${key} missing`, ev: () => evidence([], { total: { [key]: undefined } }), ids: BOTH },
    { name: `run-wide ${key} not a number`, ev: () => evidence([], { total: { [key]: '0' } }), ids: BOTH },
    { name: `run-wide ${key} negative`, ev: () => evidence([], { total: { [key]: -1 } }), ids: BOTH },
    { name: `run-wide ${key} fractional`, ev: () => evidence([], { total: { [key]: 0.5 } }), ids: BOTH },
    { name: `inventory report ${key} above its list`, ev: () => evidence([], { inventory: report([], { summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: 5 } }) }), ids: BOTH },
    { name: `inventory report ${key} missing`, ev: () => evidence([], { inventory: report([], { summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: undefined } }) }), ids: BOTH },
    { name: `accounting report ${key} above its list`, ev: () => evidence([], { accounting: { findings: [], summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: 5 } } }), ids: BOTH },
    { name: `sales report ${key} missing`, ev: () => evidence([], { sales: { findings: [], summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: undefined } } }), ids: BOTH },
    ...(['inventory', 'accounting', 'sales'] as const).flatMap((d) => [
      { name: `run summary of ${d}: ${key} differs from its report`, ev: () => evidence([], { domains: { [d]: { total: 0, info: 0, warning: 0, critical: 0, [key]: 3 } } }), ids: BOTH },
      { name: `run summary of ${d}: ${key} missing`, ev: () => evidence([], { domains: { [d]: { total: 0, info: 0, warning: 0, critical: 0, [key]: undefined } } }), ids: BOTH },
    ]),
  ]),
  // The same tampering stated EVERYWHERE (the report, the run's domain summary and the run total agree with one another and disagree
  // with the list) is caught by the report-versus-list check alone, so it is tested on its own.
  ...(['total', 'info', 'warning', 'critical'] as const).flatMap((key) => [
    { name: `${key} stated consistently everywhere but not matching the list`, ev: () => evidence([], { inventory: report([], { summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: 4 } }), domains: { inventory: { total: 0, info: 0, warning: 0, critical: 0, [key]: 4 } }, total: { [key]: 4 }, ...(key === 'critical' ? { criticalFindings: [1, 2, 3, 4].map(() => ({ domain: 'inventory', code: 'x' })), ok: false } : {}) }), ids: BOTH },
    { name: `${key} missing everywhere`, ev: () => evidence([], { inventory: report([], { summary: { total: 0, info: 0, warning: 0, critical: 0, [key]: undefined } }), domains: { inventory: { total: 0, info: 0, warning: 0, critical: 0, [key]: undefined } }, total: { [key]: undefined } }), ids: BOTH },
  ]),
  { name: 'run summary missing a domain', ev: () => evidence([], { domains: { sales: undefined } }), ids: BOTH },
  { name: 'run summary total missing', ev: () => evidence([], { result: { summary: { inventory: countsOf(report([])), accounting: countsOf(plainReport([])), sales: countsOf(plainReport([])) } } }), ids: BOTH },
  { name: 'ok missing', ev: () => ({ ...evidence(), ok: undefined }), ids: BOTH },
  { name: 'ok a string', ev: () => evidence([], { ok: 'true' }), ids: BOTH },
  { name: 'ok true beside a critical finding', ev: () => evidence([r4(2, 0)], { ok: true }), ids: BOTH },
  { name: 'ok false beside nothing critical', ev: () => evidence([], { ok: false }), ids: BOTH },
  { name: 'critical findings list not a list', ev: () => evidence([r4(2, 0)], { criticalFindings: 'x' }), ids: BOTH },
  { name: 'critical findings entry not an object', ev: () => evidence([r4(2, 0)], { criticalFindings: [null] }), ids: BOTH },
  { name: 'critical findings entry without a domain', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ code: 'x' }] }), ids: BOTH },
  { name: 'critical findings entry of an unknown domain', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ domain: 'other', code: 'x' }] }), ids: BOTH },
  { name: 'critical findings: the right entries plus one from an unknown domain', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ domain: 'inventory', code: 'x' }, { domain: 'other', code: 'x' }] }), ids: BOTH },
  { name: 'critical findings: the right entries plus a duplicate of a clean domain', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ domain: 'inventory', code: 'x' }, { domain: 'sales', code: 'x' }] }), ids: BOTH },
  { name: 'critical findings entry in the wrong domain', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ domain: 'sales', code: 'x' }] }), ids: BOTH },
  { name: 'critical findings: one finding listed twice in place of another, every count still right', ev: () => { const a = r4(2, 0); const b = r4(3, 0, { productId: P2 }); return evidence([a, b], { criticalFindings: [criticalEntry('inventory', a), criticalEntry('inventory', a)] }) }, ids: BOTH },
  { name: 'critical findings entry naming the right code for another subject', ev: () => evidence([r4(2, 0)], { criticalFindings: [criticalEntry('inventory', r4(2, 0, { productId: P2 }))] }), ids: BOTH },
  { name: 'critical findings entry with a subject id that is not a string', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ ...criticalEntry('inventory', r4(2, 0)), orderId: 7 }] }), ids: BOTH },
  { name: 'critical findings entry without a code', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ domain: 'inventory' }] }), ids: BOTH },
  { name: 'an info finding with a productId that is not a string', ev: () => evidence([{ severity: 'info', code: 'x', productId: 42, message: 'm', details: {} }]), ids: BOTH },
  { name: 'an info finding with a orderId that is not a string', ev: () => evidence([{ severity: 'info', code: 'x', orderId: { id: 1 }, message: 'm', details: {} }]), ids: BOTH },
  { name: 'a warning finding with a productId that is not a string', ev: () => evidence([{ severity: 'warning', code: 'x', productId: 42, message: 'm', details: {} }]), ids: BOTH },
  { name: 'a warning finding with a orderId that is not a string', ev: () => evidence([{ severity: 'warning', code: 'x', orderId: { id: 1 }, message: 'm', details: {} }]), ids: BOTH },
  { name: 'an info finding with an empty productId', ev: () => evidence([{ severity: 'info', code: 'x', productId: '', message: 'm', details: {} }]), ids: BOTH },
  { name: 'a critical findings entry with an empty orderId', ev: () => evidence([r4(2, 0)], { criticalFindings: [{ ...criticalEntry('inventory', r4(2, 0)), orderId: '' }] }), ids: BOTH },
  { name: 'a finding with an empty code', ev: () => evidence([{ severity: 'info', code: '', message: 'm', details: {} }]), ids: BOTH },
  { name: 'a finding with a numeric code', ev: () => evidence([{ severity: 'info', code: 5, message: 'm', details: {} }]), ids: BOTH },
  { name: 'a finding with a numeric severity', ev: () => evidence([{ severity: 1, code: 'x', message: 'm', details: {} }]), ids: BOTH },
  { name: 'a finding with an empty severity', ev: () => evidence([{ severity: '', code: 'x', message: 'm', details: {} }]), ids: BOTH },
  { name: 'accounting findings not a list', ev: () => evidence([], { accounting: { findings: {}, summary: { total: 0, info: 0, warning: 0, critical: 0 } } }), ids: BOTH },
  { name: 'sales report is a list', ev: () => evidence([], { sales: [] }), ids: BOTH },
  { name: 'reports not an object', ev: () => evidence([], { result: { reports: [] } }), ids: BOTH },
  { name: 'status an object', ev: () => evidence([], { result: { status: { x: 1 } } }), ids: BOTH },
  { name: 'a getter that throws', ev: () => ({ get result(): never { throw new Error('boom') } }), ids: BOTH },
  { name: 'a Proxy that throws', ev: () => new Proxy({}, { get() { throw new Error('boom') }, has() { throw new Error('boom') }, ownKeys() { throw new Error('boom') } }), ids: BOTH },
]

test('NO unfinished, unreadable, truncated or self-contradicting report is ever a pass', () => {
  let cases = 0
  for (const shape of SHAPES) {
    for (const id of shape.ids) {
      let item: ItemInput | undefined
      assert.doesNotThrow(() => { item = runInvariantItem(id, shape.ev(), ctx()) }, `${id}: ${shape.name}`)
      assert.notEqual(item!.outcome, 'pass', `${id}: ${shape.name}`)
      assert.equal(item!.outcome, 'inconclusive', `${id}: ${shape.name} is inconclusive, not a fail on a partial list`)
      assert.ok(item!.reasons.length > 0 && item!.proof == null, `${id}: ${shape.name}`)
      assertBuilds(item!)
      cases += 1
    }
  }
  console.log(`precondition: ${SHAPES.length} shapes, ${cases} item runs, none a pass`)
  assert.ok(cases >= 390)
})


// ---- R15 ----------------------------------------------------------------------------------------

const warning = (over: F = {}): F => ({ severity: 'warning', code: 'some_warning', productId: P, warehouseId: W, message: 'm', details: {}, ...over })
const acceptance = (id: string, over: F = {}) => parseAcceptanceFile(JSON.stringify({ schemaVersion: 1, acceptances: [{ warningId: id, acceptedBy: 'A Person', acceptedAt: '2026-10-19T09:00:00Z', reason: 'Checked by hand and understood by me', expiresAt: '2026-11-19T09:00:00Z', phases: ['P1'], ...over }] }))
const idOf = (f: F) => `invariant:inventory:${f.code}:product=${P},warehouse=${W}`

test('R15: a critical finding fails, and an acceptance never applies to it', () => {
  const crit = r4(2, 0)
  const item = runInvariantItem('R15', evidence([crit]), ctx(acceptance(idOf(crit))))
  assert.equal(item.outcome, 'fail')
  assert.equal(item.entries!.bothDiffer!.length, 1)
  assertBuilds(item)
})

test('R15: an accepted warning sharing its identity with a critical finding never hides it, in either order', () => {
  const crit = r4(2, 0)
  const warn = r4(2, 0, { severity: 'warning' })
  assert.equal(idOf(warn), idOf(crit), 'precondition: the two findings share one gate identity')
  for (const [name, findings] of [['warning first', [warn, crit]], ['critical first', [crit, warn]]] as const) {
    const item = runInvariantItem('R15', evidence([...findings]), ctx(acceptance(idOf(warn))))
    assert.equal(item.outcome, 'fail', name)
    assert.equal(item.entries!.bothDiffer!.length, 1, name)
    assert.equal((item.entries!.bothEqual ?? []).length, 0, name)
    assertBuilds(item)
  }
})

test('R15: a warning with an empty subject id never matches the acceptance written for the subjectless warning', () => {
  const subjectless = { severity: 'warning', code: 'some_warning', message: 'm', details: {} }
  const accepted = ctx(acceptance('invariant:inventory:some_warning:-'))
  assert.equal(runInvariantItem('R15', evidence([subjectless]), accepted).outcome, 'pass', 'precondition: the acceptance covers the subjectless warning')
  const item = runInvariantItem('R15', evidence([{ ...subjectless, productId: '' }]), accepted)
  assert.equal(item.outcome, 'inconclusive')
  assertBuilds(item)
  assert.equal(runInvariantItem('R15', evidence([{ ...subjectless, productId: null }]), accepted).outcome, 'pass', 'null is how the inventory producer writes an absent id')
})

test('R15: a warning with no current written acceptance fails; an accepted one is an equal identity and passes on "compared"', () => {
  const w = warning()
  const unaccepted = runInvariantItem('R15', evidence([w]), ctx())
  assert.equal(unaccepted.outcome, 'fail')
  const accepted = runInvariantItem('R15', evidence([w]), ctx(acceptance(idOf(w))))
  assert.equal(accepted.outcome, 'pass')
  assert.deepEqual(accepted.proof, { kind: 'compared' })
  assert.equal(accepted.entries!.bothEqual!.length, 1)
  assert.equal(accepted.entries!.bothEqual![0]!.key, findingToken('inventory', w as { code: string }))
  assertBuilds(accepted)
  for (const over of [{ expiresAt: '2026-10-19T10:00:00Z' }, { phases: ['P0'] }, { acceptedAt: '2026-10-21T09:00:00Z', expiresAt: '2026-11-19T09:00:00Z' }]) {
    assert.equal(runInvariantItem('R15', evidence([w]), ctx(acceptance(idOf(w), over))).outcome, 'fail', JSON.stringify(over))
  }
  assert.equal(runInvariantItem('R15', evidence([w]), ctx(acceptance('invariant:inventory:other:product=x'))).outcome, 'fail')
  assert.equal(runInvariantItem('R15', evidence([w]), ctx(parseAcceptanceFile('{not json'))).outcome, 'fail')
})

test('R15: one accepted and one not accepted is a fail naming exactly the one', () => {
  const a = warning({ code: 'a_warning' })
  const b = warning({ code: 'b_warning' })
  const item = runInvariantItem('R15', evidence([a, b]), ctx(acceptance(idOf(a))))
  assert.equal(item.outcome, 'fail')
  assert.equal(item.entries!.bothDiffer!.length, 1)
  assert.equal(item.entries!.bothEqual!.length, 1)
})

test('R15 names a finding by a digest and never prints the warning id', () => {
  const token = findingToken('inventory', warning() as { code: string })
  assert.match(token, /^finding-[0-9a-f]{20}$/)
  const item = runInvariantItem('R15', evidence([warning()]), ctx())
  assert.ok(!JSON.stringify(item).includes(P) && !JSON.stringify(item).includes(W))
})

// ---- fuzz ---------------------------------------------------------------------------------------

test('fuzz: whatever shape the evidence has, the runner returns an item the report builder accepts, and never throws', () => {
  let seed = 20261020
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  const weird = [null, undefined, 'x', '', 0, -1, 1.5, Number.NaN, [], {}, true, false, '9'.repeat(40), { a: 1 }, [null]]
  const mutate = (value: unknown, depth = 0): unknown => {
    if (Array.isArray(value)) {
      const copy = value.map((v) => mutate(v, depth + 1))
      if (rand() < 0.15 && copy.length) copy.splice(Math.floor(rand() * copy.length), 1)
      return copy
    }
    if (typeof value === 'object' && value !== null) {
      const copy: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        const roll = rand()
        if (roll < 0.06) continue
        copy[k] = roll < 0.14 ? weird[Math.floor(rand() * weird.length)] : mutate(v, depth + 1)
      }
      return copy
    }
    return rand() < 0.1 ? weird[Math.floor(rand() * weird.length)] : value
  }
  const base = evidence([r3(5, 3), r4(2, 0), warning()])
  let passes = 0
  for (let n = 0; n < 1500; n += 1) {
    const ev = mutate(base)
    for (const id of BOTH) {
      let item: ItemInput | undefined
      assert.doesNotThrow(() => { item = runInvariantItem(id, ev, ctx()) })
      assertBuilds(item!)
      if (item!.outcome === 'pass') passes += 1
    }
  }
  console.log(`precondition: 1500 mutated reports x 3 items, ${passes} passes (the base report itself fails all three)`)
  assert.equal(runInvariantItem('R3', base, ctx()).outcome, 'fail')
})
