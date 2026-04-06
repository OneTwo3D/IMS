'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CurrencyRow = {
  code: string
  name: string
  symbol: string
  active: boolean
  latestRate: number | null // 1 GBP = X of this currency
  rateDate: string | null
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getCurrencies(activeOnly = true): Promise<CurrencyRow[]> {
  const rows = await db.currency.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { code: 'asc' },
    include: {
      fxRates: {
        orderBy: { fetchedAt: 'desc' },
        take: 1,
      },
    },
  })
  return rows.map((c) => ({
    code: c.code,
    name: c.name,
    symbol: c.symbol,
    active: c.active,
    latestRate: c.fxRates[0] ? Number(c.fxRates[0].rate) : null,
    rateDate: c.fxRates[0]?.fetchedAt?.toISOString() ?? null,
  }))
}

/** Returns map: { EUR: 1.17, USD: 1.27, ... } */
export async function getCurrencyRateMap(): Promise<Record<string, number>> {
  const currencies = await getCurrencies(true)
  const map: Record<string, number> = { GBP: 1 }
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
  try {
    const code = input.code.toUpperCase().trim()
    if (code.length !== 3) return { success: false, error: 'Currency code must be 3 characters' }

    const exists = await db.currency.findUnique({ where: { code } })
    if (exists) {
      // Reactivate if inactive
      if (!exists.active) {
        await db.currency.update({ where: { code }, data: { active: true, name: input.name, symbol: input.symbol } })
        logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'created', description: `Added currency: ${code}` })
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

    logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'created', description: `Added currency: ${code}` })
    revalidatePath('/settings')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'CURRENCY', tag: 'settings', action: 'created', level: 'ERROR', description: `Failed to add currency: ${input.code}` })
    return { success: false, error: String(e) }
  }
}

export async function toggleCurrency(code: string, active: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    if (code === 'GBP') return { success: false, error: 'Cannot deactivate base currency' }
    await db.currency.update({ where: { code }, data: { active } })
    logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'updated', description: `Toggled currency ${code} ${active ? 'on' : 'off'}` })
    revalidatePath('/settings')
    return { success: true }
  } catch (e) {
    logActivity({ entityType: 'CURRENCY', entityId: code, tag: 'settings', action: 'updated', level: 'ERROR', description: `Failed to toggle currency ${code}` })
    return { success: false, error: String(e) }
  }
}

// ---------------------------------------------------------------------------
// FX Rate Fetching
// ---------------------------------------------------------------------------

/** Fetch FX rate for a single currency from exchangerate.host (free, no key) */
async function fetchSingleFxRate(code: string): Promise<number | null> {
  try {
    // Use frankfurter.dev (free, no API key required, ECB data)
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=GBP&symbols=${code}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const rate = data?.rates?.[code]
    if (typeof rate !== 'number' || rate <= 0) return null

    await db.fxRate.create({
      data: {
        fromCurrency: 'GBP',
        toCurrency: code,
        rate,
      },
    })
    return rate
  } catch {
    return null
  }
}

/** Fetch FX rates for all active currencies (called daily via cron or on demand) */
export async function fetchAllFxRates(): Promise<{ success: boolean; updated: string[]; failed: string[]; error?: string }> {
  try {
    const currencies = await db.currency.findMany({
      where: { active: true, code: { not: 'GBP' } },
      select: { code: true },
    })

    if (!currencies.length) return { success: true, updated: [], failed: [] }

    const codes = currencies.map((c) => c.code)
    const symbols = codes.join(',')

    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=GBP&symbols=${symbols}`, {
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      return { success: false, updated: [], failed: codes, error: `API returned ${res.status}` }
    }

    const data = await res.json()
    const rates = data?.rates ?? {}
    const updated: string[] = []
    const failed: string[] = []

    for (const code of codes) {
      const rate = rates[code]
      if (typeof rate === 'number' && rate > 0) {
        await db.fxRate.create({
          data: { fromCurrency: 'GBP', toCurrency: code, rate },
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
    logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', description: `Fetched FX rates for ${updated.length} currencies` })
    revalidatePath('/settings', 'layout')
    revalidatePath('/purchase-orders')
    return { success: true, updated, failed }
  } catch (e) {
    logActivity({ entityType: 'SYNC', tag: 'sync', action: 'fx_rates_fetched', level: 'ERROR', description: `Failed to fetch FX rates: ${String(e)}` })
    return { success: false, updated: [], failed: [], error: String(e) }
  }
}
