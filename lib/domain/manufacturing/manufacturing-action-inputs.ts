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

const NEGATIVE_DUST_TOLERANCE = new Prisma.Decimal('0.005')

export function manufacturingCostLayerReceivedAt(completedAt: Date | null | undefined, fallback: Date): Date {
  return completedAt ?? fallback
}

export function parseManufacturingCostLines(
  lines: ManufacturingCostLineInputLike[],
  fxRateToBase: number,
): ParsedManufacturingCostLinesResult {
  const fxRate = Number.isFinite(fxRateToBase) && fxRateToBase > 0 ? fxRateToBase : 1
  const parsed: ParsedManufacturingCostLine[] = []

  for (const line of lines) {
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

    if (amountForeign.lte(0) || amountBase.lte(0)) continue

    const roundedForeign = roundQuantity(amountForeign, 4)
    const roundedBase = roundQuantity(amountBase, 4)
    if (roundedForeign.lte(0) || roundedBase.lte(0)) continue

    parsed.push({
      description,
      amountForeign: roundedForeign.toNumber(),
      amountBase: roundedBase.toNumber(),
      accountCode: line.accountCode?.trim() || null,
      sortOrder: parsed.length,
    })
  }

  return { success: true, lines: parsed }
}
