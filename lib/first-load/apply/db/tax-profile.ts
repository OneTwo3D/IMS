/**
 * THE ACCOUNTING PROFILE OF A TAX RATE: every setting of a rate that changes what a purchase order posts.
 *
 * Read from the code that uses it (lib/tax/resolve-rate.ts `taxRateProfileSelect` and `resolvedTaxRateFromProfile`, and createPurchaseOrder, which takes the line's tax
 * amount from `taxRateValue = effective rate of the ACTIVE components, else the rate column`):
 *   - rate (the column the importer matches by value) and the effective rate (what the tax amount is computed from);
 *   - accountingTaxType, isCompound, reverseCharge, reportingCategory;
 *   - the active components: name, rate, compoundOnPrevious, accountingTaxType, sortOrder.
 * Not part of it: the name (it is the lookup key), id, usedFor and active (the lookup's own eligibility filters), countryCode, taxCategory, isDefault (not read by the purchase path).
 *
 * Two rates are interchangeable for a purchase order only when their profiles are identical.
 */
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'
import { taxRateProfileSelect } from '@/lib/tax/resolve-rate'
import { createHash } from 'node:crypto'
import { D, fmtFixed } from '../../money'

export const TAX_RATE_SELECT = { ...taxRateProfileSelect, usedFor: true, active: true } as const

export interface TaxRateRow {
  name: string
  rate: { toFixed(): string }
  usedFor: string
  active: boolean
  accountingTaxType: string | null
  isCompound: boolean
  reverseCharge: boolean
  reportingCategory: string | null
  components: ReadonlyArray<{ name: string; rate: { toFixed(): string }; compoundOnPrevious: boolean; accountingTaxType: string | null; sortOrder: number }>
}

const four = (value: { toFixed(): string } | number): string => fmtFixed(new D(typeof value === 'number' ? String(value) : value.toFixed()), 4)

/** The effective rate the purchase path computes tax from. */
export function effectiveRate(row: TaxRateRow): string {
  const effective = effectiveTaxRateFromComponents(row.components.map((c) => ({ rate: Number(c.rate.toFixed()), compoundOnPrevious: c.compoundOnPrevious })))
  return four(effective ?? Number(row.rate.toFixed()))
}

/** True when the rate column and the effective rate disagree: the importer would match one number and tax at the other. */
export function rateIsInconsistent(row: TaxRateRow): boolean {
  return effectiveRate(row) !== four(row.rate)
}

export function taxRateSignature(row: TaxRateRow): string {
  return JSON.stringify({
    rate: four(row.rate),
    effective: effectiveRate(row),
    accountingTaxType: row.accountingTaxType,
    isCompound: row.isCompound,
    reverseCharge: row.reverseCharge,
    reportingCategory: row.reportingCategory,
    components: [...row.components]
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => [c.name, four(c.rate), c.compoundOnPrevious, c.accountingTaxType, c.sortOrder]),
  })
}

export const signatureDigest = (signature: string): string => createHash('sha256').update(signature).digest('hex').slice(0, 24)
