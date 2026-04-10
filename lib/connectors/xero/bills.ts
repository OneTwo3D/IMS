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
  status: string = 'AUTHORISED',
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  // Find or create the supplier contact
  const contactResult = await findOrCreateContact(data.contactName, undefined, true)
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Xero mandates TaxType on every line; "NONE" is the no-tax fallback.
  const DEFAULT_TAX_TYPE = 'NONE'

  // Validate account codes up front — Xero rejects the whole bill otherwise.
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing an account code. Configure Account Mapping → Stock in Transit in the Xero integration settings.`,
      }
    }
  }

  // Build line items
  const lineItems = data.lines.map((line: InvoiceLine) => {
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      AccountCode: line.accountCode,
      TaxType: line.taxType || DEFAULT_TAX_TYPE,
    }
    if (line.itemCode) xeroLine.ItemCode = line.itemCode
    return xeroLine
  })

  // DueDate is mandatory for AUTHORISED bills — fall back to the bill date.
  const dueDate = data.dueDate || data.date

  const invoice: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { ContactID: contactResult.contactId },
    LineItems: lineItems,
    Status: status,
    CurrencyCode: data.currency,
    Date: data.date,
    DueDate: dueDate,
  }
  if (data.invoiceNumber) invoice.InvoiceNumber = data.invoiceNumber
  if (data.reference) invoice.Reference = data.reference

  const res = await xeroPost<XeroInvoiceResponse>('Invoices', invoice)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to create bill' }
  }

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID }
}
