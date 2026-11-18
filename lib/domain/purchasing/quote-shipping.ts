/**
 * A supplier-quoted shipping cost on a requote, as a FREIGHT COST LINE (not only the directFreight aggregate).
 *
 * WHY. submitSupplierQuote used to write the supplier's shipping only into `directFreightForeign/Base` and the order total. Landed
 * cost at receipt and the bill-from-PO flow read the order's `freightCostLines`, so the shipping was never capitalised into stock cost
 * and could not be billed as a cost line; the requote also rebuilt the order tax from line tax alone, dropping the VAT on the buyer's
 * own vatable cost lines.
 *
 * BEHIND A FLAG. The setting `supplier_quote_shipping_landed_enabled` (default OFF) turns this on, because it changes the order total
 * (the buyer's cost lines now stay in the aggregate beside the supplier's shipping) and what receipts capitalise. OPEN OWNER QUESTION:
 * does the supplier's shipping REPLACE a shipping estimate the buyer entered, or add to it? This plan ADDS (the safe, never-lose-a-cost
 * choice) and replaces only the line a previous requote created.
 *
 * Pure and synchronous: Decimal throughout.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const SUPPLIER_QUOTE_SHIPPING_SETTING_KEY = 'supplier_quote_shipping_landed_enabled'
/** Marks the cost line a requote created, so the next requote replaces it instead of stacking another. */
export const SUPPLIER_QUOTED_SHIPPING_DESCRIPTION = 'Supplier quoted shipping'

export type StoredCostLine = { id: string; description: string; amountForeign: DecimalInput; vatable: boolean }

export type QuotedShippingPlan = {
  /** Ids of earlier requote shipping lines to delete. */
  deleteIds: string[]
  /** The line to create (null when the quote carries no shipping). */
  create: { description: string; amountForeign: Prisma.Decimal; amountBase: Prisma.Decimal; vatable: false; sortOrder: number } | null
  directFreightForeign: Prisma.Decimal
  directFreightBase: Prisma.Decimal
  /** VAT on the buyer's vatable cost lines that the requote tax must keep (the supplier's shipping is not vatable). */
  costLineVatForeign: Prisma.Decimal
  costLineVatBase: Prisma.Decimal
}

export function planQuotedShipping(params: {
  shippingForeign: DecimalInput
  fxRateToBase: DecimalInput
  /** Fractional order rate (0.2 for 20%); 0 or null = no VAT on cost lines. */
  vatRate: DecimalInput | null
  costLines: readonly StoredCostLine[]
}): QuotedShippingPlan {
  const fx = toDecimal(params.fxRateToBase)
  const rate = params.vatRate == null ? new Prisma.Decimal(0) : toDecimal(params.vatRate)
  const shipping = toDecimal(params.shippingForeign)
  const previous = params.costLines.filter((c) => c.description === SUPPLIER_QUOTED_SHIPPING_DESCRIPTION)
  const kept = params.costLines.filter((c) => c.description !== SUPPLIER_QUOTED_SHIPPING_DESCRIPTION)

  const keptForeign = kept.reduce((sum, c) => sum.add(toDecimal(c.amountForeign)), new Prisma.Decimal(0))
  const vatForeign = rate.gt(0)
    ? kept.filter((c) => c.vatable).reduce((sum, c) => sum.add(toDecimal(c.amountForeign).mul(rate)), new Prisma.Decimal(0))
    : new Prisma.Decimal(0)
  const hasShipping = shipping.gt(0)
  const directFreightForeign = keptForeign.add(hasShipping ? shipping : 0)
  return {
    deleteIds: previous.map((c) => c.id),
    create: hasShipping
      ? { description: SUPPLIER_QUOTED_SHIPPING_DESCRIPTION, amountForeign: shipping, amountBase: shipping.div(fx), vatable: false, sortOrder: kept.length }
      : null,
    directFreightForeign,
    directFreightBase: directFreightForeign.div(fx),
    costLineVatForeign: vatForeign,
    costLineVatBase: vatForeign.div(fx),
  }
}
