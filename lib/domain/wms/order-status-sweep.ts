import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'

/**
 * Connector-agnostic WMS order-status sweep. Refreshes the cached snapshot for
 * in-flight sales orders linked to the active WMS connector's order-lookup
 * connector, so the sales-list chips read cached status instead of making a live
 * call per row. The detail view stays live (getWmsOrderStatusForSalesOrder).
 */

// Sales orders past these IMS statuses no longer need WMS status polling.
const TERMINAL_SALES_STATUSES = ['COMPLETED', 'DELIVERED', 'CANCELLED'] as const
const DEFAULT_STALE_MINUTES = 30
const DEFAULT_BATCH_SIZE = 50

export type WmsOrderStatusSweepResult = {
  skipped?: string
  scanned: number
  updated: number
  failed: number
}

export async function runWmsOrderStatusSweep(
  options?: { batchSize?: number; staleMinutes?: number },
): Promise<WmsOrderStatusSweepResult> {
  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { skipped: 'No WMS connector enabled', scanned: 0, updated: 0, failed: 0 }

  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { skipped: 'Active WMS connector has no order-status support', scanned: 0, updated: 0, failed: 0 }
  }

  const lookupConnector = await resolveWmsOrderLookupConnector(connectorId)
  if (!lookupConnector) return { skipped: 'No order-lookup connector resolved', scanned: 0, updated: 0, failed: 0 }

  const staleMinutes = options?.staleMinutes ?? DEFAULT_STALE_MINUTES
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000)
  const connectorLabel = getWmsConnectorDef(connectorId).label

  const orders = await db.salesOrder.findMany({
    where: {
      status: { notIn: [...TERMINAL_SALES_STATUSES] },
      shoppingLinks: { some: { connector: lookupConnector, externalOrderNumber: { not: null } } },
      OR: [
        { wmsOrderStatus: { is: null } },
        { wmsOrderStatus: { fetchedAt: { lt: staleBefore } } },
      ],
    },
    select: {
      id: true,
      shoppingLinks: {
        where: { connector: lookupConnector },
        select: { externalOrderNumber: true },
        take: 1,
      },
      // Last status pushed to the storefront, to push only on change (G4). Tracked
      // separately from `status` so a failed push isn't masked by the change gate.
      wmsOrderStatus: { select: { wcPushedStatus: true } },
    },
    take: batchSize,
    orderBy: { updatedAt: 'desc' },
  })

  let updated = 0
  let failed = 0

  for (const order of orders) {
    const reference = order.shoppingLinks[0]?.externalOrderNumber?.trim()
    if (!reference) continue

    try {
      const status = await connector.fetchOrderStatus(reference)
      const tracking = status?.tracking.find((entry) => entry.trackingNumber || entry.carrier)

      const fields = status
        ? {
            connector: connectorId,
            connectorLabel,
            externalOrderId: status.externalOrderId,
            externalOrderNumber: status.externalOrderNumber,
            status: status.status,
            statusLabel: status.statusLabel,
            isSplit: status.isSplit,
            partCount: status.partCount,
            isMerged: status.isMerged,
            mergedOrderNumbers: status.mergedOrderNumbers,
            deepLinkUrl: status.deepLinkUrl,
            trackingNumber: tracking?.trackingNumber ?? null,
            carrier: tracking?.carrier ?? null,
            lastError: null,
          }
        : {
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            isSplit: false,
            partCount: null,
            isMerged: false,
            mergedOrderNumbers: [],
            deepLinkUrl: null,
            trackingNumber: null,
            carrier: null,
            lastError: 'Order not found in WMS',
          }

      await db.wmsOrderStatusSnapshot.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, ...fields },
        update: { ...fields, fetchedAt: new Date() },
      })
      if (status) updated += 1

      // G4: surface the WMS status in the storefront admin (the companion plugin renders
      // `_oti_wms_*` meta). Push only when it changed vs the LAST SUCCESSFUL push — so a
      // transient WC failure retries next tick instead of being permanently skipped.
      // Best-effort: a failed push must not fail the status sweep, but it is logged and
      // wcPushedStatus is left unchanged so it's re-attempted.
      if (status && status.status && status.status !== order.wmsOrderStatus?.wcPushedStatus) {
        try {
          const { pushWmsOrderStatusToShopping } = await import('@/lib/shopping')
          const pushResult = await pushWmsOrderStatusToShopping(order.id, {
            status: status.status,
            statusLabel: status.statusLabel,
            connectorLabel,
            deepLinkUrl: status.deepLinkUrl,
          })
          if (pushResult.success) {
            await db.wmsOrderStatusSnapshot.update({
              where: { orderId: order.id },
              data: { wcPushedStatus: status.status },
            }).catch(() => {})
          } else if (!pushResult.skipped) {
            console.warn(`[wms-order-status-sweep] storefront WMS-status push failed for order ${order.id}: ${pushResult.error}`)
          }
        } catch (pushError) {
          console.error('[wms-order-status-sweep] storefront WMS-status push errored', pushError)
        }
      }
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'WMS order-status sweep failed'
      await db.wmsOrderStatusSnapshot
        .upsert({
          where: { orderId: order.id },
          create: {
            orderId: order.id,
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            lastError: message,
          },
          update: { fetchedAt: new Date(), lastError: message },
        })
        .catch(() => {})
    }
  }

  return { scanned: orders.length, updated, failed }
}
