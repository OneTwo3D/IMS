import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { requireRole } from '@/lib/auth/server'
import {
  hasPdfMagicBytes,
  sanitizeInvoiceUploadFilename,
  validateInvoicePdfMetadata,
} from '@/lib/security/upload-validation'

export async function POST(req: Request) {
  try {
    await requireRole('ADMIN', 'FINANCE', 'MANAGER')
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const validation = validateInvoicePdfMetadata(file)
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

  // Quick magic-byte check: real PDFs start with "%PDF-".
  const buffer = Buffer.from(await file.arrayBuffer())
  if (!hasPdfMagicBytes(buffer)) {
    return NextResponse.json({ error: 'Invalid PDF file.' }, { status: 400 })
  }

  const dir = path.join(process.cwd(), 'uploads', 'invoices')
  await mkdir(dir, { recursive: true })

  const filename = sanitizeInvoiceUploadFilename(file.name)
  const filepath = path.join(dir, filename)

  await writeFile(filepath, buffer)

  return NextResponse.json({ url: `/uploads/invoices/${filename}` })
}
