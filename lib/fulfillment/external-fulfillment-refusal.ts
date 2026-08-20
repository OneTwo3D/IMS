import type { ExternalFulfillmentRefusalReason } from './external-fulfillment'

/**
 * o3d-xnwu: the operator-visible record of a storefront fulfilment that IMS
 * REFUSED to apply.
 *
 * `processWcCompletion` used to call `applyExternalFulfillmentUpdate` and discard
 * its result entirely. So a WooCommerce order the store had marked completed
 * could fail to become an IMS shipment with the caller told nothing, the webhook
 * acknowledged, and no retry or dead letter anywhere — the "requires physical
 * stock" refusal produced literally no record at all. The WMS path had none of
 * this: it counts failures, dead-letters at five, and notifies admins.
 *
 * Two things now happen instead. The refusal is classified so the webhook can
 * decide between retrying and acknowledging (o3d-i0y / o3d-bx9), and a
 * PERMANENT one leaves a durable row in the exception inbox — the page an
 * operator is already looking at, with a replay button, rather than one WARNING
 * activity row among thousands that someone has to think to go and find.
 *
 * The row is a `shopping_sync_logs` row, the same mechanism the product
 * structure conflicts use (o3d-y89x). Its entityType is DELIBERATELY not
 * 'SalesOrder': the refund-sync park query selects FROM_CONNECTOR/SalesOrder
 * rows by status, so a fulfilment refusal filed under that type would surface in
 * the inbox as a parked refund and offer a "retry refund sync" button that would
 * do nothing of the sort.
 */
export const EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE = 'SalesOrderFulfillment'

/**
 * `true` means re-delivering the identical payload reaches the identical
 * conclusion, so the delivery should be acknowledged and the refusal put in
 * front of an operator rather than retried into a dead letter.
 *
 * Only the stock refusal qualifies today. The rest are internal failures — a
 * lock race, a transaction that lost, an order the importer has not committed
 * yet — where the next attempt genuinely may differ, and o3d-i0y's rule is that
 * only a genuinely retryable failure may become a 5xx.
 */
export function isPermanentExternalFulfillmentRefusal(
  reason: ExternalFulfillmentRefusalReason | undefined,
): boolean {
  return reason === 'insufficient-stock'
}

/** Open refusals, optionally for one order. QUARANTINED = deliberately parked, awaiting an operator. */
export function buildExternalFulfillmentRefusalWhere(orderId?: string) {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR' as const,
    entityType: EXTERNAL_FULFILLMENT_REFUSAL_ENTITY_TYPE,
    status: 'QUARANTINED' as const,
    ...(orderId ? { entityId: orderId } : {}),
  }
}
