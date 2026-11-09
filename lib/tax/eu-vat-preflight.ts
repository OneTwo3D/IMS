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
 * ONE IMS RATE PER WOOCOMMERCE RATE (owner ruling): an IMS rate named by two declared WooCommerce rates is an ERROR (SHARED_IMS_ROW). The set-identity report (R13) is not changed and not exempted:
 * where the declaration has several IMS rates on ONE Xero type (all the zero-rated rows are ZERORATEDOUTPUT, as in Xeroom) it will keep reporting that, and the preflight lists those as ADVISORY so
 * nobody is surprised by it.
 *
 * SEVERITY. `error` blocks readiness; `advisory` is listed and does not.
 */
import { createHash } from 'node:crypto'
import { Prisma } from '@/app/generated/prisma/client'
import { EU_ISO_CODES, VOEC_ISO_CODES } from '@/lib/connectors/xero/tax-rate-report-type'
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
export type PreflightMapping = { externalTaxRateId: string; externalName: string; externalCountry: string | null; externalRatePct: string; externalClass: string | null; taxRateId: string }
export type PreflightAccount = { code: string; name: string }
export type PreflightXero = { proven: true; fetchedAt: string; rows: readonly NormalisedXeroTaxRate[] } | { proven: false; reason: string }
export type PreflightInput = {
  seed: EuVatSeed
  xero: PreflightXero
  imsRates: readonly PreflightImsRate[]
  mappings: readonly PreflightMapping[]
  /** The cached chart of accounts, active accounts with a code. */
  accounts: readonly PreflightAccount[]
  /** Raw stored values of the settings the preflight reads (absent = no row). */
  settings: Readonly<Record<string, string | null | undefined>>
}

export const PREFLIGHT_CODES = {
  WOO_UNMAPPED: 'no storefront mapping names an IMS rate for this WooCommerce rate',
  MAPPING_DIFFERS: 'the mapping records a store rate with another country, percentage or class than the declaration: it was made against another store, so nothing is read or written through it',
  IMS_RATE_MISSING: 'the mapping names an IMS rate that does not exist',
  IMS_RATE_INACTIVE: 'the IMS rate is inactive',
  IMS_RATE_NOT_SALES: 'the IMS rate is purchase-only or a reverse-charge rate',
  SHARED_IMS_ROW: 'one IMS rate stands for more than one declared WooCommerce rate (the ruling is one IMS rate per WooCommerce rate)',
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
  XERO_TYPE_SHARED_BY_RATES: 'several IMS rates post on one Xero type, so the set-identity report (R13) reports them as DUPLICATE_MAPPING; it is not exempted (owner ruling), so this stays until Xero has a type each',
} as const
export type PreflightCode = keyof typeof PREFLIGHT_CODES
export type Severity = 'error' | 'advisory'
const ADVISORY: ReadonlySet<PreflightCode> = new Set<PreflightCode>(['IMS_NAME_DIFFERS', 'XERO_TYPE_SHARED_BY_RATES'])

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
  const wooIdsByIms = new Map<string, number[]>()
  for (const r of resolved) if (r.ims !== null) wooIdsByIms.set(r.ims.id, [...(wooIdsByIms.get(r.ims.id) ?? []), r.rate.wooId])
  const fullyConfigured = new Set<number>()
  const codeCarriers = new Map<string, number[]>()

  for (const { rate, mapping, mappingMatches, ims } of resolved) {
    const subject = `Woo ${rate.wooId} ${rate.country || '(no country)'} "${rate.wooName}" ${rate.ratePercent}%`
    const before = findings.length
    const err = (code: PreflightCode, detail: string): void => add(code, rate.wooId, subject, detail)
    if (mapping === null) { err('WOO_UNMAPPED', 'run the WooCommerce tax import and adoption first'); continue }
    if (!mappingMatches) { err('MAPPING_DIFFERS', `the mapping records "${mapping.externalName}", country "${mapping.externalCountry ?? ''}", ${mapping.externalRatePct}%, class "${mapping.externalClass ?? ''}"`); continue }
    if (ims === null) { err('IMS_RATE_MISSING', `mapping ${mapping.externalTaxRateId} names rate ${mapping.taxRateId}`); continue }
    const shared = wooIdsByIms.get(ims.id) ?? []
    if (shared.length > 1) err('SHARED_IMS_ROW', `IMS rate "${ims.name}" also stands for Woo ${shared.filter((id) => id !== rate.wooId).join(', ')}`)
    if (!ims.active) err('IMS_RATE_INACTIVE', `"${ims.name}"`)
    else if (!isActiveSalesRate(ims)) err('IMS_RATE_NOT_SALES', `"${ims.name}" is used for ${ims.usedFor}${ims.reverseCharge ? ', reverse charge' : ''}`)
    const imsPercent = exactDec(ims.rate)?.mul(100) ?? null
    if (imsPercent === null || !imsPercent.eq(new Dec(rate.ratePercent))) err('IMS_PERCENT_DIFFERS', `IMS ${imsPercent === null ? 'unreadable' : imsPercent.toFixed()}%, declared ${rate.ratePercent}%`)
    if (normaliseCountryCode(ims.countryCode ?? '') !== normaliseCountryCode(rate.country)) err('IMS_COUNTRY_DIFFERS', `IMS "${ims.countryCode ?? ''}", declared "${rate.country}"`)
    if (!sameName(ims.name, rate.imsName)) err('IMS_NAME_DIFFERS', `IMS "${ims.name}", declared "${rate.imsName}"`)

    // The charged type.
    const code = ims.accountingTaxType === null ? '' : ims.accountingTaxType.trim()
    if (code === '') err('CHARGED_TYPE_MISSING', `"${ims.name}"`)
    else if (code.toUpperCase() === NO_VAT_TAX_TYPE) err('CHARGED_TYPE_NONE', `"${ims.name}" carries ${code}`)
    else {
      codeCarriers.set(code, [...(codeCarriers.get(code) ?? []), rate.wooId])
      const live = xeroByType.get(code)
      if (live === undefined || live.status !== 'ACTIVE') err('CHARGED_TYPE_NOT_IN_XERO', `${code} ${live === undefined ? 'is not in the list' : `is ${live.status}`}`)
      else {
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

  // R13 consequence, stated rather than hidden: several declared rates on one Xero type.
  for (const [code, woo] of codeCarriers) {
    if (woo.length > 1) add('XERO_TYPE_SHARED_BY_RATES', null, `Xero type ${code}`, `${woo.length} rates (Woo ${woo.join(', ')})`)
  }

  const errors = findings.filter((f) => f.severity === 'error').length
  return { status: 'checked', seedVersion, xeroListFetchedAt: input.xero.proven ? input.xero.fetchedAt : '', ready: errors === 0, counts: { declaredRates: input.seed.rates.length, errors, advisories: findings.length - errors }, findings }
}

// ---------------------------------------------------------------------------
// Reading the snapshot (read only)
// ---------------------------------------------------------------------------

/** Read-only: the IMS rows and the WooCommerce mappings (all the apply needs). */
export async function readEuVatImsSide(client: Client): Promise<Pick<PreflightInput, 'imsRates' | 'mappings'>> {
  const [rates, mappings] = await Promise.all([
    client.taxRate.findMany({ select: { id: true, name: true, rate: true, usedFor: true, active: true, reverseCharge: true, countryCode: true, accountingTaxType: true, reportingCategory: true, schemePostingTaxType: true }, orderBy: { id: 'asc' } }),
    client.shoppingTaxRateMapping.findMany({ where: { connector: 'woocommerce' }, select: { externalTaxRateId: true, externalName: true, externalCountry: true, externalRatePct: true, externalClass: true, taxRateId: true }, orderBy: { externalTaxRateId: 'asc' } }),
  ])
  return {
    imsRates: rates.map((r) => ({ ...r, rate: r.rate.toFixed() })),
    mappings: mappings.map((m) => ({ ...m, externalRatePct: m.externalRatePct.toFixed() })),
  }
}

/** Read-only: the whole snapshot, with the proven stored Xero list. `connectedTenantId` is the organisation connected now (null = none). */
export async function readEuVatPreflightInput(client: Client, seed: EuVatSeed, now: Date, connectedTenantId: string | null): Promise<PreflightInput> {
  const settingKeys = [...seed.accounts.flatMap((a) => (a.settingKey === null ? [] : [a.settingKey])), seed.refundHold.thresholdSettingKey, seed.refundHold.heldCountSettingKey]
  const [ims, accounts, settingRows, list] = await Promise.all([
    readEuVatImsSide(client),
    client.accountingAccount.findMany({ where: { connector: 'xero', active: true, code: { not: null } }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
    client.setting.findMany({ where: { key: { in: settingKeys } }, select: { key: true, value: true } }),
    readStoredXeroList(client, now, connectedTenantId),
  ])
  return {
    seed,
    xero: list.ok ? { proven: true, fetchedAt: list.list.fetchedAt.toISOString(), rows: list.list.rows } : { proven: false, reason: `${list.refusal.code}: ${list.refusal.detail}` },
    ...ims,
    accounts: accounts.flatMap((a) => (a.code === null ? [] : [{ code: a.code, name: a.name }])),
    settings: Object.fromEntries(settingRows.map((s) => [s.key, s.value])),
  }
}

// ---------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------

export type SeedChange = { taxRateId: string; imsName: string; wooId: number; from: { schemePostingTaxType: string | null; reportingCategory: string | null }; to: { schemePostingTaxType: string | null; reportingCategory: string | null } }
export type SeedSkip = { wooId: number; reason: 'WOO_UNMAPPED' | 'MAPPING_DIFFERS' | 'IMS_RATE_MISSING' | 'IMS_RATE_INACTIVE' | 'IMS_RATE_NOT_SALES' | 'SHARED_IMS_ROW'; detail: string }
export type SeedApplyPlan = { seedVersion: string; changes: SeedChange[]; unchanged: number; skipped: SeedSkip[]; digest: string }

/**
 * PURE. The rows an apply would change. Only a rate a mapping of the declared store rate names, that is active and for sales, and that no second declared rate shares, is touched; every other
 * declared rate is listed as skipped with the reason (the preflight says the same in its own words). The digest binds the seed version and every change.
 */
export function planEuVatSeedApply(input: Pick<PreflightInput, 'seed' | 'imsRates' | 'mappings'>): SeedApplyPlan {
  const resolved = resolveRates({ ...input, xero: { proven: false, reason: '' }, accounts: [], settings: {} })
  const wooIdsByIms = new Map<string, number[]>()
  for (const r of resolved) if (r.ims !== null) wooIdsByIms.set(r.ims.id, [...(wooIdsByIms.get(r.ims.id) ?? []), r.rate.wooId])
  const changes: SeedChange[] = []
  const skipped: SeedSkip[] = []
  let unchanged = 0
  for (const { rate, mapping, mappingMatches, ims } of resolved) {
    const skip = (reason: SeedSkip['reason'], detail: string): void => { skipped.push({ wooId: rate.wooId, reason, detail }) }
    if (mapping === null) { skip('WOO_UNMAPPED', 'no mapping'); continue }
    if (!mappingMatches) { skip('MAPPING_DIFFERS', 'the mapping records another store rate'); continue }
    if (ims === null) { skip('IMS_RATE_MISSING', mapping.taxRateId); continue }
    if (!ims.active) { skip('IMS_RATE_INACTIVE', ims.name); continue }
    if (!isActiveSalesRate(ims)) { skip('IMS_RATE_NOT_SALES', ims.name); continue }
    if ((wooIdsByIms.get(ims.id) ?? []).length > 1) { skip('SHARED_IMS_ROW', ims.name); continue }
    const from = { schemePostingTaxType: ims.schemePostingTaxType, reportingCategory: ims.reportingCategory }
    // A rate that is not a scheme rate keeps whatever category it has (DOMESTIC, OSS, ...): the apply sets the marker only where the declaration has one, and never clears a category it did not set.
    const toCategory = rate.reportingCategory ?? (['IOSS', 'VOEC'].includes(normCategory(from.reportingCategory) ?? '') ? null : from.reportingCategory)
    const to = { schemePostingTaxType: rate.schemePostingTaxType, reportingCategory: toCategory }
    if (from.schemePostingTaxType === to.schemePostingTaxType && normCategory(from.reportingCategory) === normCategory(to.reportingCategory)) { unchanged += 1; continue }
    changes.push({ taxRateId: ims.id, imsName: ims.name, wooId: rate.wooId, from, to })
  }
  changes.sort((a, b) => (a.taxRateId < b.taxRateId ? -1 : a.taxRateId > b.taxRateId ? 1 : 0))
  const digest = createHash('sha256').update(JSON.stringify({ seedVersion: input.seed.seedVersion, changes })).digest('hex')
  return { seedVersion: input.seed.seedVersion, changes, unchanged, skipped, digest }
}

export const EU_VAT_SEED_REFUSAL_CODES = ['CONFIRM_REQUIRED', 'DIGEST_MISMATCH', 'NOTHING_TO_APPLY', 'RATE_CHANGED_DURING_APPLY', 'RATE_REPLACED'] as const
export type EuVatSeedRefusalCode = (typeof EU_VAT_SEED_REFUSAL_CODES)[number]
export type EuVatSeedApplyResult =
  | { applied: false; plan: SeedApplyPlan; refusal: { code: EuVatSeedRefusalCode; detail: string } | null }
  | { applied: true; plan: SeedApplyPlan; written: number }

const DIGEST_RE = /^[0-9a-f]{64}$/

class SeedRaceError extends Error {}

/**
 * The write. In ONE transaction: the plan is rebuilt from the rows as they are now (a different digest writes nothing), then each change is a compare-and-set on the two columns it read, under
 * the row lock every editor of a rate takes (lockTaxRateForEdit, which also refuses a rate a re-key replaced), in ascending id order. A row that moved since the plan rolls the whole apply back.
 * It writes IMS only: no Xero call, no WooCommerce call, no mapping, no rate creation, no account setting.
 */
export async function applyEuVatSeed(db: { $transaction: <T>(fn: (tx: Client) => Promise<T>) => Promise<T> }, seed: EuVatSeed, confirm: string): Promise<EuVatSeedApplyResult> {
  const snapshot = async (client: Client) => {
    return planEuVatSeedApply({ seed, ...(await readEuVatImsSide(client)) })
  }
  if (!DIGEST_RE.test(confirm)) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'CONFIRM_REQUIRED', detail: 'an apply needs the exact 64-character digest of the plan the dry run printed' } }
  try {
    return await db.$transaction(async (tx): Promise<EuVatSeedApplyResult> => {
      const plan = await snapshot(tx)
      if (plan.digest !== confirm) return { applied: false, plan, refusal: { code: 'DIGEST_MISMATCH', detail: 'the plan changed since the dry run (or this is not its digest); run the dry run again' } }
      if (plan.changes.length === 0) return { applied: false, plan, refusal: { code: 'NOTHING_TO_APPLY', detail: 'every declared rate that can be set already is' } }
      for (const change of plan.changes) {
        await lockTaxRateForEdit(tx, change.taxRateId, { schemePostingTaxType: change.to.schemePostingTaxType, reportingCategory: change.to.reportingCategory })
        const done = await tx.taxRate.updateMany({
          where: { id: change.taxRateId, active: true, schemePostingTaxType: change.from.schemePostingTaxType, reportingCategory: change.from.reportingCategory },
          data: { schemePostingTaxType: change.to.schemePostingTaxType, reportingCategory: change.to.reportingCategory },
        })
        if (done.count !== 1) throw new SeedRaceError(`tax rate ${change.taxRateId} changed since the plan was read`)
      }
      return { applied: true, plan, written: plan.changes.length }
    })
  } catch (error) {
    if (error instanceof SeedRaceError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'RATE_CHANGED_DURING_APPLY', detail: error.message } }
    if (error instanceof TaxRateReplacedError) return { applied: false, plan: await db.$transaction((tx) => snapshot(tx)), refusal: { code: 'RATE_REPLACED', detail: error.message } }
    throw error
  }
}
