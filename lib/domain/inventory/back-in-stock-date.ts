import { db } from '@/lib/db'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { resolvePurchaseOrderLineLandedQty } from '@/lib/domain/inventory/po-line-landed-quantity'
import { dateOnly } from '@/lib/domain/math/date-window'
import { INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'
import { effectiveLineEta } from '@/lib/domain/purchasing/line-eta'

/**
 * ESTIMATED BACK-IN-STOCK DATE for a zero-availability product (customer-facing; o3d-taro).
 *
 * The date comes ONLY from committed inbound supply: purchase-order lines on INCOMING_PO_STATUSES (GOODS orders) with units still
 * outstanding, and WMS ASNs that cover them. OUTSTANDING means not yet landed by the one definition the rest of IMS uses
 * (lib/domain/inventory/po-line-landed-quantity.ts: qtyReceived plus the unabsorbed WMS alignment credit over EVERY ASN row of the line,
 * closed and retired included), so units WMS alignment or a book-in already brought into stock never date a future arrival. A past promise must never reach a customer and no date beats a wrong one, so:
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
  expectedDelivery: Date | null
  po: { expectedDelivery: Date | null }
}

export type BackInStockAsnLine = {
  /** The purchase-order line the ASN line was raised for (WmsAsnLineMap.sourceLineId). */
  sourceLineId: string
  expectedQty: DecimalInput
  qtyAccountedViaSnapshot: DecimalInput
  qtyAccountedViaReceipt: DecimalInput
  /** The ASN header. `status` decides whether the row can DATE supply; every row, whatever its status, counts as landed stock. */
  asn: { eta: Date | null; status: string; closedAt?: Date | null }
}

/** ASN statuses that still expect units: only these rows can date a line's remaining supply. */
const OPEN_ASN_STATUSES: ReadonlyArray<string> = ['OPEN', 'PARTIALLY_BOOKED_IN']

/**
 * `asnLines` must be EVERY ASN row of the lines (closed and retired included): they all feed the landed quantity, and only the open ones
 * date supply.
 */
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
    const lineAsnRows = asnByLine.get(line.id) ?? []
    const landed = resolvePurchaseOrderLineLandedQty({ poLineId: line.id, qtyReceived: line.qtyReceived, wmsAsnLines: lineAsnRows })
    let outstanding = toDecimal(line.qty).sub(landed.qty)
    if (outstanding.lte(0)) continue
    for (const asnLine of lineAsnRows) {
      // closeAsnShort sets closedAt and leaves the status, so a closed-short ASN still reads PARTIALLY_BOOKED_IN: closedAt wins.
      if (asnLine.asn.closedAt || !OPEN_ASN_STATUSES.includes(asnLine.asn.status)) continue
      // The row's own landed units are max(snapshot, receipt): a receipt can absorb the very units alignment credited, so the two
      // counters are not added.
      const accounted = toDecimal(asnLine.qtyAccountedViaSnapshot).gt(toDecimal(asnLine.qtyAccountedViaReceipt))
        ? toDecimal(asnLine.qtyAccountedViaSnapshot)
        : toDecimal(asnLine.qtyAccountedViaReceipt)
      const remaining = toDecimal(asnLine.expectedQty).sub(accounted)
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
      id: true, productId: true, qty: true, qtyReceived: true, expectedDelivery: true,
      po: { select: { expectedDelivery: true } },
    },
  })
  if (lines.length === 0) return new Map()
  const asnLines = await db.wmsAsnLineMap.findMany({
    where: {
      sourceType: 'PURCHASE_ORDER_LINE',
      // NO status filter: closed and retired rows still hold landed units (po-line-landed-quantity.ts). The resolver dates from open ones only.
      sourceLineId: { in: lines.map((line) => line.id) },
    },
    select: {
      sourceLineId: true, expectedQty: true, qtyAccountedViaSnapshot: true, qtyAccountedViaReceipt: true,
      asn: { select: { eta: true, status: true, closedAt: true } },
    },
  })
  return resolveBackInStockDates(lines, asnLines, now)
}
