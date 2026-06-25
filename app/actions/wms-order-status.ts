'use server'

import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'
import type { WmsOrderStatus } from '@/lib/connectors/wms/types'

export type WmsOrderStatusView = WmsOrderStatus & { connectorLabel: string }

/**
 * Live WMS order status for an IMS sales order, for the read-only status chip.
 *
 * Connector-agnostic: resolves the active WMS connector, then the storefront
 * order number it knows the order by — via the WMS connection's
 * orderLookupConnector and that connector's ShoppingOrderLink (never scanning
 * links across connectors) — and asks the connector for the live status. Any
 * WMS/API failure resolves to null so the sales view never breaks.
 */
export async function getWmsOrderStatusForSalesOrder(salesOrderId: string): Promise<WmsOrderStatusView | null> {
  await requireAuth()

  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return null

  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) return null

  const lookupConnector = await resolveWmsOrderLookupConnector(connectorId)
  if (!lookupConnector) return null

  const link = await db.shoppingOrderLink.findUnique({
    where: { connector_orderId: { connector: lookupConnector, orderId: salesOrderId } },
    select: { externalOrderNumber: true },
  })
  const reference = link?.externalOrderNumber?.trim()
  if (!reference) return null

  try {
    const status = await connector.fetchOrderStatus(reference)
    if (!status) return null
    return { ...status, connectorLabel: getWmsConnectorDef(connectorId).label }
  } catch {
    // Read-only/alert: a WMS lookup failure must not break the sales-order view.
    return null
  }
}
