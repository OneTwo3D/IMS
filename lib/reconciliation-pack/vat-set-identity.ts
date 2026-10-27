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
 *   a second Woo rate on the same IMS rate is a duplicate (DUPLICATE_MAPPING) whatever its scope, equal or different (one counterpart each). A regional rate
 *   (Canary Islands, PT-30) therefore needs its own mapping to its own IMS rate, and shows as WOO_UNMAPPED until it has one.
 *
 * HOW AN IMS RATE FINDS ITS XERO TYPE: by the accounting tax type CODE it carries, which must be an ACTIVE type of the proven stored list (never by name).
 *   The same rules as the re-key: percentage (Xero EffectiveRate, else DisplayTaxRate, as an exact decimal, against the rate IMS computes tax at),
 *   country (the Woo country, the IMS countryCode, the IMS name prefix and the Xero name prefix must agree; UK = GB, EL = GR) and report type
 *   (xeroReportTaxType of the IMS rate against the live ReportTaxType).
 *   Two more identities close what an equal percentage leaves open: the Woo rate's class against the class its IMS mapping recorded (CLASS_DIFFERS; empty is "standard"),
 *   a positive-percentage Woo rate must apply to shipping (SHIPPING_NOT_TAXED; a zero rate is exempt), the Woo compound flag against the IMS isCompound (COMPOUND_DIFFERS), and the ordered components of the IMS rate against the Xero type's (COMPONENTS_DIFFER, the re-key's componentMeaningDifference).
 *   REGION: IMS has no region field; it records a region only as the name suffix ("PT-30 VAT"). A Woo rate's state must equal it (REGION_DIFFERS); where IMS records none and the Woo rate is regional or shares country and class with another region, it is REGION_UNVERIFIED (a finding, never a pass), so a swapped pair of regional mappings cannot pass.
 *
 * Every row carries ZERO OR MORE reasons from a closed list; no reasons means the identity is identical across the systems it is in.
 */

import { Prisma } from '@/app/generated/prisma/client'

import type { NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { xeroReportTaxType } from '@/lib/connectors/xero/tax-rate-report-type'
import type { TaxComponentRateRow, TaxMappingRow, TaxRateRow } from '@/lib/reconciliation-pack/ims-readers'
import type { WooTaxRateDetail } from '@/lib/reconciliation-pack/woo-source'
import { normaliseCountryCode, xeroNameCountry } from '@/lib/tax/tax-country'
import { componentMeaningDifference } from '@/lib/tax/tax-rekey'
import { effectiveTaxRateFromComponents } from '@/lib/tax/tax-rate-components'
import { XERO_BUILT_IN_TAX_TYPES } from '@/lib/tax/xero-built-in-tax-types'

const Decimal = Prisma.Decimal
type Decimal = InstanceType<typeof Prisma.Decimal>

export const VAT_SET_REASONS = {
  WOO_UNMAPPED: 'a WooCommerce tax rate has no IMS mapping of the storefront connector',
  DUPLICATE_MAPPING: 'the counterpart is not unique: two or more WooCommerce rates (whatever their scope, equal or different) map to one IMS rate, or two active IMS sales rates carry one Xero tax type',
  IMS_RATE_NOT_ACTIVE_SALES: 'the IMS rate a WooCommerce rate maps to is inactive, purchase-only or a reverse-charge rate',
  IMS_NOT_IN_XERO: 'an in-scope IMS sales rate carries no Xero tax type, or a type that is not an ACTIVE type of the stored Xero list',
  XERO_NOT_SALES_TYPE: 'the Xero type an IMS sales rate carries cannot be applied to revenue',
  PERCENT_DIFFERS: 'the percentages of the systems are not equal as exact decimals (IMS: the active components\' effective rate, else the rate column; Xero: EffectiveRate, else DisplayTaxRate; neither stated is a difference)',
  COUNTRY_DIFFERS: 'the country of the WooCommerce rate, the IMS country code, the IMS name prefix and the Xero name prefix do not all agree',
  REPORT_TYPE_DIFFERS: 'the Xero ReportTaxType is not the one IMS files the rate under (xeroReportTaxType of the IMS rate)',
  REPORT_TYPE_UNKNOWN: 'the IMS reporting category is not one IMS maps to a VAT-return box, or the Xero type states no ReportTaxType, so the report type cannot be confirmed',
  CLASS_DIFFERS: 'the tax class of the WooCommerce rate is not the class its IMS mapping recorded (empty and "standard" are the same class; case and surrounding spaces are ignored)',
  COMPOUND_DIFFERS: 'the WooCommerce rate is compound and the IMS rate is not, or the other way round',
  COMPONENTS_DIFFER: 'the IMS rate and the Xero type do not tax the same way: the ordered components (count, each rate, compounding) differ, or the Xero type has a non-recoverable component (the re-key\'s componentMeaningDifference)',
  SHIPPING_NOT_TAXED: 'a WooCommerce rate with a positive percentage has "apply to shipping" off, but shipping always carries the goods\' VAT rate (owner ruling; the VAT difference report\'s WOO_SHIPPING_NOT_TAXED). A zero-rate is exempt: shipping at 0% is the same as no VAT on shipping',
  REGION_DIFFERS: 'the region of the WooCommerce rate (its state) is not the region its IMS rate records: IMS records a region only as the suffix of the rate name ("PT-30 VAT" is region 30), and the two disagree, including a regional IMS rate on a country-wide WooCommerce rate',
  REGION_UNVERIFIED: 'the region of the WooCommerce rate cannot be confirmed against IMS, which has no region data for the rate (a finding, never a pass): the WooCommerce rate has a state, a postcode or a city, a postcode or city IMS cannot record, or it shares country and class with an in-scope WooCommerce rate of another region and its IMS rate names no region',
  WOO_NAME_DIFFERS: 'the name of the WooCommerce rate is not the name of the IMS rate it maps to (trimmed, whitespace runs collapsed, case ignored: the same comparison as XERO_NAME_DIFFERS), so with the IMS and Xero names equal, no swap of mapping targets or of codes can pass; WooCommerce labels must be renamed to match IMS and Xero; the row carries both names',
  XERO_NAME_DIFFERS: 'the IMS rate and the Xero type its accounting tax type code names do not have the same name (trimmed, whitespace runs collapsed, case ignored: the name the re-key matches and copies from), so the code may point at another rate of the same percentage, components and report type ("PT-30 VAT" against "PT-30 IOSS VAT"); the row carries both names',
  XERO_REGION_DIFFERS: 'the region the IMS rate name states and the region the Xero type name states are not the same ("PT-30 VAT" against "PT-20 VAT"), including one regional and one country-wide; the same name parser reads both',
  XERO_REGION_UNVERIFIED: 'the region of the IMS rate name or of the Xero type name cannot be read (a word after the country prefix that is not a hyphenated region, such as "PT Madeira VAT"), so the two cannot be compared (a finding, never a pass)',
  MISSING_IN_WOO: 'an in-scope IMS sales rate or Xero sales type has no WooCommerce counterpart',
  XERO_NOT_IN_IMS: 'an in-scope Xero sales type is carried by no active IMS sales rate',
} as const
export type VatSetReason = keyof typeof VAT_SET_REASONS
export const VAT_SET_REASON_LIST = Object.keys(VAT_SET_REASONS) as VatSetReason[]

export type VatSetSystem = 'woo' | 'ims' | 'xero'
export type VatSetRow = { system: VatSetSystem; id: string; reasons: VatSetReason[]; /** Both names, only on an IMS row with XERO_NAME_DIFFERS (ims, xero) and a Woo row with WOO_NAME_DIFFERS (ims, woo). */ names?: { ims: string; xero?: string; woo?: string } }
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
/** The tax class as Woo states it: empty is the standard class; case and surrounding spaces do not count. */
const normaliseClass = (value: string | null): string => { const slug = (value ?? '').trim().toLowerCase(); return slug === '' ? 'standard' : slug }

/** A region token as one comparable string: upper case, letters and digits only, the leading country code dropped ("PT-30" and "30" are both "30"). */
function regionToken(text: string, country: string): string {
  const token = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return country !== '' && token.startsWith(country) && token.length > country.length ? token.slice(country.length) : token
}
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set(['VAT', 'TAX', 'GST', 'ZERO', 'STANDARD', 'REDUCED', 'RATE', 'OSS', 'IOSS', 'VOEC', 'EXEMPT'])
/**
 * The region a rate NAME states, one parser for IMS and Xero names: the token after a two-letter country prefix joined by a hyphen ("PT-30 VAT" is "30").
 *   region    a hyphenated region token ("PT-30 VAT")
 *   wide      the prefix is followed by a generic word or nothing ("PT VAT", "GB VAT (Income)", "UK Standard Rate (20%)"), or there is no country prefix: no region is stated
 *   unreadable  the prefix is followed by a word that is not generic ("ES Canary VAT", "PT Madeira VAT"): a region may be stated in a convention this parser does not read
 */
type NameRegion = { kind: 'region'; token: string } | { kind: 'wide' } | { kind: 'unreadable' }
function nameRegion(name: string, country: string): NameRegion {
  const text = name.trim()
  const hyphen = /^[A-Za-z]{2}-([A-Za-z0-9]+)/.exec(text)
  if (hyphen !== null && !GENERIC_NAME_WORDS.has(hyphen[1]!.toUpperCase())) return { kind: 'region', token: regionToken(hyphen[1]!, country) }
  const word = /^[A-Za-z]{2}[\s-]+([A-Za-z]+)/.exec(text)
  if (word !== null && !GENERIC_NAME_WORDS.has(word[1]!.toUpperCase())) return { kind: 'unreadable' }
  return { kind: 'wide' }
}
/** A rate name as the re-key compares it: trimmed, whitespace runs collapsed, case ignored. */
const comparableName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** The region an IMS rate records in its name; null when it states none. IMS has no region field. */
function imsRegion(name: string, country: string): string | null {
  const region = nameRegion(name, country)
  return region.kind === 'region' ? region.token : null
}

export function compareVatSetIdentity(input: VatSetInput): VatSetRow[] {
  const ratesById = new Map(input.rates.map((rate) => [rate.id, rate]))
  const xeroByType = new Map(input.xero.map((row) => [row.taxType, row]))
  const mappedTo = new Map(input.mappings.map((mapping) => [mapping.externalTaxRateId, mapping.taxRateId]))
  const mappedClass = new Map(input.mappings.map((mapping) => [mapping.externalTaxRateId, normaliseClass(mapping.externalClass)]))

  const imsInScope = input.rates.filter((rate) => rate.active && isSales(rate.usedFor) && !rate.reverseCharge)
  const imsInScopeIds = new Set(imsInScope.map((rate) => rate.id))

  // The Woo rate IDS on each IMS rate: more than one is a duplicate whether or not their scopes are equal (owner ruling: one identical set, one counterpart each).
  const wooIdsByIms = new Map<string, Set<string>>()
  for (const woo of input.woo) {
    const target = mappedTo.get(woo.id)
    if (target === undefined) continue
    wooIdsByIms.set(target, new Set([...(wooIdsByIms.get(target) ?? []), woo.id]))
  }
  const carriersByType = new Map<string, TaxRateRow[]>()
  for (const rate of imsInScope) if (rate.accountingTaxType !== null) carriersByType.set(rate.accountingTaxType, [...(carriersByType.get(rate.accountingTaxType) ?? []), rate])

  // Woo rates of one country and class, by the regions they cover: a rate that shares both with a rate of another region is one a swap could hide.
  const regionKeyOf = (woo: WooTaxRateDetail): string => [woo.state, woo.postcode, woo.city].map((part) => part.trim().toUpperCase()).join('|')
  const regionsByCountryClass = new Map<string, Set<string>>()
  for (const woo of input.woo) {
    const target = mappedTo.get(woo.id)
    if (target === undefined || !imsInScopeIds.has(target)) continue
    const key = `${normaliseCountryCode(woo.country)}|${normaliseClass(woo.class)}`
    const regions = regionsByCountryClass.get(key) ?? new Set<string>()
    regions.add(regionKeyOf(woo))
    regionsByCountryClass.set(key, regions)
  }

  const rows: VatSetRow[] = []
  const nameDifferences = new Map<string, { ims: string; xero?: string; woo?: string }>()
  const add = (system: VatSetSystem, id: string, reasons: Set<VatSetReason>): void => {
    const names = (system === 'ims' && reasons.has('XERO_NAME_DIFFERS')) || (system === 'woo' && reasons.has('WOO_NAME_DIFFERS')) ? nameDifferences.get(`${system}|${id}`) : undefined
    rows.push({ system, id, reasons: VAT_SET_REASON_LIST.filter((reason) => reasons.has(reason)), ...(names === undefined ? {} : { names }) })
  }

  // The checks between an IMS rate and its live Xero type (shared by the IMS row).
  const imsXeroReasons = (rate: TaxRateRow, reasons: Set<VatSetReason>): void => {
    const code = rate.accountingTaxType
    const live = code === null ? undefined : xeroByType.get(code)
    if (live === undefined || live.status !== 'ACTIVE') { reasons.add('IMS_NOT_IN_XERO'); return }
    if (live.canApply.revenue !== true) reasons.add('XERO_NOT_SALES_TYPE')
    const ims = imsPercent(rate, input.componentRates)
    const stated = xeroPercent(live)
    if (ims === null || stated === null || !ims.eq(stated)) reasons.add('PERCENT_DIFFERS')
    if (componentMeaningDifference({ rate: rate.rate, components: input.componentRates.filter((component) => component.taxRateId === rate.id) }, live) !== null) reasons.add('COMPONENTS_DIFFER')
    const country = rate.countryCode === null ? '' : normaliseCountryCode(rate.countryCode)
    const imsPrefix = xeroNameCountry(rate.name)
    const livePrefix = xeroNameCountry(live.name)
    if ((imsPrefix !== null && imsPrefix !== country) || (livePrefix !== null && livePrefix !== country) || (country === '' && livePrefix !== null)) reasons.add('COUNTRY_DIFFERS')
    if (comparableName(rate.name) !== comparableName(live.name)) { reasons.add('XERO_NAME_DIFFERS'); nameDifferences.set(`ims|${rate.id}`, { ims: rate.name, xero: live.name }) }
    const imsNameRegion = nameRegion(rate.name, country)
    const liveNameRegion = nameRegion(live.name, country)
    if (imsNameRegion.kind === 'unreadable' || liveNameRegion.kind === 'unreadable') reasons.add('XERO_REGION_UNVERIFIED')
    else if ((imsNameRegion.kind === 'region' ? imsNameRegion.token : null) !== (liveNameRegion.kind === 'region' ? liveNameRegion.token : null)) reasons.add('XERO_REGION_DIFFERS')
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
      if ((wooIdsByIms.get(ims.id)?.size ?? 0) > 1) reasons.add('DUPLICATE_MAPPING')
      const wooPercent = exact(woo.rate)
      const imsValue = imsPercent(ims, input.componentRates)
      if (wooPercent === null || imsValue === null || !wooPercent.eq(imsValue)) reasons.add('PERCENT_DIFFERS')
      const imsCountry = ims.countryCode === null ? '' : normaliseCountryCode(ims.countryCode)
      if (normaliseCountryCode(woo.country) !== imsCountry) reasons.add('COUNTRY_DIFFERS')
      if (normaliseClass(woo.class) !== mappedClass.get(woo.id)) reasons.add('CLASS_DIFFERS')
      if (woo.compound !== ims.isCompound) reasons.add('COMPOUND_DIFFERS')
      if (comparableName(woo.name) !== comparableName(ims.name)) { reasons.add('WOO_NAME_DIFFERS'); nameDifferences.set(`woo|${woo.id}`, { ims: ims.name, woo: woo.name }) }
      // REGION: IMS records a region only in the rate name. A recorded region must equal the Woo state (and Woo then has no postcode or city IMS could not hold); where IMS records none, a Woo rate that is regional, or shares country and class with another region, cannot be confirmed.
      const wooCountry = normaliseCountryCode(woo.country)
      const recorded = imsRegion(ims.name, wooCountry)
      const wooState = regionToken(woo.state, wooCountry)
      const hasExtra = woo.postcode.trim() !== '' || woo.city.trim() !== ''
      if (recorded !== null) {
        if (wooState !== recorded) reasons.add('REGION_DIFFERS')
        else if (hasExtra) reasons.add('REGION_UNVERIFIED')
      } else if (wooState !== '' || hasExtra || (regionsByCountryClass.get(`${wooCountry}|${normaliseClass(woo.class)}`)?.size ?? 0) > 1) reasons.add('REGION_UNVERIFIED')
      // Same rule as the VAT difference report (WOO_SHIPPING_NOT_TAXED), judged on its reference percentage: the ACTIVE live Xero type's, else the IMS rate's. Only for a rate that report also judges (an in-scope IMS rate).
      const liveType = ims.accountingTaxType === null ? undefined : xeroByType.get(ims.accountingTaxType)
      const reference = (liveType !== undefined && liveType.status === 'ACTIVE' ? xeroPercent(liveType) : null) ?? imsValue
      if (imsInScopeIds.has(ims.id) && !woo.shipping && reference !== null && reference.gt(0)) reasons.add('SHIPPING_NOT_TAXED')
    }
    add('woo', woo.id, reasons)
  }

  for (const rate of imsInScope) {
    const reasons = new Set<VatSetReason>()
    if ((wooIdsByIms.get(rate.id)?.size ?? 0) === 0) reasons.add('MISSING_IN_WOO')
    imsXeroReasons(rate, reasons)
    if (rate.accountingTaxType !== null && (carriersByType.get(rate.accountingTaxType)?.length ?? 0) > 1) reasons.add('DUPLICATE_MAPPING')
    add('ims', rate.id, reasons)
  }

  for (const live of input.xero) {
    if (live.status !== 'ACTIVE' || XERO_BUILT_IN_TAX_TYPES.has(live.taxType) || live.canApply.revenue !== true) continue
    const reasons = new Set<VatSetReason>()
    const carriers = carriersByType.get(live.taxType) ?? []
    if (carriers.length === 0) reasons.add('XERO_NOT_IN_IMS')
    else if (!carriers.some((rate) => (wooIdsByIms.get(rate.id)?.size ?? 0) > 0)) reasons.add('MISSING_IN_WOO')
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
