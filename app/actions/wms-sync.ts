'use server'

import { requirePermission } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
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
 * does not is reported as resolved-but-unconfigured rather than as absent, because those call for
 * different things from an operator (enable a WMS / finish setting this one up).
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

  const hook = getWmsConnectorHooks(connectorId).syncDashboard
  if (!hook) return { connectorId, configured: false, connectorData: {} }

  const dashboard = await (await hook()).getDashboardData()
  return {
    connectorId,
    configured: dashboard.configured,
    connectorData: { [connectorId]: dashboard.panel },
  }
}
