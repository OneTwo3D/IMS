import { db } from '@/lib/db'
// decimal-boundary-ok: report-only (accounting invariant finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'

export type AccountingInvariantSeverity = 'info' | 'warning' | 'critical'

export type AccountingInvariantFinding = {
  severity: AccountingInvariantSeverity
  code: string
  orderId?: string
  shipmentId?: string
  refundId?: string
  syncLogId?: string
  message: string
  details: unknown
}

export type AccountingInvariantReport = {
  checkedAt: string
  findings: AccountingInvariantFinding[]
  summary: {
    total: number
    info: number
    warning: number
    critical: number
  }
}

type AccountingSyncStatus = 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED'

type SalesOrderAccountingRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  // Optional so existing pure-evaluator callers/fixtures that don't supply it are
  // treated as "unknown" (the check below fires only when paidAt is explicitly
  // null — i.e. a payment reversal cleared it). The DB loader always selects it.
  paidAt?: Date | string | null
  revenueDeferredDate: Date | string | null
  unearnedRevenueAmount: DecimalLike
  inventoryAllocatedDate: Date | string | null
  allocationBatchAmount: DecimalLike
  shipments: Array<{
    id: string
    status: string
    shipmentJournalDate: Date | string | null
    revenueRecognizedAmount: DecimalLike
    cogsBatchAmount: DecimalLike
  }>
  refunds: Array<{
    id: string
    creditNoteNumber: string | null
    accountingCreditNoteId: string | null
    totalBase: DecimalLike
    accountingRetryRequired: boolean
    accountingWarning: string | null
    accountingRetrySyncs: unknown
  }>
}

type ShipmentAccountingRow = {
  id: string
  orderId: string
  status: string
  shipmentJournalDate: Date | string | null
  revenueRecognizedAmount: DecimalLike
  cogsBatchAmount: DecimalLike
  order: {
    id: string
    orderNumber: string | null
    status: string
    revenueDeferredDate: Date | string | null
    inventoryAllocatedDate: Date | string | null
  }
}

type AccountingSyncLogRow = {
  id: string
  connector: string
  type: string
  status: AccountingSyncStatus | string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
  errorMessage: string | null
  retryCount: number
  createdAt: Date | string
  syncedAt: Date | string | null
}

export type AccountingInvariantRows = {
  salesOrders: SalesOrderAccountingRow[]
  postedShipments: ShipmentAccountingRow[]
  syncLogs: AccountingSyncLogRow[]
}

type AccountingInvariantClient = {
  salesOrder: {
    findMany(args: unknown): Promise<SalesOrderAccountingRow[]>
  }
  shipment: {
    findMany(args: unknown): Promise<ShipmentAccountingRow[]>
  }
  accountingSyncLog: {
    findMany(args: unknown): Promise<AccountingSyncLogRow[]>
  }
  setting?: {
    findUnique(args: unknown): Promise<{ value: string } | null>
  }
}

const LIVE_SYNC_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED'])
const IDEMPOTENCY_REQUIRED_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'])
const DAILY_BATCH_TYPES = new Set([
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
])
const REFUND_REVERSAL_TYPES = new Set([
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
])
const DEFAULT_SYNC_LOG_RETENTION_MONTHS = 6
const TERMINAL_SALES_ORDER_STATUSES = ['REFUNDED', 'CANCELLED'] as const

function dateKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function orderLabel(order: { orderNumber: string | null; externalOrderNumber?: string | null; id: string }): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadIdempotencyKey(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  return typeof payload._idempotencyKey === 'string' && payload._idempotencyKey.trim()
    ? payload._idempotencyKey
    : null
}

function retrySyncTypes(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((entry) => (
    isRecord(entry) && typeof entry.type === 'string' ? [entry.type] : []
  )))
}

function buildSummary(findings: AccountingInvariantFinding[]): AccountingInvariantReport['summary'] {
  return findings.reduce<AccountingInvariantReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, info: 0, warning: 0, critical: 0 },
  )
}

function liveSyncLogIndexKey(type: string, referenceId: string, referenceType: string): string {
  return `${type}\u0000${referenceType}\u0000${referenceId}`
}

function buildLiveSyncLogIndex(syncLogs: AccountingSyncLogRow[]): Set<string> {
  const index = new Set<string>()
  for (const log of syncLogs) {
    if (!LIVE_SYNC_STATUSES.has(log.status)) continue
    index.add(liveSyncLogIndexKey(log.type, log.referenceId, log.referenceType))
  }
  return index
}

function hasLiveSyncLog(
  syncLogIndex: Set<string>,
  type: string,
  referenceId: string,
  referenceType?: string,
): boolean {
  if (referenceType) return syncLogIndex.has(liveSyncLogIndexKey(type, referenceId, referenceType))
  for (const key of syncLogIndex) {
    if (key.startsWith(`${type}\u0000`) && key.endsWith(`\u0000${referenceId}`)) return true
  }
  return false
}

function expectedDailyBatchReference(prefix: 'A1' | 'A2' | 'B', stagedAt: Date | string | null): string | null {
  const key = dateKey(stagedAt)
  return key ? `${prefix}-${key}` : null
}

export function evaluateAccountingInvariantRows(rows: AccountingInvariantRows): AccountingInvariantFinding[] {
  const findings: AccountingInvariantFinding[] = []
  const syncLogIndex = buildLiveSyncLogIndex(rows.syncLogs)

  for (const shipment of rows.postedShipments) {
    const expectedReferenceId = expectedDailyBatchReference('B', shipment.shipmentJournalDate)
    const hasSyncEvidence = expectedReferenceId
      ? hasLiveSyncLog(syncLogIndex, 'DAILY_BATCH_GROUP_B', expectedReferenceId, 'DailyBatch')
      : false

    if (!hasSyncEvidence) {
      findings.push({
        severity: 'warning',
        code: 'shipment_posted_without_sync_evidence',
        orderId: shipment.orderId,
        shipmentId: shipment.id,
        message: `Shipment ${shipment.id} is marked posted but has no live Group B sync evidence`,
        details: {
          shipmentStatus: shipment.status,
          shipmentJournalDate: shipment.shipmentJournalDate,
          expectedReferenceId,
          orderNumber: shipment.order.orderNumber,
        },
      })
    }

    if (decimalToNumber(shipment.revenueRecognizedAmount) <= 0) {
      findings.push({
        severity: 'critical',
        code: 'shipment_posted_missing_revenue_amount',
        orderId: shipment.orderId,
        shipmentId: shipment.id,
        message: `Shipment ${shipment.id} is marked posted with no revenue batch amount`,
        details: {
          revenueRecognizedAmount: decimalToNumber(shipment.revenueRecognizedAmount),
        },
      })
    }

    if (decimalToNumber(shipment.cogsBatchAmount) <= 0) {
      findings.push({
        severity: 'critical',
        code: 'shipment_posted_missing_cogs_amount',
        orderId: shipment.orderId,
        shipmentId: shipment.id,
        message: `Shipment ${shipment.id} is marked posted with no COGS batch amount`,
        details: {
          cogsBatchAmount: decimalToNumber(shipment.cogsBatchAmount),
        },
      })
    }
  }

  for (const log of rows.syncLogs) {
    if (!log.referenceType.trim() || !log.referenceId.trim()) {
      findings.push({
        severity: 'critical',
        code: 'accounting_sync_missing_reference',
        syncLogId: log.id,
        message: `Accounting sync log ${log.id} is missing reference metadata`,
        details: {
          connector: log.connector,
          type: log.type,
          referenceType: log.referenceType,
          referenceId: log.referenceId,
          status: log.status,
        },
      })
    }

    if (
      IDEMPOTENCY_REQUIRED_STATUSES.has(log.status) &&
      !DAILY_BATCH_TYPES.has(log.type) &&
      !payloadIdempotencyKey(log.payload)
    ) {
      findings.push({
        severity: 'warning',
        code: 'accounting_sync_missing_idempotency_key',
        syncLogId: log.id,
        message: `Accounting sync log ${log.id} has no idempotency key in its payload`,
        details: {
          connector: log.connector,
          type: log.type,
          referenceType: log.referenceType,
          referenceId: log.referenceId,
          status: log.status,
        },
      })
    }

    if (log.status === 'FAILED') {
      findings.push({
        severity: 'warning',
        code: 'accounting_sync_failed',
        syncLogId: log.id,
        message: `Accounting sync log ${log.id} is failed and requires retry or investigation`,
        details: {
          connector: log.connector,
          type: log.type,
          referenceType: log.referenceType,
          referenceId: log.referenceId,
          retryCount: log.retryCount,
          errorMessage: log.errorMessage,
        },
      })

      if (!log.errorMessage?.trim()) {
        findings.push({
          severity: 'critical',
          code: 'accounting_sync_failed_without_error',
          syncLogId: log.id,
          message: `Accounting sync log ${log.id} failed without a visible error message`,
          details: {
            connector: log.connector,
            type: log.type,
            referenceType: log.referenceType,
            referenceId: log.referenceId,
            retryCount: log.retryCount,
          },
        })
      }
    }
  }

  for (const order of rows.salesOrders) {
    const label = orderLabel(order)
    const hasA1 = order.revenueDeferredDate != null
    const hasA2 = order.inventoryAllocatedDate != null
    const postedShipments = order.shipments.filter((shipment) => shipment.shipmentJournalDate != null)

    // A1 revenue deferral is only ever staged for a paid order (the daily batch
    // selects paidAt != null), so a posted order whose paidAt is now null had its
    // payment reversed (chargeback) without a compensating credit note — recognized
    // revenue with no cash, otherwise invisible to reconciliation (scjz.42/.72).
    const hasCompensatingCreditNote = order.refunds.some(
      (refund) => refund.creditNoteNumber != null || refund.accountingCreditNoteId != null,
    )
    if ((hasA1 || hasA2 || postedShipments.length > 0) && order.paidAt === null && !hasCompensatingCreditNote) {
      findings.push({
        severity: 'critical',
        code: 'revenue_posted_without_payment',
        orderId: order.id,
        message: `Sales order ${label} has posted revenue/allocation but paidAt is cleared and no compensating credit note exists — a reversed payment left recognized revenue without cash`,
        details: {
          status: order.status,
          revenueDeferredDate: order.revenueDeferredDate,
          inventoryAllocatedDate: order.inventoryAllocatedDate,
          postedShipmentCount: postedShipments.length,
          unearnedRevenueAmount: decimalToNumber(order.unearnedRevenueAmount),
        },
      })
    }

    if (hasA1) {
      const expectedReferenceId = expectedDailyBatchReference('A1', order.revenueDeferredDate)
      const hasSyncEvidence = expectedReferenceId
        ? hasLiveSyncLog(syncLogIndex, 'DAILY_BATCH_REVENUE_DEFERRAL', expectedReferenceId, 'DailyBatch')
        : false

      if (!hasSyncEvidence) {
        findings.push({
          severity: 'warning',
          code: 'sales_order_revenue_deferral_without_sync_evidence',
          orderId: order.id,
          message: `Sales order ${label} has A1 revenue deferral but no live daily batch sync evidence`,
          details: {
            status: order.status,
            revenueDeferredDate: order.revenueDeferredDate,
            expectedReferenceId,
            unearnedRevenueAmount: decimalToNumber(order.unearnedRevenueAmount),
          },
        })
      }
    }

    if (hasA2) {
      const expectedReferenceId = expectedDailyBatchReference('A2', order.inventoryAllocatedDate)
      const hasSyncEvidence = expectedReferenceId
        ? hasLiveSyncLog(syncLogIndex, 'DAILY_BATCH_INVENTORY_ALLOC', expectedReferenceId, 'DailyBatch')
        : false

      if (!hasSyncEvidence) {
        findings.push({
          severity: 'warning',
          code: 'sales_order_inventory_allocation_without_sync_evidence',
          orderId: order.id,
          message: `Sales order ${label} has A2 inventory allocation but no live daily batch sync evidence`,
          details: {
            status: order.status,
            inventoryAllocatedDate: order.inventoryAllocatedDate,
            expectedReferenceId,
            allocationBatchAmount: decimalToNumber(order.allocationBatchAmount),
          },
        })
      }
    }

    if (hasA2 && !hasA1) {
      findings.push({
        severity: 'critical',
        code: 'sales_order_inventory_allocated_without_revenue_deferral',
        orderId: order.id,
        message: `Sales order ${label} has A2 inventory allocation without A1 revenue deferral`,
        details: {
          status: order.status,
          inventoryAllocatedDate: order.inventoryAllocatedDate,
          allocationBatchAmount: decimalToNumber(order.allocationBatchAmount),
        },
      })
    }

    if (hasA1 && decimalToNumber(order.unearnedRevenueAmount) <= 0) {
      findings.push({
        severity: 'warning',
        code: 'sales_order_revenue_deferral_missing_amount',
        orderId: order.id,
        message: `Sales order ${label} has A1 revenue deferral with no deferred amount`,
        details: {
          revenueDeferredDate: order.revenueDeferredDate,
          unearnedRevenueAmount: decimalToNumber(order.unearnedRevenueAmount),
        },
      })
    }

    if (hasA2 && decimalToNumber(order.allocationBatchAmount) <= 0) {
      findings.push({
        severity: 'warning',
        code: 'sales_order_inventory_allocation_missing_amount',
        orderId: order.id,
        message: `Sales order ${label} has A2 inventory allocation with no allocation amount`,
        details: {
          inventoryAllocatedDate: order.inventoryAllocatedDate,
          allocationBatchAmount: decimalToNumber(order.allocationBatchAmount),
        },
      })
    }

    if (hasA1 && hasA2 && new Date(order.inventoryAllocatedDate as Date | string) < new Date(order.revenueDeferredDate as Date | string)) {
      findings.push({
        severity: 'warning',
        code: 'sales_order_stage_dates_out_of_order',
        orderId: order.id,
        message: `Sales order ${label} has A2 inventory allocation before A1 revenue deferral`,
        details: {
          revenueDeferredDate: order.revenueDeferredDate,
          inventoryAllocatedDate: order.inventoryAllocatedDate,
        },
      })
    }

    for (const shipment of postedShipments) {
      if (!hasA1 || !hasA2) {
        findings.push({
          severity: 'critical',
          code: 'sales_order_shipment_posted_without_prior_stage',
          orderId: order.id,
          shipmentId: shipment.id,
          message: `Sales order ${label} has a posted shipment without prior A1/A2 staging`,
          details: {
            shipmentJournalDate: shipment.shipmentJournalDate,
            revenueDeferredDate: order.revenueDeferredDate,
            inventoryAllocatedDate: order.inventoryAllocatedDate,
          },
        })
      }
    }

    for (const refund of order.refunds) {
      const refundRetryTypes = retrySyncTypes(refund.accountingRetrySyncs)
      const hasPostedShipment = postedShipments.length > 0
      if (!hasPostedShipment) continue

      if (refund.accountingRetryRequired && (!refund.accountingWarning?.trim() || refundRetryTypes.size === 0)) {
        findings.push({
          severity: 'critical',
          code: 'refund_accounting_retry_not_visible',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.creditNoteNumber ?? refund.id} requires accounting retry but lacks visible retry details`,
          details: {
            accountingWarning: refund.accountingWarning,
            retrySyncTypes: [...refundRetryTypes],
          },
        })
      }

      const hasCreditNoteEvidence = Boolean(refund.accountingCreditNoteId) ||
        hasLiveSyncLog(syncLogIndex, 'CREDIT_NOTE', refund.id, 'SalesOrderRefund') ||
        refundRetryTypes.has('CREDIT_NOTE')
      const hasReversalEvidence = hasLiveSyncLog(syncLogIndex, 'COGS_REVERSAL', refund.id, 'SalesOrderRefund') ||
        hasLiveSyncLog(syncLogIndex, 'UNEARNED_REV_REVERSAL', refund.id, 'SalesOrderRefund') ||
        [...refundRetryTypes].some((type) => REFUND_REVERSAL_TYPES.has(type))

      if (
        refund.accountingRetryRequired &&
        refundRetryTypes.size > 0 &&
        (
          !hasCreditNoteEvidence ||
          (decimalToNumber(refund.totalBase) > 0 && !hasReversalEvidence)
        )
      ) {
        findings.push({
          severity: 'critical',
          code: 'refund_accounting_retry_incomplete',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.creditNoteNumber ?? refund.id} requires accounting retry but retry details do not cover all missing accounting actions`,
          details: {
            orderNumber: label,
            totalBase: decimalToNumber(refund.totalBase),
            retrySyncTypes: [...refundRetryTypes],
            hasCreditNoteEvidence,
            hasReversalEvidence,
          },
        })
      }

      if (!hasCreditNoteEvidence && !refund.accountingRetryRequired) {
        findings.push({
          severity: 'warning',
          code: 'refund_missing_credit_note_sync',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.creditNoteNumber ?? refund.id} is linked to posted shipments but has no credit-note sync evidence`,
          details: {
            orderNumber: label,
            postedShipmentIds: postedShipments.map((shipment) => shipment.id),
          },
        })
      }

      if (!hasReversalEvidence && !refund.accountingRetryRequired && decimalToNumber(refund.totalBase) > 0) {
        findings.push({
          severity: 'warning',
          code: 'refund_missing_reversal_sync',
          orderId: order.id,
          refundId: refund.id,
          message: `Refund ${refund.creditNoteNumber ?? refund.id} is linked to posted shipments but has no reversal sync evidence`,
          details: {
            orderNumber: label,
            totalBase: decimalToNumber(refund.totalBase),
            postedShipmentIds: postedShipments.map((shipment) => shipment.id),
          },
        })
      }
    }
  }

  return findings
}

function monthsAgo(now: Date, months: number): Date {
  const date = new Date(now)
  const targetDay = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() - months)
  const lastTargetMonthDay = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  )).getUTCDate()
  date.setUTCDate(Math.min(targetDay, lastTargetMonthDay))
  return date
}

async function resolveSyncLogRetentionMonths(
  client: AccountingInvariantClient,
  override?: number,
): Promise<number> {
  if (override !== undefined) return Math.max(0, Math.floor(override))
  if (!client.setting) return DEFAULT_SYNC_LOG_RETENTION_MONTHS
  const row = await client.setting.findUnique({
    where: { key: 'retention_sync_logs_months' },
    select: { value: true },
  }).catch(() => null)
  const parsed = Number.parseInt(row?.value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SYNC_LOG_RETENTION_MONTHS
}

export async function collectAccountingInvariantRows(
  client: AccountingInvariantClient = db as unknown as AccountingInvariantClient,
  options: { now?: Date; syncLogRetentionMonths?: number } = {},
): Promise<AccountingInvariantRows> {
  const retentionMonths = await resolveSyncLogRetentionMonths(client, options.syncLogRetentionMonths)
  const retentionCutoff = retentionMonths > 0 ? monthsAgo(options.now ?? new Date(), retentionMonths) : null
  const retainedDateFilter = retentionCutoff ? { gte: retentionCutoff } : { not: null }
  const syncLogWhere = retentionCutoff
    ? {
        createdAt: { gte: retentionCutoff },
        OR: [
          { status: 'FAILED' },
          { status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] } },
        ],
      }
    : {
        OR: [
          { status: 'FAILED' },
          { status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] } },
        ],
      }
  const [salesOrders, postedShipments, syncLogs] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        status: { notIn: [...TERMINAL_SALES_ORDER_STATUSES] },
        OR: [
          { revenueDeferredDate: retainedDateFilter },
          { inventoryAllocatedDate: retainedDateFilter },
          { shipments: { some: { shipmentJournalDate: retainedDateFilter } } },
          { refunds: { some: retentionCutoff ? { refundedAt: { gte: retentionCutoff } } : {} } },
        ],
        // NB: the revenue_posted_without_payment invariant (scjz.72) only evaluates
        // orders collected by the retention window above — i.e. recent reversed
        // payments (the common case). A chargeback on an order posted outside the
        // window is not caught here; we deliberately do NOT pull those unwindowed,
        // because the sync-log query is also windowed, so evaluating an old order
        // would emit false *_without_sync_evidence warnings for its (unloaded) old
        // batch logs. The full chargeback handling (scjz.42) creates a credit note
        // / moves the order terminal, which is the durable fix.
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        paidAt: true,
        revenueDeferredDate: true,
        unearnedRevenueAmount: true,
        inventoryAllocatedDate: true,
        allocationBatchAmount: true,
        shipments: {
          select: {
            id: true,
            status: true,
            shipmentJournalDate: true,
            revenueRecognizedAmount: true,
            cogsBatchAmount: true,
          },
        },
        refunds: {
          select: {
            id: true,
            creditNoteNumber: true,
            accountingCreditNoteId: true,
            totalBase: true,
            accountingRetryRequired: true,
            accountingWarning: true,
            accountingRetrySyncs: true,
          },
        },
      },
    }),
    client.shipment.findMany({
      where: {
        shipmentJournalDate: retainedDateFilter,
        order: { status: { notIn: [...TERMINAL_SALES_ORDER_STATUSES] } },
      },
      select: {
        id: true,
        orderId: true,
        status: true,
        shipmentJournalDate: true,
        revenueRecognizedAmount: true,
        cogsBatchAmount: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            revenueDeferredDate: true,
            inventoryAllocatedDate: true,
          },
        },
      },
    }),
    client.accountingSyncLog.findMany({
      where: syncLogWhere,
      select: {
        id: true,
        connector: true,
        type: true,
        status: true,
        referenceType: true,
        referenceId: true,
        externalTransactionId: true,
        payload: true,
        errorMessage: true,
        retryCount: true,
        createdAt: true,
        syncedAt: true,
      },
    }),
  ])

  return { salesOrders, postedShipments, syncLogs }
}

export async function runAccountingInvariantReport(options: {
  client?: AccountingInvariantClient
} = {}): Promise<AccountingInvariantReport> {
  const rows = await collectAccountingInvariantRows(
    options.client ?? (db as unknown as AccountingInvariantClient),
  )
  const findings = evaluateAccountingInvariantRows(rows)

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
