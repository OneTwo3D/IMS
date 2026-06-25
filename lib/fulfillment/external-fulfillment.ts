import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'
import { isShoppingConnectorId } from '@/lib/fulfillment/shopping-order-lookup'
import { isWmsConnectorId, resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'

// A fulfillment update originates from either a storefront (shopping) connector
// that owns the order's ShoppingOrderLink, or a WMS/3PL connector that
// references a storefront order. Derived from the connector registries so a new
// connector is included without editing this core flow.
export type ExternalFulfillmentSource = ShoppingConnectorId | WmsConnectorId
export type ExternalShipmentStatus = 'PENDING' | 'PICKING' | 'PACKED' | 'SHIPPED'

export type ExternalFulfillmentLookup =
  | { orderId: string }
  | { externalOrderId: number }
  | { externalOrderNumber: string }
  | { orderNumber: string }

export type ExternalFulfillmentUpdate = {
  source: ExternalFulfillmentSource
  lookup: ExternalFulfillmentLookup
  targetShipmentStatus: ExternalShipmentStatus
  tracking?: Array<{ trackingNumber: string; shippingService?: string | null }>
}

type ResolvedOrder = {
  id: string
  orderNumber: string | null
  externalOrderNumber: string | null
  status: string
}

async function resolveShoppingConnectorForSource(
  source: ExternalFulfillmentSource,
): Promise<ShoppingConnectorId | null> {
  if (isShoppingConnectorId(source)) return source
  if (isWmsConnectorId(source)) return resolveWmsOrderLookupConnector(source)
  return null
}

export async function resolveOrderForExternalFulfillment(
  source: ExternalFulfillmentSource,
  lookup: ExternalFulfillmentLookup,
): Promise<ResolvedOrder | null> {
  if ('orderId' in lookup) {
    return db.salesOrder.findUnique({
      where: { id: lookup.orderId },
      select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
    })
  }

  if ('externalOrderId' in lookup) {
    if (isWmsConnectorId(source)) {
      // WMS order IDs are the WMS's own internal identifiers, not the storefront
      // order IDs stored on shopping_order_links, so this lookup form is N/A.
      return null
    }

    const connector = await resolveShoppingConnectorForSource(source)
    if (!connector) return null

    const link = await db.shoppingOrderLink.findUnique({
      where: {
        connector_externalOrderId: {
          connector,
          externalOrderId: String(lookup.externalOrderId),
        },
      },
      select: {
        order: {
          select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
        },
      },
    })
    return link?.order ?? null
  }

  if ('externalOrderNumber' in lookup) {
    const connector = await resolveShoppingConnectorForSource(source)
    if (!connector) return null

    const link = await db.shoppingOrderLink.findFirst({
      where: {
        connector,
        externalOrderNumber: lookup.externalOrderNumber,
      },
      select: {
        order: {
          select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
        },
      },
    })
    return link?.order ?? null
  }

  return db.salesOrder.findFirst({
    where: { orderNumber: lookup.orderNumber },
    select: { id: true, orderNumber: true, externalOrderNumber: true, status: true },
  })
}

function statusesToApply(
  currentStatus: ExternalShipmentStatus,
  targetStatus: ExternalShipmentStatus,
): ExternalShipmentStatus[] {
  const flow: ExternalShipmentStatus[] = ['PENDING', 'PICKING', 'PACKED', 'SHIPPED']
  const start = flow.indexOf(currentStatus)
  const end = flow.indexOf(targetStatus)
  if (start === -1 || end === -1 || end <= start) return []
  return flow.slice(start + 1, end + 1)
}

export async function applyExternalFulfillmentUpdate(
  update: ExternalFulfillmentUpdate,
): Promise<{ success: boolean; error?: string }> {
  const order = await resolveOrderForExternalFulfillment(update.source, update.lookup)
  if (!order) {
    return { success: false, error: 'Order not found for external fulfillment update' }
  }

  const { autoAllocateOrder, confirmAllocations, updateShipmentStatus } = await import('@/app/actions/allocation')

  const allocationCount = await db.orderAllocation.count({ where: { orderId: order.id } })
  if (allocationCount === 0) {
    const result = await autoAllocateOrder(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return { success: false, error: result.error ?? 'Auto-allocation failed' }
    }
    if ((result.allocationCount ?? 0) === 0 && (result.unallocatedQty ?? 0) > 0) {
      return {
        success: false,
        error: `External fulfillment requires physical stock — order has ${result.unallocatedQty} unit(s) on backorder`,
      }
    }
  }

  const shipmentCount = await db.shipment.count({ where: { orderId: order.id } })
  if (shipmentCount === 0) {
    const result = await confirmAllocations(order.id, { internalBypassToken: INTERNAL_ACTION_BYPASS })
    if (!result.success) {
      return { success: false, error: result.error ?? 'Shipment creation failed' }
    }
  }

  const shipments = await db.shipment.findMany({
    where: { orderId: order.id, status: { not: update.targetShipmentStatus } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  })

  for (let index = 0; index < shipments.length; index++) {
    const shipment = shipments[index]
    const transitions = statusesToApply(shipment.status as ExternalShipmentStatus, update.targetShipmentStatus)
    // Use matched tracking entry for this shipment; only fall back to the
    // first entry when the array has exactly one element (single tracking
    // number for all shipments). When there are multiple tracking entries
    // but fewer than shipments, leave unmatched shipments without tracking
    // rather than silently reusing an arbitrary entry.
    const tracking = update.tracking?.[index]
      ?? (update.tracking?.length === 1 ? update.tracking[0] : undefined)

    for (const target of transitions) {
      const result = await updateShipmentStatus(
        shipment.id,
        target,
        target === 'SHIPPED' && tracking
          ? {
              trackingNumber: tracking.trackingNumber,
              shippingService: tracking.shippingService ?? undefined,
            }
          : undefined,
        { internalBypassToken: INTERNAL_ACTION_BYPASS },
      )

      if (!result.success) {
        await logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'external_fulfillment_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `${update.source} fulfillment update failed at ${target} for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}`,
          metadata: { source: update.source, shipmentId: shipment.id, target, error: result.error },
          resolveUser: false,
        })
        return { success: false, error: result.error ?? `Failed to update shipment to ${target}` }
      }
    }
  }

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: order.id,
    action: 'external_fulfillment_applied',
    tag: 'sync',
    level: 'INFO',
    description: `Applied ${update.source} fulfillment update to ${update.targetShipmentStatus} for order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}`,
    metadata: { source: update.source, targetShipmentStatus: update.targetShipmentStatus, shipmentsProcessed: shipments.length },
    resolveUser: false,
  })

  return { success: true }
}
