// ---------------------------------------------------------------------------
// Supplier credit-note domain logic (audit-g5u2)
//
// Pure helpers for recording and posting a supplier credit note against a
// (freight) PO — kept DB-free so the validation + Xero-payload shape are
// unit-tested without a database or network.
// ---------------------------------------------------------------------------

/**
 * Validate a record request. Returns an error string, or null when valid.
 * A credit note can only be recorded against a PO that already has a supplier
 * invoice (you credit a bill, not an unbilled order), and a selected invoice
 * must belong to the PO.
 */
export function validateRecordSupplierCreditNote(params: {
  amountForeign: number
  hasInvoice: boolean
  /** null = no specific invoice selected; otherwise whether it belongs to the PO. */
  selectedInvoiceBelongsToPo: boolean | null
  /**
   * Remaining creditable amount on the selected bill (its total minus credit
   * notes already recorded against it). null = no specific bill to cap against.
   * Guards against over-crediting the supplier bill (Codex review).
   */
  remainingCreditableForeign?: number | null
}): string | null {
  if (!Number.isFinite(params.amountForeign) || params.amountForeign <= 0) {
    return 'Credit note amount must be greater than 0'
  }
  if (!params.hasInvoice) {
    return 'Record the supplier invoice before crediting it'
  }
  if (params.selectedInvoiceBelongsToPo === false) {
    return 'The selected invoice does not belong to this purchase order'
  }
  if (
    params.remainingCreditableForeign != null &&
    params.amountForeign > params.remainingCreditableForeign + 0.0001
  ) {
    return `Credit note exceeds the remaining creditable amount on this bill (${params.remainingCreditableForeign.toFixed(2)})`
  }
  return null
}

/**
 * Build the Xero PURCHASE_CREDIT_NOTE (ACCPAYCREDIT) sync payload from a posted
 * credit note. The single line reverses the freight bill on the same account it
 * debited (transit/clearing), so the credit nets the capitalised freight.
 */
export function buildSupplierCreditNoteSyncPayload(params: {
  creditNoteId: string
  creditNoteNumber: string | null
  reference: string | null
  reason: string | null
  supplierName: string
  supplierId: string
  currency: string
  fxRateToBase: number
  amountForeign: number
  transitAccount: string
  date: string
}): Record<string, unknown> {
  return {
    creditNoteNumber: params.creditNoteNumber ?? params.reference ?? `SCN-${params.creditNoteId}`,
    contactName: params.supplierName,
    date: params.date,
    currency: params.currency,
    currencyRateToBase: params.fxRateToBase,
    lines: [
      {
        description: params.reason ?? 'Supplier credit note',
        quantity: 1,
        unitAmount: params.amountForeign,
        accountCode: params.transitAccount,
        taxType: 'NONE',
      },
    ],
    reference: params.reference ?? undefined,
    supplierId: params.supplierId,
  }
}
