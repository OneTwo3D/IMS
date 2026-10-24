import { Prisma } from '@/app/generated/prisma/client'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'

/**
 * THE ONE EXCHANGE-RATE LOOKUP (owner ruling 2026-10-24).
 *
 * Every IMS read of an exchange rate goes through this module, against IMS's `fx_rates` table. The rules:
 *
 *  - CONVENTION. `FxRate.rate` means 1 BASE = `rate` FOREIGN, so `base = foreign / rate`.
 *  - THE BASE CURRENCY is the organisation's (`resolveBaseCurrencyCode`), never a literal. A caller that already
 *    holds it may pass `baseCurrency`; it is validated the same way.
 *  - A foreign currency equal to the base is 1 (`isBase`). Nothing else is ever defaulted to 1.
 *  - ROW SELECTION. The latest row with `fromCurrency = base`, `toCurrency = currency` and `fetchedAt <= asOf`.
 *  - A TIE AT THAT LATEST `fetchedAt` is accepted only when every tied row carries the same rate; otherwise it
 *    refuses (`ambiguous_rate`). A bad row (zero, negative, not a number) refuses even if an older row is fine:
 *    the older rate is not "the rate", it is a stale one.
 *  - A MISSING RATE REFUSES with `MissingFxRateError` and a closed `reason`. No default of 1, no fallback to a
 *    document's booked rate, no fallback to a vendor's rate. A caller that still has such a fallback owns it
 *    explicitly (see the TODO(o3d-q0x56.N) markers) and must catch `MissingFxRateError` to do so.
 *  - `asOf` IS REQUIRED. There is no implicit "now" in here; a caller that means now passes `new Date()`.
 *  - THE DATE RULE (one place): a business DATE (document date, payment date, valuation date) maps to the END of
 *    that day UTC, `endOfBusinessDateUtc`. A rate fetched at any time during the day is therefore the rate for
 *    the day's documents; a rate fetched the next morning is not. A caller holding an instant (an order's
 *    `orderedAt`, `new Date()`) passes the instant itself.
 *
 * The queries are the shape `groupBy` (latest fetchedAt per currency) then one `findMany` (the rows AT that
 * instant, so ties are visible). `selectFxRateFromRows` is the single authority over what those rows mean; it
 * re-applies the pair and `asOf` filters itself so a query that returns too much cannot widen the answer.
 */

export const FX_MISSING_REASONS = [
  'invalid_currency',
  'invalid_base_currency',
  'invalid_as_of',
  'no_rate',
  'non_positive_rate',
  'non_finite_rate',
  'ambiguous_rate',
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
}

/** What the helper needs from a Prisma client or transaction client. `organisation` is only read when no `baseCurrency` is passed. */
export type FxLookupClient = {
  fxRate: Pick<Prisma.TransactionClient['fxRate'], 'groupBy' | 'findMany'>
  organisation?: Pick<Prisma.TransactionClient['organisation'], 'findFirst'>
}

const CURRENCY_CODE = /^[A-Z]{3}$/

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && CURRENCY_CODE.test(code)
}

function isValidDate(value: unknown): value is Date {
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

function refuse(reason: FxMissingReason, base: string, currency: string, asOf: Date | undefined, message?: string): MissingFxRateError {
  const when = isValidDate(asOf) ? day(asOf) : 'an invalid date'
  const defaults: Record<FxMissingReason, string> = {
    invalid_currency: `Invalid currency code ${JSON.stringify(currency)}: three uppercase letters required`,
    invalid_base_currency: `Invalid base currency code ${JSON.stringify(base)}: three uppercase letters required`,
    invalid_as_of: 'FX lookup needs an explicit, valid asOf date',
    no_rate: `Missing ${base} FX rate for ${currency} on or before ${when}`,
    non_positive_rate: `Invalid stored ${base} FX rate for ${currency}`,
    non_finite_rate: `Invalid stored ${base} FX rate for ${currency}`,
    ambiguous_rate: `Ambiguous ${base} FX rate for ${currency} on or before ${when}`,
  }
  return new MissingFxRateError(message ?? defaults[reason], currency, isValidDate(asOf) ? asOf : undefined, reason, base)
}

function toRate(value: unknown): Prisma.Decimal | null {
  try {
    if (value === null || value === undefined || typeof value === 'boolean') return null
    const d = new Prisma.Decimal(value as Prisma.Decimal.Value)
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
  params: { baseCurrency: string; currency: string; asOf: Date },
): FxRateToBase {
  const { baseCurrency, currency, asOf } = params
  const candidates = rows.filter(
    (r) => r.fromCurrency === baseCurrency && r.toCurrency === currency && isValidDate(r.fetchedAt) && r.fetchedAt.getTime() <= asOf.getTime(),
  )
  if (candidates.length === 0) throw refuse('no_rate', baseCurrency, currency, asOf)
  const latest = candidates.reduce((max, r) => Math.max(max, r.fetchedAt.getTime()), -Infinity)
  const tied = candidates.filter((r) => r.fetchedAt.getTime() === latest)
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

export type FxRateOutcome = ({ ok: true } & FxRateToBase) | { ok: false; error: MissingFxRateError }

async function baseFor(client: FxLookupClient, baseCurrency: string | undefined, asOf: Date): Promise<string> {
  let base: string
  if (baseCurrency !== undefined) base = baseCurrency
  else {
    if (!client.organisation) throw refuse('invalid_base_currency', String(baseCurrency), '', asOf, 'FX lookup needs a baseCurrency or a client that can read the organisation')
    base = await resolveBaseCurrencyCode({ organisation: client.organisation })
  }
  if (!isValidCurrencyCode(base)) throw refuse('invalid_base_currency', String(base), '', asOf)
  return base
}

/**
 * Many currencies at ONE `asOf`, never throwing for a single currency: each gets an outcome. Two queries however
 * many currencies. Throws only for what makes the whole call meaningless (`asOf`, base currency).
 */
export async function resolveFxRatesToBase(
  client: FxLookupClient,
  params: { currencies: readonly string[]; asOf: Date; baseCurrency?: string },
): Promise<Map<string, FxRateOutcome>> {
  const { asOf } = params
  if (!isValidDate(asOf)) throw refuse('invalid_as_of', String(params.baseCurrency ?? ''), '', undefined)
  const base = await baseFor(client, params.baseCurrency, asOf)
  const out = new Map<string, FxRateOutcome>()
  const toQuery: string[] = []
  for (const currency of new Set(params.currencies)) {
    if (!isValidCurrencyCode(currency)) out.set(currency, { ok: false, error: refuse('invalid_currency', base, String(currency), asOf) })
    else if (currency === base) out.set(currency, { ok: true, rate: new Prisma.Decimal(1), fetchedAt: asOf, source: 'base', manualOverride: false, isBase: true })
    else toQuery.push(currency)
  }
  if (toQuery.length === 0) return out

  const latest = await client.fxRate.groupBy({
    by: ['toCurrency'],
    where: { fromCurrency: base, toCurrency: { in: toQuery }, fetchedAt: { lte: asOf } },
    _max: { fetchedAt: true },
  })
  const pairs = latest.flatMap((g) => (g._max.fetchedAt ? [{ toCurrency: g.toCurrency, fetchedAt: g._max.fetchedAt }] : []))
  const rows = pairs.length === 0 ? [] : await client.fxRate.findMany({
    where: { fromCurrency: base, OR: pairs.map((p) => ({ toCurrency: p.toCurrency, fetchedAt: p.fetchedAt })) },
    select: { fromCurrency: true, toCurrency: true, rate: true, fetchedAt: true, source: true, manualOverride: true },
  })
  for (const currency of toQuery) {
    try {
      out.set(currency, { ok: true, ...selectFxRateFromRows(rows, { baseCurrency: base, currency, asOf }) })
    } catch (error) {
      if (!isMissingFxRateError(error)) throw error
      out.set(currency, { ok: false, error })
    }
  }
  return out
}

/** Many currencies at one `asOf`; refuses with the first unresolved currency's error. */
export async function getFxRatesToBase(
  client: FxLookupClient,
  params: { currencies: readonly string[]; asOf: Date; baseCurrency?: string },
): Promise<Map<string, FxRateToBase>> {
  const outcomes = await resolveFxRatesToBase(client, params)
  const result = new Map<string, FxRateToBase>()
  for (const [currency, outcome] of outcomes) {
    if (!outcome.ok) throw outcome.error
    const { ok: _ok, ...rate } = outcome
    void _ok
    result.set(currency, rate)
  }
  return result
}

/** The rate for one currency: 1 base = `rate` foreign. Refuses (MissingFxRateError) rather than defaulting. */
export async function getFxRateToBase(
  client: FxLookupClient,
  params: { currency: string; asOf: Date; baseCurrency?: string },
): Promise<FxRateToBase> {
  if (!isValidCurrencyCode(params.currency)) {
    throw refuse('invalid_currency', params.baseCurrency ?? '', String(params.currency), isValidDate(params.asOf) ? params.asOf : undefined)
  }
  const outcome = (await resolveFxRatesToBase(client, { currencies: [params.currency], asOf: params.asOf, baseCurrency: params.baseCurrency })).get(params.currency)
  if (!outcome) throw refuse('no_rate', params.baseCurrency ?? '', params.currency, params.asOf)
  if (!outcome.ok) throw outcome.error
  const { ok: _ok, ...rate } = outcome
  void _ok
  return rate
}
