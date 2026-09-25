import { getMintsoftAccessToken, getMintsoftApiConfiguration, invalidateMintsoftAccessToken } from './auth'
import type { WmsAsnInput, WmsAsnPackagingType, WmsAsnRef, WmsBundleDto, WmsBundleRef, WmsProductDto, WmsProductRef, WmsReturnRecord, WmsStockLine, WmsUpsertProductOptions, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import {
  readMintsoftAsnItemExpectedQuantity,
  readMintsoftAsnItemLineIdentity,
  requireMintsoftAsnIsTheOneRequested,
  type MintsoftAsnExpectation,
} from './asn-creation-rule'
import { readMintsoftAsnWireStatusField } from './asn-status'
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

/**
 * The seven names `GET /api/ASN/GoodsInTypes` serves (read live 2026-09-24). `NewASN.GoodsInType` is
 * REQUIRED even though the swagger does not mark it so: a create without it comes back HTTP 200 with
 * `Success: false, Message: "Invalid GoodsInType:  See ASN/GoodsInTypes for valid types"` (o3d-vcw8).
 */
export const MINTSOFT_GOODS_IN_TYPES = [
  'TwentyFtContainer',
  'FortyFtContainer',
  'Pallet',
  'Carton',
  'FortyFtContainerHC',
  'FortyFiveFtContainer',
  'FortyFiveFtContainerHC',
] as const

export type MintsoftGoodsInType = typeof MINTSOFT_GOODS_IN_TYPES[number]

/**
 * IMS's packaging type as one of Mintsoft's goods-in types. Keyed by the whole union, so adding a packaging
 * type is a type error here rather than a `Success: false` at the warehouse. `Carton` is the fallback for a
 * reservation that names none: it is what 216 of this tenant's 223 ASNs use, and an ASN must carry one.
 */
const MINTSOFT_GOODS_IN_TYPE_BY_PACKAGING: Record<WmsAsnPackagingType, MintsoftGoodsInType> = {
  PARCEL: 'Carton',
  PALLET: 'Pallet',
  CONTAINER: 'TwentyFtContainer',
}

export function mintsoftGoodsInType(packagingType: WmsAsnPackagingType | null | undefined): MintsoftGoodsInType {
  return (packagingType ? MINTSOFT_GOODS_IN_TYPE_BY_PACKAGING[packagingType] : undefined) ?? 'Carton'
}

/**
 * `NewASN`, THE BODY MINTSOFT ACTUALLY ACCEPTS (o3d-vcw8, proven live 2026-09-24 by one owner-sanctioned
 * create — ASN 6117, read back and deleted). What IMS used to send — `Reference`, `Lines`, `ETA`, `Carrier`,
 * `PackagingType`, `PackageCount`, `CallbackUrl`, `AutoCallback` — is not this model; none of those names
 * exists on `NewASN`, so an accepted create would have stored an ASN with no reference and no items.
 *
 * `ClientId` IS NOT SENT, though `NewASN` declares it: our key is a client user and Mintsoft answers
 * "Client Users cannot specify a ClientId when creating an ASN!". Mintsoft sets it on the created row.
 *
 * `Quantity` IS THE PACKAGE COUNT, NOT A QUANTITY OF GOODS. The header quantity equalled the item sum on
 * only 3 of this tenant's 223 ASNs; on the ASN this contract was proven with, `Quantity: 1` with one item
 * of `QuantityExpected: 1` and `GoodsInType: "Carton"` came back as one carton. Units live on `Items[]`.
 *
 * `Carrier` and `SupplierReference` have NO home on `NewASN`, so they are preserved as labelled
 * `SupplierNotes` rather than dropped silently (the alternative o3d-vcw8 sanctions).
 */
function buildMintsoftAsnPayload(input: WmsAsnInput): Record<string, unknown> {
  const supplierNotes = [
    input.supplierReference?.trim() ? `Supplier reference: ${input.supplierReference.trim()}` : null,
    input.carrier?.trim() ? `Carrier: ${input.carrier.trim()}` : null,
  ].filter((note): note is string => Boolean(note)).join('\n')

  const payload: Record<string, unknown> = {
    WarehouseId: /^\d+$/.test(input.externalWarehouseId) ? Number.parseInt(input.externalWarehouseId, 10) : input.externalWarehouseId,
    POReference: input.reference,
    GoodsInType: mintsoftGoodsInType(input.packagingType),
    Quantity: Number.isInteger(input.packageCount) && (input.packageCount ?? 0) > 0 ? input.packageCount : 1,
    Items: input.lines.map((line) => ({
      SourceLineId: line.sourceLineId,
      ProductId: /^\d+$/.test(line.externalProductId) ? Number.parseInt(line.externalProductId, 10) : line.externalProductId,
      SKU: line.sku,
      Quantity: line.quantity,
    })),
  }
  if (supplierNotes) payload.SupplierNotes = supplierNotes
  if (input.eta) payload.EstimatedDelivery = input.eta
  return payload
}

export class MintsoftAsnCreateRejectedError extends Error {
  constructor(message: string | null, raw: unknown) {
    super(
      `Mintsoft refused the ASN create: ${message?.trim() || 'it answered without Success or an ASN id'}. `
      + 'Mintsoft answers a REFUSED create with HTTP 200 and Success: false, so nothing was created and no '
      + `ASN id exists to record (it replied ${JSON.stringify(raw)?.slice(0, 400) ?? 'nothing'}).`,
    )
    this.name = 'MintsoftAsnCreateRejectedError'
  }
}

export class MintsoftAsnCreateVerificationError extends Error {
  /**
   * THE ID IS RETAINED, NOT JUST PRINTED (round 6, Codex HIGH 1). The ASN exists at the live warehouse and
   * IMS recorded nothing, so the id is the only handle an operator has. Both creators read it off this
   * error and write it onto the failed sync job and an activity entry, where it can be queried later — a
   * message in a log line is not a record.
   */
  readonly externalAsnId: string

  constructor(externalAsnId: string, detail: string) {
    super(
      `Mintsoft reported ASN ${externalAsnId} created, but reading it back does not confirm what was sent: `
      + `${detail}. The ASN EXISTS at the warehouse and IMS has not recorded it, so nothing is being retried `
      + 'blindly: a retry looks it up by POReference and the item SourceLineIds first, and only an operator '
      + `can remove it (DELETE /api/ASN/${externalAsnId} is Mintsoft's only removal — there is no cancel).`,
    )
    this.name = 'MintsoftAsnCreateVerificationError'
    this.externalAsnId = externalAsnId
  }
}

/**
 * A QUANTITY MINTSOFT CANNOT STORE IS REFUSED BEFORE THE PUT, NOT AFTER IT (round 6, Codex HIGH 1).
 * `NewASNItem.Quantity` and `ASNItem.QuantityExpected` are int32, and IMS quantities can be fractional. A
 * fractional quantity sent to Mintsoft comes back rounded, which the read-back below refuses — correctly,
 * but by then the ASN exists at the warehouse and only an operator can delete it. There is nothing to be
 * gained by discovering that afterwards, so the create never leaves the box.
 */
export class MintsoftAsnQuantityNotRepresentableError extends Error {
  constructor(sourceLineId: string, quantity: number) {
    super(
      `Mintsoft cannot store the quantity ${quantity} that line ${sourceLineId} expects: an ASN item quantity `
      + 'is a whole number (int32) in Mintsoft, so this would be created at the warehouse as some other '
      + 'quantity and could never be reconciled with the reservation. NOTHING WAS SENT and no ASN was '
      + 'created: adjust the outstanding quantity to a whole number, then retry.',
    )
    this.name = 'MintsoftAsnQuantityNotRepresentableError'
  }
}

const MINTSOFT_INT32_MAX = 2147483647

/** Every `Items[].Quantity` Mintsoft could not store, refused before the request is built. */
function requireMintsoftCanStoreAsnQuantities(input: WmsAsnInput): void {
  for (const line of input.lines) {
    if (!Number.isFinite(line.quantity) || !Number.isInteger(line.quantity) || Math.abs(line.quantity) > MINTSOFT_INT32_MAX) {
      throw new MintsoftAsnQuantityNotRepresentableError(line.sourceLineId, line.quantity)
    }
  }
}

/** What the create asked for, in the form the shared rule compares a remote ASN against. */
export function mintsoftAsnExpectationFromCreateInput(input: WmsAsnInput): MintsoftAsnExpectation {
  return {
    reference: input.reference,
    externalWarehouseId: input.externalWarehouseId,
    lines: input.lines.map((line) => ({ sourceLineId: line.sourceLineId, expectedQty: line.quantity })),
  }
}

/**
 * EVERY MINTSOFT ASN CREATE FAILURE IS AN HTTP 200 (o3d-vcw8, three live attempts: two `Success: false`
 * with `ID: 0`, one `Success: true` with `ID: 6117`). The reply is a `ToolkitResult`, never an ASN, so
 * trusting the status code recorded a phantom ASN id of 0 as if an inbound delivery had been booked.
 * Success is `Success === true` AND `ID > 0`, and nothing else.
 */
export function readMintsoftAsnCreateResultId(data: unknown): number {
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  const message = typeof record?.Message === 'string' ? record.Message : null
  const id = typeof record?.ID === 'number' && Number.isFinite(record.ID) ? record.ID : null
  if (record?.Success !== true || id == null || !Number.isInteger(id) || id <= 0) {
    throw new MintsoftAsnCreateRejectedError(message, data)
  }
  return id
}

/**
 * POST-CREATE VERIFICATION (o3d-vcw8; o3d-bhvu round 4 named this the real answer to duplicate recovery's
 * completeness residual). The `ToolkitResult` carries an id and nothing else, so the ASN is read back — and
 * the read-back is CHECKED, not just parsed, against the SAME rule the pre-create matcher uses
 * (`asn-creation-rule.ts`): the `POReference`, the EXACT item set, every `QuantityExpected` and the
 * `WarehouseId` must be what was sent.
 *
 * ROUND 6, CODEX HIGH 1 — IT USED TO CHECK THE REFERENCE AND THE PRESENCE OF EACH `SourceLineId` ONLY. A
 * read-back at another warehouse, with an extra item, or with a different `QuantityExpected` — including
 * Mintsoft's int32 store turning a fractional quantity into a whole one — passed, and the caller then
 * recorded the RESERVATION's own quantities against that ASN and marked the job succeeded. IMS would have
 * shown an inbound delivery that the warehouse is not expecting, and nothing would ever have said so.
 * A difference refuses instead, naming the ASN id (which the error retains) so it can be reconciled.
 */
export function requireCreatedMintsoftAsnMatchesRequest(created: WmsAsnRef, input: WmsAsnInput): WmsAsnRef {
  return requireMintsoftAsnIsTheOneRequested(
    created,
    mintsoftAsnExpectationFromCreateInput(input),
    (detail) => new MintsoftAsnCreateVerificationError(created.externalAsnId, detail),
  )
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

/**
 * `PUT /api/ASN` — there is no `POST /api/ASN` (the swagger defines the create as PUT and `POST /api/ASN/{id}`
 * as the UPDATE route; live `GET /api/ASN` is 405, the path being write-only). o3d-vcw8.
 */
export function buildMintsoftAsnCreateRequest(
  input: WmsAsnInput,
): {
  path: string
  method: 'PUT'
  body: string
} {
  requireMintsoftCanStoreAsnQuantities(input)
  return {
    path: '/api/ASN',
    method: 'PUT',
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

  // NEVER `result.status`: a rejected create is an HTTP 200 (o3d-vcw8). The verdict is in the body.
  const externalAsnId = String(readMintsoftAsnCreateResultId(result.data))
  const created = await fetchMintsoftAsnById(externalAsnId)
  if (!created) {
    throw new MintsoftAsnCreateVerificationError(externalAsnId, 'reading it back returned nothing IMS can map to lines')
  }

  return requireCreatedMintsoftAsnMatchesRequest(created, input)
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
 *     to narrow correctly. WarehouseId does narrow (live: 16 rows for warehouse 6, 100+ for 5) and is
 *     offered to callers, but duplicate recovery deliberately does not use it (review M3, see
 *     fetchMintsoftAsnsForDuplicateRecovery).
 *
 * SO THIS EITHER RETURNS THE WHOLE LIST OR THROWS. A caller deciding "no such ASN exists, so create one"
 * must be able to rely on absence meaning absence; a partial list would make it create a DUPLICATE at a
 * live warehouse. A scan is accepted only when ALL of these hold, and every other outcome is a refusal:
 *
 *   (1) every page before the terminating one returned EXACTLY `Limit` rows (more is refused outright);
 *   (2) the terminating short page is PROVEN to be the end, by asking for the page after it and requiring
 *       it to be empty (round 4, Codex HIGH 2). A short page used to be *assumed* to be the end. Any
 *       truncation that is DETERMINISTIC — a server that answers page 1 with 23 rows every time — then
 *       looks exactly like a complete list, and looks the same on every re-scan, so no amount of re-reading
 *       can see it. Live Mintsoft answers a page past the end with `[]` (`PageNo=99999` → `200 []`), so the
 *       question is cheap and its answer is unambiguous;
 *   (3) no ASN ID appeared twice within the scan;
 *   (4) two consecutive scans returned exactly the same set of ASN IDs;
 *   (5) an INDEPENDENT read of the recently-updated window (`SinceLastUpdated`, taken BEFORE the full
 *       scans) is contained in the accepted set. See `fetchMintsoftAsnListRows`.
 *
 * WHY (3) AND (4) TOGETHER EXCLUDE A ROW THAT MOVED ACROSS A PAGE BOUNDARY. Pages are windows over an
 * ordering of the whole current set, so the collected count is `(pages−1)·Limit + |last page|`, which by
 * (1) and (2) is the set size at the moment the last page was served. If the scan collected that many
 * DISTINCT rows (3) and yet omitted one that existed, then by counting it must have collected some row that
 * no longer existed then — i.e. an ASN deleted mid-scan. Mintsoft's delete is a hard delete with no ID
 * reuse (proven live 2026-09-24: `DELETE /api/ASN/6117` then `GET /api/ASN/6117` → 404), so that deleted row
 * cannot appear in the NEXT scan, and (4) would fail. Two agreeing, repeat-free, end-proven scans therefore
 * omit nothing — GIVEN the paging model.
 *
 * WHAT IS STILL ASSUMED, PLAINLY. That model itself: that `PageNo`/`Limit` are a window over a permutation
 * of the whole current set, and not, say, a keyset walk that can skip a row identically every time. No
 * client-side check can establish it from this API — there is no total count, no cursor, no ordering
 * parameter, and no filter by our own reference — which is why (5) exists (a read whose result fits in one
 * page has no page boundary to be lost at) and why the real answer is post-create verification keyed on
 * `POReference` + `Items[].SourceLineId`, both now proven to round-trip (o3d-vcw8). Until that lands, this
 * reader FAILS CLOSED: every refusal here aborts the creation attempt, so no ASN is created — and, because
 * the scan is tenant-wide, none can be created for any reservation — until the condition clears.
 */
export const MINTSOFT_ASN_LIST_PAGE_LIMIT = 100
/** 50 pages of 100 = 5,000 ASNs per scan. Past that the scan refuses rather than truncates. */
export const MINTSOFT_ASN_LIST_MAX_PAGES = 50
/** Scans attempted to get two consecutive identical ones before giving up. */
export const MINTSOFT_ASN_LIST_SCAN_ATTEMPTS = 3
/**
 * How far back the independent `SinceLastUpdated` read looks. It exists to cover the rows duplicate
 * recovery is actually hunting — an ASN a recent earlier attempt created — and live it is small (9 of 220
 * ASNs were updated in the 17 days before 2026-09-18), so it is normally one page and therefore has no page
 * boundary a row could be lost at.
 */
export const MINTSOFT_ASN_LIST_RECENT_WINDOW_DAYS = 30

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

export function buildMintsoftAsnListRequest(pageNo: number, options?: MintsoftAsnListScanShape): {
  path: string
  method: 'GET'
} {
  if (!Number.isInteger(pageNo) || pageNo < 1) throw new Error(`Mintsoft ASN List pages start at 1, got ${pageNo}`)
  const query = new URLSearchParams({
    PageNo: String(pageNo),
    Limit: String(MINTSOFT_ASN_LIST_PAGE_LIMIT),
  })
  // The window read needs IDs only, and every parameter it sends is one proven live in combination with
  // PageNo/Limit; IncludeASNItems is left off it rather than assumed to combine.
  if (options?.includeItems !== false) query.set('IncludeASNItems', 'true')
  const warehouseId = options?.warehouseId?.trim()
  if (warehouseId && /^\d+$/.test(warehouseId)) query.set('WarehouseId', warehouseId)
  const sinceLastUpdated = options?.sinceLastUpdated?.trim()
  if (sinceLastUpdated) query.set('SinceLastUpdated', sinceLastUpdated)
  return { path: `/api/ASN/List?${query.toString()}`, method: 'GET' }
}

/** Everything that shapes one scan's requests. `sinceLastUpdated` is a date Mintsoft parses, e.g. 2026-09-01. */
type MintsoftAsnListScanShape = {
  warehouseId?: string | null
  sinceLastUpdated?: string | null
  includeItems?: boolean
}

/** The start of the independent recently-updated window, in the `YYYY-MM-DD` form live Mintsoft accepts. */
export function mintsoftAsnListRecentWindowSince(now: Date = new Date()): string {
  const since = new Date(now.getTime() - MINTSOFT_ASN_LIST_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  return since.toISOString().slice(0, 10)
}

function mintsoftAsnListRowId(row: unknown): string {
  const record = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null
  const id = record?.ID
  if (typeof id === 'number' && Number.isInteger(id)) return String(id)
  if (typeof id === 'string' && /^\d+$/.test(id.trim())) return id.trim()
  throw new MintsoftAsnListIncompleteError('a row has no ASN ID, so it cannot be told apart from the others')
}

type MintsoftAsnListScan = { rows: Array<Record<string, unknown>>; ids: string[]; repeated: boolean }

/**
 * A SHORT PAGE IS A CLAIM, AND THIS IS THE CHECK (round 4, Codex HIGH 2). Asking for the page after it and
 * requiring `[]` is the only way from this client to tell "that was the end" from "that was cut short",
 * and it is the only incompleteness that survives re-scanning, because a deterministic truncation repeats.
 */
async function requireEndOfMintsoftAsnList(
  request: (path: string) => Promise<MintsoftRequestResult<unknown>>,
  shortPageNo: number,
  shortPageLength: number,
  options: MintsoftAsnListOptions & MintsoftAsnListScanShape,
): Promise<void> {
  const nextPageNo = shortPageNo + 1
  const preamble = `page ${shortPageNo} returned ${shortPageLength} rows of ${MINTSOFT_ASN_LIST_PAGE_LIMIT}, which is the end of the list only if page ${nextPageNo} is empty`
  const result = await request(buildMintsoftAsnListRequest(nextPageNo, options).path)
  if (result.error) throw new MintsoftAsnListIncompleteError(`${preamble} — and it failed (${result.status}): ${result.error}`)
  if (!Array.isArray(result.data)) throw new MintsoftAsnListIncompleteError(`${preamble} — and it was not an array`)
  if (result.data.length > 0) {
    throw new MintsoftAsnListIncompleteError(
      `${preamble} — and it still served ${result.data.length} rows, so the short page was a TRUNCATION, not the end. `
      + 'Refusing to read this as the whole list: no ASN will be created until it reads back completely',
    )
  }
}

async function scanMintsoftAsnList(options: MintsoftAsnListOptions & MintsoftAsnListScanShape): Promise<MintsoftAsnListScan> {
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
    if (page.length < MINTSOFT_ASN_LIST_PAGE_LIMIT) {
      await requireEndOfMintsoftAsnList(request, pageNo, page.length, options)
      return { rows, ids, repeated }
    }
  }
  throw new MintsoftAsnListIncompleteError(
    `more than ${MINTSOFT_ASN_LIST_MAX_PAGES} pages of ${MINTSOFT_ASN_LIST_PAGE_LIMIT}; refusing to treat a truncated list as complete`,
  )
}

/** Every ASN row the list serves (with Items), or a MintsoftAsnListIncompleteError. Never a partial list. */
export async function fetchMintsoftAsnListRows(options: MintsoftAsnListOptions = {}): Promise<Array<Record<string, unknown>>> {
  // THE INDEPENDENT READ, AND IT GOES FIRST (round 4, Codex HIGH 2). Re-reading the same paged request
  // cannot see an omission that repeats; a DIFFERENTLY FILTERED request can, because the rows it returns
  // normally fit in one page and a single page has no boundary to lose a row at. It is taken before the
  // full scans so that an ASN created after it cannot make the check refuse a scan that is in fact whole;
  // the same warehouse scope is used, so it can never contain a row the full scan correctly excludes.
  const recent = await scanMintsoftAsnList({ ...options, sinceLastUpdated: mintsoftAsnListRecentWindowSince(), includeItems: false })
  let previous: MintsoftAsnListScan | null = null
  for (let attempt = 1; attempt <= MINTSOFT_ASN_LIST_SCAN_ATTEMPTS; attempt += 1) {
    const scan = await scanMintsoftAsnList(options)
    if (previous && !previous.repeated && !scan.repeated && sameIdSet(previous.ids, scan.ids)) {
      requireRecentWindowIsCovered(recent.ids, scan.ids)
      return scan.rows
    }
    previous = scan
  }
  throw new MintsoftAsnListIncompleteError(
    `the list changed between ${MINTSOFT_ASN_LIST_SCAN_ATTEMPTS} consecutive scans, so no scan can be shown to be complete`,
  )
}

/**
 * The window read is evidence of PRESENCE only: an ASN it served exists, whatever the full scan did. A row
 * it repeated or an ASN it missed says nothing (it is not the list this returns), so neither is a refusal —
 * this check can only ever refuse, never widen what is accepted.
 */
function requireRecentWindowIsCovered(recentIds: readonly string[], acceptedIds: readonly string[]): void {
  const accepted = new Set(acceptedIds)
  const missing = [...new Set(recentIds)].filter((id) => !accepted.has(id))
  if (missing.length === 0) return
  throw new MintsoftAsnListIncompleteError(
    `the recently-updated read served ASN ${missing.join(', ')}, which two agreeing full scans never did, so the `
    + 'full scan is incomplete however consistent it looks. Refusing to read it as the whole list: an ASN it '
    + 'cannot show is one an earlier attempt may have created, and no ASN will be created until the two reads agree',
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
export async function fetchMintsoftAsnsForDuplicateRecovery(options: Omit<MintsoftAsnListOptions, 'warehouseId'> = {}): Promise<WmsAsnRef[]> {
  // TENANT-WIDE, NOT SCOPED TO THE RESERVATION'S WAREHOUSE (review of o3d-bhvu, M3). A push whose
  // response was lost, then a rebind of the warehouse, then a retry: a scan scoped to the NEW warehouse
  // cannot see the ASN the first attempt created at the old one, so the retry creates a second.
  // Unscoped, the earlier ASN is found and findRecoverableMintsoftAsn refuses the mismatch by name.
  // Cost today: 220 ASNs = 3 pages x 2 consistent scans = 6 GETs per creation attempt.
  const rows = await fetchMintsoftAsnListRows({ ...options, warehouseId: null })
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
    // ONE rule for what an item's line identity is, shared with the matcher (round 5, Codex HIGH 2): an
    // item we cannot key is dropped here exactly as before — and, for a row carrying the reservation's
    // POReference, findRecoverableMintsoftAsn refuses the whole decision rather than reading the missing
    // line as "somebody else's ASN". An item with a DETERMINATE identity that is not ours (a numeric
    // SourceLineId, i.e. another integration's) is dropped and counted by remoteItemCount (review L-a).
    const identity = readMintsoftAsnItemLineIdentity(record)
    if (identity.kind !== 'identified') return []
    const sourceLineId = identity.sourceLineId
    const externalLineId = record.ID == null || String(record.ID).trim() === '' ? null : String(record.ID)
    if (!externalLineId) {
      // IT CARRIES OUR LINE ID, SO IT IS OURS (round 4, the shape of Codex HIGH 1). Dropping it would leave
      // the row with fewer lines than items, hasSameLineIdentity would call the ASN somebody else's, and the
      // creator would push a SECOND ASN for a line this one already covers. An item we cannot key is a read
      // we cannot complete, not a row to skip.
      throw new MintsoftAsnListIncompleteError(
        `ASN ${externalAsnId} has an item carrying source line ${sourceLineId} but no item ID of its own, so `
        + 'this ASN cannot be told apart from one an earlier attempt created. Nothing will be created for it '
        + 'until the item reads back with its ID',
      )
    }
    // UNREADABLE IS null, AND null IS NEVER A QUANTITY (round 4, Codex HIGH 1). NaN and Infinity are
    // `typeof 'number'`, so they were reaching the matcher as quantities that match nothing — which the
    // matcher then read as "a different ASN, go ahead and create one". findRecoverableMintsoftAsn refuses
    // on null instead (MintsoftAsnRecoveryQuantityUnreadableError). ONE reader for it, shared with the
    // rule the matcher and the post-create read-back both go through (round 6).
    const expected = readMintsoftAsnItemExpectedQuantity(record)
    return [{
      externalLineId,
      sourceLineId,
      externalProductId: record.ProductId == null ? null : String(record.ProductId),
      sku: typeof record.SKU === 'string' ? record.SKU : null,
      quantity: expected,
      raw: record,
    }]
  })
  // ROUND 8, CODEX HIGH: the status IS READ. It used to be `status: null`, and the creators' normalizer
  // turned that into OPEN — so a COMPLETE ASN recovered after a lost create was recorded as an ASN still
  // to arrive and its receipt was never reconciled. `null` here now means Mintsoft served nothing about a
  // status at all, which `interpretMintsoftWireAsnStatus` answers with `unknown` and the creators refuse;
  // it is no longer a synonym for "open". ROUND 9: the reader resolves MINTSOFT'S vocabulary and nothing
  // else, and a row whose status fields do not resolve or do not AGREE comes back carrying a marked,
  // deliberately unresolvable string instead of a name, so the refusal can say which fields disagreed.
  // One reader, shared with the by-id normalizer.
  return { externalAsnId, status: readMintsoftAsnWireStatusField(row), lines, raw: row }
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
