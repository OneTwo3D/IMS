/**
 * Push sales invoices (ACCREC) to Xero.
 */

import { xeroPost } from './api'
import { findOrCreateContact } from './contacts'
import { findOrCreateItem } from './items'
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
 *
 * Before posting, any line with an `itemCode` is pre-checked against Xero's
 * Items endpoint — missing items are auto-created so that invoices for new
 * products don't fail with "item not found". If item creation fails (e.g.
 * Xero name collision on a different code) the line still posts, just
 * without ItemCode, so the invoice itself is not blocked.
 */
export async function pushSalesInvoice(
  data: InvoiceData,
  status: string = 'AUTHORISED',
): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; error?: string }> {
  // Find or create the contact
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail)
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Pre-create any items that don't exist in Xero yet. Deduplicate by code to
  // avoid redundant API calls when the same SKU appears on multiple lines.
  const itemCodes = new Set<string>()
  const droppedItemCodes = new Set<string>()
  for (const line of data.lines) {
    if (!line.itemCode || itemCodes.has(line.itemCode)) continue
    itemCodes.add(line.itemCode)
    const itemName = line.itemName ?? line.description ?? line.itemCode
    const result = await findOrCreateItem(line.itemCode, itemName, line.accountCode)
    if (!result.success) {
      // Non-fatal: drop the ItemCode from this line and fall back to a plain
      // description-only line so the invoice still goes through.
      droppedItemCodes.add(line.itemCode)
    }
  }

  // Build line items
  const lineItems = data.lines.map((line: InvoiceLine) => {
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      AccountCode: line.accountCode,
    }
    if (line.itemCode && !droppedItemCodes.has(line.itemCode)) xeroLine.ItemCode = line.itemCode
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

  return { success: true, invoiceId: res.data.Invoices[0].InvoiceID, invoiceNumber: res.data.Invoices[0].InvoiceNumber }
}
