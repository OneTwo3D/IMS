/**
 * A supplier-quoted shipping cost on a requote, as a FREIGHT COST LINE (not only the directFreight aggregate).
 *
 * WHY. submitSupplierQuote used to write the supplier's shipping only into `directFreightForeign/Base` and the order total. Landed
 * cost at receipt and the bill-from-PO flow read the order's `freightCostLines`, so the shipping was never capitalised into stock cost
 * and could not be billed as a cost line; the requote also rebuilt the order tax from line tax alone, dropping the VAT on the buyer's
 * own vatable cost lines.
 *
 * BEHIND A FLAG. The setting `supplier_quote_shipping_landed_enabled` (default OFF) turns this on, because it changes the order total
 * (the buyer's other cost lines now stay in the aggregate beside the supplier's shipping) and what receipts capitalise.
 *
 * OWNER RULING 2026-11-18: the supplier's shipping REPLACES the buyer's own shipping estimate, so shipping is counted once. The buyer's
 * estimate is the cost line TAGGED `kind = SHIPPING` (a description is free text and proves nothing; untagged lines are never touched).
 * A tagged line that is already BILLED (a purchase-invoice line points at it) or already LANDED into stock (goods received against the
 * order) is NOT replaced: both lines stay and `refusedReplace` names why, for a visible warning. With no tagged line the supplier's
 * shipping is added, as before. A requote replaces the line a previous requote created.
 *
 * Pure and synchronous: Decimal throughout.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export const SUPPLIER_QUOTE_SHIPPING_SETTING_KEY = 'supplier_quote_shipping_landed_enabled'
/** Marks the cost line a requote created, so the next requote replaces it instead of stacking another. */
export const SUPPLIER_QUOTED_SHIPPING_DESCRIPTION = 'Supplier quoted shipping'

export type StoredCostLine = {
  id: string
  description: string
  amountForeign: DecimalInput
  vatable: boolean
  /** 'SHIPPING' = the buyer's shipping estimate (or a requote's supplier line); null/absent = untagged. */
  kind?: 'SHIPPING' | null
  /** A purchase-invoice line points at this cost line. */
  billed?: boolean
}

/** Why a buyer's SHIPPING line was left in place beside the supplier's quote. */
export type RefusedShippingReplace = { lineIds: string[]; reason: 'billed' | 'landed'; message: string }

export type QuotedShippingPlan = {
  /** Ids of earlier requote shipping lines to delete. */
  deleteIds: string[]
  /** The line to create (null when the quote carries no shipping). */
  create: { description: string; amountForeign: Prisma.Decimal; amountBase: Prisma.Decimal; vatable: false; sortOrder: number; kind: 'SHIPPING' } | null
  /** Set when a buyer SHIPPING line could not be replaced (billed or landed): it stays, beside the supplier's line. */
  refusedReplace: RefusedShippingReplace | null
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
  /** Goods have already landed into stock against this order (the caller reads it; only consulted when a buyer SHIPPING line exists). */
  landed?: boolean
}): QuotedShippingPlan {
  const fx = toDecimal(params.fxRateToBase)
  const rate = params.vatRate == null ? new Prisma.Decimal(0) : toDecimal(params.vatRate)
  const shipping = toDecimal(params.shippingForeign)
  const isPrevious = (c: StoredCostLine) => c.description === SUPPLIER_QUOTED_SHIPPING_DESCRIPTION
  const previous = params.costLines.filter(isPrevious)
  const buyerShipping = params.costLines.filter((c) => !isPrevious(c) && c.kind === 'SHIPPING')
  // Only a supplier quote that carries shipping replaces the estimate; a zero quote leaves the buyer's estimate alone.
  const billedShipping = buyerShipping.filter((c) => c.billed)
  let refusedReplace: RefusedShippingReplace | null = null
  let replaced: StoredCostLine[] = []
  if (shipping.gt(0) && buyerShipping.length > 0) {
    if (billedShipping.length > 0) {
      refusedReplace = {
        lineIds: billedShipping.map((c) => c.id),
        reason: 'billed',
        message: 'The supplier quoted shipping, but the order\'s Shipping cost line has already been billed, so it was not replaced. Both shipping lines are on the order: remove one by hand once the bill is corrected.',
      }
    } else if (params.landed) {
      refusedReplace = {
        lineIds: buyerShipping.map((c) => c.id),
        reason: 'landed',
        message: 'The supplier quoted shipping, but goods have already been received against this order, so its Shipping cost line is part of the stock cost and was not replaced. Both shipping lines are on the order: review them by hand.',
      }
    } else {
      replaced = buyerShipping
    }
  }
  const replacedIds = new Set(replaced.map((c) => c.id))
  const kept = params.costLines.filter((c) => !isPrevious(c) && !replacedIds.has(c.id))

  const keptForeign = kept.reduce((sum, c) => sum.add(toDecimal(c.amountForeign)), new Prisma.Decimal(0))
  const vatForeign = rate.gt(0)
    ? kept.filter((c) => c.vatable).reduce((sum, c) => sum.add(toDecimal(c.amountForeign).mul(rate)), new Prisma.Decimal(0))
    : new Prisma.Decimal(0)
  const hasShipping = shipping.gt(0)
  const directFreightForeign = keptForeign.add(hasShipping ? shipping : 0)
  return {
    deleteIds: [...previous.map((c) => c.id), ...replaced.map((c) => c.id)],
    create: hasShipping
      ? { description: SUPPLIER_QUOTED_SHIPPING_DESCRIPTION, amountForeign: shipping, amountBase: shipping.div(fx), vatable: false, sortOrder: kept.length, kind: 'SHIPPING' }
      : null,
    refusedReplace,
    directFreightForeign,
    directFreightBase: directFreightForeign.div(fx),
    costLineVatForeign: vatForeign,
    costLineVatBase: vatForeign.div(fx),
  }
}
