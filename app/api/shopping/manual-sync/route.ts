import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth/server'
import { syncShoppingConnectorStock } from '@/lib/shopping'

type ManualSyncType = 'orders' | 'products' | 'stock'
type ShoppingConnector = 'woocommerce' | 'shopify'

function isManualSyncType(value: unknown): value is ManualSyncType {
  return value === 'orders' || value === 'products' || value === 'stock'
}

function isShoppingConnector(value: unknown): value is ShoppingConnector {
  return value === 'woocommerce' || value === 'shopify'
}

function toSerializableResult(result: unknown): unknown {
  if (result == null) return result
  return JSON.parse(JSON.stringify(result))
}

export async function POST(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const type = (body as { type?: unknown })?.type
  const connector = (body as { connector?: unknown })?.connector ?? 'woocommerce'

  if (!isManualSyncType(type)) {
    return NextResponse.json({ success: false, error: 'Invalid sync type' }, { status: 400 })
  }

  if (!isShoppingConnector(connector)) {
    return NextResponse.json({ success: false, error: 'Invalid shopping connector' }, { status: 400 })
  }

  try {
    if (connector === 'woocommerce') {
      if (type === 'orders') {
        const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
        const result = await syncNewWcOrders({ mode: 'manual_reconcile' })
        return NextResponse.json({ success: true, result: toSerializableResult(result) })
      }
      if (type === 'products') {
        const { startManualWcProductSync } = await import('@/lib/connectors/woocommerce/sync/product-sync')
        await startManualWcProductSync()
        return NextResponse.json({ success: true, started: true })
      }
      const { startManualWcStockSync } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
      await startManualWcStockSync()
      return NextResponse.json({ success: true, started: true })
    }

    if (type !== 'stock') {
      return NextResponse.json({
        success: false,
        error: 'Shopify manual order and product sync are not wired yet',
      })
    }

    const result = await syncShoppingConnectorStock('shopify')
    return NextResponse.json({ success: true, result: toSerializableResult(result) })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const session = await requireApiAdmin()
  if (session instanceof NextResponse) return session

  const connector = request.nextUrl.searchParams.get('connector')
  const type = request.nextUrl.searchParams.get('type')

  if (!isShoppingConnector(connector)) {
    return NextResponse.json({ success: false, error: 'Invalid shopping connector' }, { status: 400 })
  }

  if (!isManualSyncType(type)) {
    return NextResponse.json({ success: false, error: 'Invalid sync type' }, { status: 400 })
  }

  if (connector === 'woocommerce' && type === 'products') {
    const { getManualWcProductSyncProgress } = await import('@/lib/connectors/woocommerce/sync/product-sync')
    const progress = await getManualWcProductSyncProgress()
    return NextResponse.json(progress)
  }

  if (connector === 'woocommerce' && type === 'stock') {
    const { getManualWcStockSyncProgress } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
    const progress = await getManualWcStockSyncProgress()
    return NextResponse.json(progress)
  }

  return NextResponse.json({
    success: false,
    error: 'Progress polling is not available for this sync type',
  }, { status: 400 })
}
