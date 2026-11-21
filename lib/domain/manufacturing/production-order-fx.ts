import { Prisma } from '@/app/generated/prisma/client'
import { getFxRateToBase, isMissingFxRateError, type FxLookupClient } from '@/lib/currencies/fx-lookup'
import { fxRateChangedMessage, missingFxRateMessage } from '@/lib/currencies/form-fx-rate'

/** What the resolver reads: the FX lookup client plus the currencies table (a foreign currency must be an active one). */
export type ProductionOrderFxClient = FxLookupClient & {
  currency: { findUnique: (args: { where: { code: string }; select: { active: true } }) => Promise<{ active: boolean } | null> }
}

export type ProductionOrderFxInput = {
  /** The order currency chosen at create. Blank / undefined means "not chosen": the caller keeps the schema defaults (base currency, rate 1). */
  currency: unknown
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
  client: ProductionOrderFxClient,
  input: ProductionOrderFxInput,
): Promise<ProductionOrderFxResolution> {
  // A server action input is untrusted: a non-string (number, object) is refused, not a TypeError.
  if (input.currency != null && typeof input.currency !== 'string') return { ok: false, error: 'Currency must be a text code such as EUR.' }
  const raw = input.currency?.trim().toUpperCase() ?? ''
  if (!raw) return { ok: true, chosen: false }
  const base = input.baseCurrency.trim().toUpperCase()
  if (raw === base) {
    return { ok: true, chosen: true, currency: base, fxRateToBase: new Prisma.Decimal(1), source: 'base', manualOverride: false, fetchedAt: input.asOf }
  }
  // A rate row can outlive the currency being switched off; an inactive currency is not offered on the form, so it is not accepted here.
  const meta = await client.currency.findUnique({ where: { code: raw }, select: { active: true } })
  if (!meta?.active) return { ok: false, error: `Currency ${raw} is not active. Pick an active currency.` }
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

/**
 * The currency columns of a new production order. A chosen currency writes its code and the table rate; no currency chosen writes the
 * ORGANISATION's base currency explicitly (the schema default is a literal GBP) and leaves the rate at the schema default of 1.
 */
export function productionOrderFxCreateData(
  fx: Extract<ProductionOrderFxResolution, { ok: true }>,
  baseCurrency: string,
): { currency: string; fxRateToBase?: Prisma.Decimal } {
  return fx.chosen ? { currency: fx.currency, fxRateToBase: fx.fxRateToBase } : { currency: baseCurrency.trim().toUpperCase() }
}

/** The FX provenance recorded in the "created" activity metadata; empty when no currency was chosen. */
export function productionOrderFxActivityMetadata(fx: Extract<ProductionOrderFxResolution, { ok: true }>): Record<string, unknown> {
  if (!fx.chosen) return {}
  return {
    currency: fx.currency,
    fxRateToBase: fx.fxRateToBase.toString(),
    fxRateSource: fx.source,
    fxRateManualOverride: fx.manualOverride,
    fxRateFetchedAt: fx.fetchedAt.toISOString(),
  }
}
