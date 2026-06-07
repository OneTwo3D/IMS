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
import {
  runRefundStatusReconciliationReport,
  type RefundStatusReconciliationFinding,
  type RefundStatusReconciliationReport,
} from '@/lib/domain/sales/refund-status-reconciliation'
import { notify } from '@/lib/notifications'

const CRITICAL_FINDINGS_HASH_SETTING = 'cron_invariant_check_critical_findings_hash'
const DEFAULT_INVENTORY_INVARIANT_PAGE_SIZE = 500
const DEFAULT_INVENTORY_INVARIANT_MAX_FINDINGS = 5000
const DEFAULT_STOCK_MOVEMENT_LOOKBACK_DAYS = 90

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function inventoryInvariantPageSize(): number {
  return positiveIntEnv('INVARIANT_CHECK_PAGE_SIZE', DEFAULT_INVENTORY_INVARIANT_PAGE_SIZE)
}

function inventoryInvariantMaxFindings(): number {
  return positiveIntEnv('INVARIANT_CHECK_MAX_FINDINGS', DEFAULT_INVENTORY_INVARIANT_MAX_FINDINGS)
}

function stockMovementLookbackDays(): number {
  return positiveIntEnv('INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS', DEFAULT_STOCK_MOVEMENT_LOOKBACK_DAYS)
}

type InvariantDomain = 'inventory' | 'accounting' | 'sales'

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
    sales: InvariantReportSummary
  }
  errors: Array<{
    domain: InvariantDomain
    message: string
  }>
  criticalFindings: ScheduledInvariantCriticalFinding[]
  reports: {
    inventory: InventoryInvariantReport | null
    accounting: AccountingInvariantReport | null
    sales: RefundStatusReconciliationReport | null
  }
}

type ScheduledInvariantCheckDependencies = {
  createRunId?: () => string
  now?: () => Date
  runInventoryReport?: () => Promise<InventoryInvariantReport>
  runAccountingReport?: () => Promise<AccountingInvariantReport>
  runSalesReport?: () => Promise<RefundStatusReconciliationReport>
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
  domain: 'sales',
  finding: RefundStatusReconciliationFinding,
): ScheduledInvariantCriticalFinding
function toCriticalFinding(
  domain: InvariantDomain,
  finding: InventoryInvariantFinding | AccountingInvariantFinding | RefundStatusReconciliationFinding,
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
  sales: RefundStatusReconciliationReport,
): ScheduledInvariantCriticalFinding[] {
  return [
    ...inventory.findings
      .filter((finding) => finding.severity === 'critical')
      .map((finding) => toCriticalFinding('inventory', finding)),
    ...accounting.findings
      .filter((finding) => finding.severity === 'critical')
      .map((finding) => toCriticalFinding('accounting', finding)),
    ...sales.findings
      .filter((finding) => finding.severity === 'critical')
      .map((finding) => toCriticalFinding('sales', finding)),
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
  sales: RefundStatusReconciliationReport | null,
): ScheduledInvariantCheckResult['status'] {
  if (errors.length === 0) return 'completed'
  if (inventory || accounting || sales) return 'partial_failure'
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
  const runInventoryReport = dependencies.runInventoryReport ?? (() => runInventoryInvariantReport({
    collectionMode: 'sql',
    pageSize: inventoryInvariantPageSize(),
    maxFindings: inventoryInvariantMaxFindings(),
    stockMovementLookbackDays: stockMovementLookbackDays(),
  }))
  const runAccountingReport = dependencies.runAccountingReport ?? runAccountingInvariantReport
  const runSalesReport = dependencies.runSalesReport ?? runRefundStatusReconciliationReport
  const writeActivityLog = dependencies.writeActivityLog ?? logActivity
  const notifyAdmins = dependencies.notifyAdmins ?? notifyActiveAdmins
  const readCriticalFindingsHash = dependencies.getPreviousCriticalFindingsHash ?? getPreviousCriticalFindingsHash
  const writeCriticalFindingsHash = dependencies.setCriticalFindingsHash ?? setCriticalFindingsHash

  const [inventoryResult, accountingResult, salesResult] = await Promise.allSettled([
    runInventoryReport(),
    runAccountingReport(),
    runSalesReport(),
  ])
  const inventory = inventoryResult.status === 'fulfilled' ? inventoryResult.value : null
  const accounting = accountingResult.status === 'fulfilled' ? accountingResult.value : null
  const sales = salesResult.status === 'fulfilled' ? salesResult.value : null
  const errors: ScheduledInvariantCheckResult['errors'] = [
    ...(inventoryResult.status === 'rejected'
      ? [{ domain: 'inventory' as const, message: normalizeError(inventoryResult.reason) }]
      : []),
    ...(accountingResult.status === 'rejected'
      ? [{ domain: 'accounting' as const, message: normalizeError(accountingResult.reason) }]
      : []),
    ...(salesResult.status === 'rejected'
      ? [{ domain: 'sales' as const, message: normalizeError(salesResult.reason) }]
      : []),
  ]
  const inventorySummary = inventory?.summary ?? EMPTY_SUMMARY
  const accountingSummary = accounting?.summary ?? EMPTY_SUMMARY
  const salesSummary = sales?.summary ?? EMPTY_SUMMARY
  const total = addSummary(addSummary(inventorySummary, accountingSummary), salesSummary)
  const criticalFindings = criticalFindingsForReports(
    inventory ?? { checkedAt, findings: [], summary: EMPTY_SUMMARY },
    accounting ?? { checkedAt, findings: [], summary: EMPTY_SUMMARY },
    sales ?? { checkedAt, findings: [], summary: EMPTY_SUMMARY },
  )
  const status = resultStatus(errors, inventory, accounting, sales)
  const result: ScheduledInvariantCheckResult = {
    runId,
    checkedAt,
    status,
    summary: {
      total,
      inventory: inventorySummary,
      accounting: accountingSummary,
      sales: salesSummary,
    },
    errors,
    criticalFindings,
    reports: {
      inventory,
      accounting,
      sales,
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
