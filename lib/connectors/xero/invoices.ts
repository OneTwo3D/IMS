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
    Total?: number
    AmountDue?: number
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
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; total?: number; error?: string }> {
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

  // Xero requires a TaxType on every line item. "NONE" is the no-tax fallback
  // for customers/products that carry no VAT, so we default to it whenever the
  // caller hasn't supplied a specific tax type.
  const DEFAULT_TAX_TYPE = 'NONE'

  // Validate that every product line has an account code — Xero rejects the
  // whole invoice with "Account code or ID must be specified" if any line is
  // missing one. Bail out early with a clear error instead of making a bad
  // API call.
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing a sales account code. Configure Account Mapping → Sales Revenue in the Xero integration settings.`,
      }
    }
  }

  // Build line items. Xero supports `DiscountRate` (a percentage, 0-100) on
  // sales invoices (ACCREC) — translate the generic per-line `discountAmount`
  // from the caller into that Xero-specific field here so that only this
  // connector knows about the target system's discount representation.
  const lineItems = data.lines.map((line: InvoiceLine) => {
    const xeroLine: Record<string, unknown> = {
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      AccountCode: line.accountCode,
      TaxType: line.taxType || DEFAULT_TAX_TYPE,
    }
    if (line.itemCode && !droppedItemCodes.has(line.itemCode)) xeroLine.ItemCode = line.itemCode
    if (line.discountAmount && line.discountAmount > 0) {
      const lineGross = line.unitAmount * line.quantity
      if (lineGross > 0) {
        // DiscountRate is a percentage with 2dp precision (Xero rounds).
        const rate = Math.round((line.discountAmount / lineGross) * 10000) / 100
        if (rate > 0) xeroLine.DiscountRate = rate
      }
    }
    return xeroLine
  })

  // Add shipping as separate line item. When the caller supplies a
  // shippingTaxType (e.g. the order has a VAT rate), use it so shipping is
  // taxed at the same rate as the products. Otherwise fall back to NONE.
  if (data.shippingAmount && data.shippingAmount > 0 && data.shippingAccountCode) {
    lineItems.push({
      Description: data.shippingDescription ?? 'Shipping',
      Quantity: 1,
      UnitAmount: data.shippingAmount,
      AccountCode: data.shippingAccountCode,
      TaxType: data.shippingTaxType || DEFAULT_TAX_TYPE,
    })
  }

  // Add order-level discount as negative line item. Use the caller-supplied
  // tax type (matching the order's VAT rate) so the discount reduces the
  // taxable base correctly. Falls back to NONE if omitted.
  if (data.discountAmount && data.discountAmount > 0 && data.discountAccountCode) {
    lineItems.push({
      Description: 'Order discount',
      Quantity: 1,
      UnitAmount: -data.discountAmount,
      AccountCode: data.discountAccountCode,
      TaxType: data.discountTaxType || DEFAULT_TAX_TYPE,
    })
  }

  // DueDate is mandatory for AUTHORISED invoices in Xero. Fall back to the
  // invoice date (same-day payment) if the caller didn't supply one.
  const dueDate = data.dueDate || data.date

  const invoice: Record<string, unknown> = {
    Type: 'ACCREC',
    Contact: { ContactID: contactResult.contactId },
    InvoiceNumber: data.invoiceNumber,
    Date: data.date,
    DueDate: dueDate,
    LineItems: lineItems,
    // Tell Xero whether the per-line UnitAmount values are tax-inclusive so
    // it computes the net/tax correctly. IMS stores gross prices when the
    // user toggles "prices include VAT" on the order.
    LineAmountTypes: data.lineAmountsIncludeTax ? 'Inclusive' : 'Exclusive',
    Status: status,
    CurrencyCode: data.currency,
  }
  if (data.reference) invoice.Reference = data.reference

  const res = await xeroPost<XeroInvoiceResponse>('Invoices', invoice, opts)
  if (!res.ok || !res.data?.Invoices?.length) {
    return { success: false, error: res.error ?? 'Failed to create invoice' }
  }

  const inv = res.data.Invoices[0]
  return { success: true, invoiceId: inv.InvoiceID, invoiceNumber: inv.InvoiceNumber, total: inv.Total }
}
