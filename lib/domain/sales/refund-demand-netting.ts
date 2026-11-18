import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal } from '@/lib/domain/math/decimal'
import { loadFulfillmentProductGraph } from '@/lib/products/kit-fulfillment'
import { lineFulfillmentRequirementQuantities, refundLineResolvableLine } from '@/lib/products/fulfillment-requirement-snapshot'

/**
 * Which part of a refund line is a CANCELLATION (nets out of outstanding demand) and which part is a
 * RETURN OF GOODS THAT ALREADY SHIPPED (does not).
 *
 * Every IMS demand/dispatch-cap/shortfall reader used to subtract the whole refunded quantity from
 * `ordered - shipped`. For a refund that returned already-dispatched goods that double-counts: line
 * ordered 10, 8 shipped, 2 of the shipped units returned and refunded, leaves 2 still to send; the
 * old arithmetic said 10 - 2 - 8 = 0, so the still-unshipped 2 were refused dispatch, dropped from
 * demand and the order read as complete.
 *
 * The returned portion is MEASURED, never presumed: only the RETURN_INBOUND movements that have
 * committed for a restocking refund count, and per order line the cumulative returned units are capped
 * at the units that actually SHIPPED. A chargeback (the customer keeps the goods), a refund with no
 * return warehouse and a refund whose restock is still awaiting an accounting retry (no movement yet)
 * return nothing, so their whole quantity is a cancellation. Everything above the shipped quantity is
 * a cancellation too, so a refund of unshipped or backordered units still nets demand.
 *
 * ONE computation: every reader goes through `loadNettedRefundLines`, so allocation, coverage, the
 * shipment build and the dispatch cap cannot disagree.
 */
type RefundNettingMarks = {
  returnWarehouseId?: string | null
  chargeback?: boolean | null
  accountingRetryRequired?: boolean | null
}

export type RefundLineForNetting = {
  /** The refund line's id: what a RETURN_INBOUND movement is attributed to (its idempotency key carries it). */
  id?: string
  salesOrderLineId: string | null
  productId: string | null
  qty: Prisma.Decimal | number | string
  refundId?: string
  refund?: RefundNettingMarks | null
}

type NettingClient = {
  stockMovement: { findMany: (args: never) => Promise<Array<{ referenceId: string | null; productId: string; qty: unknown; idempotencyKey?: string | null }>> }
  salesOrderLine: { findMany: (args: never) => Promise<Array<{ id: string; productId: string | null; fulfillmentRequirements: unknown }>> }
  shipmentLine: { findMany: (args: never) => Promise<Array<{ lineId: string; productId: string; qty: unknown }>> }
}

function mayHaveReturned(refund: RefundNettingMarks | null | undefined): boolean {
  return !!refund && !!refund.returnWarehouseId && !refund.chargeback
}

/**
 * Returns the same lines with `qty` reduced to the part that is a cancellation (what may net out of
 * demand). Lines of refunds that cannot have returned goods are returned untouched and cost no extra query.
 */
export async function netRefundLinesForDemand<T extends RefundLineForNetting>(
  client: unknown,
  refundLines: T[],
): Promise<T[]> {
  const marked = refundLines.filter((line) => line.salesOrderLineId && line.productId && mayHaveReturned(line.refund))
  if (marked.length === 0) return refundLines
  const c = client as NettingClient

  const measurableRefundIds = [...new Set(marked.filter((line) => line.refundId).map((line) => line.refundId as string))]
  const movements = measurableRefundIds.length > 0
    ? await c.stockMovement.findMany({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: measurableRefundIds } },
      select: { referenceId: true, productId: true, qty: true, idempotencyKey: true },
    } as never)
    : []
  // Each movement is attributed to ITS refund line (the refund service writes one per refund line and
  // component, keyed with the line id), so one line can never take another line's return. A movement whose
  // key carries no line id (legacy) falls into a per-(refund, product) pool that only unattributed lines draw on.
  const REFUND_MOVEMENT_LINE = /:line:([^:]+):warehouse:/
  const markedLineIds = new Set(marked.map((line) => line.id).filter((id): id is string => !!id))
  const budget = new Map<string, Prisma.Decimal>()
  const attributedLines = new Set<string>()
  const budgetKey = (scope: string, productId: string) => `${scope}|${productId}`
  for (const movement of movements) {
    const refundLineId = movement.idempotencyKey?.match(REFUND_MOVEMENT_LINE)?.[1]
    const attributed = !!refundLineId && markedLineIds.has(refundLineId)
    if (attributed) attributedLines.add(refundLineId as string)
    const k = attributed
      ? budgetKey(`line:${refundLineId}`, movement.productId)
      : budgetKey(`refund:${movement.referenceId ?? ''}`, movement.productId)
    budget.set(k, (budget.get(k) ?? new Prisma.Decimal(0)).add(toDecimal(movement.qty as never)))
  }

  const orderLineIds = [...new Set(marked.map((line) => line.salesOrderLineId as string))]
  const orderLines = await c.salesOrderLine.findMany({
    where: { id: { in: orderLineIds } },
    select: { id: true, productId: true, fulfillmentRequirements: true },
  } as never)
  const orderLineById = new Map(orderLines.map((line) => [line.id, line]))
  const productIds = [...new Set([
    ...orderLines.map((line) => line.productId).filter((id): id is string => !!id),
    ...marked.map((line) => line.productId as string),
  ])]
  const graph = await loadFulfillmentProductGraph(client as never, productIds)

  // Units that actually SHIPPED, per (order line, leaf product): the ceiling on what can have come back.
  const shippedRows = await c.shipmentLine.findMany({
    where: { lineId: { in: orderLineIds }, shipment: { status: 'SHIPPED' } },
    select: { lineId: true, productId: true, qty: true },
  } as never)
  const shippedByLineProduct = new Map<string, Prisma.Decimal>()
  for (const row of shippedRows) {
    const k = budgetKey(row.lineId, row.productId)
    shippedByLineProduct.set(k, (shippedByLineProduct.get(k) ?? new Prisma.Decimal(0)).add(toDecimal(row.qty as never)))
  }
  // Units of each order line already credited as "returned" by an earlier refund (the shipped cap is cumulative).
  const returnedByLine = new Map<string, Prisma.Decimal>()

  // Stable order (refund, then line id), so the cumulative shipped cap and the legacy pool are drawn down reproducibly.
  const ordered = [...marked].sort((a, b) =>
    (a.refundId ?? '').localeCompare(b.refundId ?? '') || (a.id ?? '').localeCompare(b.id ?? ''))
  const netByLine = new Map<T, Prisma.Decimal>()
  for (const line of ordered) {
    const qty = toDecimal(line.qty as never)
    const lineId = line.salesOrderLineId as string
    const resolvable = refundLineResolvableLine(
      { salesOrderLineId: lineId, productId: line.productId as string },
      orderLineById as never,
    )
    const perUnit = lineFulfillmentRequirementQuantities(resolvable, 1, graph)
    let cameBackUnits = qty
    let anyRequirement = false
    let shippedUnits: Prisma.Decimal | null = null
    const budgetScope = line.id && attributedLines.has(line.id) ? `line:${line.id}` : `refund:${line.refundId ?? ''}`
    const isKit = perUnit.size > 1 || [...perUnit.values()].some((factor) => !factor.eq(1))
    for (const [componentId, factor] of perUnit) {
      if (!factor.gt(0)) continue
      anyRequirement = true
      const available = budget.get(budgetKey(budgetScope, componentId)) ?? new Prisma.Decimal(0)
      cameBackUnits = Prisma.Decimal.min(cameBackUnits, available.div(factor))
      const shipped = (shippedByLineProduct.get(budgetKey(lineId, componentId)) ?? new Prisma.Decimal(0)).div(factor)
      shippedUnits = shippedUnits === null ? shipped : Prisma.Decimal.min(shippedUnits, shipped)
    }
    if (!anyRequirement) cameBackUnits = new Prisma.Decimal(0)
    // A kit comes back in whole kits.
    if (isKit) cameBackUnits = cameBackUnits.floor()
    // At most what actually shipped, across every refund on the line.
    const shippedRoom = (shippedUnits ?? new Prisma.Decimal(0)).sub(returnedByLine.get(lineId) ?? new Prisma.Decimal(0))
    cameBackUnits = Prisma.Decimal.min(cameBackUnits, shippedRoom)
    if (cameBackUnits.lt(0)) cameBackUnits = new Prisma.Decimal(0)
    returnedByLine.set(lineId, (returnedByLine.get(lineId) ?? new Prisma.Decimal(0)).add(cameBackUnits))
    for (const [componentId, factor] of perUnit) {
      if (!factor.gt(0)) continue
      const k = budgetKey(budgetScope, componentId)
      budget.set(k, (budget.get(k) ?? new Prisma.Decimal(0)).sub(cameBackUnits.mul(factor)))
    }
    netByLine.set(line, Prisma.Decimal.max(new Prisma.Decimal(0), qty.sub(cameBackUnits)))
  }

  return refundLines.map((line) => {
    const net = netByLine.get(line)
    return net === undefined ? line : { ...line, qty: net }
  })
}

export type NettedRefundLine = {
  id: string
  salesOrderLineId: string | null
  productId: string | null
  qty: Prisma.Decimal | number | string
  refundId: string
  refund: { orderId: string; returnWarehouseId: string | null; chargeback: boolean | null; accountingRetryRequired: boolean | null }
}

type RefundLineReader = {
  salesOrderRefundLine: { findMany: (args: never) => Promise<NettedRefundLine[]> }
}

/**
 * THE one way every demand reader (allocation, unshipped trim, coverage selector, shipment build,
 * dispatch cap) loads an order's refund lines: read them, then net the returned-shipped-goods part out
 * of the quantity that cancels demand. Sites must not call `netRefundLinesForDemand` themselves.
 */
export async function loadNettedRefundLines(client: unknown, where: unknown): Promise<NettedRefundLine[]> {
  const rows = await (client as RefundLineReader).salesOrderRefundLine.findMany({
    where,
    select: {
      id: true,
      salesOrderLineId: true,
      productId: true,
      qty: true,
      refundId: true,
      refund: { select: { orderId: true, returnWarehouseId: true, chargeback: true, accountingRetryRequired: true } },
    },
  } as never)
  return netRefundLinesForDemand(client, rows)
}
