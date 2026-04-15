import { cache } from 'react'
import { db } from '@/lib/db'
import type { CurrencySymbolPos } from '@/app/generated/prisma/enums'

export const DEFAULT_BASE_CURRENCY = 'GBP'

export type BaseCurrencyDisplay = {
  code: string
  symbol: string
  symbolPosition: CurrencySymbolPos
}

const FALLBACK_CURRENCY_META: Record<string, { name: string; symbol: string; symbolPosition: CurrencySymbolPos }> = {
  GBP: { name: 'British Pound Sterling', symbol: '£', symbolPosition: 'PREFIX' },
  EUR: { name: 'Euro', symbol: '€', symbolPosition: 'POSTFIX' },
  USD: { name: 'US Dollar', symbol: '$', symbolPosition: 'PREFIX' },
  NOK: { name: 'Norwegian Krone', symbol: 'kr', symbolPosition: 'POSTFIX' },
  SEK: { name: 'Swedish Krona', symbol: 'kr', symbolPosition: 'POSTFIX' },
  CAD: { name: 'Canadian Dollar', symbol: 'C$', symbolPosition: 'PREFIX' },
}

export function getFallbackCurrencyMeta(code: string): { name: string; symbol: string; symbolPosition: CurrencySymbolPos } {
  return FALLBACK_CURRENCY_META[code] ?? { name: code, symbol: code, symbolPosition: 'PREFIX' }
}

export const getBaseCurrencyCode = cache(async (): Promise<string> => {
  const org = await db.organisation.findFirst({ select: { baseCurrency: true } })
  return org?.baseCurrency ?? DEFAULT_BASE_CURRENCY
})

export const getBaseCurrencyDisplay = cache(async (): Promise<BaseCurrencyDisplay> => {
  const code = await getBaseCurrencyCode()
  const row = await db.currency.findUnique({
    where: { code },
    select: { symbol: true, symbolPosition: true },
  })
  if (row) return { code, symbol: row.symbol, symbolPosition: row.symbolPosition }
  const fallback = getFallbackCurrencyMeta(code)
  return { code, symbol: fallback.symbol, symbolPosition: fallback.symbolPosition }
})

export const isBaseCurrencyLocked = cache(async (): Promise<boolean> => {
  const [setting, counts] = await Promise.all([
    db.setting.findUnique({ where: { key: 'base_currency_locked' }, select: { value: true } }),
    Promise.all([
      db.product.count(),
      db.supplier.count(),
      db.customer.count(),
      db.purchaseOrder.count(),
      db.salesOrder.count(),
      db.stockMovement.count(),
    ]),
  ])
  if (setting?.value === 'true') return true
  return counts.some((count) => count > 0)
})
