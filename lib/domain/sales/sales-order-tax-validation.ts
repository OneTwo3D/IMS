import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type SalesOrderLineTaxValidationInput = {
  sku?: string | null
  qty: DecimalInput
  unitPriceForeign: DecimalInput
  /**
   * Line-level discount only. Header/order-level discounts are accounted for
   * separately by the sales-order action and must not be folded into this
   * assertion value.
   */
  discountAmount?: DecimalInput | null
  taxRateValue?: DecimalInput | null
  /**
   * Optional caller assertion for this line's tax before order-level discount
   * allocation. Omitted tax on a tax-bearing line is allowed for manual UI
   * callers, but the validator reports a warning so import/API omissions can be
   * surfaced.
   */
  taxForeign?: DecimalInput | null
}

export type SalesOrderLineTaxValidationWarning = {
  code: 'missing_line_tax_assertion'
  sku: string
  expectedTaxForeign: string
}

export type SalesOrderLineTaxValidationResult =
  | { success: true; warnings?: SalesOrderLineTaxValidationWarning[] }
  | { success: false; error: string }

const DEFAULT_TOLERANCE = new Prisma.Decimal('0.05')

function lineLabel(line: SalesOrderLineTaxValidationInput): string {
  return line.sku?.trim() || 'line item'
}

function rateError(line: SalesOrderLineTaxValidationInput): string | null {
  const rate = toDecimal(line.taxRateValue ?? 0)
  if (rate.gt(1)) {
    return `Implausible tax rate ${rate.toString()} for ${lineLabel(line)}: rates must be fractions, not percents`
  }
  return null
}

export function expectedSalesOrderLineTaxForeign(
  line: SalesOrderLineTaxValidationInput,
  pricesIncludeVat: boolean,
): Prisma.Decimal {
  const rate = toDecimal(line.taxRateValue ?? 0)
  const grossOrNet = toDecimal(line.qty)
    .mul(toDecimal(line.unitPriceForeign))
    .sub(toDecimal(line.discountAmount ?? 0))

  if (rate.lte(0)) return new Prisma.Decimal(0)
  if (pricesIncludeVat) {
    const net = grossOrNet.div(new Prisma.Decimal(1).add(rate))
    return grossOrNet.sub(net)
  }
  return grossOrNet.mul(rate)
}

export function validateSalesOrderLineTaxInputs(
  lines: SalesOrderLineTaxValidationInput[],
  pricesIncludeVat: boolean,
  options: { tolerance?: DecimalInput } = {},
): SalesOrderLineTaxValidationResult {
  const tolerance = toDecimal(options.tolerance ?? DEFAULT_TOLERANCE)
  const warnings: SalesOrderLineTaxValidationWarning[] = []
  for (const line of lines) {
    const invalidRate = rateError(line)
    if (invalidRate) return { success: false, error: invalidRate }

    const grossOrNet = toDecimal(line.qty)
      .mul(toDecimal(line.unitPriceForeign))
      .sub(toDecimal(line.discountAmount ?? 0))
    if (grossOrNet.lt(0)) {
      return { success: false, error: `Discount exceeds line total for ${lineLabel(line)}` }
    }

    const expected = roundQuantity(expectedSalesOrderLineTaxForeign(line, pricesIncludeVat), 4)
    if (line.taxForeign == null) {
      if (expected.gt(0)) {
        warnings.push({
          code: 'missing_line_tax_assertion',
          sku: lineLabel(line),
          expectedTaxForeign: expected.toFixed(4),
        })
      }
      continue
    }

    const provided = roundQuantity(line.taxForeign, 4)
    if (provided.sub(expected).abs().gt(tolerance)) {
      const mode = pricesIncludeVat ? 'tax-inclusive' : 'tax-exclusive'
      return {
        success: false,
        error: `Line tax for ${lineLabel(line)} does not match ${mode} pricing: expected ${expected.toFixed(4)}, received ${provided.toFixed(4)}`,
      }
    }
  }
  return warnings.length > 0 ? { success: true, warnings } : { success: true }
}
