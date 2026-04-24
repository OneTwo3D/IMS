import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { startInitialImport, getInitialImportProgress } from '@/lib/connectors/woocommerce/sync/initial-import'

// POST — start the initial order import (returns immediately)
export async function POST() {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await startInitialImport()
  return NextResponse.json({ started: true })
}

// GET — poll for progress
export async function GET() {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sync')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const progress = await getInitialImportProgress()
  return NextResponse.json(progress)
}
