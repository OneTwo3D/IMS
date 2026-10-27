import { Prisma, type PrismaClient } from '@/app/generated/prisma/client'
import { resolveBaseCurrencyCode } from '@/lib/base-currency'
import { getFxSourceRegime } from './fx-source-regime'

import {
  FX_MISSING_REASONS, MissingFxRateError, isMissingFxRateError, endOfBusinessDateUtc, isValidCurrencyCode, isValidDate, refuse, selectFxRateFromRows,
  type FxMissingReason, type FxRateRow, type FxRateToBase,
} from './fx-select'

export { FX_MISSING_REASONS, MissingFxRateError, isMissingFxRateError, endOfBusinessDateUtc, isValidCurrencyCode, selectFxRateFromRows }
export type { FxMissingReason, FxRateRow, FxRateToBase }

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

/** What the helper needs from a Prisma client or transaction client. `organisation` is only read when no `baseCurrency` is passed. */
export type FxLookupClient = {
  fxRate: Pick<Prisma.TransactionClient['fxRate'], 'groupBy' | 'findMany'>
  /** Read for the FX source regime (lib/currencies/fx-source-regime.ts): every lookup applies it, so a client must be able to read the two settings. */
  setting: Pick<Prisma.TransactionClient['setting'], 'findMany'>
  organisation?: Pick<PrismaClient['organisation'], 'findFirst'>
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

  const regime = await getFxSourceRegime(client)
  const restricted = regime?.source === 'aelia' && asOf.getTime() >= regime.since.getTime()
  const eligible = { OR: [{ source: 'aelia' }, { manualOverride: true }] }
  const latest = await client.fxRate.groupBy({
    by: ['toCurrency'],
    where: { fromCurrency: base, toCurrency: { in: toQuery }, fetchedAt: { lte: asOf }, ...(restricted ? eligible : {}) },
    _max: { fetchedAt: true },
  })
  const pairs = latest.flatMap((g) => (g._max.fetchedAt ? [{ toCurrency: g.toCurrency, fetchedAt: g._max.fetchedAt }] : []))
  const rows = pairs.length === 0 ? [] : await client.fxRate.findMany({
    where: { fromCurrency: base, AND: [{ OR: pairs.map((p) => ({ toCurrency: p.toCurrency, fetchedAt: p.fetchedAt })) }, ...(restricted ? [eligible] : [])] },
    select: { fromCurrency: true, toCurrency: true, rate: true, fetchedAt: true, source: true, manualOverride: true },
  })
  for (const currency of toQuery) {
    try {
      out.set(currency, { ok: true, ...selectFxRateFromRows(rows, { baseCurrency: base, currency, asOf, regime }) })
    } catch (error) {
      if (!isMissingFxRateError(error)) throw error
      // Under the Aelia regime the query only fetched eligible rows, so "no row" means the selected source has not given this currency.
      out.set(currency, { ok: false, error: restricted && error.reason === 'no_rate' ? refuse('no_rate_from_selected_source', base, currency, asOf) : error })
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
