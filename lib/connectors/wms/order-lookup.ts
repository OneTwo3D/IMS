import { db } from '@/lib/db'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { inferShoppingOrderLookupConnector } from '@/lib/fulfillment/shopping-order-lookup'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from './types'

export function isWmsConnectorId(value: string | null | undefined): value is WmsConnectorId {
  return value != null && (WMS_CONNECTOR_IDS as readonly string[]).includes(value)
}

/**
 * For a WMS-sourced fulfillment event, resolve which shopping connector the
 * WMS's orders are linked to. A WMS references the storefront order rather than
 * owning its own ShoppingOrderLink, so we read the WMS connection's configured
 * orderLookupConnector and infer the backing shopping connector from it.
 *
 * Matches the legacy Mintsoft behaviour: picks the earliest-created connection
 * row for the connector (no active filter) so an explicitly configured
 * orderLookupConnector is honoured regardless of the connection's active flag.
 */
export async function resolveWmsOrderLookupConnector(
  connector: WmsConnectorId,
): Promise<ShoppingConnectorId | null> {
  const connection = await db.wmsConnection.findFirst({
    where: { connector },
    orderBy: [{ createdAt: 'asc' }],
    select: { orderLookupConnector: true },
  })
  return inferShoppingOrderLookupConnector(connection?.orderLookupConnector ?? null)
}
