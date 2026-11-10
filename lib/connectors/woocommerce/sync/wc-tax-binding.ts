/**
 * THE TAX BINDING OF A WOOCOMMERCE ORDER: every input that decides the tax type a line, and the shipping, post on, recorded when an invoice is parked (before the treatment re-types any line) and recomputed from the order before a held invoice is
 * released. Two equal-value lines that exchange tax classes leave every amount and the total unchanged, and so does a flipped reverse-charge flag, so only the inputs can show it.
 *
 * THE INPUTS (everything `resolveWcTaxRateById`, `currentTaxRates` and `resolveWcLineAccountingTaxType` read to decide a posted type; each is recorded and compared):
 *   per line and for the shipping: the WooCommerce tax rate id it names (`lineRateIds`, `shippingRateIds`: position matters);
 *   per WooCommerce rate id (`rates[id]`): whether a mapping exists; the mapped IMS rate's id; its accounting tax type; its reverse-charge flag; its active flag; its rate and compound flag; its scheme posting type, reporting category and
 *   country (they decide the scheme route); the id of the rate that replaced it (a tax re-key); its active components (rate, compound-on-previous, accounting type, order); and what the rate stands for NOW once a re-key's replacement is followed
 *   (`currentTaxRates`: the id, the accounting tax type and the reverse-charge flag the builder actually reads);
 *   the reverse-charge SALES tax type setting (`reverseChargeSalesTaxType`), which swaps a reverse-charge rate's type;
 *   per line, the final effective tax type, computed exactly as the builder does (the no-tax fee rule, the rate's type or the reverse-charge swap), and per shipping rate its plain type (shipping is never swapped).
 * A rate WooCommerce names that has no mapping cannot be resolved: it is recorded as unmapped and never matches a mapped one.
 */
import { db } from '@/lib/db'
import { currentTaxRates } from '@/lib/tax/writable-tax-rate'
import { resolveWcTaxRateById } from './field-mapping'
import type { WcFullOrder } from './types'

export type WcRateInputs = {
  mapped: boolean
  imsRateId: string | null
  accountingTaxType: string | null
  reverseCharge: boolean | null
  active: boolean | null
  rate: string | null
  isCompound: boolean | null
  schemePostingTaxType: string | null
  reportingCategory: string | null
  countryCode: string | null
  replacedById: string | null
  components: string | null
  nowRateId: string | null
  nowAccountingTaxType: string | null
  nowReverseCharge: boolean | null
}

export type WcTaxBinding = {
  lineRateIds: Array<number | null>
  shippingRateIds: number[]
  rates: Record<string, WcRateInputs>
  reverseChargeSalesTaxType: string
  /** The effective tax type of each line as the builder would send it; null for a line that names no rate (nothing to resolve) or whose rate is unmapped. */
  lineTypes: Array<string | null>
  /** The plain (never swapped) type of each shipping rate, in `shippingRateIds` order; null when unmapped. */
  shippingTypes: Array<string | null>
}

/** What the invoice builder's own line rule is, injected so this module needs no import of the importer: `resolveWcLineAccountingTaxType`. */
export type LineTypeRule = (p: { forceNoTax: boolean | undefined; baseTaxType: string | null | undefined; reverseCharge: boolean | null | undefined; reverseChargeSalesTaxType: string | null | undefined }) => string | undefined

const UNMAPPED: WcRateInputs = {
  mapped: false, imsRateId: null, accountingTaxType: null, reverseCharge: null, active: null, rate: null, isCompound: null, schemePostingTaxType: null, reportingCategory: null,
  countryCode: null, replacedById: null, components: null, nowRateId: null, nowAccountingTaxType: null, nowReverseCharge: null,
}

async function readRateInputs(wcRateId: number): Promise<{ inputs: WcRateInputs; resolvedType: string | null; resolvedReverseCharge: boolean }> {
  const resolved = await resolveWcTaxRateById(wcRateId)
  if (resolved.source !== 'mapped' || resolved.taxRateId === null) return { inputs: UNMAPPED, resolvedType: null, resolvedReverseCharge: false }
  const row = await db.taxRate.findUnique({
    where: { id: resolved.taxRateId },
    select: {
      id: true, accountingTaxType: true, reverseCharge: true, active: true, rate: true, isCompound: true, schemePostingTaxType: true, reportingCategory: true, countryCode: true, replacedById: true,
      components: { where: { active: true }, select: { rate: true, compoundOnPrevious: true, accountingTaxType: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!row) return { inputs: UNMAPPED, resolvedType: null, resolvedReverseCharge: false }
  const now = (await currentTaxRates(db, [row.id])).get(row.id) ?? null
  return {
    inputs: {
      mapped: true, imsRateId: row.id, accountingTaxType: row.accountingTaxType, reverseCharge: row.reverseCharge, active: row.active, rate: row.rate.toString(), isCompound: row.isCompound,
      schemePostingTaxType: row.schemePostingTaxType, reportingCategory: row.reportingCategory, countryCode: row.countryCode, replacedById: row.replacedById,
      components: JSON.stringify(row.components.map((c) => [c.rate.toString(), c.compoundOnPrevious, c.accountingTaxType, c.sortOrder])),
      nowRateId: now?.id ?? null, nowAccountingTaxType: now?.accountingTaxType ?? null, nowReverseCharge: now?.reverseCharge ?? null,
    },
    // The builder reads the replacement's type and flag first (`rateNow`), then the mapped resolution.
    resolvedType: now?.accountingTaxType ?? resolved.accountingTaxType ?? null,
    resolvedReverseCharge: now?.reverseCharge ?? resolved.reverseCharge === true,
  }
}

export async function currentWcTaxBinding(
  wcOrder: Pick<WcFullOrder, 'shipping_lines'>,
  mappedLines: ReadonlyArray<{ externalTaxRateId?: number | null; isFeeLine?: boolean; forceNoTax?: boolean }>,
  deps: { reverseChargeSalesTaxType: string | null | undefined; lineType: LineTypeRule },
): Promise<WcTaxBinding> {
  const lineRateIds = mappedLines.map((l) => (typeof l.externalTaxRateId === 'number' && l.externalTaxRateId > 0 ? l.externalTaxRateId : null))
  const shippingRateIds = [...new Set((wcOrder.shipping_lines ?? []).flatMap((line) => (line.taxes ?? []).map((tax) => tax.id)).filter((id): id is number => typeof id === 'number' && id > 0))].sort((a, b) => a - b)
  const rates: Record<string, WcRateInputs> = {}
  const effective = new Map<number, { type: string | null; reverseCharge: boolean }>()
  for (const id of new Set([...lineRateIds.filter((id): id is number => id !== null), ...shippingRateIds])) {
    const read = await readRateInputs(id)
    rates[String(id)] = read.inputs
    effective.set(id, { type: read.resolvedType, reverseCharge: read.resolvedReverseCharge })
  }
  const setting = (deps.reverseChargeSalesTaxType ?? '').trim()
  const lineTypes = mappedLines.map((l, index): string | null => {
    if (l.isFeeLine === true && l.forceNoTax === true) return deps.lineType({ forceNoTax: true, baseTaxType: null, reverseCharge: false, reverseChargeSalesTaxType: setting }) ?? null
    const id = lineRateIds[index]
    if (id === null || id === undefined) return null
    const e = effective.get(id)
    if (!rates[String(id)]?.mapped || !e) return null
    return deps.lineType({ forceNoTax: false, baseTaxType: e.type, reverseCharge: e.reverseCharge, reverseChargeSalesTaxType: setting }) ?? null
  })
  const shippingTypes = shippingRateIds.map((id) => (rates[String(id)]?.mapped ? effective.get(id)?.type ?? null : null))
  return { lineRateIds, shippingRateIds, rates, reverseChargeSalesTaxType: setting, lineTypes, shippingTypes }
}

/** What the marker stores: the binding itself (plain JSON). */
export function recordWcTaxBinding(binding: WcTaxBinding): WcTaxBinding {
  return JSON.parse(JSON.stringify(binding)) as WcTaxBinding
}
