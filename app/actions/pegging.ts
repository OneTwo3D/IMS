'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { Prisma } from '@/app/generated/prisma/client'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { logActivityInTransaction } from '@/lib/activity-log'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { loadPurchaseOrderLineLandedQty } from '@/lib/domain/inventory/po-line-landed-quantity'
import {
  PEGGABLE_PURCHASE_ORDER_STATUSES, PEG_OPEN_ORDER_STATUSES, decidePeg, endPegInTx, loadLineAllocations, loadLivePegs,
  lockPegsForProducts, refreshPegReceipts, settlePegs,
} from '@/lib/domain/sales/peg-service'

/**
 * SO-to-PO pegging: the operator-facing reads and writes. IMS-internal allocation ordering only; nothing here reaches a connector.
 * Writing a peg takes the same permission as allocating by hand (sales.process): it decides which order gets stock.
 */

const ZERO = new Prisma.Decimal(0)

export type PegCandidate = {
  purchaseOrderLineId: string
  poId: string
  poReference: string
  supplierName: string | null
  status: string
  expectedDelivery: string | null
  lineQty: number
  landedQty: number
  /** Unreceived and not already pegged by another order: the most that can be pegged to this line. */
  available: number
}

export type SalesOrderPegRow = {
  id: string
  salesOrderLineId: string
  purchaseOrderLineId: string
  poId: string
  poReference: string
  qty: number
  receivedQty: number
  allocatedQty: number
  createdAt: string
}

export type PurchaseOrderPegRow = SalesOrderPegRow & {
  salesOrderId: string
  salesOrderNumber: string
  customerName: string | null
}

export type PegActionResult = { success: true } | { success: false; error: string }

export async function getPegCandidatesForSalesLine(salesOrderLineId: string): Promise<PegCandidate[]> {
  await requireInternalUser()
  const line = await db.salesOrderLine.findUnique({ where: { id: salesOrderLineId }, select: { productId: true, product: { select: { type: true } } } })
  if (!line?.productId || line.product?.type === 'KIT') return []
  const poLines = await db.purchaseOrderLine.findMany({
    where: { productId: line.productId, po: { status: { in: [...PEGGABLE_PURCHASE_ORDER_STATUSES] } } },
    select: {
      id: true, qty: true, qtyReceived: true, expectedDelivery: true,
      po: { select: { id: true, reference: true, status: true, expectedDelivery: true, supplier: { select: { name: true } } } },
      pegs: { where: { endedAt: null }, select: { qty: true, receivedQty: true } },
    },
    orderBy: { po: { createdAt: 'asc' } },
  })
  const landed = await loadPurchaseOrderLineLandedQty(db, poLines.map((l) => ({ id: l.id, qtyReceived: l.qtyReceived })))
  const out: PegCandidate[] = []
  for (const l of poLines) {
    const landedQty = landed.get(l.id)?.qty ?? ZERO
    const unreceived = Prisma.Decimal.max(ZERO, l.qty.sub(landedQty))
    const pegged = l.pegs.reduce((sum, p) => sum.add(p.qty.sub(p.receivedQty)), ZERO)
    const available = Prisma.Decimal.max(ZERO, unreceived.sub(pegged))
    if (!available.gt(ZERO)) continue
    const eta = l.expectedDelivery ?? l.po.expectedDelivery
    out.push({
      purchaseOrderLineId: l.id, poId: l.po.id, poReference: l.po.reference, supplierName: l.po.supplier?.name ?? null, status: l.po.status,
      expectedDelivery: eta ? eta.toISOString() : null, lineQty: l.qty.toNumber(), landedQty: landedQty.toNumber(), available: available.toNumber(),
    })
  }
  return out
}

export async function getSalesOrderPegs(orderId: string): Promise<SalesOrderPegRow[]> {
  await requireInternalUser()
  const pegs = await db.salesOrderLinePeg.findMany({
    where: { endedAt: null, salesOrderLine: { orderId } },
    select: {
      id: true, salesOrderLineId: true, purchaseOrderLineId: true, qty: true, receivedQty: true, allocatedQty: true, createdAt: true,
      purchaseOrderLine: { select: { po: { select: { id: true, reference: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return pegs.map((p) => ({
    id: p.id, salesOrderLineId: p.salesOrderLineId, purchaseOrderLineId: p.purchaseOrderLineId,
    poId: p.purchaseOrderLine.po.id, poReference: p.purchaseOrderLine.po.reference,
    qty: p.qty.toNumber(), receivedQty: p.receivedQty.toNumber(), allocatedQty: p.allocatedQty.toNumber(), createdAt: p.createdAt.toISOString(),
  }))
}

export async function getPurchaseOrderPegs(poId: string): Promise<PurchaseOrderPegRow[]> {
  await requireInternalUser()
  const pegs = await db.salesOrderLinePeg.findMany({
    where: { endedAt: null, purchaseOrderLine: { poId } },
    select: {
      id: true, salesOrderLineId: true, purchaseOrderLineId: true, qty: true, receivedQty: true, allocatedQty: true, createdAt: true,
      purchaseOrderLine: { select: { po: { select: { id: true, reference: true } } } },
      salesOrderLine: { select: { order: { select: { id: true, orderNumber: true, externalOrderNumber: true, customerName: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return pegs.map((p) => ({
    id: p.id, salesOrderLineId: p.salesOrderLineId, purchaseOrderLineId: p.purchaseOrderLineId,
    poId: p.purchaseOrderLine.po.id, poReference: p.purchaseOrderLine.po.reference,
    qty: p.qty.toNumber(), receivedQty: p.receivedQty.toNumber(), allocatedQty: p.allocatedQty.toNumber(), createdAt: p.createdAt.toISOString(),
    salesOrderId: p.salesOrderLine.order.id,
    salesOrderNumber: p.salesOrderLine.order.orderNumber ?? p.salesOrderLine.order.externalOrderNumber ?? p.salesOrderLine.order.id.slice(0, 8),
    customerName: p.salesOrderLine.order.customerName ?? null,
  }))
}

/**
 * Peg `qty` of a sales-order line to a purchase-order line. Refused when it exceeds what is still unreceived on the PO line (net
 * of other pegs) or what the order line still lacks. Taken under the order lock, then the PO lock, then the peg rows.
 */
export async function createPeg(input: { salesOrderLineId: string; purchaseOrderLineId: string; qty: number }): Promise<PegActionResult> {
  const session = await requirePermission('sales.process')
  if (!Number.isFinite(input.qty) || input.qty <= 0) return { success: false, error: 'Peg quantity must be greater than zero' }
  const qty = new Prisma.Decimal(input.qty).toDecimalPlaces(4)
  try {
    const outcome = await db.$transaction(async (tx) => {
      const line = await tx.salesOrderLine.findUnique({
        where: { id: input.salesOrderLineId },
        select: { id: true, orderId: true, productId: true, qty: true, product: { select: { type: true } }, order: { select: { orderNumber: true, externalOrderNumber: true } } },
      })
      if (!line) return { error: 'Sales order line not found' }
      if (!line.productId || line.product?.type === 'KIT') return { error: 'Only a plain stock product line can be pegged (a kit line cannot)' }
      await lockSalesOrder(tx, line.orderId)
      const order = await tx.salesOrder.findUnique({ where: { id: line.orderId }, select: { status: true, refundStatus: true } })
      if (!order || !(PEG_OPEN_ORDER_STATUSES as readonly string[]).includes(order.status) || order.refundStatus === 'FULL') {
        return { error: 'Only an open order that has not been picked or shipped can be pegged' }
      }
      const poLineHead = await tx.purchaseOrderLine.findUnique({ where: { id: input.purchaseOrderLineId }, select: { poId: true } })
      if (!poLineHead) return { error: 'Purchase order line not found' }
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "purchase_orders" WHERE id = ${poLineHead.poId} FOR UPDATE`)
      const poLine = await tx.purchaseOrderLine.findUnique({
        where: { id: input.purchaseOrderLineId },
        select: { id: true, poId: true, productId: true, qty: true, qtyReceived: true, po: { select: { reference: true, status: true } } },
      })
      if (!poLine) return { error: 'Purchase order line not found' }
      if (poLine.productId !== line.productId) return { error: 'The purchase order line is for a different product' }
      if (!(PEGGABLE_PURCHASE_ORDER_STATUSES as readonly string[]).includes(poLine.po.status)) {
        return { error: 'Only a purchase order that has been sent and is still expecting goods can be pegged to' }
      }

      await lockPegsForProducts(tx, [line.productId])
      const live = await loadLivePegs(tx, { salesOrderLine: { productId: line.productId } })
      await refreshPegReceipts(tx, live)
      const landed = (await loadPurchaseOrderLineLandedQty(tx, [{ id: poLine.id, qtyReceived: poLine.qtyReceived }])).get(poLine.id)!.qty
      const allocated = (await loadLineAllocations(tx, [{ id: line.id, productId: line.productId }])).get(line.id) ?? ZERO
      const refunded = (await tx.salesOrderRefundLine.aggregate({ where: { salesOrderLineId: line.id }, _sum: { qty: true } }))._sum.qty ?? ZERO

      const ownPegs = live.filter((p) => p.salesOrderLineId === line.id)
      const settled = settlePegs(ownPegs, allocated, line.qty)
      const salesOther = ownPegs.reduce((sum, p) => sum.add(p.qty.sub(settled.get(p.id)?.allocated ?? ZERO)), ZERO)
      const purchaseOther = live.filter((p) => p.purchaseOrderLineId === poLine.id).reduce((sum, p) => sum.add(p.qty.sub(p.receivedQty)), ZERO)

      const decision = decidePeg({
        qty, salesLineQty: line.qty, salesLineRefundedQty: new Prisma.Decimal(refunded), salesLineAllocated: allocated, salesLineOtherPegRemaining: salesOther,
        purchaseLineQty: poLine.qty, purchaseLineLanded: landed, purchaseLineOtherPegRemaining: purchaseOther,
      })
      if (!decision.ok) return { error: decision.error }

      const peg = await tx.salesOrderLinePeg.create({
        data: { salesOrderLineId: line.id, purchaseOrderLineId: poLine.id, qty, baselineAllocatedQty: allocated, seenLandedQty: landed, createdById: session.user.id ?? null },
        select: { id: true },
      })
      const orderRef = line.order.orderNumber ?? line.order.externalOrderNumber ?? line.orderId.slice(0, 8)
      const metadata = { pegId: peg.id, qty: qty.toString(), salesOrderLineId: line.id, purchaseOrderLineId: poLine.id }
      await logActivityInTransaction(tx, { entityType: 'SALES_ORDER', entityId: line.orderId, action: 'peg_created', tag: 'sales', userId: session.user.id ?? null,
        description: `Pegged ${qty.toString()} of ${orderRef} to purchase order ${poLine.po.reference}: stock received on it is allocated to this order first`, metadata })
      await logActivityInTransaction(tx, { entityType: 'PURCHASE_ORDER', entityId: poLine.poId, action: 'peg_created', tag: 'purchase', userId: session.user.id ?? null,
        description: `Sales order ${orderRef} pegged to this purchase order for ${qty.toString()}`, metadata })
      return { orderId: line.orderId, poId: poLine.poId }
    }, { maxWait: 5000, timeout: 20000 })
    if ('error' in outcome) return { success: false, error: outcome.error as string }
    revalidatePath(`/sales/${outcome.orderId}`)
    revalidatePath(`/purchase-orders/${outcome.poId}`)
    return { success: true }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { success: false, error: 'That order line is already pegged to that purchase order line. Remove the existing peg first.' }
    }
    console.error(error)
    return { success: false, error: 'Could not create the peg' }
  }
}

/** Remove a live peg by hand. The stock it was holding goes back to the oldest waiting order. */
export async function removePeg(pegId: string): Promise<PegActionResult> {
  const session = await requirePermission('sales.process')
  try {
    const outcome = await db.$transaction(async (tx) => {
      const peg = await tx.salesOrderLinePeg.findUnique({ where: { id: pegId }, select: { endedAt: true, salesOrderLine: { select: { orderId: true, productId: true } }, purchaseOrderLine: { select: { poId: true } } } })
      if (!peg || peg.endedAt) return { error: 'That peg has already ended' }
      await lockSalesOrder(tx, peg.salesOrderLine.orderId)
      if (peg.salesOrderLine.productId) await lockPegsForProducts(tx, [peg.salesOrderLine.productId])
      const ended = await endPegInTx(tx, pegId, 'REMOVED_BY_USER', session.user.id ?? null)
      if (!ended) return { error: 'That peg has already ended' }
      return { orderId: peg.salesOrderLine.orderId, poId: peg.purchaseOrderLine.poId, productId: peg.salesOrderLine.productId }
    }, { maxWait: 5000, timeout: 20000 })
    if ('error' in outcome) return { success: false, error: outcome.error as string }
    revalidatePath(`/sales/${outcome.orderId}`)
    revalidatePath(`/purchase-orders/${outcome.poId}`)
    if (outcome.productId) {
      try {
        const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
        await allocateBackordersForProducts([outcome.productId], { source: 'stock_adjustment', referenceId: pegId, referenceLabel: 'removed peg' })
      } catch (error) {
        console.error(error)
      }
    }
    return { success: true }
  } catch (error) {
    console.error(error)
    return { success: false, error: 'Could not remove the peg' }
  }
}
