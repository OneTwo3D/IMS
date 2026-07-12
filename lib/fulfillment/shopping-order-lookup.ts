import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

/**
 * Connector-agnostic resolution of which shopping (storefront) connector an
 * order belongs to. Orders imported from a storefront are linked via
 * ShoppingOrderLink; a WMS/3PL never owns its own order links — it references
 * the storefront order — so WMS-sourced flows must resolve the backing
 * shopping connector before looking an order up.
 *
 * Lives in the generic fulfillment layer (not under any connector) so both the
 * WMS boundary and individual connectors can share it.
 */

export function isShoppingConnectorId(value: string | null | undefined): value is ShoppingConnectorId {
  return value === 'woocommerce' || value === 'shopify'
}

async function getObservedShoppingOrderLinkConnectors(): Promise<ShoppingConnectorId[]> {
  const rows = await db.shoppingOrderLink.findMany({
    where: {
      connector: {
        in: ['woocommerce', 'shopify'],
      },
    },
    distinct: ['connector'],
    select: { connector: true },
  })

  return rows
    .map((row) => row.connector)
    .filter(isShoppingConnectorId)
}

/**
 * Resolve the shopping connector to use for order lookup. Prefers an explicitly
 * persisted connector; otherwise infers it from the single observed
 * ShoppingOrderLink connector, falling back to the single enabled shopping
 * plugin. Returns null when the choice is ambiguous (0 or >1 candidates).
 */
export async function inferShoppingOrderLookupConnector(
  persistedConnector?: string | null,
): Promise<ShoppingConnectorId | null> {
  if (isShoppingConnectorId(persistedConnector)) {
    return persistedConnector
  }

  const observedConnectors = await getObservedShoppingOrderLinkConnectors()
  if (observedConnectors.length === 1) {
    return observedConnectors[0]
  }

  if (observedConnectors.length === 0) {
    const pluginState = await getIntegrationPluginState()
    const enabledConnectors = [pluginState.woocommerce ? 'woocommerce' : null, pluginState.shopify ? 'shopify' : null]
      .filter((value): value is ShoppingConnectorId => value !== null)
    return enabledConnectors.length === 1 ? enabledConnectors[0] : null
  }

  return null
}
