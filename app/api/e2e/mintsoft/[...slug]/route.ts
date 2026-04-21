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

type FakeMintsoftState = {
  apiKey: string
  username?: string
  password?: string
  warehouses: FakeMintsoftWarehouse[]
  stockLevelsByWarehouse: Record<string, FakeMintsoftStockLine[]>
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

  return {
    apiKey,
    username: asString(record.username) ?? undefined,
    password: asString(record.password) ?? undefined,
    warehouses,
    stockLevelsByWarehouse,
  }
}

function isAuthorized(request: NextRequest, state: FakeMintsoftState): boolean {
  return request.headers.get('ms-apikey')?.trim() === state.apiKey
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

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
