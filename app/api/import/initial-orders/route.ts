import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { startInitialImport, getInitialImportProgress } from '@/lib/connectors/woocommerce/sync/initial-import'

// POST — start the initial order import (returns immediately)
export async function POST() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await startInitialImport()
  return NextResponse.json({ started: true })
}

// GET — poll for progress
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const progress = await getInitialImportProgress()
  return NextResponse.json(progress)
}
