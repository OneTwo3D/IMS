import { Prisma } from '@/app/generated/prisma/client'
import type { SalesOrderLinePegEndReason } from '@/app/generated/prisma/client'
import { loadPurchaseOrderLineLandedQty } from '@/lib/domain/inventory/po-line-landed-quantity'
import { logActivityInTransaction } from '@/lib/activity-log'

/**
 * SO-to-PO pegging: stock that lands on a purchase-order line is held for, and allocated to, the sales-order line pegged to
 * it before any other order sees it. IMS-internal allocation ordering only: this module writes no outbound anything.
 *
 * THE MODEL. A peg carries `qty` (what the operator pegged), `receivedQty` (the part of it that has LANDED on the PO line and
 * been earmarked for this peg, oldest peg first) and `allocatedQty` (the part of that the order has absorbed). The
 * earmarked-but-unabsorbed remainder, `receivedQty - allocatedQty`, is the HOLD: other orders' allocation (the receipt
 * backorder pass, the reallocation sweep, a payment-poller re-run: every caller of allocateSalesOrder) subtracts it from the
 * stock it may take, so pegged stock cannot be handed to an older order. Nothing takes stock away from an existing pegged
 * allocation, because allocation only ever places stock from what is free; the overallocation rebalancer, which does remove
 * reservations when stock disappears, releases pegged orders last (see sortReleaseCandidatesPeggedLast).
 *
 * `receivedQty` is DERIVED from the PO line's landed quantity (po-line-landed-quantity.ts: manual receipt + ASN alignment +
 * WMS book-in, the one definition) and the peg's `seenLandedQty` watermark, under a row lock on the pegs, so every receipt
 * path is covered with no receipt path calling in, and a receipt whose post-commit allocation never ran is still honoured by
 * the next allocation of any order.
 *
 * `allocatedQty` is derived from the order line's own allocation: the order's allocation minus what it already had when the
 * peg was made (`baselineAllocatedQty`), pooled over the line's pegs oldest first. Stock is fungible, so a peg is satisfied
 * by the line's allocation however it got there.
 *
 * LOCK ORDER (the allocation lock order, extended): sales_orders row, then stock_levels, THEN the peg rows (ascending id). The
 * peg service never takes an order or stock lock itself except where the caller (createPeg) says so.
 */

type Tx = Prisma.TransactionClient
type Decimal = Prisma.Decimal

const ZERO = new Prisma.Decimal(0)
const EPSILON = new Prisma.Decimal('0.0001')

/** An order in one of these is allocatable, so its unabsorbed peg quantity is held back from other orders. */
export const PEG_HOLDING_ORDER_STATUSES = ['PROCESSING', 'ALLOCATED'] as const
/** A peg may be made on, and survives while, the order is in one of these. Any other status ends it. */
export const PEG_OPEN_ORDER_STATUSES = ['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED'] as const
/** A peg may be made against a purchase order in one of these: it has been sent and still expects goods. */
export const PEGGABLE_PURCHASE_ORDER_STATUSES = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED'] as const

const PEG_END_LABEL: Record<SalesOrderLinePegEndReason, string> = {
  FULLY_ALLOCATED: 'the order line is fully allocated',
  SALES_ORDER_CANCELLED: 'the sales order was cancelled or fully refunded',
  SALES_LINE_REMOVED: 'the sales order line was removed',
  SALES_ORDER_ADVANCED: 'the sales order moved past allocation',
  PURCHASE_ORDER_CANCELLED: 'the purchase order was cancelled or closed',
  PURCHASE_LINE_RECEIVED_ELSEWHERE: 'the purchase order line was received without covering the peg',
  REMOVED_BY_USER: 'it was removed by a user',
}

export function pegEndReasonLabel(reason: SalesOrderLinePegEndReason): string {
  return PEG_END_LABEL[reason]
}

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

export type PegReceiptInput = { id: string; createdAt: Date; qty: Decimal; receivedQty: Decimal; seenLandedQty: Decimal }

/**
 * Earmark newly landed units for the pegs of ONE purchase-order line, oldest peg first, each up to its qty. Idempotent: the
 * watermark moves to `landed`, so replaying the same landed figure grants nothing. A landed figure BELOW the watermark (a
 * correction) grants nothing and lowers the watermark, so the units that then land again are counted again; that is the
 * conservative direction for a hold that only ever protects an order.
 */
export function grantReceipts(pegs: PegReceiptInput[], landed: Decimal): Map<string, { receivedQty: Decimal; seenLandedQty: Decimal }> {
  const sorted = [...pegs].sort(byAge)
  const seen = sorted.length === 0 ? ZERO : Prisma.Decimal.min(...sorted.map((peg) => peg.seenLandedQty))
  let pool = Prisma.Decimal.max(ZERO, landed.sub(seen))
  const out = new Map<string, { receivedQty: Decimal; seenLandedQty: Decimal }>()
  for (const peg of sorted) {
    const grant = Prisma.Decimal.min(pool, Prisma.Decimal.max(ZERO, peg.qty.sub(peg.receivedQty)))
    pool = pool.sub(grant)
    out.set(peg.id, { receivedQty: peg.receivedQty.add(grant), seenLandedQty: landed })
  }
  return out
}

export type PegSettleInput = { id: string; createdAt: Date; qty: Decimal; receivedQty: Decimal; baselineAllocatedQty: Decimal }
export type PegSettled = { allocated: Decimal; hold: Decimal }

/**
 * How much of each peg of ONE sales-order line the order has absorbed, and how much is still held for it.
 *
 *   pool       = line allocation now - the lowest baseline among the pegs (what the line gained since the first peg)
 *   allocated  = min(received, pool), oldest peg first
 *   hold       = received - allocated, capped so the holds together never exceed the line's still-unallocated demand
 */
export function settlePegs(pegs: PegSettleInput[], lineAllocated: Decimal, lineQty: Decimal): Map<string, PegSettled> {
  const sorted = [...pegs].sort(byAge)
  const baseline = sorted.length === 0 ? ZERO : Prisma.Decimal.min(...sorted.map((peg) => peg.baselineAllocatedQty))
  let pool = Prisma.Decimal.max(ZERO, lineAllocated.sub(baseline))
  let demandLeft = Prisma.Decimal.max(ZERO, lineQty.sub(lineAllocated))
  const out = new Map<string, PegSettled>()
  for (const peg of sorted) {
    const allocated = Prisma.Decimal.min(peg.receivedQty, pool)
    pool = pool.sub(allocated)
    const hold = Prisma.Decimal.min(peg.receivedQty.sub(allocated), demandLeft)
    demandLeft = demandLeft.sub(hold)
    out.set(peg.id, { allocated, hold })
  }
  return out
}

function byAge(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const PEG_INCLUDE = {
  salesOrderLine: {
    select: {
      id: true, orderId: true, productId: true, qty: true,
      order: { select: { id: true, status: true, refundStatus: true, orderNumber: true, externalOrderNumber: true } },
    },
  },
  purchaseOrderLine: {
    select: {
      id: true, poId: true, qty: true, qtyReceived: true,
      po: { select: { id: true, reference: true, status: true, destinationWarehouseId: true } },
    },
  },
} satisfies Prisma.SalesOrderLinePegInclude

export type LoadedPeg = Prisma.SalesOrderLinePegGetPayload<{ include: typeof PEG_INCLUDE }>

/** Row-lock the live pegs on these products, ascending id. Call AFTER the order and stock locks. */
export async function lockPegsForProducts(tx: Tx, productIds: string[]): Promise<void> {
  if (productIds.length === 0) return
  await tx.$queryRaw(Prisma.sql`
    SELECT p.id
    FROM "sales_order_line_pegs" p
    JOIN "sales_order_lines" l ON l.id = p."salesOrderLineId"
    WHERE p."endedAt" IS NULL AND l."productId" IN (${Prisma.join(productIds)})
    ORDER BY p.id
    FOR UPDATE OF p
  `)
}

async function loadLivePegs(tx: Tx, where: Prisma.SalesOrderLinePegWhereInput): Promise<LoadedPeg[]> {
  return tx.salesOrderLinePeg.findMany({
    where: { endedAt: null, ...where },
    include: PEG_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** The line's allocation: the order's WHOLE claim on the line's own product (retained through dispatch). */
async function loadLineAllocations(tx: Tx, lines: Array<{ id: string; productId: string | null }>): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>(lines.map((line) => [line.id, ZERO]))
  if (lines.length === 0) return out
  const productByLine = new Map(lines.map((line) => [line.id, line.productId]))
  const rows = await tx.orderAllocation.findMany({
    where: { lineId: { in: lines.map((line) => line.id) } },
    select: { lineId: true, productId: true, qty: true },
  })
  for (const row of rows) {
    if (row.productId !== productByLine.get(row.lineId)) continue
    out.set(row.lineId, (out.get(row.lineId) ?? ZERO).add(row.qty))
  }
  return out
}

/**
 * Bring the pegs' `receivedQty` up to what has landed on their PO lines. Writes only pegs that changed. The caller holds the
 * peg row locks (lockPegsForProducts) so two receipts' refreshes serialise.
 */
export async function refreshPegReceipts(tx: Tx, pegs: LoadedPeg[]): Promise<void> {
  if (pegs.length === 0) return
  const poLines = new Map(pegs.map((peg) => [peg.purchaseOrderLineId, peg.purchaseOrderLine]))
  const landed = await loadPurchaseOrderLineLandedQty(tx, [...poLines.values()].map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))
  const byPoLine = new Map<string, LoadedPeg[]>()
  for (const peg of pegs) byPoLine.set(peg.purchaseOrderLineId, [...(byPoLine.get(peg.purchaseOrderLineId) ?? []), peg])
  for (const [poLineId, group] of byPoLine) {
    const landedQty = landed.get(poLineId)?.qty
    if (!landedQty) continue
    const granted = grantReceipts(
      group.map((peg) => ({ id: peg.id, createdAt: peg.createdAt, qty: peg.qty, receivedQty: peg.receivedQty, seenLandedQty: peg.seenLandedQty })),
      landedQty,
    )
    for (const peg of group) {
      const next = granted.get(peg.id)!
      if (next.receivedQty.equals(peg.receivedQty) && next.seenLandedQty.equals(peg.seenLandedQty)) continue
      await tx.salesOrderLinePeg.update({ where: { id: peg.id }, data: { receivedQty: next.receivedQty, seenLandedQty: next.seenLandedQty } })
      peg.receivedQty = next.receivedQty
      peg.seenLandedQty = next.seenLandedQty
    }
  }
}

// ---------------------------------------------------------------------------
// The allocation seam
// ---------------------------------------------------------------------------

export type PegContext = {
  /** This order's live pegs, receipts refreshed. */
  own: LoadedPeg[]
  /** Holds (per product, per destination warehouse hint) other orders' pegs place on stock this order must leave alone. */
  holds: Array<{ pegId: string; productId: string; warehouseHint: string | null; qty: Decimal }>
  /** Per own line: the extra quantity the peg pass may add on top of the line's existing allocation. */
  ownExtraByLine: Map<string, Decimal>
}

/**
 * Called by allocateSalesOrder AFTER it holds the order lock and the stock locks. Returns null when no peg touches these
 * products (the overwhelmingly common case: one indexed read, no lock, no write).
 */
export async function loadPegContext(tx: Tx, orderId: string, productIds: string[]): Promise<PegContext | null> {
  if (productIds.length === 0) return null
  const any = await tx.salesOrderLinePeg.findFirst({
    where: { endedAt: null, salesOrderLine: { productId: { in: productIds } } },
    select: { id: true },
  })
  if (!any) return null
  await lockPegsForProducts(tx, productIds)
  const pegs = await loadLivePegs(tx, { salesOrderLine: { productId: { in: productIds } } })
  await refreshPegReceipts(tx, pegs)

  const lines = [...new Map(pegs.map((peg) => [peg.salesOrderLineId, peg.salesOrderLine])).values()]
  const allocations = await loadLineAllocations(tx, lines)
  const settledByPeg = new Map<string, PegSettled>()
  const pegsByLine = new Map<string, LoadedPeg[]>()
  for (const peg of pegs) pegsByLine.set(peg.salesOrderLineId, [...(pegsByLine.get(peg.salesOrderLineId) ?? []), peg])
  for (const [lineId, group] of pegsByLine) {
    const line = group[0]!.salesOrderLine
    const settled = settlePegs(group, allocations.get(lineId) ?? ZERO, line.qty)
    for (const [pegId, value] of settled) settledByPeg.set(pegId, value)
  }

  const own = pegs.filter((peg) => peg.salesOrderLine.orderId === orderId)
  const ownExtraByLine = new Map<string, Decimal>()
  for (const peg of own) {
    const settled = settledByPeg.get(peg.id)
    if (!settled) continue
    ownExtraByLine.set(peg.salesOrderLineId, (ownExtraByLine.get(peg.salesOrderLineId) ?? ZERO).add(settled.hold))
  }

  const holds: PegContext['holds'] = []
  for (const peg of pegs) {
    if (peg.salesOrderLine.orderId === orderId) continue
    if (!(PEG_HOLDING_ORDER_STATUSES as readonly string[]).includes(peg.salesOrderLine.order.status)) continue
    const settled = settledByPeg.get(peg.id)
    if (!settled || settled.hold.lte(ZERO)) continue
    holds.push({ pegId: peg.id, productId: peg.salesOrderLine.productId!, warehouseHint: peg.purchaseOrderLine.po.destinationWarehouseId, qty: settled.hold })
  }
  return { own, holds, ownExtraByLine }
}

/**
 * Take the other orders' held quantities out of the availability map (mutates it). A hold is taken from the PO's destination
 * warehouse first, then from wherever else the product has stock, and never below zero: a hold can only ever reduce what
 * this order may take, it can not create a shortage in stock that is not there.
 */
export function applyPegHoldsToStockMap(stockMap: Map<string, Map<string, Decimal>>, holds: PegContext['holds']): void {
  for (const hold of holds) {
    const byWarehouse = stockMap.get(hold.productId)
    if (!byWarehouse) continue
    let remaining = hold.qty
    const order = [...byWarehouse.keys()].sort((a, b) => {
      if (a === hold.warehouseHint) return -1
      if (b === hold.warehouseHint) return 1
      return byWarehouse.get(b)!.comparedTo(byWarehouse.get(a)!)
    })
    for (const warehouseId of order) {
      if (remaining.lte(ZERO)) break
      const available = byWarehouse.get(warehouseId)!
      const take = Prisma.Decimal.min(available, remaining)
      byWarehouse.set(warehouseId, available.sub(take))
      remaining = remaining.sub(take)
    }
  }
}

// ---------------------------------------------------------------------------
// Ending pegs
// ---------------------------------------------------------------------------

export type EndedPeg = { pegId: string; orderId: string; productId: string; reason: SalesOrderLinePegEndReason }

async function endPeg(tx: Tx, peg: LoadedPeg, reason: SalesOrderLinePegEndReason, userId: string | null): Promise<EndedPeg> {
  await tx.salesOrderLinePeg.update({ where: { id: peg.id }, data: { endedAt: new Date(), endReason: reason, endedById: userId, allocatedQty: peg.allocatedQty } })
  const orderRef = peg.salesOrderLine.order.orderNumber ?? peg.salesOrderLine.order.externalOrderNumber ?? peg.salesOrderLine.orderId.slice(0, 8)
  const poRef = peg.purchaseOrderLine.po.reference
  const metadata = {
    pegId: peg.id, reason, qty: peg.qty.toString(), receivedQty: peg.receivedQty.toString(), allocatedQty: peg.allocatedQty.toString(),
    salesOrderLineId: peg.salesOrderLineId, purchaseOrderLineId: peg.purchaseOrderLineId,
  }
  await logActivityInTransaction(tx, {
    entityType: 'SALES_ORDER', entityId: peg.salesOrderLine.orderId, action: 'peg_ended', tag: 'sales', userId,
    description: `Peg of ${orderRef} to purchase order ${poRef} ended: ${PEG_END_LABEL[reason]}`,
    metadata,
  })
  await logActivityInTransaction(tx, {
    entityType: 'PURCHASE_ORDER', entityId: peg.purchaseOrderLine.poId, action: 'peg_ended', tag: 'purchase', userId,
    description: `Peg of sales order ${orderRef} to ${poRef} ended: ${PEG_END_LABEL[reason]}`,
    metadata,
  })
  return { pegId: peg.id, orderId: peg.salesOrderLine.orderId, productId: peg.salesOrderLine.productId!, reason }
}

/**
 * Re-derive each peg's absorbed quantity and END those that no longer apply. The caller holds the peg row locks.
 *
 * ORDER OF THE DECISION is the order of the reasons a reader would give: an order that is cancelled is cancelled whatever its
 * allocation says; one past allocation is past it; only then is "fully allocated" asked; and the purchase side last.
 */
export async function evaluatePegs(tx: Tx, pegs: LoadedPeg[], userId: string | null = null): Promise<EndedPeg[]> {
  const ended: EndedPeg[] = []
  if (pegs.length === 0) return ended
  await refreshPegReceipts(tx, pegs)
  const lines = [...new Map(pegs.map((peg) => [peg.salesOrderLineId, peg.salesOrderLine])).values()]
  const allocations = await loadLineAllocations(tx, lines)
  const landed = await loadPurchaseOrderLineLandedQty(tx, [...new Map(pegs.map((peg) => [peg.purchaseOrderLineId, peg.purchaseOrderLine])).values()].map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))

  const pegsByLine = new Map<string, LoadedPeg[]>()
  for (const peg of pegs) pegsByLine.set(peg.salesOrderLineId, [...(pegsByLine.get(peg.salesOrderLineId) ?? []), peg])
  for (const [lineId, group] of pegsByLine) {
    const line = group[0]!.salesOrderLine
    const lineAllocated = allocations.get(lineId) ?? ZERO
    const settled = settlePegs(group, lineAllocated, line.qty)
    for (const peg of group) {
      const state = settled.get(peg.id)!
      const order = line.order
      const po = peg.purchaseOrderLine.po
      let reason: SalesOrderLinePegEndReason | null = null
      if (order.status === 'CANCELLED' || order.refundStatus === 'FULL') reason = 'SALES_ORDER_CANCELLED'
      else if (!(PEG_OPEN_ORDER_STATUSES as readonly string[]).includes(order.status)) reason = 'SALES_ORDER_ADVANCED'
      else if (state.allocated.gte(peg.qty.sub(EPSILON)) || line.qty.sub(lineAllocated).lte(EPSILON)) reason = 'FULLY_ALLOCATED'
      else if (po.status === 'CANCELLED' || po.status === 'CLOSED') reason = 'PURCHASE_ORDER_CANCELLED'
      else if (
        peg.receivedQty.lt(peg.qty.sub(EPSILON))
        && (landed.get(peg.purchaseOrderLineId)?.qty ?? ZERO).gte(peg.purchaseOrderLine.qty.sub(EPSILON))
      ) reason = 'PURCHASE_LINE_RECEIVED_ELSEWHERE'

      if (reason) {
        peg.allocatedQty = state.allocated
        ended.push(await endPeg(tx, peg, reason, userId))
      } else if (!state.allocated.equals(peg.allocatedQty)) {
        await tx.salesOrderLinePeg.update({ where: { id: peg.id }, data: { allocatedQty: state.allocated } })
        peg.allocatedQty = state.allocated
      }
    }
  }
  return ended
}

/** allocateSalesOrder's end-of-transaction call: settle (and end where due) this order's pegs. */
export async function evaluateOrderPegsInTx(tx: Tx, orderId: string): Promise<EndedPeg[]> {
  const any = await tx.salesOrderLinePeg.findFirst({ where: { endedAt: null, salesOrderLine: { orderId } }, select: { id: true } })
  if (!any) return []
  // The peg rows of this order's lines, ascending id, after the order and stock locks the allocation already holds.
  await tx.$queryRaw(Prisma.sql`
    SELECT p.id FROM "sales_order_line_pegs" p JOIN "sales_order_lines" l ON l.id = p."salesOrderLineId"
    WHERE p."endedAt" IS NULL AND l."orderId" = ${orderId} ORDER BY p.id FOR UPDATE OF p
  `)
  return evaluatePegs(tx, await loadLivePegs(tx, { salesOrderLine: { orderId } }))
}

/**
 * Called when sales-order or purchase-order lines are about to be DELETED (the FK cascade removes their pegs): record the end
 * first, so the activity log still says what happened to them.
 */
export async function recordPegsRemovedWithLines(
  tx: Tx,
  where: { salesOrderLineIds?: string[]; purchaseOrderLineIds?: string[] },
  userId: string | null,
): Promise<number> {
  const or: Prisma.SalesOrderLinePegWhereInput[] = []
  if (where.salesOrderLineIds?.length) or.push({ salesOrderLineId: { in: where.salesOrderLineIds } })
  if (where.purchaseOrderLineIds?.length) or.push({ purchaseOrderLineId: { in: where.purchaseOrderLineIds } })
  if (or.length === 0) return 0
  const pegs = await loadLivePegs(tx, { OR: or })
  for (const peg of pegs) {
    await endPeg(tx, peg, where.salesOrderLineIds?.includes(peg.salesOrderLineId) ? 'SALES_LINE_REMOVED' : 'PURCHASE_ORDER_CANCELLED', userId)
  }
  return pegs.length
}

/**
 * The cron's pass: end pegs whose order or purchase order has gone, whatever allocation did or did not run. Each batch is its
 * own transaction under the peg row locks. Returns the ended pegs so the caller can hand their released stock on.
 */
export async function sweepPegs(
  client: { $transaction: <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => Promise<T> },
  opts: { batch?: number } = {},
): Promise<{ checked: number; ended: EndedPeg[] }> {
  const batch = opts.batch ?? 200
  return client.$transaction(async (tx) => {
    const ids = (await tx.salesOrderLinePeg.findMany({ where: { endedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: batch })).map((row) => row.id)
    if (ids.length === 0) return { checked: 0, ended: [] }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "sales_order_line_pegs" WHERE id IN (${Prisma.join(ids)}) AND "endedAt" IS NULL ORDER BY id FOR UPDATE`)
    const pegs = await loadLivePegs(tx, { id: { in: ids } })
    return { checked: pegs.length, ended: await evaluatePegs(tx, pegs) }
  }, { maxWait: 5000, timeout: 20000 })
}

// ---------------------------------------------------------------------------
// The overallocation rebalancer
// ---------------------------------------------------------------------------

/**
 * The rebalancer releases reservations when stock has gone missing, newest order first. A pegged order is the one the
 * operator promised stock to, so within that order it goes LAST (stable otherwise): unpegged orders give way first.
 */
export function sortReleaseCandidatesPeggedLast<T extends { orderId: string }>(rows: T[], peggedOrderIds: ReadonlySet<string>): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(peggedOrderIds.has(a.row.orderId)) - Number(peggedOrderIds.has(b.row.orderId)) || a.index - b.index)
    .map(({ row }) => row)
}

export async function loadPeggedOrderIds(tx: Tx, productId: string): Promise<Set<string>> {
  const rows = await tx.salesOrderLinePeg.findMany({
    where: { endedAt: null, salesOrderLine: { productId } },
    select: { salesOrderLine: { select: { orderId: true } } },
  })
  return new Set(rows.map((row) => row.salesOrderLine.orderId))
}

/** End one live peg by hand. Caller holds the order lock and the peg row locks. Returns null when it had already ended. */
export async function endPegInTx(tx: Tx, pegId: string, reason: SalesOrderLinePegEndReason, userId: string | null): Promise<EndedPeg | null> {
  const [peg] = await loadLivePegs(tx, { id: pegId })
  return peg ? endPeg(tx, peg, reason, userId) : null
}

export type PegDecision = { ok: true } | { ok: false; error: string }

/**
 * Whether a peg of `qty` may be made, given the facts read under the locks. Pure, so every refusal is testable:
 *   - the quantity must be positive;
 *   - it may not exceed what has NOT yet landed on the PO line and is not already pegged by another order's peg;
 *   - it may not exceed what the order line still lacks (its demand, less what it holds, less its other live pegs).
 */
export function decidePeg(input: {
  qty: Decimal
  salesLineQty: Decimal
  salesLineRefundedQty: Decimal
  salesLineAllocated: Decimal
  salesLineOtherPegRemaining: Decimal
  purchaseLineQty: Decimal
  purchaseLineLanded: Decimal
  purchaseLineOtherPegRemaining: Decimal
}): PegDecision {
  if (!input.qty.gt(ZERO)) return { ok: false, error: 'Peg quantity must be greater than zero' }
  const unreceived = Prisma.Decimal.max(ZERO, input.purchaseLineQty.sub(input.purchaseLineLanded))
  const pegPurchase = Prisma.Decimal.max(ZERO, unreceived.sub(input.purchaseLineOtherPegRemaining))
  if (input.qty.gt(pegPurchase.add(EPSILON))) {
    return { ok: false, error: `Only ${pegPurchase.toString()} of that purchase order line is still unreceived and not already pegged to another order` }
  }
  const lacking = Prisma.Decimal.max(ZERO, input.salesLineQty.sub(input.salesLineRefundedQty).sub(input.salesLineAllocated).sub(input.salesLineOtherPegRemaining))
  if (input.qty.gt(lacking.add(EPSILON))) {
    return { ok: false, error: `The order line only still needs ${lacking.toString()} (ordered, less allocated, less already pegged)` }
  }
  return { ok: true }
}

export { loadLivePegs, loadLineAllocations }
