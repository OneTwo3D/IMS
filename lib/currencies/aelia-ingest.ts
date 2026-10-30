import { Prisma } from '@/app/generated/prisma/client'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { withFxTableWriteLock } from '@/lib/currencies/fx-table-lock'

type FxTx = Parameters<Parameters<typeof withFxTableWriteLock>[0]>[0]

/**
 * INGEST OF AELIA'S EXCHANGE RATES INTO fx_rates (FX source 'aelia'; lib/currencies/fx-source.ts).
 *
 * THE RATE IS THE RATE BEFORE MARKUP. Aelia keeps, per currency, `rate` (the exchange rate) and `rate_markup` (an ABSOLUTE amount it adds to the rate for storefront prices: a price uplift, not an
 * exchange rate). The helper plugin returns the two separately (lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php, GET /wp-json/oti/v1/aelia-rates). IMS stores `rate` EXACTLY as Aelia
 * holds it and NEVER rate + markup: Xero, the documents and the ledger convert at the exchange rate, not at a price uplift. The markup is returned in the result (so it can be seen and verified)
 * and is written nowhere.
 *
 * TIME. The row's fetchedAt is AELIA'S OWN last-update time, not the moment IMS read it. That makes the read idempotent (the same Aelia update is the same row) and keeps "the rate in force at
 * date D" meaning what Aelia's table said at D.
 *
 * REFUSALS. A missing rate, one that is not a plain positive decimal, one with more digits than the column holds (it would be rounded, so the stored row would not equal Aelia's), a currency IMS
 * does not know, an IMS currency Aelia does not list, a base currency that differs from IMS's, and a missing or future update time are all refused: nothing is stored for them and nothing is
 * substituted (never 1, never another source). A refusal of the base currency or of the update time refuses the whole read; the others refuse that currency only.
 *
 * MARKUP RULE. `rate_markup` is never an input to the stored rate, so a non-base currency whose markup is absent is still stored at its `rate`; its markup is reported as null (unknown), never as 0.
 * The base currency's own row is skipped (see parseAeliaRatesPayload).
 *
 * MANUAL OVERRIDES keep working exactly as for the ECB fetch: a currency whose latest row is a manual override is skipped (the pin stays until the admin clears it), and a row written here is an
 * ordinary row that selectFxRateFromRows ranks by fetchedAt like any other.
 *
 * EVERY WRITE IS INSIDE withFxTableWriteLock (the exclusive side of the table's stability lock, so a running CSV import holds this still); tests/currencies/fx-table-writers-census.test.ts checks it.
 */

export const AELIA_SOURCE = 'aelia'

/** The most digits after the point fx_rates.rate keeps (Decimal(18,8)). */
const RATE_DECIMALS = 8
/** The most digits before the point (Decimal(18,8)). */
const RATE_INTEGER_DIGITS = 10
/** An update time further ahead than this is a clock fault, not a rate. */
const FUTURE_TOLERANCE_MS = 5 * 60_000

export const AELIA_REFUSALS = [
  'payload_invalid',
  'base_mismatch',
  'no_update_time',
  'future_update_time',
  'missing_rate',
  'non_finite_rate',
  'non_positive_rate',
  'rate_precision',
  'unknown_currency',
  'not_listed_by_aelia',
  'duplicate_currency',
  'changed_without_update',
] as const
export type AeliaRefusalReason = (typeof AELIA_REFUSALS)[number]

export type AeliaRefusal = { currency: string | null; reason: AeliaRefusalReason; message: string }

export type AeliaRateEntry = {
  currency: string
  /** The rate before markup, as a plain decimal string, exactly as Aelia holds it. */
  rate: string
  /** Aelia's markup as the plugin returned it. Returned for verification; never stored, never added to the rate. */
  markup: string | null
  setManually: boolean
  decimals: number | null
}

export type AeliaParsed = {
  base: string
  updatedAt: Date
  entries: AeliaRateEntry[]
  /** Per-entry refusals found while parsing (missing, non-positive, non-finite, too precise, duplicate). */
  refused: AeliaRefusal[]
}

export class AeliaRefusedError extends Error {
  constructor(readonly reason: AeliaRefusalReason, message: string) {
    super(message)
    this.name = 'AeliaRefusedError'
  }
}

const CURRENCY = /^[A-Z]{3}$/
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

/** Classify one rate value. Returns the plain decimal string (trailing zeros kept as Aelia holds them) or the refusal. */
function parseRate(value: unknown): { ok: true; rate: string } | { ok: false; reason: AeliaRefusalReason; message: string } {
  const text = asText(value)
  if (text === null || text === '') return { ok: false, reason: 'missing_rate', message: 'Aelia lists no rate' }
  if (!PLAIN_DECIMAL.test(text)) {
    // "-1.2", "0", "-0" are numbers that are not positive; "NaN", "Infinity", "1e400" and words are not usable numbers at all.
    const n = Number(text)
    if (Number.isFinite(n) && text !== '') return { ok: false, reason: 'non_positive_rate', message: `Aelia's rate ${JSON.stringify(text)} is not a positive plain decimal` }
    return { ok: false, reason: 'non_finite_rate', message: `Aelia's rate ${JSON.stringify(text)} is not a finite number` }
  }
  const [whole, fraction = ''] = text.split('.')
  if (!new Prisma.Decimal(text).gt(0)) return { ok: false, reason: 'non_positive_rate', message: `Aelia's rate ${text} is not positive` }
  const significantFraction = fraction.replace(/0+$/, '')
  if (significantFraction.length > RATE_DECIMALS || whole.replace(/^0+(?=\d)/, '').length > RATE_INTEGER_DIGITS) {
    return { ok: false, reason: 'rate_precision', message: `Aelia's rate ${text} does not fit the stored precision (${RATE_INTEGER_DIGITS}.${RATE_DECIMALS}) and would be rounded` }
  }
  return { ok: true, rate: text }
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const d = new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

/** The PURE half: validate the plugin's answer. Throws AeliaRefusedError for a refusal of the whole read. */
export function parseAeliaRatesPayload(body: unknown, now: Date = new Date()): AeliaParsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AeliaRefusedError('payload_invalid', 'The helper plugin did not answer with an object')
  const p = body as Record<string, unknown>
  if (p.ok !== true || !Array.isArray(p.rates)) throw new AeliaRefusedError('payload_invalid', 'The helper plugin answer has no rate list')
  const base = typeof p.base === 'string' ? p.base.trim().toUpperCase() : ''
  if (!CURRENCY.test(base)) throw new AeliaRefusedError('payload_invalid', 'The helper plugin answer names no valid base currency')
  if (p.last_update === null || p.last_update === undefined || p.last_update === '') {
    throw new AeliaRefusedError('no_update_time', "Aelia's own last-update time is not available, so the rates cannot be dated")
  }
  const updatedAt = parseIso(p.last_update)
  if (updatedAt === null) throw new AeliaRefusedError('no_update_time', "Aelia's last-update time is not an ISO-8601 timestamp")
  if (updatedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) throw new AeliaRefusedError('future_update_time', "Aelia's last-update time is in the future")

  const entries: AeliaRateEntry[] = []
  const refused: AeliaRefusal[] = []
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const raw of p.rates) {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : ''
    if (!CURRENCY.test(currency)) { refused.push({ currency: null, reason: 'payload_invalid', message: 'An Aelia entry has no valid currency code' }); continue }
    // THE BASE ROW (the live option holds one: the base currency has `rate` and decimals but NO `rate_markup` and NO `set_manually`). The base against itself is not a rate, so the row is not read at
    // all: it can neither refuse the read nor become a stored row, and its absent markup is never taken for a markup of 0 on a foreign currency.
    if (currency === base) continue
    if (seen.has(currency)) { duplicated.add(currency); continue }
    seen.add(currency)
    const parsed = parseRate(row.rate)
    if (!parsed.ok) { refused.push({ currency, reason: parsed.reason, message: parsed.message }); continue }
    entries.push({
      currency,
      rate: parsed.rate,
      markup: asText(row.markup) || null,
      setManually: row.set_manually === true,
      decimals: typeof row.decimals === 'number' && Number.isInteger(row.decimals) ? row.decimals : null,
    })
  }
  // A currency listed twice is ambiguous: neither row is trusted.
  for (const currency of duplicated) {
    const at = entries.findIndex((e) => e.currency === currency)
    if (at >= 0) entries.splice(at, 1)
    refused.push({ currency, reason: 'duplicate_currency', message: `Aelia lists ${currency} more than once` })
  }
  return { base, updatedAt, entries, refused }
}

export type AeliaIngestResult = {
  updatedAt: Date
  /** Currencies for which a new row was written. */
  written: string[]
  /** Currencies whose row for this Aelia update already exists with the same rate (an idempotent re-read). */
  unchanged: string[]
  /** Currencies skipped because their latest row is a manual override. */
  skippedManualOverrides: string[]
  refused: AeliaRefusal[]
  /** Aelia's markup per currency, as returned. For verification only: it is stored nowhere. */
  markups: Record<string, string | null>
  /**
   * The IMS-enabled foreign currencies for which this read gave NO usable rate (neither written, already stored, nor pinned by a manual override). Empty = the set is COMPLETE.
   * A currency Aelia lists that IMS does not know is not in here: it does not make IMS's set incomplete.
   */
  missing: string[]
}

/**
 * Validate and store. Throws AeliaRefusedError when the whole read is refused (a base currency that is not IMS's, a missing or future update time, an unusable answer).
 * Everything else is reported per currency in the result.
 */
export async function ingestAeliaRates(body: unknown, options: { now?: Date } = {}): Promise<AeliaIngestResult> {
  return withFxTableWriteLock((tx) => ingestAeliaRatesInTx(tx, body, options))
}

/**
 * The same, inside a transaction that ALREADY holds the exclusive FX table lock (withFxTableWriteLock): the cutover to Aelia (setFxRateSource) reads and ingests under the very lock that
 * commits the switch. The lock is an advisory transaction lock, so this must not take it again on another connection. Every read and write here goes through `tx`.
 */
export async function ingestAeliaRatesInTx(tx: FxTx, body: unknown, options: { now?: Date } = {}): Promise<AeliaIngestResult> {
  const now = options.now ?? new Date()
  const parsed = parseAeliaRatesPayload(body, now)
  const baseCurrency = await getBaseCurrencyCode()
  if (parsed.base !== baseCurrency) {
    throw new AeliaRefusedError('base_mismatch', `Aelia's base currency is ${parsed.base} but IMS's is ${baseCurrency}; nothing was stored`)
  }

  const known = await tx.currency.findMany({ select: { code: true, active: true } })
  const knownByCode = new Map(known.map((c) => [c.code, c.active]))
  const refused: AeliaRefusal[] = [...parsed.refused]
  const markups: Record<string, string | null> = {}
  const usable: AeliaRateEntry[] = []
  for (const entry of parsed.entries) {
    if (entry.currency === baseCurrency) continue // unreachable after parsing (the base row is dropped there); kept as the second guard that no base row is ever stored
    markups[entry.currency] = entry.markup
    if (!knownByCode.has(entry.currency)) {
      refused.push({ currency: entry.currency, reason: 'unknown_currency', message: `Aelia lists ${entry.currency}, which IMS does not know; nothing was stored for it` })
      continue
    }
    if (knownByCode.get(entry.currency) !== true) continue // known but switched off in IMS: not wanted
    usable.push(entry)
  }
  // An active IMS currency that Aelia does not give a usable rate for is refused, not defaulted. (A currency already refused above for a bad rate is not reported twice.)
  const accountedFor = new Set([...parsed.entries.map((e) => e.currency), ...refused.map((r) => r.currency)])
  for (const [code, active] of knownByCode) {
    if (active && code !== baseCurrency && !accountedFor.has(code)) {
      refused.push({ currency: code, reason: 'not_listed_by_aelia', message: `Aelia does not list ${code}; no rate was stored and none was substituted` })
    }
  }

  const written: string[] = []
  const unchanged: string[] = []
  const skippedManualOverrides: string[] = []

  {
    const latest = await tx.fxRate.findMany({
      where: { fromCurrency: baseCurrency, toCurrency: { in: usable.map((u) => u.currency) } },
      orderBy: [{ toCurrency: 'asc' }, { fetchedAt: 'desc' }],
      distinct: ['toCurrency'],
      select: { toCurrency: true, manualOverride: true },
    })
    const overridden = new Set(latest.filter((r) => r.manualOverride).map((r) => r.toCurrency))
    for (const entry of usable) {
      if (overridden.has(entry.currency)) { skippedManualOverrides.push(entry.currency); continue }
      const existing = await tx.fxRate.findFirst({
        where: { fromCurrency: baseCurrency, toCurrency: entry.currency, source: AELIA_SOURCE, fetchedAt: parsed.updatedAt },
        select: { rate: true },
      })
      if (existing) {
        if (new Prisma.Decimal(String(existing.rate)).equals(new Prisma.Decimal(entry.rate))) { unchanged.push(entry.currency); continue }
        // Same Aelia update time, different rate: two rows at one instant would make the lookup refuse as ambiguous. Refuse here instead and store nothing new.
        refused.push({ currency: entry.currency, reason: 'changed_without_update', message: `Aelia's rate for ${entry.currency} changed without a new update time` })
        continue
      }
      await tx.fxRate.create({
        data: { fromCurrency: baseCurrency, toCurrency: entry.currency, rate: entry.rate, source: AELIA_SOURCE, fetchedAt: parsed.updatedAt, manualOverride: false },
      })
      written.push(entry.currency)
    }
  }

  const have = new Set([...written, ...unchanged, ...skippedManualOverrides])
  const missing = [...knownByCode].filter(([code, active]) => active && code !== baseCurrency && !have.has(code)).map(([code]) => code).sort()
  return { updatedAt: parsed.updatedAt, written, unchanged, skippedManualOverrides, refused, markups, missing }
}

/**
 * Clear a manual override from Aelia's rate. The pin is the latest row and stays in force until a NEWER non-override row exists, so this row carries the time of the admin's action
 * (`clearedAt`), not Aelia's update time (an Aelia time older than the pin could never replace it). It is the one Aelia row not dated by Aelia, and it is a deliberate admin action.
 */
export async function clearOverrideFromAelia(body: unknown, currency: string, options: { now?: Date } = {}): Promise<{ rate: string; markup: string | null }> {
  const clearedAt = options.now ?? new Date()
  const parsed = parseAeliaRatesPayload(body, clearedAt)
  const baseCurrency = await getBaseCurrencyCode()
  if (parsed.base !== baseCurrency) throw new AeliaRefusedError('base_mismatch', `Aelia's base currency is ${parsed.base} but IMS's is ${baseCurrency}; nothing was stored`)
  const entry = parsed.entries.find((e) => e.currency === currency)
  if (!entry) {
    const why = parsed.refused.find((r) => r.currency === currency)
    throw new AeliaRefusedError(why?.reason ?? 'not_listed_by_aelia', why?.message ?? `Aelia does not list ${currency}; no rate was stored and none was substituted`)
  }
  await withFxTableWriteLock(async (tx) => {
    await tx.fxRate.create({
      data: { fromCurrency: baseCurrency, toCurrency: currency, rate: entry.rate, source: AELIA_SOURCE, fetchedAt: clearedAt, manualOverride: false },
    })
  })
  return { rate: entry.rate, markup: entry.markup }
}
