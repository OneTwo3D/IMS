import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { assertE2eRouteModuleEnabled, getE2eRouteAccessError } from '@/lib/testing/e2e-route-guard'

assertE2eRouteModuleEnabled('app/api/e2e/mintsoft/[...slug]/route.ts')

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

type FakeMintsoftAsn = {
  id: string
  warehouseId: string | null
  reference: string | null
  supplierReference: string | null
  carrier: string | null
  eta: string | null
  callbackUrl: string | null
  autoCallback: boolean
  status: string
  createdAt: string
  lines: FakeMintsoftAsnLine[]
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
        supplierReference: asString(asn?.supplierReference),
        carrier: asString(asn?.carrier),
        eta: asString(asn?.eta),
        callbackUrl: asString(asn?.callbackUrl),
        autoCallback: asBoolean(asn?.autoCallback, true),
        status: asString(asn?.status) ?? 'OPEN',
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

function mapMintsoftAsnResponse(asn: FakeMintsoftAsn) {
  return {
    AsnId: /^\d+$/.test(asn.id) ? Number(asn.id) : asn.id,
    WarehouseId: asn.warehouseId && /^\d+$/.test(asn.warehouseId) ? Number(asn.warehouseId) : asn.warehouseId,
    Reference: asn.reference,
    SupplierReference: asn.supplierReference,
    Carrier: asn.carrier,
    ETA: asn.eta,
    CallbackUrl: asn.callbackUrl,
    AutoCallback: asn.autoCallback,
    Status: asn.status,
    CreatedAt: asn.createdAt,
    Lines: asn.lines.map((line) => ({
      AsnLineId: line.id,
      SourceLineId: line.sourceLineId,
      ProductId: line.productId && /^\d+$/.test(line.productId) ? Number(line.productId) : line.productId,
      SKU: line.sku,
      Quantity: line.quantity,
    })),
  }
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

  if (path === 'api/ASN') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return NextResponse.json(state.asns.map(mapMintsoftAsnResponse))
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

  if (path === 'api/ASN') {
    if (!isAuthorized(request, state)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const warehouseId = asString(body?.WarehouseId ?? body?.warehouseId)
    const reference = asString(body?.Reference ?? body?.reference)
    const lines = asArray(body?.Lines ?? body?.lines)
      .map((line, index) => {
        const recordLine = line && typeof line === 'object' && !Array.isArray(line)
          ? line as Record<string, unknown>
          : null
        const sourceLineId = asString(recordLine?.SourceLineId ?? recordLine?.sourceLineId)
        if (!sourceLineId) return null

        return {
          id: `${Date.now()}-${index + 1}`,
          sourceLineId,
          productId: asString(recordLine?.ProductId ?? recordLine?.productId),
          sku: asString(recordLine?.SKU ?? recordLine?.sku),
          quantity: asNumber(recordLine?.Quantity ?? recordLine?.quantity, 0),
        } satisfies FakeMintsoftAsnLine
      })
      .filter((line): line is FakeMintsoftAsnLine => Boolean(line))

    if (!warehouseId || !reference || lines.length === 0) {
      return NextResponse.json({ error: 'WarehouseId, Reference, and at least one line are required' }, { status: 400 })
    }

    const asnId = buildNextNumericId(state.asns.map((asn) => asn.id))
    const asn: FakeMintsoftAsn = {
      id: asnId,
      warehouseId,
      reference,
      supplierReference: asString(body?.SupplierReference ?? body?.supplierReference),
      carrier: asString(body?.Carrier ?? body?.carrier),
      eta: asString(body?.ETA ?? body?.eta),
      callbackUrl: asString(body?.CallbackUrl ?? body?.callbackUrl),
      autoCallback: asBoolean(body?.AutoCallback ?? body?.autoCallback, true),
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      lines: lines.map((line, index) => ({
        ...line,
        id: `${asnId}-${index + 1}`,
      })),
    }

    state.asns.push(asn)
    await persistFakeMintsoftState(state)
    return NextResponse.json(mapMintsoftAsnResponse(asn))
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
