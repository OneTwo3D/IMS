import { STEP_CATALOGUE, type RehearsalReport, type StepResult, type TeardownResult } from '../../lib/ops/first-install-rehearsal.ts'
import {
  CHECK_CATALOGUE,
  REQUIRED_CHECK_CONSTRAINTS,
  type ReadinessPhase,
} from '../../lib/ops/readiness-gate-constants.ts'
import type { BuildIdentity } from '../../lib/ops/build-identity.ts'
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

export const ALL_CONSTRAINTS = async (): Promise<string[]> => [...REQUIRED_CHECK_CONSTRAINTS]
