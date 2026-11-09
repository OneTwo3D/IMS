import { createHash, randomUUID } from 'node:crypto'

import { logActivity } from '@/lib/activity-log'
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { INVARIANT_WARNING_BASELINE_LOCK_KEY } from '@/lib/db/advisory-locks'
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
const NOTIFIABLE_WARNING_COUNTS_SETTING = 'cron_invariant_check_notifiable_warning_counts'

/**
 * The WARNING-level findings an admin is told about, in addition to every critical one. Short on purpose: each is a
 * standing state that needs an operator's decision, not a drift that tidies itself, so a notification is actionable.
 *
 *  - stock_cost_layer_quantity_mismatch: on-hand above the remaining FIFO layers (unlayered stock; understates
 *    valuation and mis-costs a later consumption).
 *  - transfer_stranded_in_transit: goods dispatched and not received within the stranded window.
 *  - accounting_sync_failed: a posting that failed and is held in the backlog.
 *  - refund_missing_credit_note_sync / refund_missing_reversal_sync: refund money not yet mirrored in the ledger.
 *  - refund_reversal_record_undecidable: a refund that still owes accounting and must be decided by hand.
 *
 * Notification is on CHANGE only: a code that newly appears or whose count rises. See notifiableWarningIncreases.
 */
export const NOTIFIABLE_WARNING_CODES: readonly string[] = [
  'stock_cost_layer_quantity_mismatch',
  'transfer_stranded_in_transit',
  'accounting_sync_failed',
  'refund_missing_credit_note_sync',
  'refund_missing_reversal_sync',
  'refund_reversal_record_undecidable',
]

export type NotifiableWarningCounts = Record<string, number>

/** The findings a report appends when it stopped at its row cap: the list is then INCOMPLETE and says nothing about absence. */
export const REPORT_TRUNCATION_CODES: readonly string[] = [
  'invariant_report_truncated',
  'refund_status_reconciliation_row_cap_reached',
]

export function reportsWereTruncated(findings: ReadonlyArray<{ code: string }>): boolean {
  return findings.some((finding) => REPORT_TRUNCATION_CODES.includes(finding.code))
}

export function countNotifiableWarnings(
  findings: ReadonlyArray<{ severity: string; code: string }>,
): NotifiableWarningCounts {
  const counts: NotifiableWarningCounts = {}
  for (const finding of findings) {
    if (finding.severity !== 'warning' || !NOTIFIABLE_WARNING_CODES.includes(finding.code)) continue
    counts[finding.code] = (counts[finding.code] ?? 0) + 1
  }
  return counts
}

/** The codes whose count is above the previous run's (a code absent before counts as zero). Falling counts are not news. */
export function notifiableWarningIncreases(
  previous: NotifiableWarningCounts,
  current: NotifiableWarningCounts,
): Array<{ code: string; previous: number; current: number }> {
  return Object.entries(current)
    .filter(([code, count]) => count > (previous[code] ?? 0))
    .map(([code, count]) => ({ code, previous: previous[code] ?? 0, current: count }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

type WarningBaseline = { counts: NotifiableWarningCounts; checkedAt: string; truncated?: boolean }

function parseWarningBaseline(raw: string | null | undefined): WarningBaseline | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { counts, checkedAt, truncated } = parsed as { counts?: unknown; checkedAt?: unknown; truncated?: unknown }
    if (typeof checkedAt !== 'string' || !counts || typeof counts !== 'object' || Array.isArray(counts)) return null
    const clean: NotifiableWarningCounts = {}
    for (const [code, value] of Object.entries(counts)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) clean[code] = value
    }
    return { counts: clean, checkedAt, ...(truncated === true ? { truncated: true } : {}) }
  } catch {
    return null
  }
}

export type WarningBaselineOutcome = {
  /** False when a NEWER run's baseline was already stored: this run stood down and wrote nothing. */
  applied: boolean
  increases: Array<{ code: string; previous: number; current: number }>
}

export type WarningBaselineTx = Pick<Prisma.TransactionClient, 'setting' | 'user' | 'notification' | '$executeRaw'>

/**
 * Move the named-warning baseline AND tell the admins, in ONE transaction. The notification rows are inserted with the
 * transaction's own client (notify() swallows a failed insert and would let the baseline advance over an alert nobody
 * received); if any insert fails the whole step rolls back, the baseline stays where it was, and the next run sees the
 * same increase and tries again. A transaction-scoped advisory lock serialises the step, and the stored baseline carries
 * the START time of the run that wrote it, so an older run that finishes late stands down instead of overwriting a
 * newer baseline.
 */
export async function commitWarningBaselineInTx(
  tx: WarningBaselineTx,
  input: { counts: NotifiableWarningCounts; checkedAt: string; runId: string; truncated?: boolean },
): Promise<WarningBaselineOutcome> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVARIANT_WARNING_BASELINE_LOCK_KEY})`
  const row = await tx.setting.findUnique({ where: { key: NOTIFIABLE_WARNING_COUNTS_SETTING }, select: { value: true } })
  const baseline = parseWarningBaseline(row?.value)
  if (baseline && baseline.checkedAt > input.checkedAt) return { applied: false, increases: [] }
  // A report that stopped at its row cap lists only the first findings, so a count taken from it is a floor, not a count: a code
  // missing from it is not "cleared" and a code in it is not "newly appeared". The counts are NOT moved. Admins are told ONCE
  // that the named warnings were not evaluated (the flag below dedups it), and the next complete run compares against the
  // counts kept here.
  if (input.truncated === true) {
    const kept = baseline?.counts ?? {}
    const keptValue = JSON.stringify({ counts: kept, checkedAt: input.checkedAt, truncated: true } satisfies WarningBaseline)
    await tx.setting.upsert({
      where: { key: NOTIFIABLE_WARNING_COUNTS_SETTING },
      create: { key: NOTIFIABLE_WARNING_COUNTS_SETTING, value: keptValue },
      update: { value: keptValue },
    })
    if (baseline?.truncated !== true) {
      const admins = await tx.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
      const recipients: Array<string | null> = admins.length > 0 ? admins.map((admin) => admin.id) : [null]
      for (const userId of recipients) {
        await tx.notification.create({
          data: {
            userId,
            type: 'warning',
            title: 'Invariant report was truncated',
            message: `Scheduled invariant check ${input.runId} stopped at its row cap, so the named warnings were not evaluated this run. Fix or accept the existing findings, or raise INVARIANT_CHECK_MAX_FINDINGS.`,
            actionUrl: null,
          },
        })
      }
    }
    return { applied: true, increases: [] }
  }
  const increases = notifiableWarningIncreases(baseline?.counts ?? {}, input.counts)
  const value = JSON.stringify({ counts: input.counts, checkedAt: input.checkedAt } satisfies WarningBaseline)
  await tx.setting.upsert({
    where: { key: NOTIFIABLE_WARNING_COUNTS_SETTING },
    create: { key: NOTIFIABLE_WARNING_COUNTS_SETTING, value },
    update: { value },
  })
  if (increases.length > 0) {
    const admins = await tx.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } })
    // With no active admin the alert is a broadcast rather than nothing: the baseline is about to move over it.
    const recipients: Array<string | null> = admins.length > 0 ? admins.map((admin) => admin.id) : [null]
    const message = `Scheduled invariant check ${input.runId}: ${increases
      .map((entry) => `${entry.code} ${entry.previous} -> ${entry.current}`)
      .join(', ')}.`
    for (const userId of recipients) {
      await tx.notification.create({
        data: { userId, type: 'warning', title: 'Invariant warnings need attention', message, actionUrl: null },
      })
    }
  }
  return { applied: true, increases }
}

async function commitWarningBaseline(input: { counts: NotifiableWarningCounts; checkedAt: string; runId: string; truncated?: boolean }): Promise<WarningBaselineOutcome> {
  return db.$transaction((tx) => commitWarningBaselineInTx(tx, input))
}

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
  commitWarningBaseline?: typeof commitWarningBaseline
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
  const advanceWarningBaseline = dependencies.commitWarningBaseline ?? commitWarningBaseline

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

  // A report that failed to run says nothing about its findings, so the baseline is only moved when all three ran:
  // otherwise a failed domain would read as "cleared" and its next successful run as "newly appeared".
  if (errors.length === 0 && inventory && accounting && sales) {
    const allFindings = [...inventory.findings, ...accounting.findings, ...sales.findings]
    await advanceWarningBaseline({
      counts: countNotifiableWarnings(allFindings),
      checkedAt,
      runId,
      truncated: reportsWereTruncated(allFindings),
    })
  }

  return result
}
