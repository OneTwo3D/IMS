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

export type WmsUpsertProductOptions = {
  externalProductId?: string | null
  omitBarcode?: boolean
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
  verifyWebhookSignature?(rawBody: string, signatureHeader: string | null): Promise<boolean> | boolean
}
