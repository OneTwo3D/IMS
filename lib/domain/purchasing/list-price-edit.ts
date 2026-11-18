import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

/**
 * The list-price edit from the PO margin column (o3d-hqvrp.381), as pure Decimal rules.
 *
 * The margin column shows and the operator edits the product's list price EX-VAT, in base currency: the
 * figure #935 compares with the cost. The product stores its default list price in one convention
 * (`salesPriceTaxInclusive`), so the edit converts back: an inclusive product stores
 * ex-VAT x (1 + the sales VAT rate), rounded to the column's 4 dp; with no resolved rate it refuses rather
 * than store a guess. A variation is its own product and is priced on its own row; a variable parent is
 * priced by its variations and is never edited here.
 */

export const LIST_PRICE_EDIT_MAX = '99999999.9999'

export type ListPriceEditRefusal =
  | 'invalid-price'
  | 'variable-parent'
  | 'sales-vat-unresolved'

export const LIST_PRICE_EDIT_REFUSAL_TEXT: Record<ListPriceEditRefusal, string> = {
  'invalid-price': 'Enter a price above zero, with at most 4 decimal places',
  'variable-parent': 'This is a variable product: set the price on its variations',
  'sales-vat-unresolved': 'The list price includes VAT but no sales VAT rate is configured for this product',
}

/** A positive price, at most 4 dp, within the column's range; as a normalised string, or null. */
export function parseEditedExVatPrice(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!/^\d{1,8}(\.\d{1,4})?$/.test(s)) return null
  const d = toDecimal(s)
  return d.gt(0) && d.lte(LIST_PRICE_EDIT_MAX) ? d.toFixed() : null
}

export function storedListPriceFromExVat(args: {
  exVatPrice: string
  storedVatInclusive: boolean
  salesVatRate: number | string | null
  productType: string
}): { ok: true; stored: Decimal } | { ok: false; reason: ListPriceEditRefusal } {
  if (args.productType === 'VARIABLE') return { ok: false, reason: 'variable-parent' }
  const ex = parseEditedExVatPrice(args.exVatPrice)
  if (ex === null) return { ok: false, reason: 'invalid-price' }
  if (!args.storedVatInclusive) return { ok: true, stored: roundQuantity(ex, 4) }
  if (args.salesVatRate == null) return { ok: false, reason: 'sales-vat-unresolved' }
  const rate = toDecimal(args.salesVatRate)
  if (rate.lt(0)) return { ok: false, reason: 'sales-vat-unresolved' }
  const stored = roundQuantity(toDecimal(ex).mul(rate.add(1)), 4)
  return stored.lte(LIST_PRICE_EDIT_MAX) ? { ok: true, stored } : { ok: false, reason: 'invalid-price' }
}
