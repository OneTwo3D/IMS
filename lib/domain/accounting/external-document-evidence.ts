import type { Prisma } from '@/app/generated/prisma/client'

// ---------------------------------------------------------------------------
// o3d-v7sy — THE ROW THAT IS THE ONLY LOCAL RECORD OF AN EXTERNAL ACCOUNTING DOCUMENT.
//
// `findSalesOrderDeleteBlocker` (lib/domain/sales/order-delete-guard.ts) asks "does a document
// already stand against this order?" and answers it purely from `accounting_sync_logs`: rows keyed
// to the order, to its shipments, and to the daily batches the order was staged into. Retention
// deletes those rows by age, so that answer has a shelf life — and the guard does not FAIL when its
// evidence is gone, it returns the confident negative. No rows, no blocker, and the order is
// HARD-DELETED, leaving a real invoice, COGS journal or batch entry in Xero/QuickBooks with no IMS
// order behind it. The delete is irreversible and there is no sweep that ever notices. That is the
// whole of o3d-v7sy.
//
// THE OTHER READER OF THE SAME TABLE IS ALREADY SAFE, AND SAYING SO IS PART OF THE RULE.
// `dailyBatchRecreateVerdict` (lib/connectors/xero/daily-sync.ts, and the QuickBooks twin) reads its
// `rows.length === 0` arm as "the journal never posted" and re-raises it — which a deleted SYNCED
// batch row would turn into a DUPLICATE JOURNAL. It does not, because scjz.36 already bounded the
// recreate sweep to the same retention window: `recreateRetentionWindow`
// (lib/domain/accounting/daily-batch-retention.ts) restricts its candidates to stage stamps at or
// after the cutoff, and a batch log is never created BEFORE the date it is staged for, so any log
// old enough to be deleted (`createdAt < cutoff`) belongs to a stage date the sweep has already
// excluded. The two bounds are the same `retention_sync_logs_months` setting. So this module is NOT
// justified by a money reader — it is justified by the hard delete alone, which is enough.
//
// o3d-nepa closed HALF of this table's problem, for the CANCELLED rows only:
// `UNRESOLVED_ABANDONED_CLAIM_WHERE` keeps a cancelled row whose abandonment proves nothing. The
// SYNCED row — the one that says the document DID post — was left deletable. One rule, two
// populations, one fixed: this module is the other one, and it enters the SAME two passes.
//
// WHY IT IS KEYED ON THE READER'S OWN REFERENCE TYPES rather than on a list of document types.
// A type list is a restatement of what the readers happen to look for today, and it drifts the
// moment a new AccountingSyncType is queued against an order. The readers do not select by type at
// all — the delete guard matches `referenceType`+`referenceId` and takes ANY row it finds; the batch
// verdict matches `referenceType='DailyBatch'`. So the retained set is stated the same way, and
// `order-delete-guard.ts` builds its queries from THESE constants, so a reference type cannot be
// added to a reader without joining the retained set in the same edit.
//
// WHY THE STATUS ARM IS `SYNCED OR an external id` AND NOT the readers' full status list.
// Retention already refuses to delete any POSTABLE status (PENDING / PROCESSING / FAILED) —
// `POSTABLE_ACCOUNTING_SYNC_STATUSES`, the o3d-y14 clause. The delete guard's
// `LIVE_ACCOUNTING_SYNC_STATUSES` is exactly that set plus SYNCED, and it separately matches any
// row carrying an `externalTransactionId` whatever its status. So SYNCED and "carries a document
// id" is precisely the remainder — the part of what the readers look at that retention could still
// delete. That the two sets compose to cover the readers is not left to be noticed: it is asserted
// in tests/data-retention-postable-accounting-work.test.ts, which fails if a status is added to
// LIVE_ACCOUNTING_SYNC_STATUSES without appearing in one of them.
//
// THE ROW IS RETAINED, ITS CONTENT IS NOT. This predicate feeds the retention DELETE (negated) and
// the retention COMPACTION (asserted), exactly as the two populations before it do. Every reader
// above reads COLUMNS — status, referenceId, externalTransactionId, settlementBasis,
// abandonedBeforeRemoteCall — and none reads the payload, which is customer names, addresses and
// line descriptions. So the tombstone keeps what they ask for and the personal data still expires on
// the schedule the settings UI promises. Retaining these rows WHOLE and for ever is the objection
// that reverted the earlier PROCESSING exemption, and it is not repeated here.
//
// EVERY ARM IS NULL-TOTAL, the o3d-nepa discipline, because this constant is consumed under a `NOT`
// (the delete) and NOT under one (the compaction). A sub-expression that can evaluate to SQL NULL
// would leave a row in NEITHER pass — neither deleted nor compacted — and nothing would say so.
// `referenceType` and `status` are non-nullable columns, and `{ not: null }` compiles to
// `IS NOT NULL`, which is never itself NULL. So the negation is exact.
// ---------------------------------------------------------------------------

/** The delete guard's own key for rows keyed directly to the sales order. */
export const SALES_ORDER_REFERENCE_TYPE = 'SalesOrder'
/** The delete guard's own key for rows keyed to one of the order's shipments. */
export const SHIPMENT_REFERENCE_TYPE = 'Shipment'
/**
 * The key both the delete guard's A1/A2/B check and `dailyBatchRecreateVerdict` use. Daily-batch
 * rows are NOT keyed by order id — they carry a synthetic `<group>-<date>[-<digest>]` referenceId —
 * which is why the order row's stage stamps cannot stand in for them.
 */
export const DAILY_BATCH_REFERENCE_TYPE = 'DailyBatch'

/**
 * The reference types whose rows are read as evidence that an external document exists.
 *
 * Built from the same three identifiers `order-delete-guard.ts` queries with, so the retained set
 * and the readers cannot be spelled differently.
 */
export const EXTERNAL_DOCUMENT_EVIDENCE_REFERENCE_TYPES = [
  SALES_ORDER_REFERENCE_TYPE,
  SHIPMENT_REFERENCE_TYPE,
  DAILY_BATCH_REFERENCE_TYPE,
] as const

/**
 * The statuses that say a document may stand in the ledger AND that retention would otherwise
 * delete. POSTABLE rows are already exempt (see the header); this is the remainder.
 */
export const EXTERNAL_DOCUMENT_EVIDENCE_STATUS = 'SYNCED'

/**
 * THE RECORD RETENTION MUST NOT DELETE: a row that is the only local evidence that an external
 * accounting document stands against a sales order, a shipment of one, or a daily batch one was
 * staged into.
 *
 * Deleting it does not make a reader fail. It makes two readers answer "nothing was posted" — one
 * of which then permits an irreversible hard delete, and one of which then posts the journal again.
 */
export const EXTERNAL_DOCUMENT_EVIDENCE_WHERE: Prisma.AccountingSyncLogWhereInput = {
  referenceType: { in: [...EXTERNAL_DOCUMENT_EVIDENCE_REFERENCE_TYPES] },
  OR: [
    // The processor's own writeback said the ledger answered.
    { status: EXTERNAL_DOCUMENT_EVIDENCE_STATUS },
    // ...or the row names a document, whatever its status now says. A posted row can be reverted to
    // PENDING by a failed follow-up and cancelled from there, KEEPING the id — see the delete
    // guard's own note on why the status filter cannot come first.
    { externalTransactionId: { not: null } },
  ],
}
