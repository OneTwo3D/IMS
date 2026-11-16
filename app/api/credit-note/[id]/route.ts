import { NextResponse } from 'next/server'
import { Prisma } from '@/app/generated/prisma/client'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { db } from '@/lib/db'
import { formatCountryDisplay } from '@/lib/countries'
import { getBranding, createPdfDocument, drawHeader, drawTable, drawFooter, drawTemplateNotes, pdfToBuffer, type PdfTableColumn } from '@/lib/pdf'
import { drawTotalsRows } from '@/lib/pdf-order-money'
import { creditNoteLineFacts } from '@/lib/domain/sales/credit-note-display'
import { draftCreditNoteModel, postedCreditNoteModel } from '@/lib/domain/sales/credit-note-document'
import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { refusedCreditNoteError } from '@/lib/domain/accounting/eu-vat-credit-note'
import { getSalesOrderReference } from '@/lib/sales-order-display'
import { getAccountingSettings } from '@/lib/accounting'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { formatMoney } from '@/lib/utils'
import { getDisplayTimeZone } from '@/lib/display-timezone'
import { formatDateTime } from '@/lib/format-datetime'

function safeFilenamePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  return safe.length > 0 ? safe : 'credit-note'
}

/**
 * GET /api/credit-note/[id] — the IMS-rendered credit note for one recorded refund (id = SalesOrderRefund.id).
 * A refund whose credit note was staged is printed from the staged payload (what was posted or queued); one never staged is recalculated
 * and titled "Draft Credit Note". It exists with or without an accounting connector. It carries the original invoice (or order) number it credits.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session
  if (!hasPermission(session.user.role, 'sales')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const refund = await db.salesOrderRefund.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { id: 'asc' } },
      order: {
        include: {
          lines: {
            select: {
              id: true, qty: true, unitPriceForeign: true, discountAmount: true, totalForeign: true, taxForeign: true,
              taxRate: { select: { id: true, rate: true, accountingTaxType: true } },
            },
          },
        },
      },
    },
  })
  if (!refund) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const so = refund.order

  const [baseCurrencyCode, accountingSettings, salesTaxRates, orderDefaultRate, branding, tpl, tz, currencyRow] = await Promise.all([
    getBaseCurrencyCode(),
    getAccountingSettings().catch(() => null),
    db.taxRate.findMany({ where: { usedFor: { not: 'PURCHASE' } }, select: { accountingTaxType: true, rate: true } }),
    so.taxRateName ? db.taxRate.findFirst({ where: { name: so.taxRateName, active: true }, select: { accountingTaxType: true } }) : Promise.resolve(null),
    getBranding(),
    db.documentTemplate.findUnique({
      where: { type: 'credit_note' },
      select: { headerNote: true, footerNote: true, termsText: true, customFooter: true, showPaymentTerms: true, paymentTermsText: true },
    }),
    getDisplayTimeZone(),
    db.currency.findUnique({ where: { code: so.currency } }),
  ])

  // A refund whose credit note was staged for the ledger is printed from THAT payload (what was posted or queued), never repriced; the payload
  // is held on the refund's CREDIT_NOTE sync row. A refund never staged (or whose row was refused, or whose payload retention has removed) is
  // recalculated and labelled Draft.
  const syncRow = await db.accountingSyncLog.findFirst({
    where: { type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: refund.id, status: { not: 'CANCELLED' }, payload: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  })
  const payload = syncRow?.payload && typeof syncRow.payload === 'object' && !Array.isArray(syncRow.payload) ? (syncRow.payload as Record<string, unknown>) : null
  const payloadLines = payload && Array.isArray(payload.lines) ? (payload.lines as Array<{ description?: unknown; quantity?: unknown; unitAmount?: unknown; noTaxKind?: unknown }>) : []
  const posted = payload !== null && payloadLines.length > 0 && refusedCreditNoteError(payload) === null

  const orderRate = so.taxRatePercent != null ? Number(so.taxRatePercent) : null
  const orderLineOf = (id: string | null) => (id ? so.lines.find((l) => l.id === id) : undefined)
  let model
  if (posted) {
    // Frozen rates only: the refund line's own snapshot, the VAT the source stated, else the order line's stored VAT over its stored net.
    const unused = [...refund.lines]
    const rateOf = (index: number): number => {
      const desc = payloadLines[index]?.description
      const at = unused.findIndex((l) => l.description === desc)
      if (at < 0) return Number(orderRate ?? 0)
      const [rl] = unused.splice(at, 1)
      if (rl.schemeTaxRateValue != null) return Number(rl.schemeTaxRateValue)
      const net = Number(rl.totalForeign)
      if (rl.chargedTaxForeign != null && net > 0) return Number(rl.chargedTaxForeign) / net
      const ol = orderLineOf(rl.salesOrderLineId)
      if (ol && Number(ol.totalForeign) > 0) return Number(ol.taxForeign ?? 0) / Number(ol.totalForeign)
      return Number(orderRate ?? 0)
    }
    model = postedCreditNoteModel({
      payloadLines,
      lineAmountsIncludeTax: payload?.lineAmountsIncludeTax === true,
      vatIsOwnLine: payload?.[EU_VAT_TREATMENT_PAYLOAD_KEY] != null,
      rateOf,
    })
  } else {
    const facts = creditNoteLineFacts({
      orderCurrency: so.currency,
      baseCurrency: baseCurrencyCode,
      orderLines: so.lines,
      reverseChargeSalesTaxType: accountingSettings?.reverseChargeSalesTaxType,
      orderDefaultTaxType: orderDefaultRate?.accountingTaxType ?? null,
      taxRates: salesTaxRates,
      refundLines: refund.lines,
    })
    model = draftCreditNoteModel({
      orderTaxRatePercent: orderRate,
      orderLines: so.lines.map((l) => ({
        id: l.id, qty: Number(l.qty), unitPriceForeign: Number(l.unitPriceForeign), discountAmount: Number(l.discountAmount ?? 0),
        totalForeign: Number(l.totalForeign), taxForeign: Number(l.taxForeign ?? 0),
        taxRatePercent: l.taxRate?.rate != null ? Number(l.taxRate.rate) : null,
      })),
      refundLines: refund.lines.map((l, i) => ({ ...facts[i], description: l.description, qty: Number(l.qty) })),
    })
  }

  const sym = currencyRow?.symbol ?? (so.currency === 'GBP' ? '£' : so.currency)
  const money = (n: number) => formatMoney(n, sym, currencyRow?.symbolPosition ?? 'PREFIX')
  const reference = refund.creditNoteNumber ?? (typeof payload?.creditNoteNumber === 'string' ? payload.creditNoteNumber : null) ?? 'Not yet numbered'
  const against = so.invoiceNumber ?? getSalesOrderReference(so)
  const billAddr = so.billingAddress as Record<string, string> | null
  const recipientAddr = billAddr ? [billAddr.line1, billAddr.line2, billAddr.city, billAddr.postcode, formatCountryDisplay(billAddr.country)].filter(Boolean).join('\n') : ''

  const { doc } = createPdfDocument({ title: `${posted ? 'Credit Note' : 'Draft Credit Note'} ${reference}` })
  await drawHeader(doc, branding, {
    title: posted ? 'Credit Note' : 'Draft Credit Note',
    reference,
    secondaryReference: { label: so.invoiceNumber ? 'Credits invoice' : 'Credits order', value: against },
    date: formatDateTime(refund.refundedAt, { day: 'numeric', month: 'long', year: 'numeric' }, tz),
    recipient: { name: so.customerName ?? 'Customer', address: recipientAddr, email: so.customerEmail },
  })
  drawTemplateNotes(doc, tpl, 'header')
  if (refund.reason) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Reason: ${refund.reason}`, 50, doc.y)
    doc.y += 8
  }

  const columns: PdfTableColumn[] = [
    { label: '#', width: 25, align: 'right' },
    { label: 'Description', width: 240, wrap: true },
    { label: 'Qty', width: 40, align: 'right' },
    { label: `Net (${sym})`, width: 65, align: 'right' },
    { label: `VAT (${sym})`, width: 60, align: 'right' },
    { label: `Credit (${sym})`, width: 65, align: 'right' },
  ]
  const tableRows = model.rows.map((r, i) => [String(i + 1), r.description, String(r.qty), r.net.toFixed(2), r.vat.toFixed(2), r.gross.toFixed(2)])
  if (model.rounding) tableRows.push(['', 'Rounding', '', model.rounding.net.toFixed(2), model.rounding.vat.toFixed(2), model.rounding.gross.toFixed(2)])
  drawTable(doc, columns, tableRows, branding)
  if (doc.y + 90 > 780) doc.addPage()
  drawTotalsRows(doc, [
    { label: 'Net', amount: model.total.net },
    { label: 'VAT', amount: model.total.vat },
    { label: 'Total credit', amount: model.total.gross, strong: true },
  ], money, columns)

  drawTemplateNotes(doc, tpl, 'footer')
  drawFooter(doc, 'This credit note has been applied to your account.', branding, { customFooter: tpl?.customFooter, contactEmail: branding.salesEmail })
  const buffer = await pdfToBuffer(doc)
  return new NextResponse(new Uint8Array(buffer), {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="CreditNote-${safeFilenamePart(reference)}.pdf"` },
  })
}
