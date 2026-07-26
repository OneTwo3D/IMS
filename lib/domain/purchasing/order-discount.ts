/**
 * Purchase-order header ("order-level") discount math, shared by createPurchaseOrder and
 * submitSupplierQuote so a requote applies the discount the SAME way the order was created (o3d-lx1).
 *
 * All amounts are in the supplier (foreign) currency and the same tax convention as the unit costs:
 * GROSS when the PO's prices include VAT, NET otherwise. `subtotalForeign` is always the NET (pre-tax)
 * line subtotal; `taxForeign` is the tax on it. Number math (float + round-to-4dp) intentionally mirrors
 * createPurchaseOrder so extracting it here is behaviour-preserving.
 */

const round4 = (n: number): number => Math.round(n * 10000) / 10000

/**
 * Resolve the order discount amount to apply, in the entry (gross-if-inclVat, else net) convention, for a
 * given subtotal. A PERCENTAGE discount (discountStr like "10%") is re-evaluated against the current
 * subtotal so it scales with a requote; a FIXED discount keeps its amount, capped at the subtotal so it
 * can never exceed the goods value.
 */
export function resolveHeaderOrderDiscountForeign(params: {
  discountStr: string | null
  originalDiscountForeign: number
  subtotalForeign: number
  taxForeign: number
  inclVat: boolean
}): number {
  const { discountStr, originalDiscountForeign, subtotalForeign, taxForeign, inclVat } = params
  // The discount is entered in the same convention as unit costs: gross (net + tax) when inclVat, else net.
  const conventionSubtotal = inclVat ? subtotalForeign + taxForeign : subtotalForeign
  if (conventionSubtotal <= 0) return 0

  const percent = parseDiscountPercent(discountStr)
  if (percent !== null) {
    return round4(Math.min(conventionSubtotal, conventionSubtotal * percent))
  }
  // Fixed amount: keep it, capped at the (new) subtotal so it never over-discounts.
  return round4(Math.min(Math.max(0, originalDiscountForeign), conventionSubtotal))
}

/**
 * Parse a "10%" / "10 %" / ".5%" discount string into a fraction (0.1), or null when it is not a
 * percentage. Accepts a leading-dot form (".5%") because the PO form parses percentage text with
 * parseFloat, which accepts it — the requote resolver must recognise the same percentages it stored.
 */
export function parseDiscountPercent(discountStr: string | null): number | null {
  if (!discountStr) return null
  const match = /^\s*(\d*\.?\d+)\s*%\s*$/.exec(discountStr)
  if (!match) return null
  const pct = Number(match[1])
  if (!Number.isFinite(pct) || pct < 0) return null
  return pct / 100
}

/**
 * Apply an order-level discount to already-computed totals, splitting it proportionally across the net
 * subtotal and the line tax so each tax-rate bucket drops by the same percentage. Mirrors
 * createPurchaseOrder's split exactly. Returns the post-discount totals plus the net/VAT breakdown.
 */
export function applyHeaderOrderDiscount(params: {
  subtotalForeign: number
  subtotalBase: number
  taxForeign: number
  taxBase: number
  orderDiscountForeign: number
  inclVat: boolean
  fxRate: number
}): {
  subtotalForeign: number
  subtotalBase: number
  taxForeign: number
  taxBase: number
  discountNetForeign: number
  discountNetBase: number
  discountVatForeign: number
  discountVatBase: number
} {
  const { subtotalForeign, subtotalBase, taxForeign, taxBase, orderDiscountForeign, inclVat, fxRate } = params

  const zero = {
    subtotalForeign, subtotalBase, taxForeign, taxBase,
    discountNetForeign: 0, discountNetBase: 0, discountVatForeign: 0, discountVatBase: 0,
  }
  if (!(orderDiscountForeign > 0) || !(subtotalForeign > 0) || !(fxRate > 0)) return zero

  const grossBase = subtotalForeign + taxForeign
  const netFrac = grossBase > 0 ? subtotalForeign / grossBase : 1
  const grossDisc = inclVat ? orderDiscountForeign : orderDiscountForeign / Math.max(netFrac, 0.000001)
  const cappedGrossDisc = Math.min(grossDisc, grossBase)
  const discountNetForeign = round4(cappedGrossDisc * netFrac)
  const discountVatForeign = round4(cappedGrossDisc - discountNetForeign)
  const discountNetBase = round4(discountNetForeign / fxRate)
  const discountVatBase = round4(discountVatForeign / fxRate)

  return {
    subtotalForeign: Math.max(0, subtotalForeign - discountNetForeign),
    subtotalBase: Math.max(0, subtotalBase - discountNetBase),
    taxForeign: Math.max(0, taxForeign - discountVatForeign),
    taxBase: Math.max(0, taxBase - discountVatBase),
    discountNetForeign,
    discountNetBase,
    discountVatForeign,
    discountVatBase,
  }
}
