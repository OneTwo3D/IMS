'use server'

import { getActiveWmsConnectorId } from '@/lib/connectors/wms/active-connector'
import { getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import type {
  WmsPurchaseOrderAsnState,
  WmsTransferAsnState,
  WmsCreateAsnResult,
} from '@/lib/connectors/wms/asn-types'

/**
 * Connector-agnostic ASN server-action facade. Core PO/transfer flows call
 * these; the facade resolves the active WMS connector and dispatches to that
 * connector's implementation. Adding a new WMS connector means registering its
 * implementation here (one case), not editing the PO/transfer views.
 */

function disabledAsnState(): WmsPurchaseOrderAsnState {
  return {
    pluginEnabled: false,
    canCreate: false,
    canManage: false,
    blockedReason: null,
    destinationWarehouseCode: null,
    bindingExternalWarehouseId: null,
    existingAsns: [],
    connectorLabel: 'WMS',
  }
}

export async function getWmsPurchaseOrderAsnState(poId: string): Promise<WmsPurchaseOrderAsnState> {
  const connector = await getActiveWmsConnectorId()
  if (connector === 'mintsoft') {
    const { getMintsoftPurchaseOrderAsnState } = await import('@/app/actions/mintsoft-sync')
    const core = await getMintsoftPurchaseOrderAsnState(poId)
    return { ...core, connectorLabel: getWmsConnectorDef(connector).label }
  }
  return disabledAsnState()
}

export async function getWmsTransferAsnStates(
  transferIds: string[],
): Promise<Record<string, WmsTransferAsnState>> {
  const connector = await getActiveWmsConnectorId()
  if (connector === 'mintsoft') {
    const { getMintsoftTransferAsnStates } = await import('@/app/actions/mintsoft-sync')
    const states = await getMintsoftTransferAsnStates(transferIds)
    const connectorLabel = getWmsConnectorDef(connector).label
    return Object.fromEntries(
      Object.entries(states).map(([id, state]) => [id, { ...state, connectorLabel }]),
    )
  }
  return {}
}

export async function createWmsPurchaseOrderAsn(
  poId: unknown,
  input: unknown,
): Promise<WmsCreateAsnResult> {
  const connector = await getActiveWmsConnectorId()
  if (connector === 'mintsoft') {
    const { createMintsoftPurchaseOrderAsn } = await import('@/app/actions/mintsoft-sync')
    return createMintsoftPurchaseOrderAsn(poId, input)
  }
  return { success: false, error: 'No WMS connector is enabled.' }
}

export async function createWmsTransferAsn(
  transferId: unknown,
  input: unknown,
): Promise<WmsCreateAsnResult> {
  const connector = await getActiveWmsConnectorId()
  if (connector === 'mintsoft') {
    const { createMintsoftTransferAsn } = await import('@/app/actions/mintsoft-sync')
    return createMintsoftTransferAsn(transferId, input)
  }
  return { success: false, error: 'No WMS connector is enabled.' }
}

/**
 * o3d-hl8l: re-check an ASN's booked-in state directly with the warehouse.
 *
 * The recovery path behind the webhook's maintenance-mode 503 (and behind the watchdog's
 * overdue-ASN alert): a callback that was refused, never sent or lost leaves no receipt-event row,
 * so nothing that replays existing rows can reach it. This reconstructs the trigger; the warehouse
 * remains the authority for the quantities.
 */
export async function recheckWmsAsnBookedIn(
  externalAsnId: unknown,
): Promise<{ success: boolean; error?: string; message?: string }> {
  const connector = await getActiveWmsConnectorId()
  if (connector === 'mintsoft') {
    const { recheckMintsoftAsnBookedIn } = await import('@/app/actions/mintsoft-sync')
    return recheckMintsoftAsnBookedIn(externalAsnId)
  }
  return { success: false, error: 'No WMS connector is enabled.' }
}
