import type { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { CONTRIBUTING_LANDED_COST_LINK_WHERE } from '@/lib/domain/purchasing/landed-cost-service'
import { loadPurchaseOrderLineLandedQty, PO_LANDED_QTY_EPSILON } from '@/lib/domain/inventory/po-line-landed-quantity'
import { findLiveAsnBlocks, type LiveAsnBlock } from '@/lib/domain/wms/po-receipt-asn-guard'

/**
 * EDITING A PURCHASE ORDER AT EVERY STAGE BETWEEN DRAFT AND RECEIPT, AND WHEN PART-RECEIVED.
 *
 * TWO MODES, chosen by facts read under the `purchase_orders` row lock (never by status alone: a WMS book-in or alignment
 * can land stock on an order whose status did not move):
 *
 *  - FULL (pristine): nothing references the order's line ids — no receipt, no bill, no return, no landed quantity (WMS credit
 *    included) and no `wms_asn_line_maps` row of any state. The existing draft edit applies (lines deleted and recreated,
 *    every header field open). Allowed in every editable status, so the quote prices can be entered at QUOTE_RECEIVED and a
 *    typo fixed at PO_SENT.
 *  - AMEND: anything else. Line ids are preserved (receipt lines, cost layers, bill lines, return lines and ASN maps point at
 *    them) and the rules below apply. This module is the pure half: the rules, with no I/O beyond `readPoEditFacts`.
 *
 * WHY PRICE AND COST ARE FROZEN ON TOUCHED LINES. The cost layers carry the received price and its landed-cost share; the
 * bill carries the billed price. Neither is revalued by a PO edit, so a price change on those lines would leave the order
 * saying one thing and the books another. A correction on received or billed goods is a bill / credit-note matter.
 *
 * WHY QUANTITY AND LINE-SET EDITS ARE REFUSED ON A PART-RECEIVED ORDER THAT CARRIES COST LINES. The landed-cost share of
 * every unit depends on the quantity and value of ALL lines (`allocateLandedCost`). After something has landed, changing
 * any line's quantity, price or the line set moves the share of units already laid in cost layers, and no goods-PO edit
 * revalues them. Before anything lands, or with no cost lines, there is nothing to disturb.
 */

export const PO_EDITABLE_STATUSES: readonly PurchaseOrderStatus[] = [
  'DRAFT',
  'RFQ_SENT',
  'QUOTE_RECEIVED',
  'PO_SENT',
  'SHIPPED',
  'PARTIALLY_RECEIVED',
]

export function isPurchaseOrderEditableStatus(status: string): boolean {
  return (PO_EDITABLE_STATUSES as readonly string[]).includes(status)
}

export const PO_EDIT_REFUSED_STATUS_MESSAGE =
  'This purchase order can no longer be edited. Only orders from Draft through Part-received can be changed.'

export type PoEditLineFact = {
  id: string
  productId: string
  sku: string | null
  qty: number
  unitCostForeign: number
  unitCostBase: number
  totalForeign: number
  totalBase: number
  taxForeign: number
  taxBase: number
  landedQty: number
  billedQty: number
  returnedQty: number
  receiptLineCount: number
  liveAsn: LiveAsnBlock[]
}

export type PoEditCostLineFact = {
  id: string
  description: string
  amountForeign: number
  amountBase: number
  vatable: boolean
  distributionMethod: string
}

export type PoEditFacts = {
  status: PurchaseOrderStatus
  reference: string
  lines: PoEditLineFact[]
  costLines: PoEditCostLineFact[]
  billCount: number
  receiptCount: number
  returnCount: number
  asnMapCount: number
  /** A non-zero direct cost line, or a contributing linked freight order with a non-zero cost line. */
  hasCostLines: boolean
  anyLanded: boolean
  anyLiveAsn: boolean
  pristine: boolean
}

export function lineIsTouched(line: Pick<PoEditLineFact, 'landedQty' | 'billedQty' | 'returnedQty' | 'receiptLineCount'>): boolean {
  return line.landedQty > PO_LANDED_QTY_EPSILON
    || line.billedQty > PO_LANDED_QTY_EPSILON
    || line.returnedQty > PO_LANDED_QTY_EPSILON
    || line.receiptLineCount > 0
}

/** The lowest quantity a line may be edited down to: what has landed, been billed or been returned. */
export function lineQtyFloor(line: Pick<PoEditLineFact, 'landedQty' | 'billedQty' | 'returnedQty'>): number {
  return Math.max(line.landedQty, line.billedQty, line.returnedQty, 0)
}

export async function readPoEditFacts(tx: Prisma.TransactionClient, id: string): Promise<PoEditFacts | null> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id },
    select: {
      status: true,
      reference: true,
      lines: {
        select: {
          id: true,
          productId: true,
          qty: true,
          qtyReceived: true,
          qtyReturned: true,
          unitCostForeign: true,
          unitCostBase: true,
          totalForeign: true,
          totalBase: true,
          taxForeign: true,
          taxBase: true,
          product: { select: { sku: true } },
          _count: { select: { receiptLines: true } },
          invoiceLines: { select: { qtyBilled: true } },
        },
        orderBy: { id: 'asc' },
      },
      freightCostLines: {
        select: { id: true, description: true, amountForeign: true, amountBase: true, vatable: true, distributionMethod: true },
        orderBy: { id: 'asc' },
      },
      landedCostLinks: {
        where: { ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
        select: { freightPO: { select: { freightCostLines: { select: { amountBase: true } } } } },
      },
      _count: { select: { invoices: true, receipts: true, returns: true } },
    },
  })
  if (!po) return null

  const lineIds = po.lines.map((l) => l.id)
  const landed = await loadPurchaseOrderLineLandedQty(tx, po.lines.map((l) => ({ id: l.id, qtyReceived: l.qtyReceived })))
  const liveBlocks = await findLiveAsnBlocks(tx, lineIds)
  const asnMapCount = lineIds.length === 0
    ? 0
    : await tx.wmsAsnLineMap.count({ where: { sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: { in: lineIds } } })

  const lines: PoEditLineFact[] = po.lines.map((l) => ({
    id: l.id,
    productId: l.productId,
    sku: l.product?.sku ?? null,
    qty: Number(l.qty),
    unitCostForeign: Number(l.unitCostForeign),
    unitCostBase: Number(l.unitCostBase),
    totalForeign: Number(l.totalForeign),
    totalBase: Number(l.totalBase),
    taxForeign: Number(l.taxForeign),
    taxBase: Number(l.taxBase),
    landedQty: landed.get(l.id)?.qtyNumber ?? Number(l.qtyReceived),
    billedQty: l.invoiceLines.reduce((sum, il) => sum + Number(il.qtyBilled), 0),
    returnedQty: Number(l.qtyReturned),
    receiptLineCount: l._count.receiptLines,
    liveAsn: liveBlocks.filter((b) => b.poLineId === l.id),
  }))
  const costLines: PoEditCostLineFact[] = po.freightCostLines.map((c) => ({
    id: c.id,
    description: c.description,
    amountForeign: Number(c.amountForeign),
    amountBase: Number(c.amountBase),
    vatable: c.vatable,
    distributionMethod: c.distributionMethod,
  }))
  const hasCostLines = costLines.some((c) => c.amountBase !== 0)
    || po.landedCostLinks.some((link) => link.freightPO.freightCostLines.some((c) => Number(c.amountBase) !== 0))
  const anyLanded = lines.some((l) => l.landedQty > PO_LANDED_QTY_EPSILON)
  const billCount = po._count.invoices
  const receiptCount = po._count.receipts
  const returnCount = po._count.returns
  const pristine = billCount === 0 && receiptCount === 0 && returnCount === 0 && asnMapCount === 0 && !anyLanded
    && !lines.some(lineIsTouched)
  return {
    status: po.status,
    reference: po.reference,
    lines,
    costLines,
    billCount,
    receiptCount,
    returnCount,
    asnMapCount,
    hasCostLines,
    anyLanded,
    anyLiveAsn: liveBlocks.length > 0,
    pristine,
  }
}

export type RequestedEditLine = { poLineId?: string | null; productId: string; qty: number }

export type AmendPlan =
  | { ok: false; error: string }
  | {
      ok: true
      /** Existing lines that stay, with the requested index that targets each. */
      keep: Array<{ fact: PoEditLineFact; requestIndex: number; touched: boolean; qtyChanged: boolean }>
      /** Requested indexes that become new lines (no id, or a product swap on an untouched line). */
      create: number[]
      remove: PoEditLineFact[]
    }

function fmt(n: number): string {
  return String(Math.round(n * 10000) / 10000)
}

function skuOf(line: { sku: string | null; id: string }): string {
  return line.sku ?? line.id
}

export function liveAsnLineMessage(line: PoEditLineFact, what: string): string {
  const asn = line.liveAsn.map((b) => `${b.externalAsnId}, ${b.status}`).join('; ')
  return `${skuOf(line)} has an open warehouse ASN (${asn}), so its quantity cannot be ${what}. Book the goods in through the ASN or retire it first.`
}

export function planLineAmend(facts: PoEditFacts, requested: readonly RequestedEditLine[]): AmendPlan {
  const byId = new Map(facts.lines.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const keep: Array<{ fact: PoEditLineFact; requestIndex: number; touched: boolean; qtyChanged: boolean }> = []
  const create: number[] = []
  const removeIds = new Set(facts.lines.map((l) => l.id))

  for (const [index, req] of requested.entries()) {
    if (!Number.isFinite(req.qty) || req.qty <= 0) return { ok: false, error: 'Each line needs a quantity greater than zero. To drop a line, remove it.' }
    if (!req.poLineId) {
      create.push(index)
      continue
    }
    const fact = byId.get(req.poLineId)
    if (!fact) return { ok: false, error: 'A line in the request does not belong to this purchase order. Reload the order and try again.' }
    if (seen.has(req.poLineId)) return { ok: false, error: 'The same order line was sent twice.' }
    seen.add(req.poLineId)
    const touched = lineIsTouched(fact)
    if (req.productId !== fact.productId) {
      // A product swap is a removal plus an addition, which a touched line cannot take.
      if (touched) return { ok: false, error: `${skuOf(fact)} has been received, billed or returned, so its product cannot be changed.` }
      create.push(index)
      continue
    }
    removeIds.delete(fact.id)
    const floor = lineQtyFloor(fact)
    if (req.qty < floor - PO_LANDED_QTY_EPSILON) {
      return {
        ok: false,
        error: `${skuOf(fact)} cannot go below ${fmt(floor)}: that much has already been received, billed or returned. To drop the rest of this line, set it to ${fmt(floor)}.`,
      }
    }
    const qtyChanged = Math.abs(req.qty - fact.qty) > PO_LANDED_QTY_EPSILON
    if (qtyChanged && req.qty < fact.qty && fact.liveAsn.length > 0) {
      return { ok: false, error: liveAsnLineMessage(fact, 'reduced') }
    }
    keep.push({ fact, requestIndex: index, touched, qtyChanged })
  }

  // Lines the request does not keep — absent from it, or swapped to another product — are removed.
  const removed = facts.lines.filter((l) => removeIds.has(l.id))
  for (const line of removed) {
    if (lineIsTouched(line)) return { ok: false, error: `${skuOf(line)} has been received, billed or returned, so it cannot be removed from the order.` }
    if (line.liveAsn.length > 0) return { ok: false, error: liveAsnLineMessage(line, 'removed') }
  }

  if (keep.length + create.length === 0) return { ok: false, error: 'A purchase order needs at least one line.' }

  if (facts.anyLanded) {
    const finalQtyByLine = new Map<string, number>()
    for (const k of keep) finalQtyByLine.set(k.fact.id, requested[k.requestIndex]!.qty)
    const outstandingLeft = create.length > 0
      || [...finalQtyByLine.entries()].some(([lineId, qty]) => qty - (byId.get(lineId)?.landedQty ?? 0) > PO_LANDED_QTY_EPSILON)
    if (!outstandingLeft) {
      return { ok: false, error: 'This edit would leave nothing outstanding on the order. To drop the unreceived balance, use Close instead.' }
    }
    if (facts.hasCostLines && (keep.some((k) => k.qtyChanged) || create.length > 0 || removed.length > 0)) {
      return {
        ok: false,
        error: 'This order has freight or other cost lines spread across all of its lines, and part of it has been received. '
          + 'Changing quantities or adding or removing lines would change the cost of goods already in stock. '
          + 'Close the unreceived balance and raise a new order for any extra goods.',
      }
    }
  }

  return { ok: true, keep, create, remove: removed }
}

/** Is a requested net unit cost (foreign, post-discount) the stored one? Tolerance covers the form's rounding round trip. */
export function unitCostMatchesStored(requestedNet: number, stored: number): boolean {
  return Math.abs(requestedNet - stored) <= Math.max(0.0001, Math.abs(stored) * 0.0001)
}

export function normaliseCostLinesForCompare(
  lines: ReadonlyArray<{ description?: string | null; amountForeign: number; vatable: boolean; distributionMethod: string }>,
): string[] {
  return lines
    .filter((l) => l.amountForeign > 0)
    .map((l) => `${(l.description || 'Additional cost').trim()}|${(Math.round(l.amountForeign * 100) / 100).toFixed(2)}|${l.vatable ? 1 : 0}|${l.distributionMethod}`)
    .sort()
}
