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
