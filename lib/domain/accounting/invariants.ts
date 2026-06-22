import { db } from '@/lib/db'
// decimal-boundary-ok: report-only (accounting invariant finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import { isFullyShippedTerminalStatus } from '@/lib/domain/accounting/revenue-recognition'
import { loadInventoryGlReconciliation } from '@/lib/domain/accounting/inventory-gl-reconciliation'

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
    // scjz.70: a revenue-only chargeback intentionally posts NO COGS/unearned
    // reversal (only the credit note), so it must be exempt from the reversal-
    // evidence requirement below. Optional: the Prisma select always provides it;
    // absent (e.g. legacy fixtures) is treated as a normal (non-chargeback) refund.
    chargeback?: boolean
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

function lineAmount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Sum the debit and credit columns of a journal payload's lines. Returns null
 * when the payload carries no journal lines (e.g. a daily-batch metadata-only
 * payload), so callers only balance-check actual journals.
 */
function journalLineTotals(payload: unknown): { debit: number; credit: number; lineCount: number } | null {
  if (!isRecord(payload) || !Array.isArray(payload.lines)) return null
  let debit = 0
  let credit = 0
  let lineCount = 0
  for (const line of payload.lines) {
    if (!isRecord(line)) continue
    debit += lineAmount(line.debit)
    credit += lineAmount(line.credit)
    lineCount += 1
  }
  if (lineCount === 0) return null
  return { debit, credit, lineCount }
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

// Live Xero daily-batch logs carry a digest-suffixed referenceId
// (buildDailyBatchReferenceId -> `<group>-<date>-<8 hex>`), while the invariant's
// expected key and QBO logs are the bare `<group>-<date>`. Strip a trailing 8-hex
// digest so a digest-suffixed log still matches the bare expected key (scjz.37).
function stripDailyBatchDigest(referenceId: string): string {
  return referenceId.replace(/-[0-9a-f]{8}$/, '')
}

const DAILY_BATCH_LOG_TYPES = new Set([
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
])

function buildLiveSyncLogIndex(syncLogs: AccountingSyncLogRow[]): Set<string> {
  const index = new Set<string>()
  for (const log of syncLogs) {
    if (!LIVE_SYNC_STATUSES.has(log.status)) continue
    index.add(liveSyncLogIndexKey(log.type, log.referenceId, log.referenceType))
    // Also index the digest-stripped key so a digest-suffixed Xero daily-batch
    // log matches the bare `<group>-<date>` the invariant expects.
    if (DAILY_BATCH_LOG_TYPES.has(log.type)) {
      const bare = stripDailyBatchDigest(log.referenceId)
      if (bare !== log.referenceId) {
        index.add(liveSyncLogIndexKey(log.type, bare, log.referenceType))
      }
    }
  }
  return index
}

// referenceType is required: an earlier version made it optional and, when
// omitted, matched a sync log of the right type+referenceId under *any*
// referenceType. That loose match could cross entity kinds (e.g. a DailyBatch
// log satisfying a SalesOrderRefund lookup that shared a referenceId), so the
// evidence check is now keyed on the full (type, referenceType, referenceId)
// triple — every call site already supplies referenceType (scjz.75).
function hasLiveSyncLog(
  syncLogIndex: Set<string>,
  type: string,
  referenceId: string,
  referenceType: string,
): boolean {
  return syncLogIndex.has(liveSyncLogIndexKey(type, referenceId, referenceType))
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

    // A posted (or to-be-posted) journal must balance: total debits == total
    // credits. The suite previously only checked that evidence existed, never the
    // amounts, so an unbalanced journal could reach the GL undetected (scjz.38).
    if (LIVE_SYNC_STATUSES.has(log.status)) {
      const totals = journalLineTotals(log.payload)
      if (totals && Math.abs(totals.debit - totals.credit) > 0.005) {
        findings.push({
          severity: 'critical',
          code: 'accounting_sync_journal_unbalanced',
          syncLogId: log.id,
          message: `Accounting sync log ${log.id} journal is unbalanced (debit ${totals.debit.toFixed(2)} != credit ${totals.credit.toFixed(2)})`,
          details: {
            connector: log.connector,
            type: log.type,
            referenceType: log.referenceType,
            referenceId: log.referenceId,
            debit: Math.round(totals.debit * 100) / 100,
            credit: Math.round(totals.credit * 100) / 100,
            lineCount: totals.lineCount,
          },
        })
      }
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

    // Lifecycle tie-out (scjz.75): once an order has fully shipped and every
    // recognizable (SHIPPED) shipment has posted its Group-B revenue, the sum of
    // the shipments' recognized revenue must equal the A1 deferred amount — the
    // terminal-status true-up exists precisely to absorb rounding so it lands
    // exactly. A divergence beyond rounding means revenue is stranded in
    // deferral or over-recognized. Refunded orders are skipped: their
    // UNEARNED_REV_REVERSAL adjusts the deferred base outside this sum, which a
    // refund-reversal-aware tie-out (scjz.68) must account for separately. The
    // `every` guard skips orders mid-recognition (a SHIPPED shipment still
    // awaiting its next daily batch), where recognized < deferred is expected.
    if (
      hasA1 &&
      isFullyShippedTerminalStatus(order.status) &&
      order.refunds.length === 0 &&
      postedShipments.length > 0 &&
      order.shipments.every((shipment) => shipment.shipmentJournalDate != null || shipment.status !== 'SHIPPED')
    ) {
      const deferred = decimalToNumber(order.unearnedRevenueAmount)
      const recognized = postedShipments.reduce(
        (sum, shipment) => sum + decimalToNumber(shipment.revenueRecognizedAmount),
        0,
      )
      if (deferred > 0 && Math.abs(recognized - deferred) > 0.01) {
        findings.push({
          severity: 'warning',
          code: 'sales_order_recognized_revenue_deferral_mismatch',
          orderId: order.id,
          message: `Sales order ${label} is fully shipped but recognized Group-B revenue (${recognized.toFixed(2)}) does not tie out to A1 deferred revenue (${deferred.toFixed(2)})`,
          details: {
            status: order.status,
            unearnedRevenueAmount: deferred,
            recognizedRevenueTotal: Math.round(recognized * 100) / 100,
            postedShipmentCount: postedShipments.length,
            difference: Math.round((recognized - deferred) * 100) / 100,
          },
        })
      }
    }

    // A1 revenue deferral is only ever staged for a paid order (the daily batch
    // selects paidAt != null), so a posted order whose paidAt is now null had its
    // payment reversed (chargeback) without a compensating credit note — recognized
    // revenue with no cash, otherwise invisible to reconciliation (scjz.42/.72).
    // Require durable accounting evidence (the external credit-note id), not the
    // locally-generated creditNoteNumber which is assigned at refund creation
    // before the credit-note sync queues — otherwise a never-synced/failed refund
    // would falsely suppress exactly the missing-accounting case this surfaces.
    const creditNotes = order.refunds.filter((refund) => refund.accountingCreditNoteId != null)
    const postedRevenue = decimalToNumber(order.unearnedRevenueAmount)
    const creditedTotal = creditNotes.reduce((sum, refund) => sum + decimalToNumber(refund.totalBase), 0)
    // A credit note only compensates the reversed payment if it covers the posted
    // revenue. A prior PARTIAL refund must NOT suppress the finding. When the posted
    // amount is unknown (<= 0) fall back to presence to avoid false positives.
    const fullyCompensated = creditNotes.length > 0
      && (postedRevenue <= 0 || creditedTotal + 0.01 >= postedRevenue)
    if ((hasA1 || hasA2 || postedShipments.length > 0) && order.paidAt === null && !fullyCompensated) {
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
      // scjz.70: accountingRetrySyncs records the staged service syncs (even on
      // success), so this tells whether the refund actually staged a COGS/unearned
      // reversal. A chargeback is exempt from the reversal-evidence requirement ONLY
      // when it staged none (fully-shipped, credit-note-only); a partial/deferred
      // chargeback that DID stage an UNEARNED_REV_REVERSAL must still require it.
      const stagedReversal = [...refundRetryTypes].some((type) => REFUND_REVERSAL_TYPES.has(type))
      const chargebackExemptReversal = Boolean(refund.chargeback) && !stagedReversal
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
          (decimalToNumber(refund.totalBase) > 0 && !hasReversalEvidence && !chargebackExemptReversal)
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

      // scjz.70: a fully-shipped chargeback stages no COGS/unearned reversal (credit
      // note only), so don't flag it; but a partial/deferred chargeback that staged
      // an UNEARNED_REV_REVERSAL is still required to have that evidence.
      if (!hasReversalEvidence && !refund.accountingRetryRequired && !chargebackExemptReversal && decimalToNumber(refund.totalBase) > 0) {
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
            chargeback: true,
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

  // scjz.74/.60c: reconcile the GL inventory balance to the 6dp cost-layer
  // subledger. Only a gap beyond the rounding-scale sweep limit is a real
  // discrepancy worth a finding; rounding-scale residue is left for the
  // rounding-difference sweep (scjz.60c-2). Degrades silently when the inventory
  // account is unmapped or no trial-balance snapshot exists yet.
  const inventoryReconciliation = await loadInventoryGlReconciliation()
  if (inventoryReconciliation.available && inventoryReconciliation.action === 'flag') {
    findings.push({
      severity: 'critical',
      code: 'inventory_gl_subledger_mismatch',
      message: `GL inventory balance (${inventoryReconciliation.glBalance.toFixed(2)}) does not reconcile to the cost-layer subledger (${inventoryReconciliation.subledgerValue.toFixed(2)}) beyond rounding tolerance`,
      details: {
        balanceDate: inventoryReconciliation.balanceDate,
        glBalance: inventoryReconciliation.glBalance,
        subledgerValue: inventoryReconciliation.subledgerValue,
        delta: inventoryReconciliation.delta,
        sweepLimit: inventoryReconciliation.sweepLimit,
      },
    })
  }

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
