/**
 * Push purchase invoices as bills (ACCPAY) to Xero.
 */

import { xeroPost } from './api'
import { findOrCreateContact } from './contacts'
import type { BillData, InvoiceLine } from '../types'

type XeroInvoiceResponse = {
  Invoices: Array<{
    InvoiceID: string
    InvoiceNumber: string
    Status: string
  }>
}

/**
 * Create a purchase bill (ACCPAY) in Xero.
 */
export async function pushPurchaseBill(
  data: BillData,
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  // Find or create the supplier contact
  const contactResult = await findOrCreateContact(data.contactName, undefined, true)
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Build line items
  const lineItems = data.lines.map((line: InvoiceLine) => {
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      AccountCode: line.accountCode,
    }
    if (line.itemCode) xeroLine.ItemCode = line.itemCode
    if (line.taxType) xeroLine.TaxType = line.taxType
    return xeroLine
  })

  const invoice: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { ContactID: contactResult.contactId },
    LineItems: lineItems,
    Status: 'AUTHORISED',
    CurrencyCode: data.currency,
    Date: data.date,
  }
  if (data.invoiceNumber) invoice.InvoiceNumber = data.invoiceNumber
  if (data.dueDate) invoice.DueDate = data.dueDate
  if (data.reference) invoice.Reference = data.reference

  const res = await xeroPost<XeroInvoiceResponse>('Invoices', invoice)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to create bill' }
  }

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID }
}
