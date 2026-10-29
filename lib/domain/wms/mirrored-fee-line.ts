/**
 * Which stored sales-order lines are MIRRORED WOOCOMMERCE FEE LINES (the wclc "EU Import Duty", "EU Customs Fee",
 * the over-EUR-150 "Import Duty", and any older fee).
 *
 * A fee is not goods. The warehouse cannot pick it and has no SKU for it, so it is never sent as an order item. This
 * matches the woo-mintsoft plugin (wc_mintsoft_orders.py): it reads `fee_lines` only to add their net and VAT to its
 * own gross check ("fees_net", "fees_vat"), builds `OrderItems` from `line_items` alone, and sends `TotalVat` as the
 * WooCommerce order's total tax (which includes the fees' VAT). IMS does the same: fee lines are skipped, and their
 * VAT stays in TotalVat.
 *
 * HOW A FEE LINE IS RECOGNISED, in order of authority:
 *   1. `wclcFeeKind` is set - the marker persisted by the importer from the fee line's own `_wclc_fee_kind` meta.
 *   2. Otherwise (a fee line imported before that marker existed, or one without the wclc meta) the SHAPE the importer
 *      gives every fee line and nothing else it imports: no SKU, no product and no WooCommerce line-item id (all three READ and found empty). A goods
 *      line carries a WooCommerce line-item id even when IMS holds no such product, so an unknown SKU-less goods line
 *      is NOT mistaken for a fee and still fails the push, as before.
 */
export type FeeLineCandidate = {
  sku?: string | null
  wclcFeeKind?: string | null
  productId?: string | null
  externalLineItemId?: number | null
}

export function isMirroredFeeLine(line: FeeLineCandidate): boolean {
  if (line.wclcFeeKind != null && line.wclcFeeKind !== '') return true
  const noSku = line.sku == null || line.sku.trim() === ''
  // EXPLICITLY null, not merely absent: a caller that did not select these columns learns nothing about the line.
  return noSku && line.productId === null && line.externalLineItemId === null
}
