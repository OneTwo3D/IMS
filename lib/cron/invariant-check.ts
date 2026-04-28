import { createHash, randomUUID } from 'node:crypto'

import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import {
  runAccountingInvariantReport,
  type AccountingInvariantFinding,
  type AccountingInvariantReport,
} from '@/lib/domain/accounting/invariants'
import {
  runInventoryInvariantReport,
  type InventoryInvariantFinding,
  type InventoryInvariantReport,
} from '@/lib/domain/inventory/invariants'
import { notify } from '@/lib/notifications'

const CRITICAL_FINDINGS_HASH_SETTING = 'cron_invariant_check_critical_findings_hash'

type InvariantDomain = 'inventory' | 'accounting'

type InvariantReportSummary = {
  total: number
  info: number
  warning: number
  critical: number
}

export type ScheduledInvariantCriticalFinding = {
  domain: InvariantDomain
  code: string
  message: string
  details: unknown
  productId?: string
  warehouseId?: string
  orderId?: string
  shipmentId?: string
  refundId?: string
  syncLogId?: string
}

export type ScheduledInvariantCheckResult = {
  runId: string
  checkedAt: string
  status: 'completed' | 'partial_failure' | 'failed'
  summary: {
    total: InvariantReportSummary
    inventory: InvariantReportSummary
    accounting: InvariantReportSummary
  }
  errors: Array<{
    domain: InvariantDomain
    message: string
  }>
  criticalFindings: ScheduledInvariantCriticalFinding[]
  reports: {
    inventory: InventoryInvariantReport | null
    accounting: AccountingInvariantReport | null
  }
}

type ScheduledInvariantCheckDependencies = {
  createRunId?: () => string
  now?: () => Date
  runInventoryReport?: () => Promise<InventoryInvariantReport>
  runAccountingReport?: () => Promise<AccountingInvariantReport>
  writeActivityLog?: typeof logActivity
  notifyAdmins?: (params: Omit<Parameters<typeof notify>[0], 'userId'>) => Promise<void>
  getPreviousCriticalFindingsHash?: () => Promise<string | null>
  setCriticalFindingsHash?: (hash: string | null) => Promise<void>
}

const EMPTY_SUMMARY: InvariantReportSummary = {
  total: 0,
  info: 0,
  warning: 0,
  critical: 0,
}

function addSummary(
  left: InvariantReportSummary,
  right: InvariantReportSummary,
): InvariantReportSummary {
  return {
    total: left.total + right.total,
    info: left.info + right.info,
    warning: left.warning + right.warning,
    critical: left.critical + right.critical,
  }
}

function toCriticalFinding(
  domain: 'inventory',
  finding: InventoryInvariantFinding,
): ScheduledInvariantCriticalFinding
function toCriticalFinding(
  domain: 'accounting',
  finding: AccountingInvariantFinding,
): ScheduledInvariantCriticalFinding
function toCriticalFinding(
  domain: InvariantDomain,
  finding: InventoryInvariantFinding | AccountingInvariantFinding,
): ScheduledInvariantCriticalFinding {
  return {
    domain,
    code: finding.code,
    message: finding.message,
    details: finding.details,
    productId: 'productId' in finding ? finding.productId : undefined,
    warehouseId: 'warehouseId' in finding ? finding.warehouseId : undefined,
    orderId: 'orderId' in finding ? finding.orderId : undefined,
    shipmentId: 'shipmentId' in finding ? finding.shipmentId : undefined,
    refundId: 'refundId' in finding ? finding.refundId : undefined,
    syncLogId: 'syncLogId' in finding ? finding.syncLogId : undefined,
  }
}

function criticalFindingsForReports(
  inventory: InventoryInvariantReport,
  accounting: AccountingInvariantReport,
): ScheduledInvariantCriticalFinding[] {
  return [
    ...inventory.findings
      .filter((finding) => finding.severity === 'critical')
      .map((finding) => toCriticalFinding('inventory', finding)),
    ...accounting.findings
      .filter((finding) => finding.severity === 'critical')
      .map((finding) => toCriticalFinding('accounting', finding)),
  ]
}

function activityLevel(summary: InvariantReportSummary): 'INFO' | 'WARNING' | 'ERROR' {
  if (summary.critical > 0) return 'ERROR'
  if (summary.warning > 0) return 'WARNING'
  return 'INFO'
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown invariant report failure'
}

function resultStatus(
  errors: ScheduledInvariantCheckResult['errors'],
  inventory: InventoryInvariantReport | null,
  accounting: AccountingInvariantReport | null,
): ScheduledInvariantCheckResult['status'] {
  if (errors.length === 0) return 'completed'
  if (inventory || accounting) return 'partial_failure'
  return 'failed'
}

function criticalFindingHashInput(finding: ScheduledInvariantCriticalFinding): Record<string, string | null> {
  return {
    domain: finding.domain,
    code: finding.code,
    productId: finding.productId ?? null,
    warehouseId: finding.warehouseId ?? null,
    orderId: finding.orderId ?? null,
    shipmentId: finding.shipmentId ?? null,
    refundId: finding.refundId ?? null,
    syncLogId: finding.syncLogId ?? null,
  }
}

export function hashCriticalFindings(findings: ScheduledInvariantCriticalFinding[]): string | null {
  if (findings.length === 0) return null

  const payload = findings
    .map((finding) => JSON.stringify(criticalFindingHashInput(finding)))
    .sort()

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function getPreviousCriticalFindingsHash(): Promise<string | null> {
  const setting = await db.setting.findUnique({
    where: { key: CRITICAL_FINDINGS_HASH_SETTING },
    select: { value: true },
  })
  return setting?.value || null
}

async function setCriticalFindingsHash(hash: string | null): Promise<void> {
  await db.setting.upsert({
    where: { key: CRITICAL_FINDINGS_HASH_SETTING },
    create: {
      key: CRITICAL_FINDINGS_HASH_SETTING,
      value: hash ?? '',
    },
    update: {
      value: hash ?? '',
    },
  })
}

async function notifyActiveAdmins(params: Omit<Parameters<typeof notify>[0], 'userId'>): Promise<void> {
  const admins = await db.user.findMany({
    where: {
      role: 'ADMIN',
      active: true,
    },
    select: { id: true },
  })

  await Promise.all(admins.map((admin) => notify({
    ...params,
    userId: admin.id,
  })))
}

export async function runScheduledInvariantCheck(
  dependencies: ScheduledInvariantCheckDependencies = {},
): Promise<ScheduledInvariantCheckResult> {
  const runId = dependencies.createRunId?.() ?? randomUUID()
  const checkedAt = (dependencies.now?.() ?? new Date()).toISOString()
  const runInventoryReport = dependencies.runInventoryReport ?? runInventoryInvariantReport
  const runAccountingReport = dependencies.runAccountingReport ?? runAccountingInvariantReport
  const writeActivityLog = dependencies.writeActivityLog ?? logActivity
  const notifyAdmins = dependencies.notifyAdmins ?? notifyActiveAdmins
  const readCriticalFindingsHash = dependencies.getPreviousCriticalFindingsHash ?? getPreviousCriticalFindingsHash
  const writeCriticalFindingsHash = dependencies.setCriticalFindingsHash ?? setCriticalFindingsHash

  const [inventoryResult, accountingResult] = await Promise.allSettled([
    runInventoryReport(),
    runAccountingReport(),
  ])
  const inventory = inventoryResult.status === 'fulfilled' ? inventoryResult.value : null
  const accounting = accountingResult.status === 'fulfilled' ? accountingResult.value : null
  const errors: ScheduledInvariantCheckResult['errors'] = [
    ...(inventoryResult.status === 'rejected'
      ? [{ domain: 'inventory' as const, message: normalizeError(inventoryResult.reason) }]
      : []),
    ...(accountingResult.status === 'rejected'
      ? [{ domain: 'accounting' as const, message: normalizeError(accountingResult.reason) }]
      : []),
  ]
  const inventorySummary = inventory?.summary ?? EMPTY_SUMMARY
  const accountingSummary = accounting?.summary ?? EMPTY_SUMMARY
  const total = addSummary(inventorySummary, accountingSummary)
  const criticalFindings = criticalFindingsForReports(
    inventory ?? { checkedAt, findings: [], summary: EMPTY_SUMMARY },
    accounting ?? { checkedAt, findings: [], summary: EMPTY_SUMMARY },
  )
  const status = resultStatus(errors, inventory, accounting)
  const result: ScheduledInvariantCheckResult = {
    runId,
    checkedAt,
    status,
    summary: {
      total,
      inventory: inventorySummary,
      accounting: accountingSummary,
    },
    errors,
    criticalFindings,
    reports: {
      inventory,
      accounting,
    },
  }

  if (total.total > 0 || errors.length > 0) {
    await writeActivityLog({
      entityType: 'SYSTEM',
      entityId: runId,
      action: 'invariant_check',
      tag: 'system',
      level: errors.length > 0 ? 'ERROR' : activityLevel(total),
      description: `Scheduled invariant check ${runId} ${status} with ${total.total} finding(s), including ${total.critical} critical finding(s)`,
      metadata: {
        runId,
        checkedAt,
        status,
        counts: result.summary,
        errors,
        criticalFindings,
      },
      resolveUser: false,
    })
  }

  if (criticalFindings.length > 0) {
    const hash = hashCriticalFindings(criticalFindings)
    const previousHash = await readCriticalFindingsHash()
    await writeCriticalFindingsHash(hash)

    if (hash !== previousHash) {
      await notifyAdmins({
        type: 'error',
        title: 'Critical invariant findings',
        message: `Scheduled invariant check ${runId} found ${criticalFindings.length} critical finding(s).`,
      })
    }
  } else {
    await writeCriticalFindingsHash(null)
  }

  return result
}
