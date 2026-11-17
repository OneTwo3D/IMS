import { roundQuantity, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/**
 * Profit margin of a purchase-order line, from the price the buyer entered. INTERNAL ONLY: this
 * module is read by the permission-gated server action `previewPoLineMargins` and by nothing that
 * renders to a supplier (portal, quote view, PO PDF, supplier email).
 *
 * All arithmetic is on Decimal (HALF_UP); results leave as decimal strings so no float is ever
 * asked to carry money.
 *
 * Rules (owner-approved design, o3d-ywzag slice 1):
 *  - Sales price = the product's default list price (`salesPriceBase`), ex-VAT, base currency.
 *    A price stored VAT-inclusive is divided by (1 + the product's sales VAT rate).
 *  - Cost = the entered unit price, net of VAT, after the line discount, per STOCK unit, converted
 *    to base at the PO's FX rate (1 BASE = rate FOREIGN, so base = foreign / rate). PLAIN unit
 *    price: no freight/duty/landed-cost allocation.
 *  - Gross margin % = (price - cost) / price. Margin amount = price - cost, per unit.
 *  - A missing FX rate refuses ('rate-unavailable'); it is never defaulted to 1.
 */

export type MarginRefusal =
  | 'no-sales-price'
  | 'sales-vat-unresolved'
  | 'rate-unavailable'
  | 'no-cost'

export const MARGIN_REFUSAL_TEXT: Record<MarginRefusal, string> = {
  'no-sales-price': 'No sales price on the product',
  'sales-vat-unresolved': 'Sales price includes VAT but no sales VAT rate is configured',
  'rate-unavailable': 'Rate unavailable',
  'no-cost': 'Enter a quantity and a price',
}

export type LineMarginInput = {
  /** Entered quantity, in purchase units (stock units when no purchase unit). */
  qty: DecimalInput
  /** Entered unit price per purchase unit, in the PO currency (VAT-inclusive when `pricesIncludeVat`). */
  unitCost: DecimalInput
  /** The line discount as typed: "5%", "2.50" or "". Applied to qty * unitCost, as the form does. */
  discount?: string | null
  /** Stock units per purchase unit; 1 when the line has no purchase unit. */
  purchaseUnitFactor?: DecimalInput
  /** The line's purchase VAT rate as a fraction (0.2 = 20%). */
  taxRate: DecimalInput
  pricesIncludeVat: boolean
  /** 1 base = fxRate foreign. null / non-positive means unavailable. */
  fxRate: number | string | null
  /** Product default list price as stored, or null when it has none. */
  salesPrice: DecimalInput
  salesPriceTaxInclusive: boolean
  /** Sales VAT rate (fraction) used to strip VAT from an inclusive price; null when none resolved. */
  salesVatRate: DecimalInput
}

export type LineMarginResult =
  | {
      kind: 'ok'
      /** Per stock unit, base currency, ex-VAT. */
      salesPrice: string
      cost: string
      marginAmount: string
      /** Gross margin %, 2 dp, e.g. "34.50" or "-12.00". */
      marginPct: string
      negative: boolean
      /** Stock units on the line. */
      stockQty: string
    }
  | { kind: 'refused'; reason: MarginRefusal; message: string }

function refused(reason: MarginRefusal): LineMarginResult {
  return { kind: 'refused', reason, message: MARGIN_REFUSAL_TEXT[reason] }
}

/** "10%" is a percentage of `lineGross`; "5" is an absolute amount; anything else is no discount. */
export function parseDiscountDecimal(input: string | null | undefined, lineGross: Decimal): Decimal {
  const s = (input ?? '').trim()
  if (!s) return toDecimal(0)
  const isPct = s.endsWith('%')
  const body = isPct ? s.slice(0, -1).trim() : s
  if (!/^\d+(\.\d+)?$/.test(body)) return toDecimal(0)
  const n = toDecimal(body)
  return isPct ? lineGross.mul(n).div(100) : n
}

export type ExVatListPriceInput = Pick<LineMarginInput, 'salesPrice' | 'salesPriceTaxInclusive' | 'salesVatRate'>

/**
 * The product's default list price, ex-VAT, base currency. A price stored VAT-inclusive is divided by
 * (1 + the sales VAT rate); with no resolved rate it refuses rather than guessing. Shared by the PO line
 * margin and the Reorder Planning forecast money so the two cannot disagree on a product's price.
 */
export function resolveExVatListPrice(
  input: ExVatListPriceInput,
): { kind: 'ok'; price: Decimal } | { kind: 'refused'; reason: 'no-sales-price' | 'sales-vat-unresolved' } {
  const hasSalesPrice = input.salesPrice != null && toDecimal(input.salesPrice).gt(0)
  if (!hasSalesPrice) return { kind: 'refused', reason: 'no-sales-price' }
  let price = toDecimal(input.salesPrice)
  if (input.salesPriceTaxInclusive) {
    if (input.salesVatRate == null) return { kind: 'refused', reason: 'sales-vat-unresolved' }
    const vat = toDecimal(input.salesVatRate)
    if (vat.lt(0)) return { kind: 'refused', reason: 'sales-vat-unresolved' }
    price = price.div(vat.add(1))
  }
  return { kind: 'ok', price }
}

export function computeLineMargin(input: LineMarginInput): LineMarginResult {
  const fx = input.fxRate == null ? null : toDecimal(input.fxRate)
  if (fx === null || !fx.gt(0)) return refused('rate-unavailable')

  const listPrice = resolveExVatListPrice(input)
  if (listPrice.kind === 'refused') return refused(listPrice.reason)
  const price = listPrice.price

  const qty = toDecimal(input.qty)
  const unitCost = toDecimal(input.unitCost)
  const factor = toDecimal(input.purchaseUnitFactor ?? 1)
  const stockQty = qty.mul(factor)
  if (!qty.gt(0) || !unitCost.gt(0) || !factor.gt(0)) return refused('no-cost')

  const gross = qty.mul(unitCost)
  const afterDiscount = clampNonNegative(gross.sub(parseDiscountDecimal(input.discount, gross)))
  const rate = toDecimal(input.taxRate)
  const net = input.pricesIncludeVat && rate.gt(0) ? afterDiscount.div(rate.add(1)) : afterDiscount
  const costBase = net.div(stockQty).div(fx)

  const marginAmount = price.sub(costBase)
  const marginPct = marginAmount.div(price).mul(100)
  return {
    kind: 'ok',
    salesPrice: roundQuantity(price, 6).toFixed(),
    cost: roundQuantity(costBase, 6).toFixed(),
    marginAmount: roundQuantity(marginAmount, 6).toFixed(),
    marginPct: roundQuantity(marginPct, 2).toFixed(2),
    negative: marginAmount.lt(0),
    stockQty: roundQuantity(stockQty, 6).toFixed(),
  }
}

function clampNonNegative(v: Decimal): Decimal {
  return v.lt(0) ? toDecimal(0) : v
}

export type PoMarginTotal = {
  /** Lines that contributed, and lines left out (refused or no price). */
  includedLines: number
  excludedLines: number
  salesValue: string
  costValue: string
  marginAmount: string
  /** null when no line has a sales price. */
  marginPct: string | null
  negative: boolean
}

/** PO-level margin over the lines that have a computable margin; the rest are excluded, not zero. */
export function computePoMarginTotal(results: LineMarginResult[]): PoMarginTotal {
  let sales = toDecimal(0)
  let cost = toDecimal(0)
  let included = 0
  for (const r of results) {
    if (r.kind !== 'ok') continue
    const q = toDecimal(r.stockQty)
    sales = sales.add(toDecimal(r.salesPrice).mul(q))
    cost = cost.add(toDecimal(r.cost).mul(q))
    included += 1
  }
  const margin = sales.sub(cost)
  return {
    includedLines: included,
    excludedLines: results.length - included,
    salesValue: roundQuantity(sales, 4).toFixed(),
    costValue: roundQuantity(cost, 4).toFixed(),
    marginAmount: roundQuantity(margin, 4).toFixed(),
    marginPct: included > 0 && sales.gt(0) ? roundQuantity(margin.div(sales).mul(100), 2).toFixed(2) : null,
    negative: margin.lt(0),
  }
}
