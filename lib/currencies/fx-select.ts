import { Prisma } from '@/app/generated/prisma/client'
import { compareFxRowOrder, eligibleRowsUnderAeliaRegime, fxRegimeRestrictsAt, type FxSourceRegime } from './fx-source-regime'

/**
 * The PURE half of the one exchange-rate lookup (no database, no base-currency module): the closed refusal reasons, the date rule and the row
 * selection rule. lib/currencies/fx-lookup.ts re-exports all of it and adds the database reads; the offline first-load tool imports THIS file so that
 * it applies the same rule over a supplied list of fx_rates rows without opening a database. The rules are documented in fx-lookup.ts.
 */

export const FX_MISSING_REASONS = [
  'invalid_currency',
  'invalid_base_currency',
  'invalid_as_of',
  'no_rate',
  'non_positive_rate',
  'non_finite_rate',
  'ambiguous_rate',
  'no_rate_from_selected_source',
  'fx_source_history_unreadable',
] as const
export type FxMissingReason = (typeof FX_MISSING_REASONS)[number]

export class MissingFxRateError extends Error {
  constructor(
    message: string,
    readonly currency: string,
    readonly asOf: Date | undefined,
    readonly reason: FxMissingReason = 'no_rate',
    readonly baseCurrency?: string,
  ) {
    super(message)
    this.name = 'MissingFxRateError'
  }
}

export function isMissingFxRateError(error: unknown): error is MissingFxRateError {
  return error instanceof MissingFxRateError
}

export type FxRateToBase = {
  /** 1 base = `rate` foreign; base = foreign / rate. */
  rate: Prisma.Decimal
  /** When the row was fetched. For the base currency (no row) this is `asOf`. */
  fetchedAt: Date
  source: string
  manualOverride: boolean
  isBase: boolean
}

export type FxRateRow = {
  fromCurrency: string
  toCurrency: string
  rate: unknown
  fetchedAt: Date
  source?: string
  manualOverride?: boolean
  /** Write order (fx_rates.seq): breaks a fetchedAt tie, the later write is the later row. Absent on rows from a source that does not know it. */
  seq?: bigint | number | null
}

const CURRENCY_CODE = /^[A-Z]{3}$/

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && CURRENCY_CODE.test(code)
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * THE DATE RULE. A business date maps to 23:59:59.999 UTC of that calendar day. A `Date` input contributes its UTC
 * calendar date (not the server's local day); a string must be exactly `YYYY-MM-DD` and a real date.
 */
export function endOfBusinessDateUtc(input: Date | string): Date {
  let y: number
  let m: number
  let d: number
  if (typeof input === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
    if (!match) throw new MissingFxRateError(`Not a business date (YYYY-MM-DD): ${JSON.stringify(input)}`, '', undefined, 'invalid_as_of')
    ;[y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
    const probe = new Date(Date.UTC(y, m, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m || probe.getUTCDate() !== d) {
      throw new MissingFxRateError(`Not a real calendar date: ${input}`, '', undefined, 'invalid_as_of')
    }
  } else {
    if (!isValidDate(input)) throw new MissingFxRateError('Not a valid date for an FX lookup', '', undefined, 'invalid_as_of')
    ;[y, m, d] = [input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()]
  }
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999))
}

export function refuse(reason: FxMissingReason, base: string, currency: string, asOf: Date | undefined, message?: string): MissingFxRateError {
  const when = isValidDate(asOf) ? day(asOf) : 'an invalid date'
  const defaults: Record<FxMissingReason, string> = {
    invalid_currency: `Invalid currency code ${JSON.stringify(currency)}: three uppercase letters required`,
    invalid_base_currency: `Invalid base currency code ${JSON.stringify(base)}: three uppercase letters required`,
    invalid_as_of: 'FX lookup needs an explicit, valid asOf date',
    no_rate: `Missing ${base} FX rate for ${currency} on or before ${when}`,
    non_positive_rate: `Invalid stored ${base} FX rate for ${currency}`,
    non_finite_rate: `Invalid stored ${base} FX rate for ${currency}`,
    ambiguous_rate: `Ambiguous ${base} FX rate for ${currency} on or before ${when}`,
    fx_source_history_unreadable: 'The stored FX source switch history is unreadable, so no exchange rate can be chosen safely; every FX lookup is refused until the history is repaired (switching the FX source rewrites it)',
    no_rate_from_selected_source: `The FX source is Aelia and it has given no ${base} rate for ${currency} on or before ${when}; no other source is used`,
  }
  return new MissingFxRateError(message ?? defaults[reason], currency, isValidDate(asOf) ? asOf : undefined, reason, base)
}

function toRate(value: unknown): Prisma.Decimal | null {
  try {
    if (value === null || value === undefined || typeof value === 'boolean') return null
    const d = new Prisma.Decimal(value as ConstructorParameters<typeof Prisma.Decimal>[0])
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

/**
 * The pure rule over rows already read. Rows of other pairs and rows after `asOf` are ignored; the latest
 * `fetchedAt` wins; every row at that instant must be a usable rate and all must agree.
 */
export function selectFxRateFromRows(
  rows: readonly FxRateRow[],
  params: { baseCurrency: string; currency: string; asOf: Date; regime?: FxSourceRegime },
): FxRateToBase {
  const { baseCurrency, currency, asOf, regime } = params
  if (regime?.unreadable) throw refuse('fx_source_history_unreadable', baseCurrency, currency, asOf)
  const inPair = rows.filter(
    (r) => r.fromCurrency === baseCurrency && r.toCurrency === currency && isValidDate(r.fetchedAt) && r.fetchedAt.getTime() <= asOf.getTime(),
  )
  // THE SOURCE REGIME (fx-source-regime.ts): inside an Aelia interval only Aelia rows and manual overrides IN FORCE (the latest row of the pair across all sources) are eligible; outside every interval, nothing changes.
  const restricted = fxRegimeRestrictsAt(regime ?? null, asOf)
  const candidates = restricted ? eligibleRowsUnderAeliaRegime(inPair) : inPair
  if (candidates.length === 0) throw refuse(inPair.length > 0 ? 'no_rate_from_selected_source' : 'no_rate', baseCurrency, currency, asOf)
  const latest = candidates.reduce((max, r) => Math.max(max, r.fetchedAt.getTime()), -Infinity)
  let tied = candidates.filter((r) => r.fetchedAt.getTime() === latest)
  // A TIE ON fetchedAt between a manual override and a non-override row goes to the LATER WRITE (seq): a pin set after a refresh won, and a clear (an ECB or Aelia row) written after a pin cleared it. Rows of one
  // kind that disagree stay ambiguous, as before; so do rows without a seq.
  const pins = tied.filter((r) => r.manualOverride === true)
  const others = tied.filter((r) => r.manualOverride !== true)
  if (pins.length > 0 && others.length > 0) {
    const later = (x: FxRateRow, y: FxRateRow) => (compareFxRowOrder(x, y) >= 0 ? x : y)
    const c = compareFxRowOrder(pins.reduce(later), others.reduce(later))
    if (c > 0) tied = pins
    else if (c < 0) tied = others
  }
  const rates: Prisma.Decimal[] = []
  for (const r of tied) {
    const rate = toRate(r.rate)
    if (rate === null) throw refuse('non_finite_rate', baseCurrency, currency, asOf)
    if (!rate.gt(0)) throw refuse('non_positive_rate', baseCurrency, currency, asOf)
    rates.push(rate)
  }
  if (rates.some((r) => !r.equals(rates[0]))) {
    throw refuse(
      'ambiguous_rate', baseCurrency, currency, asOf,
      `Ambiguous ${baseCurrency} FX rate for ${currency}: ${tied.length} rows share fetchedAt ${new Date(latest).toISOString()} with different rates`,
    )
  }
  const sources = [...new Set(tied.map((r) => r.source ?? 'unknown'))].sort()
  return {
    rate: rates[0],
    fetchedAt: new Date(latest),
    source: sources.join(','),
    manualOverride: tied.some((r) => r.manualOverride === true),
    isBase: false,
  }
}

