// ---------------------------------------------------------------------------
// "Available in purchase orders" warehouse flag
//
// A warehouse with the flag off (dropship, quarantine, virtual locations) cannot be chosen as a purchase-order
// destination or as a goods-receipt location. The pickers hide it and the server actions refuse it, with the
// wording below.
//
// Two things are deliberately NOT covered:
//  - A purchase order that ALREADY points at such a warehouse keeps working: it can still be edited with that
//    destination left as it is, and it can still be received into it. Receiving warns instead of refusing.
//  - WMS-driven receipts (ASN / book-in) come from the warehouse system, which decides where goods land. IMS
//    records them as the warehouse reports them and never applies this flag to them.
// ---------------------------------------------------------------------------

export type PoWarehouseFlag = { id: string; availableForPurchaseOrders?: boolean | null }

/** The flag is on unless it is explicitly false (rows read before the column existed count as available). */
export function isAvailableForPurchaseOrders(w: { availableForPurchaseOrders?: boolean | null }): boolean {
  return w.availableForPurchaseOrders !== false
}

/**
 * The warehouses a picker offers: every one with the flag on, plus `keepId` (the warehouse an existing PO already
 * points at) even when restricted, so the saved value stays visible instead of silently becoming blank.
 */
export function selectablePoWarehouses<T extends PoWarehouseFlag>(warehouses: T[], keepId?: string | null): T[] {
  return warehouses.filter((w) => isAvailableForPurchaseOrders(w) || (keepId != null && keepId !== '' && w.id === keepId))
}

export function restrictedDestinationMessage(label: string): string {
  return `${label} is not available for purchase orders, so it cannot be the destination. Choose another warehouse, or turn on "Available in purchase orders" for it in Settings > Warehouses.`
}

export function restrictedReceiptLocationMessage(label: string): string {
  return `${label} is not available for purchase orders, so goods cannot be received into it. Choose another warehouse, or turn on "Available in purchase orders" for it in Settings > Warehouses.`
}

export function restrictedExistingDestinationWarning(label: string): string {
  return `${label} is marked as not available for purchase orders. This order already pointed at it, so the receipt was allowed; new orders cannot use it.`
}

type WarehouseReader = {
  warehouse: {
    findMany(args: { where: { id: { in: string[] }; availableForPurchaseOrders: false }; select: { id: true; code: true; name: true } }): Promise<Array<{ id: string; code: string; name: string }>>
  }
}

/** The warehouses among `ids` that have the flag off, as {id, code, name}. */
export async function findPoRestrictedWarehouses(client: WarehouseReader, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (unique.length === 0) return []
  return client.warehouse.findMany({
    where: { id: { in: unique }, availableForPurchaseOrders: false },
    select: { id: true, code: true, name: true },
  })
}

export const warehouseLabel = (w: { code: string; name: string }) => `${w.code} — ${w.name}`

/**
 * Refusal for setting a PO destination. `current` is the destination the order already has (null on create):
 * leaving it unchanged passes, so an existing order that points at a restricted warehouse stays editable.
 */
export async function refuseRestrictedDestination(
  client: WarehouseReader,
  requested: string | null | undefined,
  current: string | null = null,
): Promise<string | null> {
  if (!requested || requested === current) return null
  const [restricted] = await findPoRestrictedWarehouses(client, [requested])
  return restricted ? restrictedDestinationMessage(warehouseLabel(restricted)) : null
}

/**
 * Receipt locations: a restricted warehouse other than the order's own destination is refused; the order's own
 * destination, even when restricted, is allowed with a warning (the order was placed before the flag was turned off).
 */
export async function checkReceiptLocations(
  client: WarehouseReader,
  destinationWarehouseId: string | null,
  receiptWarehouseIds: string[],
): Promise<{ refusal: string | null; warnings: string[] }> {
  const restricted = await findPoRestrictedWarehouses(client, receiptWarehouseIds)
  const warnings: string[] = []
  for (const w of restricted) {
    if (w.id === destinationWarehouseId) warnings.push(restrictedExistingDestinationWarning(warehouseLabel(w)))
    else return { refusal: restrictedReceiptLocationMessage(warehouseLabel(w)), warnings: [] }
  }
  return { refusal: null, warnings }
}
