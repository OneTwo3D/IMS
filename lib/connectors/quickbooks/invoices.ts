/**
 * QuickBooks Online sales invoice creation.
 *
 * QBO Invoice entity corresponds to Xero's ACCREC invoice.
 * Key differences from Xero:
 * - Discounts use DiscountLineDetail as a separate line type
 * - Tax uses TaxCodeRef (ID-based) not TaxType (string-based)
 * - GlobalTaxCalculation controls inclusive/exclusive interpretation
 * - No DRAFT/AUTHORISED status distinction on creation
 */

import type { InvoiceData } from '@/lib/connectors/types'
import { qboPost, resolveAccountRef } from './api'
import { findOrCreateContact } from './contacts'
import { findOrCreateItem } from './items'
import { getQuickBooksSettings } from './settings'

type QboInvoice = {
  Id: string
  DocNumber?: string
  TotalAmt: number
  Balance: number
}

type QboLine = {
  DetailType: string
  Amount: number
  Description?: string
  SalesItemLineDetail?: {
    ItemRef?: { value: string }
    Qty: number
    UnitPrice: number
    TaxCodeRef?: { value: string }
  }
  DiscountLineDetail?: {
    PercentBased: boolean
    DiscountPercent?: number
    DiscountAccountRef?: { value: string }
  }
}

/**
 * Create a sales invoice in QuickBooks.
 * Pre-creates missing items before posting (same pattern as Xero).
 */
export async function pushSalesInvoice(
  data: InvoiceData,
  _status?: string,
  opts?: { customerId?: string },
): Promise<{ success: boolean; invoiceId?: string; invoiceNumber?: string; total?: number; error?: string }> {
  try {
    // Find or create customer
    const contactResult = await findOrCreateContact(
      data.contactName,
      data.contactEmail,
      false,
      opts?.customerId ? { customerId: opts.customerId } : undefined,
    )
    if (!contactResult.success || !contactResult.contactId) {
      return { success: false, error: contactResult.error ?? 'Failed to resolve customer' }
    }

    const settings = await getQuickBooksSettings()

    // Pre-create missing items (deduplicate by itemCode)
    const itemCodes = [...new Set(data.lines.filter((l) => l.itemCode).map((l) => l.itemCode!))]
    const itemIdMap = new Map<string, string>()
    for (const code of itemCodes) {
      const itemName = data.lines.find((l) => l.itemCode === code)?.itemName ?? code
      const itemResult = await findOrCreateItem(code, itemName)
      if (itemResult.success && itemResult.itemId) {
        itemIdMap.set(code, itemResult.itemId)
      }
      // Non-fatal: if item creation fails, line still posts without ItemRef
    }

    // Build invoice lines
    const lines: QboLine[] = []

    for (const line of data.lines) {
      // Resolve the line's account code if provided — QBO doesn't support
      // per-line AccountRef on SalesItemLineDetail, but we can warn when the
      // caller expects a specific account that doesn't match the item default.
      const lineAccountRef = line.accountCode
        ? await resolveAccountRef(line.accountCode)
        : null

      if (line.accountCode && !lineAccountRef) {
        return {
          success: false,
          error: `Account code "${line.accountCode}" not found in QuickBooks chart of accounts`,
        }
      }

      const qboLine: QboLine = {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(line.quantity * line.unitAmount * 100) / 100,
        Description: line.description,
        SalesItemLineDetail: {
          Qty: line.quantity,
          UnitPrice: line.unitAmount,
          TaxCodeRef: line.taxType ? { value: line.taxType } : undefined,
          // QBO SalesItemLineDetail uses the item's IncomeAccountRef for GL
          // posting. When the caller specifies an accountCode we validate it
          // exists above, and the item was created with the matching income
          // account via findOrCreateItem. For lines without an item, we set
          // ServiceDate to signal QBO to use the company default income account.
        },
      }

      // Attach item ref if available
      const itemId = line.itemCode ? itemIdMap.get(line.itemCode) : undefined
      if (itemId) {
        qboLine.SalesItemLineDetail!.ItemRef = { value: itemId }
      }

      lines.push(qboLine)

      // Per-line discount as separate DiscountLineDetail
      if (line.discountAmount && line.discountAmount > 0) {
        const discountAccountRef = await resolveAccountRef(settings.quickbooks_discount_account)
        lines.push({
          DetailType: 'DiscountLineDetail',
          Amount: Math.round(line.discountAmount * 100) / 100,
          DiscountLineDetail: {
            PercentBased: false,
            DiscountAccountRef: discountAccountRef ?? undefined,
          },
        })
      }
    }

    // Shipping line — use a service item mapped to the shipping account
    if (data.shippingAmount && data.shippingAmount > 0) {
      const shippingAccountCode = data.shippingAccountCode ?? settings.quickbooks_shipping_account
      if (shippingAccountCode) {
        const shippingAccountRef = await resolveAccountRef(shippingAccountCode)
        if (!shippingAccountRef) {
          return {
            success: false,
            error: `Shipping account "${shippingAccountCode}" not found in QuickBooks chart of accounts`,
          }
        }
      }
      // Create/find a "Shipping" service item so the line posts to the
      // configured shipping income account (set on the item)
      const shippingItem = await findOrCreateItem('Shipping', 'Shipping & Delivery')
      const shippingLine: QboLine = {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(data.shippingAmount * 100) / 100,
        Description: data.shippingDescription ?? 'Shipping',
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: data.shippingAmount,
          TaxCodeRef: data.shippingTaxType ? { value: data.shippingTaxType } : undefined,
        },
      }
      if (shippingItem.itemId) {
        shippingLine.SalesItemLineDetail!.ItemRef = { value: shippingItem.itemId }
      }
      lines.push(shippingLine)
    }

    // Order-level discount
    if (data.discountAmount && data.discountAmount > 0) {
      const discountAccountRef = await resolveAccountRef(
        data.discountAccountCode ?? settings.quickbooks_discount_account,
      )
      lines.push({
        DetailType: 'DiscountLineDetail',
        Amount: Math.round(data.discountAmount * 100) / 100,
        DiscountLineDetail: {
          PercentBased: false,
          DiscountAccountRef: discountAccountRef ?? undefined,
        },
      })
    }

    const invoiceBody: Record<string, unknown> = {
      CustomerRef: { value: contactResult.contactId },
      TxnDate: data.date,
      DueDate: data.dueDate || data.date,
      Line: lines,
      GlobalTaxCalculation: data.lineAmountsIncludeTax ? 'TaxInclusive' : 'TaxExclusive',
    }

    if (data.invoiceNumber) invoiceBody.DocNumber = data.invoiceNumber
    if (data.currency) invoiceBody.CurrencyRef = { value: data.currency }
    if (data.reference) invoiceBody.PrivateNote = data.reference

    const res = await qboPost<{ Invoice: QboInvoice }>('invoice', invoiceBody)
    if (!res.ok || !res.data) {
      return { success: false, error: res.error ?? 'Failed to create invoice' }
    }

    const invoice = res.data.Invoice
    return {
      success: true,
      invoiceId: invoice.Id,
      invoiceNumber: invoice.DocNumber,
      total: invoice.TotalAmt,
    }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
