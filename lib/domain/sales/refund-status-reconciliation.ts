import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type RefundStatusReconciliationSeverity = 'info' | 'warning' | 'critical'

export type RefundStatusReconciliationFinding = {
  severity: RefundStatusReconciliationSeverity
  code: string
  orderId?: string
  refundId?: string
  message: string
  details: unknown
}

export type RefundStatusReconciliationReport = {
  checkedAt: string
  findings: RefundStatusReconciliationFinding[]
  summary: {
    total: number
    info: number
    warning: number
    critical: number
  }
}

export type RefundStatusOrderRow = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
  totalBase: DecimalInput
  refunds: Array<{
    id: string
    creditNoteNumber: string | null
    totalBase: DecimalInput
    refundedAt: Date | string
  }>
}

export type RefundStatusReconciliationClient = {
  salesOrder: {
    findMany(args: unknown): Promise<RefundStatusOrderRow[]>
  }
}

export type RefundStatusReconciliationRows = {
  salesOrders: RefundStatusOrderRow[]
  sourceRowLimitReached: boolean
}

const REFUNDED_STATUSES = new Set(['REFUNDED', 'PARTIALLY_REFUNDED'])
const FULL_REFUND_RATIO = toDecimal('0.999')
const DEFAULT_SOURCE_ROW_LIMIT = 5000

function orderLabel(order: Pick<RefundStatusOrderRow, 'id' | 'orderNumber' | 'externalOrderNumber'>): string {
  return order.orderNumber ?? order.externalOrderNumber ?? order.id
}

function buildSummary(findings: RefundStatusReconciliationFinding[]): RefundStatusReconciliationReport['summary'] {
  return findings.reduce<RefundStatusReconciliationReport['summary']>(
    (summary, finding) => {
      summary.total += 1
      summary[finding.severity] += 1
      return summary
    },
    { total: 0, info: 0, warning: 0, critical: 0 },
  )
}

function expectedRefundStatus(order: RefundStatusOrderRow): 'REFUNDED' | 'PARTIALLY_REFUNDED' | null {
  if (order.refunds.length === 0) return null
  const orderTotal = toDecimal(order.totalBase)
  const refundedTotal = order.refunds.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))

  if (orderTotal.lte(0)) {
    return refundedTotal.gte(0) ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  }
  return refundedTotal.gte(orderTotal.mul(FULL_REFUND_RATIO))
    ? 'REFUNDED'
    : 'PARTIALLY_REFUNDED'
}

export function evaluateRefundStatusReconciliationRows(
  rows: RefundStatusReconciliationRows,
): RefundStatusReconciliationFinding[] {
  const findings: RefundStatusReconciliationFinding[] = []

  if (rows.sourceRowLimitReached) {
    findings.push({
      severity: 'warning',
      code: 'refund_status_reconciliation_row_cap_reached',
      message: 'Refund status reconciliation reached the source row cap; narrow or paginate the daily check before trusting a clean result',
      details: {
        sourceRowLimitReached: true,
      },
    })
  }

  for (const order of rows.salesOrders) {
    const expectedStatus = expectedRefundStatus(order)
    const label = orderLabel(order)
    const refundTotalBase = order.refunds.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))
    const refundIds = order.refunds.map((refund) => refund.id)

    if (!expectedStatus && REFUNDED_STATUSES.has(order.status)) {
      findings.push({
        severity: 'critical',
        code: 'sales_order_refund_status_without_refunds',
        orderId: order.id,
        message: `Sales order ${label} is marked ${order.status} but has no refund rows`,
        details: {
          status: order.status,
          totalBase: toDecimal(order.totalBase).toString(),
        },
      })
      continue
    }

    if (!expectedStatus) continue

    if (order.status !== expectedStatus) {
      findings.push({
        severity: 'critical',
        code: 'sales_order_refund_status_mismatch',
        orderId: order.id,
        refundId: refundIds[0],
        message: `Sales order ${label} refund total implies ${expectedStatus} but status is ${order.status}`,
        details: {
          status: order.status,
          expectedStatus,
          totalBase: toDecimal(order.totalBase).toString(),
          refundedTotalBase: refundTotalBase.toString(),
          refundIds,
          creditNoteNumbers: order.refunds.map((refund) => refund.creditNoteNumber).filter(Boolean),
        },
      })
    }
  }

  return findings
}

export async function collectRefundStatusReconciliationRows(
  client: RefundStatusReconciliationClient = db as unknown as RefundStatusReconciliationClient,
  options: { sourceRowLimit?: number } = {},
): Promise<RefundStatusReconciliationRows> {
  const sourceRowLimit = Math.max(1, Math.floor(options.sourceRowLimit ?? DEFAULT_SOURCE_ROW_LIMIT))
  const rows = await client.salesOrder.findMany({
    where: {
      OR: [
        { status: { in: [...REFUNDED_STATUSES] } },
        { refunds: { some: {} } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: sourceRowLimit + 1,
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      totalBase: true,
      refunds: {
        orderBy: { refundedAt: 'asc' },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          refundedAt: true,
        },
      },
    },
  })

  return {
    salesOrders: rows.slice(0, sourceRowLimit),
    sourceRowLimitReached: rows.length > sourceRowLimit,
  }
}

export async function runRefundStatusReconciliationReport(options: {
  client?: RefundStatusReconciliationClient
  sourceRowLimit?: number
} = {}): Promise<RefundStatusReconciliationReport> {
  const rows = await collectRefundStatusReconciliationRows(
    options.client ?? (db as unknown as RefundStatusReconciliationClient),
    { sourceRowLimit: options.sourceRowLimit },
  )
  const findings = evaluateRefundStatusReconciliationRows(rows)

  return {
    checkedAt: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
  }
}
