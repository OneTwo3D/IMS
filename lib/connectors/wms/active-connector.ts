import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from './types'

/**
 * Resolve which WMS connector the app should route receiving/ASN flows through.
 *
 * Prefers an enabled WMS connector. When none is enabled it falls back to the
 * first registered connector (the legacy default, Mintsoft) so that historical
 * single-connector deployments — which relied on this implicit fallback, where
 * the PO/transfer views always queried it and let the connector report its own
 * "disabled" state — keep routing through it. A second connector only becomes
 * active when its plugin is explicitly enabled. Order matters: the legacy
 * default must remain first in WMS_CONNECTOR_IDS.
 */
export async function getActiveWmsConnectorId(): Promise<WmsConnectorId | null> {
  const state = await getIntegrationPluginState()
  const enabled = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (enabled) return enabled
  return WMS_CONNECTOR_IDS[0] ?? null
}

/**
 * The ENABLED WMS connector, with no legacy fallback — exactly what
 * runWmsDispatchSweep resolves (o3d-bjc.12).
 *
 * getActiveWmsConnectorId() falls back to the first registered connector so the
 * historical single-connector deployments keep routing somewhere. That fallback
 * is wrong for anything that asks "is a sweep maintaining this?": with every
 * plugin disabled the sweep does not run, so its leftover state is not evidence
 * — and offering to bulk-quarantine links on it would exclude orders that come
 * straight back the moment the connector is re-enabled.
 */
export async function getEnabledWmsConnectorId(): Promise<WmsConnectorId | null> {
  const state = await getIntegrationPluginState()
  return WMS_CONNECTOR_IDS.find((id) => state[id]) ?? null
}
