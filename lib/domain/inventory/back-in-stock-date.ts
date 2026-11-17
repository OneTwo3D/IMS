import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { dateOnly } from '@/lib/domain/math/date-window'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'
import { effectiveLineEta } from '@/lib/domain/purchasing/line-eta'

/**
 * ESTIMATED BACK-IN-STOCK DATE for a zero-availability product (customer-facing; o3d-taro).
 *
 * The date comes ONLY from committed inbound supply: purchase-order lines on INCOMING_PO_STATUSES (GOODS orders) with units still
 * outstanding, and WMS ASNs that cover them. A past promise must never reach a customer and no date beats a wrong one, so:
 *
 *   - a supply source's date is the ASN's eta when the line is covered by an open ASN (OPEN / PARTIALLY_BOOKED_IN) that has one, else the
 *     line's effective ETA (its own date, else the order's: lib/domain/purchasing/line-eta.ts). An ASN with no eta falls through to the PO date;
 *   - a source resolved to a date BEFORE today (UTC calendar day) is LATE and is dropped, never rolled forward and never shown;
 *   - a source with no date is dropped;
 *   - the answer is the earliest date left, or null (the caller then clears the storefront value).
 */

export type BackInStockPoLine = {
  id: string
  productId: string
  qty: DecimalInput
  qtyReceived: DecimalInput
  qtyReturned: DecimalInput
  expectedDelivery: Date | null
  po: { expectedDelivery: Date | null }
}

export type BackInStockAsnLine = {
  /** The purchase-order line the ASN line was raised for (WmsAsnLineMap.sourceLineId). */
  sourceLineId: string
  expectedQty: DecimalInput
  qtyAccountedViaSnapshot: DecimalInput
  qtyAccountedViaReceipt: DecimalInput
  asn: { eta: Date | null }
}

/** Pure: product id to its earliest committed, not-late arrival date (YYYY-MM-DD). Products with none are absent. */
export function resolveBackInStockDates(lines: BackInStockPoLine[], asnLines: BackInStockAsnLine[], now: Date): Map<string, string> {
  const today = dateOnly(now)
  const asnByLine = new Map<string, BackInStockAsnLine[]>()
  for (const asnLine of asnLines) {
    const list = asnByLine.get(asnLine.sourceLineId) ?? []
    list.push(asnLine)
    asnByLine.set(asnLine.sourceLineId, list)
  }
  const earliest = new Map<string, string>()
  const consider = (productId: string, date: Date | null) => {
    if (!date) return
    const day = dateOnly(date)
    if (day < today) return // late: a past promise is never shown
    const existing = earliest.get(productId)
    if (!existing || day < existing) earliest.set(productId, day)
  }
  for (const line of lines) {
    let outstanding = toDecimal(line.qty).sub(toDecimal(line.qtyReceived)).sub(toDecimal(line.qtyReturned))
    if (outstanding.lte(0)) continue
    for (const asnLine of asnByLine.get(line.id) ?? []) {
      const remaining = toDecimal(asnLine.expectedQty).sub(toDecimal(asnLine.qtyAccountedViaSnapshot)).sub(toDecimal(asnLine.qtyAccountedViaReceipt))
      // An ASN without an eta does not cover the units for dating: they fall through to the PO date.
      if (remaining.lte(0) || !asnLine.asn.eta) continue
      consider(line.productId, asnLine.asn.eta)
      outstanding = outstanding.sub(remaining)
    }
    if (outstanding.gt(0)) consider(line.productId, effectiveLineEta(line.expectedDelivery, line.po.expectedDelivery))
  }
  return earliest
}

/**
 * Loads the committed supply for the given products and resolves their dates. Read-only. The caller passes only products it already
 * knows are at zero availability and are simple stockable products; this does not decide that.
 */
export async function loadBackInStockDates(productIds: string[], now: Date = new Date()): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map()
  const lines = await db.purchaseOrderLine.findMany({
    where: { productId: { in: productIds }, po: { type: 'GOODS', status: { in: INCOMING_PO_STATUSES } } },
    select: {
      id: true, productId: true, qty: true, qtyReceived: true, qtyReturned: true, expectedDelivery: true,
      po: { select: { expectedDelivery: true } },
    },
  })
  if (lines.length === 0) return new Map()
  const asnLines = await db.wmsAsnLineMap.findMany({
    where: {
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: { in: lines.map((line) => line.id) },
      asn: { status: { in: ['OPEN', 'PARTIALLY_BOOKED_IN'] } },
    },
    select: {
      sourceLineId: true, expectedQty: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true,
      asn: { select: { eta: true } },
    },
  })
  return resolveBackInStockDates(lines, asnLines, now)
}
