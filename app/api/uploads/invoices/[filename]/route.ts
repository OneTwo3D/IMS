import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/server'
import { resolveInvoiceUploadFilePath } from '@/lib/upload-storage'
import { uploadFileResponse } from '@/lib/upload-file-response'

export const runtime = 'nodejs'

// Supplier invoice PDFs can contain commercial data, so serving stays gated to
// admin/finance/manager roles even though branding and avatars are public.
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
  const filepath = resolveInvoiceUploadFilePath(filename)
  if (!filepath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    return await uploadFileResponse(filepath, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'X-Content-Type-Options': 'nosniff',
    })
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
}
