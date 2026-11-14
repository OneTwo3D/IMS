/**
 * IS AN UNSTAMPED ORDER A SCHEME ORDER, ON IMMUTABLE EVIDENCE? Shared by the credit-note treatment (which refuses such an order's credit note as a settle-by-hand row) and the refund writer (which records `scheme_treated_at` on a refund created for one), so both classify it the same way.
 *   (b) IMS itself queued or posted an invoice for the order carrying the EU VAT treatment marker: a scheme order, whatever the rates map to now.
 *   (c) no such invoice (it came from the storefront plugin before cut-over): ONLY the rates' CURRENT mapping can say whether it was a scheme sale. ACCEPTED LIMIT: removing a rate's scheme mapping while refunds of such pre-cut-over orders are still possible misclassifies them as ordinary.
 */
import type { db } from '@/lib/db'

const SCHEME_CATEGORIES = new Set(['IOSS', 'VOEC'])

export async function unstampedOrderIsScheme(client: Pick<typeof db, 'accountingSyncLog' | 'salesOrder'>, orderId: string): Promise<boolean> {
  const treatedInvoice = await client.accountingSyncLog.findFirst({
    where: { type: { in: ['SALES_INVOICE', 'SALES_INVOICE_UPDATE'] }, referenceType: 'SalesOrder', referenceId: orderId, payload: { path: ['_euVatTreatment', 'applied'], equals: true } },
    select: { id: true },
  })
  if (treatedInvoice !== null) return true
  const order = await client.salesOrder.findUnique({ where: { id: orderId }, select: { lines: { select: { taxRate: { select: { reportingCategory: true, schemePostingTaxType: true } } } } } })
  return (order?.lines ?? []).some((line) => SCHEME_CATEGORIES.has((line.taxRate?.reportingCategory ?? '').trim().toUpperCase()) || (line.taxRate?.schemePostingTaxType ?? '').trim() !== '')
}
