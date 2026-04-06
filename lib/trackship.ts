/**
 * TrackShip API integration for delivery tracking.
 *
 * Two modes:
 * 1. "woocommerce" — poll WC order meta for delivery status (WC has AST + TrackShip)
 * 2. "trackship" — query TrackShip API directly
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'

// ---------------------------------------------------------------------------
// TrackShip API (direct)
// ---------------------------------------------------------------------------

type TrackShipResponse = {
  tracking_number: string
  shipping_provider: string
  tracking_status: string // e.g. "delivered", "in_transit", "out_for_delivery", "exception"
  est_delivery_date?: string
  last_event?: string
  last_event_time?: string
}

export async function queryTrackShip(apiKey: string, trackingNumber: string, carrier: string): Promise<TrackShipResponse | null> {
  try {
    const res = await fetch('https://my.trackship.com/api/v1/get-tracking', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'trackship-api-key': apiKey,
      },
      body: JSON.stringify({
        tracking_number: trackingNumber,
        shipping_provider: carrier,
      }),
    })
    if (!res.ok) {
      logActivity({
        entityType: 'SYSTEM',
        action: 'trackship_error',
        tag: 'sync',
        level: 'ERROR',
        description: `TrackShip API error: ${res.status} ${res.statusText}`,
        metadata: { trackingNumber, carrier, status: res.status },
      })
      return null
    }
    const data = await res.json()
    return {
      tracking_number: trackingNumber,
      shipping_provider: carrier,
      tracking_status: data.tracking_status ?? data.shipment_status ?? 'unknown',
      est_delivery_date: data.est_delivery_date,
      last_event: data.last_event,
      last_event_time: data.last_event_time,
    }
  } catch (e) {
    logActivity({
      entityType: 'SYSTEM',
      action: 'trackship_error',
      tag: 'sync',
      level: 'ERROR',
      description: `TrackShip API request failed: ${String(e)}`,
      metadata: { trackingNumber, carrier },
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// WooCommerce AST delivery status — delegated to WC connector
// ---------------------------------------------------------------------------

// Import from WooCommerce connector module
import { getWcDeliveryStatus } from '@/lib/connectors/woocommerce/delivery'

// ---------------------------------------------------------------------------
// Check delivery status for all shipped orders
// ---------------------------------------------------------------------------

export async function checkDeliveryStatus(): Promise<{ checked: number; delivered: number }> {
  const settings = await db.setting.findMany({
    where: { key: { in: ['delivery_tracking_enabled', 'delivery_tracking_source', 'trackship_api_key', 'wc_url', 'wc_key', 'wc_secret'] } },
  })
  const settingsMap = new Map(settings.map((s) => [s.key, s.value]))

  if (settingsMap.get('delivery_tracking_enabled') !== 'true') return { checked: 0, delivered: 0 }

  const source = settingsMap.get('delivery_tracking_source') ?? 'trackship'

  // Find shipped orders with tracking numbers
  const shippedOrders = await db.salesOrder.findMany({
    where: {
      status: 'SHIPPED',
      trackingNumber: { not: null },
    },
    select: {
      id: true,
      wcOrderId: true,
      wcOrderNumber: true,
      trackingNumber: true,
      shippingService: true,
      shipments: {
        where: { status: 'SHIPPED', trackingNumber: { not: null } },
        select: { id: true, trackingNumber: true, shippingService: true },
      },
    },
  })

  let checked = 0
  let delivered = 0

  for (const order of shippedOrders) {
    let isDelivered = false

    if (source === 'woocommerce' && order.wcOrderId) {
      // Query WooCommerce connector for delivery status
      const result = await getWcDeliveryStatus(order.wcOrderId)
      if (result?.status === 'delivered') isDelivered = true
      checked++
    } else if (source === 'trackship') {
      // Query TrackShip API directly for each shipment tracking number
      const apiKey = settingsMap.get('trackship_api_key')
      if (!apiKey) continue

      // Check all shipment tracking numbers (or order-level tracking)
      const trackingEntries = order.shipments.length > 0
        ? order.shipments.map((s) => ({ tracking: s.trackingNumber!, carrier: s.shippingService ?? '' }))
        : order.trackingNumber ? [{ tracking: order.trackingNumber, carrier: order.shippingService ?? '' }] : []

      let allDelivered = trackingEntries.length > 0
      for (const entry of trackingEntries) {
        const result = await queryTrackShip(apiKey, entry.tracking, entry.carrier)
        if (result?.tracking_status !== 'delivered') {
          allDelivered = false
        }
        checked++
      }
      if (allDelivered && trackingEntries.length > 0) isDelivered = true
    }

    if (isDelivered) {
      await db.salesOrder.update({
        where: { id: order.id },
        data: { status: 'DELIVERED' },
      })
      delivered++
      logActivity({
        entityType: 'SALES_ORDER',
        entityId: order.id,
        action: 'delivered',
        tag: 'sales',
        level: 'INFO',
        description: `Order ${order.wcOrderNumber} marked as delivered via ${source}`,
        metadata: { orderNumber: order.wcOrderNumber, source },
      })
    }
  }

  return { checked, delivered }
}
