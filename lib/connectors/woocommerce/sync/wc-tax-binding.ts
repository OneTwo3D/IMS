/**
 * THE TAX BINDING OF A WOOCOMMERCE ORDER: which WooCommerce tax rate each line and the shipping carry, and the accounting tax type each of those rates resolves to through the SAME mapping the invoice builder uses
 * (`resolveWcTaxRateById`: WooCommerce rate id -> mapped IMS rate -> its accounting tax type). Recorded in the treatment marker when an invoice is parked (before the treatment re-types any line), and recomputed from the order before a held
 * invoice is released: a swap of two lines' tax classes leaves every amount and the total unchanged, so only the binding can show it.
 */
import { resolveWcTaxRateById } from './field-mapping'
import type { WcFullOrder } from './types'

export type CurrentWcTaxBinding = {
  /** The WooCommerce rate id of each line (goods then fees, as the invoice lines are), or null when the line names none. */
  lineRateIds: Array<number | null>
  /** The distinct WooCommerce rate ids on the shipping lines, ascending. */
  shippingRateIds: number[]
  /** Every rate id above, resolved: `mapped` false means WooCommerce named a rate IMS has no mapping for (it cannot be resolved). */
  resolved: Record<string, { type: string | null; mapped: boolean; reverseCharge: boolean }>
}

/** What the marker records: the same, without the resolver's reverse-charge detail. */
export type RecordedWcTaxBinding = { lineRateIds: Array<number | null>; shippingRateIds: number[]; resolved: Record<string, string | null> }

export async function currentWcTaxBinding(
  wcOrder: Pick<WcFullOrder, 'shipping_lines'>,
  mappedLines: ReadonlyArray<{ externalTaxRateId?: number | null }>,
): Promise<CurrentWcTaxBinding> {
  const lineRateIds = mappedLines.map((l) => (typeof l.externalTaxRateId === 'number' && l.externalTaxRateId > 0 ? l.externalTaxRateId : null))
  const shippingRateIds = [...new Set((wcOrder.shipping_lines ?? []).flatMap((line) => (line.taxes ?? []).map((tax) => tax.id)).filter((id): id is number => typeof id === 'number' && id > 0))].sort((a, b) => a - b)
  const resolved: CurrentWcTaxBinding['resolved'] = {}
  for (const id of new Set([...lineRateIds.filter((id): id is number => id !== null), ...shippingRateIds])) {
    const rate = await resolveWcTaxRateById(id)
    resolved[String(id)] = { type: rate.accountingTaxType ?? null, mapped: rate.source === 'mapped', reverseCharge: rate.reverseCharge === true }
  }
  return { lineRateIds, shippingRateIds, resolved }
}

export function recordWcTaxBinding(binding: CurrentWcTaxBinding): RecordedWcTaxBinding {
  return { lineRateIds: binding.lineRateIds, shippingRateIds: binding.shippingRateIds, resolved: Object.fromEntries(Object.entries(binding.resolved).map(([id, r]) => [id, r.type])) }
}
