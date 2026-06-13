/**
 * Push credit notes to Xero.
 */

import { xeroPost } from './api'
import { findOrCreateContact } from './contacts'
import { imsRateToXeroCurrencyRate } from './fx'
import type { CreditNoteData, InvoiceLine } from '../types'

type XeroCreditNoteResponse = {
  CreditNotes: Array<{
    CreditNoteID: string
    CreditNoteNumber: string
    Status: string
  }>
}

export const XERO_SALES_CREDIT_NOTE_TYPE = 'ACCRECCREDIT'

/**
 * Create a sales credit note (ACCRECCREDIT) in Xero.
 */
export async function pushCreditNote(
  data: CreditNoteData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string; customerId?: string },
): Promise<{ success: boolean; creditNoteId?: string; error?: string }> {
  // Find or create the contact
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail, false, { customerId: opts?.customerId })
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
    Type: XERO_SALES_CREDIT_NOTE_TYPE,
    Contact: { ContactID: contactResult.contactId },
    CreditNoteNumber: data.creditNoteNumber,
    Date: data.date,
    LineItems: lineItems,
    LineAmountTypes: data.lineAmountsIncludeTax ? 'Inclusive' : 'Exclusive',
    Status: status,
    CurrencyCode: data.currency,
  }
  // Stamp the IMS rate so Xero doesn't apply its own daily XE rate.
  const xeroCurrencyRate = imsRateToXeroCurrencyRate(data.currencyRateToBase)
  if (xeroCurrencyRate != null) creditNote.CurrencyRate = xeroCurrencyRate
  if (data.reference) creditNote.Reference = data.reference

  const res = await xeroPost<XeroCreditNoteResponse>('CreditNotes', creditNote, opts)
  if (!res.ok || !res.data?.CreditNotes?.length) {
    return { success: false, error: res.error ?? 'Failed to create credit note' }
  }

  return { success: true, creditNoteId: res.data.CreditNotes[0].CreditNoteID }
}

export const XERO_PURCHASE_CREDIT_NOTE_TYPE = 'ACCPAYCREDIT'

/**
 * audit-g5u2: pure builder for the Xero ACCPAYCREDIT (supplier/purchase credit
 * note) request body. Extracted so the payload shape is unit-tested without the
 * network. Mirrors the ACCRECCREDIT builder but flips Type to ACCPAYCREDIT.
 */
export function buildXeroPurchaseCreditNote(
  data: CreditNoteData,
  status: string,
  contactId: string,
): Record<string, unknown> {
  const DEFAULT_TAX_TYPE = 'NONE'
  const creditNote: Record<string, unknown> = {
    Type: XERO_PURCHASE_CREDIT_NOTE_TYPE,
    Contact: { ContactID: contactId },
    CreditNoteNumber: data.creditNoteNumber,
    Date: data.date,
    LineItems: data.lines.map((line: InvoiceLine) => {
      const xeroLine: Record<string, unknown> = {
        Description: line.description,
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
        AccountCode: line.accountCode,
        TaxType: line.taxType || DEFAULT_TAX_TYPE,
      }
      if (line.itemCode) xeroLine.ItemCode = line.itemCode
      return xeroLine
    }),
    LineAmountTypes: data.lineAmountsIncludeTax ? 'Inclusive' : 'Exclusive',
    Status: status,
    CurrencyCode: data.currency,
  }
  const xeroCurrencyRate = imsRateToXeroCurrencyRate(data.currencyRateToBase)
  if (xeroCurrencyRate != null) creditNote.CurrencyRate = xeroCurrencyRate
  if (data.reference) creditNote.Reference = data.reference
  return creditNote
}

/**
 * audit-g5u2: create a SUPPLIER (purchase) credit note (ACCPAYCREDIT) in Xero —
 * e.g. crediting a duplicate freight bill. Resolves the SUPPLIER contact (vs the
 * customer contact the sales credit note uses).
 */
export async function pushPurchaseCreditNote(
  data: CreditNoteData,
  status: string = 'AUTHORISED',
  opts?: { idempotencyKey?: string; supplierId?: string },
): Promise<{ success: boolean; creditNoteId?: string; error?: string }> {
  const contactResult = await findOrCreateContact(data.contactName, data.contactEmail, true, { supplierId: opts?.supplierId })
  if (!contactResult.success || !contactResult.contactId) {
    return { success: false, error: `Contact error: ${contactResult.error}` }
  }
  for (const line of data.lines) {
    if (!line.accountCode) {
      return {
        success: false,
        error: `Line "${line.description}" is missing a purchase/expense account code for the supplier credit note.`,
      }
    }
  }
  const creditNote = buildXeroPurchaseCreditNote(data, status, contactResult.contactId)
  const res = await xeroPost<XeroCreditNoteResponse>('CreditNotes', creditNote, opts)
  if (!res.ok || !res.data?.CreditNotes?.length) {
    return { success: false, error: res.error ?? 'Failed to create purchase credit note' }
  }
  return { success: true, creditNoteId: res.data.CreditNotes[0].CreditNoteID }
}
