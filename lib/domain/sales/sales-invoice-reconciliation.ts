/**
 * DOES THE INVOICE BUILT FOR A MANUAL ORDER BOOK TO THE ORDER'S OWN TOTAL?
 *
 * The invoice is a document of its own: its amounts are sent inclusive or exclusive of VAT as a whole, and shipping and the order discount take the
 * header's tax type, while the order stored its amounts under per-line rates and its own basis. Whenever those two readings of the same amounts part
 * (prices stored net but flagged gross, shipping taxed at a different rate from the header, ...) the ledger receives a different total from the one the
 * customer was quoted, and nobody finds out until the receivable does not settle. This computes what the ledger would book from the payload alone and
 * compares it with the stored total, so a mismatch is refused where the invoice would be queued rather than posted.
 */

export type ReconcilableInvoice = {
  lineAmountsIncludeTax: boolean
  /** The header's default rate as a fraction; shipping and the order discount are taxed at it. */
  headerRate: number
  lines: ReadonlyArray<{ quantity: number; unitAmount: number; discountAmount?: number | null; storedTax: number }>
  /** As sent: gross when `lineAmountsIncludeTax`, else net. */
  shippingAmount?: number | null
  discountAmount?: number | null
}

export const RECONCILIATION_TOLERANCE_PER_PART = 0.01

export function expectedLedgerTotal(invoice: ReconcilableInvoice): number {
  const lines = invoice.lines.reduce((t, l) => t + l.quantity * l.unitAmount - Number(l.discountAmount ?? 0), 0)
  const shippingAndDiscount = Number(invoice.shippingAmount ?? 0) - Number(invoice.discountAmount ?? 0)
  if (invoice.lineAmountsIncludeTax) return lines + shippingAndDiscount
  const lineTax = invoice.lines.reduce((t, l) => t + l.storedTax, 0)
  return lines + lineTax + shippingAndDiscount * (1 + invoice.headerRate)
}

/** null when the invoice reconciles to the order total; otherwise the figures, for the refusal. */
export function invoiceReconciliationProblem(invoice: ReconcilableInvoice, orderTotal: number): { expected: number; orderTotal: number; difference: number } | null {
  const expected = Math.round(expectedLedgerTotal(invoice) * 100) / 100
  const difference = Math.round((expected - orderTotal) * 100) / 100
  const bound = RECONCILIATION_TOLERANCE_PER_PART * (invoice.lines.length + 2)
  return Math.abs(difference) <= bound + 1e-9 ? null : { expected, orderTotal, difference }
}

export class SalesInvoiceDoesNotReconcileError extends Error {
  constructor(problem: { expected: number; orderTotal: number; difference: number }, currency: string) {
    super(
      `The invoice built for this order would total ${problem.expected.toFixed(2)} ${currency} but the order totals ${problem.orderTotal.toFixed(2)} ${currency} `
      + `(difference ${problem.difference.toFixed(2)}), so it was not queued and the order was not moved. The order's amounts and its tax treatment disagree `
      + `(for example shipping or a discount taxed at a different rate from the order's default rate). A new order has to be created with them consistent.`,
    )
    this.name = 'SalesInvoiceDoesNotReconcileError'
  }
}
