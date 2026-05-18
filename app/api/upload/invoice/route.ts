import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/server'
import { logActivity } from '@/lib/activity-log'
import {
  hasPdfMagicBytes,
  sanitizeInvoiceUploadFilename,
  validateInvoicePdfMetadata,
} from '@/lib/security/upload-validation'
import { getInvoiceStoredPath, getInvoiceUploadUrl } from '@/lib/upload-storage'
import { fileScanAuditMetadata } from '@/lib/security/file-scan'
import { storeInvoicePdfUpload } from '@/lib/invoice-upload-storage'

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

  const filename = sanitizeInvoiceUploadFilename(file.name)
  const stored = await storeInvoicePdfUpload(filename, buffer)
  if (!stored.ok) {
    await logActivity({
      entityType: 'SYSTEM',
      tag: 'purchase',
      action: 'rejected',
      description: `Rejected invoice PDF upload: ${filename}`,
      userId: session.user.id,
      metadata: {
        originalFilename: file.name,
        storedFilename: filename,
        sizeBytes: file.size,
        ...fileScanAuditMetadata(stored.scan),
      },
    })
    return NextResponse.json({ error: stored.error }, { status: stored.status })
  }

  await logActivity({
    entityType: 'SYSTEM',
    tag: 'purchase',
    action: 'uploaded',
    description: `Uploaded invoice PDF: ${filename}`,
    userId: session.user.id,
    metadata: {
      originalFilename: file.name,
      storedFilename: filename,
      storedPath: getInvoiceStoredPath(filename),
      sizeBytes: file.size,
      ...fileScanAuditMetadata(stored.scan),
    },
  })

  return NextResponse.json({ url: getInvoiceUploadUrl(filename) })
}
