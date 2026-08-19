/**
 * Per-line money for a SUPPLIER REQUOTE (o3d-4rp), shared with the shape createPurchaseOrder uses so
 * a requoted line is stored under exactly the same conventions as a line created by finance.
 *
 * WHY THIS EXISTS. submitSupplierQuote rewrote qty/unitCost/total on a requote and left
 * `taxForeign`/`taxBase` at the values computed for the ORIGINAL RFQ prices, then summed those stale
 * figures into the PO tax totals — and, since o3d-lx1, consumed them as both the percentage basis and
 * the VAT split of the reapplied header discount. A supplier who requoted 100 -> 150 therefore posted
 * 150 of goods carrying 20 of VAT.
 *
 * CONVENTIONS. `PurchaseOrderLine.unitCostForeign` and `.totalForeign` are defined by the schema as
 * NET of VAT. The quoted unit price arrives in the PO's own entry convention: GROSS when
 * `pricesIncludeVat`, NET otherwise. So on a VAT-inclusive PO the net is extracted from the quote and
 * the tax is the difference; on a VAT-exclusive PO the quote is already net and the tax is rate x net.
 * With no rate (or an exclusive PO) the result is arithmetically identical to a plain qty x price, so
 * the common case is unchanged.
 *
 * Decimal throughout — this is money, and the values seed cost layers and therefore COGS.
 */
import { Prisma } from '@/app/generated/prisma/client'
import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type RequotedLineAmounts = {
  /** NET unit cost in the supplier currency. */
  unitCostForeign: Prisma.Decimal
  unitCostBase: Prisma.Decimal
  /** NET line total in the supplier currency. */
  totalForeign: Prisma.Decimal
  totalBase: Prisma.Decimal
  taxForeign: Prisma.Decimal
  taxBase: Prisma.Decimal
}

export function calcRequotedLineAmounts(params: {
  qty: DecimalInput
  /** The supplier's quoted unit price, in the PO's entry convention. */
  quotedUnitPriceForeign: DecimalInput
  /** Fractional rate (0.2 for 20%): the line's own rate, or the order default when it has none. */
  taxRate: DecimalInput
  pricesIncludeVat: boolean
  /** Must be > 0; callers refuse the requote outright when the RFQ has no usable rate. */
  fxRateToBase: DecimalInput
}): RequotedLineAmounts {
  const qty = toDecimal(params.qty)
  const quotedUnitPriceForeign = toDecimal(params.quotedUnitPriceForeign)
  const rawRate = toDecimal(params.taxRate)
  // A negative or non-finite rate is not a tax rate; treat it as no tax rather than inventing a credit.
  const taxRate = rawRate.isFinite() && rawRate.gt(0) ? rawRate : new Prisma.Decimal(0)
  const fxRate = toDecimal(params.fxRateToBase)
  const inclVat = params.pricesIncludeVat && taxRate.gt(0)

  const quotedLineForeign = qty.mul(quotedUnitPriceForeign)
  const totalForeign = inclVat
    ? quotedLineForeign.div(new Prisma.Decimal(1).add(taxRate))
    : quotedLineForeign
  const unitCostForeign = qty.gt(0) ? totalForeign.div(qty) : new Prisma.Decimal(0)
  const taxForeign = inclVat ? quotedLineForeign.sub(totalForeign) : totalForeign.mul(taxRate)

  return {
    unitCostForeign,
    unitCostBase: unitCostForeign.div(fxRate),
    totalForeign,
    totalBase: totalForeign.div(fxRate),
    taxForeign,
    taxBase: taxForeign.div(fxRate),
  }
}
