'use server'

import { db } from '@/lib/db'
import { requireInternalUser } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { enabledWmsConnectorId } from '@/lib/connectors/wms/enabled-connector'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'
import type { WmsOrderStatus } from '@/lib/connectors/wms/types'

// `dispatched` is a reconciliation signal (used by the dispatch sweep), not a display
// field — exclude it from the chip view so the cached-snapshot view need not store it.
export type WmsOrderStatusView = Omit<WmsOrderStatus, 'dispatched'> & { connectorLabel: string }

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
  await requireInternalUser()

  const state = await getIntegrationPluginState()
  // `enabledWmsConnectorId`, not "the first enabled one" (round 10, Codex HIGH 1). This read has one
  // way to decline — no chip — and it is the right answer both when no connector is enabled and
  // when the enabled set is contradictory: a chip resolved from a guessed connector would name a
  // warehouse that is not fulfilling the order.
  const connectorId = enabledWmsConnectorId(state)
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
