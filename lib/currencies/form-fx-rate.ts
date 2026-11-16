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

/**
 * Full-precision memory for a converted money field, so repeated currency changes do not compound the 2dp rounding:
 * `base` is the amount in the base currency, `shown` the rounded figure the field was last given. While the field still
 * shows `shown` (the user has not edited it) the next conversion starts from `base`; an edited field starts from what it shows.
 */
export type MoneyAnchor = { shown: number; base: number }

export function convertAnchored(value: number, anchor: MoneyAnchor | undefined, fromRate: number | null, toRate: number | null): { value: number; anchor: MoneyAnchor | undefined } {
  if (fromRate === null || toRate === null || !(fromRate > 0) || !(toRate > 0) || !Number.isFinite(value)) return { value, anchor }
  const base = anchor && anchor.shown === value ? anchor.base : value / fromRate
  const next = Math.round(base * toRate * 100) / 100
  return { value: next, anchor: { shown: next, base } }
}

/** A discount field ("10%" or "5"), anchored like a price: a percentage stays as typed, blank stays blank, an unreadable value is returned unchanged. */
export function convertDiscountAnchored(input: string, anchor: MoneyAnchor | undefined, fromRate: number | null, toRate: number | null): { value: string; anchor: MoneyAnchor | undefined } {
  const s = input.trim()
  if (!s || s.endsWith('%')) return { value: input, anchor }
  const abs = parseFloat(s)
  if (Number.isNaN(abs)) return { value: input, anchor }
  const r = convertAnchored(abs, anchor, fromRate, toRate)
  return { value: String(r.value), anchor: r.anchor }
}

/** Unanchored form of the discount conversion (one step, no memory). */
export function repriceDiscountStr(input: string, fromRate: number | null, toRate: number | null): string {
  return convertDiscountAnchored(input, undefined, fromRate, toRate).value
}

/** The FX_RATE_CHANGED refusal the create actions return when the table rate moved after the form read it. */
export function isFxRateChangedError(error: string | undefined): boolean {
  return !!error && error.startsWith('FX_RATE_CHANGED:')
}

export const FX_RATE_CHANGED_FORM_MESSAGE = 'The exchange rate changed while you were working. The rate and the amounts shown have been updated: check them, then submit again.'

export function fxRateChangedMessage(currency: string, expected: number, actual: number): string {
  return `FX_RATE_CHANGED: the ${currency} table rate moved from ${expected} to ${actual} since it was checked; nothing was written`
}
