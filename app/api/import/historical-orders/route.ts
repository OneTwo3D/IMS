import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { startHistoricalImport, getImportProgress } from '@/lib/connectors/woocommerce/orders'

// POST — start the import (returns immediately)
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { dateFrom, dateTo } = await req.json()
  if (!dateFrom || !dateTo) return NextResponse.json({ error: 'Missing date range' }, { status: 400 })

  await startHistoricalImport(dateFrom, dateTo)
  return NextResponse.json({ started: true })
}

// GET — poll for progress
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const progress = await getImportProgress()
  return NextResponse.json(progress)
}
