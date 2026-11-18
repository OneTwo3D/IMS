import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { getBranding } from '@/lib/pdf'
import { loadSalesOrderForPdf, renderSalesOrderPdf } from '@/lib/sales-order-pdf'
import { getSalesOrderReference } from '@/lib/sales-order-display'

function safeFilenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  return safe.length > 0 ? safe : 'order'
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const so = await loadSalesOrderForPdf(id)
  if (!so) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // A quotation is the same renderer with a QUOTE heading (the quote download button points here too, so a quote is never labelled a sales order).
  const buffer = await renderSalesOrderPdf(so, await getBranding(), { variant: so.isQuote ? 'quote' : 'order' })
  const orderRef = getSalesOrderReference(so)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${so.isQuote ? 'Quote' : 'Order'}-${safeFilenamePart(orderRef)}.pdf"` },
  })
}
