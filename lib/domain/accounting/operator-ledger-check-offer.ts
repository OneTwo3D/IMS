/**
 * The two facts about the operator ledger check that a CLIENT component needs, in a module with no
 * imports — so the Accounting Sync page can name and offer the control without pulling the settlement
 * evidence module (and its `node:crypto`) into a browser bundle. See operator-ledger-check.ts.
 */

/** The control the remedy names. One place, so the refusal, the page and the help text agree. */
export const LEDGER_CHECK_CONTROL_NAME = 'Checked the ledger'

/**
 * Whether the Accounting Sync page OFFERS the "Checked the ledger" control on a row. An affordance only:
 * the recorder re-reads the row and the ledger and refuses anything the registration decision does not
 * treat as an unresolved receipt attempt holding a receipt back — so offering it on a row where it then
 * refuses costs a sentence, never a payment.
 */
export function offersOperatorLedgerCheck(row: { type: string; referenceType: string; status: string }): boolean {
  return row.type === 'INVOICE_PAYMENT'
    && row.referenceType === 'SalesOrder'
    && LEDGER_CHECK_OFFERED_STATUSES.has(row.status)
}

/** The statuses an unresolved attempt can have (`unresolvedInvoicePaymentAttempts`' population). */
const LEDGER_CHECK_OFFERED_STATUSES: ReadonlySet<string> = new Set(['FAILED', 'CANCELLED'])
