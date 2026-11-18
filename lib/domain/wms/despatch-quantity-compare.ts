/**
 * THE WAREHOUSE'S DESPATCHED QUANTITIES, COMPARED WITH WHAT IMS BOOKS (o3d-hqvrp.115).
 *
 * IMS books a despatch from its own shipment rows, not from what the warehouse reports it sent, so a warehouse that shipped more
 * (an amendment that never propagated, a substitution, an over-pick) or fewer (a short despatch without a split) than IMS books leaves
 * on-hand drifting with nothing raised. This module only DETECTS the difference, per SKU. It never changes what is booked: an
 * operator decides what the difference means. Pure, so the rule is testable without a database.
 */

export const WMS_DESPATCH_QTY_MISMATCH_CATEGORY = 'DESPATCH_QTY_MISMATCH'

export type DespatchQuantityLine = { sku: string; qty: number }

export type DespatchQuantityMismatch = {
  sku: string
  /** What the warehouse reports despatched. */
  wmsQty: number
  /** What IMS books for the order. */
  imsQty: number
}

function bySku(lines: ReadonlyArray<DespatchQuantityLine>): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of lines) {
    const sku = line.sku.trim()
    if (!sku) continue
    out.set(sku, (out.get(sku) ?? 0) + Number(line.qty))
  }
  return out
}

/** Every SKU whose summed quantity differs between the warehouse and IMS, in SKU order. Empty: they agree. */
export function compareDespatchedQuantities(
  wmsLines: ReadonlyArray<DespatchQuantityLine>,
  imsLines: ReadonlyArray<DespatchQuantityLine>,
): DespatchQuantityMismatch[] {
  const wms = bySku(wmsLines)
  const ims = bySku(imsLines)
  const skus = [...new Set([...wms.keys(), ...ims.keys()])].sort()
  const out: DespatchQuantityMismatch[] = []
  for (const sku of skus) {
    const wmsQty = wms.get(sku) ?? 0
    const imsQty = ims.get(sku) ?? 0
    if (Math.abs(wmsQty - imsQty) > 0.0001) out.push({ sku, wmsQty, imsQty })
  }
  return out
}

export function describeDespatchQuantityMismatch(
  connectorLabel: string,
  orderRef: string,
  mismatches: ReadonlyArray<DespatchQuantityMismatch>,
): string {
  const detail = mismatches.map((m) => `${m.sku}: ${connectorLabel} despatched ${m.wmsQty}, IMS booked ${m.imsQty}`).join('; ')
  return `${connectorLabel} despatched order ${orderRef} in quantities that differ from what IMS booked (${detail}). `
    + 'IMS changed nothing: the stock movement and cost are as booked from its own shipment rows. '
    + 'Check what physically left, then correct stock by an adjustment if the booking is wrong.'
}
