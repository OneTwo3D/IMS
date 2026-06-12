import { db } from '@/lib/db'
import type { Prisma, TaxCategory } from '@/app/generated/prisma/client'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'

export type TaxUsedFor = 'SALES' | 'PURCHASE'

export type ResolvedTaxRate = {
  taxRateId: string | null
  taxRateName: string | null
  taxRateValue: number
  accountingTaxType: string | null
  isCompound: boolean
  reverseCharge: boolean
  reportingCategory: string | null
  components: TaxRateComponentCandidate[]
  matched: 'exact' | 'country_standard' | 'global' | 'fallback'
  warning: string | null
}

export type TaxRateComponentCandidate = {
  name: string
  rate: number
  compoundOnPrevious: boolean
  accountingTaxType: string | null
  sortOrder: number
}

export type TaxRateCandidate = {
  id: string
  name: string
  rate: number
  accountingTaxType: string | null
  countryCode: string | null
  taxCategory: TaxCategory
  usedFor: string
  isCompound: boolean
  reverseCharge: boolean
  reportingCategory: string | null
  components: TaxRateComponentCandidate[]
}

export const taxRateProfileSelect = {
  id: true,
  name: true,
  rate: true,
  accountingTaxType: true,
  isCompound: true,
  reverseCharge: true,
  reportingCategory: true,
  components: {
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      name: true,
      rate: true,
      compoundOnPrevious: true,
      accountingTaxType: true,
      sortOrder: true,
    },
  },
} satisfies Prisma.TaxRateSelect

type TaxRateProfileRow = Prisma.TaxRateGetPayload<{ select: typeof taxRateProfileSelect }>

type ResolveContext = {
  usedFor: TaxUsedFor
  orderDefault: {
    id: string | null
    name: string | null
    rate: number
    accountingTaxType: string | null
    isCompound?: boolean
    reverseCharge?: boolean
    reportingCategory?: string | null
    components?: TaxRateComponentCandidate[]
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

export function resolvedTaxRateFromProfile(
  row: TaxRateProfileRow,
  matched: ResolvedTaxRate['matched'],
): ResolvedTaxRate {
  const components = row.components.map((component) => ({
    name: component.name,
    rate: Number(component.rate),
    compoundOnPrevious: component.compoundOnPrevious,
    accountingTaxType: component.accountingTaxType,
    sortOrder: component.sortOrder,
  }))
  return {
    taxRateId: row.id,
    taxRateName: row.name,
    taxRateValue: effectiveTaxRateFromComponents(components) ?? Number(row.rate),
    accountingTaxType: row.accountingTaxType,
    isCompound: row.isCompound,
    reverseCharge: row.reverseCharge,
    reportingCategory: row.reportingCategory,
    components,
    matched,
    warning: null,
  }
}

function resolvedTaxRateFromCandidate(
  row: TaxRateCandidate,
  matched: ResolvedTaxRate['matched'],
): ResolvedTaxRate {
  const activeRate = effectiveTaxRateFromComponents(row.components) ?? Number(row.rate)
  return {
    taxRateId: row.id,
    taxRateName: row.name,
    taxRateValue: activeRate,
    accountingTaxType: row.accountingTaxType,
    isCompound: row.isCompound,
    reverseCharge: row.reverseCharge,
    reportingCategory: row.reportingCategory,
    components: row.components,
    matched,
    warning: null,
  }
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
      return resolvedTaxRateFromCandidate(exact, 'exact')
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
      return resolvedTaxRateFromCandidate(countryStandard, 'country_standard')
    }
  }

  // Step 3: global rate for the category
  const global = applicable.find((r) => r.countryCode == null && r.taxCategory === productCategory)
  if (global) {
    return resolvedTaxRateFromCandidate(global, 'global')
  }

  // Step 4: order default — flagged
  const warning = `No configured ${usedFor.toLowerCase()} rate for ${destCountry ? destCountry.toUpperCase() : 'unknown country'} / ${productCategory}. Using order default.`
  return {
    taxRateId: orderDefault.id,
    taxRateName: orderDefault.name,
    taxRateValue: orderDefault.rate,
    accountingTaxType: orderDefault.accountingTaxType,
    isCompound: orderDefault.isCompound ?? false,
    reverseCharge: orderDefault.reverseCharge ?? false,
    reportingCategory: orderDefault.reportingCategory ?? null,
    components: orderDefault.components ?? [],
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
      isCompound: true,
      reverseCharge: true,
      reportingCategory: true,
      components: {
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          rate: true,
          compoundOnPrevious: true,
          accountingTaxType: true,
          sortOrder: true,
        },
      },
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
    isCompound: r.isCompound,
    reverseCharge: r.reverseCharge,
    reportingCategory: r.reportingCategory,
    components: r.components.map((component) => ({
      name: component.name,
      rate: Number(component.rate),
      compoundOnPrevious: component.compoundOnPrevious,
      accountingTaxType: component.accountingTaxType,
      sortOrder: component.sortOrder,
    })),
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
      isCompound: true,
      reverseCharge: true,
      reportingCategory: true,
      components: {
        where: { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          rate: true,
          compoundOnPrevious: true,
          accountingTaxType: true,
          sortOrder: true,
        },
      },
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
    isCompound: r.isCompound,
    reverseCharge: r.reverseCharge,
    reportingCategory: r.reportingCategory,
    components: r.components.map((component) => ({
      name: component.name,
      rate: Number(component.rate),
      compoundOnPrevious: component.compoundOnPrevious,
      accountingTaxType: component.accountingTaxType,
      sortOrder: component.sortOrder,
    })),
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
