/**
 * R13, SET IDENTITY: WooCommerce, IMS and Xero use the same set of VAT rates (owner ruling). Pure: no clock, no database, no network, no write.
 *
 * SCOPE (what is judged; everything else is out of scope and not listed)
 *   WooCommerce  every tax rate the store lists, of every tax class and every region (a Canary Islands or PT-30 rate is a rate like any other).
 *   IMS          every ACTIVE tax rate used for SALES or BOTH that is not a reverse-charge rate. (Inactive, purchase-only and reverse-charge rates are out of scope.)
 *   Xero         every ACTIVE, organisation-specific (custom) tax type that can be applied to revenue. (Xero's built-in types, types that are not
 *                ACTIVE and types that cannot be applied to revenue are out of scope. A built-in type is still a valid TARGET of an IMS rate.)
 *   That covers the UK, OSS, IOSS and VOEC rate sets alike: the rule does not depend on the scheme, because the ruling is that the sets are equal.
 *
 * HOW A WOOCOMMERCE RATE FINDS ITS IMS RATE: only through the stored mapping of the storefront connector (ShoppingTaxRateMapping, keyed by the store's rate id).
 *   Country, state, postcode and city never choose an IMS rate; they describe the Woo rate's scope. The country must agree with the IMS rate's country;
 *   state, postcode, city and class are the scope that a second Woo rate must share to be a duplicate of the first (below). A regional rate
 *   (Canary Islands, PT-30) therefore needs its own mapping to its own IMS rate, and shows as WOO_UNMAPPED until it has one.
 *
 * HOW AN IMS RATE FINDS ITS XERO TYPE: by the accounting tax type CODE it carries, which must be an ACTIVE type of the proven stored list (never by name).
 *   The same rules as the re-key: percentage (Xero EffectiveRate, else DisplayTaxRate, as an exact decimal, against the rate IMS computes tax at),
 *   country (the Woo country, the IMS countryCode, the IMS name prefix and the Xero name prefix must agree; UK = GB, EL = GR) and report type
 *   (xeroReportTaxType of the IMS rate against the live ReportTaxType).
 *
 * Every row carries ZERO OR MORE reasons from a closed list; no reasons means the identity is identical across the systems it is in.
 */

import { Prisma } from '@/app/generated/prisma/client'

import type { NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { xeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'
import type { TaxComponentRateRow, TaxMappingRow, TaxRateRow } from '@/lib/reconciliation-pack/ims-readers'
import type { WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { normaliseCountryCode, xeroNameCountry } from '@/lib/tax/tax-country'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'
import { XERO_BUILT_IN_TAX_TYPES } from '@/lib/tax/xero-built-in-tax-types'

const Decimal = Prisma.Decimal
type Decimal = InstanceType<typeof Prisma.Decimal>

export const VAT_SET_REASONS = {
  WOO_UNMAPPED: 'a WooCommerce tax rate has no IMS mapping of the storefront connector',
  DUPLICATE_MAPPING: 'the counterpart is not unique: two WooCommerce rates of different scope (country, state, postcode, city or class) map to one IMS rate, or two active IMS sales rates carry one Xero tax type',
  IMS_RATE_NOT_ACTIVE_SALES: 'the IMS rate a WooCommerce rate maps to is inactive, purchase-only or a reverse-charge rate',
  IMS_NOT_IN_XERO: 'an in-scope IMS sales rate carries no Xero tax type, or a type that is not an ACTIVE type of the stored Xero list',
  XERO_NOT_SALES_TYPE: 'the Xero type an IMS sales rate carries cannot be applied to revenue',
  PERCENT_DIFFERS: 'the percentages of the systems are not equal as exact decimals (IMS: the active components\' effective rate, else the rate column; Xero: EffectiveRate, else DisplayTaxRate; neither stated is a difference)',
  COUNTRY_DIFFERS: 'the country of the WooCommerce rate, the IMS country code, the IMS name prefix and the Xero name prefix do not all agree',
  REPORT_TYPE_DIFFERS: 'the Xero ReportTaxType is not the one IMS files the rate under (xeroReportTaxType of the IMS rate)',
  REPORT_TYPE_UNKNOWN: 'the IMS reporting category is not one IMS maps to a VAT-return box, or the Xero type states no ReportTaxType, so the report type cannot be confirmed',
  MISSING_IN_WOO: 'an in-scope IMS sales rate or Xero sales type has no WooCommerce counterpart',
  XERO_NOT_IN_IMS: 'an in-scope Xero sales type is carried by no active IMS sales rate',
} as const
export type VatSetReason = keyof typeof VAT_SET_REASONS
export const VAT_SET_REASON_LIST = Object.keys(VAT_SET_REASONS) as VatSetReason[]

export type VatSetSystem = 'woo' | 'ims' | 'xero'
export type VatSetRow = { system: VatSetSystem; id: string; reasons: VatSetReason[] }
export type VatSetSummary = {
  inScope: Record<VatSetSystem, number>
  identical: Record<VatSetSystem, number>
  byReason: Record<VatSetReason, number>
}

export type VatSetInput = {
  woo: readonly WooTaxRateDetail[]
  rates: readonly TaxRateRow[]
  /** Mappings of the storefront connector only. */
  mappings: readonly TaxMappingRow[]
  componentRates: readonly TaxComponentRateRow[]
  /** The rows of the PROVEN stored Xero list. */
  xero: readonly NormalisedXeroTaxRate[]
}

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(['DOMESTIC', 'REVERSE_CHARGE', 'EC_SALES', 'OSS'])
const isSales = (usedFor: string): boolean => usedFor === 'SALES' || usedFor === 'BOTH'

function exact(text: string | null): Decimal | null {
  if (text === null) return null
  try {
    const value = new Decimal(text)
    return value.isFinite() ? value : null
  } catch { return null }
}

/** The percentage IMS computes tax at: the active components' effective rate when it has any, else the rate column. */
function imsPercent(rate: TaxRateRow, components: readonly TaxComponentRateRow[]): Decimal | null {
  const column = exact(rate.rate)
  if (column === null) return null
  const active = components.filter((component) => component.taxRateId === rate.id && component.active).sort((a, b) => a.sortOrder - b.sortOrder)
  if (active.length === 0) return column.mul(100)
  const effective = effectiveTaxRateFromComponents(active.map((component) => ({ rate: Number(component.rate), compoundOnPrevious: component.compoundOnPrevious })))
  return effective === null ? column.mul(100) : new Decimal(String(effective)).mul(100)
}

const xeroPercent = (row: NormalisedXeroTaxRate): Decimal | null => exact(row.effectiveRate ?? row.displayTaxRate)
const scopeKey = (rate: WooTaxRateDetail): string => [normaliseCountryCode(rate.country), rate.state.trim().toUpperCase(), rate.postcode.trim(), rate.city.trim().toUpperCase(), rate.class.trim().toLowerCase() || 'standard'].join('|')

export function compareVatSetIdentity(input: VatSetInput): VatSetRow[] {
  const ratesById = new Map(input.rates.map((rate) => [rate.id, rate]))
  const xeroByType = new Map(input.xero.map((row) => [row.taxType, row]))
  const mappedTo = new Map(input.mappings.map((mapping) => [mapping.externalTaxRateId, mapping.taxRateId]))

  const imsInScope = input.rates.filter((rate) => rate.active && isSales(rate.usedFor) && !rate.reverseCharge)
  const imsInScopeIds = new Set(imsInScope.map((rate) => rate.id))
  // Which IMS rates have a Woo rate that is really in the store's list, and from which scopes.
  const wooScopesByIms = new Map<string, Set<string>>()
  for (const woo of input.woo) {
    const target = mappedTo.get(woo.id)
    if (target === undefined) continue
    const scopes = wooScopesByIms.get(target) ?? new Set<string>()
    scopes.add(scopeKey(woo))
    wooScopesByIms.set(target, scopes)
  }
  const carriersByType = new Map<string, TaxRateRow[]>()
  for (const rate of imsInScope) if (rate.accountingTaxType !== null) carriersByType.set(rate.accountingTaxType, [...(carriersByType.get(rate.accountingTaxType) ?? []), rate])

  const rows: VatSetRow[] = []
  const add = (system: VatSetSystem, id: string, reasons: Set<VatSetReason>): void => { rows.push({ system, id, reasons: VAT_SET_REASON_LIST.filter((reason) => reasons.has(reason)) }) }

  // The checks between an IMS rate and its live Xero type (shared by the IMS row).
  const imsXeroReasons = (rate: TaxRateRow, reasons: Set<VatSetReason>): void => {
    const code = rate.accountingTaxType
    const live = code === null ? undefined : xeroByType.get(code)
    if (live === undefined || live.status !== 'ACTIVE') { reasons.add('IMS_NOT_IN_XERO'); return }
    if (live.canApply.revenue !== true) reasons.add('XERO_NOT_SALES_TYPE')
    const ims = imsPercent(rate, input.componentRates)
    const stated = xeroPercent(live)
    if (ims === null || stated === null || !ims.eq(stated)) reasons.add('PERCENT_DIFFERS')
    const country = rate.countryCode === null ? '' : normaliseCountryCode(rate.countryCode)
    const imsPrefix = xeroNameCountry(rate.name)
    const livePrefix = xeroNameCountry(live.name)
    if ((imsPrefix !== null && imsPrefix !== country) || (livePrefix !== null && livePrefix !== country) || (country === '' && livePrefix !== null)) reasons.add('COUNTRY_DIFFERS')
    const category = (rate.reportingCategory ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
    const liveReport = live.reportTaxType === null ? null : live.reportTaxType.trim().toUpperCase()
    if ((category !== '' && !KNOWN_CATEGORIES.has(category)) || liveReport === null) reasons.add('REPORT_TYPE_UNKNOWN')
    else if (liveReport !== xeroReportTaxType({ reportingCategory: rate.reportingCategory, usedFor: rate.usedFor, name: rate.name, rate: Number(rate.rate) })) reasons.add('REPORT_TYPE_DIFFERS')
  }

  for (const woo of input.woo) {
    const reasons = new Set<VatSetReason>()
    const target = mappedTo.get(woo.id)
    const ims = target === undefined ? undefined : ratesById.get(target)
    if (target === undefined || ims === undefined) reasons.add('WOO_UNMAPPED')
    else {
      if (!imsInScopeIds.has(ims.id)) reasons.add('IMS_RATE_NOT_ACTIVE_SALES')
      if ((wooScopesByIms.get(ims.id)?.size ?? 0) > 1) reasons.add('DUPLICATE_MAPPING')
      const wooPercent = exact(woo.rate)
      const imsValue = imsPercent(ims, input.componentRates)
      if (wooPercent === null || imsValue === null || !wooPercent.eq(imsValue)) reasons.add('PERCENT_DIFFERS')
      const imsCountry = ims.countryCode === null ? '' : normaliseCountryCode(ims.countryCode)
      if (normaliseCountryCode(woo.country) !== imsCountry) reasons.add('COUNTRY_DIFFERS')
    }
    add('woo', woo.id, reasons)
  }

  for (const rate of imsInScope) {
    const reasons = new Set<VatSetReason>()
    if ((wooScopesByIms.get(rate.id)?.size ?? 0) === 0) reasons.add('MISSING_IN_WOO')
    imsXeroReasons(rate, reasons)
    if (rate.accountingTaxType !== null && (carriersByType.get(rate.accountingTaxType)?.length ?? 0) > 1) reasons.add('DUPLICATE_MAPPING')
    add('ims', rate.id, reasons)
  }

  for (const live of input.xero) {
    if (live.status !== 'ACTIVE' || XERO_BUILT_IN_TAX_TYPES.has(live.taxType) || live.canApply.revenue !== true) continue
    const reasons = new Set<VatSetReason>()
    const carriers = carriersByType.get(live.taxType) ?? []
    if (carriers.length === 0) reasons.add('XERO_NOT_IN_IMS')
    else if (!carriers.some((rate) => (wooScopesByIms.get(rate.id)?.size ?? 0) > 0)) reasons.add('MISSING_IN_WOO')
    add('xero', live.taxType, reasons)
  }
  return rows
}

export function summariseVatSet(rows: readonly VatSetRow[]): VatSetSummary {
  const zero = (): Record<VatSetSystem, number> => ({ woo: 0, ims: 0, xero: 0 })
  const summary: VatSetSummary = { inScope: zero(), identical: zero(), byReason: Object.fromEntries(VAT_SET_REASON_LIST.map((reason) => [reason, 0])) as Record<VatSetReason, number> }
  for (const row of rows) {
    summary.inScope[row.system] += 1
    if (row.reasons.length === 0) summary.identical[row.system] += 1
    for (const reason of row.reasons) summary.byReason[reason] += 1
  }
  return summary
}
