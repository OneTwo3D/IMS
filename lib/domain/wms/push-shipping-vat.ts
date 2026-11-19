const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * The shipping VAT of an order: the order's tax (what the payload's TotalVat carries, WooCommerce's total tax) minus the tax of EVERY stored line
 * (fee lines and refunded lines included, because the order tax still holds them). IMS does not store the shipping tax on its own, so this is the
 * remainder; never negative, 2dp. Zero when the order has no shipping charge, when the order has no shipping VAT or the figures do not support one.
 */
export function deriveShippingVat(order: { taxForeign: unknown; shippingForeign?: unknown; lines: Array<{ taxForeign?: unknown }> }): number {
  // No shipping charge, no shipping VAT: a remainder on an order that ships free is a rounding leftover (or header and line tax that no longer reconcile), not VAT on shipping.
  if (toNumber(order.shippingForeign) <= 0) return 0
  const remainder = toNumber(order.taxForeign) - order.lines.reduce((sum, line) => sum + toNumber(line.taxForeign), 0)
  return remainder > 0.005 ? Math.round(remainder * 100) / 100 : 0
}

