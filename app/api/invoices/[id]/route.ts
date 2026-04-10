/**
 * Public signed-URL PDF download endpoint for Xero invoices.
 * GET /api/invoices/[id]?token=<hmac>
 */

import { NextRequest, NextResponse } from 'next/server'
import { loadInvoicePdf, verifyPdfToken } from '@/lib/invoice-pdf'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const token = request.nextUrl.searchParams.get('token')

  if (!token || !verifyPdfToken(id, token)) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 403 })
  }

  const pdf = await loadInvoicePdf(id)
  if (!pdf) {
    return NextResponse.json({ error: 'Invoice PDF not found' }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="invoice-${id}.pdf"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
