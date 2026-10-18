/**
 * THE STORED ACCOUNTING OF A PURCHASE ORDER, validated with the arithmetic that wrote it.
 *
 * createPurchaseOrder writes, besides the fields the fingerprint carries: per line the net unit cost, the base unit cost, the line totals and the line tax in both currencies; per order the
 * subtotal, tax and total in both currencies, after the header discount. Every one of those is a function of the stored lines, the stored FX rate, the VAT convention and the stored discount.
 * This module recomputes the header from the stored lines with the importer's own functions (`calcLineTotals`, moved to lib/domain/purchasing/line-totals.ts for this purpose, and
 * `applyHeaderOrderDiscount`, already shared) and returns the NAMES of the columns that differ. The lines themselves are pinned to the file by the fingerprint (quantity, entered amount after
 * discount, tax token, tax profile, tax amount against the rate), so a header edited together with its lines still differs from the file through them.
 *
 * NO TOLERANCE. Every stored line amount is compared EXACTLY, at the places it is stored (unit costs 6 dp, amounts 4 dp), with what the importer's own arithmetic gives for the FILE's numbers
 * (`expectedLine`: the same expressions on the same rounding primitives). The header is composed from those expected lines with the importer's own `applyHeaderOrderDiscount`.
 *
 * Also checked: the columns the importer never sets (they keep their defaults) are still at them. A value in one of them did not come from this load.
 */
import { calcLineTotals, safeFxRate } from '@/lib/domain/purchasing/line-totals'
import { applyHeaderOrderDiscount } from '@/lib/domain/purchasing/order-discount'
import { D } from '../../money'

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
    sortOrder: number
    /** The effective rate the line was taxed at: its rate's, or the order's stated percent when the line holds no rate. */
    effectiveRate: number
  }>
}

const num = (value: Dec): number => Number(value.toFixed())
/** A stored decimal equals an importer-computed number rounded to `dp` places (half up), exactly. */
const exact = (stored: Dec, value: number, dp: number): boolean => new D(stored.toFixed()).toFixed(dp) === new D(value).toDecimalPlaces(dp, D.ROUND_HALF_UP).toFixed(dp)

/** One line of the FILE, as the importer reads it: quantity, entered unit cost and line discount, as numbers. */
export interface FileLineNumbers {
  qty: number
  unitCost: number
  discount: number
}

/**
 * What createPurchaseOrder computes for one line, from the FILE's numbers, the line's tax rate (the effective rate it resolves to, or the order's stated percent when the line holds none)
 * and the order's VAT convention and FX rate: the same expressions, in the same order, on the same rounding primitives. Nothing here is a tolerance.
 */
export function expectedLine(file: FileLineNumbers, rate: number, inclVat: boolean, fx: number): {
  unitCostForeign: number; unitCostBase: number; totalForeign: number; totalBase: number; taxForeign: number; taxBase: number
} {
  const lineInclVat = inclVat && rate > 0
  const grossAfterDisc = Math.max(0, file.qty * file.unitCost - file.discount)
  const netLineForeign = lineInclVat ? grossAfterDisc / (1 + rate) : grossAfterDisc
  const netUnitForeign = file.qty > 0 ? netLineForeign / file.qty : 0
  const { unitCostBase, totalForeign, totalBase } = calcLineTotals(netUnitForeign, file.qty, fx)
  const taxForeign = lineInclVat ? Math.round((grossAfterDisc - totalForeign) * 10000) / 10000 : Math.round(totalForeign * rate * 10000) / 10000
  const taxBase = Math.round((taxForeign / fx) * 10000) / 10000
  return { unitCostForeign: netUnitForeign, unitCostBase, totalForeign, totalBase, taxForeign, taxBase }
}

/**
 * The names (never values) of the stored columns that are not what the importer would have written for THIS FILE; empty = all good. `file` holds the order's lines in file order (the
 * importer stores them in that order, `sortOrder` = position); null for an order the file does not contain.
 */
export function headerAmountMismatches(po: StoredPoAmounts, file: readonly FileLineNumbers[] | null): string[] {
  const bad = new Set<string>()
  const fxRaw = num(po.fxRateToBase)
  const fx = safeFxRate(fxRaw)
  const stored = [...po.lines].sort((a, b) => a.sortOrder - b.sortOrder)

  if (file === null) bad.add('notInFile')
  else if (file.length !== stored.length) bad.add('lineCount')
  else {
    let subtotalForeign = 0
    let subtotalBase = 0
    let taxForeign = 0
    let taxBase = 0
    stored.forEach((line, i) => {
      const e = expectedLine(file[i]!, line.effectiveRate, po.pricesIncludeVat, fxRaw)
      // The net unit cost to 6 dp, its base twin, the totals and the taxes to the places they are stored: exactly what the importer's arithmetic gives for the file's numbers.
      if (!exact(line.unitCostForeign, e.unitCostForeign, 6)) bad.add('line.unitCostForeign')
      if (!exact(line.unitCostBase, e.unitCostBase, 6)) bad.add('line.unitCostBase')
      if (!exact(line.totalForeign, e.totalForeign, 4)) bad.add('line.totalForeign')
      if (!exact(line.totalBase, e.totalBase, 4)) bad.add('line.totalBase')
      if (!exact(line.taxForeign, e.taxForeign, 4)) bad.add('line.taxForeign')
      if (!exact(line.taxBase, e.taxBase, 4)) bad.add('line.taxBase')
      subtotalForeign += e.totalForeign
      subtotalBase += e.totalBase
      taxForeign += e.taxForeign
      taxBase += e.taxBase
    })
    // ---- header: the importer's own composition, from those expected lines ----
    const discounted = applyHeaderOrderDiscount({
      subtotalForeign, subtotalBase, taxForeign, taxBase,
      orderDiscountForeign: Math.max(0, num(po.discountAmount)), inclVat: po.pricesIncludeVat, fxRate: fxRaw,
    })
    const expected: Record<string, number> = {
      subtotalForeign: discounted.subtotalForeign,
      subtotalBase: discounted.subtotalBase,
      taxForeign: discounted.taxForeign,
      taxBase: discounted.taxBase,
      totalForeign: discounted.subtotalForeign + discounted.taxForeign,
      totalBase: discounted.subtotalBase + discounted.taxBase,
    }
    for (const [column, value] of Object.entries(expected)) {
      if (!exact((po as unknown as Record<string, Dec>)[column]!, value, 4)) bad.add(column)
    }
  }
  for (const line of stored) {
    if (line.description !== null || line.purchaseUnitId !== null || line.purchaseUnitQty !== null || num(line.qtyReceived) !== 0 || num(line.qtyReturned) !== 0
      || num(line.landedUnitCostBase) !== 0 || line.reorderEvidence !== null) bad.add('line.defaults')
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
export function headerAmountsEntry(po: StoredPoAmounts, file: readonly FileLineNumbers[] | null): string {
  const bad = headerAmountMismatches(po, file)
  return bad.length === 0 ? 'ok' : `mismatch:${bad.join(',')}`
}
