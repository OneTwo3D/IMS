import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getE2eRouteAccessError } from '@/lib/testing/e2e-route-guard'

const E2E_MINTSOFT_STATE_KEY = 'e2e_mintsoft_state'

type FakeMintsoftWarehouse = {
  id: string
  name: string
}

type FakeMintsoftStockLine = {
  productId: number | null
  warehouseId: string | null
  clientId: number | null
  sku: string
  level: number
  preOrderable: boolean
  bundle: boolean
  lowStockLevel: number
  breakdown: unknown[]
}

type FakeMintsoftProduct = {
  id: string
  sku: string
  name: string
  ean: string | null
  customsDescription: string | null
  commodityCode: string | null
  countryOfManufacture: string | null
  weight: number | null
  height: number | null
  width: number | null
  depth: number | null
  imageUrl: string | null
}

type FakeMintsoftReturn = {
  id: string
  warehouseId: string | null
  sku: string | null
  qty: number | null
  orderReference: string | null
  reason: string | null
  receivedAt: string | null
}

type FakeMintsoftAsnLine = {
  id: string
  sourceLineId: string
  productId: string | null
  sku: string | null
  quantity: number
}

/**
 * o3d-vcw8: the fake holds an ASN the way Mintsoft does — `POReference`, `GoodsInType`, a header `Quantity`
 * that is a PACKAGE COUNT, `SupplierNotes`, and items keyed by `SourceLineId`. There is no callback field
 * of any kind, because Mintsoft has none.
 */
type FakeMintsoftAsn = {
  id: string
  warehouseId: string | null
  reference: string | null
  supplierNotes: string | null
  estimatedDelivery: string | null
  goodsInType: string
  /** The header package count, NOT a quantity of goods. */
  quantity: number
  statusId: number
  status: string
  createdAt: string
  lines: FakeMintsoftAsnLine[]
}

/** `GET /api/ASN/GoodsInTypes`, read live 2026-09-24. `NewASN.GoodsInType` must be one of these. */
const FAKE_MINTSOFT_GOODS_IN_TYPES = [
  'TwentyFtContainer',
  'FortyFtContainer',
  'Pallet',
  'Carton',
  'FortyFtContainerHC',
  'FortyFiveFtContainer',
  'FortyFiveFtContainerHC',
]

/** Mintsoft answers EVERY create failure with HTTP 200 and a `ToolkitResult` carrying the verdict. */
function fakeMintsoftToolkitResult(id: number, success: boolean, message: string): NextResponse {
  return NextResponse.json({
    ID: id,
    Success: success,
    SensitiveData: null,
    Message: message,
    WarningMessage: null,
    AllocatedFromReplen: false,
  })
}

type FakeMintsoftState = {
  apiKey: string
  username?: string
  password?: string
  warehouses: FakeMintsoftWarehouse[]
  stockLevelsByWarehouse: Record<string, FakeMintsoftStockLine[]>
  products: FakeMintsoftProduct[]
  returns: FakeMintsoftReturn[]
  asns: FakeMintsoftAsn[]
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function getFakeMintsoftState(): Promise<FakeMintsoftState | null> {
  const row = await db.setting.findUnique({
    where: { key: E2E_MINTSOFT_STATE_KEY },
    select: { value: true },
  })
  const record = parseJsonRecord(row?.value ?? null)
  if (!record) return null

  const apiKey = asString(record.apiKey)
  if (!apiKey) return null

  const warehouses = asArray(record.warehouses)
    .map((value) => {
      const warehouse = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const id = asString(warehouse?.id)
      const name = asString(warehouse?.name)
      if (!id || !name) return null
      return { id, name }
    })
    .filter((value): value is FakeMintsoftWarehouse => Boolean(value))

  const stockLevelsByWarehouseRecord = record.stockLevelsByWarehouse && typeof record.stockLevelsByWarehouse === 'object' && !Array.isArray(record.stockLevelsByWarehouse)
    ? record.stockLevelsByWarehouse as Record<string, unknown>
    : {}
  const stockLevelsByWarehouse = Object.fromEntries(
    Object.entries(stockLevelsByWarehouseRecord).map(([warehouseId, value]) => [
      warehouseId,
      asArray(value)
        .map((line) => {
          const recordLine = line && typeof line === 'object' && !Array.isArray(line)
            ? line as Record<string, unknown>
            : null
          const sku = asString(recordLine?.sku)
          if (!sku) return null

          return {
            productId: recordLine?.productId == null ? null : asNumber(recordLine.productId, 0),
            warehouseId: recordLine?.warehouseId == null ? null : asString(recordLine.warehouseId),
            clientId: recordLine?.clientId == null ? null : asNumber(recordLine.clientId, 0),
            sku,
            level: asNumber(recordLine?.level, 0),
            preOrderable: asBoolean(recordLine?.preOrderable, true),
            bundle: asBoolean(recordLine?.bundle, false),
            lowStockLevel: asNumber(recordLine?.lowStockLevel, 0),
            breakdown: asArray(recordLine?.breakdown),
          } satisfies FakeMintsoftStockLine
        })
        .filter((line): line is FakeMintsoftStockLine => Boolean(line)),
    ]),
  )
  const products = asArray(record.products)
    .map((value) => {
      const product = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const id = asString(product?.id)
      const sku = asString(product?.sku)
      const name = asString(product?.name)
      if (!id || !sku || !name) return null

      return {
        id,
        sku,
        name,
        ean: asString(product?.ean),
        customsDescription: asString(product?.customsDescription),
        commodityCode: asString(product?.commodityCode),
        countryOfManufacture: asString(product?.countryOfManufacture),
        weight: product?.weight == null ? null : asNumber(product.weight, 0),
        height: product?.height == null ? null : asNumber(product.height, 0),
        width: product?.width == null ? null : asNumber(product.width, 0),
        depth: product?.depth == null ? null : asNumber(product.depth, 0),
        imageUrl: asString(product?.imageUrl),
      } satisfies FakeMintsoftProduct
    })
    .filter((value): value is FakeMintsoftProduct => Boolean(value))
  const returns = asArray(record.returns)
    .map((value) => {
      const item = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const id = asString(item?.id)
      if (!id) return null

      return {
        id,
        warehouseId: asString(item?.warehouseId),
        sku: asString(item?.sku),
        qty: item?.qty == null ? null : asNumber(item.qty, 0),
        orderReference: asString(item?.orderReference),
        reason: asString(item?.reason),
        receivedAt: asString(item?.receivedAt),
      } satisfies FakeMintsoftReturn
    })
    .filter((value): value is FakeMintsoftReturn => Boolean(value))
  const asns = asArray(record.asns)
    .map((value) => {
      const asn = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
      const id = asString(asn?.id)
      if (!id) return null

      const lines = asArray(asn?.lines)
        .map((line) => {
          const recordLine = line && typeof line === 'object' && !Array.isArray(line)
            ? line as Record<string, unknown>
            : null
          const lineId = asString(recordLine?.id)
          const sourceLineId = asString(recordLine?.sourceLineId)
          if (!lineId || !sourceLineId) return null

          return {
            id: lineId,
            sourceLineId,
            productId: asString(recordLine?.productId),
            sku: asString(recordLine?.sku),
            quantity: asNumber(recordLine?.quantity, 0),
          } satisfies FakeMintsoftAsnLine
        })
        .filter((line): line is FakeMintsoftAsnLine => Boolean(line))

      return {
        id,
        warehouseId: asString(asn?.warehouseId),
        reference: asString(asn?.reference),
        supplierNotes: asString(asn?.supplierNotes),
        estimatedDelivery: asString(asn?.estimatedDelivery),
        goodsInType: asString(asn?.goodsInType) ?? 'Carton',
        quantity: asNumber(asn?.quantity, 1),
        statusId: asNumber(asn?.statusId, 1),
        status: asString(asn?.status) ?? 'NEW',
        createdAt: asString(asn?.createdAt) ?? new Date().toISOString(),
        lines,
      } satisfies FakeMintsoftAsn
    })
    .filter((value): value is FakeMintsoftAsn => Boolean(value))

  return {
    apiKey,
    username: asString(record.username) ?? undefined,
    password: asString(record.password) ?? undefined,
    warehouses,
    stockLevelsByWarehouse,
    products,
    returns,
    asns,
  }
}

function isAuthorized(request: NextRequest, state: FakeMintsoftState): boolean {
  return request.headers.get('ms-apikey')?.trim() === state.apiKey
}

function mapMintsoftProductResponse(product: FakeMintsoftProduct) {
  return {
    ProductId: Number(product.id),
    SKU: product.sku,
    Name: product.name,
    EAN: product.ean,
    CustomsDescription: product.customsDescription,
    CommodityCode: product.commodityCode ? { Code: product.commodityCode } : null,
    CountryOfManufacture: product.countryOfManufacture ? { Code: product.countryOfManufacture } : null,
    Weight: product.weight,
    Height: product.height,
    Width: product.width,
    Depth: product.depth,
    ImageURL: product.imageUrl,
  }
}

/**
 * `GET /api/ASN/{id}`, in the LIVE `ASN`/`ASNItem` shape (o3d-vcw8, captured from ASN 6117 on 2026-09-24).
 * It used to answer with an invented `AsnId`/`Reference`/`Status`/`Lines` shape that agreed with the
 * equally invented client — which is precisely how a create contract that cannot work passed every e2e run.
 * `ASNStatus` is an OBJECT and carries NO ExternalName (that trick is order-only), quantities are
 * `QuantityExpected`/`QuantityReceieved` (Mintsoft's spelling)/`QuantityBooked`/`OnOrder`.
 */
function mapMintsoftAsnResponse(asn: FakeMintsoftAsn) {
  const asnId = /^\d+$/.test(asn.id) ? Number(asn.id) : asn.id
  return {
    CLIENTSHORTNAME: 'E2E Fake Client',
    POReference: asn.reference,
    Supplier: null,
    SupplierNotes: asn.supplierNotes,
    EstimatedDelivery: asn.estimatedDelivery,
    Comments: null,
    GoodsInType: asn.goodsInType,
    Quantity: asn.quantity,
    ASNStatus: { Name: asn.status, Colour: 'purple', TextColour: null, ID: asn.statusId },
    ASNStatusId: asn.statusId,
    Shipped: false,
    Items: asn.lines.map((line) => ({
      ASNId: asnId,
      ProductId: line.productId && /^\d+$/.test(line.productId) ? Number(line.productId) : line.productId,
      QuantityExpected: line.quantity,
      QuantityReceieved: 0,
      QuantityBooked: 0,
      OnOrder: 0,
      SSCCNumber: null,
      Complete: false,
      SourceLineId: line.sourceLineId,
      SKU: line.sku,
      ID: line.id,
    })),
    WarehouseId: asn.warehouseId && /^\d+$/.test(asn.warehouseId) ? Number(asn.warehouseId) : asn.warehouseId,
    ClientId: 89,
    ID: asnId,
    LastUpdated: asn.createdAt,
  }
}

/**
 * `GET /api/ASN/List`, shaped like the live rows (o3d-bhvu): `ID`, `POReference`, `WarehouseId`, and
 * `Items` of `{ ID, SourceLineId, ProductId, SKU, QuantityExpected }` when IncludeASNItems=true, else
 * `null`. Exported so the paging contract can be unit-tested without the e2e harness.
 */
export function fakeMintsoftAsnListResponse(asns: FakeMintsoftAsn[], params: URLSearchParams): NextResponse {
  const pageNo = Number.parseInt(params.get('PageNo') ?? '1', 10)
  const limitRaw = params.get('Limit')
  const limit = limitRaw == null ? 100 : Number.parseInt(limitRaw, 10)
  if (!Number.isInteger(pageNo) || pageNo < 1) {
    return NextResponse.json({ Message: 'An error has occurred.' }, { status: 500 })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ Message: 'The request is invalid.' }, { status: 400 })
  }
  const warehouseId = params.get('WarehouseId')
  const includeItems = params.get('IncludeASNItems') === 'true'
  const scoped = warehouseId ? asns.filter((asn) => asn.warehouseId === warehouseId) : asns
  const page = scoped.slice((pageNo - 1) * limit, pageNo * limit)
  return NextResponse.json(page.map((asn) => ({
    ID: /^\d+$/.test(asn.id) ? Number(asn.id) : asn.id,
    POReference: asn.reference,
    WarehouseId: asn.warehouseId && /^\d+$/.test(asn.warehouseId) ? Number(asn.warehouseId) : asn.warehouseId,
    ASNStatus: { Name: asn.status },
    LastUpdated: asn.createdAt,
    Items: includeItems
      ? asn.lines.map((line) => ({
          ID: line.id,
          SourceLineId: line.sourceLineId,
          ProductId: line.productId && /^\d+$/.test(line.productId) ? Number(line.productId) : line.productId,
          SKU: line.sku,
          QuantityExpected: line.quantity,
        }))
      : null,
  })))
}

export function parseFakeMintsoftDirectAsnPath(path: string): string | null {
  if (!path.startsWith('api/ASN/')) return null
  return decodeURIComponent(path.slice('api/ASN/'.length))
}

function buildNextNumericId(values: string[]): string {
  return String(
    Math.max(
      0,
      ...values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    ) + 1,
  )
}

function readFakeMintsoftProductFields(
  body: Record<string, unknown> | null,
  current?: FakeMintsoftProduct,
): FakeMintsoftProduct | null {
  const sku = asString(body?.SKU ?? body?.sku) ?? current?.sku ?? null
  const name = asString(body?.Name ?? body?.name) ?? current?.name ?? null
  if (!sku || !name) return null

  return {
    id: current?.id ?? '',
    sku,
    name,
    ean: Object.prototype.hasOwnProperty.call(body ?? {}, 'EAN')
      ? asString(body?.EAN)
      : (current?.ean ?? null),
    customsDescription: Object.prototype.hasOwnProperty.call(body ?? {}, 'CustomsDescription')
      ? asString(body?.CustomsDescription)
      : (current?.customsDescription ?? null),
    commodityCode: Object.prototype.hasOwnProperty.call(body ?? {}, 'CommodityCode')
      ? asString((body?.CommodityCode as Record<string, unknown> | null)?.Code)
      : (current?.commodityCode ?? null),
    countryOfManufacture: Object.prototype.hasOwnProperty.call(body ?? {}, 'CountryOfManufacture')
      ? asString((body?.CountryOfManufacture as Record<string, unknown> | null)?.Code)
      : (current?.countryOfManufacture ?? null),
    weight: Object.prototype.hasOwnProperty.call(body ?? {}, 'Weight')
      ? (body?.Weight == null ? null : asNumber(body.Weight, 0))
      : (current?.weight ?? null),
    height: Object.prototype.hasOwnProperty.call(body ?? {}, 'Height')
      ? (body?.Height == null ? null : asNumber(body.Height, 0))
      : (current?.height ?? null),
    width: Object.prototype.hasOwnProperty.call(body ?? {}, 'Width')
      ? (body?.Width == null ? null : asNumber(body.Width, 0))
      : (current?.width ?? null),
    depth: Object.prototype.hasOwnProperty.call(body ?? {}, 'Depth')
      ? (body?.Depth == null ? null : asNumber(body.Depth, 0))
      : (current?.depth ?? null),
    imageUrl: Object.prototype.hasOwnProperty.call(body ?? {}, 'ImageURL')
      ? asString(body?.ImageURL)
      : (current?.imageUrl ?? null),
  }
}

async function persistFakeMintsoftState(state: FakeMintsoftState): Promise<void> {
  await db.setting.upsert({
    where: { key: E2E_MINTSOFT_STATE_KEY },
    create: {
      key: E2E_MINTSOFT_STATE_KEY,
      value: JSON.stringify(state),
    },
    update: {
      value: JSON.stringify(state),
    },
  })
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> },
) {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError

  const state = await getFakeMintsoftState()
  if (!state) {
    return NextResponse.json({ error: 'Mintsoft E2E state not configured' }, { status: 503 })
  }

  const { slug } = await context.params
  const path = slug.join('/')

  if (path === 'api/Warehouse') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json(
      state.warehouses.map((warehouse) => ({
        Id: Number(warehouse.id),
        Name: warehouse.name,
      })),
    )
  }

  if (path === 'api/Product/StockLevels') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const warehouseId = request.nextUrl.searchParams.get('WarehouseId') ?? request.nextUrl.searchParams.get('warehouseId')
    if (!warehouseId?.trim()) {
      return NextResponse.json({ error: 'WarehouseId is required' }, { status: 400 })
    }

    const lines = state.stockLevelsByWarehouse[warehouseId.trim()] ?? []
    return NextResponse.json(
      lines.map((line) => ({
        ProductId: line.productId ?? 0,
        WarehouseId: Number(line.warehouseId ?? warehouseId.trim()),
        ClientId: line.clientId ?? 0,
        SKU: line.sku,
        Level: line.level,
        PreOrderable: line.preOrderable ?? true,
        Bundle: line.bundle ?? false,
        LowStockLevel: line.lowStockLevel ?? 0,
        Breakdown: line.breakdown ?? [],
      })),
    )
  }

  if (path === 'api/Product') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sku = request.nextUrl.searchParams.get('SKU') ?? request.nextUrl.searchParams.get('sku')
    if (sku?.trim()) {
      const matches = state.products.filter((product) => product.sku === sku.trim())
      return NextResponse.json(matches.map(mapMintsoftProductResponse))
    }

    return NextResponse.json(state.products.map(mapMintsoftProductResponse))
  }

  if (path === 'api/Returns') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const sinceParam = request.nextUrl.searchParams.get('since')
    const since = sinceParam ? new Date(sinceParam) : null
    const filtered = state.returns.filter((item) => {
      if (!since || !Number.isFinite(since.getTime()) || !item.receivedAt) return true
      const receivedAt = new Date(item.receivedAt)
      return Number.isFinite(receivedAt.getTime()) && receivedAt >= since
    })

    return NextResponse.json(
      filtered.map((item) => ({
        ReturnId: item.id,
        WarehouseId: item.warehouseId ? Number(item.warehouseId) : null,
        SKU: item.sku,
        Qty: item.qty,
        OrderNumber: item.orderReference,
        Reason: item.reason,
        ReceivedAt: item.receivedAt,
      })),
    )
  }

  // o3d-bhvu: the fake follows the LIVE contract on the read side. Live Mintsoft answers `GET /api/ASN`
  // with 405 (the path is the create route) and serves the list at `GET /api/ASN/List`, paged by
  // PageNo/Limit with Limit capped at 100 (400 above it), `[]` past the end, and Items only with
  // IncludeASNItems=true. Serving the list at `GET /api/ASN` here is how the broken client passed e2e.
  if (path === 'api/ASN') {
    return NextResponse.json({ Message: "The requested resource does not support http method 'GET'." }, { status: 405 })
  }

  if (path === 'api/ASN/List') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return fakeMintsoftAsnListResponse(state.asns, request.nextUrl.searchParams)
  }

  const directAsnId = parseFakeMintsoftDirectAsnPath(path)
  if (directAsnId != null) {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const asn = state.asns.find((entry) => entry.id === directAsnId)
    if (!asn) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(mapMintsoftAsnResponse(asn))
  }

  if (path.startsWith('api/Product/')) {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const productId = path.slice('api/Product/'.length)
    const product = state.products.find((entry) => entry.id === productId)
    if (!product) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(mapMintsoftProductResponse(product))
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> },
) {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError

  const state = await getFakeMintsoftState()
  if (!state) {
    return NextResponse.json({ error: 'Mintsoft E2E state not configured' }, { status: 503 })
  }

  const { slug } = await context.params
  const path = slug.join('/')

  if (path === 'api/Auth') {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const username = asString(body?.Username ?? body?.username)
    const password = asString(body?.Password ?? body?.password)

    if (!state.username || !state.password || username !== state.username || password !== state.password) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json(state.apiKey)
  }

  if (path === 'api/Product') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const productId = asString(body?.ID ?? body?.id)
    if (!productId) {
      return NextResponse.json({ error: 'ID is required' }, { status: 400 })
    }

    const index = state.products.findIndex((entry) => entry.id === productId)
    if (index < 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const current = state.products[index]!
    const updated = readFakeMintsoftProductFields(body, current)
    if (!updated) {
      return NextResponse.json({ error: 'SKU and Name are required' }, { status: 400 })
    }

    state.products[index] = updated
    await persistFakeMintsoftState(state)
    return NextResponse.json(mapMintsoftProductResponse(updated))
  }

  // o3d-vcw8: there is NO `POST /api/ASN` in Mintsoft. The create is `PUT /api/ASN` (below) and
  // `POST /api/ASN/{id}` is the UPDATE route. The fake used to implement this invented POST, which is how a
  // client that could never create an ASN passed e2e; it answers the way a write-only path does instead.
  if (path === 'api/ASN') {
    return NextResponse.json({ Message: "The requested resource does not support http method 'POST'." }, { status: 405 })
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ slug: string[] }> },
) {
  const authError = getE2eRouteAccessError(request)
  if (authError) return authError

  const state = await getFakeMintsoftState()
  if (!state) {
    return NextResponse.json({ error: 'Mintsoft E2E state not configured' }, { status: 503 })
  }

  const { slug } = await context.params
  const path = slug.join('/')

  // `PUT /api/ASN` IS THE ASN CREATE, and every failure of it is an HTTP 200 carrying a ToolkitResult with
  // Success: false (o3d-vcw8, three live attempts on 2026-09-24). The fake reproduces that exactly —
  // including the two rejections the live probe collected — so a client that trusts the status code, omits
  // GoodsInType or sends ClientId fails here rather than at a live warehouse.
  if (path === 'api/ASN') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (body != null && Object.prototype.hasOwnProperty.call(body, 'ClientId')) {
      return fakeMintsoftToolkitResult(0, false, 'Client Users cannot specify a ClientId when creating an ASN!')
    }

    const goodsInType = asString(body?.GoodsInType)
    if (!goodsInType || !FAKE_MINTSOFT_GOODS_IN_TYPES.includes(goodsInType)) {
      return fakeMintsoftToolkitResult(0, false, 'Invalid GoodsInType:  See ASN/GoodsInTypes for valid types')
    }

    const warehouseId = asString(body?.WarehouseId)
    const reference = asString(body?.POReference)
    const lines = asArray(body?.Items)
      .map((line, index) => {
        const recordLine = line && typeof line === 'object' && !Array.isArray(line)
          ? line as Record<string, unknown>
          : null
        const sourceLineId = asString(recordLine?.SourceLineId)
        if (!sourceLineId) return null

        return {
          id: `${Date.now()}-${index + 1}`,
          sourceLineId,
          productId: asString(recordLine?.ProductId),
          sku: asString(recordLine?.SKU),
          quantity: asNumber(recordLine?.Quantity, 0),
        } satisfies FakeMintsoftAsnLine
      })
      .filter((line): line is FakeMintsoftAsnLine => Boolean(line))

    if (!warehouseId || !reference || lines.length === 0) {
      // The generic Success-false-with-HTTP-200 case: a body Mintsoft's validation rejects before any row
      // is written (proven live: a rejected create leaves the tenant's ASN id set byte-identical).
      return fakeMintsoftToolkitResult(0, false, 'ASN could not be created: WarehouseId, POReference and at least one item are required')
    }

    const asnId = buildNextNumericId(state.asns.map((asn) => asn.id))
    const asn: FakeMintsoftAsn = {
      id: asnId,
      warehouseId,
      reference,
      supplierNotes: asString(body?.SupplierNotes),
      estimatedDelivery: asString(body?.EstimatedDelivery),
      goodsInType,
      quantity: asNumber(body?.Quantity, 1),
      statusId: 1,
      status: 'NEW',
      createdAt: new Date().toISOString(),
      lines: lines.map((line, index) => ({
        ...line,
        id: `${asnId}-${index + 1}`,
      })),
    }

    state.asns.push(asn)
    await persistFakeMintsoftState(state)
    return fakeMintsoftToolkitResult(Number(asnId), true, 'ASN Successfully created. Please note the ID for future reference.')
  }

  if (path !== 'api/Product') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!isAuthorized(request, state)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const nextId = String(
    Math.max(
      0,
      ...state.products
        .map((product) => Number(product.id))
        .filter((value) => Number.isFinite(value)),
    ) + 1,
  )
  const created = readFakeMintsoftProductFields(body)
  if (!created) {
    return NextResponse.json({ error: 'SKU and Name are required' }, { status: 400 })
  }

  created.id = nextId
  state.products.push(created)
  await persistFakeMintsoftState(state)
  return NextResponse.json(mapMintsoftProductResponse(created))
}
