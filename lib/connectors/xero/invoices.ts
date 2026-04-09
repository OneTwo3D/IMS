/**
 * Push sales invoices (ACCREC) to Xero.
 */

import { xeroPost } from './api'
import { findOrCreateContact } from './contacts'
import type { InvoiceData, InvoiceLine } from '../types'

type XeroInvoiceResponse = {
  Invoices: Array<{
    InvoiceID: string
    InvoiceNumber: string
    Status: string
  }>
}

/**
 * Create a sales invoice (ACCREC) in Xero.
 */
export async function pushSalesInvoice(
  data: InvoiceData,
  status: string = 'AUTHORISED',
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  // Find or create the contact
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail)
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
    if (line.discountRate && line.discountRate > 0) xeroLine.DiscountRate = line.discountRate
    return xeroLine
  })

  // Add shipping as separate line item
  if (data.shippingAmount && data.shippingAmount > 0 && data.shippingAccountCode) {
    lineItems.push({
      Description: data.shippingDescription ?? 'Shipping',
      Quantity: 1,
      UnitAmount: data.shippingAmount,
      AccountCode: data.shippingAccountCode,
    })
  }

  // Add order-level discount as negative line item
  if (data.discountAmount && data.discountAmount > 0 && data.discountAccountCode) {
    lineItems.push({
      Description: 'Order discount',
      Quantity: 1,
      UnitAmount: -data.discountAmount,
      AccountCode: data.discountAccountCode,
    })
  }

  const invoice: Record<string, unknown> = {
    Type: 'ACCREC',
    Contact: { ContactID: contactResult.contactId },
    InvoiceNumber: data.invoiceNumber,
    Date: data.date,
    LineItems: lineItems,
    Status: status,
    CurrencyCode: data.currency,
  }
  if (data.dueDate) invoice.DueDate = data.dueDate
  if (data.reference) invoice.Reference = data.reference

  const res = await xeroPost<XeroInvoiceResponse>('Invoices', invoice)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to create invoice' }
  }

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID }
}
