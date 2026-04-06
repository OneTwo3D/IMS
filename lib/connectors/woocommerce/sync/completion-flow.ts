/**
 * WC "completed" → IMS auto-allocate + ship flow.
 *
 * When WooCommerce marks an order as completed (e.g. payment gateway or admin),
 * this flow auto-allocates stock, creates shipments, and ships them with tracking.
 * Designed to be re-entrant: skips already-completed steps.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import type { WcFullOrder } from './types'
import { extractWcTracking } from './field-mapping'

export async function processWcCompletion(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  const so = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: { id: true, wcOrderNumber: true, status: true },
  })
  if (!so) return

  // Step 1: Auto-allocate if not already allocated
  const allocCount = await db.orderAllocation.count({ where: { orderId } })
  if (allocCount === 0) {
    const { autoAllocateOrder } = await import('@/app/actions/allocation')
    await autoAllocateOrder(orderId)
  }

  // Step 2: Create shipments if none exist
  const shipmentCount = await db.shipment.count({ where: { orderId } })
  if (shipmentCount === 0) {
    const { confirmAllocations } = await import('@/app/actions/allocation')
    await confirmAllocations(orderId)
  }

  // Step 3: Extract tracking from WC order meta
  const wcTracking = extractWcTracking(wcOrder)

  // Step 4: Ship all pending shipments
  const shipments = await db.shipment.findMany({
    where: { orderId, status: { not: 'SHIPPED' } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  })

  const { updateShipmentStatus } = await import('@/app/actions/allocation')

  for (let i = 0; i < shipments.length; i++) {
    const shipment = shipments[i]
    // Assign tracking: distribute WC tracking entries across shipments
    const tracking = wcTracking[i] ?? wcTracking[0]
    const extra = tracking ? { trackingNumber: tracking.trackingNumber, shippingService: tracking.carrier } : undefined

    // Progress through states sequentially
    const transitions: string[] = []
    if (shipment.status === 'PENDING') transitions.push('PICKING', 'PACKED', 'SHIPPED')
    else if (shipment.status === 'PICKING') transitions.push('PACKED', 'SHIPPED')
    else if (shipment.status === 'PACKED') transitions.push('SHIPPED')

    for (const target of transitions) {
      const result = await updateShipmentStatus(
        shipment.id,
        target,
        target === 'SHIPPED' ? extra : undefined,
      )
      if (!result.success) {
        logActivity({
          entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_completion_error', tag: 'sync', level: 'WARNING',
          description: `WC completion flow: failed to transition shipment to ${target}: ${result.error}`,
          metadata: { shipmentId: shipment.id, target, error: result.error },
        })
        break // stop this shipment, try next
      }
    }
  }

  // Step 5: If order is not yet COMPLETED/SHIPPED, update it
  const updated = await db.salesOrder.findUnique({ where: { id: orderId }, select: { status: true } })
  if (updated && !['SHIPPED', 'COMPLETED', 'DELIVERED'].includes(updated.status)) {
    await db.salesOrder.update({ where: { id: orderId }, data: { status: 'COMPLETED' } })
  }

  logActivity({
    entityType: 'SALES_ORDER', entityId: orderId, action: 'wc_completion_processed', tag: 'sync', level: 'INFO',
    description: `Processed WC completion for order #${so.wcOrderNumber} — ${shipments.length} shipment(s) shipped`,
    metadata: { wcOrderId: wcOrder.id, shipmentsProcessed: shipments.length, trackingEntries: wcTracking.length },
  })
}
