/**
 * The WooCommerce duty / tax results the importer MIRRORS (owner decision D5: WooCommerce calculates, IMS never recomputes): the IOSS
 * number and delivery term on the order, and the per-unit customs value override on an order line. Pure readers, in their own module so
 * nothing that stubs field-mapping has to know about them.
 */
import type { WcFullOrder, WcLineItem } from './types'

function normaliseText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed || null
}

/** The order meta keys the duty/tax mirror reads. WooCommerce's compliance plugin is the writer; IMS only reads them. */
export const WC_IOSS_NUMBER_META_KEY = '_o3d_ioss_number'
export const WC_DELIVERY_TERM_META_KEY = '_o3d_delivery_term'
export const WC_DELIVERY_TERMS = ['IOSS_DDP', 'DDP', 'DDU_DAP'] as const
export type WcDeliveryTerm = (typeof WC_DELIVERY_TERMS)[number]
/** The line item meta holding the operator-set per-unit customs value override (written by the label plugin). */
export const WC_CUSTOMS_UNIT_VALUE_META_KEY = '_wc_label_customs_unit_value'

export type WcDutyTaxMirror = { iossNumber: string | null; deliveryTerm: WcDeliveryTerm | null }

/**
 * The IOSS number WooCommerce applied and the delivery term it declared, MIRRORED as stored (never derived, never defaulted).
 * Absent, blank or unusable meta is null. Returns `null` (not a pair of nulls) when the payload carries no meta list at all, so a
 * caller can tell "WooCommerce reported nothing" (leave the stored values alone) from "reported none" (clear them).
 */
export function readWcDutyTaxMirror(order: Pick<WcFullOrder, 'meta_data'>): WcDutyTaxMirror | null {
  if (!Array.isArray(order.meta_data)) return null
  const ioss = normaliseText(order.meta_data.find((m) => m.key === WC_IOSS_NUMBER_META_KEY)?.value)
  const termRaw = normaliseText(order.meta_data.find((m) => m.key === WC_DELIVERY_TERM_META_KEY)?.value)
  const term = termRaw ? termRaw.toUpperCase() : null
  return {
    iossNumber: ioss && ioss.length <= 40 && !/\s/.test(ioss) ? ioss : null,
    deliveryTerm: term && (WC_DELIVERY_TERMS as readonly string[]).includes(term) ? (term as WcDeliveryTerm) : null,
  }
}

/**
 * The per-unit customs value override on one order line, as WooCommerce holds it: a plain positive decimal (the label plugin's own
 * grammar: digits and an optional point, greater than zero). Anything else is null, never a guess. Not rounded or recomputed.
 */
export function readWcLineCustomsUnitValue(line: Pick<WcLineItem, 'meta_data'>): string | null {
  const entry = (line.meta_data ?? []).find((m) => m.key === WC_CUSTOMS_UNIT_VALUE_META_KEY)
  if (!entry) return null
  const raw = typeof entry.value === 'number' ? String(entry.value) : typeof entry.value === 'string' ? entry.value.trim() : ''
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) return null
  return parseFloat(raw) > 0 ? raw : null
}
