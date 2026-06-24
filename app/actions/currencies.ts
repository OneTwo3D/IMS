'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { getBaseCurrencyCode, getFallbackCurrencyMeta } from '@/lib/base-currency'
import { notify } from '@/lib/notifications'

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
  await requireAuth()
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
  await requireAuth()
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

export async function createCurrency(input: {
  code: string
  name: string
  symbol: string
}): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  try {
    const code = input.code.toUpperCase().trim()
    if (code.length !== 3) return { success: false, error: 'Currency code must be 3 characters' }

    const exists = await db.currency.findUnique({ where: { code } })
    if (exists) {
      // Reactivate if inactive
      if (!exists.active) {
        await db.currency.update({ where: { code }, data: { active: true, name: input.name, symbol: input.symbol } })
        await logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'created', description: `Added currency: ${code}` })
        revalidatePath('/settings')
        return { success: true }
      }
      return { success: false, error: 'Currency already exists' }
    }

    await db.currency.create({
      data: { code, name: input.name, symbol: input.symbol, active: true },
    })

    // Immediately fetch FX rate for this currency
    await fetchSingleFxRate(code)

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
    await db.currency.update({ where: { code }, data: { active } })
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

    await db.fxRate.create({
      data: {
        fromCurrency: baseCurrency,
        toCurrency: code,
        rate,
      },
    })
    return rate
  } catch {
    return null
  }
}

/** Core FX rate fetching logic (no auth — used by cron and the server action) */
export async function fetchAllFxRatesInternal(): Promise<{
  success: boolean
  updated: string[]
  failed: string[]
  error?: string
  retryCount?: number
  skippedManualOverrides?: string[]
  pendingWcOrderRetry?: { attempted: number; imported: number; stillPending: number; failed: number } | null
}> {
  try {
    const baseCurrency = await getBaseCurrencyCode()
    const currencies = await db.currency.findMany({
      where: { active: true, code: { not: baseCurrency } },
      select: { code: true },
    })

    if (!currencies.length) return { success: true, updated: [], failed: [] }

    // Skip currencies whose latest rate is a manual override — the admin has
    // pinned that rate and doesn't want frankfurter to overwrite it. The
    // override stays in effect until they explicitly insert a fresh non-
    // override row via clearManualFxRate().
    const allCodes = currencies.map((c) => c.code)
    const overrideCodes = await getActiveOverrideCurrencies(allCodes)
    const codes = allCodes.filter((c) => !overrideCodes.has(c))

    if (!codes.length) {
      await recordFxFetchAttempt({
        status: 'skipped_manual_override',
        retryCount: 0,
        skippedManualOverrides: allCodes,
      })
      await logActivity({
        entityType: 'SYNC',
        tag: 'sync',
        action: 'fx_rates_fetched',
        description: `FX fetch skipped — all ${allCodes.length} currencies have manual overrides`,
      })
      return { success: true, updated: [], failed: [], retryCount: 0, skippedManualOverrides: allCodes }
    }
    const symbols = encodeURIComponent(codes.join(','))

    let res: Response | null = null
    let retryCount = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      retryCount = attempt
      res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCurrency)}&symbols=${symbols}`, {
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)
      if (res?.ok) break
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500))
    }

    if (!res?.ok) {
      const error = `API returned ${res?.status ?? 'no response'}`
      await recordFxFetchAttempt({
        status: 'failed',
        retryCount,
        failed: codes,
        error,
      })
      await logActivity({
        entityType: 'SYNC',
        tag: 'sync',
        action: 'fx_rates_fetched',
        level: 'ERROR',
        description: `FX rate refresh failed; existing rates remain in use for ${codes.length} currencies`,
        metadata: { failed: codes, status: res?.status ?? null, retryCount },
      })
      await notifyActiveAdmins({
        type: 'error',
        title: 'FX rate refresh failed',
        message: `Frankfurter FX refresh failed after ${retryCount} attempts. Existing rates remain in use for ${codes.join(', ')}.`,
        actionUrl: '/settings/accounting?tab=fx-rates',
      })
      return { success: false, updated: [], failed: codes, error, retryCount }
    }

    const data = await res.json()
    const rates = data?.rates ?? {}
    const updated: string[] = []
    const failed: string[] = []

    for (const code of codes) {
      const rate = rates[code]
      if (typeof rate === 'number' && rate > 0) {
        await db.fxRate.create({
          data: { fromCurrency: baseCurrency, toCurrency: code, rate, source: 'frankfurter' },
        })
        updated.push(code)
      } else {
        failed.push(code)
      }
    }

    await recordFxFetchAttempt({
      status: failed.length ? 'partial' : 'success',
      retryCount,
      failed,
      skippedManualOverrides: Array.from(overrideCodes),
    })

    // Record last fetched timestamp
    await db.setting.upsert({
      where: { key: 'fx_last_fetched' },
      create: { key: 'fx_last_fetched', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', description: `Fetched FX rates for ${updated.length} currencies` })

    let pendingWcOrderRetry: { attempted: number; imported: number; stillPending: number; failed: number } | null = null
    if (updated.length > 0) {
      try {
        const { retryPendingWcOrdersWaitingForFx } = await import('@/lib/connectors/woocommerce/sync/order-import')
        pendingWcOrderRetry = await retryPendingWcOrdersWaitingForFx()
      } catch (e) {
        await logActivity({
          entityType: 'SYNC',
          tag: 'sync',
          action: 'wc_order_fx_pending_retry',
          level: 'WARNING',
          description: `Failed to retry WooCommerce orders waiting for FX rates: ${String(e).slice(0, 240)}`,
        })
      }
    }

    // b8i6.2: fan the new rates out to every configured shopping connector via
    // the facade (each owns its own push + telemetry; Shopify is skipped until it
    // gains an FX push). Failure here must never roll back the inbound fetch.
    if (updated.length) {
      try {
        const { pushFxRatesToConnectors } = await import('@/lib/shopping')
        await pushFxRatesToConnectors()
      } catch (e) {
        await logActivity({
          entityType: 'SYNC',
          tag: 'sync',
          action: 'fx_rates_pushed',
          level: 'ERROR',
          description: `FX rate push threw: ${String(e).slice(0, 240)}`,
        })
      }
    }

    revalidatePath('/settings', 'layout')
    revalidatePath('/purchase-orders')
    return { success: true, updated, failed, retryCount, skippedManualOverrides: Array.from(overrideCodes), pendingWcOrderRetry }
  } catch (e) {
    const error = String(e)
    await recordFxFetchAttempt({
      status: 'failed',
      retryCount: 0,
      error,
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', level: 'ERROR', description: `Failed to fetch FX rates: ${error}` })
    await notifyActiveAdmins({
      type: 'error',
      title: 'FX rate refresh failed',
      message: `FX refresh failed before contacting Frankfurter: ${error.slice(0, 200)}`,
      actionUrl: '/settings/accounting?tab=fx-rates',
    })
    return { success: false, updated: [], failed: [], error, retryCount: 0 }
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

/**
 * Of the given currency codes, return the set whose latest FxRate row is a
 * manual override. The fetch loop calls this so it can skip those currencies
 * without overwriting the admin-pinned rate.
 */
async function getActiveOverrideCurrencies(codes: string[]): Promise<Set<string>> {
  if (!codes.length) return new Set()
  // For each currency, take the latest row and check `manualOverride`. Done
  // in SQL to avoid loading every historical row.
  const rows = await db.$queryRaw<Array<{ toCurrency: string; manualOverride: boolean }>>`
    SELECT DISTINCT ON ("toCurrency") "toCurrency", "manualOverride"
    FROM "fx_rates"
    WHERE "toCurrency" = ANY(${codes}::text[])
    ORDER BY "toCurrency", "fetchedAt" DESC
  `
  return new Set(rows.filter((r) => r.manualOverride).map((r) => r.toCurrency))
}

type FxFetchAttemptStatus = 'success' | 'partial' | 'failed' | 'skipped_manual_override'

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

async function recordFxFetchAttempt(input: {
  status: FxFetchAttemptStatus
  retryCount: number
  failed?: string[]
  skippedManualOverrides?: string[]
  error?: string
}): Promise<void> {
  const now = new Date().toISOString()
  await Promise.all([
    setSetting('fx_last_fetch_attempt_at', now),
    setSetting('fx_last_fetch_attempt_status', input.status),
    setSetting('fx_last_fetch_retry_count', String(input.retryCount)),
    setSetting('fx_last_fetch_failed_currencies', (input.failed ?? []).join(',')),
    setSetting('fx_last_fetch_skipped_manual_overrides', (input.skippedManualOverrides ?? []).join(',')),
    setSetting('fx_last_fetch_error', input.error ?? ''),
  ])
}

async function notifyActiveAdmins(params: Omit<Parameters<typeof notify>[0], 'userId'>): Promise<void> {
  const admins = await db.user.findMany({
    where: { role: 'ADMIN', active: true },
    select: { id: true },
  })
  await Promise.all(admins.map((admin) => notify({ ...params, userId: admin.id })))
}

export type FxRateRow = {
  toCurrency: string
  rate: number
  fetchedAt: string
  source: string
  manualOverride: boolean
}

/** Latest rate per active non-base currency, with provenance flags. */
export async function getLatestFxRates(): Promise<FxRateRow[]> {
  await requireAuth()
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

  await db.fxRate.create({
    data: {
      fromCurrency: baseCurrency,
      toCurrency: code,
      rate,
      source: 'manual',
      manualOverride: true,
    },
  })
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
  await db.fxRate.create({
    data: { fromCurrency: baseCurrency, toCurrency: code, rate: fresh, source: 'frankfurter', manualOverride: false },
  })
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
}

/**
 * Single read for the FX integration health card on the Currencies settings
 * page. Combines the last frankfurter fetch timestamp, the last successful WC
 * push, and a count of currencies currently held under manual override.
 */
export async function getFxHealth(): Promise<FxHealth> {
  await requireAuth()
  const baseCurrency = await getBaseCurrencyCode()

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
    db.setting.findUnique({ where: { key: 'fx_last_fetched' }, select: { value: true } }),
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
  const wcPushEnabled = wcEnabledSetting?.value === 'true'
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
  }
}

function splitSettingList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

export async function getFxPushLog(limit = 20): Promise<FxPushLogRow[]> {
  await requireAuth()
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
