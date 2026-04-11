import { db } from '@/lib/db'
import type { TaxCategory } from '@/app/generated/prisma/client'

export type TaxUsedFor = 'SALES' | 'PURCHASE'

export type ResolvedTaxRate = {
  taxRateId: string | null
  taxRateName: string | null
  taxRateValue: number
  accountingTaxType: string | null
  matched: 'exact' | 'country_standard' | 'global' | 'fallback'
  warning: string | null
}

export type TaxRateCandidate = {
  id: string
  name: string
  rate: number
  accountingTaxType: string | null
  countryCode: string | null
  taxCategory: TaxCategory
  usedFor: string
}

type ResolveContext = {
  usedFor: TaxUsedFor
  orderDefault: {
    id: string | null
    name: string | null
    rate: number
    accountingTaxType: string | null
  }
}

/**
 * Returns true if a TaxRate row applies to the given usedFor filter.
 * SALES matches "SALES" or "BOTH"; PURCHASE matches "PURCHASE" or "BOTH".
 */
export function taxRateMatchesUsedFor(rowUsedFor: string, usedFor: TaxUsedFor): boolean {
  const uf = (rowUsedFor || 'BOTH').toUpperCase()
  if (uf === 'BOTH') return true
  if (usedFor === 'SALES') return uf === 'SALES'
  return uf === 'PURCHASE'
}

/**
 * Canonical client/server-shared resolver algorithm: given the full list of
 * candidate TaxRate rows, pick the best one for (category, destCountry, usedFor)
 * by running the 4-step fallback chain described in the tax plan.
 *
 * Mirror this algorithm exactly in the client-side helper.
 */
export function pickTaxRate(args: {
  productCategory: TaxCategory
  destinationCountry: string | null
  usedFor: TaxUsedFor
  rates: TaxRateCandidate[]
  orderDefault: ResolveContext['orderDefault']
}): ResolvedTaxRate {
  const { productCategory, usedFor, rates, orderDefault } = args
  const destCountry = args.destinationCountry ? args.destinationCountry.toLowerCase() : null

  const applicable = rates.filter((r) => taxRateMatchesUsedFor(r.usedFor, usedFor))

  // Step 1: exact (country + category)
  if (destCountry) {
    const exact = applicable.find(
      (r) =>
        r.countryCode != null &&
        r.countryCode.toLowerCase() === destCountry &&
        r.taxCategory === productCategory,
    )
    if (exact) {
      return {
        taxRateId: exact.id,
        taxRateName: exact.name,
        taxRateValue: Number(exact.rate),
        accountingTaxType: exact.accountingTaxType,
        matched: 'exact',
        warning: null,
      }
    }
  }

  // Step 2: country STANDARD — only if the product category is STANDARD
  if (destCountry && productCategory === 'STANDARD') {
    const countryStandard = applicable.find(
      (r) =>
        r.countryCode != null &&
        r.countryCode.toLowerCase() === destCountry &&
        r.taxCategory === 'STANDARD',
    )
    if (countryStandard) {
      return {
        taxRateId: countryStandard.id,
        taxRateName: countryStandard.name,
        taxRateValue: Number(countryStandard.rate),
        accountingTaxType: countryStandard.accountingTaxType,
        matched: 'country_standard',
        warning: null,
      }
    }
  }

  // Step 3: global rate for the category
  const global = applicable.find((r) => r.countryCode == null && r.taxCategory === productCategory)
  if (global) {
    return {
      taxRateId: global.id,
      taxRateName: global.name,
      taxRateValue: Number(global.rate),
      accountingTaxType: global.accountingTaxType,
      matched: 'global',
      warning: null,
    }
  }

  // Step 4: order default — flagged
  const warning = `No configured ${usedFor.toLowerCase()} rate for ${destCountry ? destCountry.toUpperCase() : 'unknown country'} / ${productCategory}. Using order default.`
  return {
    taxRateId: orderDefault.id,
    taxRateName: orderDefault.name,
    taxRateValue: orderDefault.rate,
    accountingTaxType: orderDefault.accountingTaxType,
    matched: 'fallback',
    warning,
  }
}

/**
 * Server-side single-line resolver: loads candidate rates from the DB and
 * runs pickTaxRate. Prefer resolveLineTaxRateBatch when resolving multiple lines.
 */
export async function resolveLineTaxRate(args: {
  productCategory: TaxCategory
  destinationCountry: string | null
  usedFor: TaxUsedFor
  orderDefault: ResolveContext['orderDefault']
}): Promise<ResolvedTaxRate> {
  const { productCategory, destinationCountry, usedFor, orderDefault } = args
  const rates = await loadCandidateRates({
    destinationCountry,
    productCategory,
    usedFor,
  })
  return pickTaxRate({ productCategory, destinationCountry, usedFor, rates, orderDefault })
}

async function loadCandidateRates(args: {
  destinationCountry: string | null
  productCategory: TaxCategory
  usedFor: TaxUsedFor
}): Promise<TaxRateCandidate[]> {
  const { destinationCountry, productCategory, usedFor } = args
  const usedForIn =
    usedFor === 'SALES' ? ['SALES', 'BOTH'] : ['PURCHASE', 'BOTH']

  // We need rates relevant to each step of the fallback chain. To keep the
  // query simple and the index happy, load:
  //  - rows for the dest country with this category or STANDARD
  //  - rows with null country and this category
  const categories: TaxCategory[] =
    productCategory === 'STANDARD'
      ? ['STANDARD']
      : [productCategory, 'STANDARD']

  const rows = await db.taxRate.findMany({
    where: {
      active: true,
      usedFor: { in: usedForIn },
      OR: [
        destinationCountry
          ? {
              countryCode: destinationCountry,
              taxCategory: { in: categories },
            }
          : undefined,
        {
          countryCode: null,
          taxCategory: productCategory,
        },
      ].filter(Boolean) as Array<Record<string, unknown>>,
    },
    select: {
      id: true,
      name: true,
      rate: true,
      accountingTaxType: true,
      countryCode: true,
      taxCategory: true,
      usedFor: true,
    },
  })

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: Number(r.rate),
    accountingTaxType: r.accountingTaxType,
    countryCode: r.countryCode,
    taxCategory: r.taxCategory,
    usedFor: r.usedFor,
  }))
}

/**
 * Batch resolver: for a set of lines (each with productId and productCategory),
 * resolve all rates in one DB round trip, returning a Map keyed by line id.
 *
 * Loads *all* active rates that could match any line's category for the
 * given country + usedFor combination, then runs pickTaxRate for each line
 * against that in-memory list.
 */
export async function resolveLineTaxRateBatch<L extends { id: string; productCategory: TaxCategory }>(
  lines: L[],
  ctx: {
    destinationCountry: string | null
    usedFor: TaxUsedFor
    orderDefault: ResolveContext['orderDefault']
  },
): Promise<Map<string, ResolvedTaxRate>> {
  const result = new Map<string, ResolvedTaxRate>()
  if (lines.length === 0) return result

  const { destinationCountry, usedFor, orderDefault } = ctx
  const usedForIn =
    usedFor === 'SALES' ? ['SALES', 'BOTH'] : ['PURCHASE', 'BOTH']

  const distinctCategories = Array.from(new Set(lines.map((l) => l.productCategory)))
  const categoriesWithStandard = Array.from(new Set<TaxCategory>([...distinctCategories, 'STANDARD']))

  const rows = await db.taxRate.findMany({
    where: {
      active: true,
      usedFor: { in: usedForIn },
      OR: [
        destinationCountry
          ? {
              countryCode: destinationCountry,
              taxCategory: { in: categoriesWithStandard },
            }
          : undefined,
        { countryCode: null, taxCategory: { in: distinctCategories } },
      ].filter(Boolean) as Array<Record<string, unknown>>,
    },
    select: {
      id: true,
      name: true,
      rate: true,
      accountingTaxType: true,
      countryCode: true,
      taxCategory: true,
      usedFor: true,
    },
  })

  const rates: TaxRateCandidate[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    rate: Number(r.rate),
    accountingTaxType: r.accountingTaxType,
    countryCode: r.countryCode,
    taxCategory: r.taxCategory,
    usedFor: r.usedFor,
  }))

  const cache = new Map<TaxCategory, ResolvedTaxRate>()
  for (const line of lines) {
    const cached = cache.get(line.productCategory)
    if (cached) {
      result.set(line.id, cached)
      continue
    }
    const resolved = pickTaxRate({
      productCategory: line.productCategory,
      destinationCountry,
      usedFor,
      rates,
      orderDefault,
    })
    cache.set(line.productCategory, resolved)
    result.set(line.id, resolved)
  }
  return result
}
