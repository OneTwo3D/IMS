'use server'

import { requirePermission } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { findWmsConnector, findWmsConnectorLabel, getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from '@/lib/connectors/wms/types'

/**
 * Connector-agnostic /sync WMS panel data.
 *
 * o3d-remove-shiphero round 4 (Codex HIGH 2) — WHY THIS IS NOT AN `id === 'mintsoft'` CHECK.
 * This facade used to dispatch only when the active connector was literally one id, and fall
 * through to `return null` otherwise. `null` is the SAME answer the facade gives when no WMS
 * connector is enabled at all, so a second enabled, registered, fully configured connector showed
 * the operator an empty Integrations panel that is indistinguishable from "you have no WMS". The
 * one-arm dispatcher is a switch that compiles fine and makes the id meaningless — see the same
 * note on app/actions/wms-asn.ts.
 *
 * It now routes on CAPABILITY: does the active connector declare a sync dashboard? A connector that
 * does not is reported as resolved-but-panel-less rather than as absent, because those call for
 * different things from an operator (enable a WMS / administer this one elsewhere).
 *
 * o3d-remove-shiphero round 8 (Codex HIGH 1) — AND CAPABILITY IS NOT STATE. Round 6's no-hook arm
 * answered `configured: false`, which is a claim about the CONNECTION, from a branch that had only
 * established something about the BUILD. `configured` is now read from `isConfigured()` — the one
 * mandatory method on the connector contract — on every path, before the hook is even looked up.
 *
 * THE DTO IS KEYED BY CONNECTOR, not by a named member. It used to carry `mintsoft: … | null`,
 * which the sync dashboard read by name — and that member, not the dispatch, was what actually
 * blocked the move onto hooks: a second connector would have needed a second named member, which is
 * the same defect with one more arm. `connectorData` is keyed by the id that produced the payload,
 * so adding a connector adds a registry entry and a panel, and this file never changes.
 *
 * `null` now means exactly one thing: no WMS connector is enabled.
 *
 * o3d-512h round 3 — `return null` when no WMS connector is enabled is still an answer about the
 * tenant's configuration, and resolveEnabledWmsConnectorId reads plugin state to produce it.
 * Delegate: mintsoft-sync.ts:getMintsoftDashboardData → requireMintsoftReadAccess() →
 * requirePermission('sync').
 */
export type WmsSyncDashboardData = {
  connectorId: WmsConnectorId
  /**
   * The active connector's registered display name (o3d-remove-shiphero round 6, Codex HIGH 1).
   *
   * Carried in the DTO, as the onboarding envelope already carries it, because the /sync panel is
   * a CLIENT component and cannot read the registry: without this it had nothing but the raw id to
   * put in front of an operator when the connector is one it ships no panel for — which is
   * precisely the case in which a human-readable name matters most. `findWmsConnectorLabel`, not
   * `getDef`, so an id from a connector this build no longer ships degrades to its own id rather
   * than throwing from inside a read.
   */
  connectorLabel: string
  /**
   * Whether the ACTIVE CONNECTOR'S CONNECTION is set up — a fact about STATE, read from the one
   * mandatory statement a connector makes about itself (o3d-remove-shiphero round 8, Codex HIGH 1).
   *
   * It is NOT a fact about capability, and round 6 shipped it conflated with one: the no-hook arm
   * below answered `configured: false` for a connector that simply declares no dashboard, so a
   * live, correctly configured warehouse was described to the operator as "not set up" — beside a
   * header naming it and under an enable switch that was on. The remedy an operator takes from
   * "not set up" is to re-enter credentials that were never missing.
   *
   * `connectorData` is the capability statement: empty means "this connector ran no panel". The two
   * facts are now carried by two fields with two sources, and neither branch of this file writes
   * this one.
   */
  configured: boolean
  /**
   * The active connector's own panel payload, under its own id. Read only by the matching panel in
   * app/(dashboard)/sync/wms-sync-panel.tsx, which is the file whose job it is to know the shape.
   */
  connectorData: Partial<Record<WmsConnectorId, unknown>>
}

async function resolveEnabledWmsConnectorId(): Promise<WmsConnectorId | null> {
  const state = await getIntegrationPluginState()
  return WMS_CONNECTOR_IDS.find((id) => state[id]) ?? null
}

/**
 * @param activeConnectorId the enabled WMS connector the caller already resolved
 *   (the /sync page reads plugin state for its enable gate and passes it here so
 *   state is read once). Omit it and the facade resolves it itself.
 */
export async function getWmsSyncDashboardData(
  activeConnectorId?: WmsConnectorId | null,
): Promise<WmsSyncDashboardData | null> {
  await requirePermission('sync')
  const connectorId = activeConnectorId !== undefined
    ? activeConnectorId
    : await resolveEnabledWmsConnectorId()
  if (!connectorId) return null

  const connectorLabel = findWmsConnectorLabel(connectorId) ?? connectorId

  // ONE READ, ON EVERY PATH, BEFORE THE CAPABILITY QUESTION IS ASKED AT ALL. Whether the connection
  // is set up does not depend on whether this build ships a panel for it, so it is not resolved
  // inside either arm below. `findWmsConnector` rather than `getWmsConnector`: an id left behind by
  // a connector this build no longer ships is unconfigurable, not a throw from inside a read.
  const connector = findWmsConnector(connectorId)
  const configured = connector !== null && await connector.isConfigured()

  const hook = getWmsConnectorHooks(connectorId).syncDashboard
  if (!hook) return { connectorId, connectorLabel, configured, connectorData: {} }

  return {
    connectorId,
    connectorLabel,
    configured,
    connectorData: { [connectorId]: (await (await hook()).getDashboardData()).panel },
  }
}
