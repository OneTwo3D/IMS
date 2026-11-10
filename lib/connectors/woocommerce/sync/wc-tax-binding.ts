/**
 * THE TAX BINDING OF A WOOCOMMERCE ORDER: every input that decides the tax type a line, and the shipping, post on, recorded when an invoice is parked (before the treatment re-types any line) and recomputed from the order before a held invoice is
 * released. Two equal-value lines that exchange tax classes leave every amount and the total unchanged, and so does a flipped reverse-charge flag, so only the inputs can show it.
 *
 * THE INPUTS (everything `resolveWcTaxRateById`, `currentTaxRates` and `resolveWcLineAccountingTaxType` read to decide a posted type; each is recorded and compared):
 *   per line and for the shipping: the WooCommerce tax rate id it names (`lineRateIds`, `shippingRateIds`: position matters);
 *   per WooCommerce rate id (`rates[id]`): whether a mapping exists; the mapped IMS rate's id; its accounting tax type; its reverse-charge flag; its active flag; its rate and compound flag; its scheme posting type, reporting category and
 *   country (they decide the scheme route); the id of the rate that replaced it (a tax re-key); its active components (rate, compound-on-previous, accounting type, order); and what the rate stands for NOW once a re-key's replacement is followed
 *   (`currentTaxRates`: the id, the accounting tax type and the reverse-charge flag the builder actually reads);
 *   the reverse-charge SALES tax type setting (`reverseChargeSalesTaxType`), which swaps a reverse-charge rate's type.
 * THE OUTPUTS ARE WHAT IS COMPARED. The inputs above are kept as diagnostics (they say WHY a hold changed); the decision is the output of the ONE function the invoice builder also uses (`resolveWcInvoiceTaxTypes` in order-import.ts): per line and for the
 * shipping, the resolved IMS rate id, where it came from (the WooCommerce rate, the product-category resolver, the order default, or the fee no-tax rule) and the effective posted tax type. A line that names no WooCommerce rate is NOT taxless: the builder picks
 * its rate from the category resolver or the order default, so its selection is recorded and compared like any other. A rate WooCommerce names that has no mapping cannot be resolved: it is recorded as unmapped and never matches a mapped one.
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

/** The output of `resolveWcInvoiceTaxTypes` (order-import.ts), as this module needs it. */
export type InvoiceTaxTypesInput = {
  lines: Array<{ rateId: string | null; source: string; type: string | null }>
  shipping: { rateId: string | null; type: string | null }
}

export type WcTaxBinding = {
  lineRateIds: Array<number | null>
  shippingRateIds: number[]
  rates: Record<string, WcRateInputs>
  reverseChargeSalesTaxType: string
  /** THE COMPARED OUTPUT, per line: the resolved IMS rate id, its source and the effective posted tax type (null where nothing resolves). */
  lines: Array<{ rateId: string | null; source: string; type: string | null }>
  /** THE COMPARED OUTPUT for the shipping. */
  shipping: { rateId: string | null; type: string | null }
}

const UNMAPPED: WcRateInputs = {
  mapped: false, imsRateId: null, accountingTaxType: null, reverseCharge: null, active: null, rate: null, isCompound: null, schemePostingTaxType: null, reportingCategory: null,
  countryCode: null, replacedById: null, components: null, nowRateId: null, nowAccountingTaxType: null, nowReverseCharge: null,
}

async function readRateInputs(wcRateId: number): Promise<WcRateInputs> {
  const resolved = await resolveWcTaxRateById(wcRateId)
  if (resolved.source !== 'mapped' || resolved.taxRateId === null) return UNMAPPED
  const row = await db.taxRate.findUnique({
    where: { id: resolved.taxRateId },
    select: {
      id: true, accountingTaxType: true, reverseCharge: true, active: true, rate: true, isCompound: true, schemePostingTaxType: true, reportingCategory: true, countryCode: true, replacedById: true,
      components: { where: { active: true }, select: { rate: true, compoundOnPrevious: true, accountingTaxType: true, sortOrder: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  })
  if (!row) return UNMAPPED
  const now = (await currentTaxRates(db, [row.id])).get(row.id) ?? null
  return {
    mapped: true, imsRateId: row.id, accountingTaxType: row.accountingTaxType, reverseCharge: row.reverseCharge, active: row.active, rate: row.rate.toString(), isCompound: row.isCompound,
    schemePostingTaxType: row.schemePostingTaxType, reportingCategory: row.reportingCategory, countryCode: row.countryCode, replacedById: row.replacedById,
    components: JSON.stringify(row.components.map((c) => [c.rate.toString(), c.compoundOnPrevious, c.accountingTaxType, c.sortOrder])),
    nowRateId: now?.id ?? null, nowAccountingTaxType: now?.accountingTaxType ?? null, nowReverseCharge: now?.reverseCharge ?? null,
  }
}

export async function currentWcTaxBinding(
  wcOrder: Pick<WcFullOrder, 'shipping_lines'>,
  mappedLines: ReadonlyArray<{ externalTaxRateId?: number | null }>,
  deps: { reverseChargeSalesTaxType: string | null | undefined; invoiceTypes: InvoiceTaxTypesInput },
): Promise<WcTaxBinding> {
  const lineRateIds = mappedLines.map((l) => (typeof l.externalTaxRateId === 'number' && l.externalTaxRateId > 0 ? l.externalTaxRateId : null))
  const shippingRateIds = [...new Set((wcOrder.shipping_lines ?? []).flatMap((line) => (line.taxes ?? []).map((tax) => tax.id)).filter((id): id is number => typeof id === 'number' && id > 0))].sort((a, b) => a - b)
  const rates: Record<string, WcRateInputs> = {}
  for (const id of new Set([...lineRateIds.filter((id): id is number => id !== null), ...shippingRateIds])) rates[String(id)] = await readRateInputs(id)
  return {
    lineRateIds, shippingRateIds, rates, reverseChargeSalesTaxType: (deps.reverseChargeSalesTaxType ?? '').trim(),
    lines: deps.invoiceTypes.lines.map((l) => ({ rateId: l.rateId, source: l.source, type: l.type })),
    shipping: { rateId: deps.invoiceTypes.shipping.rateId, type: deps.invoiceTypes.shipping.type },
  }
}

/** What the marker stores: the binding itself (plain JSON). */
export function recordWcTaxBinding(binding: WcTaxBinding): WcTaxBinding {
  return JSON.parse(JSON.stringify(binding)) as WcTaxBinding
}
