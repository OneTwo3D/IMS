import type { AccountingSyncType } from '@/app/generated/prisma/client'
import { syncTypeWritesBackReference } from './back-reference'
import { isOperatorAssertedSettlement } from './sync-row-settlement'

// ---------------------------------------------------------------------------
// o3d-psvi — A REFUSAL MUST CARRY A REMEDY AN OPERATOR CAN ACTUALLY PERFORM.
//
// THE STATE THIS EXISTS FOR. The back-reference sweep's `decideSaleRelease` reads the sales order
// under its row lock before it releases anything, and retires the sync row to CANCELLED when the
// sale is not live — deliberately, because writing a document id onto a cancelled order would
// enqueue that sale's PDF, email, storefront note and PAYMENT. It fails closed: a sale it cannot
// find reads as CANCELLED too.
//
// That retirement keeps the row's `externalTransactionId`, so a REAL ledger document is still named
// on it, and moves it out of `BACK_REFERENCE_REPAIRABLE_STATUSES` — which is simultaneously the
// sweep's candidate window, the retention evidence predicate, the operator release command's source
// check and the release CLI's. Every remaining route is FAILED-only or FAILED/PROCESSING-only, and
// the settle control answers "this row is already CANCELLED; a recorded outcome cannot be
// re-settled". So the row is terminal on every path there is.
//
// AND THE SALE CAN COME BACK. A WooCommerce order cancelled by mistake and then reinstated is
// pushed back into IMS through `applySalesOrderStatusTransition` with
// `INTERNAL_STATUS_TRANSITION_BYPASS`, which skips the lifecycle state machine and "will happily
// move an order backwards" — see lib/sales/status-transition-bypass.ts and
// lib/connectors/woocommerce/sync/order-status.ts. The lifecycle table has `CANCELLED: []`, so this
// is the only way back, and it is a route the storefront takes on its own.
//
// The result is a live sale, a real invoice in the ledger, no back-reference, no PDF, no email, no
// storefront note and no PAYMENT — and nothing an operator can press.
//
// WHY THIS IS A DECISION FUNCTION AND NOT A `status: 'CANCELLED'` FILTER ON THE RETRY. A STATUS IS
// NOT A POSTING. CANCELLED is written by this sweep, by the payment-reversal retirements, by the
// orphaned-row sweep and by an operator settling a row by hand, and the four mean entirely different
// things. Only one of them describes work that a live sale still needs finished, and the difference
// is not recorded anywhere as a flag — so it is RE-DERIVED here from facts that are: what the row
// names, what its basis column says, and what the sale says NOW under its own lock.
//
// AND THE REMEDY IS CHECKED END TO END. Releasing to SYNCED is worth nothing on its own: what
// finishes the job is the back-reference sweep, whose candidate window is
// `status in (SYNCED, FAILED)` AND `backReferenceCheckedAt IS NULL` AND an external id. If the row
// were already stamped, the release would produce a tidy-looking SYNCED row that no pass ever looks
// at again — a remedy that cannot be performed, which is the failure this issue is named for. That
// is why `backReferenceCheckedAt` is a REFUSAL below rather than a detail.
// ---------------------------------------------------------------------------

/** The one reference type whose row belongs to a sale that can be re-read. Mirrors the sweep's gate. */
export const SALE_SCOPED_RELEASE_REFERENCE_TYPE = 'SalesOrder'

/**
 * What the sale says, read under its own row lock inside the transaction that writes.
 *
 * THREE STATES, AND THE THIRD IS NOT A SYNONYM FOR THE SECOND. `UNREADABLE` is not evidence that the
 * sale is gone; it is evidence that nobody can currently speak for it — a lock timeout, a deadlock,
 * a dropped connection. Collapsing it into `CANCELLED` is exactly the fail-closed reading that
 * created this state in the first place, and doing it a second time, in the recovery, would make the
 * recovery unable to recover from itself.
 */
export type ReleaseSaleState = 'LIVE' | 'CANCELLED' | 'MISSING' | 'UNREADABLE'

export type CancelledSaleReleaseRow = {
  id: string
  type: AccountingSyncType
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  /** Read from the COLUMN, never from the note — see the refusal below. */
  settlementBasis: string | null
  backReferenceCheckedAt: Date | null
}

export type CancelledSaleReleaseDecision =
  | { release: true }
  | { release: false; reason: string }

/**
 * MAY THIS CANCELLED ROW BE PUT BACK IN FRONT OF THE SWEEP?
 *
 * Every refusal below names what to do instead, because a refusal that only says no is the defect
 * this whole issue is about. Pure, so the wording is testable without a database.
 */
export function describeCancelledSaleRelease(
  row: CancelledSaleReleaseRow,
  sale: ReleaseSaleState,
): CancelledSaleReleaseDecision {
  if (row.status !== 'CANCELLED') {
    return {
      release: false,
      reason: `This row is ${row.status}, not CANCELLED, so there is nothing to release. `
        + 'A FAILED row is retried or settled from its own controls; a SYNCED one is already recorded as posted.',
    }
  }

  // Scoped to the rows the sale-cancellation gate can actually have retired. That gate runs only for
  // `SalesOrder`-keyed rows, and only a type that WRITES A BACK-REFERENCE has anything for the sweep
  // to finish. Reading the pair table rather than naming SALES_INVOICE keeps this from drifting the
  // way a restated type list already has once (o3d-9kek r6 finding 2).
  //
  // It also excludes, by construction rather than by exception, the CANCELLED rows that must NEVER be
  // resurrected on any evidence: a payment retired because the operator reversed it in the ledger and
  // IMS confirmed the deletion is an INVOICE_PAYMENT, and an INVOICE_PAYMENT writes no back-reference.
  if (row.referenceType !== SALE_SCOPED_RELEASE_REFERENCE_TYPE || !syncTypeWritesBackReference(row.type, row.referenceType)) {
    return {
      release: false,
      reason: `This control only releases a sales-order document whose link was never written — a ${row.type} `
        + `for ${row.referenceType} is not one. If a document exists in the accounting system that IMS is not `
        + 'showing, correct it there; nothing here can adopt it.',
    }
  }

  const externalId = (row.externalTransactionId ?? '').trim()
  if (externalId === '') {
    return {
      release: false,
      reason: 'This row names no document in the accounting system, so nothing was posted from it and there is '
        + 'nothing to link. Raise the invoice again from the sales order rather than releasing this row — releasing '
        + 'it would record a post that never happened.',
    }
  }

  // THE BASIS COLUMN, NOT THE NOTE (o3d-anu8). A row settled on an operator's word names a document
  // id a person typed after looking at a screen; nobody called the accounting system for it and
  // nothing compared an amount. The sweep already refuses to build follow-ups from one, so releasing
  // it would not even reach the work — it would just move the refusal somewhere nobody is looking.
  if (isOperatorAssertedSettlement(row.settlementBasis)) {
    return {
      release: false,
      reason: 'This row\'s outcome was recorded by an OPERATOR ASSERTION, not by the connector, so the document id '
        + `${externalId} is unverified. Open it in the accounting system: if it is the right document, link it to `
        + 'this sales order by hand, and the row settles itself. Releasing it would build a PDF, a note or a PAYMENT '
        + 'against a document nothing has checked.',
    }
  }

  // The end-to-end check. A stamped row is one the sweep has reached a verdict on and will never look
  // at again, so the release would hand it to a pass that has already finished with it.
  if (row.backReferenceCheckedAt !== null) {
    return {
      release: false,
      reason: 'The repair sweep has already reached a verdict on this row, so releasing it would produce a row no '
        + 'later pass looks at. Check the sales order for its accounting invoice id: if it is missing, use the '
        + 'external-id release command, which is the path that re-opens a settled row.',
    }
  }

  if (sale === 'CANCELLED') {
    return {
      release: false,
      reason: 'The sales order is still CANCELLED. A document raised against a cancelled sale must not be revived — '
        + `writing its id onto the order would enqueue that sale's PDF, email, storefront note and PAYMENT. The `
        + `document ${externalId} is real and is the only thing left to undo: void or credit-note it in the `
        + 'accounting system. If the sale should be live, reinstate the order first and then release this row.',
    }
  }

  if (sale === 'MISSING') {
    return {
      release: false,
      reason: 'The sales order this row belongs to no longer exists, so there is nothing for the document id to be '
        + `written onto. The document ${externalId} is still real: void or credit-note it in the accounting system.`,
    }
  }

  if (sale === 'UNREADABLE') {
    return {
      release: false,
      reason: 'The sales order could not be read, so this attempt could not prove it is live and NOTHING was '
        + 'changed — the row is exactly as it was. That is not a verdict about the sale, only about this moment: '
        + 'try again.',
    }
  }

  return { release: true }
}

/**
 * The note the released row carries.
 *
 * It says what was true at the moment of the release and what happens next, because the row's own
 * status will shortly be changed again by the sweep, and a reader arriving afterwards has no other
 * way to know why a retired row came back.
 */
export function cancelledSaleReleaseNote(externalId: string, now: Date): string {
  return `Released at ${now.toISOString()}: this row had been retired because the sales order was not live, and the `
    + `order is live again. The document ${externalId.trim()} was already posted and is unchanged; the row is put back `
    + 'in front of the back-reference repair sweep so the link and the outstanding follow-ups are completed. Nothing '
    + 'was sent to the accounting system by this release.'
}
