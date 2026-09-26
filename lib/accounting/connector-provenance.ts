/**
 * o3d-j625 r3 — PURE connector-provenance helpers for connector-native identifiers.
 *
 * Deliberately free of any import that carries BEHAVIOUR: lib/accounting.ts re-exports these, and many
 * tests mock that module whole. Keeping the pure halves here means those mocks never re-implement a
 * provenance rule by hand — a re-implementation in a fixture is a second copy of the rule, and a second
 * copy is what drifts.
 *
 * o3d-j625 r12 (merging o3d-remove-parked-connectors): it now imports the CONNECTOR REGISTRY, and only
 * that. `ACCOUNTING_CONNECTORS` is a frozen literal list with no side effects and no database, so this
 * module stays pure and safe to import from a fixture — and the reason the comment above gives (mocks of
 * `lib/accounting`) is untouched, because the registry is not `lib/accounting`. The alternative was to
 * keep spelling the roster as a literal pair here, which is the second copy of the rule that this very
 * comment warns about, and which after the archiving would have gone on accepting an id the build cannot
 * route.
 */

import { isRegisteredAccountingConnector, type AccountingConnectorId } from '@/lib/connectors/accounting-registry'

/** A connector this build can route a posting to. */
export type RoutableAccountingConnector = AccountingConnectorId

/**
 * A connector id AS IT WAS STORED — on a sync row, a sales order's `accountingInvoiceConnector`, a held
 * invoice, a persisted retry stage — which is NOT the same type as a routable one (o3d-j625 r12, merging
 * o3d-remove-parked-connectors).
 *
 * Those columns are plain strings with no foreign key, and archiving a connector deleted no rows, so a
 * stored value can name a connector this build does not register: development databases hold `quickbooks`
 * rows right now. Typing such a field `AccountingConnectorId` would be a CLAIM THAT CANNOT BE TRUE of a
 * value read back from the database, and it would make the code that exists to detect exactly that case
 * impossible to write or to test. `isRegisteredAccountingConnector` is the narrowing from this to
 * {@link RoutableAccountingConnector}, and development's `getAccountingPostingContextFor` types its own
 * pinned parameter `string` for the same reason.
 */
export type StoredAccountingConnector = string

/**
 * o3d-j625 r3 (Codex HIGH 2, HIGH 3) — THE PAYLOAD KEYS THAT HOLD SOMEBODY ELSE'S PRIMARY KEY.
 *
 * THE FINDING r2 GOT HALF RIGHT. `chartConnector` establishes whose chart of ACCOUNT CODES a payload
 * was written in, and r2 argued from there that mis-routing a connector's own document ids is WORSE
 * than mis-routing codes — then proved the provenance of one of the two ids in the payload it was
 * arguing about. The reviewer's answer: naming a chart says nothing about a DOCUMENT ID, because
 * document ids DELIBERATELY SURVIVE A CONNECTOR SWITCH. `SalesOrder.accountingInvoiceId` is not
 * cleared when the operator moves to QuickBooks — the Xero invoice it names still exists — so after a
 * switch the chart check passes (the codes really are the active connector's) while the payload still
 * carries the retired connector's invoice id. The payment then fails, or settles a document that
 * happens to share the id in the other ledger.
 *
 * These are the keys a connector sync processor reads out of a payload AS AN IDENTIFIER IN ITS OWN
 * SYSTEM — not an account code (those are covered by the chart), and not a local IMS id:
 *
 *   accountingInvoiceId      the invoice/bill the posting attaches to (INVOICE_PAYMENT, BILL_PAYMENT,
 *                            SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, credit-note allocation)
 *   accountingCreditNoteId   the credit note a follow-up attaches to
 *   creditNoteId             the same, under the name the Xero follow-up reads
 *   allocateToInvoiceId      the bill a supplier credit note is allocated against
 *   bankAccountId            the bank/payment ACCOUNT the money moves through. A connector account id,
 *                            and the one with no column to record: it comes from the GLOBAL, UNSCOPED
 *                            `accounting_payment_account_map` setting (see getPaymentAccountMap),
 *                            which is shared by both connectors and whose VALUES are one connector's
 *                            native ids. Its provenance is established by CONFIRMATION instead —
 *                            accountingBankAccountBelongsTo.
 *
 * WHY THE PAYLOAD IS READ AT RUNTIME rather than swept in source. Most enqueue payloads are built in
 * a helper (`buildPurchaseInvoiceAccountingPayload`, `buildSupplierCreditNoteSyncPayload`, a staged
 * `accountingRetrySyncs` row read back out of the database), so a source-text census of the call
 * arguments CANNOT SEE the keys — a scan of all 26 call sites reads an inline payload at only 9 of
 * them. A runtime read of the object that is about to be written is complete by construction, and it
 * catches the site somebody adds next month without needing a list to be updated.
 */
export const CONNECTOR_NATIVE_PAYLOAD_ID_KEYS = [
  'accountingInvoiceId',
  'accountingCreditNoteId',
  'creditNoteId',
  'allocateToInvoiceId',
  'bankAccountId',
] as const

/**
 * o3d-j625 r3 — A RECORDED PROVENANCE VALUE THIS BUILD CANNOT ROUTE IS `null`, NOT A GUESS.
 *
 * The provenance columns (`SalesOrder.accountingInvoiceConnector` and its three siblings) are plain
 * `TEXT`, because that is what `AccountingSyncLog.connector` is and because a connector can be removed
 * from the build while rows written under it remain (see the ShipHero removal in #680). A value this
 * build does not know is therefore possible, and it must NOT be narrowed to whatever this build happens
 * to support — that is the mis-attribution the whole issue is about. `null` is the answer, and `null`
 * makes the enqueue guard refuse and say the posting is owed.
 */
export function asRoutableAccountingConnector(
  value: string | null | undefined,
): RoutableAccountingConnector | null {
  return isRegisteredAccountingConnector(value) ? value : null
}

/** Which of {@link CONNECTOR_NATIVE_PAYLOAD_ID_KEYS} this payload actually carries a value for. */
export function connectorNativePayloadIdKeys(payload: Record<string, unknown>): string[] {
  return CONNECTOR_NATIVE_PAYLOAD_ID_KEYS.filter((key) => {
    const value = payload[key]
    return typeof value === 'string' && value !== ''
  })
}

