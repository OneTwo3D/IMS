import { toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * Replenishment thresholds are set on the Product and may be overridden per warehouse on the
 * product's StockLevel row. A null override inherits the Product value. This is the ONE place that
 * rule lives: the report, the editor's placeholders and the audit trail all call it.
 *
 * The thresholds are planning-only. They are never sent to a WMS or a storefront.
 */
export type ReorderThresholdFields = {
  reorderPoint: DecimalInput | null
  safetyStockQty: DecimalInput | null
  reorderQty: DecimalInput | null
}

/** One row of the reorder_threshold_overrides table (product x warehouse). Null/undefined fields inherit. */
export type ReorderThresholdOverrides = {
  reorderPoint?: DecimalInput | null
  safetyStockQty?: DecimalInput | null
  reorderQty?: DecimalInput | null
}

export type ReorderThresholdField = keyof ReorderThresholdFields

export type ResolvedReorderThresholds = {
  reorderPoint: Prisma.Decimal | null
  safetyStockQty: Prisma.Decimal | null
  reorderQty: Prisma.Decimal | null
  /** Which fields came from the warehouse override rather than the Product. */
  overridden: ReorderThresholdField[]
}

export const REORDER_THRESHOLD_FIELDS: readonly ReorderThresholdField[] = ['reorderPoint', 'safetyStockQty', 'reorderQty']

export function resolveReorderThresholds(
  product: ReorderThresholdFields,
  override?: ReorderThresholdOverrides | null,
): ResolvedReorderThresholds {
  const overridden: ReorderThresholdField[] = []
  const resolved = {} as Record<ReorderThresholdField, Prisma.Decimal | null>
  for (const field of REORDER_THRESHOLD_FIELDS) {
    const own = override?.[field]
    if (own != null) {
      resolved[field] = toDecimal(own)
      overridden.push(field)
    } else {
      const inherited = product[field]
      resolved[field] = inherited == null ? null : toDecimal(inherited)
    }
  }
  return { ...resolved, overridden }
}

/** Stored scale: Decimal(12,4), so the largest representable value is 99,999,999.9999. */
const MAX_OVERRIDE = '99999999.9999'
const OVERRIDE_DECIMAL_PLACES = 4

export type OverrideInputResult =
  | { ok: true; value: Prisma.Decimal | null }
  | { ok: false; error: string }

/**
 * Parse one override cell. Blank (or null/undefined) means "inherit the Product value" and is stored as
 * NULL. Anything else must be a plain non-negative number within the column's range, with at most four
 * decimal places (the column's scale), so a value is never silently rounded on save.
 */
export function parseOverrideInput(raw: string | null | undefined): OverrideInputResult {
  const text = (raw ?? '').trim()
  if (text === '') return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: 'Enter a number of zero or more, or leave blank to inherit the product value.' }
  const value = toDecimal(text)
  if (value.decimalPlaces() > OVERRIDE_DECIMAL_PLACES) return { ok: false, error: 'Use at most 4 decimal places.' }
  if (value.gt(MAX_OVERRIDE)) return { ok: false, error: 'That number is too large.' }
  return { ok: true, value }
}
