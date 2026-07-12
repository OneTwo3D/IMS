import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { startHistoricalImport, getImportProgress } from '@/lib/connectors/woocommerce/orders'

// POST — start the import (returns immediately)
export async function POST(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { dateFrom, dateTo } = await req.json()
  if (!dateFrom || !dateTo) return NextResponse.json({ error: 'Missing date range' }, { status: 400 })

  await startHistoricalImport(dateFrom, dateTo)
  return NextResponse.json({ started: true })
}

// GET — poll for progress
export async function GET() {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const progress = await getImportProgress()
  return NextResponse.json(progress)
}
