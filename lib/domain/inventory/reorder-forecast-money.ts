import { roundMoney, toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { MARGIN_REFUSAL_TEXT, resolveExVatListPrice } from '@/lib/domain/purchasing/line-margin'

/**
 * Forecast sales and forecast margin for a Reorder Planning row. FORWARD-LOOKING ESTIMATES,
 * not booked sales: nothing here reads an order, an invoice or a refund.
 *
 *   forecast quantity = the row's demand over the target cover weeks (daily demand x weeks x 7)
 *   forecast sales    = forecast quantity x the product's default list price, ex-VAT, base currency
 *                       (a VAT-inclusive stored price is divided by 1 + the sales VAT rate; same
 *                       rules as the PO line margin, via resolveExVatListPrice)
 *   forecast margin   = forecast sales - forecast quantity x current unit cost (base currency)
 *
 * Current unit cost is the open cost layers' remaining-quantity weighted average; a product holding no
 * stock falls back to its latest cost layer. A product with NO cost layer at all (or only a zero-cost
 * one) has no cost history: margin is "unavailable" (null + a reason), never 0 and never 100%.
 * All arithmetic is Decimal; results leave as base-currency strings in the currency's minor units.
 */

export const NO_COST_HISTORY_TEXT = 'No cost history (no cost layers)'

export type ForecastMoneyInput = {
  /** Units forecast over the cover period. */
  forecastQty: DecimalInput
  salesPrice: DecimalInput
  salesPriceTaxInclusive: boolean
  /** Sales VAT rate as a fraction; null when none resolved. */
  salesVatRate: DecimalInput
  /** Current unit cost, base currency; null when the product has no cost history. */
  unitCostBase: DecimalInput
  baseCurrency: string
}

export type ForecastMoney = {
  /** Base currency, ex-VAT; null when the price is unusable. */
  forecastSales: string | null
  /** Base currency; null when unavailable. */
  forecastMargin: string | null
  /** Why forecastSales is null, else null. */
  forecastSalesUnavailable: string | null
  /** Why forecastMargin is null, else null. */
  forecastMarginUnavailable: string | null
}

export function computeForecastMoney(input: ForecastMoneyInput): ForecastMoney {
  const price = resolveExVatListPrice(input)
  if (price.kind === 'refused') {
    const reason = MARGIN_REFUSAL_TEXT[price.reason]
    return { forecastSales: null, forecastMargin: null, forecastSalesUnavailable: reason, forecastMarginUnavailable: reason }
  }
  const qty = toDecimal(input.forecastQty)
  const sales: Decimal = qty.mul(price.price)
  const cost = input.unitCostBase == null ? null : toDecimal(input.unitCostBase)
  if (cost == null || !cost.gt(0)) {
    return {
      forecastSales: roundMoney(sales, input.baseCurrency).toFixed(),
      forecastMargin: null,
      forecastSalesUnavailable: null,
      forecastMarginUnavailable: NO_COST_HISTORY_TEXT,
    }
  }
  return {
    forecastSales: roundMoney(sales, input.baseCurrency).toFixed(),
    forecastMargin: roundMoney(sales.sub(qty.mul(cost)), input.baseCurrency).toFixed(),
    forecastSalesUnavailable: null,
    forecastMarginUnavailable: null,
  }
}

export type ForecastMoneyProductInputs = {
  salesPrice: DecimalInput
  salesPriceTaxInclusive: boolean
  salesVatRate: DecimalInput
  unitCostBase: DecimalInput
}

/** Open-layer weighted average cost, else the latest layer's cost, else null. Pure; the loader feeds it. */
export function currentUnitCostBase(
  openLayers: Array<{ remainingQty: DecimalInput; unitCostBase: DecimalInput }>,
  latestLayerUnitCostBase: DecimalInput,
): Decimal | null {
  let value = toDecimal(0)
  let qty = toDecimal(0)
  for (const layer of openLayers) {
    value = value.add(toDecimal(layer.remainingQty).mul(toDecimal(layer.unitCostBase)))
    qty = qty.add(toDecimal(layer.remainingQty))
  }
  if (qty.gt(0)) return value.div(qty)
  return latestLayerUnitCostBase == null ? null : toDecimal(latestLayerUnitCostBase)
}
