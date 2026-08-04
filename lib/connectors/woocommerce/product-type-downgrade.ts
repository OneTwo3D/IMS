/**
 * o3d-t0zq (part 2) / o3d-0hhu — the WooCommerce product sync must not downgrade a product type
 * that local structure depends on.
 *
 * WooCommerce knows two kinds of product the sync can express: `variable` and everything else,
 * which it maps to VARIABLE and SIMPLE. IMS has four more. So a KIT, a BOM, or a VARIABLE
 * parent whose WooCommerce object is (or becomes) `simple` was being rewritten to SIMPLE, while
 * its ProductComponent rows and VARIANT children stayed exactly where they were.
 *
 * The result is a product whose type says it has no structure and whose structure is still
 * there: components that no longer drive stock, or variants whose parent no longer accepts
 * children. The editor forbids exactly this transformation; the sync ran none of those checks.
 *
 * REFUSING RATHER THAN DELETING. Clearing the structure to match the incoming type would make
 * rows disappear that other systems still read: invariants.ts reads live ProductComponent rows,
 * and the replenishment and inventory-health reports condition their use of BomItem/KitItem on
 * the parent still being BOM/KIT. An in-progress ASSEMBLY order is NOT at risk -- it freezes a
 * componentSnapshot at creation and consumes that, and normal assembly creation takes BOM
 * products rather than KITs (an earlier version of this note claimed otherwise; it was wrong).
 * The cost of keeping the local type is a stale type on a product nobody sells that way. The
 * cost of deleting is rows that several reports silently stop counting.
 */

/** Types whose meaning depends on rows this sync does not own. */
export const STRUCTURED_DOWNGRADE_TYPES = new Set(['KIT', 'BOM', 'VARIABLE'])

export type DowngradeDecision =
  | { action: 'write'; type: string }
  | { action: 'keep'; type: string; reason: string }

/**
 * Decide the type to persist.
 *
 * `hasStructure` must be established under the same lock as the write — a component or child
 * added between an unlocked read and the update would otherwise be stranded by the very check
 * meant to prevent it.
 */
export function planTypeWrite(params: {
  existingType: string | null | undefined
  incomingType: string
  hasStructure: boolean
  sku: string
}): DowngradeDecision {
  const { existingType, incomingType, hasStructure, sku } = params

  // A new product, or no change: nothing to protect.
  if (!existingType || existingType === incomingType) return { action: 'write', type: incomingType }

  // Only changes OUT OF a structured type are refused. That includes KIT -> VARIABLE, not just
  // the SIMPLE case -- any move away from a type whose dependent rows would be left behind.
  // Moving INTO a structured type (SIMPLE -> VARIABLE, how a product legitimately gains
  // variants) is unaffected, because the existing type is what is checked.
  if (!STRUCTURED_DOWNGRADE_TYPES.has(existingType)) return { action: 'write', type: incomingType }

  // A structured type with nothing left depending on it can be rewritten freely: the whole
  // reason to refuse is the orphaned rows, and there are none.
  if (!hasStructure) return { action: 'write', type: incomingType }

  return {
    action: 'keep',
    type: existingType,
    reason: `WooCommerce reports ${sku} as ${incomingType.toLowerCase()}, but it is a local `
      + `${existingType} with components or variants that depend on that type. The local type is `
      + 'kept: rewriting it would leave those rows orphaned, and deleting them would change what '
      + 'an in-flight order is entitled to. Change the structure in IMS first if the downgrade is '
      + 'intended.',
  }
}
