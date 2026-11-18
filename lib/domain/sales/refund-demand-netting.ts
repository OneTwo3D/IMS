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
 * The evidence is the same the external-fulfilment check uses: a restocking refund (returnWarehouseId)
 * is measured by its RETURN_INBOUND movements, a chargeback (customer keeps the goods) counts whole,
 * and a restock still owed to a retried accounting step counts whole. Anything else is a cancellation.
 */
type RefundNettingMarks = {
  returnWarehouseId?: string | null
  chargeback?: boolean | null
  accountingRetryRequired?: boolean | null
}

export type RefundLineForNetting = {
  salesOrderLineId: string | null
  productId: string | null
  qty: Prisma.Decimal | number | string
  refundId?: string
  refund?: RefundNettingMarks | null
}

type NettingClient = {
  stockMovement: { findMany: (args: never) => Promise<Array<{ referenceId: string | null; productId: string; qty: unknown }>> }
  salesOrderLine: { findMany: (args: never) => Promise<Array<{ id: string; productId: string | null; fulfillmentRequirements: unknown }>> }
}

function evidencesGoodsLeft(refund: RefundNettingMarks | null | undefined): boolean {
  return !!refund && (!!refund.returnWarehouseId || !!refund.chargeback)
}

function goodsLeftUnmeasured(refund: RefundNettingMarks): boolean {
  return !!refund.chargeback || !!refund.accountingRetryRequired
}

/**
 * Returns the same lines with `qty` reduced to the part that is a cancellation (what may net out of
 * demand). Lines without goods-left evidence are returned untouched and cost no extra query.
 */
export async function netRefundLinesForDemand<T extends RefundLineForNetting>(
  client: unknown,
  refundLines: T[],
): Promise<T[]> {
  const marked = refundLines.filter((line) => line.salesOrderLineId && line.productId && evidencesGoodsLeft(line.refund))
  if (marked.length === 0) return refundLines
  const c = client as NettingClient

  const measurableRefundIds = [...new Set(
    marked
      .filter((line) => line.refund && !goodsLeftUnmeasured(line.refund) && line.refundId)
      .map((line) => line.refundId as string),
  )]
  const movements = measurableRefundIds.length > 0
    ? await c.stockMovement.findMany({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: measurableRefundIds } },
      select: { referenceId: true, productId: true, qty: true },
    } as never)
    : []
  const budget = new Map<string, Prisma.Decimal>()
  const budgetKey = (refundId: string, productId: string) => `${refundId}|${productId}`
  for (const movement of movements) {
    const k = budgetKey(movement.referenceId ?? '', movement.productId)
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

  // Stable order, so the shared per-(refund, product) budget is drawn down reproducibly.
  const ordered = [...marked].sort((a, b) => (a.refundId ?? '').localeCompare(b.refundId ?? ''))
  const netByLine = new Map<T, Prisma.Decimal>()
  for (const line of ordered) {
    const qty = toDecimal(line.qty as never)
    const refund = line.refund as RefundNettingMarks
    if (goodsLeftUnmeasured(refund)) {
      netByLine.set(line, new Prisma.Decimal(0))
      continue
    }
    const resolvable = refundLineResolvableLine(
      { salesOrderLineId: line.salesOrderLineId as string, productId: line.productId as string },
      orderLineById as never,
    )
    const perUnit = lineFulfillmentRequirementQuantities(resolvable, 1, graph)
    let cameBackUnits = qty
    let anyRequirement = false
    for (const [componentId, factor] of perUnit) {
      if (!factor.gt(0)) continue
      anyRequirement = true
      const available = budget.get(budgetKey(line.refundId ?? '', componentId)) ?? new Prisma.Decimal(0)
      cameBackUnits = Prisma.Decimal.min(cameBackUnits, available.div(factor))
    }
    if (!anyRequirement) cameBackUnits = new Prisma.Decimal(0)
    if (cameBackUnits.lt(0)) cameBackUnits = new Prisma.Decimal(0)
    for (const [componentId, factor] of perUnit) {
      if (!factor.gt(0)) continue
      const k = budgetKey(line.refundId ?? '', componentId)
      budget.set(k, (budget.get(k) ?? new Prisma.Decimal(0)).sub(cameBackUnits.mul(factor)))
    }
    netByLine.set(line, Prisma.Decimal.max(new Prisma.Decimal(0), qty.sub(cameBackUnits)))
  }

  return refundLines.map((line) => {
    const net = netByLine.get(line)
    return net === undefined ? line : { ...line, qty: net }
  })
}
