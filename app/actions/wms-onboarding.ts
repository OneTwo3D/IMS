'use server'

import { getActiveWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from '@/lib/connectors/wms/types'
import type { MintsoftOnboardingConnectionData } from '@/app/actions/mintsoft-sync'

/**
 * Connector-agnostic onboarding connection-data envelope. The setup wizard reads
 * `connectorId`/`connectorLabel`/`configured` generically; the connector-specific
 * connection payload is nested under the connector key and consumed only by the
 * matching form in components/onboarding/wms-onboarding-connection.tsx. Adding a
 * 2nd WMS connector means filling a new branch here + a new form there — the
 * onboarding page/step need no edits.
 */
export type WmsOnboardingConnectionData = {
  connectorId: WmsConnectorId
  connectorLabel: string
  configured: boolean
  mintsoft: MintsoftOnboardingConnectionData | null
}

export async function getWmsOnboardingConnectionData(): Promise<WmsOnboardingConnectionData> {
  const connectorId = (await getActiveWmsConnectorId()) ?? WMS_CONNECTOR_IDS[0]

  if (connectorId === 'mintsoft') {
    const { getMintsoftOnboardingConnectionData } = await import('@/app/actions/mintsoft-sync')
    const mintsoft = await getMintsoftOnboardingConnectionData()
    return {
      connectorId,
      connectorLabel: getWmsConnectorDef(connectorId).label,
      configured: mintsoft.status.configured,
      mintsoft,
    }
  }

  return {
    connectorId,
    connectorLabel: getWmsConnectorDef(connectorId).label,
    configured: false,
    mintsoft: null,
  }
}
