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

/**
 * True when a FULLY-PAID order with no invoice is being cancelled (audit-s3en).
 *
 * shouldWarnPaidWithoutInvoice deliberately stays quiet for the on_shipped (and
 * on_paid) auto-triggers because the invoice is expected to generate later in the
 * normal flow (at dispatch / at payment). But cancellation forecloses that: an
 * on_shipped order paid then cancelled-before-ship will NEVER get its invoice, so
 * the at-payment suppression leaves a silent paid-receivable-without-invoice gap.
 * At cancel time the trigger is irrelevant — no auto-generation can fire anymore —
 * so any fully-paid, uninvoiced order being cancelled must be surfaced for a
 * receivable reversal / refund. (on_paid orders already hold an invoice number;
 * manual/unset already warned at payment via shouldWarnPaidWithoutInvoice.)
 */
export function shouldWarnPaidOrderCancelledWithoutInvoice(params: {
  isPaid: boolean
  hasInvoiceNumber: boolean
}): boolean {
  return params.isPaid && !params.hasInvoiceNumber
}
