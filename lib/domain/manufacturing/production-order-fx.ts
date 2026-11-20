import { Prisma } from '@/app/generated/prisma/client'
import { getFxRateToBase, isMissingFxRateError, type FxLookupClient } from '@/lib/currencies/fx-lookup'
import { fxRateChangedMessage, missingFxRateMessage } from '@/lib/currencies/form-fx-rate'

export type ProductionOrderFxInput = {
  /** The order currency chosen at create. Blank / undefined means "not chosen": the caller keeps the schema defaults (base currency, rate 1). */
  currency: string | null | undefined
  baseCurrency: string
  asOf: Date
  /** The rate the form displayed; a different table rate now is refused (same FX_RATE_CHANGED contract as the PO form). */
  expectedFxRate?: number
}

export type ProductionOrderFxResolution =
  | { ok: true; chosen: false }
  | {
      ok: true
      chosen: true
      currency: string
      /** 1 base = fxRateToBase foreign, exactly as the fx_rates row (Decimal(18,8) on the order). */
      fxRateToBase: Prisma.Decimal
      /** Provenance, recorded in the activity log: 'base' for the base currency, else the fx_rates row's source. */
      source: string
      manualOverride: boolean
      fetchedAt: Date
    }
  | { ok: false; error: string }

/**
 * The currency + rate of a new production order. Mirrors the PO / sales-order forms (#921): the rate is ALWAYS the central
 * fx_rates table rate (Aelia is the master, via lib/currencies/fx-lookup.ts), or 1 for the base currency. A missing rate
 * is a refusal, never a default of 1; there is no typed rate.
 */
export async function resolveProductionOrderFx(
  client: FxLookupClient,
  input: ProductionOrderFxInput,
): Promise<ProductionOrderFxResolution> {
  const raw = input.currency?.trim().toUpperCase() ?? ''
  if (!raw) return { ok: true, chosen: false }
  const base = input.baseCurrency.trim().toUpperCase()
  if (raw === base) {
    return { ok: true, chosen: true, currency: base, fxRateToBase: new Prisma.Decimal(1), source: 'base', manualOverride: false, fetchedAt: input.asOf }
  }
  try {
    const r = await getFxRateToBase(client, { currency: raw, asOf: input.asOf, baseCurrency: base })
    if (input.expectedFxRate !== undefined && input.expectedFxRate !== r.rate.toNumber()) {
      return { ok: false, error: fxRateChangedMessage(raw, input.expectedFxRate, r.rate.toNumber()) }
    }
    return { ok: true, chosen: true, currency: raw, fxRateToBase: r.rate, source: r.source, manualOverride: r.manualOverride, fetchedAt: r.fetchedAt }
  } catch (error) {
    if (isMissingFxRateError(error)) return { ok: false, error: missingFxRateMessage(raw) }
    throw error
  }
}
