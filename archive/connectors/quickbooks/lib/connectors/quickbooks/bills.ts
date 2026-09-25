/**
 * QuickBooks Online purchase bill creation.
 *
 * QBO Bill entity corresponds to Xero's ACCPAY invoice.
 * Uses AccountBasedExpenseLineDetail for line items.
 * Discounts are applied by reducing the Amount (same approach as Xero bills,
 * since QBO Bill doesn't support DiscountLineDetail).
 */

import type { BillData } from '@/lib/connectors/types'
import { qboPost, qboPostIdempotent, resolveAccountRef } from './api'
import { findOrCreateContact } from './contacts'
import { imsRateToQboExchangeRate } from './fx'

type QboBill = {
  Id: string
  DocNumber?: string
  TotalAmt: number
  Balance: number
}

/**
 * Create a purchase bill in QuickBooks.
 */
export async function pushPurchaseBill(
  data: BillData,
  _status?: string,
  opts?: { supplierId?: string; requestId?: string },
): Promise<{ success: boolean; invoiceId?: string; error?: string }> {
  try {
    // Find or create vendor
    const contactResult = await findOrCreateContact(
      data.contactName,
      undefined,
      true,
      opts?.supplierId ? { supplierId: opts.supplierId } : undefined,
    )
    if (!contactResult.success || !contactResult.contactId) {
      return { success: false, error: contactResult.error ?? 'Failed to resolve vendor' }
    }

    // Build bill lines
    const lines: Array<Record<string, unknown>> = []

    for (const line of data.lines) {
      const accountRef = await resolveAccountRef(line.accountCode)
      if (!accountRef) {
        return { success: false, error: `Account code not found in QuickBooks: ${line.accountCode}` }
      }

      // Apply discount by reducing amount (same as Xero bills approach)
      const lineAmount = line.quantity * line.unitAmount
      const effectiveAmount = Math.max(0, Math.round((lineAmount - (line.discountAmount ?? 0)) * 100) / 100)

      lines.push({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: effectiveAmount,
        Description: line.description,
        AccountBasedExpenseLineDetail: {
          AccountRef: accountRef,
          TaxCodeRef: line.taxType ? { value: line.taxType } : undefined,
        },
      })
    }

    const billBody: Record<string, unknown> = {
      VendorRef: { value: contactResult.contactId },
      TxnDate: data.date,
      DueDate: data.dueDate || data.date,
      Line: lines,
    }

    if (data.invoiceNumber) billBody.DocNumber = data.invoiceNumber
    if (data.currency) billBody.CurrencyRef = { value: data.currency }
    const qboRate = imsRateToQboExchangeRate(data.currencyRateToBase)
    if (qboRate != null) billBody.ExchangeRate = qboRate
    if (data.reference) billBody.PrivateNote = data.reference

    const res = opts?.requestId
      ? await qboPostIdempotent<{ Bill: QboBill }>('bill', billBody, opts.requestId)
      : await qboPost<{ Bill: QboBill }>('bill', billBody)
    if (!res.ok || !res.data) {
      return { success: false, error: res.error ?? 'Failed to create bill' }
    }

    return { success: true, invoiceId: res.data.Bill.Id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
