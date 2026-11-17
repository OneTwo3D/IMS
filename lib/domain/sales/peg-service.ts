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

/** The warehouse key for units that landed with no recorded warehouse (no cost layer and the PO has no destination). */
export const UNATTRIBUTED_WAREHOUSE = ''
/** Purchase orders that expect nothing more: a peg on one holds nothing back from other orders. */
const PO_STATUSES_HOLDING_NOTHING = ['CANCELLED', 'CLOSED'] as const
type WarehouseQty = Map<string, Decimal>

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
  PURCHASE_LINE_REMOVED: 'the purchase order line was removed or reduced below the pegged quantity',
  PURCHASE_LINE_RECEIVED_ELSEWHERE: 'the purchase order line was received without covering the peg',
  REMOVED_BY_USER: 'it was removed by a user',
}

export function pegEndReasonLabel(reason: SalesOrderLinePegEndReason): string {
  return PEG_END_LABEL[reason]
}

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

export type PegReceiptInput = { id: string; createdAt: Date; qty: Decimal; receivedByWarehouse: WarehouseQty; seenByWarehouse: WarehouseQty }
export type PegReceiptGrant = { receivedByWarehouse: WarehouseQty; seenByWarehouse: WarehouseQty; receivedQty: Decimal; seenLandedQty: Decimal }

function sumQty(map: WarehouseQty): Decimal {
  let total = ZERO
  for (const qty of map.values()) total = total.add(qty)
  return total
}

/** Split a PO line's landed total over the warehouses its cost layers were laid in; the unlayered remainder goes to `fallback`. */
export function splitLandedByWarehouse(total: Decimal, layerQtyByWarehouse: WarehouseQty, fallbackWarehouseId: string | null): WarehouseQty {
  const out: WarehouseQty = new Map()
  let remaining = Prisma.Decimal.max(ZERO, total)
  for (const warehouseId of [...layerQtyByWarehouse.keys()].sort()) {
    const take = Prisma.Decimal.min(remaining, Prisma.Decimal.max(ZERO, layerQtyByWarehouse.get(warehouseId)!))
    if (take.lte(ZERO)) continue
    out.set(warehouseId, take)
    remaining = remaining.sub(take)
  }
  if (remaining.gt(ZERO)) {
    const key = fallbackWarehouseId ?? UNATTRIBUTED_WAREHOUSE
    out.set(key, (out.get(key) ?? ZERO).add(remaining))
  }
  return out
}

/**
 * Earmark newly landed units for the pegs of ONE purchase-order line, oldest peg first, each up to its qty, PER WAREHOUSE: the
 * units that landed in warehouse B are earmarked in B, whatever the PO's planned destination was. Idempotent: each warehouse's
 * watermark moves to what is landed there, so replaying the same figures grants nothing.
 *
 * RECONCILIATION. The earmarks of the live pegs can never exceed what is landed in that warehouse. When the landed figure falls
 * (a receipt reversed or corrected), the excess earmark is taken back, NEWEST peg first, and the watermark follows it down, so
 * the units that land again are earmarked once, not twice.
 */
export function grantReceipts(pegs: PegReceiptInput[], landedByWarehouse: WarehouseQty): Map<string, PegReceiptGrant> {
  const sorted = [...pegs].sort(byAge)
  const state = sorted.map((peg) => ({ peg, received: new Map(peg.receivedByWarehouse), seen: new Map(peg.seenByWarehouse) }))
  const warehouseIds = [...new Set([
    ...landedByWarehouse.keys(),
    ...sorted.flatMap((peg) => [...peg.receivedByWarehouse.keys(), ...peg.seenByWarehouse.keys()]),
  ])].sort()
  for (const warehouseId of warehouseIds) {
    const landed = Prisma.Decimal.max(ZERO, landedByWarehouse.get(warehouseId) ?? ZERO)
    let excess = state.reduce((sum, item) => sum.add(item.received.get(warehouseId) ?? ZERO), ZERO).sub(landed)
    for (const item of [...state].reverse()) {
      if (excess.lte(ZERO)) break
      const have = item.received.get(warehouseId) ?? ZERO
      const cut = Prisma.Decimal.min(excess, have)
      if (cut.gt(ZERO)) item.received.set(warehouseId, have.sub(cut))
      excess = excess.sub(cut)
    }
    const seen = state.length === 0 ? ZERO : Prisma.Decimal.min(...state.map((item) => item.seen.get(warehouseId) ?? ZERO))
    let pool = Prisma.Decimal.max(ZERO, landed.sub(seen))
    for (const item of state) {
      const room = Prisma.Decimal.max(ZERO, item.peg.qty.sub(sumQty(item.received)))
      const grant = Prisma.Decimal.min(pool, room)
      if (grant.gt(ZERO)) item.received.set(warehouseId, (item.received.get(warehouseId) ?? ZERO).add(grant))
      pool = pool.sub(grant)
      item.seen.set(warehouseId, landed)
    }
  }
  const out = new Map<string, PegReceiptGrant>()
  for (const item of state) {
    for (const [key, qty] of item.received) if (qty.lte(ZERO)) item.received.delete(key)
    for (const [key, qty] of item.seen) if (qty.lte(ZERO)) item.seen.delete(key)
    out.set(item.peg.id, { receivedByWarehouse: item.received, seenByWarehouse: item.seen, receivedQty: sumQty(item.received), seenLandedQty: sumQty(item.seen) })
  }
  return out
}

export function readWarehouseQty(json: unknown): WarehouseQty {
  const out: WarehouseQty = new Map()
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      const qty = new Prisma.Decimal(String(value ?? 0))
      if (qty.gt(ZERO)) out.set(key, qty)
    }
  }
  return out
}

export function warehouseQtyToJson(map: WarehouseQty): Record<string, string> {
  return Object.fromEntries([...map.entries()].filter(([, qty]) => qty.gt(ZERO)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, qty]) => [key, qty.toString()]))
}

/**
 * A peg's hold (received - absorbed) by warehouse. The absorbed units are taken out of the warehouses the line's own allocation
 * sits in first (`preferred`, most first), then the rest in id order, so what stays held is what is still in the warehouse it
 * landed in. The result sums to `hold` (capped at what was received).
 */
export function holdByWarehouse(received: WarehouseQty, hold: Decimal, preferred: string[]): WarehouseQty {
  const total = sumQty(received)
  let absorbed = Prisma.Decimal.max(ZERO, total.sub(hold))
  const left: WarehouseQty = new Map(received)
  const order = [...new Set([...preferred, ...[...received.keys()].sort()])]
  for (const warehouseId of order) {
    if (absorbed.lte(ZERO)) break
    const have = left.get(warehouseId)
    if (!have) continue
    const take = Prisma.Decimal.min(have, absorbed)
    left.set(warehouseId, have.sub(take))
    absorbed = absorbed.sub(take)
  }
  for (const [key, qty] of left) if (qty.lte(ZERO)) left.delete(key)
  return left
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
      id: true, poId: true, productId: true, qty: true, qtyReceived: true,
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

async function loadLineAllocationRows(tx: Tx, lines: Array<{ id: string; productId: string | null }>) {
  if (lines.length === 0) return []
  const productByLine = new Map(lines.map((line) => [line.id, line.productId]))
  const rows = await tx.orderAllocation.findMany({
    where: { lineId: { in: lines.map((line) => line.id) } },
    select: { lineId: true, productId: true, warehouseId: true, qty: true },
  })
  return rows.filter((row) => row.productId === productByLine.get(row.lineId))
}

/** The line's allocation: the order's WHOLE claim on the line's own product (retained through dispatch). */
async function loadLineAllocations(tx: Tx, lines: Array<{ id: string; productId: string | null }>): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>(lines.map((line) => [line.id, ZERO]))
  for (const row of await loadLineAllocationRows(tx, lines)) out.set(row.lineId, (out.get(row.lineId) ?? ZERO).add(row.qty))
  return out
}

/** Per line, the warehouses its own allocation sits in, most first (where absorbed peg units are taken from). */
async function loadLineAllocationWarehouses(tx: Tx, lines: Array<{ id: string; productId: string | null }>): Promise<Map<string, string[]>> {
  const byLine = new Map<string, WarehouseQty>()
  for (const row of await loadLineAllocationRows(tx, lines)) {
    const inner = byLine.get(row.lineId) ?? new Map<string, Decimal>()
    inner.set(row.warehouseId, (inner.get(row.warehouseId) ?? ZERO).add(row.qty))
    byLine.set(row.lineId, inner)
  }
  return new Map([...byLine].map(([lineId, inner]) => [lineId, [...inner.entries()].sort((a, b) => b[1].comparedTo(a[1]) || (a[0] < b[0] ? -1 : 1)).map(([id]) => id)]))
}

/**
 * Where each PO line's landed units actually landed: the cost layers laid for the line, by warehouse (the manual receipt, the ASN
 * alignment and the book-in all lay them in the warehouse they put the stock in), capped at the landed total. Landed units no
 * layer accounts for are attributed to the PO's destination warehouse (or, with none, to "unattributed").
 */
export async function loadLandedByWarehouse(
  tx: Tx,
  lines: Array<{ id: string; qtyReceived: Prisma.Decimal | number | string; destinationWarehouseId: string | null }>,
): Promise<Map<string, { total: Decimal; byWarehouse: WarehouseQty }>> {
  const out = new Map<string, { total: Decimal; byWarehouse: WarehouseQty }>()
  if (lines.length === 0) return out
  const landed = await loadPurchaseOrderLineLandedQty(tx, lines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))
  const layers = await tx.costLayer.groupBy({ by: ['poLineId', 'warehouseId'], where: { poLineId: { in: lines.map((line) => line.id) } }, _sum: { receivedQty: true } })
  const layersByLine = new Map<string, WarehouseQty>()
  for (const row of layers) {
    if (!row.poLineId) continue
    const inner = layersByLine.get(row.poLineId) ?? new Map<string, Decimal>()
    inner.set(row.warehouseId, (inner.get(row.warehouseId) ?? ZERO).add(row._sum.receivedQty ?? ZERO))
    layersByLine.set(row.poLineId, inner)
  }
  for (const line of lines) {
    const total = new Prisma.Decimal(landed.get(line.id)?.qty.toString() ?? '0')
    out.set(line.id, { total, byWarehouse: splitLandedByWarehouse(total, layersByLine.get(line.id) ?? new Map(), line.destinationWarehouseId) })
  }
  return out
}

/**
 * Bring the pegs' `receivedQty` into line with what has landed on their PO lines, per warehouse (see grantReceipts, which also
 * takes back earmarks a landed-quantity correction has made impossible). Writes only pegs that changed. The caller holds the peg
 * row locks (lockPegsForProducts) so two receipts' refreshes serialise.
 */
export async function refreshPegReceipts(tx: Tx, pegs: LoadedPeg[]): Promise<void> {
  if (pegs.length === 0) return
  const poLines = new Map(pegs.map((peg) => [peg.purchaseOrderLineId, peg.purchaseOrderLine]))
  const landed = await loadLandedByWarehouse(tx, [...poLines.values()].map((line) => ({ id: line.id, qtyReceived: line.qtyReceived, destinationWarehouseId: line.po.destinationWarehouseId })))
  const byPoLine = new Map<string, LoadedPeg[]>()
  for (const peg of pegs) byPoLine.set(peg.purchaseOrderLineId, [...(byPoLine.get(peg.purchaseOrderLineId) ?? []), peg])
  for (const [poLineId, group] of byPoLine) {
    const landedLine = landed.get(poLineId)
    if (!landedLine) continue
    const granted = grantReceipts(
      group.map((peg) => ({ id: peg.id, createdAt: peg.createdAt, qty: peg.qty, receivedByWarehouse: readWarehouseQty(peg.receivedByWarehouse), seenByWarehouse: readWarehouseQty(peg.seenLandedByWarehouse) })),
      landedLine.byWarehouse,
    )
    for (const peg of group) {
      const next = granted.get(peg.id)!
      const receivedJson = warehouseQtyToJson(next.receivedByWarehouse)
      const seenJson = warehouseQtyToJson(next.seenByWarehouse)
      if (
        next.receivedQty.equals(peg.receivedQty) && next.seenLandedQty.equals(peg.seenLandedQty)
        && JSON.stringify(receivedJson) === JSON.stringify(warehouseQtyToJson(readWarehouseQty(peg.receivedByWarehouse)))
        && JSON.stringify(seenJson) === JSON.stringify(warehouseQtyToJson(readWarehouseQty(peg.seenLandedByWarehouse)))
      ) continue
      const allocatedQty = Prisma.Decimal.min(peg.allocatedQty, next.receivedQty)
      await tx.salesOrderLinePeg.update({
        where: { id: peg.id },
        data: { receivedQty: next.receivedQty, seenLandedQty: next.seenLandedQty, allocatedQty, receivedByWarehouse: receivedJson, seenLandedByWarehouse: seenJson },
      })
      peg.receivedQty = next.receivedQty
      peg.seenLandedQty = next.seenLandedQty
      peg.allocatedQty = allocatedQty
      peg.receivedByWarehouse = receivedJson
      peg.seenLandedByWarehouse = seenJson
    }
  }
}

// ---------------------------------------------------------------------------
// The allocation seam
// ---------------------------------------------------------------------------

export type PegContext = {
  /** This order's live pegs, receipts refreshed. */
  own: LoadedPeg[]
  /** Holds other orders' pegs place on stock this order must leave alone: per product, in the warehouse the units landed in. */
  holds: Array<{ pegId: string; productId: string; warehouseId: string; qty: Decimal }>
  /** Per own line: the extra quantity the peg pass may add on top of the line's existing allocation. */
  ownExtraByLine: Map<string, Decimal>
  /** The same extra, per product and warehouse: the peg pass may add it only where the stock landed. */
  ownExtraByProductWarehouse: Map<string, WarehouseQty>
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
  const allocationWarehouses = await loadLineAllocationWarehouses(tx, lines)
  const settledByPeg = new Map<string, PegSettled>()
  const pegsByLine = new Map<string, LoadedPeg[]>()
  for (const peg of pegs) pegsByLine.set(peg.salesOrderLineId, [...(pegsByLine.get(peg.salesOrderLineId) ?? []), peg])
  for (const [lineId, group] of pegsByLine) {
    const line = group[0]!.salesOrderLine
    const settled = settlePegs(group, allocations.get(lineId) ?? ZERO, line.qty)
    for (const [pegId, value] of settled) settledByPeg.set(pegId, value)
  }
  const holdWarehouses = (peg: LoadedPeg, hold: Decimal): WarehouseQty =>
    holdByWarehouse(readWarehouseQty(peg.receivedByWarehouse), hold, allocationWarehouses.get(peg.salesOrderLineId) ?? [])

  const own = pegs.filter((peg) => peg.salesOrderLine.orderId === orderId)
  const ownExtraByLine = new Map<string, Decimal>()
  const ownExtraByProductWarehouse = new Map<string, WarehouseQty>()
  for (const peg of own) {
    const settled = settledByPeg.get(peg.id)
    if (!settled) continue
    ownExtraByLine.set(peg.salesOrderLineId, (ownExtraByLine.get(peg.salesOrderLineId) ?? ZERO).add(settled.hold))
    const productId = peg.salesOrderLine.productId!
    const inner = ownExtraByProductWarehouse.get(productId) ?? new Map<string, Decimal>()
    for (const [warehouseId, qty] of holdWarehouses(peg, settled.hold)) inner.set(warehouseId, (inner.get(warehouseId) ?? ZERO).add(qty))
    ownExtraByProductWarehouse.set(productId, inner)
  }

  const holds: PegContext['holds'] = []
  for (const peg of pegs) {
    if (peg.salesOrderLine.orderId === orderId) continue
    if (!(PEG_HOLDING_ORDER_STATUSES as readonly string[]).includes(peg.salesOrderLine.order.status)) continue
    // Defence in depth: the sweep ends a peg whose purchase order has closed, but until it runs that peg must not keep stock back.
    if ((PO_STATUSES_HOLDING_NOTHING as readonly string[]).includes(peg.purchaseOrderLine.po.status)) continue
    const settled = settledByPeg.get(peg.id)
    if (!settled || settled.hold.lte(ZERO)) continue
    for (const [warehouseId, qty] of holdWarehouses(peg, settled.hold)) {
      holds.push({ pegId: peg.id, productId: peg.salesOrderLine.productId!, warehouseId, qty })
    }
  }
  return { own, holds, ownExtraByLine, ownExtraByProductWarehouse }
}

/**
 * Take the other orders' held quantities out of the availability map (mutates it). A hold comes out of the warehouse the units
 * landed in and ONLY there, never below zero: a hold can only reduce what this order may take there, it can not create a
 * shortage in stock that is not there, and it never pulls stock out of another warehouse. (A hold with no recorded warehouse
 * comes from wherever the product has most stock.)
 */
export function applyPegHoldsToStockMap(stockMap: Map<string, Map<string, Decimal>>, holds: PegContext['holds']): void {
  for (const hold of holds) {
    const byWarehouse = stockMap.get(hold.productId)
    if (!byWarehouse) continue
    if (hold.warehouseId !== UNATTRIBUTED_WAREHOUSE) {
      const available = byWarehouse.get(hold.warehouseId)
      if (available) byWarehouse.set(hold.warehouseId, available.sub(Prisma.Decimal.min(available, hold.qty)))
      continue
    }
    let remaining = hold.qty
    const order = [...byWarehouse.keys()].sort((a, b) => byWarehouse.get(b)!.comparedTo(byWarehouse.get(a)!) || (a < b ? -1 : 1))
    for (const warehouseId of order) {
      if (remaining.lte(ZERO)) break
      const available = byWarehouse.get(warehouseId)!
      const take = Prisma.Decimal.min(available, remaining)
      byWarehouse.set(warehouseId, available.sub(take))
      remaining = remaining.sub(take)
    }
  }
}

/**
 * The receipt's peg pass (capPeggedLines): in each warehouse the order may hold at most what it already reserves there plus what
 * landed THERE for its pegs, so the pegged order cannot reserve existing stock in warehouse A because a receipt landed in B.
 * Mutates the availability map. Extra with no recorded warehouse may be taken in any warehouse.
 */
export function applyPegCapsToStockMap(
  stockMap: Map<string, Map<string, Decimal>>,
  extraByProductWarehouse: Map<string, WarehouseQty>,
  ownReservations: Array<{ productId: string; warehouseId: string; qty: Decimal }>,
): void {
  for (const [productId, extra] of extraByProductWarehouse) {
    const byWarehouse = stockMap.get(productId)
    if (!byWarehouse) continue
    const anywhere = extra.get(UNATTRIBUTED_WAREHOUSE) ?? ZERO
    for (const [warehouseId, available] of byWarehouse) {
      const held = ownReservations.filter((row) => row.productId === productId && row.warehouseId === warehouseId).reduce((sum, row) => sum.add(row.qty), ZERO)
      const cap = held.add(extra.get(warehouseId) ?? ZERO).add(anywhere)
      byWarehouse.set(warehouseId, Prisma.Decimal.min(available, cap))
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
    await endPeg(tx, peg, where.salesOrderLineIds?.includes(peg.salesOrderLineId) ? 'SALES_LINE_REMOVED' : 'PURCHASE_LINE_REMOVED', userId)
  }
  return pegs.length
}

/**
 * A FULL edit of a pristine purchase order deletes and recreates its lines, which would cascade away the pegs on them (the
 * stock promise and its history) with nothing recorded. So, before that delete: decide per live peg whether it can survive.
 *
 * A peg survives when its PO line is still in the edit (same line id) for the SAME product and the new quantity still covers it
 * (oldest pegs first, net of what has landed). Those lines are NOT deleted: the caller updates them in place (the amend path
 * does the same), so the peg keeps pointing at the same line row. Every other peg is ended here, with a reason and an activity
 * row, and goes with its line as before. Returns the ids of the lines the caller must keep.
 */
export async function reconcilePegsForPoLineRewrite(
  tx: Tx,
  poId: string,
  requestedLines: Array<{ poLineId?: string | null; productId: string; qty: number }>,
  userId: string | null,
): Promise<Set<string>> {
  const keep = new Set<string>()
  if (!(await tx.salesOrderLinePeg.findFirst({ where: { endedAt: null, purchaseOrderLine: { poId } }, select: { id: true } }))) return keep
  // After the purchase_orders row the caller holds, the peg rows ascending (the lock order of createPeg).
  await tx.$queryRaw(Prisma.sql`
    SELECT p.id FROM "sales_order_line_pegs" p JOIN "purchase_order_lines" l ON l.id = p."purchaseOrderLineId"
    WHERE p."endedAt" IS NULL AND l."poId" = ${poId} ORDER BY p.id FOR UPDATE OF p
  `)
  const pegs = await loadLivePegs(tx, { purchaseOrderLine: { poId } })
  const requested = new Map<string, { productId: string; qty: Decimal }>()
  for (const line of requestedLines) {
    if (line.poLineId && !requested.has(line.poLineId)) requested.set(line.poLineId, { productId: line.productId, qty: new Prisma.Decimal(line.qty) })
  }
  const landed = await loadPurchaseOrderLineLandedQty(tx, [...new Map(pegs.map((peg) => [peg.purchaseOrderLineId, peg.purchaseOrderLine])).values()].map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))
  const committed = new Map<string, Decimal>()
  for (const peg of pegs) {
    const want = requested.get(peg.purchaseOrderLineId)
    let survives = false
    if (want && want.productId === peg.purchaseOrderLine.productId) {
      const room = Prisma.Decimal.max(ZERO, want.qty.sub(landed.get(peg.purchaseOrderLineId)?.qty ?? ZERO).sub(committed.get(peg.purchaseOrderLineId) ?? ZERO))
      if (peg.qty.sub(peg.receivedQty).lte(room.add(EPSILON))) {
        survives = true
        committed.set(peg.purchaseOrderLineId, (committed.get(peg.purchaseOrderLineId) ?? ZERO).add(peg.qty.sub(peg.receivedQty)))
      }
    }
    if (survives) keep.add(peg.purchaseOrderLineId)
    else await endPeg(tx, peg, 'PURCHASE_LINE_REMOVED', userId)
  }
  return keep
}

/**
 * The cron's pass: end pegs whose order or purchase order has gone, whatever allocation did or did not run. Each batch is its
 * own transaction under the peg row locks. Returns the ended pegs so the caller can hand their released stock on.
 */
export async function sweepPegs(
  client: { $transaction: <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => Promise<T> },
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<{ checked: number; ended: EndedPeg[]; exhausted: boolean }> {
  const batch = opts.batch ?? 200
  // A full pass over every live peg, in keyset order (id > the last id of the previous batch), one transaction per batch. No
  // cursor is persisted because none is needed: each run starts at the beginning and runs to the end, so no peg is ever skipped
  // however many are live. `maxBatches` only bounds a pathological run (default 500 batches = 100,000 pegs); `exhausted`
  // says whether the pass reached the end.
  const maxBatches = opts.maxBatches ?? 500
  let after: string | null = null
  let checked = 0
  const ended: EndedPeg[] = []
  for (let round = 0; round < maxBatches; round += 1) {
    const cursor: string | null = after
    const result: { ids: string[]; checked: number; ended: EndedPeg[] } = await client.$transaction(async (tx): Promise<{ ids: string[]; checked: number; ended: EndedPeg[] }> => {
      const ids: string[] = (await tx.salesOrderLinePeg.findMany({
        where: { endedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: batch,
      })).map((row) => row.id)
      if (ids.length === 0) return { ids, checked: 0, ended: [] }
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "sales_order_line_pegs" WHERE id IN (${Prisma.join(ids)}) AND "endedAt" IS NULL ORDER BY id FOR UPDATE`)
      const pegs = await loadLivePegs(tx, { id: { in: ids } })
      return { ids, checked: pegs.length, ended: await evaluatePegs(tx, pegs) }
    }, { maxWait: 5000, timeout: 20000 })
    if (result.ids.length === 0) return { checked, ended, exhausted: true }
    checked += result.checked
    ended.push(...result.ended)
    after = result.ids[result.ids.length - 1]!
    if (result.ids.length < batch) return { checked, ended, exhausted: true }
  }
  return { checked, ended, exhausted: false }
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
