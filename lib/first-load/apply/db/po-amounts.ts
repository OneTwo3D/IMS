/**
 * THE STORED ACCOUNTING OF A PURCHASE ORDER, validated with the arithmetic that wrote it.
 *
 * createPurchaseOrder writes, besides the fields the fingerprint carries: per line the net unit cost, the base unit cost, the line totals and the line tax in both currencies; per order the
 * subtotal, tax and total in both currencies, after the header discount. Every one of those is a function of the stored lines, the stored FX rate, the VAT convention and the stored discount.
 * This module recomputes the header from the stored lines with the importer's own functions (`calcLineTotals`, moved to lib/domain/purchasing/line-totals.ts for this purpose, and
 * `applyHeaderOrderDiscount`, already shared) and returns the NAMES of the columns that differ. The lines themselves are pinned to the file by the fingerprint (quantity, entered amount after
 * discount, tax token, tax profile, tax amount against the rate), so a header edited together with its lines still differs from the file through them.
 *
 * TOLERANCE. Amounts are stored to 4 decimal places and unit costs to 6. The importer computes in floating point and sums floats; this recomputation uses the same functions on the stored
 * (already rounded) values, so the only difference left is float accumulation and the last rounding: at most one unit in the last stored place. 0.0001 for 4 dp amounts; for the base unit
 * cost 0.000002 scaled by 1/fx when fx < 1 (the stored foreign unit cost was rounded to 6 dp before it was divided). A larger difference is a difference.
 *
 * Also checked: the columns the importer never sets (they keep their defaults) are still at them. A value in one of them did not come from this load.
 */
import { calcLineTotals, safeFxRate } from '@/lib/domain/purchasing/line-totals'
import { applyHeaderOrderDiscount } from '@/lib/domain/purchasing/order-discount'

type Dec = { toFixed(): string }

export interface StoredPoAmounts {
  type: string
  landedCostMethod: string
  fxRateToBase: Dec
  pricesIncludeVat: boolean
  discountAmount: Dec
  discountStr: string | null
  subtotalForeign: Dec
  subtotalBase: Dec
  taxForeign: Dec
  taxBase: Dec
  totalForeign: Dec
  totalBase: Dec
  directFreightForeign: Dec
  directFreightBase: Dec
  internalNotes: string | null
  skipPreferredSupplierUpdate: boolean
  archived: boolean
  trackingNumber: string | null
  shippingProvider: string | null
  receivedAt: Date | null
  invoicedAt: Date | null
  rfqSentAt: Date | null
  poSentAt: Date | null
  /** Additional-cost rows; the importer passes none. */
  freightCostLineCount: number
  /** The price cache createPurchaseOrder writes per supplier and product agrees with the stored lines (computed by the reader from the orders it read). */
  supplierProductsOk: boolean
  lines: ReadonlyArray<{
    qty: Dec
    unitCostForeign: Dec
    unitCostBase: Dec
    totalForeign: Dec
    totalBase: Dec
    taxForeign: Dec
    taxBase: Dec
    description: string | null
    purchaseUnitId: string | null
    purchaseUnitQty: Dec | null
    qtyReceived: Dec
    qtyReturned: Dec
    landedUnitCostBase: Dec
    reorderEvidence: unknown
  }>
}

export const AMOUNT_TOLERANCE = 0.0001
const num = (value: Dec): number => Number(value.toFixed())
const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance + 1e-12

/** The names (never values) of the stored columns that are not what the importer would have written; empty = all good. */
export function headerAmountMismatches(po: StoredPoAmounts): string[] {
  const bad = new Set<string>()
  const fx = safeFxRate(num(po.fxRateToBase))

  // ---- lines ----
  let subtotalForeign = 0
  let subtotalBase = 0
  let taxForeign = 0
  let taxBase = 0
  for (const line of po.lines) {
    const totalForeign = num(line.totalForeign)
    const lineTaxForeign = num(line.taxForeign)
    // totalBase = round4(totalForeign / fx); taxBase = round4(taxForeign / fx); unitCostBase = round6(unitCostForeign / fx), by calcLineTotals on the stored net unit cost.
    const derived = calcLineTotals(num(line.unitCostForeign), num(line.qty), fx)
    // The stored net unit cost must give the stored line total: totalForeign = round4(unitCostForeign x qty) by calcLineTotals. The importer rounded the unit cost to 6 dp AFTER
    // computing the total from the unrounded one, so the two agree to 0.0001 plus half a unit of the 6th place per unit of quantity. A unit cost altered (with its base twin)
    // while the file-pinned total stays put is therefore a difference here, and the unit cost is tied to the file through the total the fingerprint compares.
    if (!near(totalForeign, derived.totalForeign, AMOUNT_TOLERANCE + num(line.qty) * 0.0000005)) bad.add('line.unitCostForeign')
    if (!near(num(line.totalBase), Math.round((totalForeign / fx) * 10000) / 10000, AMOUNT_TOLERANCE)) bad.add('line.totalBase')
    if (!near(num(line.taxBase), Math.round((lineTaxForeign / fx) * 10000) / 10000, AMOUNT_TOLERANCE)) bad.add('line.taxBase')
    if (!near(num(line.unitCostBase), derived.unitCostBase, 0.000002 * Math.max(1, 1 / fx))) bad.add('line.unitCostBase')
    if (line.description !== null || line.purchaseUnitId !== null || line.purchaseUnitQty !== null || num(line.qtyReceived) !== 0 || num(line.qtyReturned) !== 0
      || num(line.landedUnitCostBase) !== 0 || line.reorderEvidence !== null) bad.add('line.defaults')
    subtotalForeign += totalForeign
    subtotalBase += num(line.totalBase)
    taxForeign += lineTaxForeign
    taxBase += num(line.taxBase)
  }

  // ---- header: the importer's own composition, from the stored lines ----
  const discounted = applyHeaderOrderDiscount({
    subtotalForeign, subtotalBase, taxForeign, taxBase,
    orderDiscountForeign: Math.max(0, num(po.discountAmount)), inclVat: po.pricesIncludeVat, fxRate: num(po.fxRateToBase),
  })
  const freightForeign = 0
  const freightBase = 0
  const expected: Record<string, number> = {
    subtotalForeign: discounted.subtotalForeign,
    subtotalBase: discounted.subtotalBase,
    taxForeign: discounted.taxForeign,
    taxBase: discounted.taxBase,
    totalForeign: discounted.subtotalForeign + discounted.taxForeign + freightForeign,
    totalBase: discounted.subtotalBase + discounted.taxBase + freightBase,
  }
  for (const [column, value] of Object.entries(expected)) {
    if (!near(num((po as unknown as Record<string, Dec>)[column]), value, AMOUNT_TOLERANCE)) bad.add(column)
  }

  // ---- columns this load never sets ----
  if (po.type !== 'GOODS') bad.add('type')
  if (po.landedCostMethod !== 'BY_VALUE') bad.add('landedCostMethod')
  if (num(po.directFreightForeign) !== 0 || num(po.directFreightBase) !== 0 || po.freightCostLineCount !== 0) bad.add('directFreight')
  if (po.discountStr !== null) bad.add('discountStr')
  if (po.internalNotes !== null) bad.add('internalNotes')
  if (po.skipPreferredSupplierUpdate) bad.add('skipPreferredSupplierUpdate')
  if (po.archived) bad.add('archived')
  if (po.trackingNumber !== null || po.shippingProvider !== null) bad.add('shipping')
  if (po.receivedAt !== null || po.invoicedAt !== null || po.rfqSentAt !== null || po.poSentAt !== null) bad.add('lifecycleDates')
  if (!po.supplierProductsOk) bad.add('supplierProducts')
  return [...bad].sort()
}

/** The fingerprint entry: `ok`, or the names of the columns that are not what the importer writes. */
export function headerAmountsEntry(po: StoredPoAmounts): string {
  const bad = headerAmountMismatches(po)
  return bad.length === 0 ? 'ok' : `mismatch:${bad.join(',')}`
}
