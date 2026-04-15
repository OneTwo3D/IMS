/**
 * Push credit notes to Xero.
 */

import { xeroPost } from './api'
import { findOrCreateContact } from './contacts'
import type { CreditNoteData, InvoiceLine } from '../types'

type XeroCreditNoteResponse = {
  CreditNotes: Array<{
    CreditNoteID: string
    CreditNoteNumber: string
    Status: string
  }>
}

/**
 * Create a credit note (ACCREC) in Xero.
 */
export async function pushCreditNote(
  data: CreditNoteData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; creditNoteId?: string; error?: string }> {
  // Find or create the contact
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail)
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }

  // Xero mandates TaxType on every line; "NONE" is the no-tax fallback.
  const DEFAULT_TAX_TYPE = 'NONE'

  // Validate account codes up front.
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing a sales account code. Configure Account Mapping → Sales Revenue in the Xero integration settings.`,
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

  const creditNote: Record<string, unknown> = {
    Type: 'ACCREC',
    Contact: { ContactID: contactResult.contactId },
    CreditNoteNumber: data.creditNoteNumber,
    Date: data.date,
    LineItems: lineItems,
    Status: status,
    CurrencyCode: data.currency,
  }
  if (data.reference) creditNote.Reference = data.reference

  const res = await xeroPost<XeroCreditNoteResponse>('CreditNotes', creditNote, opts)
  if (!res.ok || !res.data?.CreditNotes?.length) {
    return { success: false, error: res.error ?? 'Failed to create credit note' }
  }

  return { success: true, creditNoteId: res.data.CreditNotes[0].CreditNoteID }
}
