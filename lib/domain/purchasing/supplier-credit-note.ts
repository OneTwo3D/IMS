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
 * audit-oy5p / reverse-charge: resolve the ACCPAYCREDIT line's tax type so the
 * credit MIRRORS the bill it offsets.
 *
 * Reverse charge first: a reverse-charge purchase carries NO supplier VAT
 * (billHadTax is false because taxForeign is 0), but the goods ARE vatable — the
 * buyer self-accounts the notional input+output VAT under the reverse-charge tax
 * type. The bill posts those lines on `reverseChargeTaxType` (see purchase-
 * invoice-edit.ts), so the credit MUST reverse on that same tax type, NOT NONE,
 * or the notional VAT is never reversed. Callers set `isReverseCharge` only for
 * the purchase that actually carries it (a goods PO); freight credits never do.
 *
 * Otherwise: if the offset bill carried tax, reverse with the supplier's tax
 * type; else NONE (conservative — won't fabricate a VAT reversal without a bill
 * signal to mirror).
 *
 * Scope: the credit note is a single amount, so this uses a bill/PO-level tax
 * signal (uniform tax treatment — the normal case). Per-line tax bases on a
 * mixed bill remain out of scope for a single-amount credit.
 */
export function resolveSupplierCreditNoteTaxType(params: {
  billHadTax: boolean
  supplierTaxType: string | null | undefined
  /** True only when the offset purchase is reverse-charge (a goods PO). */
  isReverseCharge?: boolean
  /** The configured reverse-charge purchase tax type (accounting settings). */
  reverseChargeTaxType?: string | null
}): string {
  if (params.isReverseCharge) {
    // Mirror the bill poster exactly: the configured RC tax type when set, else
    // the line's own accounting tax type (baseTaxType) — NOT NONE, so an RC
    // purchase with no RC tax type configured still posts on the line's tax type
    // just as the bill did.
    return params.reverseChargeTaxType || params.supplierTaxType || 'NONE'
  }
  if (params.billHadTax && params.supplierTaxType) return params.supplierTaxType
  return 'NONE'
}

/**
 * Build the Xero PURCHASE_CREDIT_NOTE (ACCPAYCREDIT) sync payload from a posted
 * credit note. The single line reverses the freight bill on the same account it
 * debited (transit/clearing) and mirrors its tax type, so the credit nets the
 * capitalised freight AND reverses the VAT correctly (audit-oy5p).
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
  taxType: string
  date: string
  // audit-v08m: the offset bill's external (Xero) id + the amount to apply, so the
  // post-credit follow-up can allocate the ACCPAYCREDIT to the bill. Omitted (and
  // allocation skipped) when the bill hasn't synced to Xero yet.
  allocateToInvoiceId?: string | null
  allocateAmount?: number | null
  // Reverse-charge credits carry a NET amount and post EXCLUSIVE (like the bill,
  // which sends net/exclusive lines) so Xero computes the notional VAT on top
  // rather than netting the amount down. Standard/freight credits carry a GROSS
  // amount and post INCLUSIVE. Defaults to inclusive.
  lineAmountsIncludeTax?: boolean
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
        taxType: params.taxType,
      },
    ],
    // Standard/freight: the amount is GROSS (the over-credit cap is the bill's
    // gross total), so post tax-INCLUSIVE — Xero splits net + VAT under the
    // mirrored tax type (treating it as net would add VAT on top and over-credit).
    // Reverse charge: the amount is NET and posts EXCLUSIVE so Xero applies the
    // notional RC VAT on top, mirroring the net/exclusive RC bill. With a NONE
    // tax type inclusive vs exclusive is identical (no VAT).
    lineAmountsIncludeTax: params.lineAmountsIncludeTax ?? true,
    reference: params.reference ?? undefined,
    supplierId: params.supplierId,
    // audit-v08m: only carried when the bill has an external id — the follow-up
    // reads these to allocate the credit to the bill.
    ...(params.allocateToInvoiceId
      ? { allocateToInvoiceId: params.allocateToInvoiceId, allocateAmount: params.allocateAmount ?? params.amountForeign }
      : {}),
  }
}
