/**
 * A SYNTHETIC "EVERYTHING IS AS DECLARED" WORLD, built from the declaration (lib/tax/eu-vat-seed.json): one IMS rate and one mapping per declared WooCommerce rate, a Xero list that holds every
 * type the declaration names, the chart accounts and the settings. The preflight must find nothing wrong with it (apart from the advisories about shared Xero types); each preflight test then
 * breaks one thing. The charged live code of a rate whose code the declaration leaves open (null) is a made-up one, as a re-key would have set it.
 */
import type { NormalisedXeroTaxRate } from '@/lib/connectors/xero/tax-rate-list'
import type { PreflightImsRate, PreflightInput, PreflightMapping } from '@/lib/tax/eu-vat-preflight'
import { loadEuVatSeed, type EuVatSeed } from '@/lib/tax/eu-vat-seed'

const six = (percent: string): string => Number(percent).toFixed(6)

export function xeroType(taxType: string, name: string, percent: string, status: NormalisedXeroTaxRate['status'] = 'ACTIVE'): NormalisedXeroTaxRate {
  return { taxType, name, status, reportTaxType: 'OUTPUT', effectiveRate: six(percent), displayTaxRate: six(percent), components: [{ name, rate: six(percent), compound: false, nonRecoverable: false }], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } }
}

export const STORE = 'https://shop.example'
export const syntheticChargedCode = (wooId: number): string => `TAXC${wooId}`

export type World = { input: PreflightInput; ims: Map<number, PreflightImsRate>; mappings: Map<number, PreflightMapping>; xero: Map<string, NormalisedXeroTaxRate> }

/** One entry per IMS rate: the members of a shared rate map to the same id, and the first entry of the id (its group's first WooCommerce rate) is the one a test edits. */
function uniqueRates(ims: Map<number, PreflightImsRate>): PreflightImsRate[] {
  const seen = new Map<string, PreflightImsRate>()
  for (const rate of ims.values()) if (!seen.has(rate.id)) seen.set(rate.id, rate)
  return [...seen.values()]
}

export function perfectWorld(seed: EuVatSeed = loadEuVatSeed()): World {
  const ims = new Map<number, PreflightImsRate>()
  const mappings = new Map<number, PreflightMapping>()
  const xero = new Map<string, NormalisedXeroTaxRate>()
  const byName = new Map<string, PreflightImsRate>()
  for (const r of seed.rates) {
    const code = r.accountingTaxType ?? syntheticChargedCode(r.wooId)
    // WooCommerce rates declared to be one Xero rate share one IMS rate (ruling Q2, option A): the first of the group stands for it, and `ims` holds that one object for every member.
    const rate = byName.get(r.imsName) ?? {
      id: `ims-${r.wooId}`, name: r.imsName, taxCategory: r.taxCategory, rate: (Number(r.ratePercent) / 100).toFixed(4), usedFor: 'SALES', active: true, reverseCharge: false, countryCode: r.imsCountry,
      accountingTaxType: code, reportingCategory: r.reportingCategory, schemePostingTaxType: r.schemePostingTaxType,
    }
    byName.set(r.imsName, rate)
    ims.set(r.wooId, rate)
    mappings.set(r.wooId, { id: `map-${r.wooId}`, storeIdentity: STORE, externalTaxRateId: String(r.wooId), externalName: r.wooName, externalCountry: r.country === '' ? null : r.country, externalRatePct: r.ratePercent, externalClass: r.wooClass, taxRateId: rate.id })
    if (!xero.has(code)) xero.set(code, xeroType(code, r.accountingXeroName ?? r.imsName, r.ratePercent))
    if (r.schemePostingTaxType !== null && !xero.has(r.schemePostingTaxType)) xero.set(r.schemePostingTaxType, xeroType(r.schemePostingTaxType, r.schemePostingXeroName!, '0.0000'))
  }
  const settings: Record<string, string> = {}
  for (const a of seed.accounts) if (a.settingKey !== null) settings[a.settingKey] = a.code
  const input: PreflightInput = {
    seed,
    storeIdentity: STORE,
    xero: { proven: true, fetchedAt: '2026-11-09T14:00:00.000Z', rows: [...xero.values()] },
    imsRates: uniqueRates(ims),
    componentRates: [],
    mappings: [...mappings.values()],
    accounts: seed.accounts.map((a) => ({ code: a.code, name: a.name ?? `Account ${a.code}` })),
    settings,
  }
  return { input, ims, mappings, xero }
}

/** The world with `mutate` applied to a copy: the helper replaces what it changes, never edits the shared objects. */
export function withWorld(mutate: (world: World) => void, seed: EuVatSeed = loadEuVatSeed()): PreflightInput {
  const world = perfectWorld(seed)
  mutate(world)
  return { ...world.input, imsRates: uniqueRates(world.ims), mappings: [...world.mappings.values()], xero: { proven: true, fetchedAt: '2026-11-09T14:00:00.000Z', rows: [...world.xero.values()] } }
}
