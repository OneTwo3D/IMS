import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { parseShoppingConnectorId } from '@/lib/connectors/shopping-registry'

// b8i6.5: route the import by shopping connector. Defaults to WooCommerce for
// back-compat; an unknown connector is rejected (400) and a known-but-unbuilt
// one (e.g. Shopify, whose order import isn't implemented yet) returns 501.

// POST — start the initial order import (returns immediately)
export async function POST(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const connector = parseShoppingConnectorId(new URL(req.url).searchParams.get('connector'))
  if (!connector) return NextResponse.json({ error: 'Unknown shopping connector' }, { status: 400 })
  if (connector !== 'woocommerce') {
    return NextResponse.json({ error: `Initial order import is not implemented for ${connector}` }, { status: 501 })
  }

  const { startInitialImport } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  await startInitialImport()
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
    return NextResponse.json({ error: `Initial order import is not implemented for ${connector}` }, { status: 501 })
  }

  const { getInitialImportProgress } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  const progress = await getInitialImportProgress()
  return NextResponse.json(progress)
}
