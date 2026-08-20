/**
 * Push credit notes to Xero.
 */

import { xeroGet, xeroPost, xeroPut } from './api'
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
 *
 * POST, AND DELIBERATELY SO — o3d-tfri. `POST /CreditNotes` is create-or-update on
 * `CreditNoteNumber`, the same upsert-on-a-natural-key that made `pushPurchaseBill` unsafe
 * (o3d-6l3). This one keeps it, because THE PREMISE THAT MAKES THE UPSERT DANGEROUS IS ABSENT HERE,
 * and it is worth being explicit about which premise:
 *
 *   A sales credit note's number is MINTED BY US and is unique by construction.
 *   `nextCreditNoteNumber` (lib/domain/sales/refund-service.ts) takes a
 *   `pg_advisory_xact_lock` on a per-year counter key and increments a stored counter, so two
 *   refunds cannot be handed the same number even concurrently. There is therefore no such thing
 *   as two DIFFERENT sales credit notes arriving at one `CreditNoteNumber` — only the SAME
 *   credit note posting again.
 *
 * And for that case the upsert is the property we want. Xero's idempotency key expires after six
 * minutes, so a QUEUED retry is not protected by it; what stops a duplicate is the local
 * `externalTransactionId`, which is exactly what is missing when the response to the first post
 * was lost. Re-posting then REPLACES the credit note's own document with identical content and
 * returns its id, and the ledger converges. `PUT` would instead refuse the retry — Xero requires
 * ACCRECCREDIT numbers to be unique — leaving a credit note in the ledger that IMS has no id for
 * and an operator to reconcile by hand.
 *
 * The supplier credit note below now stands on the SAME two premises, and reaches the same verb: its
 * number is derived from its own primary key, so it too is unique by construction, and its retry after
 * a lost response has to converge rather than create a second payable. What must not be converted by
 * analogy is the premise — a poster whose document number is not minted by us belongs on PUT.
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
 *
 * POST, LIKE THE SALES CREDIT NOTE — and the reasoning is the sales one, applied here at last.
 *
 * THE HISTORY MATTERS, because this verb has been both. `POST /CreditNotes` is create-or-update on
 * `CreditNoteNumber`: hand it a number Xero already holds for this contact and it silently REPLACES
 * that credit note and returns its id. On the PURCHASE side that number USED NOT TO BE OURS — it was
 * the supplier's own reference when they gave one, and the PURCHASE ORDER's reference when the
 * operator left the optional field blank. Several credit notes against ONE purchase order is an
 * explicitly supported flow (the over-credit guard caps the total, not the count), so two
 * blank-numbered credits on one PO carried the SAME number and the second overwrote the first:
 * payables understated by every credit but the last, no error on either side, and IMS only finding
 * out when the unique index on `SupplierCreditNote.accountingCreditNoteId` (o3d-9kek) refused the
 * second back-reference — long after the ledger damage was done.
 *
 * ROUND 1 of o3d-tfri fixed that twice over: `buildSupplierCreditNoteSyncPayload` was made to derive
 * the number from the credit note's own primary key, and this poster was switched to `PUT`
 * (create-only) so a collision from any source would be REFUSED rather than absorbed.
 *
 * ROUND 2: THE SECOND HALF WAS THE WRONG TRADE ONCE THE FIRST LANDED. Xero's idempotency key expires
 * after six minutes, so a QUEUED retry is not protected by it; what stops a duplicate is the local
 * `externalTransactionId`, and that is precisely what is missing when the response to the first
 * attempt was LOST. Under `PUT`, ACCPAYCREDIT numbers are not required to be unique in Xero, so the
 * retry does not collide — IT CREATES A SECOND CREDIT NOTE. Two ACCPAYCREDIT documents for one
 * supplier credit: payables now UNDERSTATED by the duplicate, which is the same ledger damage the
 * round-1 defect caused, arriving by the opposite route. And IMS records the id of the second, so
 * the first is orphaned in the ledger with nothing pointing at it.
 *
 * That argument is not new. It is verbatim the one round 1 wrote to KEEP the sales credit note on
 * POST — "a queued retry is unprotected; when the local id is missing after a lost response,
 * upserting REPLACES ITS OWN DOCUMENT AND CONVERGES, while creating would refuse and strand" — and
 * it was applied to one side only.
 *
 * WHAT MAKES IT APPLY HERE NOW is the OTHER half of round 1, and it must not be undone: the number
 * is `SCN-<creditNoteId>`, derived from this row's primary key ALWAYS (not only when the operator
 * left the field blank — see `buildSupplierCreditNoteSyncPayload`). Unique by construction, exactly
 * as `nextCreditNoteNumber`'s advisory-locked counter makes the sales number unique. So there is no
 * longer any such thing as two DIFFERENT supplier credit notes arriving at one `CreditNoteNumber` —
 * only the SAME one posting again, which is the case the upsert converges.
 *
 * The supplier's own reference is not lost and never was: it travels as `Reference`.
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

/**
 * audit-v08m: how much of a supplier credit note to allocate to a bill. The
 * allocation can never exceed (a) what the credit still has un-allocated
 * (RemainingCredit) or (b) what the bill still owes (AmountDue) — Xero rejects an
 * over-allocation, which would otherwise retry to permanent failure. Capping here
 * also makes a retry-after-success a safe no-op: once the credit is fully applied
 * RemainingCredit is 0, so this returns 0 and the caller skips the PUT. Rounded to
 * 2dp so floating-point noise can't push a cent over Xero's limit.
 */
export function resolveCreditNoteAllocationAmount(params: {
  requested: number
  remainingCredit: number
  amountDue: number
}): number {
  const capped = Math.min(params.requested, params.remainingCredit, params.amountDue)
  if (!Number.isFinite(capped) || capped <= 0) return 0
  return Math.round(capped * 100) / 100
}

type XeroCreditNoteRemainingResponse = {
  CreditNotes?: Array<{ CreditNoteID: string; RemainingCredit?: number }>
}
type XeroInvoiceDueResponse = {
  Invoices?: Array<{ InvoiceID: string; AmountDue?: number }>
}

/**
 * audit-v08m: allocate a posted supplier credit note (ACCPAYCREDIT) against the
 * bill it offsets, so the bill stops showing as outstanding in Xero's AP aging.
 * Idempotent: re-reads the credit's RemainingCredit and the bill's AmountDue
 * first, so a retry after a partial/successful allocation only applies the
 * residual (or nothing). Returns allocatedAmount=0 when there is nothing left to
 * apply (already settled), which the caller treats as success.
 */
export async function allocatePurchaseCreditNote(
  params: { creditNoteId: string; invoiceId: string; amount: number; date: string },
  opts?: { idempotencyKey?: string },
): Promise<{ success: boolean; allocatedAmount?: number; error?: string }> {
  const cnRes = await xeroGet<XeroCreditNoteRemainingResponse>(`CreditNotes/${params.creditNoteId}`)
  if (!cnRes.ok || !cnRes.data?.CreditNotes?.length) {
    return { success: false, error: cnRes.error ?? 'Credit note not found in Xero for allocation' }
  }
  const remainingCredit = cnRes.data.CreditNotes[0].RemainingCredit ?? 0

  const billRes = await xeroGet<XeroInvoiceDueResponse>(`Invoices/${params.invoiceId}`)
  if (!billRes.ok || !billRes.data?.Invoices?.length) {
    return { success: false, error: billRes.error ?? 'Bill not found in Xero for allocation' }
  }
  const amountDue = billRes.data.Invoices[0].AmountDue ?? 0

  const allocateAmount = resolveCreditNoteAllocationAmount({ requested: params.amount, remainingCredit, amountDue })
  if (allocateAmount <= 0) return { success: true, allocatedAmount: 0 }

  const res = await xeroPut<{ Allocations?: Array<{ Amount: number }> }>(
    `CreditNotes/${params.creditNoteId}/Allocations`,
    { Allocations: [{ Invoice: { InvoiceID: params.invoiceId }, Amount: allocateAmount, Date: params.date }] },
    opts,
  )
  if (!res.ok) {
    return { success: false, error: res.error ?? 'Failed to allocate credit note to bill' }
  }
  return { success: true, allocatedAmount: allocateAmount }
}
