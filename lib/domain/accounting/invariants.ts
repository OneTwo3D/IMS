import { db } from '@/lib/db'
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

function hasLiveSyncLog(
  syncLogs: AccountingSyncLogRow[],
  type: string,
  referenceId: string,
  referenceType?: string,
): boolean {
  return syncLogs.some((log) => (
    log.type === type &&
    log.referenceId === referenceId &&
    (referenceType == null || log.referenceType === referenceType) &&
    LIVE_SYNC_STATUSES.has(log.status)
  ))
}

function expectedDailyBatchReference(prefix: 'A1' | 'A2' | 'B', stagedAt: Date | string | null): string | null {
  const key = dateKey(stagedAt)
  return key ? `${prefix}-${key}` : null
}

export function evaluateAccountingInvariantRows(rows: AccountingInvariantRows): AccountingInvariantFinding[] {
  const findings: AccountingInvariantFinding[] = []

  for (const shipment of rows.postedShipments) {
    const expectedReferenceId = expectedDailyBatchReference('B', shipment.shipmentJournalDate)
    const hasSyncEvidence = expectedReferenceId
      ? hasLiveSyncLog(rows.syncLogs, 'DAILY_BATCH_GROUP_B', expectedReferenceId, 'DailyBatch')
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

    if (decimalToNumber(shipment.revenueRecognizedAmount) <= 0 && decimalToNumber(shipment.cogsBatchAmount) <= 0) {
      findings.push({
        severity: 'critical',
        code: 'shipment_posted_missing_batch_amounts',
        orderId: shipment.orderId,
        shipmentId: shipment.id,
        message: `Shipment ${shipment.id} is marked posted with no revenue or COGS batch amount`,
        details: {
          revenueRecognizedAmount: decimalToNumber(shipment.revenueRecognizedAmount),
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

    if (hasA1) {
      const expectedReferenceId = expectedDailyBatchReference('A1', order.revenueDeferredDate)
      const hasSyncEvidence = expectedReferenceId
        ? hasLiveSyncLog(rows.syncLogs, 'DAILY_BATCH_REVENUE_DEFERRAL', expectedReferenceId, 'DailyBatch')
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
        ? hasLiveSyncLog(rows.syncLogs, 'DAILY_BATCH_INVENTORY_ALLOC', expectedReferenceId, 'DailyBatch')
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
        hasLiveSyncLog(rows.syncLogs, 'CREDIT_NOTE', refund.id, 'SalesOrderRefund') ||
        refundRetryTypes.has('CREDIT_NOTE')
      const hasReversalEvidence = hasLiveSyncLog(rows.syncLogs, 'COGS_REVERSAL', refund.id, 'SalesOrderRefund') ||
        hasLiveSyncLog(rows.syncLogs, 'UNEARNED_REV_REVERSAL', refund.id, 'SalesOrderRefund') ||
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

export async function collectAccountingInvariantRows(
  client: AccountingInvariantClient = db as unknown as AccountingInvariantClient,
): Promise<AccountingInvariantRows> {
  const [salesOrders, postedShipments, syncLogs] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        OR: [
          { revenueDeferredDate: { not: null } },
          { inventoryAllocatedDate: { not: null } },
          { shipments: { some: { shipmentJournalDate: { not: null } } } },
          { refunds: { some: {} } },
        ],
      },
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
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
      where: { shipmentJournalDate: { not: null } },
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
            revenueDeferredDate: true,
            inventoryAllocatedDate: true,
          },
        },
      },
    }),
    client.accountingSyncLog.findMany({
      where: {
        OR: [
          { status: 'FAILED' },
          { status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] } },
        ],
      },
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
