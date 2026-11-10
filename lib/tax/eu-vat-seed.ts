/**
 * THE EU IOSS / VOEC RATE CONFIGURATION, AS A DECLARATION (lib/tax/eu-vat-seed.json), AND WHAT IT MEANS. Pure: no database, no network, no clock, no write.
 *
 * The file declares, for each of the live WooCommerce tax rates, the IMS rate that stands for it and the Xero tax types it posts on:
 *   - `accountingTaxType`: the CHARGED rate's Xero code (DE VAT 19%). null = resolved by name from the stored Xero list at setup, never declared (Xero numbers custom codes per organisation);
 *   - `schemePostingTaxType`: for a rate sold under IOSS or VOEC, the destination's ZERO-RATED Xero type its goods, shipping and discount lines post on (TAX131), byte-exact name beside it;
 *   - `reportingCategory`: IOSS or VOEC on those rates (the marker lib/tax/vat-scheme.ts already accepts), null elsewhere.
 * Nothing here posts anything: no document builder reads the file or the column it fills, and nothing writes a tax rate to Xero.
 *
 * ONE IMS RATE PER XERO RATE (owner ruling Q2, option A): WooCommerce rates that post on the same Xero type share one IMS rate (the 33 on ZERORATEDOUTPUT), as in Xero. Rates that share one carry the
 * same `imsName` and are declared identically; the set-identity report (R13) accepts exactly that sharing (it reads this declaration) and still refuses sharing where the types differ.
 */
import seedFile from './eu-vat-seed.json'

export const EU_VAT_SEED_SCHEMA_VERSION = 1
export const SCHEME_CATEGORIES = ['IOSS', 'VOEC'] as const
export type SchemeCategory = (typeof SCHEME_CATEGORIES)[number]

export type EuVatSeedRate = {
  wooId: number
  country: string
  /** Percent with four decimals, as WooCommerce states it ("19.0000"). */
  ratePercent: string
  wooName: string
  wooClass: string
  /** The IMS rate's name: the WooCommerce label, prefixed with the country where the label alone would repeat. */
  imsName: string
  /** The IMS rate's country: the Woo country, or null on an IMS rate shared by several WooCommerce rates (it spans countries). */
  imsCountry: string | null
  taxCategory: 'STANDARD' | 'ZERO'
  accountingTaxType: string | null
  /** The charged type's Xero name, byte-exact (for a rate posting on a built-in type, the name Xeroom's association gives it). */
  accountingXeroName: string | null
  reportingCategory: SchemeCategory | null
  schemePostingTaxType: string | null
  /** Byte-exact: 'AT IOSS  VAT' has two spaces. */
  schemePostingXeroName: string | null
}

export type EuVatSeedAccount = { role: string; settingKey: string | null; code: string; name: string | null }

export type EuVatSeed = {
  schemaVersion: number
  seedVersion: string
  accounts: EuVatSeedAccount[]
  refundHold: { thresholdSettingKey: string; heldCountSettingKey: string; defaultThreshold: number }
  rates: EuVatSeedRate[]
}

export type SeedProblem = { code: string; detail: string }

/** The tax types a scheme rate's own posting must never be (it posts on the zero-rated type) and a plain rate's may be. */
export const NO_VAT_TAX_TYPE = 'NONE'

const TAX_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Structural validation of a seed. Returns every problem; an empty list means the declaration is internally consistent. */
export function validateEuVatSeed(seed: EuVatSeed): SeedProblem[] {
  const problems: SeedProblem[] = []
  const add = (code: string, detail: string): void => { problems.push({ code, detail }) }
  if (seed.schemaVersion !== EU_VAT_SEED_SCHEMA_VERSION) add('SCHEMA_VERSION', `schemaVersion ${String(seed.schemaVersion)} is not ${EU_VAT_SEED_SCHEMA_VERSION}`)
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(seed.seedVersion)) add('SEED_VERSION', `seedVersion "${seed.seedVersion}" is not YYYY-MM-DD.n`)
  const ids = new Set<number>()
  const imsNames = new Map<string, EuVatSeedRate>()
  for (const rate of seed.rates) {
    const where = `Woo rate ${rate.wooId}`
    if (!Number.isInteger(rate.wooId) || rate.wooId <= 0) add('WOO_ID', `${where}: not a positive integer`)
    if (ids.has(rate.wooId)) add('DUPLICATE_WOO_ID', `${where}: declared twice`)
    ids.add(rate.wooId)
    const sharer = imsNames.get(rate.imsName)
    if (sharer !== undefined) {
      // Sharing one IMS rate is allowed only for rates declared to be the same Xero rate in every respect.
      const same = (['accountingTaxType', 'accountingXeroName', 'schemePostingTaxType', 'schemePostingXeroName', 'reportingCategory', 'taxCategory', 'imsCountry', 'ratePercent'] as const).filter((f) => sharer[f] !== rate[f])
      if (same.length > 0) add('SHARED_IMS_NAME_DIFFERS', `${where}: shares the IMS rate "${rate.imsName}" with Woo ${sharer.wooId} but differs in ${same.join(', ')}`)
      if (rate.accountingTaxType === null) add('SHARED_WITHOUT_CODE', `${where}: a shared IMS rate declares the Xero type it stands for`)
      if (rate.imsCountry !== null) add('SHARED_WITH_COUNTRY', `${where}: a shared IMS rate spans countries, so its imsCountry is null`)
    } else imsNames.set(rate.imsName, rate)
    if (rate.imsCountry !== null && rate.imsCountry !== rate.country) add('IMS_COUNTRY', `${where}: imsCountry "${rate.imsCountry}" is neither null nor the country`)
    if (!/^\d{1,3}\.\d{4}$/.test(rate.ratePercent)) add('RATE_PERCENT', `${where}: ratePercent "${rate.ratePercent}" is not a percentage with four decimals`)
    for (const [field, value] of [['accountingTaxType', rate.accountingTaxType], ['schemePostingTaxType', rate.schemePostingTaxType]] as const) {
      if (value !== null && !TAX_TYPE_RE.test(value)) add('TAX_TYPE_SHAPE', `${where}: ${field} "${value}" is not a Xero tax type`)
    }
    const scheme = rate.reportingCategory !== null
    if (scheme !== (rate.schemePostingTaxType !== null)) add('SCHEME_PAIR', `${where}: reportingCategory and schemePostingTaxType are both set or both null`)
    if (rate.reportingCategory !== null && !(SCHEME_CATEGORIES as readonly string[]).includes(rate.reportingCategory)) add('SCHEME_CATEGORY', `${where}: reportingCategory "${String(rate.reportingCategory)}" is not IOSS or VOEC`)
    if (scheme && rate.schemePostingXeroName === null) add('SCHEME_NAME', `${where}: a scheme rate names its zero-rated type`)
    if (scheme && rate.schemePostingTaxType === rate.accountingTaxType) add('SCHEME_ON_CHARGED_CODE', `${where}: the scheme posting type is the charged code`)
    if (scheme && Number(rate.ratePercent) === 0) add('SCHEME_ZERO_CHARGED', `${where}: a scheme rate charges VAT`)
    if (!scheme && rate.schemePostingXeroName !== null) add('SCHEME_NAME_WITHOUT_SCHEME', `${where}: a name for a scheme type on a rate that is not a scheme rate`)
    if ((rate.accountingTaxType ?? '').toUpperCase() === NO_VAT_TAX_TYPE || (rate.schemePostingTaxType ?? '').toUpperCase() === NO_VAT_TAX_TYPE) add('NONE', `${where}: a rate never posts on NONE`)
  }
  if (!Number.isInteger(seed.refundHold.defaultThreshold) || seed.refundHold.defaultThreshold < 0) add('REFUND_HOLD_DEFAULT', 'refundHold.defaultThreshold is not a non-negative integer')
  const roles = new Set<string>()
  for (const account of seed.accounts) {
    if (roles.has(account.role)) add('DUPLICATE_ACCOUNT_ROLE', `account role ${account.role} is declared twice`)
    roles.add(account.role)
    if (!/^[A-Za-z0-9.-]{1,10}$/.test(account.code)) add('ACCOUNT_CODE', `account ${account.role}: "${account.code}" is not an account code`)
  }
  return problems
}

/** The declaration, validated at load: a seed that contradicts itself is a programming error, not an operator's problem. */
export function loadEuVatSeed(): EuVatSeed {
  const seed = seedFile as unknown as EuVatSeed
  const problems = validateEuVatSeed(seed)
  if (problems.length > 0) throw new Error(`lib/tax/eu-vat-seed.json is inconsistent: ${problems.map((p) => `${p.code} (${p.detail})`).join('; ')}`)
  return seed
}

/** What a line of this rate posts on when the sale is under its scheme: the zero-rated type; for any other rate, its own type (null where the live code is resolved by name). */
export function seedPostingTaxType(rate: EuVatSeedRate): string | null {
  return rate.schemePostingTaxType ?? rate.accountingTaxType
}

export function isSchemeRate(rate: Pick<EuVatSeedRate, 'schemePostingTaxType'>): boolean {
  return rate.schemePostingTaxType !== null
}

/** The declared WooCommerce rates that share this rate's IMS rate (itself included); one element for a rate that stands alone. */
export function seedSharers(seed: Pick<EuVatSeed, 'rates'>, rate: Pick<EuVatSeedRate, 'imsName'>): EuVatSeedRate[] {
  return seed.rates.filter((r) => r.imsName === rate.imsName)
}
