export type WmsConnectorId = 'mintsoft'

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
  pollReturns(since: Date): Promise<WmsReturnRecord[]>
  createBundle?(input: WmsBundleDto): Promise<WmsBundleRef>
  fetchBundle?(externalProductId: string): Promise<WmsBundleRef | null>
  verifyWebhookSignature?(rawBody: string, signatureHeader: string | null): Promise<boolean> | boolean
}
