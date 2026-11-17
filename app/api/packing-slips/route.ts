import { NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { createPdfDocument, pdfToBuffer } from '@/lib/pdf'
import { normaliseBulkOrderIds } from '@/lib/domain/sales/bulk-actions'
import { orderPackingSlipAvailable } from '@/lib/domain/sales/packing-slip-scope'
import {
  drawPackingSlip,
  loadPackingSlipContext,
  loadPackingSlipOrder,
} from '@/lib/sales/packing-slip-document'
import { db } from '@/lib/db'

/**
 * One combined packing-slip PDF for the orders selected on the sales-order list: `?ids=a,b,c`.
 * Each order starts on a new page and is drawn by the same renderer as the single-order slip.
 * Only the named orders are read. An order that is a draft or cancelled gets no slip (the order
 * page offers none either); they are listed on a closing "Not printed" page so nothing vanishes.
 */
export async function GET(req: Request) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const raw = new URL(req.url).searchParams.get('ids') ?? ''
  const parsed = normaliseBulkOrderIds(raw.split(',').map((v) => v.trim()).filter(Boolean))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  // Statuses first, in one query, so skipped orders cost no rendering.
  const found = await db.salesOrder.findMany({
    where: { id: { in: parsed.ids } },
    select: { id: true, status: true, orderNumber: true, externalOrderNumber: true },
  })
  const byId = new Map(found.map((o) => [o.id, o]))
  const notPrinted: string[] = []
  const printable: string[] = []
  for (const id of parsed.ids) {
    const o = byId.get(id)
    if (!o) notPrinted.push(`${id.slice(0, 8)}: order not found`)
    else if (!orderPackingSlipAvailable(o.status)) {
      notPrinted.push(`${o.orderNumber ?? o.externalOrderNumber ?? id.slice(0, 8)}: ${o.status === 'DRAFT' ? 'still a draft' : 'cancelled'}`)
    } else printable.push(id)
  }
  if (printable.length === 0) {
    return NextResponse.json({ error: `None of the selected orders can have a packing slip printed (${notPrinted.join('; ')}).` }, { status: 409 })
  }

  const ctx = await loadPackingSlipContext()
  const { doc } = createPdfDocument({ title: `Packing slips (${printable.length} orders)` })
  let first = true
  for (const id of printable) {
    const loaded = await loadPackingSlipOrder(id, null)
    if (!loaded.ok) {
      notPrinted.push(`${id.slice(0, 8)}: ${loaded.error}`)
      continue
    }
    if (!first) doc.addPage()
    first = false
    await drawPackingSlip(doc, loaded.data, ctx)
  }
  if (notPrinted.length > 0) {
    if (!first) doc.addPage()
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#333').text('Not printed', 50, 50)
    doc.font('Helvetica').fontSize(10)
    for (const line of notPrinted) doc.text(`- ${line}`)
  }

  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="Packing-Slips.pdf"',
    },
  })
}
