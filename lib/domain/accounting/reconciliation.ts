import { db } from '@/lib/db'

export type AccountingReconciliationSeverity = 'warning' | 'critical'

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
  checkedAt: string
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
  accountingRetrySyncs: unknown
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

const DEFAULT_RECONCILIATION_LOOKBACK_DAYS = 90
const MAX_RECONCILIATION_ROWS = 10_000
const TERMINAL_SALES_ORDER_STATUSES = ['REFUNDED', 'CANCELLED'] as const

const MIRRORED_SYNC_TYPES = new Set([
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

function lookbackDate(days: number): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date
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

export function evaluateAccountingReconciliationRows(
  rows: AccountingReconciliationRows,
): AccountingReconciliationFinding[] {
  const findings: AccountingReconciliationFinding[] = []
  const sourceKeys = new Set<string>()
  const refundIds = new Set(rows.refunds.map((refund) => refund.id))

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
    if (!MIRRORED_SYNC_TYPES.has(log.type)) continue
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

    if (!MIRRORED_SYNC_TYPES.has(event.type)) continue
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
  options: { lookbackDays?: number } = {},
): Promise<AccountingReconciliationRows> {
  const fromDate = lookbackDate(options.lookbackDays ?? DEFAULT_RECONCILIATION_LOOKBACK_DAYS)
  const [salesOrders, shipments, refunds, syncLogs, accountingEvents] = await Promise.all([
    client.salesOrder.findMany({
      where: {
        status: { notIn: [...TERMINAL_SALES_ORDER_STATUSES] },
        OR: [
          { revenueDeferredDate: { not: null } },
          { inventoryAllocatedDate: { not: null } },
        ],
      },
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
      where: { shipmentJournalDate: { not: null } },
      select: {
        id: true,
        orderId: true,
        shipmentJournalDate: true,
      },
    }),
    client.salesOrderRefund.findMany({
      where: {
        refundedAt: { gte: fromDate },
        order: { status: { notIn: [...TERMINAL_SALES_ORDER_STATUSES] } },
      },
      orderBy: { refundedAt: 'desc' },
      take: MAX_RECONCILIATION_ROWS,
      select: {
        id: true,
        orderId: true,
        creditNoteNumber: true,
        accountingRetrySyncs: true,
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
  lookbackDays?: number
} = {}): Promise<AccountingReconciliationReport> {
  const rows = await collectAccountingReconciliationRows(
    options.client ?? (db as unknown as AccountingReconciliationClient),
    { lookbackDays: options.lookbackDays },
  )
  const findings = evaluateAccountingReconciliationRows(rows)

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
