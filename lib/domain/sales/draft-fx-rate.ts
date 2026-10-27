import type { Prisma } from '@/app/generated/prisma/client'
import { getFxRateToBase } from '@/lib/currencies/fx-lookup'

/**
 * The base-currency rate a draft sales order is re-priced at when it is finalised (moved out of app/actions/sales.ts so
 * it can be tested; a 'use server' module cannot export a helper like this).
 *
 * The base currency itself is 1. Every other currency reads the one central lookup (lib/currencies/fx-lookup.ts); a
 * missing rate THROWS ("Missing <base> FX rate for <cur> on or before <date>"), as it always did.
 * A manual sales order is created at this same lookup (createSalesOrder): no order takes a typed rate.
 */
export async function resolveFxRateToBase(
  tx: Pick<Prisma.TransactionClient, 'fxRate' | 'setting'>,
  currency: string,
  baseCurrency: string,
  asOf: Date,
): Promise<number> {
  const normalizedCurrency = currency.trim().toUpperCase()
  const normalizedBase = baseCurrency.trim().toUpperCase()
  if (!normalizedCurrency || normalizedCurrency === normalizedBase) return 1
  const rate = await getFxRateToBase(tx, { currency: normalizedCurrency, asOf, baseCurrency: normalizedBase })
  return rate.rate.toNumber()
}
