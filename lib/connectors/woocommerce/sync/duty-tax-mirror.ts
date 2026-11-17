/**
 * The WooCommerce duty / tax results the importer MIRRORS (owner decision D5: WooCommerce calculates, IMS never recomputes): the per-unit
 * customs value override on an order line. Pure readers, in their own module so
 * nothing that stubs field-mapping has to know about them.
 */
import type { WcLineItem } from './types'

/** The line item meta holding the operator-set per-unit customs value override (written by the label plugin). */
export const WC_CUSTOMS_UNIT_VALUE_META_KEY = '_wc_label_customs_unit_value'

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
