import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'

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
  refundStatus: string
  totalBase: DecimalInput
  taxBase?: DecimalInput
  refunds: Array<{
    id: string
    creditNoteNumber: string | null
    totalBase: DecimalInput
    refundedAt: Date | string
    totalsBasis?: string | null
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

// Refund disposition implied by the refund records (null = no refunds = NONE).
function expectedRefundDisposition(order: RefundStatusOrderRow): 'FULL' | 'PARTIAL' | 'UNKNOWN' | null {
  if (order.refunds.length === 0) return null
  // Refund totals are stored NET (o3d-w00), so compare against the NET order total (totalBase - taxBase)
  // — the same basis createSalesOrderRefund now classifies on. A gross basis reported a fully-refunded
  // taxable order as PARTIAL and raised a false mismatch finding. But mirror createSalesOrderRefund's
  // o3d-n8p fail-safe: the net total is only sound when EVERY refund is NET-basis. If any refund is
  // legacy/unknown (NULL basis), its stored total may be GROSS and can't be summed with NET totals
  // safely — return null (unknown disposition) so this order is NOT flagged as a false mismatch, rather
  // than asserting FULL/PARTIAL against a mixed-unit sum.
  const allRefundsNet = order.refunds.every((refund) => refund.totalsBasis === 'NET')
  if (!allRefundsNet) return 'UNKNOWN'
  const netOrderTotal = toDecimal(order.totalBase).sub(toDecimal(order.taxBase ?? 0))
  const orderTotal = netOrderTotal.lt(0) ? toDecimal(0) : netOrderTotal
  const refundedTotal = order.refunds.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))

  if (orderTotal.lte(0)) {
    return refundedTotal.gte(0) ? 'FULL' : 'PARTIAL'
  }
  return isFullRefundAmount(refundedTotal, orderTotal)
    ? 'FULL'
    : 'PARTIAL'
}

export function evaluateRefundStatusReconciliationRows(
  rows: RefundStatusReconciliationRows,
): RefundStatusReconciliationFinding[] {
  const findings: RefundStatusReconciliationFinding[] = []

  if (rows.sourceRowLimitReached) {
    findings.push({
      severity: 'warning',
      code: 'refund_status_reconciliation_row_cap_reached',
      message: 'Refund status reconciliation reached the source row cap; rows are scanned by stable id order, but add pagination or narrow the daily check before trusting a clean result',
      details: {
        sourceRowLimitReached: true,
        coverage: 'bounded_to_first_sourceRowLimit_rows_by_id_asc',
      },
    })
  }

  for (const order of rows.salesOrders) {
    const expectedDisposition = expectedRefundDisposition(order)
    const label = orderLabel(order)
    const refundTotalBase = order.refunds.reduce((sum, refund) => sum.add(toDecimal(refund.totalBase)), toDecimal(0))
    const refundIds = order.refunds.map((refund) => refund.id)

    // o3d-n8p: a legacy/unknown amount-basis refund can't be reconciled to FULL/PARTIAL — skip it entirely
    // rather than raise a false mismatch or a false "no refund rows" finding (it HAS refund rows).
    if (expectedDisposition === 'UNKNOWN') continue

    if (!expectedDisposition && order.refundStatus !== 'NONE') {
      findings.push({
        severity: 'critical',
        code: 'sales_order_refund_status_without_refunds',
        orderId: order.id,
        message: `Sales order ${label} has refundStatus ${order.refundStatus} but no refund rows`,
        details: {
          status: order.status,
          refundStatus: order.refundStatus,
          totalBase: toDecimal(order.totalBase).toString(),
        },
      })
      continue
    }

    if (!expectedDisposition) continue

    if (order.refundStatus !== expectedDisposition) {
      findings.push({
        severity: 'critical',
        code: 'sales_order_refund_status_mismatch',
        orderId: order.id,
        refundId: refundIds[0],
        message: `Sales order ${label} refund total implies ${expectedDisposition} but refundStatus is ${order.refundStatus}`,
        details: {
          status: order.status,
          refundStatus: order.refundStatus,
          expectedDisposition,
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
        { refundStatus: { not: 'NONE' } },
        { refunds: { some: {} } },
      ],
    },
    orderBy: { id: 'asc' },
    take: sourceRowLimit + 1,
    select: {
      id: true,
      orderNumber: true,
      externalOrderNumber: true,
      status: true,
      refundStatus: true,
      totalBase: true,
      taxBase: true,
      refunds: {
        orderBy: { refundedAt: 'asc' },
        select: {
          id: true,
          creditNoteNumber: true,
          totalBase: true,
          refundedAt: true,
          totalsBasis: true,
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
