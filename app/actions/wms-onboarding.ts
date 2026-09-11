'use server'

import { requirePermission } from '@/lib/auth/server'
import { getActiveWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { findWmsConnector, findWmsConnectorLabel, getWmsConnectorHooks } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS, type WmsConnectorId } from '@/lib/connectors/wms/types'

/**
 * Connector-agnostic onboarding connection-data envelope.
 *
 * o3d-remove-shiphero round 4 (Codex HIGH 2) — WHY THIS IS NOT AN `id === 'mintsoft'` CHECK.
 * The fall-through arm here returned `configured: false` for any other registered connector. That
 * is not an empty answer, it is a WRONG one: the wizard shows an unticked setup step for a
 * connection that is already live, and an operator who "fixes" it re-enters credentials that were
 * never missing. Same shape as the ASN facade's "No WMS connector is enabled." — a one-arm
 * dispatcher telling every connector but one that it does not exist.
 *
 * It now routes on CAPABILITY: does the active connector declare an onboarding step? A connector
 * with no setup form of its own renders no form.
 *
 * o3d-remove-shiphero round 8 (Codex HIGH 1) — AND IT NO LONGER ANSWERS `configured: false` WHILE
 * DOING SO. Round 4 replaced one wrong answer with a narrower one: the no-hook arm still reported
 * an unset connection for a connector whose connection is live and merely has no setup form in this
 * build. The wizard therefore showed an unticked step, and the operator's remedy for an unticked
 * step is to re-enter credentials that were never missing — the exact failure the round-4 note
 * above describes, surviving the round-4 fix. `configured` is now read from `isConfigured()`, the
 * one mandatory statement a connector makes about its own connection, on every path.
 *
 * THE DTO IS KEYED BY CONNECTOR. It used to carry `mintsoft: … | null`, read by name in
 * components/onboarding/wms-onboarding-connection.tsx; see app/actions/wms-sync.ts for why a second
 * named member would have been the same defect with one more arm.
 *
 * `findWmsConnectorLabel` (not `getDef`) so an id from a connector this build no longer ships
 * degrades to its own id rather than throwing from inside a read.
 *
 * o3d-512h round 3 — the no-connector arm answered from this module, after getActiveWmsConnectorId
 * had already read plugin state, to any authenticated principal. Delegate:
 * mintsoft-sync.ts:getMintsoftOnboardingConnectionData → requireMintsoftReadAccess() →
 * requirePermission('sync').
 */
export type WmsOnboardingConnectionData = {
  connectorId: WmsConnectorId
  connectorLabel: string
  /** Whether the CONNECTION is set up. State, not capability — see the note above and wms-sync.ts. */
  configured: boolean
  /**
   * The active connector's own connection payload, under its own id. Read only by the matching form
   * in components/onboarding/wms-onboarding-connection.tsx.
   */
  connectorData: Partial<Record<WmsConnectorId, unknown>>
}

export async function getWmsOnboardingConnectionData(): Promise<WmsOnboardingConnectionData> {
  await requirePermission('sync')
  const connectorId = (await getActiveWmsConnectorId()) ?? WMS_CONNECTOR_IDS[0]
  const connectorLabel = findWmsConnectorLabel(connectorId) ?? connectorId

  // Read on EVERY path, before the capability question, for the reason spelled out in wms-sync.ts.
  const connector = findWmsConnector(connectorId)
  const configured = connector !== null && await connector.isConfigured()

  const hook = getWmsConnectorHooks(connectorId).onboarding
  if (!hook) return { connectorId, connectorLabel, configured, connectorData: {} }

  return {
    connectorId,
    connectorLabel,
    configured,
    connectorData: { [connectorId]: (await (await hook()).getConnectionData()).form },
  }
}
