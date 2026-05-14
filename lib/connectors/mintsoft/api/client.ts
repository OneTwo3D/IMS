import { getMintsoftAccessToken, getMintsoftApiConfiguration, invalidateMintsoftAccessToken } from './auth'
import type { WmsAsnInput, WmsAsnRef, WmsBundleDto, WmsBundleRef, WmsProductDto, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsUpsertProductOptions, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import {
  extractMintsoftArrayPayload,
  normalizeMintsoftAsn,
  normalizeMintsoftBundle,
  extractMintsoftObjectPayload,
  normalizeMintsoftProduct,
  normalizeMintsoftProductListItem,
  normalizeMintsoftReturn,
  normalizeMintsoftStockLine,
  normalizeMintsoftWarehouse,
} from './normalizers'

export type MintsoftRequestResult<T> = {
  data: T | null
  error?: string
  status: number
}

function buildMintsoftRequestUrl(path: string, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBaseUrl)
}

function buildMintsoftRequestHeaders(baseUrl: string, init: RequestInit | undefined): HeadersInit {
  const url = buildMintsoftRequestUrl('/', baseUrl)
  const e2eSecret = process.env.E2E_ROUTE_SECRET?.trim()

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(e2eSecret && url.pathname.startsWith('/api/e2e/mintsoft')
      ? { 'x-e2e-secret': e2eSecret }
      : {}),
    ...init?.headers,
  }
}

async function sendMintsoftRequest<T>(
  path: string,
  baseUrl: string,
  apiKey: string,
  init: RequestInit | undefined,
): Promise<MintsoftRequestResult<T>> {
  const response = await fetch(buildMintsoftRequestUrl(path, baseUrl), {
    ...init,
    headers: {
      ...buildMintsoftRequestHeaders(baseUrl, init),
      'ms-apikey': apiKey,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    return {
      data: null,
      error: `Mintsoft request failed with status ${response.status}`,
      status: response.status,
    }
  }

  if (response.status === 204) {
    return {
      data: null,
      status: response.status,
    }
  }

  return {
    data: (await response.json()) as T,
    status: response.status,
  }
}

export async function mintsoftRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<MintsoftRequestResult<T>> {
  const config = await getMintsoftApiConfiguration()
  if (!config.baseUrl) {
    return {
      data: null,
      error: 'Mintsoft connection is not configured',
      status: 400,
    }
  }

  try {
    const apiKey = await getMintsoftAccessToken()
    const firstAttempt = await sendMintsoftRequest<T>(path, config.baseUrl, apiKey, init)
    if (firstAttempt.status !== 401) {
      return firstAttempt
    }

    await invalidateMintsoftAccessToken()
    const refreshedApiKey = await getMintsoftAccessToken({ forceRefresh: true })
    return sendMintsoftRequest<T>(path, config.baseUrl, refreshedApiKey, init)
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : 'Mintsoft request failed',
      status: 500,
    }
  }
}

export async function fetchMintsoftWarehouses(): Promise<WmsWarehouseRef[]> {
  const result = await mintsoftRequest<unknown>('/api/Warehouse')
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftWarehouse(item))
    .filter((item): item is WmsWarehouseRef => Boolean(item))
}

export async function fetchMintsoftStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]> {
  const query = new URLSearchParams({ WarehouseId: externalWarehouseId.trim() })
  const result = await mintsoftRequest<unknown>(`/api/Product/StockLevels?${query.toString()}`)
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftStockLine(item))
    .filter((item): item is WmsStockLine => Boolean(item))
}

export async function fetchMintsoftProduct(externalProductId: string): Promise<WmsProductRef | null> {
  const result = await mintsoftRequest<unknown>(`/api/Product/${encodeURIComponent(externalProductId.trim())}`)
  if (result.status === 404) return null
  if (result.error) {
    throw new Error(result.error)
  }

  return normalizeMintsoftProduct(result.data)
}

export async function fetchMintsoftProductBySku(sku: string): Promise<WmsProductRef | null> {
  const normalizedSku = sku.trim()
  if (!normalizedSku) return null

  const result = await mintsoftRequest<unknown>(`/api/Product?${new URLSearchParams({ SKU: normalizedSku }).toString()}`)
  if (result.status === 404) return null
  if (result.error) {
    throw new Error(result.error)
  }

  const direct = normalizeMintsoftProduct(result.data)
  if (direct?.sku === normalizedSku) return direct

  const listMatch = extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftProductListItem(item))
    .find((item): item is WmsProductRef => item != null && item.sku === normalizedSku)

  if (listMatch) return listMatch

  const wrapped = extractMintsoftObjectPayload(result.data)
  return wrapped && direct?.sku === normalizedSku ? direct : null
}

export async function fetchMintsoftReturns(since: Date): Promise<WmsReturnRecord[]> {
  const query = new URLSearchParams({ since: since.toISOString() })
  const result = await mintsoftRequest<unknown>(`/api/Returns?${query.toString()}`)
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftReturn(item))
    .filter((item): item is WmsReturnRecord => Boolean(item))
}

function buildMintsoftProductPayload(product: WmsProductDto, omitBarcode: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    SKU: product.sku,
    Name: product.name,
  }

  if (product.customsDescription) payload.CustomsDescription = product.customsDescription
  if (!omitBarcode && product.barcode) payload.EAN = product.barcode
  if (product.weightKg != null) payload.Weight = product.weightKg
  if (product.heightCm != null) payload.Height = product.heightCm
  if (product.widthCm != null) payload.Width = product.widthCm
  if (product.depthCm != null) payload.Depth = product.depthCm
  if (product.imageUrl) payload.ImageURL = product.imageUrl
  if (product.commodityCode) payload.CommodityCode = { Code: product.commodityCode }
  if (product.countryOfManufacture) payload.CountryOfManufacture = { Code: product.countryOfManufacture }

  return payload
}

function buildMintsoftAsnPayload(input: WmsAsnInput): Record<string, unknown> {
  return {
    WarehouseId: /^\d+$/.test(input.externalWarehouseId) ? Number.parseInt(input.externalWarehouseId, 10) : input.externalWarehouseId,
    Reference: input.reference,
    SupplierReference: input.supplierReference ?? null,
    Carrier: input.carrier ?? null,
    ETA: input.eta ?? null,
    PackagingType: input.packagingType ?? null,
    PackageCount: input.packageCount ?? null,
    CallbackUrl: input.callbackUrl ?? null,
    AutoCallback: input.autoCallback ?? true,
    Lines: input.lines.map((line) => ({
      SourceLineId: line.sourceLineId,
      ProductId: /^\d+$/.test(line.externalProductId) ? Number.parseInt(line.externalProductId, 10) : line.externalProductId,
      SKU: line.sku,
      Quantity: line.quantity,
    })),
  }
}

export function buildMintsoftProductUpsertRequest(
  product: WmsProductDto,
  options?: WmsUpsertProductOptions,
): {
  path: string
  method: 'PUT' | 'POST'
  body: string
} {
  const externalProductId = options?.externalProductId?.trim() || null
  const omitBarcode = options?.omitBarcode ?? false
  const payload = buildMintsoftProductPayload(product, omitBarcode)

  if (externalProductId) {
    const parsedExternalProductId = /^\d+$/.test(externalProductId)
      ? Number.parseInt(externalProductId, 10)
      : externalProductId
    return {
      path: '/api/Product',
      method: 'POST',
      body: JSON.stringify({
        ID: parsedExternalProductId,
        ...payload,
      }),
    }
  }

  return {
    path: '/api/Product',
    method: 'PUT',
    body: JSON.stringify(payload),
  }
}

export function buildMintsoftAsnCreateRequest(
  input: WmsAsnInput,
): {
  path: string
  method: 'POST'
  body: string
} {
  return {
    path: '/api/ASN',
    method: 'POST',
    body: JSON.stringify(buildMintsoftAsnPayload(input)),
  }
}

export function buildMintsoftAsnFetchByIdRequest(externalAsnId: string): {
  path: string
  method: 'GET'
} {
  const normalized = externalAsnId.trim()
  if (!normalized) {
    throw new Error('externalAsnId is required')
  }

  return {
    path: `/api/ASN/${encodeURIComponent(normalized)}`,
    method: 'GET',
  }
}

export async function upsertMintsoftProduct(
  product: WmsProductDto,
  options?: WmsUpsertProductOptions,
): Promise<WmsProductRef> {
  const externalProductId = options?.externalProductId?.trim() || null
  const request = buildMintsoftProductUpsertRequest(product, options)
  const result = await mintsoftRequest<unknown>(request.path, {
    method: request.method,
    body: request.body,
  })

  if (result.error) {
    throw new Error(result.error)
  }

  const normalized = normalizeMintsoftProduct(result.data)
  if (!normalized) {
    const fetched = externalProductId
      ? await fetchMintsoftProduct(externalProductId)
      : await fetchMintsoftProductBySku(product.sku)
    if (!fetched) {
      throw new Error('Mintsoft product upsert succeeded but no product details were returned')
    }
    return fetched
  }

  return normalized
}

export async function createMintsoftAsn(input: WmsAsnInput): Promise<WmsAsnRef> {
  const request = buildMintsoftAsnCreateRequest(input)
  const result = await mintsoftRequest<unknown>(request.path, {
    method: request.method,
    body: request.body,
  })

  if (result.error) {
    throw new Error(result.error)
  }

  const normalized = normalizeMintsoftAsn(result.data)
  if (!normalized) {
    throw new Error('Mintsoft ASN create succeeded but no line mapping was returned')
  }

  return normalized
}

function buildMintsoftBundlePayload(input: WmsBundleDto): Record<string, unknown> {
  return {
    SKU: input.sku,
    Name: input.name,
    PackingInstructions: input.packingInstructions ?? null,
    Components: input.components.map((component) => ({
      SKU: component.sku,
      Quantity: component.quantity,
      ...(component.externalProductId
        ? {
            ProductId: /^\d+$/.test(component.externalProductId)
              ? Number.parseInt(component.externalProductId, 10)
              : component.externalProductId,
          }
        : {}),
    })),
  }
}

export function buildMintsoftBundleCreateRequest(
  input: WmsBundleDto,
): { path: string; method: 'PUT'; body: string } {
  return {
    path: '/api/Product/Bundle',
    method: 'PUT',
    body: JSON.stringify(buildMintsoftBundlePayload(input)),
  }
}

export async function createMintsoftBundle(input: WmsBundleDto): Promise<WmsBundleRef> {
  const request = buildMintsoftBundleCreateRequest(input)
  const result = await mintsoftRequest<unknown>(request.path, {
    method: request.method,
    body: request.body,
  })

  if (result.error) {
    throw new Error(result.error)
  }

  const newProductResult = extractMintsoftObjectPayload(result.data)
  const productIdValue = newProductResult
    ? (newProductResult.ProductId ?? newProductResult.productId ?? newProductResult.ID ?? newProductResult.Id ?? newProductResult.id)
    : null
  const productId = typeof productIdValue === 'number'
    ? String(productIdValue)
    : typeof productIdValue === 'string' && productIdValue.trim()
      ? productIdValue.trim()
      : null

  if (!productId) {
    throw new Error('Mintsoft bundle create succeeded but no product id was returned')
  }

  const fetched = await fetchMintsoftBundle(productId)
  if (!fetched) {
    return {
      externalBundleId: productId,
      sku: input.sku,
      name: input.name,
      components: input.components,
      raw: newProductResult,
    }
  }
  return fetched
}

export async function fetchMintsoftBundle(externalProductId: string): Promise<WmsBundleRef | null> {
  const normalized = externalProductId.trim()
  if (!normalized) return null

  const result = await mintsoftRequest<unknown>(`/api/Product/${encodeURIComponent(normalized)}/Bundle`)
  if (result.status === 404) return null
  if (result.error) {
    throw new Error(result.error)
  }

  const bundle = normalizeMintsoftBundle(result.data)
  if (!bundle) return null

  return {
    ...bundle,
    externalBundleId: bundle.externalBundleId || normalized,
  }
}

export async function fetchMintsoftAsns(): Promise<WmsAsnRef[]> {
  const result = await mintsoftRequest<unknown>('/api/ASN')
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftAsn(item))
    .filter((item): item is WmsAsnRef => Boolean(item))
}

export async function fetchMintsoftAsnById(externalAsnId: string): Promise<WmsAsnRef | null> {
  const request = buildMintsoftAsnFetchByIdRequest(externalAsnId)

  const result = await mintsoftRequest<unknown>(request.path, { method: request.method })
  return normalizeMintsoftAsnFetchByIdResult(externalAsnId, result)
}

export function normalizeMintsoftAsnFetchByIdResult(
  externalAsnId: string,
  result: MintsoftRequestResult<unknown>,
): WmsAsnRef | null {
  const normalizedExternalAsnId = externalAsnId.trim()
  if (!normalizedExternalAsnId) {
    throw new Error('externalAsnId is required')
  }

  if (result.status === 404) return null
  if (result.error) {
    throw new Error(result.error)
  }

  const normalized = normalizeMintsoftAsn(result.data, {
    externalAsnIdFallback: normalizedExternalAsnId,
  })
  if (!normalized) return null

  return normalized
}
