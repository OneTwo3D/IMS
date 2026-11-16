/** Which packing slip a request asks for: the whole order, or one shipment of it. */

export function packingSlipUrl(orderId: string, shipmentId?: string): string {
  const base = `/api/packing-slip/${encodeURIComponent(orderId)}`
  return shipmentId ? `${base}?shipment=${encodeURIComponent(shipmentId)}` : base
}

/** The order-level slip (⋮ menu) is offered once the order is past draft and not cancelled. */
export function orderPackingSlipAvailable(orderStatus: string): boolean {
  return orderStatus !== 'DRAFT' && orderStatus !== 'CANCELLED'
}

/**
 * Narrow an order's shipments to the one requested. `undefined` request = all shipments;
 * `null` = the requested shipment does not belong to this order (caller answers 404).
 */
export function selectShipmentsForSlip<T extends { id: string }>(
  shipments: readonly T[],
  requestedShipmentId: string | null | undefined,
): T[] | null {
  if (!requestedShipmentId) return [...shipments]
  const match = shipments.filter((s) => s.id === requestedShipmentId)
  return match.length > 0 ? match : null
}
