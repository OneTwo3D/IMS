import { isMissingFxRateError } from './fx-select'

/**
 * What the PO and sales-order forms show for a foreign currency (pure; the server action in app/actions/currencies.ts
 * fills it from the one central lookup, lib/currencies/fx-lookup.ts, over `fx_rates`, which Aelia feeds).
 *
 * `missing` is a REFUSAL: the form blocks submit and never falls back to a rate of 1. The server re-reads the table
 * rate when the order is saved and refuses a missing one too, so this is the early, readable version of that refusal.
 */
export type FormFxRate =
  | { state: 'base' }
  | { state: 'ok'; rate: number; fetchedAt: string; source: string; manualOverride: boolean }
  | { state: 'missing'; currency: string; message: string }

/** Where an admin can add or pin a rate. */
export const FX_RATES_SETTINGS_PATH = '/settings/accounting'

export function missingFxRateMessage(currency: string): string {
  return `No exchange rate for ${currency} yet: rates come from the store (Aelia). Ask an admin to sync the rates or pin one in Settings, Accounting, FX Rates, then pick the currency again.`
}

export function missingFormFxRate(currency: string): FormFxRate {
  return { state: 'missing', currency, message: missingFxRateMessage(currency) }
}

/** The rate a form may use, or null when there is none (never 1 by default). */
export function usableRate(fx: FormFxRate): number | null {
  if (fx.state === 'base') return 1
  if (fx.state === 'ok' && Number.isFinite(fx.rate) && fx.rate > 0) return fx.rate
  return null
}

/** True when the form must not be submitted for this currency state. `loading` is a rate still being fetched. */
export function fxBlocksSubmit(fx: FormFxRate | null): boolean {
  return fx === null || usableRate(fx) === null
}

/** Maps a lookup failure to the form state. Only a missing-rate refusal is a state; anything else is a real error and rethrown. */
export function formFxRateFromError(currency: string, error: unknown): FormFxRate {
  if (isMissingFxRateError(error)) return missingFormFxRate(currency)
  throw error
}

export function describeFxSource(source: string, manualOverride: boolean): string {
  if (manualOverride) return 'manual override'
  if (source === 'aelia') return 'Aelia'
  if (source === 'frankfurter') return 'ECB (frankfurter)'
  return source
}

/**
 * A price typed in one currency, restated in another through the base currency (rates are 1 base = rate foreign, so
 * base = foreign / rate). Rounded to the pence like every other line price in the form. Null when either rate is unusable.
 */
export function repriceUnitPrice(price: number, fromRate: number | null, toRate: number | null): number | null {
  if (fromRate === null || toRate === null) return null
  if (!(fromRate > 0) || !(toRate > 0) || !Number.isFinite(price)) return null
  return Math.round((price / fromRate) * toRate * 100) / 100
}
