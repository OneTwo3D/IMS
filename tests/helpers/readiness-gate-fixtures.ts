import { defaultItems } from '../../lib/reconciliation-pack/harness.ts'
import { PACK_ITEM_IDS, getPackItem, type PackItemId } from '../../lib/reconciliation-pack/constants.ts'
import { buildReport, type ItemInput, type ReportRecord, type StreamBracket } from '../../lib/reconciliation-pack/report.ts'
import { STEP_CATALOGUE, type RehearsalReport, type StepResult, type TeardownResult } from '../../lib/ops/first-install-rehearsal.ts'
import {
  CHECK_CATALOGUE,
  REQUIRED_CHECK_CONSTRAINTS,
  type ReadinessPhase,
} from '../../lib/ops/readiness-gate-constants.ts'
import type { ConstraintRow } from '../../lib/ops/readiness-gate-collect.ts'
import type { BuildIdentity } from '../../lib/ops/build-identity.ts'
import { APPLY_REPORT_FORMAT_VERSION, PRECONDITION_IDS } from '../../lib/first-load/apply/constants.ts'
import { VERIFICATION_IDS } from '../../lib/first-load/apply/verify-core.ts'
import {
  type AcceptanceFile,
  type CheckResult,
  type InvariantEvidence,
  type OutboundEvidence,
} from '../../lib/ops/readiness-gate.ts'

export const NOW = new Date('2026-10-08T12:00:00.000Z')
export const DAY = 24 * 60 * 60 * 1000
export const NO_ACCEPTANCES: AcceptanceFile = { status: 'absent', problems: [], entries: [] }

export const GATE_BUILD: BuildIdentity = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true, path: '/opt/ims/app' }

export const PASS: CheckResult = { kind: 'pass', summary: 'ok' }

/** Every catalogue check passing: the one fixture a GO can be built from. */
export function allPassing(): Record<string, CheckResult> {
  return Object.fromEntries(CHECK_CATALOGUE.map((definition) => [definition.id, PASS]))
}

/** The shape a real run has on this tree: fixed checks pass, R3/R4/R15 derive, every other pack item is not available. */
export function realisticResults(): Record<string, CheckResult> {
  const results = allPassing()
  for (const definition of CHECK_CATALOGUE) {
    if (definition.id.startsWith('pack-') && !['pack-R3', 'pack-R4', 'pack-R15'].includes(definition.id)) {
      results[definition.id] = { kind: 'not-available', reason: 'no runner' }
    }
  }
  results['read-sync-liveness'] = { kind: 'not-available', reason: 'no status script' }
  return results
}

export function cleanOutbound(overrides: Partial<OutboundEvidence> = {}): OutboundEvidence {
  return {
    connectors: [
      { connector: 'woocommerce', state: 'held' },
      { connector: 'mintsoft', state: 'held' },
      { connector: 'xero', state: 'held' },
    ],
    anyGranted: false,
    anyUnreadable: false,
    countsAvailable: true,
    ...overrides,
  }
}

type Finding = { severity: string; code: string; productId?: string; warehouseId?: string; orderId?: string; message?: string }

export function cleanInvariant(overrides: { inventory?: Finding[]; accounting?: Finding[]; sales?: Finding[]; truncated?: boolean; ok?: boolean; status?: string; errors?: unknown[]; criticalFindings?: unknown[]; nullReport?: 'inventory' | 'accounting' | 'sales' } = {}): InvariantEvidence {
  const report = (findings: Finding[], truncated = false) => ({
    findings,
    truncated,
    summary: {
      total: findings.length,
      info: findings.filter((f) => f.severity === 'info').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      critical: findings.filter((f) => f.severity === 'critical').length,
    },
  })
  const inventory = report(overrides.inventory ?? [], overrides.truncated)
  const accounting = report(overrides.accounting ?? [])
  const sales = report(overrides.sales ?? [])
  const all = [...inventory.findings, ...accounting.findings, ...sales.findings]
  return {
    ok: overrides.ok ?? true,
    result: {
      status: overrides.status ?? 'completed',
      errors: overrides.errors ?? [],
      criticalFindings: overrides.criticalFindings ?? all.filter((f) => f.severity === 'critical'),
      summary: { total: { critical: all.filter((f) => f.severity === 'critical').length, warning: all.filter((f) => f.severity === 'warning').length } },
      reports: {
        inventory: overrides.nullReport === 'inventory' ? null : inventory,
        accounting: overrides.nullReport === 'accounting' ? null : accounting,
        sales: overrides.nullReport === 'sales' ? null : sales,
      },
    },
  }
}

export function greenSteps(): StepResult[] {
  return STEP_CATALOGUE.map((definition) => ({ id: definition.id, item: definition.item, title: definition.title, required: true, status: 'passed' as const, detail: {}, durationMs: 1 }))
}

export function cleanTeardown(): TeardownResult {
  return { clusterStopped: true, postmasterPid: 1, envFileShredded: true, rootRemoved: true, orphanPids: [], errors: [] }
}

export function greenRehearsal(overrides: Partial<RehearsalReport> = {}): RehearsalReport {
  const finished = new Date(NOW.getTime() - 2 * DAY)
  return {
    schemaVersion: 2,
    tool: 'rehearse-first-install',
    build: { ...GATE_BUILD },
    runId: 'run-1',
    verdict: 'GREEN',
    exitCode: 0,
    startedAt: new Date(finished.getTime() - 60_000).toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: 60_000,
    host: { node: 'v22', postgresServer: '17' },
    cluster: { root: '/x', port: 1, role: 'r', scramVerified: true, systemIdentifier: '1', sourceDatabase: 'a', restoreDatabase: 'b' },
    steps: greenSteps(),
    teardown: cleanTeardown(),
    notes: [],
    interrupted: null,
    ...overrides,
  }
}

export function validAcceptance(warningId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    warningId,
    acceptedBy: 'Jan Operator',
    acceptedAt: new Date(NOW.getTime() - DAY).toISOString(),
    reason: 'Reviewed the finding; the stock rows belong to a discontinued SKU.',
    expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    phases: ['P0', 'P1', 'P2'],
    ...overrides,
  }
}

export function acceptanceText(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ schemaVersion: 1, acceptances: entries })
}

export const PHASES: ReadinessPhase[] = ['P0', 'P1', 'P2']

/** How PostgreSQL 17 renders each required constraint (captured with pg_get_constraintdef on a migrated database). */
export const PG_RENDERED: Record<string, string> = {
  stock_levels_quantity_nonnegative: 'CHECK ((quantity >= (0)::numeric))',
  stock_levels_reserved_nonnegative: 'CHECK (("reservedQty" >= (0)::numeric))',
  stock_levels_reserved_qty_lte_quantity: 'CHECK (("reservedQty" <= quantity))',
  cost_layers_received_nonnegative: 'CHECK (("receivedQty" >= (0)::numeric))',
  cost_layers_remaining_qty_non_negative: 'CHECK (("remainingQty" >= (0)::numeric))',
  cost_layers_remaining_qty_lte_received_qty: 'CHECK (("remainingQty" <= "receivedQty"))',
  stock_movements_qty_nonnegative: 'CHECK ((qty >= (0)::numeric))',
}

export function constraintRows(): ConstraintRow[] {
  return REQUIRED_CHECK_CONSTRAINTS.map((entry) => ({ schema: 'public', table: entry.table, name: entry.name, validated: true, definition: PG_RENDERED[entry.name]!, currentSchema: 'public' }))
}
export const ALL_CONSTRAINTS = async (): Promise<ConstraintRow[]> => constraintRows()


// ---------------------------------------------------------------------------------------------
// The first load: the database's run record and the published apply report that names it.
// ---------------------------------------------------------------------------------------------

export const APPLY_SYSTEM_ID = '7400000000000000001'
export const APPLY_RUN = { runId: 'qoblex-load-1', manifestDigest: 'd'.repeat(64), status: 'VERIFIED' }

/** A published apply report as scripts/first-load-apply.ts writes it (format version 2) for APPLY_RUN, made on APPLY_SYSTEM_ID two days before NOW. */
export function greenApplyReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'first-load-apply',
    formatVersion: APPLY_REPORT_FORMAT_VERSION,
    runId: APPLY_RUN.runId,
    manifestDigest: APPLY_RUN.manifestDigest,
    mode: 'apply',
    exit: { code: 0, name: 'OK', operatorText: '' },
    target: { database: 'ims', systemId: APPLY_SYSTEM_ID, migrations: 10 },
    restorePoint: { path: '/var/tmp/restore/first-load-qoblex-load-1.dump', sha256: 'c'.repeat(64), bytes: 1234, listed: true },
    preconditions: PRECONDITION_IDS.map((id) => ({ id, result: id === 'rail:fx-rates' || id === 'rail:tax-rates' || id === 'rail:warehouses' || id === 'rail:forbidden-skus' || id === 'rail:currency-lock' || id.startsWith('check:transfer') ? 'not-applicable' : 'pass', detail: 'x' })),
    steps: [
      { step: 'suppliers', status: 'DONE', emitted: 3, created: 3, updated: 0, skippedExisting: 0, failed: 0 },
      { step: 'products', status: 'DONE', emitted: 5, created: 4, updated: 0, skippedExisting: 1, failed: 0 },
    ],
    accountingBalanced: true,
    verification: VERIFICATION_IDS.map((id) => ({ id, result: 'pass', expected: 'x', actual: 'x' })),
    problems: [],
    window: { start: new Date(NOW.getTime() - 2 * DAY - 60_000).toISOString(), end: new Date(NOW.getTime() - 2 * DAY).toISOString() },
    ...overrides,
  }
}

export function applyEvidence(over: Partial<import('../../lib/ops/readiness-gate.ts').ApplyEvidence> = {}): import('../../lib/ops/readiness-gate.ts').ApplyEvidence {
  return { systemId: APPLY_SYSTEM_ID, runs: [{ ...APPLY_RUN }], reports: [{ parsed: greenApplyReport(), markdownDigestOk: true }], unparseable: 0, ...over }
}

// ---- the reconciliation pack's newest report -------------------------------------------------------

/** A pass the report builder accepts: the catalogue's sources and a named proof. */
export function packPass(id: PackItemId): ItemInput {
  return { id, outcome: 'pass', reasons: [], proof: { kind: 'proven-empty', source: 'snapshot-run-row-present' }, sources: [...getPackItem(id).sources] }
}
const PACK_STAMP = '2026-10-07T03:00:00.000Z'
export const packStreams = (): StreamBracket[] => (['woocommerce-order-sweep', 'mintsoft-stock-sync', 'mintsoft-dispatch-poll', 'mintsoft-order-status', 'xero-balance-snapshots', 'xero-tax-rates'] as const).map((stream) => ({ stream, start: PACK_STAMP, end: PACK_STAMP }))

/**
 * A pack report record as the publisher would have written it (built by the real builder), for the installation APPLY_SYSTEM_ID, one hour
 * before NOW. R3, R4 and R15 pass unless `items` says otherwise; at P1 and P2 the other items the phase applies are NO_RUNNER.
 */
export function packRecord(phase: ReadinessPhase = 'P0', over: { finishedAt?: Date; systemIdentifier?: string; items?: Partial<Record<PackItemId, ItemInput>>; sequence?: number; asOf?: string } = {}): ReportRecord {
  const finished = (over.finishedAt ?? new Date(NOW.getTime() - 3600_000)).toISOString()
  const items = defaultItems(phase, { R3: packPass('R3'), R4: packPass('R4'), R15: packPass('R15'), ...over.items })
  const needsStreams = items.some((item) => getPackItem(item.id).streams.length > 0 && item.outcome === 'pass')
  return buildReport({
    runId: '20261008T100000Z-aaaaaaaaaaaa', systemIdentifier: over.systemIdentifier ?? APPLY_SYSTEM_ID, phase, asOf: over.asOf ?? '2026-10-07', startedAt: finished, finishedAt: finished,
    streams: needsStreams ? packStreams() : [], items,
  }, over.sequence ?? 1, null).record
}
export { PACK_ITEM_IDS }
