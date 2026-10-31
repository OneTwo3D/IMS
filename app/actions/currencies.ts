'use server'

import { AELIA_CUTOVER_READ_BOUND_MS, AELIA_CUTOVER_TX_TIMEOUT_MS, FxCutoverRefusedError, cutoverReadMismatches, readWithin } from '@/lib/currencies/aelia-cutover'
import { withFxTableWriteLock } from '@/lib/currencies/fx-table-lock'
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { getBaseCurrencyCode, getFallbackCurrencyMeta } from '@/lib/base-currency'
import { fetchAllFxRatesInternal } from '@/lib/currencies/fx-refresh'
import { appendFxSourceSwitch } from '@/lib/currencies/fx-source-regime'
import { FX_RATE_SOURCE_HISTORY_SETTING, FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCES, getFxRateSource, getFxRateSourceInTx, type FxRateSource } from '@/lib/currencies/fx-source'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CurrencyRow = {
  code: string
  name: string
  symbol: string
  symbolPosition: 'PREFIX' | 'POSTFIX'
  active: boolean
  isBaseCurrency: boolean
  latestRate: number | null // 1 GBP = X of this currency
  rateDate: string | null
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getCurrencies(activeOnly = true): Promise<CurrencyRow[]> {
  await requireInternalUser()
  const baseCurrency = await getBaseCurrencyCode()
  const rows = await db.currency.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { code: 'asc' },
    include: {
      fxRates: {
        where: { fromCurrency: baseCurrency },
        orderBy: { fetchedAt: 'desc' },
        take: 1,
      },
    },
  })
  const mapped: CurrencyRow[] = rows.map((c) => ({
    code: c.code,
    name: c.name,
    symbol: c.symbol,
    symbolPosition: c.symbolPosition,
    active: c.active,
    isBaseCurrency: c.code === baseCurrency,
    latestRate: c.fxRates[0] ? Number(c.fxRates[0].rate) : null,
    rateDate: c.fxRates[0]?.fetchedAt?.toISOString() ?? null,
  }))
  if (!mapped.some((c) => c.code === baseCurrency)) {
    const fallback = getFallbackCurrencyMeta(baseCurrency)
    mapped.unshift({
      code: baseCurrency,
      name: fallback.name,
      symbol: fallback.symbol,
      symbolPosition: fallback.symbolPosition,
      active: true,
      isBaseCurrency: true,
      latestRate: 1,
      rateDate: null,
    })
  }
  return mapped
}

/** Returns map: { BASE: 1, EUR: 1.17, USD: 1.27, ... } */
export async function getCurrencyRateMap(): Promise<Record<string, number>> {
  await requireInternalUser()
  const baseCurrency = await getBaseCurrencyCode()
  const currencies = await getCurrencies(true)
  const map: Record<string, number> = { [baseCurrency]: 1 }
  for (const c of currencies) {
    if (c.latestRate != null) map[c.code] = c.latestRate
  }
  return map
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * ACTIVATING A CURRENCY IS SERIALISED WITH THE FX SOURCE SWITCH. The cutover to Aelia checks every ACTIVE foreign currency for Aelia coverage under the exclusive FX table lock; a currency activated
 * outside that lock between the check and the commit would slip past it and then refuse every lookup. So create and activate take the same lock (withFxTableWriteLock), and while the source is Aelia an
 * activation needs coverage NOW: the real lookup, under the real regime, must answer with an Aelia row or a manual override (a pin), otherwise it refuses and nothing is written.
 */
async function aeliaActivationRefusal(tx: Prisma.TransactionClient, code: string): Promise<string | null> {
  if ((await getFxRateSourceInTx(tx)) !== 'aelia') return null
  const baseCurrency = await getBaseCurrencyCode()
  if (code === baseCurrency) return null
  const { resolveFxRatesToBase } = await import('@/lib/currencies/fx-lookup')
  const outcome = (await resolveFxRatesToBase(tx, { currencies: [code], asOf: new Date(), baseCurrency })).get(code)
  if (outcome?.ok) return null
  const why = outcome && !outcome.ok ? outcome.error.reason : 'no_rate'
  return `Currency ${code} was not activated: the FX source is Aelia and Aelia has not given a usable rate for ${code} (${why}). Add ${code} in the store's currency switcher so Aelia gives a rate, or pin a manual rate for it first, then activate it.`
}

export async function createCurrency(input: {
  code: string
  name: string
  symbol: string
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    const code = input.code.toUpperCase().trim()
    if (code.length !== 3) return { success: false, error: 'Currency code must be 3 characters' }

    const outcome = await withFxTableWriteLock(async (tx): Promise<{ error: string } | { created: boolean }> => {
      const exists = await tx.currency.findUnique({ where: { code } })
      if (exists && exists.active) return { error: 'Currency already exists' }
      const refusal = await aeliaActivationRefusal(tx, code)
      if (refusal) return { error: refusal }
      if (exists) {
        // Reactivate if inactive
        await tx.currency.update({ where: { code }, data: { active: true, name: input.name, symbol: input.symbol } })
        return { created: false }
      }
      await tx.currency.create({ data: { code, name: input.name, symbol: input.symbol, active: true } })
      return { created: true }
    })
    if ('error' in outcome) return { success: false, error: outcome.error }

    // Immediately fetch FX rate for a new currency (its own FX lock transaction: it runs after the one above has committed)
    if (outcome.created) await fetchSingleFxRate(code)

    await logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'created', description: `Added currency: ${code}` })
    revalidatePath('/settings')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'CURRENCY', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to add currency: ${input.code}` })
    return { success: false, error: String(e) }
  }
}

export async function toggleCurrency(code: string, active: boolean): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    const baseCurrency = await getBaseCurrencyCode()
    if (code === baseCurrency) return { success: false, error: 'Cannot deactivate base currency' }
    const refusal = await withFxTableWriteLock(async (tx) => {
      const found = active ? await aeliaActivationRefusal(tx, code) : null // only an activation needs coverage; switching a currency off never does
      if (found) return found
      await tx.currency.update({ where: { code }, data: { active } })
      return null
    })
    if (refusal) return { success: false, error: refusal }
    await logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'updated', description: `Toggled currency ${code} ${active ? 'on' : 'off'}` })
    revalidatePath('/settings')
    return { success: true }
  } catch (e) {
    await logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to toggle currency ${code}` })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// FX Rate Fetching
// ---------------------------------------------------------------------------

/** Fetch FX rate for a single currency from exchangerate.host (free, no key) */
async function fetchSingleFxRate(code: string): Promise<number | null> {
  // The FX source is Aelia: frankfurter is never asked (no other source stands in for Aelia). The new currency gets its rate from Aelia at the next scheduled read.
  if ((await getFxRateSource()) === 'aelia') return null
  try {
    const baseCurrency = await getBaseCurrencyCode()
    // Use frankfurter.dev (free, no API key required, ECB data)
    const safeCode = encodeURIComponent(code)
    let rate: number | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCurrency)}&symbols=${safeCode}`, {
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = await res.json()
        const maybeRate = data?.rates?.[code]
        if (typeof maybeRate === 'number' && maybeRate > 0) {
          rate = maybeRate
          break
        }
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
    if (rate === null) return null

    // Re-read the source inside the lock: a switch to Aelia that committed while frankfurter was being asked wins, and the ECB row is not stored.
    const stored = await withFxTableWriteLock(async (tx) => {
      if ((await getFxRateSourceInTx(tx)) === 'aelia') return false
      await tx.fxRate.create({ data: { fromCurrency: baseCurrency, toCurrency: code, rate } })
      return true
    })
    if (!stored) return null
    return rate
  } catch {
    return null
  }
}

/** Fetch FX rates for all active currencies (called on demand from UI) */
export async function fetchAllFxRates(): Promise<{ success: boolean; updated: string[]; failed: string[]; error?: string }> {
  await requirePermission('settings.company')
  return fetchAllFxRatesInternal()
}

// ---------------------------------------------------------------------------
// Manual overrides + push log (Phase 4 admin UI)
// ---------------------------------------------------------------------------

export type FxRateRow = {
  toCurrency: string
  rate: number
  fetchedAt: string
  source: string
  manualOverride: boolean
}

/** Latest rate per active non-base currency, with provenance flags. */
export async function getLatestFxRates(): Promise<FxRateRow[]> {
  await requireInternalUser()
  const baseCurrency = await getBaseCurrencyCode()
  const rows = await db.$queryRaw<Array<{ toCurrency: string; rate: string; fetchedAt: Date; source: string; manualOverride: boolean }>>`
    SELECT DISTINCT ON ("toCurrency")
      "toCurrency", "rate", "fetchedAt", "source", "manualOverride"
    FROM "fx_rates"
    WHERE "fromCurrency" = ${baseCurrency}
    ORDER BY "toCurrency", "fetchedAt" DESC
  `
  return rows.map((r) => ({
    toCurrency: r.toCurrency,
    rate: Number(r.rate),
    fetchedAt: r.fetchedAt.toISOString(),
    source: r.source,
    manualOverride: r.manualOverride,
  }))
}

/**
 * Pin a manual rate for a currency. Inserts a new FxRate row with
 * `manualOverride=true`, which becomes the latest for that currency and is
 * therefore picked up by every read site (PO/SO creation, Xero stamping,
 * WC push). Stays in effect until cleared.
 */
export async function setManualFxRate(toCurrency: string, rate: number): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  const code = toCurrency.trim().toUpperCase()
  if (!code) return { success: false, error: 'Currency code required' }
  if (!Number.isFinite(rate) || rate <= 0) return { success: false, error: 'Rate must be a positive number' }
  const baseCurrency = await getBaseCurrencyCode()
  if (code === baseCurrency) return { success: false, error: 'Cannot override the base currency' }

  await withFxTableWriteLock((tx) => tx.fxRate.create({
    data: {
      fromCurrency: baseCurrency,
      toCurrency: code,
      rate,
      source: 'manual',
      manualOverride: true,
    },
  }))
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'fx_rate_overridden',
    description: `Manual FX rate set: 1 ${baseCurrency} = ${rate} ${code}`,
  })
  revalidatePath('/settings/accounting')
  return { success: true }
}

/**
 * Clear an override by re-fetching just this currency from frankfurter and
 * inserting it as a non-override row. The new row becomes "latest", so the
 * next fetch loop will treat the currency as normal again.
 */
export async function clearManualFxRate(toCurrency: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  const code = toCurrency.trim().toUpperCase()
  if (!code) return { success: false, error: 'Currency code required' }
  const baseCurrency = await getBaseCurrencyCode()

  // The FX source is Aelia: the override is replaced by Aelia's own rate (before markup), never by a frankfurter rate.
  if ((await getFxRateSource()) === 'aelia') {
    const [{ readAeliaRatesFromWc }, { clearOverrideFromAelia, AeliaRefusedError }] = await Promise.all([
      import('@/lib/connectors/woocommerce/aelia-rates'),
      import('@/lib/currencies/aelia-ingest'),
    ])
    const read = await readAeliaRatesFromWc()
    if (!read.ok) return { success: false, error: read.message }
    try {
      const cleared = await clearOverrideFromAelia(read.body, code)
      await logActivity({
        entityType: 'SETTING',
        tag: 'settings',
        action: 'fx_rate_override_cleared',
        description: `Cleared manual override for ${code}; new rate from Aelia (before markup): 1 ${baseCurrency} = ${cleared.rate} ${code}`,
      })
    } catch (e) {
      if (e instanceof AeliaRefusedError) return { success: false, error: `${e.reason}: ${e.message}` }
      throw e
    }
    revalidatePath('/settings/accounting')
    return { success: true }
  }

  let res: Response | null = null
  try {
    res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCurrency)}&symbols=${encodeURIComponent(code)}`,
      { signal: AbortSignal.timeout(15000) },
    )
  } catch (e) {
    return { success: false, error: `Failed to reach frankfurter.dev: ${String(e).slice(0, 200)}` }
  }
  if (!res.ok) return { success: false, error: `frankfurter.dev returned ${res.status}` }
  const data = (await res.json().catch(() => ({}))) as { rates?: Record<string, number> }
  const fresh = data.rates?.[code]
  if (typeof fresh !== 'number' || fresh <= 0) {
    return { success: false, error: `frankfurter.dev did not return a rate for ${code}` }
  }
  const stored = await withFxTableWriteLock(async (tx) => {
    if ((await getFxRateSourceInTx(tx)) === 'aelia') return false
    await tx.fxRate.create({ data: { fromCurrency: baseCurrency, toCurrency: code, rate: fresh, source: 'frankfurter', manualOverride: false } })
    return true
  })
  if (!stored) return { success: false, error: 'The FX source changed to Aelia while this ran; nothing was stored.' }
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'fx_rate_override_cleared',
    description: `Cleared manual override for ${code}; new rate from frankfurter: 1 ${baseCurrency} = ${fresh} ${code}`,
  })
  revalidatePath('/settings/accounting')
  return { success: true }
}

export type FxPushLogRow = {
  id: string
  connector: string
  pushedAt: string
  ratesCount: number
  status: string
  errorMessage: string | null
}

/**
 * Threshold beyond which a stored rate or the last successful push is
 * considered stale enough to warn about. The cron is scheduled at most every
 * 24 h (default), so 36 h means we've missed at least one cycle.
 */
const FX_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000

export type FxHealth = {
  lastFetchedAt: string | null
  lastFetchAgeMs: number | null
  fetchStale: boolean
  lastFetchAttemptAt: string | null
  lastFetchAttemptStatus: string | null
  lastFetchRetryCount: number
  lastFetchError: string | null
  failedCurrencies: string[]
  skippedManualOverrideCurrencies: string[]
  wcPushEnabled: boolean
  lastWcPushAt: string | null
  lastWcPushAgeMs: number | null
  wcPushStale: boolean
  manualOverrideCount: number
  /** The FX source switch ('ecb' default, or 'aelia'). With 'aelia' `lastFetchedAt` is Aelia's own update time and the WooCommerce push is disabled. */
  fxSource: FxRateSource
}

/**
 * Single read for the FX integration health card on the Currencies settings
 * page. Combines the last frankfurter fetch timestamp, the last successful WC
 * push, and a count of currencies currently held under manual override.
 */
export async function getFxHealth(): Promise<FxHealth> {
  await requireInternalUser()
  const baseCurrency = await getBaseCurrencyCode()
  const fxSource = await getFxRateSource()

  const [
    lastFetchedSetting,
    lastAttemptAtSetting,
    lastAttemptStatusSetting,
    lastAttemptRetrySetting,
    lastAttemptErrorSetting,
    failedCurrenciesSetting,
    skippedManualOverridesSetting,
    wcEnabledSetting,
    lastPushSetting,
    overrideRows,
  ] = await Promise.all([
    db.setting.findUnique({ where: { key: fxSource === 'aelia' ? 'fx_aelia_last_update_at' : 'fx_last_fetched' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_attempt_at' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_attempt_status' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_retry_count' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_error' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_failed_currencies' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'fx_last_fetch_skipped_manual_overrides' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'wc_fx_push_enabled' }, select: { value: true } }),
    db.setting.findUnique({ where: { key: 'last_wc_fx_push_at' }, select: { value: true } }),
    db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM (
        SELECT DISTINCT ON ("toCurrency") "toCurrency", "manualOverride"
        FROM "fx_rates"
        WHERE "fromCurrency" = ${baseCurrency}
        ORDER BY "toCurrency", "fetchedAt" DESC
      ) latest
      WHERE latest."manualOverride" = true
    `,
  ])

  const now = Date.now()
  const lastFetchedAt = lastFetchedSetting?.value ?? null
  const lastFetchAgeMs = lastFetchedAt ? now - new Date(lastFetchedAt).getTime() : null
  // Under the Aelia source the push is disabled whatever its own setting says.
  const wcPushEnabled = fxSource !== 'aelia' && wcEnabledSetting?.value === 'true'
  const lastWcPushAt = lastPushSetting?.value || null
  const lastWcPushAgeMs = lastWcPushAt ? now - new Date(lastWcPushAt).getTime() : null

  return {
    lastFetchedAt,
    lastFetchAgeMs,
    fetchStale: lastFetchAgeMs == null || lastFetchAgeMs > FX_STALE_THRESHOLD_MS,
    lastFetchAttemptAt: lastAttemptAtSetting?.value ?? null,
    lastFetchAttemptStatus: lastAttemptStatusSetting?.value ?? null,
    lastFetchRetryCount: Number(lastAttemptRetrySetting?.value ?? 0) || 0,
    lastFetchError: lastAttemptErrorSetting?.value || null,
    failedCurrencies: splitSettingList(failedCurrenciesSetting?.value),
    skippedManualOverrideCurrencies: splitSettingList(skippedManualOverridesSetting?.value),
    wcPushEnabled,
    lastWcPushAt,
    lastWcPushAgeMs,
    // Only flag push-stale when the operator has actually enabled push.
    wcPushStale: wcPushEnabled && (lastWcPushAgeMs == null || lastWcPushAgeMs > FX_STALE_THRESHOLD_MS),
    manualOverrideCount: Number(overrideRows[0]?.count ?? 0),
    fxSource,
  }
}

function splitSettingList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

export async function getFxPushLog(limit = 20): Promise<FxPushLogRow[]> {
  await requireInternalUser()
  const rows = await db.fxRatePushLog.findMany({
    orderBy: { pushedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  })
  return rows.map((r) => ({
    id: r.id,
    connector: r.connector,
    pushedAt: r.pushedAt.toISOString(),
    ratesCount: r.ratesCount,
    status: r.status,
    errorMessage: r.errorMessage,
  }))
}

// ---------------------------------------------------------------------------
// The FX source switch (default OFF = 'ecb'). See lib/currencies/fx-source.ts.
// ---------------------------------------------------------------------------

export async function getFxRateSourceSetting(): Promise<FxRateSource> {
  await requireInternalUser()
  return getFxRateSource()
}

/**
 * Choose the source of the exchange rates. 'aelia' needs the WooCommerce store configured (its address and the shared secret) AND the onetwoInventory Helper plugin 1.3.0 or later deployed on it
 * (deployed by the owner; nothing here installs it). The switch READS Aelia first and commits only on a complete rate set, otherwise it is refused with the reason and the source stays ECB.
 */
export async function setFxRateSource(source: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  if (!(FX_RATE_SOURCES as readonly string[]).includes(source)) return { success: false, error: 'Unknown FX source' }
  if (source === 'aelia') {
    const { getSettingValues } = await import('@/lib/settings-store')
    const config = await getSettingValues(['wc_url', 'wc_webhook_secret'])
    if (!config.get('wc_url') || !config.get('wc_webhook_secret')) {
      return { success: false, error: 'Set the WooCommerce store address and the shared secret first: Aelia is read through the onetwoInventory Helper plugin (1.3.0 or later) on the store.' }
    }
  }
  // THE CUTOVER BARRIER. The source and the instant of the change are written together under the EXCLUSIVE FX table lock: a rate push (which holds the lock shared from its source check through its POST) and a
  // CSV import finish first, and every ECB refresh write re-reads the source inside this same lock. So once this commits no ECB row and no rate POST can follow it.
  //
  // SWITCHING TO AELIA READS FIRST. Inside that same lock (so there is no window between the read and the switch) the helper plugin is read ONCE and the answer is ingested into fx_rates; the switch commits
  // only if the set is COMPLETE: every IMS-enabled foreign currency has a valid pre-markup rate from this read (stored now, already stored, or pinned by a manual override). Otherwise the transaction is
  // rolled back (no row, no setting: the source stays as it was) and the refusal names what is missing. Without this a first cutover, with no Aelia rows yet, would refuse every foreign-currency lookup
  // until a scheduled read succeeded. Switching back to ECB needs no read.
  //
  // HOW LONG THE LOCK IS HELD. The read is bounded by AELIA_CUTOVER_READ_BOUND_MS (20 s, a hard race around the 15 s transport timeout, so a stalled body read cannot hold it either); the ingest is local
  // database work on a handful of rows; the transaction itself is capped at AELIA_CUTOVER_TX_TIMEOUT_MS (45 s), after which it is rolled back and the lock released. So the exclusive lock is held at most about
  // 45 s, normally under 1 s for an answering store, and rate pushes, CSV imports and refreshes wait that long at worst (their own waits are 30 s / 60 s).
  let switchedAt = new Date()
  let changed: boolean
  let aeliaResult: Awaited<ReturnType<typeof import('@/lib/currencies/aelia-ingest').ingestAeliaRatesInTx>> | null = null
  try {
    changed = await withFxTableWriteLock(async (tx) => {
      if ((await getFxRateSourceInTx(tx)) === source) return false
      if (source === 'aelia') {
        const [{ readAeliaRatesFromWc }, { ingestAeliaRatesInTx, AeliaRefusedError }] = await Promise.all([
          import('@/lib/connectors/woocommerce/aelia-rates'),
          import('@/lib/currencies/aelia-ingest'),
        ])
        const read = await readWithin(AELIA_CUTOVER_READ_BOUND_MS, () => readAeliaRatesFromWc())
        switchedAt = new Date() // the cutover instant is taken AFTER the read (which may have taken seconds), so an Aelia update that landed meanwhile is not 'in the future'
        if (!read.ok) throw new FxCutoverRefusedError(`Aelia's rates could not be read, so the source was not changed (it is still ECB): ${read.message}`)
        let result: Awaited<ReturnType<typeof ingestAeliaRatesInTx>>
        try {
          result = await ingestAeliaRatesInTx(tx, read.body, { now: switchedAt })
        } catch (e) {
          if (e instanceof AeliaRefusedError) throw new FxCutoverRefusedError(`Aelia's answer was refused (${e.reason}), so the source was not changed (it is still ECB): ${e.message}`)
          throw e
        }
        if (result.missing.length) {
          const why = result.missing.map((code) => {
            const r = result.refused.find((x) => x.currency === code)
            return r ? `${code} (${r.reason})` : code
          })
          throw new FxCutoverRefusedError(`Aelia did not give a usable rate for ${result.missing.join(', ')}, so the source was not changed (it is still ECB and nothing was stored): ${why.join(', ')}. Add the currency in the store's currency switcher, or switch the currency off in IMS, then try again.`)
        }
        // A store clock AHEAD of IMS's: the rows would be dated after the cutover instant, and every lookup at that instant excludes them. Refused outright.
        if (result.updatedAt.getTime() > switchedAt.getTime()) {
          const ahead = Math.ceil((result.updatedAt.getTime() - switchedAt.getTime()) / 1000)
          throw new FxCutoverRefusedError(`Aelia's last-update time (${result.updatedAt.toISOString()}) is later than now, so the store clock is ahead by ${ahead} s; the source was not changed (it is still ECB and nothing was stored). Correct the store's clock, or wait until Aelia's next update is in the past, then try again.`)
        }
        aeliaResult = result
      }
      // THE BOUNDARY IS TAKEN HERE, inside the lock-holding transaction and after every check, immediately before the writes that commit it: a switch that waited behind an import must not record an
      // instant from before its wait, or a document recorded during the wait (under the old regime) would later read as the new one. For the Aelia path this is later than the read instant used to date the ingested rows, which is harmless (rows dated earlier are eligible).
      switchedAt = new Date()
      // THE SWITCH HISTORY: one interval boundary per switch, appended in this same transaction (read under the exclusive lock, so two switches cannot interleave). A lookup selects the regime in effect at its
      // asOf from this list, so a switch back to ECB does not turn an Aelia-period document into an ECB lookup.
      const before = await tx.setting.findMany({ where: { key: { in: [FX_RATE_SOURCE_SETTING, FX_RATE_SOURCE_SINCE_SETTING, FX_RATE_SOURCE_HISTORY_SETTING] } }, select: { key: true, value: true } })
      const prior = (k: string) => before.find((x) => x.key === k)?.value
      const history = appendFxSourceSwitch(prior(FX_RATE_SOURCE_HISTORY_SETTING), prior(FX_RATE_SOURCE_SETTING), prior(FX_RATE_SOURCE_SINCE_SETTING), source as FxRateSource, switchedAt)
      await tx.setting.upsert({ where: { key: FX_RATE_SOURCE_HISTORY_SETTING }, create: { key: FX_RATE_SOURCE_HISTORY_SETTING, value: history }, update: { value: history } })
      await tx.setting.upsert({ where: { key: FX_RATE_SOURCE_SETTING }, create: { key: FX_RATE_SOURCE_SETTING, value: source }, update: { value: source } })
      await tx.setting.upsert({ where: { key: FX_RATE_SOURCE_SINCE_SETTING }, create: { key: FX_RATE_SOURCE_SINCE_SETTING, value: switchedAt.toISOString() }, update: { value: switchedAt.toISOString() } })
      if (source === 'aelia' && aeliaResult) {
        // THE AUTHORITY: with the new source and instant written in this transaction, run the ACTUAL lookup (the one every document and report uses, under the new regime) for every active foreign
        // currency AT the cutover instant. Each must resolve to an Aelia row or a manual override, else the whole transaction rolls back. This is the real rule, not a model of it.
        const [{ resolveFxRatesToBase }, { getBaseCurrencyCode }] = await Promise.all([import('@/lib/currencies/fx-lookup'), import('@/lib/base-currency')])
        const baseCode = await getBaseCurrencyCode()
        const activeForeign = (await tx.currency.findMany({ where: { active: true }, select: { code: true } })).map((c) => c.code).filter((code) => code !== baseCode)
        const outcomes = await resolveFxRatesToBase(tx, { currencies: activeForeign, asOf: switchedAt, baseCurrency: baseCode })
        const failures = [...outcomes].flatMap(([code, o]) => (o.ok ? [] : [`${code} (${o.error.reason})`]))
        if (failures.length) {
          throw new FxCutoverRefusedError(`After the switch these currencies would not resolve to an Aelia rate or a manual override: ${failures.join(', ')}; the source was not changed (it is still ECB and nothing was stored).`)
        }
        // And what each unpinned currency resolves to must be THIS read's rate and time, not some other stored row.
        const differing = cutoverReadMismatches(outcomes, aeliaResult)
        if (differing.length) {
          throw new FxCutoverRefusedError(`After the switch these currencies would not resolve as this Aelia read and the pins say (an unpinned one to this read's rate and time, a pinned one to its manual override): ${differing.join(', ')}; the source was not changed (it is still ECB and nothing was stored).`)
        }
        await tx.setting.upsert({ where: { key: 'fx_aelia_last_update_at' }, create: { key: 'fx_aelia_last_update_at', value: aeliaResult.updatedAt.toISOString() }, update: { value: aeliaResult.updatedAt.toISOString() } })
        await tx.setting.upsert({ where: { key: 'fx_aelia_last_read_at' }, create: { key: 'fx_aelia_last_read_at', value: switchedAt.toISOString() }, update: { value: switchedAt.toISOString() } })
      }
      return true
    }, { timeout: AELIA_CUTOVER_TX_TIMEOUT_MS })
  } catch (e) {
    if (e instanceof FxCutoverRefusedError) return { success: false, error: e.message }
    throw e
  }
  if (!changed) return { success: true }
  await logActivity({
    entityType: 'SETTING',
    tag: 'settings',
    action: 'fx_rate_source_changed',
    description: source === 'aelia'
      ? `FX source set to Aelia from ${switchedAt.toISOString()}: rates are read from the store (before markup), lookups from that instant use only Aelia rates and manual overrides, and the IMS to WooCommerce rate push is disabled`
      : `FX source set to ECB (frankfurter) from ${switchedAt.toISOString()}: rates are fetched daily and may be pushed to WooCommerce`,
  })
  revalidatePath('/settings/accounting')
  revalidatePath('/sync')
  return { success: true }
}
