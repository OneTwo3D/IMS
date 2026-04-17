/**
 * WC "completed" → IMS shipment workflow.
 *
 * WooCommerce is treated as the dispatch authority for external storefront
 * orders. When an order is marked completed in Woo, the IMS auto-allocates,
 * creates shipment rows, and advances those shipments to SHIPPED with tracking.
 */

import type { WcFullOrder } from './types'
import { extractWcTracking } from './field-mapping'
import { applyExternalFulfillmentUpdate } from '@/lib/fulfillment/external-fulfillment'

export async function processWcCompletion(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  const wcTracking = extractWcTracking(wcOrder)

  await applyExternalFulfillmentUpdate({
    source: 'woocommerce',
    lookup: { orderId },
    targetShipmentStatus: 'SHIPPED',
    tracking: wcTracking.map((row) => ({
      trackingNumber: row.trackingNumber,
      shippingService: row.carrier,
    })),
  })
}
