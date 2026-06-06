import { Prisma } from '@/app/generated/prisma/client'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

export type ManufacturingCostLineInputLike = {
  description: string
  amountForeign: number
  accountCode?: string | null
}

export type ParsedManufacturingCostLine = {
  description: string
  amountForeign: number
  amountBase: number
  accountCode: string | null
  sortOrder: number
}

export type ParsedManufacturingCostLinesResult =
  | { success: true; lines: ParsedManufacturingCostLine[] }
  | { success: false; error: string }

export type ManufacturingCostLayerReceivedAtInput = {
  orderType: 'ASSEMBLY' | 'DISASSEMBLY'
  completedAt?: Date | null
  transitionAt: Date
}

// Tolerance for negative rounding dust from FX/discount arithmetic. Sized at a
// half-penny for the common 2dp-currency path; 3dp currencies should move this
// to a currency-aware minor-unit threshold when manufacturing cost lines gain a
// currency-specific parser.
const NEGATIVE_DUST_TOLERANCE = new Prisma.Decimal('0.005')

export function manufacturingCostLayerReceivedAt(input: ManufacturingCostLayerReceivedAtInput): Date {
  if (input.orderType === 'DISASSEMBLY') {
    return input.transitionAt
  }
  return input.completedAt ?? input.transitionAt
}

export function parseManufacturingCostLines(
  lines: ManufacturingCostLineInputLike[],
  fxRateToBase: number,
): ParsedManufacturingCostLinesResult {
  if (!Number.isFinite(fxRateToBase) || fxRateToBase <= 0) {
    return {
      success: false,
      error: `Invalid FX rate ${fxRateToBase} on production order; set a positive rate before editing cost lines.`,
    }
  }

  const fxRate = fxRateToBase
  const parsed: ParsedManufacturingCostLine[] = []

  for (const [idx, line] of lines.entries()) {
    const description = line.description.trim()
    if (description.length === 0 || !Number.isFinite(line.amountForeign)) continue

    const amountForeign = toDecimal(line.amountForeign)
    const amountBase = amountForeign.mul(fxRate)
    if (amountForeign.lt(NEGATIVE_DUST_TOLERANCE.neg()) || amountBase.lt(NEGATIVE_DUST_TOLERANCE.neg())) {
      return {
        success: false,
        error: 'Manufacturing cost amounts must be non-negative. Use a separate adjustment to credit inventory.',
      }
    }

    // Zero-amount cost lines are intentionally dropped. They have no financial
    // effect and would add accounting clutter; non-financial trace notes belong
    // on the production order notes field.
    if (amountForeign.lte(0) || amountBase.lte(0)) continue

    const roundedForeign = roundQuantity(amountForeign, 4)
    const roundedBase = roundQuantity(amountBase, 4)
    if (roundedForeign.lte(0) || roundedBase.lte(0)) continue

    parsed.push({
      description,
      amountForeign: roundedForeign.toNumber(),
      amountBase: roundedBase.toNumber(),
      accountCode: line.accountCode?.trim() || null,
      sortOrder: idx,
    })
  }

  return { success: true, lines: parsed }
}
