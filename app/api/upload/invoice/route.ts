import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { requireRole } from '@/lib/auth/server'

export async function POST(req: Request) {
  try {
    await requireRole('ADMIN', 'FINANCE', 'MANAGER')
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  if (file.type !== 'application/pdf') {
    return NextResponse.json({ error: 'Only PDF files are accepted' }, { status: 400 })
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 20MB.' }, { status: 400 })
  }

  // Quick magic-byte check: real PDFs start with "%PDF-".
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return NextResponse.json({ error: 'Invalid PDF file.' }, { status: 400 })
  }

  const dir = path.join(process.cwd(), 'uploads', 'invoices')
  await mkdir(dir, { recursive: true })

  const timestamp = Date.now()
  // Force basename and restrict to a safe charset, then append extension.
  const rawBase = path.basename(file.name).replace(/\.[^.]+$/, '')
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'invoice'
  const filename = `${timestamp}-${safeBase}.pdf`
  const filepath = path.join(dir, filename)

  await writeFile(filepath, buffer)

  return NextResponse.json({ url: `/uploads/invoices/${filename}` })
}
