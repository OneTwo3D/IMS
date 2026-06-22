import { db } from '@/lib/db'
import { toJsonInputValue } from '@/lib/db/json-input'
// decimal-boundary-ok: report-only (accounting reconciliation finding details)
import { decimalToNumber, type DecimalLike } from '@/lib/decimal'
import { isMirrorableAccountingSyncType } from './accounting-event-mirror'

export type AccountingReconciliationSeverity = 'warning' | 'critical'
export type AccountingReconciliationRunStatus = 'COMPLETED' | 'FAILED' | 'PARTIAL'
export type AccountingReconciliationFindingStatus = 'OPEN' | 'RESOLVED' | 'ACCEPTED'

export type AccountingReconciliationFinding = {
  severity: AccountingReconciliationSeverity
  code: string
  orderId?: string
  shipmentId?: string
  refundId?: string
  syncLogId?: string
  accountingEventId?: string
  message: string
  details: unknown
}

export type AccountingReconciliationReport = {
  runId?: string
  checkedAt: string
  fromDate: string
  toDate: string
  persisted?: boolean
  findings: AccountingReconciliationFinding[]
  summary: {
    total: number
    warning: number
    critical: number
  }
}

type SourceOrderRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  revenueDeferredDate: Date | string | null
  inventoryAllocatedDate: Date | string | null
}

type SourceShipmentRow = {
  id: string
  orderId: string
  shipmentJournalDate: Date | string | null
}

type SourceRefundRow = {
  id: string
  orderId: string
  creditNoteNumber: string | null
  accountingCreditNoteId: string | null
  totalBase: DecimalLike
  accountingRetrySyncs: unknown
  // scjz.70: revenue-only chargeback — credit note only, no COGS/unearned reversal.
  // Optional: the Prisma select always provides it; absent is a normal refund.
  chargeback?: boolean
}

type AccountingSyncLogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  payload: unknown
}

type AccountingEventRow = {
  id: string
  type: string
  sourceEntityType: string
  sourceEntityId: string
  businessDate: Date | string
  status: string
  idempotencyKey: string
  externalSystem: string | null
  externalId: string | null
}

export type AccountingReconciliationRows = {
  salesOrders: SourceOrderRow[]
  shipments: SourceShipmentRow[]
  refunds: SourceRefundRow[]
  syncLogs: AccountingSyncLogRow[]
  accountingEvents: AccountingEventRow[]
}

type AccountingReconciliationClient = {
  salesOrder: {
    findMany(args: unknown): Promise<SourceOrderRow[]>
  }
  shipment: {
    findMany(args: unknown): Promise<SourceShipmentRow[]>
  }
  salesOrderRefund: {
    findMany(args: unknown): Promise<SourceRefundRow[]>
  }
  accountingSyncLog: {
    findMany(args: unknown): Promise<AccountingSyncLogRow[]>
  }
  accountingEvent: {
    findMany(args: unknown): Promise<AccountingEventRow[]>
  }
}

type PersistedAccountingReconciliationFinding = {
  id: string
  runId: string
  severity: string
  code: string
  entityType: string | null
  entityId: string | null
  message: string
  details: unknown
  status: string
  statusUpdatedAt: Date | string | null
  statusUpdatedBy: string | null
  createdAt: Date | string
}

type PersistedAccountingReconciliationRun = {
  id: string
  fromDate: Date | string | null
  toDate: Date | string | null
  status: string
  totalCount: number
  warningCount: number
  criticalCount: number
  createdAt: Date | string
  findings?: PersistedAccountingReconciliationFinding[]
  _count?: { findings: number }
}

type AccountingReconciliationPersistenceClient = {
  $transaction?<T>(fn: (tx: AccountingReconciliationPersistenceClient) => Promise<T>): Promise<T>
  accountingReconciliationRun: {
    create(args: unknown): Promise<PersistedAccountingReconciliationRun>
    findMany(args: unknown): Promise<PersistedAccountingReconciliationRun[]>
  }
  accountingReconciliationFinding: {
    createMany(args: unknown): Promise<{ count: number }>
    findUnique(args: unknown): Promise<PersistedAccountingReconciliationFinding | null>
    update(args: unknown): Promise<PersistedAccountingReconciliationFinding>
  }
}

export const ACCOUNTING_RECONCILIATION_FINDING_STATUSES = ['OPEN', 'RESOLVED', 'ACCEPTED'] as const
export const MAX_RECONCILIATION_LIST_RUNS = 100
export const MAX_RECONCILIATION_FINDINGS_PER_RUN = 500

export const DEFAULT_RECONCILIATION_LOOKBACK_DAYS = 90
const MAX_RECONCILIATION_ROWS = 10_000
const TERMINAL_SALES_ORDER_STATUSES = ['REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'COMPLETED', 'DELIVERED'] as const
const REFUNDED_SALES_ORDER_STATUSES = new Set(['REFUNDED', 'PARTIALLY_REFUNDED'])
// PENDING/PROCESSING are intentional evidence: reconciliation distinguishes
// "queued but not mirrored" from "no accounting path was ever scheduled".
const LIVE_SYNC_STATUSES = new Set(['PENDING', 'PROCESSING', 'SYNCED'])

// Document sync events are mirrorable, but their source checks are document-specific rather than DailyBatch source-key checks.
const SOURCE_TRACKED_EVENT_TYPES = new Set([
  'DAILY_BATCH_REVENUE_DEFERRAL',
  'DAILY_BATCH_INVENTORY_ALLOC',
  'DAILY_BATCH_GROUP_B',
  'COGS_REVERSAL',
  'UNEARNED_REV_REVERSAL',
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

function eventKey(input: {
  externalSystem?: string | null
  type: string
  sourceEntityType: string
  sourceEntityId: string
}): string {
  return [
    input.externalSystem ?? '*',
    input.type,
    input.sourceEntityType,
    input.sourceEntityId,
  ].join('|')
}

function sourceKey(type: string, sourceEntityType: string, sourceEntityId: string): string {
  return [type, sourceEntityType, sourceEntityId].join('|')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function retrySyncTypes(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((entry) => (
    isRecord(entry) && typeof entry.type === 'string' ? [entry.type] : []
  )))
}

function syncLogHasLiveEvidence(
  syncLogs: AccountingSyncLogRow[],
  params: { type: string; referenceType: string; referenceId: string },
): boolean {
  return syncLogs.some((log) => (
    log.type === params.type &&
    log.referenceType === params.referenceType &&
    log.referenceId === params.referenceId &&
    LIVE_SYNC_STATUSES.has(log.status)
  ))
}

function refundLabel(refund: SourceRefundRow): string {
  return refund.creditNoteNumber ?? refund.id
}

function orderLabel(order: SourceOrderRow): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

function hasAccountingEvent(
  accountingEvents: AccountingEventRow[],
  params: { type: string; sourceEntityType: string; sourceEntityId: string; externalSystem?: string | null },
): boolean {
  const exactKey = eventKey(params)
  if (params.externalSystem) {
    return accountingEvents.some((event) => eventKey(event) === exactKey)
  }
  const anyConnectorKey = sourceKey(params.type, params.sourceEntityType, params.sourceEntityId)
  return accountingEvents.some((event) => sourceKey(event.type, event.sourceEntityType, event.sourceEntityId) === anyConnectorKey)
}

function hasRefundCreditNoteEvidence(rows: AccountingReconciliationRows, refund: SourceRefundRow): boolean {
  // Any non-empty connector credit-note id is durable evidence. Sync writers
  // must clear this field if a remote credit note is voided or invalidated.
  if (refund.accountingCreditNoteId?.trim()) return true
  if (syncLogHasLiveEvidence(rows.syncLogs, {
    type: 'CREDIT_NOTE',
    referenceType: 'SalesOrderRefund',
    referenceId: refund.id,
  })) return true
  if (hasAccountingEvent(rows.accountingEvents, {
    type: 'CREDIT_NOTE',
    sourceEntityType: 'SalesOrderRefund',
    sourceEntityId: refund.id,
  })) return true
  return retrySyncTypes(refund.accountingRetrySyncs).has('CREDIT_NOTE')
}

function hasRefundReversalEvidence(rows: AccountingReconciliationRows, refund: SourceRefundRow): boolean {
  const retryTypes = retrySyncTypes(refund.accountingRetrySyncs)
  for (const type of REFUND_REVERSAL_TYPES) {
    if (syncLogHasLiveEvidence(rows.syncLogs, {
      type,
      referenceType: 'SalesOrderRefund',
      referenceId: refund.id,
    })) return true
    if (hasAccountingEvent(rows.accountingEvents, {
      type,
      sourceEntityType: 'SalesOrderRefund',
      sourceEntityId: refund.id,
    })) return true
    if (retryTypes.has(type)) return true
  }
  return false
}

function buildSummary(findings: AccountingReconciliationFinding[]): AccountingReconciliationReport['summary'] {
  return findings.reduce<AccountingReconciliationReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, warning: 0, critical: 0 },
  )
}

export function reconciliationLookbackDate(days: number, now: Date = new Date()): Date {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - days)
  return date
}

function findingEntity(finding: AccountingReconciliationFinding): { entityType: string | null; entityId: string | null } {
  if (finding.accountingEventId) return { entityType: 'AccountingEvent', entityId: finding.accountingEventId }
  if (finding.syncLogId) return { entityType: 'AccountingSyncLog', entityId: finding.syncLogId }
  if (finding.refundId) return { entityType: 'SalesOrderRefund', entityId: finding.refundId }
  if (finding.shipmentId) return { entityType: 'Shipment', entityId: finding.shipmentId }
  if (finding.orderId) return { entityType: 'SalesOrder', entityId: finding.orderId }
  return { entityType: null, entityId: null }
}

function normalizeFindingStatus(value: unknown): AccountingReconciliationFindingStatus | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  return ACCOUNTING_RECONCILIATION_FINDING_STATUSES.includes(normalized as AccountingReconciliationFindingStatus)
    ? normalized as AccountingReconciliationFindingStatus
    : null
}

function addExpectedSourceEventFinding(
  findings: AccountingReconciliationFinding[],
  rows: AccountingReconciliationRows,
  params: {
    code: string
    type: string
    sourceEntityType: string
    sourceEntityId: string
    message: string
    orderId?: string
    shipmentId?: string
    refundId?: string
    details: Record<string, unknown>
  },
): void {
  if (hasAccountingEvent(rows.accountingEvents, params)) return
  findings.push({
    severity: 'warning',
    code: params.code,
    orderId: params.orderId,
    shipmentId: params.shipmentId,
    refundId: params.refundId,
    message: params.message,
    details: {
      type: params.type,
      sourceEntityType: params.sourceEntityType,
      sourceEntityId: params.sourceEntityId,
      ...params.details,
    },
  })
}

function addRowCapFindings(
  findings: AccountingReconciliationFinding[],
  rows: AccountingReconciliationRows,
): void {
  const cappedDatasets: Array<{ dataset: keyof AccountingReconciliationRows; count: number }> = [
    { dataset: 'salesOrders', count: rows.salesOrders.length },
    { dataset: 'shipments', count: rows.shipments.length },
    { dataset: 'refunds', count: rows.refunds.length },
    { dataset: 'syncLogs', count: rows.syncLogs.length },
    { dataset: 'accountingEvents', count: rows.accountingEvents.length },
  ]

  for (const { dataset, count } of cappedDatasets) {
    if (count < MAX_RECONCILIATION_ROWS) continue
    findings.push({
      severity: 'warning',
      code: 'reconciliation_row_cap_reached',
      message: `Accounting reconciliation reached the ${MAX_RECONCILIATION_ROWS} row cap for ${dataset}; report may be incomplete`,
      details: {
        dataset,
        scanned: count,
        limit: MAX_RECONCILIATION_ROWS,
      },
    })
  }
}

export function evaluateAccountingReconciliationRows(
  rows: AccountingReconciliationRows,
): AccountingReconciliationFinding[] {
  const findings: AccountingReconciliationFinding[] = []
  addRowCapFindings(findings, rows)
  const sourceKeys = new Set<string>()
  const refundIds = new Set(rows.refunds.map((refund) => refund.id))
  const refundsByOrderId = new Map<string, SourceRefundRow[]>()
  for (const refund of rows.refunds) {
    const existing = refundsByOrderId.get(refund.orderId)
    if (existing) existing.push(refund)
    else refundsByOrderId.set(refund.orderId, [refund])
  }
  const postedShipmentOrderIds = new Set(
    rows.shipments
      .filter((shipment) => shipment.shipmentJournalDate != null)
      .map((shipment) => shipment.orderId),
  )

  for (const order of rows.salesOrders) {
    const label = orderLabel(order)
    const a1Date = dateKey(order.revenueDeferredDate)
    if (a1Date) {
      const sourceEntityId = `A1-${a1Date}`
      sourceKeys.add(sourceKey('DAILY_BATCH_REVENUE_DEFERRAL', 'DailyBatch', sourceEntityId))
      addExpectedSourceEventFinding(findings, rows, {
        code: 'source_order_revenue_deferral_without_event',
        type: 'DAILY_BATCH_REVENUE_DEFERRAL',
        sourceEntityType: 'DailyBatch',
        sourceEntityId,
        orderId: order.id,
        message: `Sales order ${label} has A1 revenue deferral but no mirrored accounting event`,
        details: { status: order.status, revenueDeferredDate: order.revenueDeferredDate },
      })
    }

    const a2Date = dateKey(order.inventoryAllocatedDate)
    if (a2Date) {
      const sourceEntityId = `A2-${a2Date}`
      sourceKeys.add(sourceKey('DAILY_BATCH_INVENTORY_ALLOC', 'DailyBatch', sourceEntityId))
      addExpectedSourceEventFinding(findings, rows, {
        code: 'source_order_inventory_allocation_without_event',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        sourceEntityType: 'DailyBatch',
        sourceEntityId,
        orderId: order.id,
        message: `Sales order ${label} has A2 inventory allocation but no mirrored accounting event`,
        details: { status: order.status, inventoryAllocatedDate: order.inventoryAllocatedDate },
      })
    }

    const orderRefunds = refundsByOrderId.get(order.id) ?? []
    const hasPostedAccountingState = Boolean(a1Date || a2Date || postedShipmentOrderIds.has(order.id))
    if (order.status === 'CANCELLED' && hasPostedAccountingState) {
      const hasReversalEvidence = orderRefunds.some((refund) => hasRefundReversalEvidence(rows, refund))
      if (!hasReversalEvidence) {
        findings.push({
          severity: 'critical',
          code: 'terminal_cancelled_order_missing_reversal_evidence',
          orderId: order.id,
          message: `Cancelled sales order ${label} has posted accounting state but no reversal evidence`,
          details: {
            status: order.status,
            revenueDeferredDate: order.revenueDeferredDate,
            inventoryAllocatedDate: order.inventoryAllocatedDate,
            hasPostedShipment: postedShipmentOrderIds.has(order.id),
            refundIds: orderRefunds.map((refund) => refund.id),
          },
        })
      }
    }

    if (REFUNDED_SALES_ORDER_STATUSES.has(order.status)) {
      for (const refund of orderRefunds) {
        const hasCreditNoteEvidence = hasRefundCreditNoteEvidence(rows, refund)
        const hasReversalEvidence = hasRefundReversalEvidence(rows, refund)
        if (!hasCreditNoteEvidence) {
          findings.push({
            severity: 'critical',
            code: 'terminal_refunded_order_missing_credit_note_evidence',
            orderId: order.id,
            refundId: refund.id,
            message: `Refunded sales order ${label} has refund ${refundLabel(refund)} but no credit-note evidence`,
            details: {
              status: order.status,
              creditNoteNumber: refund.creditNoteNumber,
              accountingCreditNoteId: refund.accountingCreditNoteId,
              totalBase: decimalToNumber(refund.totalBase),
            },
          })
        }

        // Zero-total refunds post no COGS/unearned-revenue reversal; only
        // positive-value refunds require reversal evidence. scjz.70: a fully-shipped
        // chargeback stages none (credit note only) so it is exempt; but a
        // partial/deferred chargeback that staged an UNEARNED_REV_REVERSAL (recorded
        // in accountingRetrySyncs) must still require that evidence.
        const stagedReversal = [...retrySyncTypes(refund.accountingRetrySyncs)].some((type) => REFUND_REVERSAL_TYPES.has(type))
        const chargebackExemptReversal = Boolean(refund.chargeback) && !stagedReversal
        if (postedShipmentOrderIds.has(order.id) && decimalToNumber(refund.totalBase) > 0 && !hasReversalEvidence && !chargebackExemptReversal) {
          findings.push({
            severity: 'critical',
            code: 'terminal_refunded_order_missing_reversal_evidence',
            orderId: order.id,
            refundId: refund.id,
            message: `Refunded sales order ${label} has refund ${refundLabel(refund)} but no reversal evidence`,
            details: {
              status: order.status,
              creditNoteNumber: refund.creditNoteNumber,
              totalBase: decimalToNumber(refund.totalBase),
              hasPostedShipment: true,
            },
          })
        }
      }
    }
  }

  for (const shipment of rows.shipments) {
    const bDate = dateKey(shipment.shipmentJournalDate)
    if (!bDate) continue
    const sourceEntityId = `B-${bDate}`
    sourceKeys.add(sourceKey('DAILY_BATCH_GROUP_B', 'DailyBatch', sourceEntityId))
    addExpectedSourceEventFinding(findings, rows, {
      code: 'source_shipment_without_event',
      type: 'DAILY_BATCH_GROUP_B',
      sourceEntityType: 'DailyBatch',
      sourceEntityId,
      orderId: shipment.orderId,
      shipmentId: shipment.id,
      message: `Shipment ${shipment.id} has Group B posting state but no mirrored accounting event`,
      details: { shipmentJournalDate: shipment.shipmentJournalDate },
    })
  }

  for (const refund of rows.refunds) {
    const expectedRefundTypes = new Set([
      ...rows.syncLogs
        .filter((log) => log.referenceType === 'SalesOrderRefund' && log.referenceId === refund.id && REFUND_REVERSAL_TYPES.has(log.type))
        .map((log) => log.type),
      ...[...retrySyncTypes(refund.accountingRetrySyncs)].filter((type) => REFUND_REVERSAL_TYPES.has(type)),
    ])

    for (const type of expectedRefundTypes) {
      sourceKeys.add(sourceKey(type, 'SalesOrderRefund', refund.id))
      addExpectedSourceEventFinding(findings, rows, {
        code: 'source_refund_without_event',
        type,
        sourceEntityType: 'SalesOrderRefund',
        sourceEntityId: refund.id,
        orderId: refund.orderId,
        refundId: refund.id,
        message: `Refund ${refundLabel(refund)} has ${type} sync evidence but no mirrored accounting event`,
        details: { creditNoteNumber: refund.creditNoteNumber },
      })
    }
  }

  for (const log of rows.syncLogs) {
    if (log.type === 'COGS_REVERSAL' && log.referenceType === 'Shipment') {
      sourceKeys.add(sourceKey(log.type, log.referenceType, log.referenceId))
    }
    if (!isMirrorableAccountingSyncType(log.type)) continue
    if (hasAccountingEvent(rows.accountingEvents, {
      externalSystem: log.connector,
      type: log.type,
      sourceEntityType: log.referenceType,
      sourceEntityId: log.referenceId,
    })) continue

    findings.push({
      severity: 'warning',
      code: 'old_sync_log_without_mirrored_event',
      syncLogId: log.id,
      message: `Accounting sync log ${log.id} has no mirrored accounting event`,
      details: {
        connector: log.connector,
        type: log.type,
        status: log.status,
        referenceType: log.referenceType,
        referenceId: log.referenceId,
      },
    })
  }

  for (const event of rows.accountingEvents) {
    if (event.status === 'POSTED' && !event.externalId?.trim()) {
      findings.push({
        severity: 'critical',
        code: 'posted_event_without_external_id',
        accountingEventId: event.id,
        message: `Posted accounting event ${event.id} has no external ID`,
        details: {
          type: event.type,
          sourceEntityType: event.sourceEntityType,
          sourceEntityId: event.sourceEntityId,
          externalSystem: event.externalSystem,
        },
      })
    }

    if (!SOURCE_TRACKED_EVENT_TYPES.has(event.type)) continue
    const key = sourceKey(event.type, event.sourceEntityType, event.sourceEntityId)
    const isKnownRefund = event.sourceEntityType === 'SalesOrderRefund' && refundIds.has(event.sourceEntityId)
    if (!sourceKeys.has(key) && !isKnownRefund) {
      findings.push({
        severity: 'warning',
        code: 'event_without_source',
        accountingEventId: event.id,
        message: `Accounting event ${event.id} has no matching source state`,
        details: {
          type: event.type,
          sourceEntityType: event.sourceEntityType,
          sourceEntityId: event.sourceEntityId,
          externalSystem: event.externalSystem,
        },
      })
    }
  }

  const eventReferences = new Map<string, string[]>()
  for (const event of rows.accountingEvents) {
    if (!event.externalSystem?.trim() || !event.externalId?.trim()) continue
    const key = `${event.externalSystem}|${event.externalId}`
    eventReferences.set(key, [...(eventReferences.get(key) ?? []), event.id])
  }
  const syncLogReferences = new Map<string, string[]>()
  for (const log of rows.syncLogs) {
    if (!log.connector.trim() || !log.externalTransactionId?.trim()) continue
    const key = `${log.connector}|${log.externalTransactionId}`
    syncLogReferences.set(key, [...(syncLogReferences.get(key) ?? []), log.id])
  }

  for (const [reference, eventIds] of eventReferences) {
    if (eventIds.length <= 1) continue
    findings.push({
      severity: 'critical',
      code: 'duplicate_external_reference',
      message: `External accounting reference ${reference} appears on ${eventIds.length} accounting events`,
      details: {
        externalReference: reference,
        accountingEventIds: eventIds,
        syncLogIds: [],
      },
    })
  }

  for (const [reference, syncLogIds] of syncLogReferences) {
    if (syncLogIds.length <= 1) continue
    findings.push({
      severity: 'critical',
      code: 'duplicate_external_reference',
      message: `External accounting reference ${reference} appears on ${syncLogIds.length} sync logs`,
      details: {
        externalReference: reference,
        accountingEventIds: [],
        syncLogIds,
      },
    })
  }

  return findings
}

export async function collectAccountingReconciliationRows(
  client: AccountingReconciliationClient = db as unknown as AccountingReconciliationClient,
  options: { lookbackDays?: number; toDate?: Date } = {},
): Promise<AccountingReconciliationRows> {
  const fromDate = reconciliationLookbackDate(
    options.lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS,
    options.toDate,
  )
  const [salesOrders, shipments, refunds, syncLogs, accountingEvents] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        OR: [
          { revenueDeferredDate: { gte: fromDate } },
          { inventoryAllocatedDate: { gte: fromDate } },
          { status: { in: [...TERMINAL_SALES_ORDER_STATUSES] }, updatedAt: { gte: fromDate } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderNumber: true,
        externalOrderNumber: true,
        status: true,
        revenueDeferredDate: true,
        inventoryAllocatedDate: true,
      },
    }),
    client.shipment.findMany({
      where: { shipmentJournalDate: { gte: fromDate } },
      orderBy: { shipmentJournalDate: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderId: true,
        shipmentJournalDate: true,
      },
    }),
    client.salesOrderRefund.findMany({
      where: {
        refundedAt: { gte: fromDate },
      },
      orderBy: { refundedAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderId: true,
        creditNoteNumber: true,
        accountingCreditNoteId: true,
        totalBase: true,
        accountingRetrySyncs: true,
        chargeback: true,
      },
    }),
    client.accountingSyncLog.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] } },
          { status: { in: ['SYNCED', 'FAILED'] }, createdAt: { gte: fromDate } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        connector: true,
        type: true,
        status: true,
        referenceType: true,
        referenceId: true,
        externalTransactionId: true,
        payload: true,
      },
    }),
    client.accountingEvent.findMany({
      where: {
        OR: [
          { businessDate: { gte: fromDate } },
          { status: { not: 'POSTED' } },
        ],
      },
      orderBy: { businessDate: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        type: true,
        sourceEntityType: true,
        sourceEntityId: true,
        businessDate: true,
        status: true,
        idempotencyKey: true,
        externalSystem: true,
        externalId: true,
      },
    }),
  ])

  return { salesOrders, shipments, refunds, syncLogs, accountingEvents }
}

export async function runAccountingReconciliationReport(options: {
  client?: AccountingReconciliationClient
  persistenceClient?: AccountingReconciliationPersistenceClient
  lookbackDays?: number
  persist?: boolean
  now?: () => Date
} = {}): Promise<AccountingReconciliationReport> {
  const checkedAt = options.now?.() ?? new Date()
  const fromDate = reconciliationLookbackDate(options.lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS, checkedAt)
  const rows = await collectAccountingReconciliationRows(
    options.client ?? (db as unknown as AccountingReconciliationClient),
    { lookbackDays: options.lookbackDays, toDate: checkedAt },
  )
  const findings = evaluateAccountingReconciliationRows(rows)

  const report: AccountingReconciliationReport = {
    checkedAt: checkedAt.toISOString(),
    fromDate: fromDate.toISOString(),
    toDate: checkedAt.toISOString(),
    findings,
    summary: buildSummary(findings),
  }

  if (!options.persist) return report
  return persistAccountingReconciliationReport(
    report,
    options.persistenceClient ?? (db as unknown as AccountingReconciliationPersistenceClient),
  )
}

export async function persistAccountingReconciliationReport(
  report: AccountingReconciliationReport,
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
): Promise<AccountingReconciliationReport> {
  const persist = async (tx: AccountingReconciliationPersistenceClient) => {
    const run = await tx.accountingReconciliationRun.create({
      data: {
        fromDate: report.fromDate ? new Date(report.fromDate) : null,
        toDate: report.toDate ? new Date(report.toDate) : null,
        status: 'COMPLETED' satisfies AccountingReconciliationRunStatus,
        totalCount: report.summary.total,
        warningCount: report.summary.warning,
        criticalCount: report.summary.critical,
      },
    })

    if (report.findings.length > 0) {
      await tx.accountingReconciliationFinding.createMany({
        data: report.findings.map((finding) => {
          const entity = findingEntity(finding)
          return {
            runId: run.id,
            severity: finding.severity,
            code: finding.code,
            entityType: entity.entityType,
            entityId: entity.entityId,
            message: finding.message,
            details: toJsonInputValue(finding.details),
            status: 'OPEN' satisfies AccountingReconciliationFindingStatus,
          }
        }),
      })
    }

    return {
      ...report,
      runId: run.id,
      persisted: true,
    }
  }

  return client.$transaction ? client.$transaction(persist) : persist(client)
}

export async function listAccountingReconciliationRuns(
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
  options: { limit?: number; includeFindings?: boolean } = {},
): Promise<PersistedAccountingReconciliationRun[]> {
  const take = Math.min(Math.max(options.limit ?? 25, 1), MAX_RECONCILIATION_LIST_RUNS)
  return client.accountingReconciliationRun.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: options.includeFindings
      ? {
          findings: {
            orderBy: { createdAt: 'asc' },
            take: MAX_RECONCILIATION_FINDINGS_PER_RUN,
          },
          _count: { select: { findings: true } },
        }
      : { _count: { select: { findings: true } } },
  })
}

export type AccountingReconciliationFindingStatusUpdate = {
  finding: PersistedAccountingReconciliationFinding
  priorStatus: AccountingReconciliationFindingStatus
}

export async function updateAccountingReconciliationFindingStatus(
  findingId: string,
  status: unknown,
  actorId?: string | null,
  client: AccountingReconciliationPersistenceClient = db as unknown as AccountingReconciliationPersistenceClient,
): Promise<AccountingReconciliationFindingStatusUpdate> {
  const normalized = normalizeFindingStatus(status)
  if (!normalized) {
    throw new Error(`Invalid accounting reconciliation finding status: ${String(status)}`)
  }

  const update = async (tx: AccountingReconciliationPersistenceClient) => {
    const prior = await tx.accountingReconciliationFinding.findUnique({
      where: { id: findingId },
    })
    if (!prior) throw new Error(`Accounting reconciliation finding not found: ${findingId}`)

    const priorStatus = normalizeFindingStatus(prior.status)
    if (!priorStatus) {
      throw new Error(`Invalid existing accounting reconciliation finding status: ${prior.status}`)
    }

    const finding = await tx.accountingReconciliationFinding.update({
      where: { id: findingId },
      data: {
        status: normalized,
        statusUpdatedAt: new Date(),
        statusUpdatedBy: actorId ?? null,
      },
    })

    return { finding, priorStatus }
  }

  return client.$transaction ? client.$transaction(update) : update(client)
}
