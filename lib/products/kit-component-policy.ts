import type { ProductType } from '@/app/generated/prisma/client'

/**
 * Which products may be components of a KIT, and how each type counts toward the kit.
 *
 * ONE RULE, used by every reader and writer so availability, allocation, dispatch and the editor
 * agree:
 *
 *   - NON_INVENTORY (a service, leaflet, gift wrap, fee): not stock-tracked, so it IMPOSES NO LIMIT.
 *     The availability calculation ignores it and the fulfilment expansion drops it (a standalone
 *     NON_INVENTORY order line is already skipped by allocation and dispatch for the same reason).
 *   - VARIABLE (a variable PARENT): it holds no stock, its variations do, and which variation the kit
 *     takes is undefined. REFUSED at save: a kit must name a concrete variation. A legacy row that
 *     already has one fails closed (availability 0, never allocatable) rather than being skipped,
 *     because skipping made a kit look sellable while every variation was out of stock.
 *   - A kit whose components are ALL NON_INVENTORY has nothing that limits or consumes stock, so it is
 *     REFUSED at save (make it a NON_INVENTORY product instead); a legacy one fails closed at 0.
 */
export function isKitIgnoredComponentType(type: ProductType | string): boolean {
  return type === 'NON_INVENTORY'
}

export type KitComponentRefusal = { reason: string }

/** Returns a refusal message when `components` may not be saved onto a KIT, else null. */
export function findKitComponentRefusal(
  components: Array<{ sku: string; type: ProductType | string }>,
): string | null {
  const variable = components.filter((c) => c.type === 'VARIABLE')
  if (variable.length > 0) {
    return `A kit cannot contain a variable product (${variable.map((c) => c.sku).join(', ')}): choose a specific variation instead. A variable parent holds no stock, so a kit built on it could never be allocated.`
  }
  if (components.length > 0 && components.every((c) => isKitIgnoredComponentType(c.type))) {
    return 'A kit must contain at least one stock-tracked component. Every component here is a non-inventory item (service, fee or similar), so the kit would have no stock to sell; make it a non-inventory product instead.'
  }
  return null
}
