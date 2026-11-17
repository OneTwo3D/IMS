import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { createPdfDocument, pdfToBuffer } from '@/lib/pdf'
import {
  drawPackingSlip,
  loadPackingSlipContext,
  loadPackingSlipOrder,
  packingSlipOrderNumber,
} from '@/lib/sales/packing-slip-document'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const loaded = await loadPackingSlipOrder(id, new URL(req.url).searchParams.get('shipment'))
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status })

  const ctx = await loadPackingSlipContext()
  const orderNum = packingSlipOrderNumber(loaded.data.so)
  const { doc } = createPdfDocument({ title: `Packing Slip ${orderNum}` })
  await drawPackingSlip(doc, loaded.data, ctx)

  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Packing-Slip-${orderNum}.pdf"`,
    },
  })
}
