import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'

export type TaxRateComponentInput = {
  id?: string
  name: string
  rate: number
  compoundOnPrevious?: boolean
  accountingTaxType?: string | null
  sortOrder?: number
  active?: boolean
}

export type NormalizedTaxRateComponent = {
  id?: string
  name: string
  rate: number
  compoundOnPrevious: boolean
  accountingTaxType: string | null
  sortOrder: number
  active: boolean
}

export function normalizeTaxRateComponents(
  components: TaxRateComponentInput[] | null | undefined,
): NormalizedTaxRateComponent[] {
  if (!components?.length) return []
  return components
    .map((component, index) => {
      const normalized = {
        name: component.name.trim(),
        rate: Number(component.rate),
        compoundOnPrevious: Boolean(component.compoundOnPrevious),
        accountingTaxType: component.accountingTaxType?.trim() || null,
        sortOrder: component.sortOrder ?? index,
        active: component.active ?? true,
      }
      return component.id ? { id: component.id, ...normalized } : normalized
    })
    .filter((component) => component.name.length > 0 && Number.isFinite(component.rate) && component.rate >= 0)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
}

export function effectiveTaxRateFromComponents(
  components: Array<{ rate: number; compoundOnPrevious?: boolean; active?: boolean }>,
): number | null {
  const activeComponents = components.filter((component) => component.active ?? true)
  if (activeComponents.length === 0) return null

  let effectiveRate = toDecimal(0)
  for (const component of activeComponents) {
    const rate = toDecimal(component.rate)
    if (component.compoundOnPrevious) {
      effectiveRate = effectiveRate.plus(rate.times(toDecimal(1).plus(effectiveRate)))
    } else {
      effectiveRate = effectiveRate.plus(rate)
    }
  }

  return roundQuantity(effectiveRate, 4).toNumber()
}

export function taxRateIsCompoundProfile(components: Array<{ compoundOnPrevious?: boolean; active?: boolean }>): boolean {
  const activeComponents = components.filter((component) => component.active ?? true)
  return activeComponents.length > 1 || activeComponents.some((component) => component.compoundOnPrevious)
}
