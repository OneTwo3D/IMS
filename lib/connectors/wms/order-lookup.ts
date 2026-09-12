import { db } from '@/lib/db'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'
import { inferShoppingOrderLookupConnector } from '@/lib/fulfillment/shopping-order-lookup'
import type { WmsConnectorId } from './types'

// Re-exported for back-compat; the canonical definition lives in ./types (a
// server-free module, so client components can import the guard too).
export { isWmsConnectorId } from './types'

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
export type WmsOrderLookupPort = {
  /** The earliest-created connection row for this connector id, or null. */
  findConnection(connector: string): Promise<{ orderLookupConnector: string | null } | null>
}

const prismaPort: WmsOrderLookupPort = {
  findConnection: (connector) => db.wmsConnection.findFirst({
    where: { connector },
    orderBy: [{ createdAt: 'asc' }],
    select: { orderLookupConnector: true },
  }),
}

/**
 * `connector` is a plain string, not `WmsConnectorId`: a WmsConnection row can name a connector
 * this build no longer ships, and the answer for such a row is "no configured lookup", not a
 * type error at the call site that reads it.
 *
 * `port` exists so this can be driven without a database — the second-connector seam test asks it
 * about a FICTITIOUS connector and asserts the query is filtered on the id it was ASKED about. The
 * failure mode that guards against is a resolver pinned to Mintsoft's row, which would link a
 * second warehouse's fulfilments to the wrong storefront.
 */
export async function resolveWmsOrderLookupConnector(
  connector: WmsConnectorId | string,
  port: WmsOrderLookupPort = prismaPort,
): Promise<ShoppingConnectorId | null> {
  const connection = await port.findConnection(connector)
  return inferShoppingOrderLookupConnector(connection?.orderLookupConnector ?? null)
}
