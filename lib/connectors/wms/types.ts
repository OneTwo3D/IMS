/**
 * Canonical list of WMS/3PL connector ids. This is the single source of truth
 * the generic WMS boundary derives from — registry entries, plugin-enabled
 * checks, and module routing all read this list rather than hardcoding a
 * connector literal. Add a new id here (plus a registry entry, an
 * IntegrationPluginId + setting key, and per-connector cron/webhook ingress)
 * when a new WMS connector lands; core sales/PO/transfer/stock flows need no edits.
 */
export const WMS_CONNECTOR_IDS = ['mintsoft', 'shiphero'] as const

export type WmsConnectorId = (typeof WMS_CONNECTOR_IDS)[number]

export function isWmsConnectorId(value: string | null | undefined): value is WmsConnectorId {
  return value != null && (WMS_CONNECTOR_IDS as readonly string[]).includes(value)
}

export type WmsConnectionSettings = {
  baseUrl: string
  apiKey: string
  webhookSecret: string
  orderLookupConnector: string | null
}

export type WmsWarehouseRef = {
  externalId: string
  name: string
}

export type WmsStockLine = {
  sku: string
  quantity: number
  raw: Record<string, unknown> | null
}

export type WmsProductDto = {
  sku: string
  name: string
  customsDescription: string | null
  barcode: string | null
  commodityCode: string | null
  countryOfManufacture: string | null
  weightKg: number | null
  heightCm: number | null
  widthCm: number | null
  depthCm: number | null
  imageUrl: string | null
  raw?: Record<string, unknown> | null
}

export type WmsProductRef = {
  externalId: string
  sku: string
  barcode: string | null
  raw: Record<string, unknown> | null
}

export type WmsReturnRecord = {
  externalReturnId: string
  externalWarehouseId: string | null
  sku: string | null
  qty: number | null
  orderReference: string | null
  reason: string | null
  receivedAt: string | null
  raw: Record<string, unknown> | null
}

export type WmsAsnPackagingType = 'PARCEL' | 'PALLET' | 'CONTAINER'

export type WmsAsnLineInput = {
  sourceLineId: string
  externalProductId: string
  sku: string
  quantity: number
}

export type WmsAsnInput = {
  externalWarehouseId: string
  reference: string
  callbackUrl?: string | null
  supplierReference?: string | null
  carrier?: string | null
  eta?: string | null
  packagingType?: WmsAsnPackagingType | null
  packageCount?: number | null
  autoCallback?: boolean
  lines: WmsAsnLineInput[]
}

export type WmsAsnLineRef = {
  externalLineId: string
  sourceLineId: string
  externalProductId: string | null
  sku: string | null
  quantity: number | null
  raw: Record<string, unknown> | null
}

export type WmsAsnRef = {
  externalAsnId: string
  status: string | null
  lines: WmsAsnLineRef[]
  raw: Record<string, unknown> | null
}

export type WmsUpsertProductOptions = {
  externalProductId?: string | null
  omitBarcode?: boolean
}

export type WmsBundleComponent = {
  externalProductId: string | null
  sku: string
  quantity: number
}

export type WmsBundleDto = {
  sku: string
  name: string
  packingInstructions: string | null
  components: WmsBundleComponent[]
}

export type WmsBundleRef = {
  externalBundleId: string
  sku: string
  name: string | null
  components: WmsBundleComponent[]
  raw: Record<string, unknown> | null
}

export type WmsConnectionCheck = {
  success: boolean
  error?: string
}

export type WmsOrderTracking = {
  trackingNumber: string | null
  carrier: string | null
  despatchedAt: string | null
}

/**
 * Live order status for a storefront order as seen by the WMS. Read-only — used
 * to surface a status chip + deep link on the sales-order view.
 */
export type WmsOrderStatus = {
  /** The WMS's own internal order id (used for the deep link). */
  externalOrderId: string
  /** The WMS order number; may carry a merged marker (e.g. "5001+5002"). */
  externalOrderNumber: string
  /** Raw status as the WMS reports it (e.g. "DESPATCHED"). */
  status: string
  /** Human-readable status label. */
  statusLabel: string
  /** True when the WMS split the order into multiple parts. */
  isSplit: boolean
  /** Number of parts when split, else null. */
  partCount: number | null
  /** True when this order is a merge survivor of several storefront orders. */
  isMerged: boolean
  /** The storefront order numbers folded into a merged order. */
  mergedOrderNumbers: string[]
  /** Deep link to the order in the WMS web UI, if available. */
  deepLinkUrl: string | null
  tracking: WmsOrderTracking[]
  /** Normalised "the goods have left the warehouse" flag — the connector decides the
   *  semantics from its own status names/tracking, so core dispatch reconciliation stays
   *  connector-agnostic. */
  dispatched: boolean
  raw?: Record<string, unknown> | null
}

/**
 * One part of a (possibly split) WMS order — a Mintsoft split part or a ShipHero shipment.
 * Used by the generic dispatch sweep to reconcile per-part despatch.
 */
export type WmsOrderPart = {
  /** The WMS's own id for this part (used to fetch its line items). */
  externalId: string
  /** 1-based part number within the split. */
  partNumber: number
  /** Raw per-part status as the WMS reports it. */
  status: string
  /** Normalised dispatched flag for this part (connector-decided). */
  dispatched: boolean
  tracking: WmsOrderTracking[]
}

export type WmsOrderAddress = {
  firstName: string
  lastName: string
  company: string
  address1: string
  address2: string
  town: string
  county: string
  postCode: string
  country: string
}

export type WmsOrderPushLine = {
  sku: string
  quantity: number
  unitPriceExVat: number
  unitPriceVat: number
  description: string | null
}

/** A storefront/IMS order to create in the WMS for fulfilment (Phase 8 push). */
export type WmsOrderPushInput = {
  orderNumber: string
  /** Stable external reference the WMS stores to match the order back (IMS order id). */
  externalReference: string
  externalWarehouseId: string
  currency: string
  shippingAddress: WmsOrderAddress
  email: string | null
  phone: string | null
  /** Customer VAT/IOSS number for customs declarations; null when not provided. */
  vatNumber: string | null
  comments: string | null
  /** Carrier/service name passed through for the WMS to resolve; null = WMS default. */
  courierService: string | null
  totalVat: number
  shippingExVat: number
  shippingVat: number
  discountExVat: number
  discountVat: number
  lines: WmsOrderPushLine[]
}

export type WmsOrderPushResult = {
  externalOrderId: string
  externalOrderNumber: string | null
  status: string
  /** True when the order's shipping service didn't resolve and the WMS fell back to a
   *  default courier — the warehouse should verify the courier before despatch. */
  courierFallback?: boolean
}

export type WmsOrderCancelResult = {
  cancelled: boolean
  /** WMS status observed; a non-NEW order is not cancellable and is left as-is. */
  status: string
}

export type WmsOrderUpdateResult = {
  /** False when the WMS order is past NEW and can no longer be amended. */
  updated: boolean
  status: string
}

export interface WmsConnector {
  readonly id: WmsConnectorId
  readonly name: string

  isConfigured(): Promise<boolean>
  validateConnection(): Promise<WmsConnectionCheck>
  fetchWarehouses(): Promise<WmsWarehouseRef[]>
  fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]>
  fetchProduct(externalProductId: string): Promise<WmsProductRef | null>
  fetchProductBySku(sku: string): Promise<WmsProductRef | null>
  upsertProduct(product: WmsProductDto, options?: WmsUpsertProductOptions): Promise<WmsProductRef>
  createAsn(input: WmsAsnInput): Promise<WmsAsnRef>
  fetchAsnById?(externalAsnId: string): Promise<WmsAsnRef | null>
  pollReturns(since: Date): Promise<WmsReturnRecord[]>
  createBundle?(input: WmsBundleDto): Promise<WmsBundleRef>
  fetchBundle?(externalProductId: string): Promise<WmsBundleRef | null>
  /** Resolve the live order status for a storefront order number, if supported. */
  fetchOrderStatus?(orderNumber: string): Promise<WmsOrderStatus | null>
  /** All parts of a (possibly split) order, each with its own status/tracking/dispatched
   *  flag — for per-part dispatch reconciliation. */
  fetchOrderParts?(orderNumber: string): Promise<WmsOrderPart[]>
  /** Line items (SKU + whole-unit qty) of a single order/part. */
  fetchOrderPartItems?(externalPartId: string): Promise<Array<{ sku: string; qty: number }>>
  /** Push (create) an order into the WMS for fulfilment; idempotent on re-push. */
  pushOrder?(input: WmsOrderPushInput): Promise<WmsOrderPushResult>
  /** Amend an already-pushed WMS order; a no-op (updated=false) if past NEW. */
  updateOrder?(externalOrderId: string, input: WmsOrderPushInput): Promise<WmsOrderUpdateResult>
  /** Cancel a WMS order by its external id; a no-op (success) if past NEW. */
  cancelOrder?(externalOrderId: string): Promise<WmsOrderCancelResult>
  /** Post an operator-facing note onto the WMS order — e.g. to flag a refund to the
   *  warehouse when the API cannot auto-apply it (a past-NEW order). */
  addOrderComment?(externalOrderId: string, comment: string): Promise<void>
  verifyWebhookSignature?(
    rawBody: string,
    signatureHeader: string | null,
    options?: { timestamp?: string | null },
  ): Promise<boolean> | boolean
}
