import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from './types'

/**
 * Resolve which WMS connector the app should route receiving/ASN flows through.
 *
 * Prefers an enabled WMS connector. When none is enabled it falls back to the
 * sole registered connector (if there is exactly one) so that historical state
 * still resolves through that connector's implementation — preserving the prior
 * single-connector behaviour where the PO/transfer views always queried it and
 * let the connector report its own "disabled" state. Returns null only when the
 * choice is genuinely ambiguous (0 enabled and >1 registered connectors).
 */
export async function getActiveWmsConnectorId(): Promise<WmsConnectorId | null> {
  const state = await getIntegrationPluginState()
  const enabled = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (enabled) return enabled
  return WMS_CONNECTOR_IDS.length === 1 ? WMS_CONNECTOR_IDS[0] : null
}
