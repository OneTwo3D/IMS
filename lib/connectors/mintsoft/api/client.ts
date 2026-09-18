import { getMintsoftAccessToken, getMintsoftApiConfiguration, invalidateMintsoftAccessToken } from './auth'
import type { WmsAsnInput, WmsAsnRef, WmsBundleDto, WmsBundleRef, WmsProductDto, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsUpsertProductOptions, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import { connectorFetch } from '@/lib/security/connector-fetch'
import { clampCustomsDescription } from '@/lib/trade/customs-description'
import {
  extractMintsoftArrayPayload,
  normalizeMintsoftAsn,
  normalizeMintsoftBundle,
  extractMintsoftObjectPayload,
  normalizeMintsoftProduct,
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
  const response = await connectorFetch(buildMintsoftRequestUrl(path, baseUrl), {
    ...init,
    headers: {
      ...buildMintsoftRequestHeaders(baseUrl, init),
      'ms-apikey': apiKey,
    },
    cache: 'no-store',
  }, {
    connectorName: 'Mintsoft',
    allowE2eLocalHttp: true,
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

    // o3d-092: in fixed-key mode a 401 means the operator's key is wrong or was
    // rotated out from under us by something else. There is nothing to refresh
    // — and re-authenticating would MINT A NEW TENANT KEY, breaking the
    // woocommerce-mintsoft-sync sweep and the shipping-label service that
    // share it. So surface the 401 instead of retrying: no invalidate (the
    // cached-token row is not what we authenticated with), no replay.
    if (config.authMode === 'api_key') {
      return {
        ...firstAttempt,
        error: firstAttempt.error
          ?? 'Mintsoft rejected the fixed API key (401). Not re-authenticating: that would '
            + 'regenerate the tenant API key and break the other Mintsoft integrations. '
            + 'Check that the configured key is current.',
      }
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

/** Parse the bare ProductId returned by /api/Product/LookupProductId (0 = not found). */
export function parseMintsoftProductId(data: unknown): number | null {
  if (typeof data === 'number') return Number.isInteger(data) && data > 0 ? data : null
  if (typeof data === 'string') {
    const parsed = Number(data.trim())
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

export async function fetchMintsoftProductBySku(sku: string): Promise<WmsProductRef | null> {
  const normalizedSku = sku.trim()
  if (!normalizedSku) return null

  // Mintsoft has no GET /api/Product?SKU filter (the base /api/Product GET is by
  // id only). Resolve SKU → ProductId via the dedicated lookup endpoint, then
  // fetch the full product by id — per the official Swagger, GET
  // /api/Product/LookupProductId?SKU= returns a bare int ProductId (0 = absent).
  const lookup = await mintsoftRequest<unknown>(`/api/Product/LookupProductId?${new URLSearchParams({ SKU: normalizedSku }).toString()}`)
  if (lookup.status === 404) return null
  if (lookup.error) {
    throw new Error(lookup.error)
  }

  const productId = parseMintsoftProductId(lookup.data)
  if (productId == null) return null

  const product = await fetchMintsoftProduct(String(productId))
  if (!product) return null
  // Guard against a stale/alt-SKU mapping: only adopt the product when its echoed
  // SKU matches the requested base SKU (case-insensitively — Mintsoft may echo a
  // different case), or the product doesn't echo a SKU at all.
  if (product.sku && product.sku.toLowerCase() !== normalizedSku.toLowerCase()) return null
  return product
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

  const customsDescription = clampCustomsDescription(product.customsDescription)
  if (customsDescription) payload.CustomsDescription = customsDescription
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

/**
 * THE MINTSOFT ASN LIST, AS THE LIVE API ACTUALLY SERVES IT (o3d-bhvu).
 *
 * Established with read-only GETs against the live tenant (ClientId 89) on 2026-09-18, and against
 * the published contract at GET /swagger/docs/v1:
 *   - `GET /api/ASN` is 405. `/api/ASN` carries only PUT (create) in the swagger; the list is
 *     `GET /api/ASN/List`. This function used to GET `/api/ASN`, so it threw on every call.
 *   - `/api/ASN/List` PAGES. Unparameterised it returned exactly 100 rows of 220; `PageNo=1,2,3`
 *     with `Limit=100` returned 100, 100 and 20. `Limit=101` and `Limit=500` are HTTP 400, so the
 *     page size is CLAMPED here, never configured (the Order/List lesson: a larger value fails
 *     silently into a fallback). `PageNo=0` is a 500 and a page past the end is `[]`.
 *   - Rows are ordered neither by ID nor by LastUpdated, so a page boundary is not a stable cursor.
 *   - `Items` is `null` unless `IncludeASNItems=true`.
 *   - There is NO filter by our reference (the parameters are ASNStatusId, ClientId, PageNo, Limit,
 *     WarehouseId, SinceLastUpdated, BookedIn*Interval, IncludeASNItems), and an unparseable
 *     SinceLastUpdated is silently IGNORED rather than rejected — so no filter here may be trusted
 *     to narrow correctly, and none is relied on except WarehouseId, which does narrow (live: 16 rows
 *     for warehouse 6, and 100+ for warehouse 5).
 *
 * SO THIS EITHER RETURNS THE WHOLE LIST OR THROWS. It pages to exhaustion (a short page ends it),
 * refuses a page larger than it asked for, refuses to go past `MINTSOFT_ASN_LIST_MAX_PAGES`, and —
 * because the order is unstable, so a row can move across a page boundary while the scan runs and be
 * skipped — accepts a scan only when two consecutive scans return exactly the same set of ASN IDs with
 * no ID seen twice within either. A caller deciding "no such ASN exists, so create one" must be able
 * to rely on the absence meaning absence; a partial list would make it create a DUPLICATE at a live
 * warehouse.
 */
export const MINTSOFT_ASN_LIST_PAGE_LIMIT = 100
/** 50 pages of 100 = 5,000 ASNs per scan. Past that the scan refuses rather than truncates. */
export const MINTSOFT_ASN_LIST_MAX_PAGES = 50
/** Scans attempted to get two consecutive identical ones before giving up. */
export const MINTSOFT_ASN_LIST_SCAN_ATTEMPTS = 3

/** Thrown when the ASN list cannot be established as complete. Callers must treat it as "unknown", never "empty". */
export class MintsoftAsnListIncompleteError extends Error {
  constructor(message: string) {
    super(`Cannot establish the complete Mintsoft ASN list: ${message}`)
    this.name = 'MintsoftAsnListIncompleteError'
  }
}

export type MintsoftAsnListOptions = {
  /** Mintsoft's numeric warehouse ID. Anything else is ignored and the whole tenant is scanned. */
  warehouseId?: string | null
  /** The HTTP boundary; tests substitute it. */
  request?: (path: string) => Promise<MintsoftRequestResult<unknown>>
}

export function buildMintsoftAsnListRequest(pageNo: number, options?: { warehouseId?: string | null }): {
  path: string
  method: 'GET'
} {
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error(`Mintsoft ASN List pages start at 1, got ${pageNo}`)
  const query = new URLSearchParams({
    PageNo: String(pageNo),
    Limit: String(MINTSOFT_ASN_LIST_PAGE_LIMIT),
    IncludeASNItems: 'true',
  })
  const warehouseId = options?.warehouseId?.trim()
  if (warehouseId && /^\d+$/.test(warehouseId)) query.set('WarehouseId', warehouseId)
  return { path: `/api/ASN/List?${query.toString()}`, method: 'GET' }
}

function mintsoftAsnListRowId(row: unknown): string {
  const record = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null
  const id = record?.ID
  if (typeof id === 'number' && Number.isInteger(id)) return String(id)
  if (typeof id === 'string' && /^\d+$/.test(id.trim())) return id.trim()
  throw new MintsoftAsnListIncompleteError('a row has no ASN ID, so it cannot be told apart from the others')
}

async function scanMintsoftAsnList(options: MintsoftAsnListOptions): Promise<{ rows: Array<Record<string, unknown>>; ids: string[]; repeated: boolean }> {
  const request = options.request ?? ((path: string) => mintsoftRequest<unknown>(path))
  const rows: Array<Record<string, unknown>> = []
  const ids: string[] = []
  const seen = new Set<string>()
  let repeated = false
  for (let pageNo = 1; pageNo <= MINTSOFT_ASN_LIST_MAX_PAGES; pageNo += 1) {
    const result = await request(buildMintsoftAsnListRequest(pageNo, options).path)
    if (result.error) throw new MintsoftAsnListIncompleteError(`page ${pageNo} failed (${result.status}): ${result.error}`)
    if (!Array.isArray(result.data)) throw new MintsoftAsnListIncompleteError(`page ${pageNo} was not an array`)
    const page = result.data
    if (page.length > MINTSOFT_ASN_LIST_PAGE_LIMIT) {
      throw new MintsoftAsnListIncompleteError(`page ${pageNo} returned ${page.length} rows for a limit of ${MINTSOFT_ASN_LIST_PAGE_LIMIT}`)
    }
    for (const row of page) {
      const id = mintsoftAsnListRowId(row)
      if (seen.has(id)) repeated = true
      seen.add(id)
      ids.push(id)
      rows.push(row as Record<string, unknown>)
    }
    if (page.length < MINTSOFT_ASN_LIST_PAGE_LIMIT) return { rows, ids, repeated }
  }
  throw new MintsoftAsnListIncompleteError(
    `more than ${MINTSOFT_ASN_LIST_MAX_PAGES} pages of ${MINTSOFT_ASN_LIST_PAGE_LIMIT}; refusing to treat a truncated list as complete`,
  )
}

/** Every ASN row the list serves (with Items), or a MintsoftAsnListIncompleteError. Never a partial list. */
export async function fetchMintsoftAsnListRows(options: MintsoftAsnListOptions = {}): Promise<Array<Record<string, unknown>>> {
  let previous: { rows: Array<Record<string, unknown>>; ids: string[]; repeated: boolean } | null = null
  for (let attempt = 1; attempt <= MINTSOFT_ASN_LIST_SCAN_ATTEMPTS; attempt += 1) {
    const scan = await scanMintsoftAsnList(options)
    if (previous && !previous.repeated && !scan.repeated && sameIdSet(previous.ids, scan.ids)) return scan.rows
    previous = scan
  }
  throw new MintsoftAsnListIncompleteError(
    `the list changed between ${MINTSOFT_ASN_LIST_SCAN_ATTEMPTS} consecutive scans, so no scan can be shown to be complete`,
  )
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((value, index) => value === b[index])
}

/**
 * The ASN list normalized as the booked-in path reads an ASN (`normalizeMintsoftAsn`, the same normalizer
 * as `GET /api/ASN/{id}`). The MINTSOFT_USE_BULK_ASN_LOOKUP rollback path of the booked-in processor.
 */
export async function fetchMintsoftAsns(options: MintsoftAsnListOptions = {}): Promise<WmsAsnRef[]> {
  return (await fetchMintsoftAsnListRows(options))
    .map((item) => normalizeMintsoftAsn(item))
    .filter((item): item is WmsAsnRef => Boolean(item))
}

/**
 * THE ASNs A CREATOR MUST CHECK BEFORE IT CREATES ONE — duplicate recovery (o3d-bhvu).
 *
 * Each row carries what the creators match on: `raw.POReference` (Mintsoft stores the reference there;
 * there is no `Reference` field in its ASN model) and one line per item with its `SourceLineId` and its
 * EXPECTED quantity (`QuantityExpected`). The expected quantity is deliberately not `normalizeMintsoftAsn`'s
 * `quantity`, which the booked-in path reads as RECEIVED.
 *
 * A row whose `Items` is not an array is REFUSED rather than skipped: the list was asked for items, so a
 * row without them is one this caller cannot rule out as its own, and skipping it would be the partial
 * scan this function exists to prevent.
 */
export async function fetchMintsoftAsnsForDuplicateRecovery(externalWarehouseId: string | null, options: Omit<MintsoftAsnListOptions, 'warehouseId'> = {}): Promise<WmsAsnRef[]> {
  const rows = await fetchMintsoftAsnListRows({ ...options, warehouseId: externalWarehouseId })
  return rows.map((row) => normalizeMintsoftAsnListRowForRecovery(row))
}

export function normalizeMintsoftAsnListRowForRecovery(row: Record<string, unknown>): WmsAsnRef {
  const externalAsnId = mintsoftAsnListRowId(row)
  if (!Array.isArray(row.Items)) {
    throw new MintsoftAsnListIncompleteError(`ASN ${externalAsnId} came back without its items`)
  }
  const lines = (row.Items as unknown[]).flatMap((item) => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
    if (!record) return []
    const sourceLineId = typeof record.SourceLineId === 'string' && record.SourceLineId.trim() ? record.SourceLineId.trim() : null
    const externalLineId = record.ID == null ? null : String(record.ID)
    if (!sourceLineId || !externalLineId) return []
    const expected = typeof record.QuantityExpected === 'number' ? record.QuantityExpected : null
    return [{
      externalLineId,
      sourceLineId,
      externalProductId: record.ProductId == null ? null : String(record.ProductId),
      sku: typeof record.SKU === 'string' ? record.SKU : null,
      quantity: expected,
      raw: record,
    }]
  })
  return { externalAsnId, status: null, lines, raw: row }
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
