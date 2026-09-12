import type { WmsAsnPackagingType } from './types'

/**
 * Connector-agnostic ASN (Advance Shipment Notice) view-model shared by the PO
 * and transfer receiving flows. The active WMS connector's server actions
 * produce these shapes (see app/actions/wms-asn.ts); core flows depend only on
 * these types, never on a connector-specific module.
 */

export type WmsAsnRow = {
  id: string
  externalAsnId: string
  status: string
  createdAt: string
  lastCallbackAt: string | null
  closedAt: string | null
  lineCount: number
  totalExpectedQty: string
  totalReceivedQty: string
}

// The label-free shape a WMS connector's state action produces. The facade
// (app/actions/wms-asn.ts) decorates it with the active connector's display
// label before handing it to core flows, so connectors never hardcode it.
type WmsAsnStateCore = {
  pluginEnabled: boolean
  canCreate: boolean
  canManage: boolean
  blockedReason: string | null
  destinationWarehouseCode: string | null
  bindingExternalWarehouseId: string | null
  existingAsns: WmsAsnRow[]
}

export type WmsPurchaseOrderAsnStateCore = WmsAsnStateCore
export type WmsTransferAsnStateCore = WmsAsnStateCore

// Public, connector-agnostic state consumed by the PO/transfer views. The
// `connectorLabel` drives all user-visible "<WMS> ASN" copy so the dialog needs
// no edits when a new connector is added.
export type WmsPurchaseOrderAsnState = WmsAsnStateCore & { connectorLabel: string }
export type WmsTransferAsnState = WmsAsnStateCore & { connectorLabel: string }

/** The fallback label when no WMS connector resolves at all. Never a connector name. */
export const WMS_GENERIC_CONNECTOR_LABEL = 'WMS'

/**
 * The ONE place a connector-agnostic ASN core becomes a labelled view-model.
 *
 * Extracted from app/actions/wms-asn.ts so it can be driven without a server action —
 * tests/wms-second-connector-seam.test.ts decorates a core with a FICTITIOUS connector's
 * label and asserts nothing Mintsoft-shaped survives. Inline this back into the facade
 * and the only thing checking the label promise disappears with it.
 */
export function decorateWmsAsnState<T extends WmsAsnStateCore>(
  core: T,
  connectorLabel: string | null,
): T & { connectorLabel: string } {
  return { ...core, connectorLabel: connectorLabel ?? WMS_GENERIC_CONNECTOR_LABEL }
}

/**
 * The state a PO/transfer view gets when the resolved connector cannot do ASNs at all
 * — including when no connector resolves. It is still LABELLED with whatever did
 * resolve, so the dialog says "Acme Fulfilment ASN unavailable" rather than the
 * anonymous "WMS": telling an operator that an unnamed system is unavailable is the
 * kind of copy that generates a support ticket.
 */
export function unsupportedWmsAsnState(connectorLabel: string | null): WmsPurchaseOrderAsnState {
  return decorateWmsAsnState({
    pluginEnabled: false,
    canCreate: false,
    canManage: false,
    blockedReason: null,
    destinationWarehouseCode: null,
    bindingExternalWarehouseId: null,
    existingAsns: [],
  }, connectorLabel)
}

export type WmsCreateAsnInput = {
  packagingType?: WmsAsnPackagingType | null
  packageCount?: number | null
  eta?: string | null
  supplierReference?: string | null
  carrier?: string | null
  autoCallback?: boolean
}

export type WmsCreateAsnResult = {
  success: boolean
  error?: string
  message?: string
  externalAsnId?: string
}
