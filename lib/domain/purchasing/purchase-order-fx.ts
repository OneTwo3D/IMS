import { getFxRateToBase, type FxLookupClient } from '@/lib/currencies/fx-lookup'

export const PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE = 0.02

export type PurchaseOrderFxClient = FxLookupClient

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

  // The one central lookup. A missing rate throws "Missing <base> FX rate for <cur> on or before <date>" and a
  // stored zero/negative rate throws "Invalid stored <base> FX rate for <cur>", as this function always did.
  // TODO(o3d-q0x56.6): the user-typed override below is removed there; this lookup then becomes the whole answer.
  const latestRate = await getFxRateToBase(client, { currency, asOf: input.asOf, baseCurrency })
  const resolvedRate = latestRate.rate.toNumber()

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
