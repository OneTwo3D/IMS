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
  /** The header's default rate as a fraction: what shipping and the order discount are taxed at when their own code names no rate. */
  headerRate: number
  lines: ReadonlyArray<{
    quantity: number
    unitAmount: number
    discountAmount?: number | null
    /**
     * The rate of the tax code the line will be SENT on (0 for a no-tax code), or null when no rate is known for that code. Tax on an exclusive
     * document is whatever the ledger computes from the code it is sent, so this, not the VAT IMS stored for the line, is what is reconciled;
     * `storedTax` stands in only for a code nobody can price.
     */
    rate: number | null
    storedTax: number
  }>
  /** The rate of the code shipping is sent on, or null when unknown (the header rate then). */
  shippingRate?: number | null
  /** The rate of the code the order discount is sent on, or null when unknown (the header rate then). */
  discountRate?: number | null
  /** As sent: gross when `lineAmountsIncludeTax`, else net. */
  shippingAmount?: number | null
  discountAmount?: number | null
  /**
   * The order discount as the invoice posts it when its tax was apportioned across the line rates: one amount per tax code, each with the rate of the code it is SENT on (null when no rate is
   * known for it: the header rate then). When present the discount's VAT is the sum over the parts, not `discountAmount` at one rate; `discountAmount` stays the total the parts add up to.
   */
  discountParts?: ReadonlyArray<{ amount: number; rate: number | null }>
}

/**
 * HOW FAR A GENUINE INVOICE CAN SIT FROM THE ORDER'S TOTAL, in the order's currency.
 *
 * The order stores its amounts to four places; the ledger works to two. Each figure the ledger computes by itself (the tax of a line, of the shipping,
 * of the discount) is rounded once, to the nearest minor unit, so it can be off by at most half a minor unit: 0.005 per line, plus 0.01 for the shipping
 * and the discount between them. One more cent covers the total itself being rounded. That is the whole of what rounding can produce, and it grows only with
 * the number of lines.
 *
 * It is CAPPED at 1.00: a difference of a whole currency unit is not rounding whatever the line count (at 0.005 a line the cap is reached at 194 lines, far
 * beyond any order this system holds), so the bound can never be wide enough to hide a mis-taxed shipping line or a fee on the wrong code.
 */
export const RECONCILIATION_TOLERANCE_PER_LINE = 0.005
export const RECONCILIATION_TOLERANCE_FIXED = 0.03
export const RECONCILIATION_TOLERANCE_CAP = 1

export function reconciliationBound(lineCount: number): number {
  return Math.min(RECONCILIATION_TOLERANCE_CAP, Math.round((RECONCILIATION_TOLERANCE_PER_LINE * lineCount + RECONCILIATION_TOLERANCE_FIXED) * 10000) / 10000)
}

export function expectedLedgerTotal(invoice: ReconcilableInvoice): number {
  const shipping = Number(invoice.shippingAmount ?? 0)
  const discount = Number(invoice.discountAmount ?? 0)
  const netLines = invoice.lines.map((l) => l.quantity * l.unitAmount - Number(l.discountAmount ?? 0))
  // Inclusive: every amount already carries its tax, so the document books to the sum of what it sends whatever the codes are.
  if (invoice.lineAmountsIncludeTax) return netLines.reduce((t, n) => t + n, 0) + shipping - discount
  const lines = invoice.lines.reduce((t, l, i) => t + netLines[i]! + (l.rate === null ? l.storedTax : netLines[i]! * l.rate), 0)
  const discountWithTax = invoice.discountParts && invoice.discountParts.length > 0
    ? invoice.discountParts.reduce((t, part) => t + part.amount * (1 + (part.rate ?? invoice.discountRate ?? invoice.headerRate)), 0)
    : discount * (1 + (invoice.discountRate ?? invoice.headerRate))
  return lines + shipping * (1 + (invoice.shippingRate ?? invoice.headerRate)) - discountWithTax
}

/** null when the invoice reconciles to the order total; otherwise the figures, for the refusal. */
export function invoiceReconciliationProblem(invoice: ReconcilableInvoice, orderTotal: number): { expected: number; orderTotal: number; difference: number } | null {
  const expected = Math.round(expectedLedgerTotal(invoice) * 100) / 100
  const difference = Math.round((expected - orderTotal) * 100) / 100
  const bound = reconciliationBound(invoice.lines.length)
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

/** The stored per-rate split of the order discount does not add up to the discount the invoice carries (beyond rounding): refused, since spreading the difference onto one rate would mis-tax it. */
export class SalesInvoiceDiscountSplitError extends SalesInvoiceDoesNotReconcileError {
  constructor(amount: number, currency: string) {
    super({ expected: 0, orderTotal: 0, difference: 0 }, currency)
    this.message = `This order's discount of ${amount.toFixed(2)} ${currency} was taxed per VAT rate, but the stored split no longer adds up to it, so the invoice would put the discount's VAT on the wrong rates. It was not queued and the order was not moved or saved. The order's discount has to be re-entered (edit the order) so it is re-split.`
    this.name = 'SalesInvoiceDiscountSplitError'
  }
}

/** A group of the order discount's per-rate split has no tax code to be posted on (discountSplitTaxCodeRefusal): refused here rather than queued for the sync processor to refuse. */
export class SalesInvoiceDiscountSplitTaxCodeError extends SalesInvoiceDoesNotReconcileError {
  constructor(message: string, currency: string) {
    super({ expected: 0, orderTotal: 0, difference: 0 }, currency)
    this.message = `${message} It was not queued and the order was not moved or saved.`
    this.name = 'SalesInvoiceDiscountSplitTaxCodeError'
  }
}

/** An update of a posted invoice touches a VAT rate the posted record gives two different codes: refused rather than guessed (postedCodesAmbiguityRefusal). */
export class SalesInvoicePostedCodesAmbiguousError extends SalesInvoiceDoesNotReconcileError {
  constructor(message: string, currency: string) {
    super({ expected: 0, orderTotal: 0, difference: 0 }, currency)
    this.message = `${message} It was not queued and the order was not moved or saved.`
    this.name = 'SalesInvoicePostedCodesAmbiguousError'
  }
}

/**
 * A positive shipping or order-discount amount the connector would DROP because its account is not mapped: the invoice would book short of (or over) that
 * money. Named so the message says which mapping is missing; still a reconciliation refusal, so every caller that refuses a mismatch refuses this.
 */
export class SalesInvoiceExtraNotMappedError extends SalesInvoiceDoesNotReconcileError {
  constructor(which: 'shipping' | 'discount', amount: number, currency: string) {
    super({ expected: 0, orderTotal: 0, difference: 0 }, currency)
    this.message = which === 'shipping'
      ? `This order has shipping of ${amount.toFixed(2)} ${currency}, but the shipping account is not set in the accounting settings, so the invoice would leave the shipping out and total less than the order. It was not queued and the order was not moved or saved. The shipping account is set under Settings, Accounting.`
      : `This order has an order discount of ${amount.toFixed(2)} ${currency}, but the discount account is not set in the accounting settings, so the invoice would leave the discount out and total more than the order. It was not queued and the order was not moved or saved. The discount account is set under Settings, Accounting.`
    this.name = 'SalesInvoiceExtraNotMappedError'
  }
}

/**
 * A reverse-charge line with no reverse-charge sales tax type configured (o3d-hqvrp.53). The swap is what moves the line off
 * its taxable code; with the setting empty the line would keep that code and the ledger would add VAT that the reconciliation
 * models at 0%. Refused rather than posted on the wrong code. Still a reconciliation refusal, so every caller that refuses a mismatch refuses this.
 */
export class SalesInvoiceReverseChargeSwapNotSetError extends SalesInvoiceDoesNotReconcileError {
  constructor(currency: string) {
    super({ expected: 0, orderTotal: 0, difference: 0 }, currency)
    this.message = 'This order has a reverse-charge line, but no reverse-charge sales tax type is set in the accounting settings, so the line would post on its taxable code and the ledger would add VAT to it. It was not queued and the order was not moved or saved. The reverse-charge sales tax type is set under Settings, Accounting.'
    this.name = 'SalesInvoiceReverseChargeSwapNotSetError'
  }
}

/** True when any line is reverse-charge and the swap setting is empty. */
export function reverseChargeSwapMissing(
  lines: ReadonlyArray<{ taxRate?: { reverseCharge?: boolean | null } | null }>,
  reverseChargeSalesTaxType: string | null | undefined,
): boolean {
  return !reverseChargeSalesTaxType?.trim() && lines.some((l) => l.taxRate?.reverseCharge === true)
}

/** The accounting queue declined the invoice (`reason`): inside the transaction that moves the order this rolls everything back. Not a reconciliation mismatch, so not a subclass. */
export class SalesInvoiceNotQueuedError extends Error {
  constructor(public readonly reason: string) {
    super(`The sales invoice for this order could not be queued (the accounting queue declined it: ${reason}), so nothing was saved and the order was not moved.`)
    this.name = 'SalesInvoiceNotQueuedError'
  }
}

/**
 * The answer of an in-transaction invoice enqueue, turned into the decision the transaction needs: a queued row, a recorded shadow (the producer-side hold) and a
 * type that is not configured to post owe the ledger nothing; anything else (a refusal) throws so the order's transaction rolls back.
 */
export function assertInvoiceQueuedOrNotOwed(outcome: { queued: boolean; reason?: string }): void {
  if (outcome.queued) return
  if (outcome.reason === 'not-configured' || outcome.reason === 'shadowed') return
  throw new SalesInvoiceNotQueuedError(outcome.reason ?? 'refused')
}

/**
 * An UPDATE of an already-posted sales invoice for which the invoice's own date cannot be read (not from the posted row's payload, the storefront creation day or the stored stamp).
 * Sending today's date would re-date the invoice into the period of the edit, so the update is refused. A subclass of the not-queued refusal, so every caller that refuses a declined invoice refuses this.
 */
export class SalesInvoiceOriginalDateUnknownError extends SalesInvoiceNotQueuedError {
  constructor() {
    super('the original date of the posted invoice is unknown')
    this.message = 'The invoice already posted for this order has a date IMS cannot read (no posted record carries it and the order stores none), and sending today\'s date would re-date that invoice. The update was not queued and nothing was saved. An administrator has to record the posted invoice date on the order in the database before it can be edited while Xero writes are live.'
    this.name = 'SalesInvoiceOriginalDateUnknownError'
  }
}
