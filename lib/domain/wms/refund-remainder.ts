import { db } from '@/lib/db'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { loadNettedRefundLines } from '@/lib/domain/sales/refund-demand-netting'
import { isMirroredFeeLine } from './mirrored-fee-line'
import { raiseWmsOperatorTask, refundRemainderQuery, warehouseOrderRef, type WmsOperatorTaskInput } from './operator-tasks'

/**
 * THE UNSHIPPED REMAINDER AFTER A SHIPPED-UNITS RETURN AND REFUND (owner decision 2026-11-18, o3d-2q9vp).
 *
 * The warehouse order is pushed (create and amend) as `ordered - GROSS refunded` per line, while IMS's own demand nets only the units that physically came
 * back, up to the units that shipped (refund-demand-netting.ts). Example: ordered 10, 8 shipped, 2 of the shipped units returned and refunded. The warehouse
 * order holds 8 (all despatched); IMS still owes 2. Pushing the netted figure would ask a live warehouse for 10 with 8 already gone, so IMS does NOT change
 * the quantity: it raises ONE operator task asking the warehouse to send the remainder, and a person raises that query by hand.
 *
 * Per line:  owed       = ordered - netted refund - shipped
 *            stillSent  = max(0, (ordered - gross refund) - shipped)   what the warehouse order will still send by itself
 *            remainder  = max(0, owed - stillSent)
 *
 * A line whose shipped units cannot be counted one-for-one against the line's own product (a kit ships as components) is left alone: no guess is made.
 * Off by default (`wms_refund_remainder_task_enabled`): it raises tasks for orders that already have such refunds.
 */
export const WMS_REFUND_REMAINDER_TASK_SETTING = 'wms_refund_remainder_task_enabled'

export type RemainderLine = { id: string; sku: string | null; productId: string | null; qty: unknown; wclcFeeKind?: string | null }

export function computeRefundRemainders(input: {
  lines: ReadonlyArray<RemainderLine>
  grossRefundedByLine: ReadonlyMap<string, unknown>
  nettedRefundedByLine: ReadonlyMap<string, unknown>
  /** Units shipped per line, counted one-for-one against the line's own product. A line absent from the map is not measurable and is skipped. */
  shippedByLine: ReadonlyMap<string, unknown>
}): Array<{ sku: string; quantity: number }> {
  const zero = toDecimal(0)
  const out: Array<{ sku: string; quantity: number }> = []
  for (const line of input.lines) {
    if (!line.sku || isMirroredFeeLine(line)) continue
    if (!input.shippedByLine.has(line.id)) continue
    const ordered = toDecimal(line.qty as never)
    const gross = toDecimal((input.grossRefundedByLine.get(line.id) ?? 0) as never)
    const netted = toDecimal((input.nettedRefundedByLine.get(line.id) ?? 0) as never)
    const shipped = toDecimal(input.shippedByLine.get(line.id) as never)
    if (gross.lte(netted)) continue // nothing returned-and-shipped: the push and IMS agree
    const owed = ordered.minus(netted).minus(shipped)
    if (owed.lte(0)) continue
    const stillSent = maxOf(ordered.minus(gross).minus(shipped), zero)
    const remainder = maxOf(owed.minus(stillSent), zero)
    if (remainder.gt(0)) out.push({ sku: line.sku, quantity: remainder.toNumber() })
  }
  return out
}

function maxOf(a: Decimal, b: Decimal): Decimal {
  return a.gt(b) ? a : b
}

export type RefundRemainderDeps = {
  isEnabled(): Promise<boolean>
  candidates(connector: string, limit: number): Promise<Array<{
    orderId: string; orderNumber: string | null; externalOrderId: string; externalOrderNumber: string | null; lines: RemainderLine[]
  }>>
  refundTotals(orderId: string): Promise<{ gross: Map<string, unknown>; netted: Map<string, unknown> }>
  shipped(orderId: string, lines: ReadonlyArray<RemainderLine>): Promise<Map<string, unknown>>
  raise(task: WmsOperatorTaskInput): Promise<boolean>
}

const LIVE_STATUSES = ['PROCESSING', 'ALLOCATED', 'PICKING', 'PACKING'] as const

export const defaultRefundRemainderDeps: RefundRemainderDeps = {
  async isEnabled() {
    const row = await db.setting.findUnique({ where: { key: WMS_REFUND_REMAINDER_TASK_SETTING }, select: { value: true } })
    return row?.value === 'true'
  },
  async candidates(connector, limit) {
    const links = await db.wmsOrderPushLink.findMany({
      where: {
        connector,
        state: 'SYNCED',
        externalOrderId: { not: null },
        order: { status: { in: [...LIVE_STATUSES] }, erasedAt: null, refunds: { some: { returnWarehouseId: { not: null }, chargeback: { not: true } } } },
      },
      select: {
        externalOrderId: true, externalOrderNumber: true,
        order: { select: { id: true, orderNumber: true, lines: { select: { id: true, sku: true, productId: true, qty: true, wclcFeeKind: true } } } },
      },
      orderBy: { pushedAt: 'asc' },
      take: limit,
    })
    return links.map((link) => ({
      orderId: link.order.id,
      orderNumber: link.order.orderNumber,
      externalOrderId: link.externalOrderId as string,
      externalOrderNumber: link.externalOrderNumber,
      lines: link.order.lines,
    }))
  },
  async refundTotals(orderId) {
    const rows = await db.salesOrderRefundLine.findMany({ where: { refund: { orderId } }, select: { salesOrderLineId: true, qty: true } })
    const gross = new Map<string, unknown>()
    for (const row of rows) {
      if (!row.salesOrderLineId) continue
      gross.set(row.salesOrderLineId, toDecimal(gross.get(row.salesOrderLineId) as never ?? 0).plus(toDecimal(row.qty)))
    }
    const netted = new Map<string, unknown>()
    for (const row of await loadNettedRefundLines(db, { refund: { orderId } })) {
      if (!row.salesOrderLineId) continue
      netted.set(row.salesOrderLineId, toDecimal(netted.get(row.salesOrderLineId) as never ?? 0).plus(toDecimal(row.qty as never)))
    }
    return { gross, netted }
  },
  async shipped(orderId, lines) {
    const rows = await db.shipmentLine.findMany({ where: { lineId: { in: lines.map((l) => l.id) }, shipment: { status: 'SHIPPED' } }, select: { lineId: true, productId: true, qty: true } })
    const out = new Map<string, unknown>()
    for (const line of lines) {
      if (!line.productId) continue
      const own = rows.filter((row) => row.lineId === line.id)
      // A line whose shipped rows are all its own product is countable; a kit's component rows are not.
      if (own.some((row) => row.productId !== line.productId)) continue
      out.set(line.id, own.reduce((sum, row) => sum.plus(toDecimal(row.qty)), toDecimal(0)))
    }
    void orderId
    return out
  },
  async raise(task) {
    return raiseWmsOperatorTask(db, task)
  },
}

/**
 * Raise the remainder task for every pushed order that needs one. Returns how many NEW tasks were recorded. The task is deduplicated on the exact
 * remainder, so the same fact is one task and a changed remainder (a further return) is a new one. Never throws for one order: it is skipped and counted by the caller's log.
 */
export async function raiseRefundRemainderTasks(connector: string, limit = 50, deps: RefundRemainderDeps = defaultRefundRemainderDeps): Promise<number> {
  if (!(await deps.isEnabled())) return 0
  let raised = 0
  for (const candidate of await deps.candidates(connector, limit)) {
    try {
      const totals = await deps.refundTotals(candidate.orderId)
      const remainder = computeRefundRemainders({
        lines: candidate.lines,
        grossRefundedByLine: totals.gross,
        nettedRefundedByLine: totals.netted,
        shippedByLine: await deps.shipped(candidate.orderId, candidate.lines),
      })
      if (remainder.length === 0) continue
      const orderRef = candidate.orderNumber ?? candidate.orderId
      const created = await deps.raise({
        connector,
        orderId: candidate.orderId,
        externalOrderId: candidate.externalOrderId,
        reason: 'REFUND_REMAINDER_DUE',
        queryText: refundRemainderQuery(warehouseOrderRef(candidate.externalOrderNumber, candidate.externalOrderId), orderRef, remainder),
        payload: { orderNumber: candidate.orderNumber, externalOrderNumber: candidate.externalOrderNumber },
        dedupeBasis: `remainder:${JSON.stringify(remainder.map((line) => [line.sku, line.quantity]).sort())}`,
      })
      if (created) raised += 1
    } catch (error) {
      console.error('[wms-order-push] could not check the refund remainder of an order', candidate.orderId, error instanceof Error ? error.message : error)
    }
  }
  return raised
}
