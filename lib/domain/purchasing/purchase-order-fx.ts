import { getFxRateToBase, type FxLookupClient } from '@/lib/currencies/fx-lookup'

export type PurchaseOrderFxClient = FxLookupClient

export type ResolvePurchaseOrderFxRateInput = {
  currency: string
  baseCurrency: string
  asOf: Date
}

/**
 * A purchase order's rate to base: ALWAYS the central fx_rates rate (the latest row on or before `asOf`, lib/currencies/fx-lookup.ts getFxRateToBase), or 1 for the base
 * currency. There is no user-supplied rate and no tolerance band: "one rate means the table rate" (owner ruling 2026-10-25, o3d-q0x56.6). A missing rate throws
 * "Missing <base> FX rate for <cur> on or before <date>" and a stored zero/negative rate throws "Invalid stored <base> FX rate for <cur>". An admin who needs a different
 * rate pins a manual override row in fx_rates (Settings, Accounting, FX Rates: app/actions/currencies.ts setManualFxRate): it is simply the latest row.
 */
export async function resolvePurchaseOrderFxRateToBase(
  client: PurchaseOrderFxClient,
  input: ResolvePurchaseOrderFxRateInput,
): Promise<number> {
  const currency = input.currency.trim().toUpperCase()
  const baseCurrency = input.baseCurrency.trim().toUpperCase()
  if (!currency || currency === baseCurrency) return 1
  const latestRate = await getFxRateToBase(client, { currency, asOf: input.asOf, baseCurrency })
  return latestRate.rate.toNumber()
}
