'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireAuth, requirePermission } from '@/lib/auth/server'
import { DEFAULT_BASE_CURRENCY, getBaseCurrencyCode, getFallbackCurrencyMeta } from '@/lib/base-currency'

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
export async function fetchAllFxRatesInternal(): Promise<{ success: boolean; updated: string[]; failed: string[]; error?: string }> {
  try {
    const baseCurrency = await getBaseCurrencyCode()
    const currencies = await db.currency.findMany({
      where: { active: true, code: { not: baseCurrency } },
      select: { code: true },
    })

    if (!currencies.length) return { success: true, updated: [], failed: [] }

    const codes = currencies.map((c) => c.code)
    const symbols = encodeURIComponent(codes.join(','))

    let res: Response | null = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(baseCurrency)}&symbols=${symbols}`, {
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)
      if (res?.ok) break
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500))
    }

    if (!res?.ok) {
      await logActivity({
        entityType: 'SYNC',
        tag: 'sync',
        action: 'fx_rates_fetched',
        level: 'WARNING',
        description: `FX rate refresh failed; existing rates remain in use for ${codes.length} currencies`,
        metadata: { failed: codes, status: res?.status ?? null },
      })
      return { success: false, updated: [], failed: codes, error: `API returned ${res?.status ?? 'no response'}` }
    }

    const data = await res.json()
    const rates = data?.rates ?? {}
    const updated: string[] = []
    const failed: string[] = []

    for (const code of codes) {
      const rate = rates[code]
      if (typeof rate === 'number' && rate > 0) {
        await db.fxRate.create({
          data: { fromCurrency: baseCurrency, toCurrency: code, rate },
        })
        updated.push(code)
      } else {
        failed.push(code)
      }
    }

    // Record last fetched timestamp
    await db.setting.upsert({
      where: { key: 'fx_last_fetched' },
      create: { key: 'fx_last_fetched', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', description: `Fetched FX rates for ${updated.length} currencies` })
    revalidatePath('/settings', 'layout')
    revalidatePath('/purchase-orders')
    return { success: true, updated, failed }
  } catch (e) {
    await logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', level: 'ERROR', description: `Failed to fetch FX rates: ${String(e)}` })
    return { success: false, updated: [], failed: [], error: String(e) }
  }
}

/** Fetch FX rates for all active currencies (called on demand from UI) */
export async function fetchAllFxRates(): Promise<{ success: boolean; updated: string[]; failed: string[]; error?: string }> {
  await requirePermission('settings.company')
  return fetchAllFxRatesInternal()
}
