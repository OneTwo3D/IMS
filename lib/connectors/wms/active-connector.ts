import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { enabledWmsConnectorId, resolveEnabledWmsConnector, type WmsConnectorResolution } from './enabled-connector'
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
  const resolution = await resolveActiveWmsConnector()
  return resolution.kind === 'one' ? resolution.id : null
}

/**
 * The same resolution, with the REASON kept (o3d-remove-shiphero round 10, Codex HIGH 1).
 *
 * `getActiveWmsConnectorId` collapses two very different states to `null`, and after this round
 * that is actively misleading: the legacy fallback means "nothing enabled" resolves to the first
 * registered connector, so `null` from that helper is reached ONLY by a contradictory enabled set
 * (or by a build that registers no connector at all). A caller that turns `null` into "No WMS
 * connector is enabled." would therefore print the one sentence that is certainly false in the one
 * state that reaches it — the same shape as the finding this round is fixing. Callers that put a
 * sentence in front of an operator take this; callers that only need an id take the helper above.
 */
export async function resolveActiveWmsConnector(): Promise<WmsConnectorResolution> {
  const resolution = resolveEnabledWmsConnector(await getIntegrationPluginState())
  // AMBIGUOUS IS NOT "NONE", SO IT DOES NOT TAKE THE FALLBACK. The fallback exists for a deployment
  // that has never enabled anything, where the legacy default is the only sensible route. With two
  // connectors enabled there IS a selection — it is just contradictory, and resolving it to the
  // first registered connector is precisely the silent winner-picking this resolver stops.
  if (resolution.kind !== 'none') return resolution
  const fallback = WMS_CONNECTOR_IDS[0]
  return fallback ? { kind: 'one', id: fallback } : { kind: 'none' }
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
  return enabledWmsConnectorId(await getIntegrationPluginState())
}
