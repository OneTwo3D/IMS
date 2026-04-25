/**
 * QuickBooks Online credit memo creation.
 *
 * QBO CreditMemo entity corresponds to Xero's ACCREC credit note.
 */

import type { CreditNoteData } from '@/lib/connectors/types'
import { qboPost, qboPostIdempotent } from './api'
import { findOrCreateContact } from './contacts'
import { imsRateToQboExchangeRate } from './fx'

type QboCreditMemo = {
  Id: string
  DocNumber?: string
  TotalAmt: number
}

/**
 * Create a credit memo in QuickBooks.
 */
export async function pushCreditMemo(
  data: CreditNoteData,
  _status?: string,
  opts?: { customerId?: string; requestId?: string },
): Promise<{ success: boolean; creditNoteId?: string; error?: string }> {
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

    // Build credit memo lines
    const lines = data.lines.map((line) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: Math.round(line.quantity * line.unitAmount * 100) / 100,
      Description: line.description,
      SalesItemLineDetail: {
        Qty: line.quantity,
        UnitPrice: line.unitAmount,
        TaxCodeRef: line.taxType ? { value: line.taxType } : undefined,
      },
    }))

    const body: Record<string, unknown> = {
      CustomerRef: { value: contactResult.contactId },
      TxnDate: data.date,
      Line: lines,
      GlobalTaxCalculation: data.lineAmountsIncludeTax ? 'TaxInclusive' : 'TaxExclusive',
    }

    if (data.creditNoteNumber) body.DocNumber = data.creditNoteNumber
    if (data.currency) body.CurrencyRef = { value: data.currency }
    const qboRate = imsRateToQboExchangeRate(data.currencyRateToBase)
    if (qboRate != null) body.ExchangeRate = qboRate
    if (data.reference) body.PrivateNote = data.reference

    const res = opts?.requestId
      ? await qboPostIdempotent<{ CreditMemo: QboCreditMemo }>('creditmemo', body, opts.requestId)
      : await qboPost<{ CreditMemo: QboCreditMemo }>('creditmemo', body)
    if (!res.ok || !res.data) {
      return { success: false, error: res.error ?? 'Failed to create credit memo' }
    }

    return { success: true, creditNoteId: res.data.CreditMemo.Id }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}
