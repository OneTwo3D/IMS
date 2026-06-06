import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'

export type SalesOrderLineTaxValidationInput = {
  sku?: string | null
  qty: DecimalInput
  unitPriceForeign: DecimalInput
  discountAmount?: DecimalInput | null
  taxRateValue?: DecimalInput | null
  taxForeign?: DecimalInput | null
}

export type SalesOrderLineTaxValidationResult =
  | { success: true }
  | { success: false; error: string }

const DEFAULT_TOLERANCE = new Prisma.Decimal('0.0001')

function lineLabel(line: SalesOrderLineTaxValidationInput): string {
  return line.sku?.trim() || 'line item'
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
  for (const line of lines) {
    const grossOrNet = toDecimal(line.qty)
      .mul(toDecimal(line.unitPriceForeign))
      .sub(toDecimal(line.discountAmount ?? 0))
    if (grossOrNet.lt(0)) {
      return { success: false, error: `Discount exceeds line total for ${lineLabel(line)}` }
    }

    if (line.taxForeign == null) continue
    const expected = roundQuantity(expectedSalesOrderLineTaxForeign(line, pricesIncludeVat), 4)
    const provided = roundQuantity(line.taxForeign, 4)
    if (provided.sub(expected).abs().gt(tolerance)) {
      const mode = pricesIncludeVat ? 'tax-inclusive' : 'tax-exclusive'
      return {
        success: false,
        error: `Line tax for ${lineLabel(line)} does not match ${mode} pricing: expected ${expected.toFixed(4)}, received ${provided.toFixed(4)}`,
      }
    }
  }
  return { success: true }
}
