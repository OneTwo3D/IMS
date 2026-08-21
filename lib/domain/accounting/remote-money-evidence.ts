import type { AccountingSyncType } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// o3d-nepa — WHAT RETENTION MAY NEVER FORGET ABOUT A REMOTE MONEY MOVEMENT.
//
// Retention expires accounting_sync_logs by AGE. For most rows that is a log being tidied away.
// For a handful of types the row is not a log at all: its bare EXISTENCE is the only local fact
// that stops the same money being moved in the ledger a second time. Delete it and the guard that
// reads it does not fail — it answers "no, nothing has been sent", confidently and wrongly.
//
// THE THREE READERS, and why each one is a duplicate rather than a lost audit trail:
//
//   • INVOICE_PAYMENT — `hasExistingSyncLog` counts PENDING/PROCESSING/**SYNCED** rows for the
//     scope and returns early when one exists. That SYNCED row is the entire suppression. It is
//     also, for an IMPORTED order, the ONLY record anywhere that the ledger was told: the payment
//     is registered by the SALES_INVOICE follow-up without ever creating a local Payment row, so
//     `decideInvoicePaymentRegistration` says in as many words that "IMS's own payment rows do not
//     bound what the ledger has been told". Delete the sync row and the next re-drive registers the
//     receipt again.
//   • PURCHASE_CREDIT_NOTE_ALLOCATION — `reenqueueMissingCreditNoteAllocations` treats a row of ANY
//     status, terminal ones included, as "this credit note is owned by the normal path" and skips
//     it. Its candidate query selects every POSTED credit note with a linked bill, for ever, so the
//     row is the only thing keeping an already-allocated credit out of that set. Delete it and the
//     sweep allocates the same credit against the same bill twice.
//   • BILL_PAYMENT — `latestBillPaymentSyncRows` derives a bill's settlement status from its newest
//     sync row. With the row gone a bill that was paid and settled in the ledger reads NOT_SENT,
//     and the operator-facing answer to "has this been sent?" invites the operator to send it.
//
// AND THE REMOTE SYSTEM WILL NOT CATCH IT. Xero's Idempotency-Key expires after six minutes, so a
// re-post weeks later is a new request as far as the ledger is concerned; the local record is the
// only thing that ever prevented the duplicate. o3d-h2wx made the TOKEN survive the row, which is
// what stops a REPLACEMENT row rotating it — but that only helps while some row still exists to
// carry it. A deleted row carries nothing.
//
// WHY THIS IS NOT THE POSTABLE-STATUS EXEMPTION. That one (PENDING/PROCESSING/FAILED, landing in
// PR #618) protects UNFINISHED work — a payload a worker will still post from. This protects
// FINISHED work: SYNCED and CANCELLED rows, which that exemption deliberately releases the moment
// they terminalise. The two sets barely overlap and neither implies the other, so they are kept
// apart rather than merged into one "important rows" list that would answer both questions badly.
//
// WHY THE WHOLE ROW, AND WHAT IT COSTS. The proper shape is a compacted tombstone keeping only the
// identity columns and the idempotency token — that is o3d-nepa's own prescription and it is still
// the right end state. It is not this change: compaction in place has twice traded one defect for
// another as each new consumer of these rows was discovered, and it needs the operator/health/
// backlog semantics settled first. What is retained meanwhile is small and specific: these payloads
// carry external ids, a bank account id, an amount, a date and a reference — no customer names,
// email addresses, delivery addresses or line descriptions, which is what made the earlier
// whole-table exemptions unacceptable. Growth is one row per payment or allocation ever made.
//
// NOT LISTED, deliberately: SALES_INVOICE, PURCHASE_INVOICE, CREDIT_NOTE and PURCHASE_CREDIT_NOTE.
// Those post DOCUMENTS, and a document that posted carries its external id back onto the local
// record, which is durable evidence outside this table. Their unresolved cases — posted with no
// local link — are already held back and compacted by UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE.
// ---------------------------------------------------------------------------

/**
 * Sync types whose row existence is the local guard against moving the same money twice.
 *
 * Read by data retention, and by tests that assert retention and the guards agree. Never merged
 * with `MONEY_MOVING_FOLLOW_UP_TYPES` in followup-idempotency: that set answers "does a duplicate
 * of this need a manual reversal, so pin the body and refuse on ambiguity?" and this one answers
 * "is this row the only thing stopping the duplicate?". BILL_PAYMENT is in exactly one of them.
 */
export const REMOTE_MONEY_EVIDENCE_TYPES: readonly AccountingSyncType[] = [
  'INVOICE_PAYMENT',
  'PURCHASE_CREDIT_NOTE_ALLOCATION',
  'BILL_PAYMENT',
]
