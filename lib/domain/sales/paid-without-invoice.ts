// ---------------------------------------------------------------------------
// Paid-without-invoice detection (audit-H2)
//
// An order's invoice number is generated automatically only for the 'on_paid'
// (at payment) and 'on_shipped' (at dispatch) invoice triggers. With the
// 'manual' trigger (or no trigger set), a fully-paid order can sit with a
// recorded receivable and no invoice ever generated or synced — a GL
// receivable/invoice mismatch. We do NOT auto-generate (manual means the
// operator wants control); we make the gap loud instead.
// ---------------------------------------------------------------------------

// Triggers that DO auto-generate an invoice in the normal flow, so a missing
// invoice on a paid order is expected to resolve itself (on_shipped → at ship).
const AUTO_INVOICE_TRIGGERS = new Set(['on_paid', 'on_shipped'])

/**
 * True when an order has just become fully paid, has no invoice number, and the
 * configured invoice trigger will never auto-generate one (manual / unset) — so
 * the operator should be alerted to generate it.
 */
export function shouldWarnPaidWithoutInvoice(params: {
  becamePaid: boolean
  hasInvoiceNumber: boolean
  invoiceTrigger: string | null | undefined
}): boolean {
  if (!params.becamePaid || params.hasInvoiceNumber) return false
  return !AUTO_INVOICE_TRIGGERS.has(params.invoiceTrigger ?? '')
}
