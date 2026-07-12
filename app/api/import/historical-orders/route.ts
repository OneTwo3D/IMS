import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { parseShoppingConnectorId } from '@/lib/connectors/shopping-registry'

// b8i6.5: route the import by shopping connector. Defaults to WooCommerce for
// back-compat; an unknown connector is rejected (400) and a known-but-unbuilt
// one (e.g. Shopify, whose order import isn't implemented yet) returns 501.

// POST — start the import (returns immediately)
export async function POST(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { dateFrom, dateTo } = body
  if (!dateFrom || !dateTo) return NextResponse.json({ error: 'Missing date range' }, { status: 400 })

  const connector = parseShoppingConnectorId(body.connector)
  if (!connector) return NextResponse.json({ error: `Unknown shopping connector: ${body.connector}` }, { status: 400 })
  if (connector !== 'woocommerce') {
    return NextResponse.json({ error: `Historical order import is not implemented for ${connector}` }, { status: 501 })
  }

  const { startHistoricalImport } = await import('@/lib/connectors/woocommerce/orders')
  await startHistoricalImport(dateFrom, dateTo)
  return NextResponse.json({ started: true, connector })
}

// GET — poll for progress
export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const connector = parseShoppingConnectorId(new URL(req.url).searchParams.get('connector'))
  if (!connector) return NextResponse.json({ error: 'Unknown shopping connector' }, { status: 400 })
  if (connector !== 'woocommerce') {
    return NextResponse.json({ error: `Historical order import is not implemented for ${connector}` }, { status: 501 })
  }

  const { getImportProgress } = await import('@/lib/connectors/woocommerce/orders')
  const progress = await getImportProgress()
  return NextResponse.json(progress)
}
