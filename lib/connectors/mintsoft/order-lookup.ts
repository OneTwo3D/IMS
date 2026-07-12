import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import type { ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

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

export async function inferMintsoftOrderLookupConnector(
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
