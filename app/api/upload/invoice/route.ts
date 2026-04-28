import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { requireRole } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import {
  hasPdfMagicBytes,
  sanitizeInvoiceUploadFilename,
  validateInvoicePdfMetadata,
} from '@/lib/security/upload-validation'

export async function POST(req: Request) {
  let session
  try {
    session = await requireRole('ADMIN', 'FINANCE', 'MANAGER')
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
  await logActivity({
    entityType: 'SYSTEM',
    tag: 'purchase',
    action: 'uploaded',
    description: `Uploaded invoice PDF: ${filename}`,
    userId: session.user.id,
    metadata: {
      originalFilename: file.name,
      storedFilename: filename,
      storedPath: path.join('uploads', 'invoices', filename),
      sizeBytes: file.size,
    },
  })

  return NextResponse.json({ url: `/uploads/invoices/${filename}` })
}
