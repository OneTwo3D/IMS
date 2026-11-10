/**
 * DRIFT OF THE SCHEME POSTING TYPES, judged against the DECLARATION (lib/tax/eu-vat-seed.json) and matched to Xero BY CODE, because it is a code and not a name that gets sent. The name-matched sweep
 * (tax-rate-drift.ts) cannot see it: the posting type is a different Xero rate from the one the IMS rate is named for ("DE VAT" against "DE IOSS VAT"), and a rate with no components is not compared at all.
 *
 * DRIVEN FROM THE DECLARED MAPPINGS, not from the rates that currently carry a type: for every declared WooCommerce rate whose mapping is stamped for the configured store and records the declared store
 * rate, the IMS rate it names must carry the declared `schemePostingTaxType` and a reporting category that agrees (the declared IOSS/VOEC marker; on a rate that is not a scheme rate, none of those two). So a
 * CLEARED type, a type swapped for another valid one and IOSS turned into VOEC are all drift, not just a type that has gone from Xero. The declared type itself must still be an ACTIVE Xero type at exactly 0%
 * with the declared name (byte-exact), and must not be the rate's own charged code. A declared rate whose mapping is missing, never adopted, made against another store, recording another store rate, or
 * naming a missing or inactive IMS rate is drift too (one item, MAPPING_ISSUES_ID), and ONLY a rate named by a mapping that passed all of those counts as declared. An active rate carrying a type no such mapping names is drift as well. Pure; alert-only: nothing is written back.
 */
import { Prisma } from '@/app/generated/prisma/client'
import type { NormalisedXeroTaxRate } from './tax-rate-list'
import type { EuVatSeedRate } from '@/lib/tax/eu-vat-seed'

export type SchemeDriftRate = { taxRateId: string; name: string; active: boolean; accountingTaxType: string | null; reportingCategory: string | null; schemePostingTaxType: string | null }
export type SchemeDriftMapping = { externalTaxRateId: string; taxRateId: string; storeIdentity: string | null; externalCountry: string | null; externalRatePct: string; externalClass: string | null }

/** The one drift item that carries the declared mappings that are missing or invalid (they belong to no rate). */
export const MAPPING_ISSUES_ID = 'eu-vat-declared-mappings'
const norm = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim().toUpperCase())
const cls = (value: string | null): string => (value ?? '').trim().toLowerCase() || 'standard'

export function computeSchemePostingDrift(input: {
  declared: readonly EuVatSeedRate[]
  mappings: readonly SchemeDriftMapping[]
  rates: readonly SchemeDriftRate[]
  /** The normalised URL of the WooCommerce store configured now; null = none, and no mapping can be matched (nothing is judged). */
  storeIdentity: string | null
  xero: readonly NormalisedXeroTaxRate[]
}): Array<{ taxRateId: string; name: string; lines: string[] }> {
  const byType = new Map(input.xero.map((row) => [row.taxType, row]))
  const ratesById = new Map(input.rates.map((r) => [r.taxRateId, r]))
  const mappingBy = new Map(input.mappings.map((m) => [m.externalTaxRateId, m]))
  const linesBy = new Map<string, string[]>()
  const add = (id: string, line: string): void => { const lines = linesBy.get(id) ?? []; if (!lines.includes(line)) lines.push(line); linesBy.set(id, lines) }
  const issue = (line: string): void => add(MAPPING_ISSUES_ID, line)
  const named = new Set<string>()
  // An instance the declaration has not touched at all (no declared WooCommerce rate mapped, no rate carrying a scheme posting type) has nothing to drift from.
  const engaged = input.rates.some((r) => r.schemePostingTaxType !== null) || input.declared.some((d) => mappingBy.has(String(d.wooId)))
  if (!engaged) return []
  if (input.storeIdentity === null) issue('No usable WooCommerce store is configured, so no declared mapping can be shown to belong to it and no scheme posting type is judged')
  for (const declared of input.declared) {
    if (input.storeIdentity === null) break
    const mapping = mappingBy.get(String(declared.wooId))
    const label = `Declared Woo rate ${declared.wooId}`
    if (mapping === undefined) { issue(`${label} has no storefront mapping`); continue }
    if (mapping.storeIdentity === null) { issue(`${label}: its mapping was never adopted (no store identity)`); continue }
    if (mapping.storeIdentity !== input.storeIdentity) { issue(`${label}: its mapping was made against another store than the one configured now`); continue }
    if ((mapping.externalCountry ?? '').trim().toUpperCase() !== declared.country || !new Prisma.Decimal(mapping.externalRatePct).eq(new Prisma.Decimal(declared.ratePercent)) || cls(mapping.externalClass) !== cls(declared.wooClass)) {
      issue(`${label}: its mapping records another country, percentage or class than the declaration`); continue
    }
    const rate = ratesById.get(mapping.taxRateId)
    if (rate === undefined) { issue(`${label}: its mapping names a tax rate that does not exist`); continue }
    if (!rate.active) { issue(`${label}: its mapping names an inactive tax rate`); continue }
    // Only a rate named by a mapping that passed every check above counts as declared.
    named.add(rate.taxRateId)
    const expectedType = declared.schemePostingTaxType
    if ((rate.schemePostingTaxType ?? null) !== expectedType) {
      add(rate.taxRateId, expectedType === null ? `Carries scheme posting type ${rate.schemePostingTaxType ?? ''}, but the declaration has none for Woo rate ${declared.wooId}` : `Scheme posting type is ${rate.schemePostingTaxType ?? 'not set'}, declared ${expectedType} for Woo rate ${declared.wooId}`)
    }
    const category = norm(rate.reportingCategory)
    if (expectedType !== null ? category !== declared.reportingCategory : category === 'IOSS' || category === 'VOEC') {
      add(rate.taxRateId, `Reporting category is "${rate.reportingCategory ?? ''}", declared ${declared.reportingCategory ?? 'neither IOSS nor VOEC'} for Woo rate ${declared.wooId}`)
    }
    if (expectedType !== null) {
      const live = byType.get(expectedType)
      if (live === undefined) add(rate.taxRateId, `Scheme posting type ${expectedType} is not in the Xero tax-rate list`)
      else {
        if (live.status !== 'ACTIVE') add(rate.taxRateId, `Scheme posting type ${expectedType} is ${live.status} in Xero, not ACTIVE`)
        const stated = live.effectiveRate ?? live.displayTaxRate
        if (stated === null) add(rate.taxRateId, `Scheme posting type ${expectedType} states no rate in Xero, so it cannot be shown to be zero-rated`)
        else if (Number(stated) !== 0) add(rate.taxRateId, `Scheme posting type ${expectedType} is ${Number(stated)}% in Xero, not 0%`)
        if (declared.schemePostingXeroName !== null && live.name !== declared.schemePostingXeroName) add(rate.taxRateId, `Scheme posting type ${expectedType} is named "${live.name}" in Xero, declared "${declared.schemePostingXeroName}"`)
      }
      if (rate.accountingTaxType !== null && rate.accountingTaxType === expectedType) add(rate.taxRateId, `Its charged code is its scheme posting type ${expectedType}: a scheme line would post on the charged rate`)
    }
  }
  // A mapping onto a declared rate from a WooCommerce rate the declaration does not declare the same Xero rate (or does not declare at all) is a sharer nobody judged.
  for (const rateId of named) {
    const declaredImsName = (id: string) => input.declared.find((d) => String(d.wooId) === id)?.imsName
    const owners = new Set(input.declared.filter((d) => mappingBy.get(String(d.wooId))?.taxRateId === rateId).map((d) => d.imsName))
    for (const m of input.mappings) {
      if (m.taxRateId !== rateId) continue
      const theirs = declaredImsName(m.externalTaxRateId)
      if (theirs === undefined || owners.size > 1) add(rateId, `Woo rate ${m.externalTaxRateId} is mapped to this rate but the declaration ${theirs === undefined ? 'does not declare it' : 'declares it as another Xero rate'}`)
    }
  }
  for (const rate of input.rates) {
    if (input.storeIdentity !== null && rate.active && rate.schemePostingTaxType !== null && !named.has(rate.taxRateId)) add(rate.taxRateId, `Carries scheme posting type ${rate.schemePostingTaxType} but no declared WooCommerce mapping names it`)
  }
  const out: Array<{ taxRateId: string; name: string; lines: string[] }> = []
  for (const [taxRateId, lines] of linesBy) out.push({ taxRateId, name: taxRateId === MAPPING_ISSUES_ID ? 'EU VAT declaration: storefront mappings' : ratesById.get(taxRateId)?.name ?? taxRateId, lines })
  return out
}
