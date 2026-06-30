import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'
import type { SalesOrderStatus } from '@/lib/domain/workflows/status-types'
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

/**
 * Whether to push the storefront status forward (→ "completed" for WooCommerce) after a
 * fulfilment update. Only for a WMS-sourced dispatch that just brought the order to
 * SHIPPED — a storefront-sourced update already has the storefront as the source of truth
 * (pushing back would echo), and a partial dispatch leaves the order pre-SHIPPED. This is
 * what makes the storefront fire its customer despatch email (e.g. AST on →completed).
 *
 * Restricted to SHIPPED (not COMPLETED/DELIVERED): those later states have no WC status
 * mapping (IMS_TO_WC) so a push would silently no-op — and a SHIPPED order has already
 * driven the WC completion, so there's nothing more to push.
 */
export function shouldPushStorefrontCompletion(
  source: ExternalFulfillmentSource,
  targetShipmentStatus: ExternalShipmentStatus,
  orderStatus: string,
): boolean {
  return targetShipmentStatus === 'SHIPPED'
    && isWmsConnectorId(source)
    && orderStatus === 'SHIPPED'
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

  // When a WMS dispatch has fully shipped the order, push the storefront status
  // forward (SHIPPED → WooCommerce "completed") so the storefront fires its customer
  // despatch email — e.g. Advanced Shipment Tracking emails the tracking on the
  // →completed transition, not on a raw tracking-meta write. Writing the tracking meta
  // alone (above) leaves the WC order in its prior status and the customer un-emailed.
  // Gated to WMS sources: a storefront-sourced fulfilment already has the storefront as
  // the source of truth, so pushing status back would just echo.
  if (update.targetShipmentStatus === 'SHIPPED' && isWmsConnectorId(update.source)) {
    const current = await db.salesOrder.findUnique({ where: { id: order.id }, select: { status: true } })
    if (current && shouldPushStorefrontCompletion(update.source, update.targetShipmentStatus, current.status)) {
      // Best-effort: the shipment + tracking are already applied; a failed status push
      // must not fail the dispatch. But log it — a missed completion = a missed customer
      // despatch email, which would otherwise be invisible.
      const logCompletionPushFailure = (detail: string) =>
        logActivity({
          entityType: 'SALES_ORDER',
          entityId: order.id,
          action: 'wc_completion_push_failed',
          tag: 'sync',
          level: 'WARNING',
          description: `Storefront completion push failed for despatched order ${order.externalOrderNumber ?? order.orderNumber ?? order.id}: ${detail} — customer despatch email may not have fired`,
          metadata: { source: update.source },
          resolveUser: false,
        }).catch(() => {})
      try {
        const { pushSalesOrderStatus } = await import('@/lib/shopping')
        const pushResult = await pushSalesOrderStatus(order.id, current.status as SalesOrderStatus)
        if (!pushResult.success) await logCompletionPushFailure(pushResult.error ?? 'unknown error')
      } catch (error) {
        await logCompletionPushFailure(error instanceof Error ? error.message : 'unexpected error')
      }
    }
  }

  return { success: true }
}
