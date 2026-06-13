/**
 * TrackShip API integration for delivery tracking.
 *
 * Two modes:
 * 1. "shopping_connector" — poll the active shopping connector for delivery status
 * 2. "trackship" — query TrackShip API directly
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getOrderDeliveryStatus } from '@/lib/shopping'
import { INTERNAL_STATUS_TRANSITION_BYPASS } from '@/lib/sales/status-transition-bypass'

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
      await logActivity({
        entityType: 'SYSTEM',
        action: 'trackship_error',
        tag: 'sync',
        level: 'ERROR',
        description: `TrackShip API error: ${res.status} ${res.statusText}`,
        metadata: { trackingNumber, carrier, status: res.status },
        resolveUser: false,
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
    await logActivity({
      entityType: 'SYSTEM',
      action: 'trackship_error',
      tag: 'sync',
      level: 'ERROR',
      description: `TrackShip API request failed: ${String(e)}`,
      metadata: { trackingNumber, carrier },
      resolveUser: false,
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Mark a delivered order
// ---------------------------------------------------------------------------

type DeliveredTarget = { id: string; externalOrderNumber: string | null; source: string }
type MarkDeliveredDeps = {
  transition: (
    id: string,
    targetStatus: 'DELIVERED',
    extra: undefined,
    options: { internalBypassToken: symbol },
  ) => Promise<{ success: boolean; error?: string }>
  log: typeof logActivity
}

/**
 * Mark an order DELIVERED from a delivery-tracking poll.
 *
 * Routes through the real status-transition path rather than a raw status
 * write (audit C2): the transition re-validates under a lock — so an order
 * that moved to CANCELLED / REFUNDED / etc. between the SHIPPED query and now
 * is not silently overwritten — and runs the same side effects a manual
 * DELIVERED transition does (status_changed log, WooCommerce status push,
 * cache revalidation). The cron has no session, so it passes the internal
 * bypass token to skip the sales.process permission check while keeping the
 * guard and side effects. Dependency-injected so the routing + skip-on-reject
 * behaviour is unit-testable without the DB or external API.
 */
export async function markOrderDelivered(
  target: DeliveredTarget,
  deps: MarkDeliveredDeps,
): Promise<{ delivered: boolean }> {
  const result = await deps.transition(target.id, 'DELIVERED', undefined, {
    internalBypassToken: INTERNAL_STATUS_TRANSITION_BYPASS,
  })
  if (result.success) {
    await deps.log({
      entityType: 'SALES_ORDER',
      entityId: target.id,
      action: 'delivered',
      tag: 'sales',
      level: 'INFO',
      description: `Order ${target.externalOrderNumber} marked as delivered via ${target.source}`,
      metadata: { orderNumber: target.externalOrderNumber, source: target.source },
      resolveUser: false,
    })
    return { delivered: true }
  }
  // No longer in a state that can transition to DELIVERED (e.g. cancelled or
  // refunded after dispatch). Log and skip rather than forcing it.
  await deps.log({
    entityType: 'SALES_ORDER',
    entityId: target.id,
    action: 'delivery_status_skipped',
    tag: 'sales',
    level: 'WARNING',
    description: `Skipped marking order ${target.externalOrderNumber} delivered via ${target.source}: ${result.error ?? 'transition rejected'}`,
    metadata: { orderNumber: target.externalOrderNumber, source: target.source, error: result.error ?? null },
    resolveUser: false,
  })
  return { delivered: false }
}

// Check delivery status for all shipped orders
// ---------------------------------------------------------------------------

export async function checkDeliveryStatus(): Promise<{ checked: number; delivered: number }> {
  const settings = await db.setting.findMany({
    where: { key: { in: ['delivery_tracking_enabled', 'delivery_tracking_source', 'trackship_api_key'] } },
  })
  const settingsMap = new Map(settings.map((s) => [s.key, s.value]))

  if (settingsMap.get('delivery_tracking_enabled') !== 'true') return { checked: 0, delivered: 0 }

  const deliverySource = settingsMap.get('delivery_tracking_source') ?? 'trackship'
  const useShoppingConnector = deliverySource === 'woocommerce' || deliverySource === 'shopping_connector'

  // Find shipped orders with tracking numbers
  const shippedOrders = await db.salesOrder.findMany({
    where: {
      status: 'SHIPPED',
      trackingNumber: { not: null },
    },
    select: {
      id: true,
      externalOrderNumber: true,
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

    if (useShoppingConnector) {
      const result = await getOrderDeliveryStatus(order.id)
      if (result?.status === 'delivered') isDelivered = true
      checked++
    } else if (deliverySource === 'trackship') {
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
      const resolvedSource = useShoppingConnector ? 'shopping_connector' : 'trackship'
      const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')
      const result = await markOrderDelivered(
        { id: order.id, externalOrderNumber: order.externalOrderNumber, source: resolvedSource },
        { transition: applySalesOrderStatusTransition, log: logActivity },
      )
      if (result.delivered) delivered++
    }
  }

  return { checked, delivered }
}
