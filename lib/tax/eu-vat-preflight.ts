/**
 * THE EU IOSS / VOEC PREFLIGHT AND THE SEED APPLY: what is missing or mismatched between the declaration (lib/tax/eu-vat-seed.json), the IMS database and the STORED copy of Xero's tax-rate
 * list. It never calls Xero or WooCommerce and never writes a tax rate to Xero.
 *
 *   evaluateEuVatPreflight   PURE. Seed + a snapshot of what IMS and the stored Xero list hold -> findings. No database, no clock.
 *   readEuVatPreflightInput  READ ONLY. Reads the snapshot (IMS rates, storefront mappings, the cached chart of accounts, the settings, the proven stored Xero list).
 *   planEuVatSeedApply       PURE. The rows an apply would change: only `schemePostingTaxType` and `reportingCategory`, only on an IMS rate a WooCommerce mapping already names.
 *   applyEuVatSeed           WRITES, and only when the operator passes the digest of the plan they saw. Dry run is the default of the command.
 *
 * HOW A WOOCOMMERCE RATE FINDS ITS IMS RATE: only through the stored mapping (ShoppingTaxRateMapping, keyed by the store's rate id), as in the set-identity report. The mapping's own record of
 * the store rate (country, percentage, class) must equal the declaration's, or the mapping was made against another store and nothing is written through it. The apply never creates a rate, never
 * edits a mapping and never edits an account mapping: the rates come from the tax import and the re-key, the accounts from the settings form.
 *
 * ONE IMS RATE PER XERO RATE (owner ruling Q2, option A): WooCommerce rates declared to be the same Xero rate (the 33 on ZERORATEDOUTPUT) share one IMS rate. An IMS rate named by declared WooCommerce
 * rates that are NOT declared the same (SHARED_IMS_ROW), or two IMS rates on one Xero type (XERO_TYPE_ON_TWO_IMS_RATES), is an ERROR. The set-identity report (R13) accepts the declared sharing too.
 *
 * SEVERITY. `error` blocks readiness; `advisory` is listed and does not.
 */
import { createHash } from 'node:crypto'
import { imsPercent as effectiveImsPercent } from '@/lib/reconciliation-pack/vat-set-identity'
import type { TaxComponentRateRow, TaxRateRow } from '@/lib/reconciliation-pack/ims-readers'
import { WOO_TAX_RATE_WRITE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { Prisma } from '@/app/generated/prisma/client'
import { EU_ISO_CODES, VOEC_ISO_CODES } from '@/lib/connectors/xero/tax-rate-report-type'
import type { XeroConnectionStamp } from '@/lib/connectors/xero/connection-fence'
import type { NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import { readStoredXeroList, type Client } from '@/lib/tax/purchase-tax-import'
import { lockTaxRateForEdit, TaxRateReplacedError } from '@/lib/tax/tax-rate-replaced'
import { collapseName, normaliseCountryCode } from '@/lib/tax/tax-country'
import { parseCountSetting } from '@/lib/domain/accounting/eu-vat-settings'
import { isSchemeRate, NO_VAT_TAX_TYPE, type EuVatSeed, type EuVatSeedRate } from '@/lib/tax/eu-vat-seed'

const Dec = Prisma.Decimal
type Dec = InstanceType<typeof Prisma.Decimal>

/** The countries a scheme rate must exist for: the 27 EU member states, Monaco and Norway. */
export const SCHEME_COUNTRIES: readonly string[] = [...[...EU_ISO_CODES].filter((code) => code !== 'EL'), 'MC', ...VOEC_ISO_CODES].sort()

export type PreflightImsRate = {
  id: string
  name: string
  /** Fraction text, Decimal(5,4). */
  rate: string
  usedFor: string
  active: boolean
  reverseCharge: boolean
  countryCode: string | null
  accountingTaxType: string | null
  reportingCategory: string | null
  schemePostingTaxType: string | null
}
export type PreflightMapping = { id: string; externalTaxRateId: string; externalName: string; externalCountry: string | null; externalRatePct: string; externalClass: string | null; taxRateId: string; /** The normalised URL of the store the mapping was made against; null = never adopted (unstamped). */ storeIdentity: string | null }
export type PreflightAccount = { code: string; name: string }
export type PreflightXero = { proven: true; fetchedAt: string; rows: readonly NormalisedXeroTaxRate[] } | { proven: false; reason: string }
export type PreflightInput = {
  /** The normalised URL of the store configured NOW (normaliseStoreIdentity); null = none usable, and no mapping can be trusted. */
  storeIdentity: string | null
  seed: EuVatSeed
  xero: PreflightXero
  imsRates: readonly PreflightImsRate[]
  /** The tax components of the IMS rates (all rows; the active ones of a rate decide the percentage tax is computed at, as in the set-identity report). */
  componentRates: readonly TaxComponentRateRow[]
  mappings: readonly PreflightMapping[]
  /** The cached chart of accounts, active accounts with a code. */
  accounts: readonly PreflightAccount[]
  /** Raw stored values of the settings the preflight reads (absent = no row). */
  settings: Readonly<Record<string, string | null | undefined>>
}

export const PREFLIGHT_CODES = {
  WOO_UNMAPPED: 'no storefront mapping names an IMS rate for this WooCommerce rate',
  STORE_NOT_IDENTIFIED: 'no usable WooCommerce store is configured, so no mapping can be shown to belong to it',
  MAPPING_UNSTAMPED: 'the mapping was never adopted (it carries no store identity), so it is not shown to belong to the configured store: run the WooCommerce adoption step',
  MAPPING_OTHER_STORE: 'the mapping was made against another store than the one configured now',
  MAPPING_DIFFERS: 'the mapping records a store rate with another country, percentage or class than the declaration: it was made against another store, so nothing is read or written through it',
  IMS_RATE_MISSING: 'the mapping names an IMS rate that does not exist',
  IMS_RATE_INACTIVE: 'the IMS rate is inactive',
  IMS_RATE_NOT_SALES: 'the IMS rate is purchase-only or a reverse-charge rate',
  XERO_NOT_SALES_TYPE: 'the Xero type cannot be applied to revenue (canApply.revenue is not true; the set-identity report\'s XERO_NOT_SALES_TYPE), so sales lines cannot use it',
  SHARED_IMS_ROW: 'one IMS rate stands for WooCommerce rates the declaration does not declare to be the same Xero rate (only rates on the same Xero type may share an IMS rate)',
  IMS_PERCENT_DIFFERS: 'the IMS rate is not the percentage the declaration states',
  IMS_COUNTRY_DIFFERS: 'the IMS rate is for another country than the declaration states',
  IMS_NAME_DIFFERS: 'the IMS rate has another name than the declaration states (trimmed, whitespace collapsed, case ignored)',
  CHARGED_TYPE_MISSING: 'the IMS rate carries no accounting tax type',
  CHARGED_TYPE_NONE: 'the IMS rate carries NONE; a rate never posts on "No VAT"',
  CHARGED_TYPE_NOT_IN_XERO: 'the IMS rate\'s accounting tax type is not an ACTIVE type of the stored Xero list',
  CHARGED_TYPE_DIFFERS: 'the IMS rate\'s accounting tax type is not the one the declaration states, or the live type of the declared name',
  CHARGED_NAME_NOT_IN_XERO: 'no ACTIVE Xero type has the declared name, so the live code cannot be known: create it in Xero (this tool never does)',
  CHARGED_NAME_AMBIGUOUS: 'more than one ACTIVE Xero type has the declared name',
  CHARGED_NAME_DIFFERS: 'the live Xero type of the IMS rate\'s code has another name than the declaration states (byte-exact)',
  CHARGED_PERCENT_DIFFERS: 'the live Xero type of the IMS rate\'s code is not the declared percentage',
  SCHEME_FIELDS_DIFFER: 'the IMS rate\'s schemePostingTaxType or reportingCategory is not the declared one (npm run eu-vat:seed sets them)',
  SCHEME_ON_CHARGED_CODE: 'the IMS rate\'s charged code is its scheme posting type: a scheme line would post on the charged rate',
  SCHEME_TYPE_NOT_IN_XERO: 'the scheme posting type is not an ACTIVE type of the stored Xero list',
  SCHEME_NAME_DIFFERS: 'the live Xero type has another name than the declaration states (byte-exact)',
  SCHEME_NOT_ZERO: 'the live Xero type is not at an effective rate of exactly 0 (or states none)',
  SCHEME_FIELD_ON_UNDECLARED_RATE: 'an active IMS rate carries a scheme posting type but no declared WooCommerce rate names it',
  COUNTRY_NOT_COVERED: 'no fully configured scheme rate for this country (EU-27, Monaco, Norway)',
  ACCOUNT_NOT_IN_CHART: 'the account is not an active account of the cached chart',
  ACCOUNT_NAME_DIFFERS: 'the account has another name than the declaration states',
  CHART_NOT_CACHED: 'the chart of accounts is not cached, so no account can be confirmed live',
  ACCOUNT_SETTING_NOT_SET: 'the account setting is blank',
  ACCOUNT_SETTING_DIFFERS: 'the account setting is not the declared account',
  HOLD_SETTING_INVALID: 'a refund-hold setting is not a non-negative whole number',
  XERO_TYPE_ON_TWO_IMS_RATES: 'two different IMS rates carry one Xero type (the ruling is one IMS rate per Xero rate); the set-identity report reports it as DUPLICATE_MAPPING',
} as const
export type PreflightCode = keyof typeof PREFLIGHT_CODES
export type Severity = 'error' | 'advisory'
const ADVISORY: ReadonlySet<PreflightCode> = new Set<PreflightCode>(['IMS_NAME_DIFFERS'])

export type PreflightFinding = { severity: Severity; code: PreflightCode; /** The declared WooCommerce rate, or null for a finding about the whole configuration. */ wooId: number | null; subject: string; detail: string }

export type PreflightResult =
  | { status: 'refused'; seedVersion: string; reason: string }
  | { status: 'checked'; seedVersion: string; xeroListFetchedAt: string; ready: boolean; counts: { declaredRates: number; errors: number; advisories: number }; findings: PreflightFinding[] }

const normCategory = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim().toUpperCase())
const exactDec = (text: string | null): Dec | null => {
  if (text === null) return null
  try { const value = new Dec(text); return value.isFinite() ? value : null } catch { return null }
}
const xeroPercent = (row: NormalisedXeroTaxRate): Dec | null => exactDec(row.effectiveRate ?? row.displayTaxRate)
const isActiveSalesRate = (rate: PreflightImsRate): boolean => rate.active && (rate.usedFor === 'SALES' || rate.usedFor === 'BOTH') && !rate.reverseCharge
const sameName = (a: string, b: string): boolean => collapseName(a).toLowerCase() === collapseName(b).toLowerCase()

type Resolved = { rate: EuVatSeedRate; mapping: PreflightMapping | null; mappingMatches: boolean; ims: PreflightImsRate | null }

/** Every WooCommerce mapping to each IMS rate, as the store's rate ids (declared or not). */
function mappingsByImsRate(mappings: readonly PreflightMapping[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of mappings) out.set(m.taxRateId, [...(out.get(m.taxRateId) ?? []), m.externalTaxRateId])
  return out
}

/** The active components of a rate in order, as bound into the plan (rate as four-decimal text). */
function activeComponents(all: readonly TaxComponentRateRow[], rateId: string): Array<{ rate: string; compoundOnPrevious: boolean; sortOrder: number }> {
  return all.filter((c) => c.taxRateId === rateId && c.active).sort((a, b) => a.sortOrder - b.sortOrder).map((c) => ({ rate: new Dec(c.rate).toFixed(4), compoundOnPrevious: c.compoundOnPrevious, sortOrder: c.sortOrder }))
}

function resolveRates(input: PreflightInput): Resolved[] {
  const mappingBy = new Map(input.mappings.map((m) => [m.externalTaxRateId, m]))
  const imsBy = new Map(input.imsRates.map((r) => [r.id, r]))
  return input.seed.rates.map((rate) => {
    const mapping = mappingBy.get(String(rate.wooId)) ?? null
    const mappingMatches = mapping !== null
      && normaliseCountryCode(mapping.externalCountry ?? '') === normaliseCountryCode(rate.country)
      && (exactDec(mapping.externalRatePct)?.eq(new Dec(rate.ratePercent)) ?? false)
      && ((mapping.externalClass ?? '').trim().toLowerCase() || 'standard') === (rate.wooClass.trim().toLowerCase() || 'standard')
    return { rate, mapping, mappingMatches, ims: mapping === null ? null : imsBy.get(mapping.taxRateId) ?? null }
  })
}

/** PURE. Every finding the declaration, the IMS rows and the stored Xero list produce. */
export function evaluateEuVatPreflight(input: PreflightInput): PreflightResult {
  const seedVersion = input.seed.seedVersion
  if (!input.xero.proven) return { status: 'refused', seedVersion, reason: input.xero.reason }
  const xeroRows = input.xero.rows
  const activeXero = xeroRows.filter((row) => row.status === 'ACTIVE')
  const xeroByType = new Map(xeroRows.map((row) => [row.taxType, row]))
  const findings: PreflightFinding[] = []
  const add = (code: PreflightCode, wooId: number | null, subject: string, detail: string): void => { findings.push({ severity: ADVISORY.has(code) ? 'advisory' : 'error', code, wooId, subject, detail }) }

  const resolved = resolveRates(input)
  // EVERY WooCommerce mapping, declared or not, to each IMS rate: an undeclared mapping onto a declared rate is a sharer the check must see.
  const wooIdsByIms = mappingsByImsRate(input.mappings)
  const fullyConfigured = new Set<number>()
  const codeCarriers = new Map<string, Set<string>>()

  for (const { rate, mapping, mappingMatches, ims } of resolved) {
    const subject = `Woo ${rate.wooId} ${rate.country || '(no country)'} "${rate.wooName}" ${rate.ratePercent}%`
    const before = findings.length
    const err = (code: PreflightCode, detail: string): void => add(code, rate.wooId, subject, detail)
    if (mapping === null) { err('WOO_UNMAPPED', 'run the WooCommerce tax import and adoption first'); continue }
    if (input.storeIdentity === null) { err('STORE_NOT_IDENTIFIED', 'configure the WooCommerce store'); continue }
    if (mapping.storeIdentity === null) { err('MAPPING_UNSTAMPED', `mapping ${mapping.externalTaxRateId}`); continue }
    if (mapping.storeIdentity !== input.storeIdentity) { err('MAPPING_OTHER_STORE', `mapping ${mapping.externalTaxRateId} was made against ${mapping.storeIdentity}`); continue }
    if (!mappingMatches) { err('MAPPING_DIFFERS', `the mapping records "${mapping.externalName}", country "${mapping.externalCountry ?? ''}", ${mapping.externalRatePct}%, class "${mapping.externalClass ?? ''}"`); continue }
    if (ims === null) { err('IMS_RATE_MISSING', `mapping ${mapping.externalTaxRateId} names rate ${mapping.taxRateId}`); continue }
    const shared = wooIdsByIms.get(ims.id) ?? []
    const strangers = shared.filter((id) => input.seed.rates.find((x) => String(x.wooId) === id)?.imsName !== rate.imsName)
    if (strangers.length > 0) err('SHARED_IMS_ROW', `IMS rate "${ims.name}" also stands for Woo ${strangers.join(', ')}, which are not declared to be the same Xero rate (an undeclared mapping counts)`)
    if (!ims.active) err('IMS_RATE_INACTIVE', `"${ims.name}"`)
    else if (!isActiveSalesRate(ims)) err('IMS_RATE_NOT_SALES', `"${ims.name}" is used for ${ims.usedFor}${ims.reverseCharge ? ', reverse charge' : ''}`)
    // The percentage IMS computes tax at: the active components' effective rate when it has any, else the rate column (the set-identity report's own function).
    const imsPercent = effectiveImsPercent({ id: ims.id, rate: ims.rate } as TaxRateRow, input.componentRates)
    if (imsPercent === null || !imsPercent.eq(new Dec(rate.ratePercent))) err('IMS_PERCENT_DIFFERS', `IMS ${imsPercent === null ? 'unreadable' : imsPercent.toFixed()}%, declared ${rate.ratePercent}%`)
    if (rate.imsCountry !== null && normaliseCountryCode(ims.countryCode ?? '') !== normaliseCountryCode(rate.imsCountry)) err('IMS_COUNTRY_DIFFERS', `IMS "${ims.countryCode ?? ''}", declared "${rate.imsCountry}"`)
    if (!sameName(ims.name, rate.imsName)) err('IMS_NAME_DIFFERS', `IMS "${ims.name}", declared "${rate.imsName}"`)

    // The charged type.
    const code = ims.accountingTaxType === null ? '' : ims.accountingTaxType.trim()
    if (code === '') err('CHARGED_TYPE_MISSING', `"${ims.name}"`)
    else if (code.toUpperCase() === NO_VAT_TAX_TYPE) err('CHARGED_TYPE_NONE', `"${ims.name}" carries ${code}`)
    else {
      codeCarriers.set(code, new Set([...(codeCarriers.get(code) ?? []), ims.id]))
      const live = xeroByType.get(code)
      if (live === undefined || live.status !== 'ACTIVE') err('CHARGED_TYPE_NOT_IN_XERO', `${code} ${live === undefined ? 'is not in the list' : `is ${live.status}`}`)
      else {
        if (live.canApply.revenue !== true) err('XERO_NOT_SALES_TYPE', `${code} cannot be applied to revenue in Xero`)
        if (rate.accountingXeroName !== null && live.name !== rate.accountingXeroName) err('CHARGED_NAME_DIFFERS', `${code} is "${live.name}" in Xero, declared "${rate.accountingXeroName}"`)
        const livePercent = xeroPercent(live)
        if (livePercent === null || !livePercent.eq(new Dec(rate.ratePercent))) err('CHARGED_PERCENT_DIFFERS', `${code} is ${livePercent === null ? 'unstated' : livePercent.toFixed()}% in Xero, declared ${rate.ratePercent}%`)
      }
      if (rate.accountingTaxType !== null && code !== rate.accountingTaxType) err('CHARGED_TYPE_DIFFERS', `IMS carries ${code}, declared ${rate.accountingTaxType}`)
    }
    if (rate.accountingTaxType === null && rate.accountingXeroName !== null) {
      const byName = activeXero.filter((row) => row.name === rate.accountingXeroName)
      if (byName.length === 0) err('CHARGED_NAME_NOT_IN_XERO', `no ACTIVE Xero type is named "${rate.accountingXeroName}"`)
      else if (byName.length > 1) err('CHARGED_NAME_AMBIGUOUS', `${byName.map((row) => row.taxType).join(', ')} are all named "${rate.accountingXeroName}"`)
      else if (code !== '' && code !== byName[0]!.taxType) err('CHARGED_TYPE_DIFFERS', `IMS carries ${code}; the live type named "${rate.accountingXeroName}" is ${byName[0]!.taxType} (run npm run tax:rekey)`)
    }

    // The scheme posting type.
    const imsCategory = normCategory(ims.reportingCategory)
    const categoryOk = isSchemeRate(rate) ? imsCategory === rate.reportingCategory : imsCategory !== 'IOSS' && imsCategory !== 'VOEC'
    if ((ims.schemePostingTaxType ?? null) !== rate.schemePostingTaxType || !categoryOk) {
      err('SCHEME_FIELDS_DIFFER', `IMS: ${ims.schemePostingTaxType ?? 'null'} / ${ims.reportingCategory ?? 'null'}; declared: ${rate.schemePostingTaxType ?? 'null'} / ${rate.reportingCategory ?? '(not IOSS or VOEC)'}`)
    }
    if (rate.schemePostingTaxType !== null) {
      if (code !== '' && code === rate.schemePostingTaxType) err('SCHEME_ON_CHARGED_CODE', `"${ims.name}" carries ${code} as its charged code`)
      const live = xeroByType.get(rate.schemePostingTaxType)
      if (live === undefined || live.status !== 'ACTIVE') err('SCHEME_TYPE_NOT_IN_XERO', `${rate.schemePostingTaxType} ${live === undefined ? 'is not in the list' : `is ${live.status}`}`)
      else {
        if (live.canApply.revenue !== true) err('XERO_NOT_SALES_TYPE', `${rate.schemePostingTaxType} cannot be applied to revenue in Xero`)
        if (live.name !== rate.schemePostingXeroName) err('SCHEME_NAME_DIFFERS', `${rate.schemePostingTaxType} is "${live.name}" in Xero, declared "${rate.schemePostingXeroName ?? ''}"`)
        const livePercent = xeroPercent(live)
        if (livePercent === null || !livePercent.isZero()) err('SCHEME_NOT_ZERO', `${rate.schemePostingTaxType} is ${livePercent === null ? 'unstated' : `${livePercent.toFixed()}%`} in Xero`)
      }
    }
    if (findings.slice(before).every((f) => f.severity === 'advisory')) fullyConfigured.add(rate.wooId)
  }

  // A scheme posting type on an IMS rate no declared WooCommerce rate names.
  const declaredImsIds = new Set(resolved.flatMap((r) => (r.ims === null ? [] : [r.ims.id])))
  for (const ims of input.imsRates) {
    if (ims.schemePostingTaxType !== null && ims.active && !declaredImsIds.has(ims.id)) add('SCHEME_FIELD_ON_UNDECLARED_RATE', null, `IMS rate "${ims.name}"`, `carries ${ims.schemePostingTaxType}`)
  }

  // Every scheme country has at least one fully configured scheme rate.
  for (const country of SCHEME_COUNTRIES) {
    const ok = resolved.some((r) => isSchemeRate(r.rate) && normaliseCountryCode(r.rate.country) === country && fullyConfigured.has(r.rate.wooId))
    if (!ok) add('COUNTRY_NOT_COVERED', null, country, 'no scheme rate of this country is mapped, active and complete')
  }

  // Accounts and their settings.
  if (input.accounts.length === 0) add('CHART_NOT_CACHED', null, 'chart of accounts', 'sync the chart of accounts, then run this again')
  for (const account of input.seed.accounts) {
    const subject = `account ${account.code} (${account.role})`
    if (input.accounts.length > 0) {
      const found = input.accounts.find((a) => a.code === account.code)
      if (found === undefined) add('ACCOUNT_NOT_IN_CHART', null, subject, 'not an active account of the cached chart')
      else if (account.name !== null && found.name !== account.name) add('ACCOUNT_NAME_DIFFERS', null, subject, `"${found.name}" in the chart, declared "${account.name}"`)
    }
    if (account.settingKey !== null) {
      const value = (input.settings[account.settingKey] ?? '').trim()
      if (value === '') add('ACCOUNT_SETTING_NOT_SET', null, subject, `${account.settingKey} is blank`)
      else if (value !== account.code) add('ACCOUNT_SETTING_DIFFERS', null, subject, `${account.settingKey} is "${value}", declared "${account.code}"`)
    }
  }
  for (const key of [input.seed.refundHold.thresholdSettingKey, input.seed.refundHold.heldCountSettingKey]) {
    const parsed = parseCountSetting(input.settings[key])
    if (parsed.state === 'invalid') add('HOLD_SETTING_INVALID', null, key, `"${parsed.raw}"`)
  }

  // One IMS rate per Xero rate: a Xero type carried by two different IMS rates.
  // Counted over ALL active IMS sales rates, not only the declared ones: an undeclared rate on a declared Xero type is a second IMS rate on it.
  const salesByCode = new Map<string, PreflightImsRate[]>()
  for (const r of input.imsRates) {
    const carried = (r.accountingTaxType ?? '').trim()
    if (isActiveSalesRate(r) && carried !== '') salesByCode.set(carried, [...(salesByCode.get(carried) ?? []), r])
  }
  for (const code of codeCarriers.keys()) {
    const carriers = salesByCode.get(code) ?? []
    if (carriers.length > 1) {
      const undeclared = carriers.filter((r) => !declaredImsIds.has(r.id)).map((r) => `"${r.name}"`)
      const detail = `${carriers.length} IMS rates${undeclared.length > 0 ? `, undeclared: ${undeclared.join(', ')}` : ''}`
      add('XERO_TYPE_ON_TWO_IMS_RATES', null, `Xero type ${code}`, detail)
      // ALSO on every declared rate that carries the type, so the plan skips each of them (and the dry run lists them as skipped) rather than writing through a duplicated Xero type.
      for (const r of resolved) {
        if (r.ims !== null && (r.ims.accountingTaxType ?? '').trim() === code) add('XERO_TYPE_ON_TWO_IMS_RATES', r.rate.wooId, `Woo ${r.rate.wooId} ${r.rate.country || '(no country)'} "${r.rate.wooName}"`, detail)
      }
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length
  return { status: 'checked', seedVersion, xeroListFetchedAt: input.xero.proven ? input.xero.fetchedAt : '', ready: errors === 0, counts: { declaredRates: input.seed.rates.length, errors, advisories: findings.length - errors }, findings }
}

// ---------------------------------------------------------------------------
// Reading the snapshot (read only)
// ---------------------------------------------------------------------------

/** Read-only: the IMS rows and the WooCommerce mappings (all the apply needs). */
export async function readEuVatImsSide(client: Client): Promise<Pick<PreflightInput, 'imsRates' | 'mappings' | 'componentRates'>> {
  const [rates, mappings, components] = await Promise.all([
    client.taxRate.findMany({ select: { id: true, name: true, rate: true, usedFor: true, active: true, reverseCharge: true, countryCode: true, accountingTaxType: true, reportingCategory: true, schemePostingTaxType: true }, orderBy: { id: 'asc' } }),
    client.shoppingTaxRateMapping.findMany({ where: { connector: 'woocommerce' }, select: { id: true, externalTaxRateId: true, externalName: true, externalCountry: true, externalRatePct: true, externalClass: true, taxRateId: true, storeIdentity: true }, orderBy: { externalTaxRateId: 'asc' } }),
    client.taxRateComponent.findMany({ select: { taxRateId: true, rate: true, compoundOnPrevious: true, active: true, sortOrder: true }, orderBy: [{ taxRateId: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }] }),
  ])
  return {
    componentRates: components.map((c) => ({ ...c, rate: c.rate.toFixed() })),
    imsRates: rates.map((r) => ({ ...r, rate: r.rate.toFixed() })),
    mappings: mappings.map((m) => ({ ...m, externalRatePct: m.externalRatePct.toFixed() })),
  }
}

/** Read-only: the whole snapshot, with the proven stored Xero list. `connectedTenantId` is the organisation connected now (null = none). */
export async function readEuVatPreflightInput(client: Client, seed: EuVatSeed, now: Date, connectedTenantId: string | null, storeIdentity: string | null): Promise<PreflightInput> {
  const settingKeys = [...seed.accounts.flatMap((a) => (a.settingKey === null ? [] : [a.settingKey])), seed.refundHold.thresholdSettingKey, seed.refundHold.heldCountSettingKey]
  const [ims, accounts, settingRows, list] = await Promise.all([
    readEuVatImsSide(client),
    client.accountingAccount.findMany({ where: { connector: 'xero', active: true, code: { not: null } }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
    client.setting.findMany({ where: { key: { in: settingKeys } }, select: { key: true, value: true } }),
    readStoredXeroList(client, now, connectedTenantId),
  ])
  return {
    seed,
    storeIdentity,
    xero: list.ok ? { proven: true, fetchedAt: list.list.fetchedAt.toISOString(), rows: list.list.rows } : { proven: false, reason: `${list.refusal.code}: ${list.refusal.detail}` },
    ...ims,
    accounts: accounts.flatMap((a) => (a.code === null ? [] : [{ code: a.code, name: a.name }])),
    settings: Object.fromEntries(settingRows.map((s) => [s.key, s.value])),
  }
}

// ---------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------

export type SeedMappingFacts = { id: string; externalTaxRateId: string; externalCountry: string | null; externalRatePct: string; externalClass: string | null }
export type SeedChangeIdentity = {
  storeIdentity: string
  /** Every mapping that names the rate (several WooCommerce rates may share it), in id order, with the store-rate facts the declaration was matched on. */
  mappings: SeedMappingFacts[]
  /** The ids of EVERY mapping row that names the rate, declared or not, in id order: the apply row-locks this whole set and refuses if it has grown or shrunk. */
  allMappingIds: string[]
  name: string
  /** Fraction text, Decimal(5,4). */
  rate: string
  country: string | null
  usedFor: string
  charged: { code: string; xeroName: string; xeroPercent: string }
  scheme: { code: string; xeroName: string; xeroPercent: string } | null
  /** The ACTIVE tax components the percentage was computed from, in order: the apply re-reads and compares them under the row lock. */
  components: Array<{ rate: string; compoundOnPrevious: boolean; sortOrder: number }>
}
export type SeedChange = { taxRateId: string; imsName: string; wooId: number; identity: SeedChangeIdentity; from: { schemePostingTaxType: string | null; reportingCategory: string | null }; to: { schemePostingTaxType: string | null; reportingCategory: string | null } }
export type SeedSkip = { wooId: number; reason: PreflightCode | 'XERO_LIST_NOT_PROVEN'; detail: string }
export type SeedApplyPlan = { seedVersion: string; storeIdentity: string | null; changes: SeedChange[]; unchanged: number; skipped: SeedSkip[]; digest: string }

/**
 * PURE. The rows an apply would change. A declared rate enters the plan only if the preflight finds NOTHING wrong with it except the two fields the apply sets: its mapping is stamped for the
 * store configured now and records the declared store rate; the IMS rate is active, for sales, unshared, and has the declared country, percentage and name; its charged code is an ACTIVE Xero type of the
 * declared name and percentage; and the scheme type is an ACTIVE, zero-rated Xero type of the declared name. Every other declared rate is listed as skipped with the first reason. The digest binds the seed
 * version, the store identity and, for every change, the identity facts it was judged on (`identity`), so anything that moves between the dry run and the apply changes it. Without a proven Xero list nothing is planned.
 */
export function planEuVatSeedApply(input: PreflightInput): SeedApplyPlan {
  const resolved = resolveRates(input)
  const changes: SeedChange[] = []
  const skipped: SeedSkip[] = []
  let unchanged = 0
  const result = evaluateEuVatPreflight(input)
  if (result.status === 'refused') {
    for (const { rate } of resolved) skipped.push({ wooId: rate.wooId, reason: 'XERO_LIST_NOT_PROVEN', detail: result.reason })
  } else {
    const xeroByType = new Map((input.xero.proven ? input.xero.rows : []).map((row) => [row.taxType, row]))
    for (const { rate, mapping, ims } of resolved) {
      const blocking = result.findings.filter((f) => f.wooId === rate.wooId && (f.severity === 'error' || f.code === 'IMS_NAME_DIFFERS') && f.code !== 'SCHEME_FIELDS_DIFFER')
      if (blocking.length > 0) { skipped.push({ wooId: rate.wooId, reason: blocking[0]!.code, detail: blocking[0]!.detail }); continue }
      if (mapping === null || ims === null || input.storeIdentity === null) continue // unreachable: each of these is a blocking finding above
      const from = { schemePostingTaxType: ims.schemePostingTaxType, reportingCategory: ims.reportingCategory }
      // A rate that is not a scheme rate keeps whatever category it has (DOMESTIC, OSS, ...): the apply sets the marker only where the declaration has one, and never clears a category it did not set.
      const toCategory = rate.reportingCategory ?? (['IOSS', 'VOEC'].includes(normCategory(from.reportingCategory) ?? '') ? null : from.reportingCategory)
      const to = { schemePostingTaxType: rate.schemePostingTaxType, reportingCategory: toCategory }
      if (from.schemePostingTaxType === to.schemePostingTaxType && normCategory(from.reportingCategory) === normCategory(to.reportingCategory)) { unchanged += 1; continue }
      const fact = (code: string): { code: string; xeroName: string; xeroPercent: string } => {
        const live = xeroByType.get(code)
        return { code, xeroName: live?.name ?? '', xeroPercent: (live === undefined ? null : xeroPercent(live))?.toFixed() ?? '' }
      }
      const facts: SeedMappingFacts = { id: mapping.id, externalTaxRateId: mapping.externalTaxRateId, externalCountry: mapping.externalCountry, externalRatePct: new Dec(mapping.externalRatePct).toFixed(4), externalClass: mapping.externalClass }
      const existing = changes.find((c) => c.taxRateId === ims.id)
      if (existing !== undefined) { existing.identity.mappings.push(facts); existing.identity.mappings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); continue }
      const identity: SeedChangeIdentity = {
        storeIdentity: input.storeIdentity, mappings: [facts], allMappingIds: input.mappings.filter((m) => m.taxRateId === ims.id).map((m) => m.id).sort(), name: ims.name, rate: ims.rate, country: ims.countryCode, usedFor: ims.usedFor,
        components: activeComponents(input.componentRates, ims.id),
        charged: fact(ims.accountingTaxType ?? ''), scheme: rate.schemePostingTaxType === null ? null : fact(rate.schemePostingTaxType),
      }
      changes.push({ taxRateId: ims.id, imsName: ims.name, wooId: rate.wooId, identity, from, to })
    }
  }
  changes.sort((a, b) => (a.taxRateId < b.taxRateId ? -1 : a.taxRateId > b.taxRateId ? 1 : 0))
  const digest = createHash('sha256').update(JSON.stringify({ seedVersion: input.seed.seedVersion, store: input.storeIdentity, changes })).digest('hex')
  return { seedVersion: input.seed.seedVersion, storeIdentity: input.storeIdentity, changes, unchanged, skipped, digest }
}

export const EU_VAT_SEED_REFUSAL_CODES = ['CONFIRM_REQUIRED', 'XERO_LIST_NOT_PROVEN', 'XERO_CONNECTION_CHANGED', 'WOO_STORE_CHANGED', 'MAPPING_WRITERS_BUSY', 'DIGEST_MISMATCH', 'NOTHING_TO_APPLY', 'RATE_CHANGED_DURING_APPLY', 'RATE_REPLACED'] as const
export type EuVatSeedRefusalCode = (typeof EU_VAT_SEED_REFUSAL_CODES)[number]
export type EuVatSeedApplyResult =
  | { applied: false; plan: SeedApplyPlan; refusal: { code: EuVatSeedRefusalCode; detail: string } | null }
  | { applied: true; plan: SeedApplyPlan; written: number }

const DIGEST_RE = /^[0-9a-f]{64}$/

class SeedRaceError extends Error {}
class WooStoreChangedError extends Error {}
class MappingWritersBusyError extends Error {}

/**
 * The write. In ONE transaction: the plan is rebuilt from the rows as they are now (a different digest writes nothing), then each change is a compare-and-set on the two columns it read, under
 * the row lock every editor of a rate takes (lockTaxRateForEdit, which also refuses a rate a re-key replaced), in ascending id order. A row that moved since the plan rolls the whole apply back.
 * It writes IMS only: no Xero call, no WooCommerce call, no mapping, no rate creation, no account setting.
 */
/**
 * What the run must be told from outside the database: the Xero connection captured BEFORE the plan was read (null = none; its tenant is the organisation the stored list must belong to) and the
 * normalised URL of the WooCommerce store configured now (null = none).
 */
export type EuVatSeedContext = { connection: XeroConnectionStamp | null; storeIdentity: string | null; now?: Date }

/** Read-only: the plan, built from the full snapshot (IMS rows, mappings, the proven stored Xero list). The dry run is this. */
export async function readEuVatSeedPlan(client: Client, seed: EuVatSeed, ctx: EuVatSeedContext): Promise<SeedApplyPlan> {
  return planEuVatSeedApply(await readEuVatPreflightInput(client, seed, ctx.now ?? new Date(), ctx.connection?.tenantId ?? null, ctx.storeIdentity))
}

export async function applyEuVatSeed(db: { $transaction: <T>(fn: (tx: Client) => Promise<T>) => Promise<T> }, seed: EuVatSeed, confirm: string, ctx: EuVatSeedContext): Promise<EuVatSeedApplyResult> {
  const snapshot = (client: Client) => readEuVatSeedPlan(client, seed, ctx)
  if (!DIGEST_RE.test(confirm)) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'CONFIRM_REQUIRED', detail: 'an apply needs the exact 64-character digest of the plan the dry run printed' } }
  // Loaded when an apply runs, not when the module is: the fence module opens the application's database client.
  const { assertXeroConnectionUnchanged, XeroConnectionChangedError } = await import('@/lib/connectors/xero/connection-fence')
  // Settings reads and a URL normaliser: no request is made by any of these.
  const [{ WC_SYNC_ADVISORY_LOCK_KEY }, { WC_CREDENTIAL_SETTING_KEYS, resolveWcCredentialsFromRows }, { normaliseStoreIdentity }] = await Promise.all([
    import('@/lib/connectors/woocommerce/sync-lock'), import('@/lib/connectors/woocommerce/credentials'), import('@/lib/connectors/woocommerce/tax-rate-plan'),
  ])
  try {
    return await db.$transaction(async (tx): Promise<EuVatSeedApplyResult> => {
      // FIRST, before anything is read: the Xero mapping-selection lock, held to commit, and the connection must still be the one the stored list was read for. A rebind of the organisation
      // cannot interleave with this transaction, so the list the plan was judged against is the list of the organisation connected for the whole write.
      await assertXeroConnectionUnchanged(tx as never, ctx.connection)
      // The WooCommerce store: the lock a credential save takes (so a save waits for this commit), then the store configured NOW, read inside this transaction. A switch since the plan was made refuses.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_SYNC_ADVISORY_LOCK_KEY})`
      const credentialRows = await tx.setting.findMany({ where: { key: { in: [...WC_CREDENTIAL_SETTING_KEYS] } }, select: { key: true, value: true } })
      const credentials = resolveWcCredentialsFromRows(credentialRows)
      const storeNow = credentials === null ? null : normaliseStoreIdentity(credentials.url)
      if (storeNow !== ctx.storeIdentity) throw new WooStoreChangedError('the WooCommerce store configured now is not the one this plan was made for')
      // THE LOCK EVERY WRITER OF THE MAPPING TABLE TAKES (SHARED: lockStorefrontMappingWrites; the tax-rate writer's apply holds it EXCLUSIVE), taken EXCLUSIVE here and held to commit, BEFORE the mapping set is read: a
      // row lock on a rate does not stop a mapping from being inserted or re-pointed at it (that takes only a key-share), so this is what makes the set the plan rests on the set that is committed. Order: Xero
      // mapping-selection lock, WooCommerce credential lock, this one (the order the re-key and the credential save already follow). Tried, not waited for: a running tax-rate apply holds it for a whole network run.
      let gotWriteLock = false
      for (let attempt = 0; attempt < 10 && !gotWriteLock; attempt += 1) {
        gotWriteLock = (await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(${WOO_TAX_RATE_WRITE_LOCK_KEY}::bigint) AS ok`)[0]?.ok === true
        if (!gotWriteLock) await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (!gotWriteLock) throw new MappingWritersBusyError('a WooCommerce tax-rate apply or a mapping writer holds the mapping write lock, so nothing was written')
      const plan = await snapshot(tx)
      if (plan.skipped.some((s) => s.reason === 'XERO_LIST_NOT_PROVEN')) return { applied: false, plan, refusal: { code: 'XERO_LIST_NOT_PROVEN', detail: plan.skipped[0]!.detail } }
      if (plan.digest !== confirm) return { applied: false, plan, refusal: { code: 'DIGEST_MISMATCH', detail: 'the plan changed since the dry run (or this is not its digest); run the dry run again' } }
      if (plan.changes.length === 0) return { applied: false, plan, refusal: { code: 'NOTHING_TO_APPLY', detail: 'every declared rate that can be set already is' } }
      // The rate rows, in ascending id (the order every editor and the re-key use), then the mapping rows that named them.
      for (const change of plan.changes) await lockTaxRateForEdit(tx, change.taxRateId, { schemePostingTaxType: change.to.schemePostingTaxType, reportingCategory: change.to.reportingCategory })
      const wanted = plan.changes.flatMap((c) => c.identity.mappings.map((m) => ({ change: c, facts: m }))).sort((a, b) => (a.facts.id < b.facts.id ? -1 : a.facts.id > b.facts.id ? 1 : 0))
      // Row-locked (FOR SHARE: a writer of a mapping row waits for this commit) and compared on every declared field, so a mapping edited, re-pointed, re-stamped or deleted (a row that is gone is not found below) since the plan was read rolls the whole apply back.
      const completeIds = [...new Set(plan.changes.flatMap((c) => c.identity.allMappingIds))].sort()
      await tx.$queryRaw`SELECT id FROM shopping_tax_rate_mappings WHERE id = ANY(${[...new Set([...wanted.map((w) => w.facts.id), ...completeIds])].sort()}::text[]) ORDER BY id FOR SHARE`
      // The COMPLETE mapping set of every rate the plan writes (declared or not): a mapping that arrived or left since the plan was read, or that is not a declared sharer, rolls the apply back.
      const current = await tx.shoppingTaxRateMapping.findMany({ where: { connector: 'woocommerce', taxRateId: { in: plan.changes.map((c) => c.taxRateId) } }, select: { id: true, taxRateId: true } })
      for (const change of plan.changes) {
        const now = current.filter((m) => m.taxRateId === change.taxRateId).map((m) => m.id).sort()
        if (now.length !== change.identity.allMappingIds.length || now.some((id, i) => id !== change.identity.allMappingIds[i])) throw new SeedRaceError(`the set of mappings that name tax rate ${change.taxRateId} changed since the plan was read`)
      }
      const rows = new Map((await tx.shoppingTaxRateMapping.findMany({ where: { id: { in: wanted.map((w) => w.facts.id) } } })).map((r) => [r.id, r]))
      for (const { change, facts } of wanted) {
        const row = rows.get(facts.id)
        const same = row !== undefined && row.connector === 'woocommerce' && row.externalTaxRateId === facts.externalTaxRateId && row.taxRateId === change.taxRateId && row.storeIdentity === change.identity.storeIdentity
          && (row.externalCountry ?? null) === facts.externalCountry && row.externalRatePct.toFixed(4) === facts.externalRatePct && (row.externalClass ?? null) === facts.externalClass
        if (!same) throw new SeedRaceError(`the mapping of Woo rate ${facts.externalTaxRateId} changed since the plan was read`)
      }
      // The components the percentage was computed from, compared with the plan's in order. The rate rows are locked above, and the one editor of a rate's components (the settings action) takes that same row lock first.
      const components = await tx.taxRateComponent.findMany({ where: { taxRateId: { in: plan.changes.map((c) => c.taxRateId) } }, select: { taxRateId: true, rate: true, compoundOnPrevious: true, active: true, sortOrder: true } })
      for (const change of plan.changes) {
        const now = activeComponents(components.map((c) => ({ ...c, rate: c.rate.toFixed() })), change.taxRateId)
        if (JSON.stringify(now) !== JSON.stringify(change.identity.components)) throw new SeedRaceError(`the tax components of tax rate ${change.taxRateId} changed since the plan was read`)
      }
      for (const change of plan.changes) {
        // Under the row lock: the row must STILL be what the plan judged (identity, charged code, flags) and what it will change from, or the whole apply rolls back.
        const id = change.identity
        const done = await tx.taxRate.updateMany({
          where: {
            id: change.taxRateId, active: true, reverseCharge: false, name: id.name, rate: new Prisma.Decimal(id.rate), countryCode: id.country, usedFor: id.usedFor, accountingTaxType: id.charged.code,
            schemePostingTaxType: change.from.schemePostingTaxType, reportingCategory: change.from.reportingCategory,
          },
          data: { schemePostingTaxType: change.to.schemePostingTaxType, reportingCategory: change.to.reportingCategory },
        })
        if (done.count !== 1) throw new SeedRaceError(`tax rate ${change.taxRateId} changed since the plan was read`)
      }
      return { applied: true, plan, written: plan.changes.length }
    })
  } catch (error) {
    if (error instanceof MappingWritersBusyError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'MAPPING_WRITERS_BUSY', detail: error.message } }
    if (error instanceof WooStoreChangedError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'WOO_STORE_CHANGED', detail: error.message } }
    if (error instanceof XeroConnectionChangedError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'XERO_CONNECTION_CHANGED', detail: error.message } }
    if (error instanceof SeedRaceError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'RATE_CHANGED_DURING_APPLY', detail: error.message } }
    if (error instanceof TaxRateReplacedError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'RATE_REPLACED', detail: error.message } }
    throw error
  }
}
