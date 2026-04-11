import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'
import { requireRole } from '@/lib/auth/server'

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    await requireRole('ADMIN', 'FINANCE', 'MANAGER')
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { filename } = await params
  const safeName = path.basename(filename)
  if (!SAFE_FILENAME.test(safeName) || !safeName.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 })
  }

  const invoiceDir = path.join(process.cwd(), 'uploads', 'invoices')
  const filepath = path.join(invoiceDir, safeName)

  // Path-traversal guard: resolved path must remain under invoiceDir.
  const resolved = path.resolve(filepath)
  if (!resolved.startsWith(path.resolve(invoiceDir) + path.sep)) {
    return NextResponse.json({ error: 'Invalid file' }, { status: 400 })
  }

  try {
    const buffer = await readFile(resolved)
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
