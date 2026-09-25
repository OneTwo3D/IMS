import { NextRequest, NextResponse } from 'next/server'
import { requireApiAdmin } from '@/lib/auth/server'
import { SHOPPING_CONNECTORS, type ShoppingConnectorId } from '@/lib/connectors/shopping-registry'

type ManualSyncType = 'orders' | 'products' | 'stock'

function isManualSyncType(value: unknown): value is ManualSyncType {
  return value === 'orders' || value === 'products' || value === 'stock'
}

// DERIVED FROM THE REGISTRY, not a second id union (o3d-remove-parked-connectors). This route used
// to spell `'woocommerce' | 'shopify'` itself, so the ingress accepted exactly the ids somebody had
// remembered here. Registering a connector now widens what this route accepts by construction.
function isShoppingConnector(value: unknown): value is ShoppingConnectorId {
  return typeof value === 'string' && SHOPPING_CONNECTORS.some((connector) => connector.id === value)
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

    // A REGISTERED CONNECTOR WITH NO MANUAL-SYNC ARM FAILS VISIBLY, it does not fall through
    // (o3d-remove-parked-connectors). `isShoppingConnector` is registry-derived, so a second
    // connector reaches here the day it is registered; answering with a named refusal is what stops
    // that showing up as a silent success on the operator's Sync screen.
    return NextResponse.json({
      success: false,
      error: `Manual sync is not wired for the ${connector} connector`,
    }, { status: 501 })
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
