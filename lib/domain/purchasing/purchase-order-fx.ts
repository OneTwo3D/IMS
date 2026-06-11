import { Prisma } from '@/app/generated/prisma/client'

export const PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE = 0.02

type PurchaseOrderFxClient = Pick<Prisma.TransactionClient, 'fxRate'>

export type ResolvePurchaseOrderFxRateInput = {
  currency: string
  baseCurrency: string
  asOf: Date
  inputRateToBase?: number | null
}

export async function resolvePurchaseOrderFxRateToBase(
  client: PurchaseOrderFxClient,
  input: ResolvePurchaseOrderFxRateInput,
): Promise<number> {
  const currency = input.currency.trim().toUpperCase()
  const baseCurrency = input.baseCurrency.trim().toUpperCase()
  if (!currency || currency === baseCurrency) return 1

  const latestRate = await client.fxRate.findFirst({
    where: {
      fromCurrency: baseCurrency,
      toCurrency: currency,
      fetchedAt: { lte: input.asOf },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true, fetchedAt: true },
  })
  if (!latestRate) {
    throw new Error(`Missing ${baseCurrency} FX rate for ${currency} on or before ${input.asOf.toISOString().slice(0, 10)}`)
  }

  const resolvedRate = Number(latestRate.rate)
  if (!Number.isFinite(resolvedRate) || resolvedRate <= 0) {
    throw new Error(`Invalid stored ${baseCurrency} FX rate for ${currency}`)
  }

  const inputRate = input.inputRateToBase
  if (inputRate == null || !Number.isFinite(inputRate) || inputRate <= 0) return resolvedRate

  const deltaRatio = Math.abs(inputRate - resolvedRate) / resolvedRate
  if (deltaRatio > PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE) {
    const deltaPercent = (deltaRatio * 100).toFixed(2)
    throw new Error(
      `PO FX rate ${inputRate} for ${currency} differs by ${deltaPercent}% from the latest ` +
      `${baseCurrency} rate ${resolvedRate} on or before ${input.asOf.toISOString().slice(0, 10)}; ` +
      `refresh the rate or use an override within ${(PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE * 100).toFixed(0)}%.`,
    )
  }

  return inputRate
}
