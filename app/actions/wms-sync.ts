'use server'

import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from '@/lib/connectors/wms/types'
import type { MintsoftDashboardData } from '@/app/actions/mintsoft-sync'

/**
 * Connector-agnostic /sync WMS panel data. The dashboard reads
 * `connectorId`/`configured` generically and hands the nested per-connector
 * payload to the matching panel in app/(dashboard)/sync/wms-sync-panel.tsx.
 * Returns null when no WMS connector is enabled (mirrors the prior
 * `pluginState.mintsoft ? data : null` gate). Adding a connector means filling a
 * branch here + a panel there; the sync page/dashboard logic stays generic.
 */
export type WmsSyncDashboardData = {
  connectorId: WmsConnectorId
  configured: boolean
  mintsoft: MintsoftDashboardData | null
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
  const connectorId = activeConnectorId !== undefined
    ? activeConnectorId
    : await resolveEnabledWmsConnectorId()
  if (!connectorId) return null

  if (connectorId === 'mintsoft') {
    const { getMintsoftDashboardData } = await import('@/app/actions/mintsoft-sync')
    const mintsoft = await getMintsoftDashboardData()
    return {
      connectorId,
      configured: Boolean(mintsoft.status.configured),
      mintsoft,
    }
  }

  return null
}
