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

export async function getWmsSyncDashboardData(): Promise<WmsSyncDashboardData | null> {
  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
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
