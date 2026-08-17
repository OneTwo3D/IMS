import type { AccountingSyncStatus, AccountingSyncType } from '@/app/generated/prisma/client'
import { BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { isUniqueConstraintViolation, uniqueViolationTargetsField } from '@/lib/db/prisma-unique-violation'

// ---------------------------------------------------------------------------
// Accounting back-reference write + repair (audit-H3)
//
// After a document is pushed to the accounting connector, its external id must
// be written back onto the source document (accountingInvoiceId on a SalesOrder
// / PurchaseInvoice, accountingCreditNoteId on a SalesOrderRefund). If that
// write fails — or the process dies between marking the sync row SYNCED and
// running the write — the document is permanently orphaned: it has no external
// id, idempotency blocks a re-push, and (previously) the error was swallowed.
//
// This module isolates the per-type back-reference logic so it can be applied
// (throwing on failure, so the caller can retry) and probed (does the document
// still lack its id?) by a repair sweep. Pure DI seam — tests pass a mock that
// can throw on the write.
// ---------------------------------------------------------------------------

export type BackReferenceParams = {
  /**
   * Which accounting connector's external id this is. Required because a
   * PurchaseOrder-keyed row can only be attributed to a bill by asking how many
   * OTHER rows on that PO are competing for the same link — a question that is
   * only meaningful within one connector (o3d-9kek).
   */
  connector: string
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalId: string
  invoiceNumber?: string
}

/** What applyBackReference actually did — so a caller can log a refusal to guess. */
export type BackReferenceApplyOutcome =
  /** Written. Names the document it ACTUALLY wrote, which for a PO-keyed row is the resolved bill. */
  | { outcome: 'applied'; referenceType: string; referenceId: string }
  /** Nothing to write: no external id, an unhandled type/reference pair, or every bill already linked. */
  | { outcome: 'nothing-to-apply' }
  /**
   * This row's external id is ALREADY on a bill of this PO. A verdict, not a failure: the
   * repair happened (this pass or an earlier one), so nothing further is owed.
   */
  | { outcome: 'already-linked'; purchaseInvoiceId: string }
  /**
   * The resolved bill stopped being unlinked between the resolve and the conditional write —
   * a concurrent writer got there first. Nothing was overwritten, and nothing is claimed.
   */
  | { outcome: 'contended'; purchaseInvoiceId: string }
  /**
   * A PurchaseOrder-keyed row whose bill cannot be identified — refused rather than guessed.
   * Also carries the two CONFLICT reasons (the id is already attributed to another bill, either
   * seen by the resolver or reported by the unique index at write time): whichever bill holds
   * the id, this row's id is spoken for and must never be copied onto a second one.
   */
  | { outcome: 'ambiguous'; attribution: AmbiguousPurchaseOrderAttribution }

// Minimal Prisma surface the back-reference logic touches. Structural so a test
// double (or the real PrismaClient / a transaction client) satisfies it.
export type BackReferenceDeps = {
  salesOrder: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    findUnique(args: { where: { id: string }; select: { accountingInvoiceId: true } }): Promise<{ accountingInvoiceId: string | null } | null>
  }
  salesOrderRefund: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    findUnique(args: { where: { id: string }; select: { accountingCreditNoteId: true } }): Promise<{ accountingCreditNoteId: string | null } | null>
  }
  purchaseInvoice: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    /**
     * The CONDITIONAL write. `update` cannot express "only if still unlinked" — it matches on
     * the primary key alone — so the PO-keyed path uses updateMany and requires count === 1
     * (o3d-9kek finding 3). Same compare-and-swap idiom as accounting-event-mirror's void.
     */
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
    findUnique(args: { where: { id: string }; select: { accountingInvoiceId: true } }): Promise<{ accountingInvoiceId: string | null } | null>
  }
  supplierCreditNote: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    findUnique(args: { where: { id: string }; select: { accountingCreditNoteId: true } }): Promise<{ accountingCreditNoteId: string | null } | null>
  }
} & PurchaseOrderAttributionDeps & Partial<BackReferenceFenceDeps>

/**
 * The Prisma surface the PurchaseOrder → bill attribution asks about. Separate
 * from BackReferenceDeps so a sweep can resolve attribution without holding the
 * write surface.
 */
export type PurchaseOrderAttributionDeps = {
  accountingSyncLog: {
    count(args: { where: Record<string, unknown> }): Promise<number>
  }
  purchaseInvoice: {
    /**
     * `poId` is selectable because the claim lookup asks about the WHOLE table, not one PO: an
     * external id already held by a bill of another order is a conflict, and the PO-scoped
     * version of this question could not see it at all (o3d-9kek r2 finding 1).
     */
    findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; select: { id: true; poId?: true } }): Promise<{ id: string; poId?: string } | null>
    findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; select: { id: true }; take?: number }): Promise<Array<{ id: string }>>
  }
}

/** A client that can run raw SQL — i.e. take the advisory lock. Satisfied by a Prisma tx client. */
export type BackReferenceTxClient = BackReferenceDeps & {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}

/**
 * The seam that makes the PO-keyed resolve-then-apply ATOMIC (o3d-9kek finding 3).
 *
 * Optional on BackReferenceDeps because a caller may already BE inside a transaction and want this
 * work to join it rather than open a second one. Present on the real PrismaClient, which is what both
 * connectors and the repair sweep pass, so the live paths are fenced. When it is absent the
 * conditional write still refuses to overwrite a linked bill — the lock removes the wasted
 * work and the log noise of two sweeps racing, the compare-and-swap is what removes the
 * DAMAGE.
 *
 * "ABSENT" IS SOMETHING A CALLER DOES, NOT SOMETHING PRISMA DOES (Codex r9 finding 2). An earlier
 * revision of this comment — and of the test doubles — claimed a Prisma interactive-transaction
 * client has no `$transaction`, on the strength of the `ITXClientDenyList` type. That is false for
 * the installed runtime. Verified against node_modules/@prisma/client/runtime/client.js (7.7.0): the
 * deny list is exactly `["$connect","$disconnect","$on","$use","$extends"]`, `$transaction` is NOT in
 * it, and `_createItxClient` removes only those five, so the tx client KEEPS `$transaction` and
 * `_transactionWithCallback` opens a nested savepoint transaction for every provider except MongoDB.
 * So a caller that wants its own transaction joined rather than nested must strip the method itself —
 * see `withoutNestedTransaction` and releaseAndRelinkExternalDocumentId, which does exactly that.
 */
export type BackReferenceFenceDeps = {
  $transaction<T>(fn: (tx: BackReferenceTxClient) => Promise<T>): Promise<T>
}

export type AmbiguousPurchaseOrderAttribution = {
  outcome: 'ambiguous'
  /**
   * MULTIPLE_SYNC_ROWS   — another live PURCHASE_INVOICE row references this PO, so
   *                        two external ids compete for the same bill link.
   * MULTIPLE_UNLINKED_BILLS — the PO has more than one bill with no external id, so
   *                        the row names the order but not which bill it posted.
   * NO_LIVE_SYNC_ROW     — NO live row for this PO carries this external id any more. The
   *                        attribution evidence disappeared between the candidate read and this
   *                        count (retention deletes accounting_sync_logs by age; a row can also
   *                        be cancelled or have its external id cleared). Zero is NOT a
   *                        degenerate "one": the documented invariant is EXACTLY one live row,
   *                        and stamping an in-memory id after its evidence is gone is a guess
   *                        that cannot even be reviewed afterwards (o3d-9kek r2 finding 2).
   * EXTERNAL_ID_LINKED_ELSEWHERE — the id is already on a bill of a DIFFERENT PurchaseOrder.
   *                        Either that bill is the right one and this row's reference is wrong,
   *                        or something has already mis-attributed it; both need a human.
   * EXTERNAL_ID_CLAIMED_CONCURRENTLY — the unique index refused the write because another bill
   *                        acquired the id after this resolve. The interleaving the PO-scoped
   *                        guard could not see, caught by the constraint instead of by protocol.
   */
  reason:
    | 'MULTIPLE_SYNC_ROWS'
    | 'MULTIPLE_UNLINKED_BILLS'
    | 'NO_LIVE_SYNC_ROW'
    | 'EXTERNAL_ID_LINKED_ELSEWHERE'
    | 'EXTERNAL_ID_CLAIMED_CONCURRENTLY'
  /** NULL when the ambiguity was decided before this was measured — never reported as 0. */
  syncRowCount: number | null
  /** Capped at 2 — the query only needs to know "one or more than one". NULL as above. */
  unlinkedBillCount: number | null
  /** EXTERNAL_ID_LINKED_ELSEWHERE only: the bill that already holds this external id. */
  linkedPurchaseInvoiceId?: string
  /** EXTERNAL_ID_LINKED_ELSEWHERE only: the PurchaseOrder that bill belongs to, if known. */
  linkedPurchaseOrderId?: string | null
}

/**
 * The names a P2002 can use for the bill / sales-invoice column, and for the credit-note column.
 *
 * BOTH the DATABASE column and the PRISMA FIELD, because which of the two arrives depends on which
 * of the three shapes lib/db/prisma-unique-violation reads the violation from:
 *
 *   • `@prisma/adapter-pg` — what lib/db/index.ts actually builds the client with — reports the
 *     DATABASE columns at `meta.driverAdapterError.cause.constraint.fields`. All four of these
 *     columns are `@map`ped to all-lowercase snake_case (`accounting_invoice_id`,
 *     `accounting_credit_note_id`), and the live probe recorded in prisma-unique-violation.ts found
 *     that Postgres reports all-lowercase identifiers UNQUOTED — so `accounting_invoice_id`;
 *   • some adapter builds report the INDEX NAME there instead, and the raw-message fallback always
 *     does (`purchase_invoices_accounting_invoice_id_key`). The shared reader anchors those on the
 *     `_<column>_key` suffix rather than matching a substring;
 *   • the classic query engine's `meta.target` is a fallback path this codebase no longer runs on,
 *     and across Prisma versions it has carried column names, index names AND model field names.
 *
 * Listing the Prisma field name alongside the column costs nothing and removes the guess:
 * `accountingInvoiceId` is not a column ANY of these four tables has, so accepting it cannot widen
 * the match onto some other real column.
 *
 * NOT VERIFIED FROM HERE: the exact `constraint` payload for THESE indexes, which needs a live
 * database. What was verified live (see prisma-unique-violation.ts) is the shape of the envelope and
 * the quoting rule; the reader covers all three shapes, so the classification does not depend on
 * which one a given Prisma build picks.
 */
const EXTERNAL_BILL_ID_NAMES = ['accounting_invoice_id', 'accountingInvoiceId'] as const
const EXTERNAL_CREDIT_NOTE_ID_NAMES = ['accounting_credit_note_id', 'accountingCreditNoteId'] as const

/**
 * A Prisma unique-constraint violation (P2002) raised by one of the external-id indexes.
 *
 * Structural rather than `instanceof Prisma.PrismaClientKnownRequestError` — the same idiom as
 * shopping-webhook-inbox's isUniqueViolation — for two reasons: this module keeps its Prisma
 * import type-only, and a test double must be able to RAISE one. A double that cannot produce a
 * constraint violation would make the handling below untestable while looking tested — and a double
 * that produces the WRONG shape is worse, because it looks tested and is not. See the doubles in
 * tests/accounting/back-reference.test.ts, which raise the live adapter's envelope.
 *
 * FIELD IDENTIFICATION IS DELEGATED to lib/db/prisma-unique-violation (o3d-9kek r7 finding 2).
 * This used to read `meta.target` and nothing else, which is the ONE shape production never
 * produces: under `@prisma/adapter-pg` `meta.target` is `undefined` and the columns arrive at
 * `meta.driverAdapterError.cause.constraint.fields`. So every live P2002 fell into the old
 * "unnamed target" branch — and that branch returned TRUE. A `SalesOrderRefund.externalRefundId`
 * violation, or any other unique constraint on any of these models, was therefore reported to the
 * operator as an accounting-id collision, with a message naming a realm switch and a remedy that
 * has nothing to do with the constraint that actually failed.
 *
 * It also matched by SUBSTRING, so a hypothetical `accounting_invoice_id_hash` counted as ours.
 *
 * FAILS CLOSED, in the direction that phrase actually points here: a P2002 that does not identify
 * ITSELF as one of our columns is NOT claimed. The old comment called returning `true` "fail closed"
 * on the grounds that refusing a write is the safe failure — but these classifiers do not decide
 * whether to write. Every caller below has ALREADY had its write refused by the database; what the
 * classifier decides is what the operator is TOLD, and — in the sweep — whether the row is deferred
 * as a human-resolvable id conflict or counted as an ordinary transient failure. Claiming an
 * unidentified violation there is not caution, it is a wrong diagnosis; declining it surfaces the
 * real constraint instead.
 */
function isExternalIdConflict(error: unknown, names: readonly string[]): boolean {
  // WALKS THE CAUSE CHAIN (o3d-9kek r6 finding 3). Every branch below re-describes the violation in
  // the operator's terms and rethrows a plain Error with the P2002 as `cause`, so by the time the
  // repair sweep sees one, the code is no longer on the top-level object. Looking only at the top
  // would classify every one of our own explanatory rethrows as an unrelated failure — i.e. the
  // clearer the message, the less the caller could tell what it was.
  //
  // The FIRST P2002 in the chain decides. Our rethrows wrap the original violation, so the outermost
  // one is the real one; continuing past a P2002 that names a different constraint would let an
  // unrelated inner violation re-classify it.
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if (isUniqueConstraintViolation(current)) return uniqueViolationTargetsField(current, names)
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** The bill / sales-invoice index: purchase_invoices + sales_orders both use accounting_invoice_id. */
export function isExternalBillIdConflict(error: unknown): boolean {
  return isExternalIdConflict(error, EXTERNAL_BILL_ID_NAMES)
}

/** The credit-note indexes: sales_order_refunds + supplier_credit_notes (o3d-9kek r6 finding 3). */
export function isExternalCreditNoteIdConflict(error: unknown): boolean {
  return isExternalIdConflict(error, EXTERNAL_CREDIT_NOTE_ID_NAMES)
}

/**
 * Either of the above — for callers that only need "this write was refused because the external id
 * is already attributed", without caring which document type raised it (the repair sweep).
 */
export function isExternalDocumentIdConflict(error: unknown): boolean {
  return isExternalBillIdConflict(error) || isExternalCreditNoteIdConflict(error)
}

/**
 * The shared refusal message for a duplicated external id (o3d-9kek r6 finding 3).
 *
 * One wording for all four columns, because the situation and the remedy are identical: the ledger
 * document is already spoken for locally, IMS will not move or clear the existing link on its own
 * (nothing records whether that link was posted authoritatively or deduced), and a human has to
 * decide which local document is the real one. Written out rather than left as Prisma's
 * `Unique constraint failed on the fields: (...)`, which names a column and no action.
 */
function externalIdConflictMessage(params: {
  connector: string
  documentLabel: string
  localId: string
  externalId: string
  remoteLabel: string
  otherLabel: string
}): string {
  return (
    `Refusing to link ${params.documentLabel} ${params.localId} to ${params.connector} ${params.remoteLabel} ${params.externalId}: `
    + `that external id is ALREADY HELD LOCALLY by another ${params.otherLabel}, and one ledger document cannot belong to two `
    + 'local documents — every later correction, payment or status update would act on the wrong one. The likeliest cause is that '
    + 'this connector was reconnected to a different company/organisation which has reissued an id a document from the previous one '
    + `still holds; the next likeliest is that the ledger merged two of our documents on a shared number. Check which record currently `
    + `carries ${params.externalId} and resolve it by hand — nothing here will overwrite it.`
  )
}

export type PurchaseOrderAttribution =
  | { outcome: 'unique'; purchaseInvoiceId: string }
  /**
   * THIS row's external id is already on a bill of this PO. Checked FIRST, before any
   * uniqueness reasoning, because "one live row and one unlinked bill" is satisfied by a
   * historical row that was repaired long ago sitting next to a bill that belongs to
   * something else — and the uniqueness rule would then copy the old row's id onto it
   * (o3d-9kek finding 1). An id that is already where it belongs needs no repair.
   */
  | { outcome: 'already-linked'; purchaseInvoiceId: string }
  /** Every bill on the PO already carries an external id (or the PO has none). */
  | { outcome: 'none' }
  | AmbiguousPurchaseOrderAttribution

/**
 * Rows that still compete for a PO's bill link. CANCELLED is excluded (audit-46ry:
 * deliberately abandoned, e.g. a cross-connector orphan).
 *
 * PENDING/PROCESSING stay in the list for the case that matters — a row retried after a
 * partial post already carries its external id — but see the `externalTransactionId`
 * predicate below: a row that has NOT posted has no external id, so it is competing for
 * nothing yet and must not manufacture ambiguity (o3d-9kek finding 2). Holding the only
 * unlinked bill hostage for it does not protect it either: a PO-keyed row can only ever
 * post against a bill that already exists locally, so if this PO has exactly one unlinked
 * bill, both rows would want that same bill and one of them is a duplicate post — a
 * different defect, which refusing to repair does not fix.
 */
const PURCHASE_ORDER_ATTRIBUTION_LIVE_STATUSES = ['PENDING', 'PROCESSING', 'SYNCED', 'FAILED'] as const

/**
 * o3d-9kek: which bill a PurchaseOrder-keyed PURCHASE_INVOICE row belongs to.
 *
 * A PURCHASE_INVOICE row enqueued before o3d-9oq names the ORDER, not the bill, so the
 * old code fell through to "the newest bill on this PO with no external id yet". That
 * guess is wrong whenever two bills are in play, and a wrong external id is worse than a
 * missing one because it looks correct — later payments and document updates then hit
 * the wrong remote bill.
 *
 * Ambiguity is decided from the ACTUAL population for that PO — every live sync row and
 * every unlinked local bill — not from whatever happened to fall inside a sweep's capped
 * candidate page. A page-local count misses both "another row for this PO sits beyond the
 * page boundary" and "one row, but the PO has several unlinked bills".
 */
export async function resolvePurchaseOrderBackReference(
  deps: PurchaseOrderAttributionDeps,
  params: { connector: string; purchaseOrderId: string; externalId: string },
): Promise<PurchaseOrderAttribution> {
  // FIRST, before any uniqueness reasoning: WHO, ANYWHERE, already holds this external id?
  //
  // Scoped to this PO, this check missed the case that matters most — an id sitting on a bill of
  // a DIFFERENT order — and a copy written there is indistinguishable from a correct link
  // (o3d-9kek r2 finding 1). Unscoped it answers both questions at once, because the unique index
  // guarantees at most one holder:
  //
  //   • the holder is a bill of THIS PO  → already-linked. The repair happened; nothing is owed.
  //     Without this, an already-repaired legacy row plus one newer unlinked bill satisfies
  //     "exactly one live row, exactly one unlinked bill" and the old code copied the id onto a
  //     bill belonging to something else.
  //   • the holder is a bill of another PO → a CONFLICT, refused and reported. Either that bill
  //     is the correct one and this row's reference is wrong, or an earlier guess mis-attributed
  //     it. Both need a human; neither is repaired by writing a second copy.
  //
  // GLOBALLY, not per-connection. The unique index is on the VALUE alone, so this single lookup
  // finds the holder whoever it is. That is deliberately strict: a QuickBooks realm switch can
  // leave a retired company's bill holding an integer the new company has since reissued, and this
  // will then report a conflict and refuse. A blocked write with a loud error is the correct trade
  // — see applyBackReference's bill-keyed message, and o3d-gt8r for the connector-tenant isolation
  // work that would let two realms coexist safely.
  if (params.externalId) {
    const holder = await deps.purchaseInvoice.findFirst({
      where: { accountingInvoiceId: params.externalId },
      select: { id: true, poId: true },
    })
    if (holder) {
      if (holder.poId === params.purchaseOrderId) return { outcome: 'already-linked', purchaseInvoiceId: holder.id }
      return {
        outcome: 'ambiguous',
        reason: 'EXTERNAL_ID_LINKED_ELSEWHERE',
        syncRowCount: null,
        unlinkedBillCount: null,
        linkedPurchaseInvoiceId: holder.id,
        linkedPurchaseOrderId: holder.poId ?? null,
      }
    }
  }

  const unlinkedBills = await deps.purchaseInvoice.findMany({
    where: { poId: params.purchaseOrderId, accountingInvoiceId: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
    take: 2,
  })
  // Nothing to attribute — every bill already has its id. Not ambiguous: there is no
  // decision to get wrong.
  if (unlinkedBills.length === 0) return { outcome: 'none' }

  const syncRowCount = await deps.accountingSyncLog.count({
    where: {
      connector: params.connector,
      type: 'PURCHASE_INVOICE',
      referenceType: 'PurchaseOrder',
      referenceId: params.purchaseOrderId,
      status: { in: [...PURCHASE_ORDER_ATTRIBUTION_LIVE_STATUSES] },
      // A row with no external id has posted nothing, so it competes for no bill link.
      // Counting it manufactured ambiguity out of a FAILED row that never reached the
      // connector at all, which then blocked a repair that was in fact unambiguous
      // (o3d-9kek finding 2).
      externalTransactionId: { not: null },
    },
  })
  // EXACTLY one, not "at most one". Zero used to fall through to `unique`, which meant the
  // attribution could be acted on after the evidence for it had been deleted: the sweep reads its
  // candidate page outside this transaction, retention deletes accounting_sync_logs by age
  // independently, so between the two reads the legacy row — and, worse, a competing sibling
  // whose existence was the ONLY thing making the attribution ambiguous — can vanish. The sweep
  // then held an in-memory external id, saw one unlinked bill and no competitor, and stamped it.
  // Requiring one live row means the decision is always made against evidence that still exists
  // (o3d-9kek r2 finding 2). Retention no longer deletes unresolved evidence either — see
  // UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE — so this is the fence, not the whole fix.
  if (syncRowCount === 0) {
    return { outcome: 'ambiguous', reason: 'NO_LIVE_SYNC_ROW', syncRowCount, unlinkedBillCount: unlinkedBills.length }
  }
  if (syncRowCount > 1) {
    return { outcome: 'ambiguous', reason: 'MULTIPLE_SYNC_ROWS', syncRowCount, unlinkedBillCount: unlinkedBills.length }
  }
  if (unlinkedBills.length > 1) {
    return { outcome: 'ambiguous', reason: 'MULTIPLE_UNLINKED_BILLS', syncRowCount, unlinkedBillCount: unlinkedBills.length }
  }
  return { outcome: 'unique', purchaseInvoiceId: unlinkedBills[0].id }
}

/**
 * THE ONE AUTHORITATIVE LIST of sync type → reference type pairs that write a back-reference.
 *
 * Exported and derived-from rather than restated, because restating it is how a whole document type
 * silently fell out of the repair sweep (o3d-9kek r6 finding 2). The sweep and data retention both
 * filtered on a hand-written `['SALES_INVOICE', 'CREDIT_NOTE', 'PURCHASE_INVOICE']`, whose comment
 * claimed it matched these pairs — it did not. PURCHASE_CREDIT_NOTE was missing, so a supplier
 * credit note whose post succeeded and whose local id write failed was never a candidate for repair,
 * AND was never protected from retention: the only row carrying the external credit-note id was
 * deleted by age instead of compacted to a tombstone, taking the evidence with it.
 *
 * Every consumer that needs "which types can carry a back-reference" must read this, never a copy.
 * applyBackReference and backReferenceIsMissing below still branch per pair — they have to, the
 * columns differ — but a pair present here and absent there is caught by a test rather than by a
 * missing repair a year later.
 */
export const BACK_REFERENCE_PAIRS: ReadonlyArray<{
  type: AccountingSyncType
  referenceTypes: readonly string[]
  /**
   * The model that HOLDS the external id, and the column it holds it in. Not always the reference
   * type: a PurchaseOrder-keyed row is attributed to one of that order's PurchaseInvoices.
   *
   * Carried here, on the same table as the pair, so the four (model, column) facts the release path
   * needs cannot drift from the four branches applyBackReference writes — the r6 finding 2 mistake
   * was a restated list, and a second restated list is the same defect with a new name.
   */
  holder: ExternalDocumentIdHolder
}> = [
  { type: 'SALES_INVOICE', referenceTypes: ['SalesOrder'], holder: { model: 'SalesOrder', column: 'accountingInvoiceId' } },
  { type: 'CREDIT_NOTE', referenceTypes: ['SalesOrderRefund'], holder: { model: 'SalesOrderRefund', column: 'accountingCreditNoteId' } },
  // PurchaseOrder is the LEGACY keying (pre-o3d-9oq): the row names the order, not the bill, and is
  // attributed by resolvePurchaseOrderBackReference or refused.
  { type: 'PURCHASE_INVOICE', referenceTypes: ['PurchaseInvoice', 'PurchaseOrder'], holder: { model: 'PurchaseInvoice', column: 'accountingInvoiceId' } },
  { type: 'PURCHASE_CREDIT_NOTE', referenceTypes: ['SupplierCreditNote'], holder: { model: 'SupplierCreditNote', column: 'accountingCreditNoteId' } },
]

/** Which model/column a sync type+reference pair's external id lands on, or null if it lands nowhere. */
export function backReferenceHolder(type: AccountingSyncType, referenceType: string): ExternalDocumentIdHolder | null {
  return BACK_REFERENCE_PAIRS.find((pair) => pair.type === type && pair.referenceTypes.includes(referenceType))?.holder ?? null
}

/**
 * THE STATUSES whose external id is a durable record of a post that may still need linking locally.
 *
 * SYNCED is the obvious one — the post succeeded and the row is the local record of it, including
 * the QuickBooks quarantine state (SYNCED with the conflict in `errorMessage`, deliberately not
 * flipped out of SYNCED because that would stop the row suppressing its own re-enqueue and the
 * document would post twice).
 *
 * FAILED belongs here too, and getting that wrong would have silently gutted the release path. XERO
 * DOES NOT QUARANTINE: `updateBackReference` lets the refusal propagate, the caller runs
 * markSyncLogForFollowUpRetry, and after MAX_RETRIES the row lands on FAILED — still carrying the
 * externalTransactionId the ledger issued, because that is persisted before the back-reference is
 * ever attempted. So a Xero external-id conflict is ONLY ever visible as a FAILED row, and a release
 * that accepted SYNCED alone would refuse every Xero conflict there is: the exact "posted, refused,
 * and no way out" defect this path was built to remove, reintroduced by its own guard.
 *
 * PENDING/PROCESSING are excluded because a sync is in flight that may post again and return a
 * DIFFERENT id, and CANCELLED because the row was deliberately abandoned (audit-46ry).
 *
 * ONE definition, read by the sweep's candidate window, by the retention evidence predicate and by
 * the release. A restated copy is how a whole document type fell out of the sweep in r6 finding 2.
 */
export const BACK_REFERENCE_REPAIRABLE_STATUSES: readonly AccountingSyncStatus[] = ['SYNCED', 'FAILED']

/** The sync types in BACK_REFERENCE_PAIRS. Derived, so it can never drift from the pairs. */
export const BACK_REFERENCE_TYPES: readonly AccountingSyncType[] = BACK_REFERENCE_PAIRS.map((pair) => pair.type)

/** Whether a sync type/reference pair writes a back-reference at all. */
export function syncTypeWritesBackReference(type: AccountingSyncType, referenceType: string): boolean {
  return BACK_REFERENCE_PAIRS.some((pair) => pair.type === type && pair.referenceTypes.includes(referenceType))
}

// ---------------------------------------------------------------------------
// THE FOLLOW-UP OBLIGATION (o3d-9kek Codex r9 finding 1, r10 finding 1)
//
// Every connector posts a document, marks its sync row SYNCED with the external id, and THEN — as
// two separate awaits, outside that transaction on purpose, because the id must be durable before
// anything can fail — writes the back-reference and enqueues the follow-ups (invoice PDF, payment
// registration, bill attachment). If the process dies in between, the row is SYNCED, linked, and
// its follow-ups never ran. Nothing about that row says so: SYNCED means "posted", and a present
// back-reference means "linked". The work is owed and no state records that it is owed, so the
// repair sweep sees a reconciled row, stamps it checked, and the payment or PDF is gone silently.
//
// `backReferenceFollowUpsPendingAt` is that record. r9 added it and wired it into the SWEEP only;
// the sweep is the repair route and the connectors are where most rows actually go, so r10 wired it
// here — ONCE, shared, rather than a copy per connector. Copies are exactly how the two connectors
// drifted before (see the QuickBooks writer's own comment about its hand-rolled back-reference).
//
// TWO RULES, and they are what make the marker worth having:
//
//   1. CLAIMED AS AN INTENT, BEFORE THE LINK IS WRITTEN — never recorded in a catch afterwards. A
//      marker written only when the enqueue fails is itself a database write that can fail
//      transiently, and if it does, the row is linked again with nothing recording what it owes.
//      That is the same hole one layer down. On the connector paths the claim is FREE: it merges
//      into the update that flips the row to SYNCED, so there is no window at all between "SYNCED
//      with an id" and "recorded as owing follow-ups", and no extra call that can fail on its own.
//   2. RELEASED ONLY ONCE THE FOLLOW-UPS ACTUALLY RAN. The failure is asymmetric on purpose: a
//      marker left behind on a row whose follow-ups succeeded costs ONE idempotent re-enqueue on a
//      later sweep, while a marker cleared too early costs the payment.
// ---------------------------------------------------------------------------

/** The minimal Prisma surface the obligation release touches. Structural, so a test double fits. */
export type FollowUpObligationClient = {
  accountingSyncLog: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
  }
}

/**
 * The claim, as a data fragment to MERGE INTO the write that marks the row SYNCED — not as a call
 * of its own. Rule 1 above: made atomic with the SYNCED transition it is describing, so no ordering
 * and no failure of this marker can leave a posted row unrecorded.
 */
export function followUpObligationClaim(now: Date = new Date()): { backReferenceFollowUpsPendingAt: Date } {
  return { backReferenceFollowUpsPendingAt: now }
}

/**
 * Discharge the obligation: the back-reference is written and the follow-ups are enqueued.
 *
 * SWALLOWS its failure and reports it as a boolean, and never throws. The follow-ups have already
 * run by the time this is called, so a failure here is not a reason to retry them — driving the
 * caller's follow-up-failure path would re-post work that succeeded. Leaving the marker set is the
 * safe direction: the next sweep finds a linked row that still says it owes follow-ups and
 * re-enqueues them idempotently. Noise, not loss.
 *
 * It is a separate write because it has to be: the SYNCED transition commits BEFORE the follow-ups
 * run (that ordering is the connectors' idempotency guard against double-posting), so there is no
 * later transaction on this row to fold it into.
 */
export async function releaseFollowUpObligation(
  client: FollowUpObligationClient,
  params: { syncLogId: string; connector: string },
): Promise<boolean> {
  try {
    await client.accountingSyncLog.update({
      where: { id: params.syncLogId },
      data: { backReferenceFollowUpsPendingAt: null },
    })
    return true
  } catch (error) {
    console.error(
      `${params.connector}: follow-ups ran but the obligation marker could not be cleared; a later sweep will re-enqueue them`,
      params.syncLogId,
      error,
    )
    return false
  }
}

/**
 * Resolve a PO-keyed row to its bill and write the id in ONE step (o3d-9kek finding 3).
 *
 * Splitting the two — resolve here, write there — leaves a window in which a normal
 * bill-keyed sync links the very bill this resolved, and the write then replaces that valid
 * id with the legacy row's. Two things close it, and both are needed:
 *
 *   • the whole pair runs inside the caller's transaction under a per-PurchaseOrder advisory
 *     lock, so two repair sweeps (or a sweep and a connector's own writer) cannot interleave
 *     their resolves;
 *   • the write is a COMPARE-AND-SWAP — `updateMany` predicated on the bill still having no
 *     external id, requiring exactly one affected row. Writers that do NOT take the lock (the
 *     authoritative bill-keyed path, which must be free to overwrite) are still fenced out by
 *     this, because a linked bill no longer matches the predicate.
 *
 * Returns `contended` rather than throwing: nothing was written and nothing is wrong, the
 * next pass simply re-resolves from the state that actually won.
 *
 * NEITHER of those is sufficient on its own, and o3d-9kek r2 finding 1 is why: the lock is
 * COOPERATIVE (the authoritative bill-keyed writer does not take it) and the swap's predicate
 * only asks about ITS OWN bill. A bill-keyed writer that links a SIBLING bill with this
 * candidate's external id, after the resolve and before the swap, defeats both — the swap's row
 * is still unlinked, so it matches, and the id lands on two bills. What actually forbids that is
 * the unique index on purchase_invoices.accounting_invoice_id; the P2002 it raises is caught by
 * the caller and classified as an attribution conflict, never retried into an overwrite.
 */
async function resolveAndApplyPurchaseOrderBackReference(
  tx: BackReferenceDeps,
  params: { connector: string; purchaseOrderId: string; externalId: string },
): Promise<BackReferenceApplyOutcome> {
  const attribution = await resolvePurchaseOrderBackReference(tx, params)
  if (attribution.outcome === 'ambiguous') return { outcome: 'ambiguous', attribution }
  if (attribution.outcome === 'already-linked') {
    return { outcome: 'already-linked', purchaseInvoiceId: attribution.purchaseInvoiceId }
  }
  if (attribution.outcome === 'none') return { outcome: 'nothing-to-apply' }

  const written = await tx.purchaseInvoice.updateMany({
    where: { id: attribution.purchaseInvoiceId, accountingInvoiceId: null },
    data: { accountingInvoiceId: params.externalId },
  })
  if (written.count !== 1) return { outcome: 'contended', purchaseInvoiceId: attribution.purchaseInvoiceId }
  return { outcome: 'applied', referenceType: 'PurchaseInvoice', referenceId: attribution.purchaseInvoiceId }
}

/**
 * Write the external id back onto the source document. THROWS on failure so the
 * caller can mark the sync row for retry — unlike the old inline version, which
 * swallowed the error and left the document silently orphaned.
 */
export async function applyBackReference(deps: BackReferenceDeps, params: BackReferenceParams): Promise<BackReferenceApplyOutcome> {
  const { connector, type, referenceType, referenceId, externalId, invoiceNumber } = params
  if (!externalId) return { outcome: 'nothing-to-apply' }

  // o3d-9kek r6 finding 3: the three sales-side columns are globally unique too, so each of these
  // writes can now be REFUSED by the database — and each one classifies and re-describes the
  // refusal exactly as the bill writer below does. A bare `update` here would let Prisma's
  // `Unique constraint failed on the fields: (accounting_invoice_id)` be the only thing an operator
  // ever sees: a column name, no document, and no action.
  if (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') {
    try {
      await deps.salesOrder.update({
        where: { id: referenceId },
        data: {
          accountingInvoiceId: externalId,
          invoiceNumber: invoiceNumber ?? undefined,
          invoicedAt: new Date(),
        },
      })
    } catch (error) {
      if (!isExternalBillIdConflict(error)) throw error
      // Worse here than on a bill, which is why it is refused rather than allowed: payment polling
      // selects EVERY order carrying a matching external id and marks each one paid, so a duplicate
      // makes one customer payment settle two orders.
      throw new Error(
        externalIdConflictMessage({
          connector, documentLabel: 'SalesOrder', localId: referenceId, externalId,
          remoteLabel: 'invoice', otherLabel: 'sales order',
        }),
        { cause: error },
      )
    }
  } else if (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') {
    try {
      await deps.salesOrderRefund.update({
        where: { id: referenceId },
        data: { accountingCreditNoteId: externalId },
      })
    } catch (error) {
      if (!isExternalCreditNoteIdConflict(error)) throw error
      throw new Error(
        externalIdConflictMessage({
          connector, documentLabel: 'SalesOrderRefund', localId: referenceId, externalId,
          remoteLabel: 'credit note', otherLabel: 'refund',
        }),
        { cause: error },
      )
    }
  } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseInvoice') {
    // The AUTHORITATIVE path: the row names its own bill, so there is nothing to deduce and this
    // write is allowed to overwrite a legacy guess. It is still subject to the unique index, and
    // a violation here is a real signal rather than a race — the id is on some OTHER bill. That
    // happens when the ledger merged two of our documents (the o3d-6l3 ACCPAY upsert-on-
    // InvoiceNumber defect), when an earlier guess mis-attributed it, or — the case the index is
    // deliberately strict about — when the connector was reconnected to a DIFFERENT company and
    // reissued an id a retired company's bill still holds. Rethrown with the explanation, so the
    // sync row carries it: retries exhaust to FAILED and a human sees why, instead of a second bill
    // silently claiming the same remote document.
    //
    // The index is on the VALUE alone, deliberately (o3d-9kek). Namespacing it per connection would
    // let both bills exist, and roughly 190 call sites read a naked accountingInvoiceId — so the
    // collision would move from a blocked write to two documents a payment or an update can confuse,
    // on models (SalesOrder, SalesOrderRefund, SupplierCreditNote) that have no provenance column to
    // consult even in principle. A blocked write with a loud error is the acceptable failure; a
    // silent wrong document is not. See o3d-gt8r.
    try {
      await deps.purchaseInvoice.update({
        where: { id: referenceId },
        data: { accountingInvoiceId: externalId },
      })
    } catch (error) {
      if (!isExternalBillIdConflict(error)) throw error
      throw new Error(
        `Refusing to link PurchaseInvoice ${referenceId} to ${connector} bill ${externalId}: that external id is ALREADY HELD LOCALLY by `
        + 'another purchase invoice, and one ledger document cannot belong to two local bills — every later correction would rewrite the '
        + 'wrong one. The likeliest cause is that this connector was reconnected to a different company/organisation which has reissued an '
        + 'id a bill from the previous one still holds; the next likeliest is that an earlier repair mis-attributed it. Check which bill '
        + `currently carries ${externalId} and resolve it by hand — nothing here will overwrite it.`,
        { cause: error },
      )
    }
  } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseOrder') {
    // o3d-9kek: a PO-keyed row names the ORDER, not the bill. This used to write the id
    // onto "the newest bill with no id yet", which swaps ids whenever two bills are in
    // play. Attribute it only when the whole population for that PO leaves exactly one
    // possibility; otherwise refuse and let the caller log it for manual attribution.
    // (New rows are keyed on the bill since o3d-9oq — this path is for legacy rows.)
    const resolveAndApply = { connector, purchaseOrderId: referenceId, externalId }
    if (typeof deps.$transaction === 'function') {
      try {
        return await deps.$transaction(async (tx) => {
          // Per-PurchaseOrder serialization, held to commit. hashtext() is Postgres's own
          // int4 hash, so the PO id stays visible in the statement's parameters rather than
          // being pre-hashed into an opaque number.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE}::int4, hashtext(${referenceId})::int4)`
          return resolveAndApplyPurchaseOrderBackReference(tx, resolveAndApply)
        })
      } catch (error) {
        // The unique index refused the swap: another bill acquired this external id after the
        // resolve — the interleaving no PO-scoped guard and no compare-and-swap can see.
        //
        // Caught OUT HERE, deliberately, not inside the callback. A failed statement puts the
        // Postgres transaction in an aborted state, so catching a P2002 inside and returning
        // normally would make Prisma try to COMMIT an aborted transaction and fail anyway. There
        // is nothing else in this transaction worth saving — the swap was its only write — so
        // letting it roll back and classifying the error here is both simpler and correct.
        if (!isExternalBillIdConflict(error)) throw error
        return {
          outcome: 'ambiguous',
          attribution: { outcome: 'ambiguous', reason: 'EXTERNAL_ID_CLAIMED_CONCURRENTLY', syncRowCount: null, unlinkedBillCount: null },
        }
      }
    }
    // Already inside somebody else's transaction — the caller handed us a client with no
    // `$transaction`, which is a DELIBERATE ACT on their part (see BackReferenceFenceDeps: Prisma's
    // own tx client keeps the method). The compare-and-swap below still refuses to overwrite a bill
    // that gained an id, and a P2002 is deliberately PROPAGATED rather than classified — swallowing
    // it would leave the caller's transaction aborted while telling them everything is fine.
    return resolveAndApplyPurchaseOrderBackReference(deps, resolveAndApply)
  } else if (type === 'PURCHASE_CREDIT_NOTE' && referenceType === 'SupplierCreditNote') {
    try {
      await deps.supplierCreditNote.update({
        where: { id: referenceId },
        data: { accountingCreditNoteId: externalId },
      })
    } catch (error) {
      if (!isExternalCreditNoteIdConflict(error)) throw error
      // The one of the four with a live cause today: Xero's POST /CreditNotes is create-or-update
      // on CreditNoteNumber (the o3d-6l3 ACCPAY defect, one document type over), and
      // buildSupplierCreditNotePayload falls back to the PO reference when the number is blank —
      // so two manual credit notes on one PO can post the same number and come back with the same
      // CreditNoteID, the second having replaced the first in the ledger. The index turns that from
      // two local rows quietly sharing one document into a refusal somebody reads.
      throw new Error(
        externalIdConflictMessage({
          connector, documentLabel: 'SupplierCreditNote', localId: referenceId, externalId,
          remoteLabel: 'credit note', otherLabel: 'supplier credit note',
        })
        + ' If both credit notes were raised against the same purchase order with a blank credit-note number,'
        + ' they will have posted under the same number and the ledger will hold only one of them — check it there first.',
        { cause: error },
      )
    }
  } else {
    return { outcome: 'nothing-to-apply' }
  }
  return { outcome: 'applied', referenceType, referenceId }
}

/**
 * Whether the source document still lacks its back-reference — i.e. a repair is
 * needed. Returns false for types that don't write a back-reference.
 */
export async function backReferenceIsMissing(deps: BackReferenceDeps, params: BackReferenceParams): Promise<boolean> {
  const { type, referenceType, referenceId, externalId } = params
  if (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') {
    const so = await deps.salesOrder.findUnique({ where: { id: referenceId }, select: { accountingInvoiceId: true } })
    return so != null && !so.accountingInvoiceId
  }
  if (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') {
    const refund = await deps.salesOrderRefund.findUnique({ where: { id: referenceId }, select: { accountingCreditNoteId: true } })
    return refund != null && !refund.accountingCreditNoteId
  }
  if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseInvoice') {
    const inv = await deps.purchaseInvoice.findUnique({ where: { id: referenceId }, select: { accountingInvoiceId: true } })
    return inv != null && !inv.accountingInvoiceId
  }
  if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseOrder') {
    // o3d-9kek finding 1: THIS row's id being already on a bill of the PO settles it. Asking
    // only "is any bill unlinked?" reported a row as missing when it was in fact repaired
    // long ago, and the unlinked bill it then saw belonged to something else entirely.
    if (externalId) {
      const alreadyLinked = await deps.purchaseInvoice.findFirst({
        where: { poId: referenceId, accountingInvoiceId: externalId },
        select: { id: true },
      })
      if (alreadyLinked) return false
    }
    // Missing when at least one bill on the PO still has no external id to apply to.
    const invoice = await deps.purchaseInvoice.findFirst({
      where: { poId: referenceId, accountingInvoiceId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    return invoice != null
  }
  if (type === 'PURCHASE_CREDIT_NOTE' && referenceType === 'SupplierCreditNote') {
    const cn = await deps.supplierCreditNote.findUnique({ where: { id: referenceId }, select: { accountingCreditNoteId: true } })
    return cn != null && !cn.accountingCreditNoteId
  }
  return false
}

// ---------------------------------------------------------------------------
// THE ROUTE FORWARD out of a refused external-id write (o3d-9kek r7 finding 1).
//
// The global unique index turns a realm collision into a REFUSAL, which is the right trade —
// see applyBackReference. But a refusal is only acceptable if something can still be done, and
// for a document that has ALREADY POSTED to the remote ledger there was nothing:
//
//   • QuickBooks posts a bill under company B and gets id 145 back. The sync row is marked SYNCED
//     with externalTransactionId = 145 — so the fact of the post is durable and retention-protected
//     (UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE compacts that row to a tombstone rather than
//     deleting it, and the tombstone keeps the external id). Nothing is lost.
//   • The write of 145 onto the local bill is then refused, because a bill from the retired
//     company A still holds 145.
//   • The warning said "link the document by hand". THAT INSTRUCTION COULD NOT BE CARRIED OUT: the
//     same index refuses a manual link for exactly the same reason. And with the QuickBooks sweep
//     deliberately unwired (o3d-s36z is its precondition) nothing retried it either.
//
// So the missing piece was never the record — it was the RELEASE. The retired company's claim has
// to come off before anything, human or machine, can put the id where it belongs.
//
// WHY THIS IS NOT AUTOMATIC. Nothing in the database can tell a retired realm's stale id from a
// live, correct link: SalesOrder, SalesOrderRefund, PurchaseInvoice and SupplierCreditNote have no
// provenance column for the accounting id (that is what o3d-gt8r/o3d-s36z would add). Clearing the
// wrong one silently detaches a document that IS correctly linked — the governing principle again,
// pointing the other way. So the holder is NAMED BY THE OPERATOR and re-verified here, and the
// clear is conditional on that document still holding exactly that id.
//
// WHY THE SYNC ROW IS NOT FLIPPED TO FAILED to make it visible, which is the obvious move and is
// wrong: queueQuickBooksSync (and Xero's equivalent) dedupes new enqueues on
// `status in (PENDING, PROCESSING, SYNCED)`. A row moved out of SYNCED stops suppressing its own
// re-enqueue, and the document posts to the ledger a SECOND time. A posted document that cannot be
// recorded is bad; two posted documents are worse.
// ---------------------------------------------------------------------------

/** The four local models that can hold an accounting external document id, and the column they use. */
export type ExternalDocumentIdHolder =
  | { model: 'SalesOrder'; column: 'accountingInvoiceId' }
  | { model: 'SalesOrderRefund'; column: 'accountingCreditNoteId' }
  | { model: 'PurchaseInvoice'; column: 'accountingInvoiceId' }
  | { model: 'SupplierCreditNote'; column: 'accountingCreditNoteId' }

/** The Prisma delegate surface the claim lookup and release need. Structural, so a double satisfies it. */
type ExternalDocumentIdClaimDelegate = {
  findFirst(args: { where: Record<string, unknown>; select: { id: true } }): Promise<{ id: string } | null>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

export type ExternalDocumentIdClaimDeps = {
  salesOrder: ExternalDocumentIdClaimDelegate
  salesOrderRefund: ExternalDocumentIdClaimDelegate
  purchaseInvoice: ExternalDocumentIdClaimDelegate
  supplierCreditNote: ExternalDocumentIdClaimDelegate
}

/**
 * The sync row the operator named, re-read AT WRITE TIME (o3d-9kek r8 finding 2).
 *
 * The operator types a `--sync-log` id copied out of an activity entry that may be hours old. Every
 * fact the release acts on comes from that row — which external id, and onto which document — so the
 * row is the SOURCE, and a source that has moved on since it was read is not evidence of anything.
 */
type ExternalDocumentIdReleaseSourceDelegate = {
  findUnique(args: {
    where: { id: string }
    select: {
      id: true
      connector: true
      type: true
      referenceType: true
      referenceId: true
      externalTransactionId: true
      status: true
      errorMessage: true
      backReferenceAmbiguousLoggedAt: true
      backReferenceEvidenceCompactedAt: true
    }
  }): Promise<{
    id: string
    connector: string
    type: AccountingSyncType
    referenceType: string
    referenceId: string
    externalTransactionId: string | null
    status: string
    errorMessage: string | null
    backReferenceAmbiguousLoggedAt: Date | null
    backReferenceEvidenceCompactedAt: Date | null
  } | null>
  update(args: { where: { id: string }; data: { errorMessage: null } }): Promise<unknown>
}

/**
 * Everything the release touches, WITHOUT the transaction seam — i.e. what it hands to
 * `applyBackReference` from inside its own transaction, so the PO-keyed path there takes its
 * "already inside somebody else's transaction" branch instead of opening a second one.
 *
 * THE ABSENCE IS MANUFACTURED, not inherited (Codex r9 finding 2). An earlier revision said this
 * shape "is exactly what a Prisma interactive transaction client is". It is not: Prisma's tx client
 * keeps `$transaction` (see BackReferenceFenceDeps for the runtime evidence), so this `Omit` was a
 * type-level fiction that the value passed at runtime did not honour. Production therefore took the
 * nested-savepoint branch while every test took this one. `withoutNestedTransaction` makes the type
 * true of the value.
 */
export type ExternalDocumentIdReleaseClient =
  ExternalDocumentIdClaimDeps
  & Omit<BackReferenceDeps, '$transaction' | 'accountingSyncLog'>
  & { accountingSyncLog: BackReferenceDeps['accountingSyncLog'] & ExternalDocumentIdReleaseSourceDelegate }

/**
 * The activity-log write the release makes INSIDE its transaction (Codex r9 finding 3).
 *
 * Deliberately the raw delegate rather than lib/activity-log: that module writes through the global
 * `db`, so an entry written by it would commit (or fail) independently of the transaction whose
 * effects it describes — which is the defect. The caller supplies the text; the release supplies the
 * transaction.
 */
export type ExternalDocumentIdReleaseAuditClient = {
  activityLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> }
}

/**
 * Writes the DURABLE RECORD of a completed release, inside the release's own transaction.
 *
 * REQUIRED, and required as an argument rather than an option, because the record is not decoration:
 * this is the one operation in this module that deliberately clears a live accounting link, and an
 * operator asking "who detached this document, and when?" months later has nothing else to read. A
 * throw here rolls the release back — the audit row and the release land together or neither does.
 */
export type ExternalDocumentIdReleaseRecorder = (
  tx: ExternalDocumentIdReleaseAuditClient,
  release: { releasedFrom: string; appliedTo: { referenceType: string; referenceId: string } },
) => Promise<void>

/** The release's client, which MUST be transactional — see releaseAndRelinkExternalDocumentId. */
export type ExternalDocumentIdReleaseDeps = ExternalDocumentIdReleaseClient & {
  $transaction<T>(fn: (tx: ExternalDocumentIdReleaseClient & ExternalDocumentIdReleaseAuditClient & {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
    /**
     * PRESENT, because Prisma's interactive-transaction client has it (Codex r9 finding 2). Typing it
     * away is what let the production behaviour and the tested behaviour diverge; declaring it means
     * the stripping below is visible as a deliberate act instead of an assumption.
     */
    $transaction?: BackReferenceFenceDeps['$transaction']
  }) => Promise<T>): Promise<T>
}

/**
 * `tx` as a client that CANNOT open a nested transaction (Codex r9 finding 2).
 *
 * Prisma 7.7's interactive-transaction client retains `$transaction` and supports nesting via
 * savepoints, so handing it straight to `applyBackReference` makes that function open a SECOND
 * transaction inside ours — with its own advisory lock re-acquisition, and, worse, with its own
 * `catch` that classifies a unique-index violation and returns `ambiguous` normally. The release
 * would then report `not-relinked / ambiguous` with no `conflictMessage`, having thrown away the one
 * message that names which document holds the id. Removing the method makes the documented design
 * (one transaction, one lock, P2002 propagating to the release's own classifier) actually happen.
 *
 * A Proxy rather than a spread: the real client is itself a composite Proxy, and copying its own
 * keys is not a documented way to reproduce it. Functions are bound to the target so a method called
 * through this view still runs against the real client.
 */
function withoutNestedTransaction<T extends object>(tx: T): Omit<T, '$transaction'> {
  return new Proxy(tx, {
    get(target, property) {
      if (property === '$transaction') return undefined
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(target, property) {
      return property === '$transaction' ? false : Reflect.has(target, property)
    },
  }) as Omit<T, '$transaction'>
}

const CLAIM_DELEGATES: Record<ExternalDocumentIdHolder['model'], keyof ExternalDocumentIdClaimDeps> = {
  SalesOrder: 'salesOrder',
  SalesOrderRefund: 'salesOrderRefund',
  PurchaseInvoice: 'purchaseInvoice',
  SupplierCreditNote: 'supplierCreditNote',
}

/**
 * Which local record currently holds `externalId` in `holder`'s column — i.e. what is BLOCKING the
 * write, named so the operator does not have to go looking.
 *
 * SCOPED TO THE ONE MODEL, deliberately. The four unique indexes are PER TABLE, not global across
 * the four: `sales_orders.accounting_invoice_id` and `purchase_invoices.accounting_invoice_id` are
 * separate constraints, and QuickBooks issues Invoice ids and Bill ids from separate sequences — so
 * Invoice 145 and Bill 145 routinely coexist and are not related in any way. Searching all four
 * tables would report a perfectly innocent sales order as the blocker of a bill write, and the
 * release path below would then invite an operator to detach it.
 */
export async function findExternalDocumentIdClaim(
  deps: ExternalDocumentIdClaimDeps,
  params: { holder: ExternalDocumentIdHolder; externalId: string },
): Promise<{ id: string } | null> {
  if (!params.externalId) return null
  const delegate = deps[CLAIM_DELEGATES[params.holder.model]]
  return delegate.findFirst({ where: { [params.holder.column]: params.externalId }, select: { id: true } })
}

export type ExternalDocumentIdReleaseOutcome =
  /** The named holder released the id, and the back-reference was then written to its rightful owner. */
  | { outcome: 'relinked'; releasedFrom: string; appliedTo: { referenceType: string; referenceId: string } }
  /** The id is already on the document that should have it. Nothing to release, nothing to write. */
  | { outcome: 'already-correct' }
  /** Nothing holds the id in this model any more — so nothing is blocking. Re-run the repair instead. */
  | { outcome: 'no-claim' }
  /**
   * The document currently holding the id is NOT the one the operator confirmed. Refused rather than
   * released: the confirmation is the only thing separating "a retired realm's stale id" from "a
   * correct link", so a confirmation about a different document confirms nothing.
   */
  | { outcome: 'holder-mismatch'; currentHolderId: string }
  /**
   * The conditional clear matched no row — the holder changed its id between the read and the write.
   * Nothing was cleared and nothing was written; re-read and confirm again.
   */
  | { outcome: 'contended'; holderId: string }
  /**
   * THE SOURCE ROW is not the row the operator read (o3d-9kek r8 finding 2). Nothing was written.
   *
   *   MISSING              — the sync row is gone (retention, or a connector switch).
   *   NOT_REPAIRABLE_STATUS — it is outside BACK_REFERENCE_REPAIRABLE_STATUSES: PENDING/PROCESSING
   *                          means a sync is in flight that may post again under a DIFFERENT id, and
   *                          CANCELLED means the row was deliberately abandoned.
   *   NO_CONFLICT_EVIDENCE — nothing on the row records that its back-reference was ever refused, so
   *                          there is no durable evidence this is the conflict being resolved.
   *   EXTERNAL_ID_CHANGED  — it now carries a different external id: it re-posted, and the id the
   *                          operator confirmed a holder for is no longer the one this row is about.
   *   TARGET_CHANGED       — connector/type/reference moved, so it no longer names this document.
   */
  | { outcome: 'source-refused'; reason: 'MISSING' | 'NOT_REPAIRABLE_STATUS' | 'NO_CONFLICT_EVIDENCE' | 'EXTERNAL_ID_CHANGED' | 'TARGET_CHANGED' }
  /**
   * THE DESTINATION no longer needs this link (o3d-9kek r8 finding 2). Nothing was written.
   *
   *   ALREADY_LINKED     — it already carries a back-reference. A DIFFERENT one: an id equal to this
   *                        one is `already-correct` above. Overwriting it would replace a newer,
   *                        valid link with an older id read off a stale activity entry.
   *   MISSING            — the document itself is gone.
   *   CHANGED_UNDER_READ — it was unlinked when read and had acquired an id by the time the write
   *                        fenced it. The compare-and-swap refused; the newer link stands.
   */
  | { outcome: 'destination-refused'; reason: 'ALREADY_LINKED' | 'MISSING' | 'CHANGED_UNDER_READ' }
  /**
   * The re-link would not have landed, so NOTHING WAS RELEASED — the whole operation rolled back and
   * the holder still holds the id. Says what applyBackReference returned (or, for a violation of the
   * unique index raised inside the transaction, `ambiguous`, which is how applyBackReference's own
   * outer catch classifies the same interleaving).
   *
   * `conflictMessage` carries the unique-index refusal's own text when there was one. Without it the
   * operator would be told only "ambiguous" — while applyBackReference's message, the one that names
   * which document holds the id and what to do about it, was thrown away by the classification.
   */
  | { outcome: 'not-relinked'; applyOutcome: BackReferenceApplyOutcome['outcome']; conflictMessage?: string }
  /** This type/reference pair does not write a back-reference at all, so there is no claim to release. */
  | { outcome: 'not-applicable' }

/**
 * Thrown to ROLL THE TRANSACTION BACK while still reporting a structured outcome (r8 finding 1).
 *
 * Every refusal below has to unwind whatever the operation had already written, and the only way to
 * unwind a Prisma interactive transaction is to leave it by throwing. Caught immediately outside, so
 * it never escapes this module.
 */
class ExternalDocumentIdReleaseAbort extends Error {
  constructor(readonly result: ExternalDocumentIdReleaseOutcome) {
    super(`external id release aborted: ${result.outcome}`)
  }
}

/** Whether the sync row is still the one the operator read, or why it is not. */
function releaseSourceRefusal(
  source: Awaited<ReturnType<ExternalDocumentIdReleaseSourceDelegate['findUnique']>>,
  params: BackReferenceParams,
): Extract<ExternalDocumentIdReleaseOutcome, { outcome: 'source-refused' }>['reason'] | null {
  if (!source) return 'MISSING'
  // The same window the sweep and retention use, imported rather than restated. A row outside it is
  // not a posted-but-unlinked document: PENDING/PROCESSING means a sync is in flight that may return
  // a DIFFERENT id, CANCELLED means it was abandoned.
  if (!(BACK_REFERENCE_REPAIRABLE_STATUSES as readonly string[]).includes(source.status)) return 'NOT_REPAIRABLE_STATUS'
  // DURABLE EVIDENCE that this row's back-reference was actually refused — not merely a row that
  // happens to carry an external id, which is most of the table. Four paths leave a marker:
  //
  //   • QuickBooks quarantines the conflict into `errorMessage` on a row it keeps SYNCED;
  //   • Xero lets the refusal propagate, so markSyncLogForFollowUpRetry writes the same refusal text
  //     into `errorMessage` and the row exhausts its retries to FAILED;
  //   • the connector-agnostic repair sweep defers a refusal by stamping
  //     `backReferenceAmbiguousLoggedAt` rather than writing any text at all;
  //   • DATA RETENTION stamps `backReferenceEvidenceCompactedAt`, and that one has to be here or the
  //     guard would undo the thing it guards. The tombstone deliberately NULLS `errorMessage` (it is
  //     free text quoting the payload), so at the retention horizon a QuickBooks quarantine loses
  //     its only marker — and QuickBooks has no repair sweep to leave the other one, so this command
  //     is the sole route out. Accepting only the first three would let retention permanently retire
  //     an operator's ability to fix it: the r4 finding 3 mistake — compaction is scheduled by AGE
  //     and says nothing about repairability — in a new place. It is also the STRONGEST of the four:
  //     the stamp is written exclusively to rows matching UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
  //     i.e. to unresolved back-reference candidates and nothing else.
  //
  // A FAILED row's errorMessage can also be an ordinary failure unrelated to any conflict, so this
  // is a FLOOR, not a proof: what actually stops a wrong write is the operator's confirmation of the
  // holder, the holder still holding exactly this id, and the destination fence below.
  if (!source.errorMessage && !source.backReferenceAmbiguousLoggedAt && !source.backReferenceEvidenceCompactedAt) {
    return 'NO_CONFLICT_EVIDENCE'
  }
  if (source.externalTransactionId !== params.externalId) return 'EXTERNAL_ID_CHANGED'
  if (source.connector !== params.connector || source.type !== params.type
    || source.referenceType !== params.referenceType || source.referenceId !== params.referenceId) return 'TARGET_CHANGED'
  return null
}

/**
 * RELEASE the named holder's claim on an external id and immediately link it to the document that
 * actually posted it. The operator route out of a refused back-reference.
 *
 * ONE TRANSACTION, not one call (o3d-9kek r8 finding 1). Releasing alone leaves the id owned by
 * nobody, which is a WORSE state than the refusal it replaced: the ledger document is attached to
 * nothing at all, and for QuickBooks nothing sweeps it up afterwards. Doing both halves in one
 * FUNCTION was not enough to prevent that — a crash, a dropped connection or a refused re-link
 * between the two writes left exactly the state the design existed to avoid, and it was not even
 * recoverable by re-running: the holder no longer held the id, so the operator's confirmation no
 * longer matched anything and the command answered `no-claim` for ever. So the clear and the write
 * are one atomic unit; anything short of `applied` throws, the transaction rolls back to the
 * pre-release state, and the recovery procedure is simply to run the command again.
 *
 * WHAT IS VERIFIED, and where:
 *   • the SOURCE sync row is re-read inside the transaction and must still be the row the operator
 *     read — same external id, same target, still in BACK_REFERENCE_REPAIRABLE_STATUSES (SYNCED for
 *     QuickBooks' quarantine, FAILED for Xero's propagated refusal), still carrying conflict
 *     evidence (r8 finding 2). A row that re-posted under a new id is not evidence for moving the
 *     old one;
 *   • the HOLDER must still be the document the operator confirmed, and the clear is conditional on
 *     it still holding exactly that id;
 *   • the DESTINATION must still lack a back-reference, checked AND fenced under the same
 *     transaction: a no-op conditional write predicated on the column being null both proves it and
 *     row-locks it for the rest of the transaction, so a destination that has since acquired a
 *     newer, valid id is refused rather than overwritten. For a PO-keyed row the destination is not
 *     known until it is resolved, and that resolve — plus its own compare-and-swap — runs inside
 *     this transaction under the per-PurchaseOrder advisory lock, taken HERE and kept here by
 *     handing applyBackReference a client with no `$transaction` (Codex r9 finding 2 — Prisma's own
 *     tx client keeps that method and would otherwise nest a savepoint transaction inside ours).
 *
 * AND THE AUDIT ROW IS PART OF THE TRANSACTION (Codex r9 finding 3). The record of a destructive act
 * must be exactly as durable as the act. Writing it afterwards through lib/activity-log — which
 * swallows its own persistence errors and returns void — meant a successful release could leave the
 * holder detached, the destination linked, and NOTHING anywhere saying it had happened; re-running
 * could not recover it either, because the second run exits `already-correct` before reaching the
 * log. `recordRelease` runs on the same client, inside the same transaction: if it throws, the
 * release rolls back with it.
 *
 * Fails closed throughout: an unexpected state at any of those points refuses and reports, and
 * refusing to repair is acceptable in a way that repairing onto the wrong document is not.
 */
export async function releaseAndRelinkExternalDocumentId(
  deps: ExternalDocumentIdReleaseDeps,
  params: BackReferenceParams & { syncLogId: string; confirmedHolderId: string },
  recordRelease: ExternalDocumentIdReleaseRecorder,
): Promise<ExternalDocumentIdReleaseOutcome> {
  const holder = backReferenceHolder(params.type, params.referenceType)
  if (!holder || !params.externalId) return { outcome: 'not-applicable' }
  if (typeof deps.$transaction !== 'function') {
    // Not a fallback. A non-transactional client cannot roll the release back, and a release that
    // cannot roll back is the defect this function exists to not have.
    throw new Error('releaseAndRelinkExternalDocumentId requires a transactional client: the release and the re-link must be one atomic unit')
  }
  // A PurchaseOrder-keyed row names the ORDER; every other pair names the document that holds the
  // id itself (BACK_REFERENCE_PAIRS), which is what lets the destination be fenced by id below.
  const poKeyed = params.type === 'PURCHASE_INVOICE' && params.referenceType === 'PurchaseOrder'

  try {
    return await deps.$transaction(async (tx) => {
      if (poKeyed) {
        // The same lock applyBackReference would have taken, taken one level up: inside our
        // transaction it has no `$transaction` of its own, so it runs the resolve-and-swap unfenced
        // unless we hold the lock for it. Held to commit, so the resolve, the release and the swap
        // are all serialized against another repair of the same PO.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE}::int4, hashtext(${params.referenceId})::int4)`
      }

      const claim = await findExternalDocumentIdClaim(tx, { holder, externalId: params.externalId })
      if (!claim) throw new ExternalDocumentIdReleaseAbort({ outcome: 'no-claim' })
      // The id is already exactly where this row says it belongs. Only meaningful for the reference
      // types that name their own document — a PurchaseOrder-keyed row names an order, never a bill.
      //
      // ASKED BEFORE THE SOURCE IS VERIFIED, deliberately: it writes nothing, and it is the answer a
      // SECOND RUN of a command that already succeeded deserves. The first run clears the sync row's
      // quarantine text (below), so a re-run would otherwise be met with NO_CONFLICT_EVIDENCE —
      // technically a refusal that writes nothing, but one that reads as "you have the wrong row"
      // when the truth is "this is already done".
      if (claim.id === params.referenceId && params.referenceType === holder.model) {
        throw new ExternalDocumentIdReleaseAbort({ outcome: 'already-correct' })
      }

      const source = await tx.accountingSyncLog.findUnique({
        where: { id: params.syncLogId },
        select: {
          id: true, connector: true, type: true, referenceType: true, referenceId: true,
          externalTransactionId: true, status: true, errorMessage: true,
          backReferenceAmbiguousLoggedAt: true, backReferenceEvidenceCompactedAt: true,
        },
      })
      const sourceRefusal = releaseSourceRefusal(source, params)
      if (sourceRefusal) throw new ExternalDocumentIdReleaseAbort({ outcome: 'source-refused', reason: sourceRefusal })

      if (claim.id !== params.confirmedHolderId) {
        throw new ExternalDocumentIdReleaseAbort({ outcome: 'holder-mismatch', currentHolderId: claim.id })
      }

      // ONE delegate for both halves: the claim lookup only ever searches `holder.model`, and for
      // every non-PO pair the destination is a row of that same model (BACK_REFERENCE_PAIRS), so the
      // holder being released and the document being linked are rows of the same table.
      const table = tx[CLAIM_DELEGATES[holder.model]]
      if (poKeyed) {
        // The PO's own resolver already answers "does this PO still need the link?" — and it is the
        // only thing that can, since the bill is not named. `already-linked` means a bill of THIS
        // order already carries the id (including the case where the confirmed holder IS that bill),
        // so there is nothing to release and nothing to move.
        const attribution = await resolvePurchaseOrderBackReference(tx, {
          connector: params.connector, purchaseOrderId: params.referenceId, externalId: params.externalId,
        })
        if (attribution.outcome === 'already-linked') throw new ExternalDocumentIdReleaseAbort({ outcome: 'already-correct' })
      } else {
        // READ, then FENCE. The read distinguishes "already linked to something newer" from "gone"
        // for the operator; the conditional no-op write is what makes it safe — it matches only
        // while the column is still null and row-locks the destination until this transaction
        // commits, so nothing can link it between here and the write below.
        //
        // Writing the column to the value it already has looks pointless and is not: Postgres takes
        // the same row lock for a same-value UPDATE as for any other, which is the whole point, and
        // the `count` reports whether the predicate still held. Three of the four holder models
        // carry `@updatedAt`, so this does touch that column — only on a run that goes on to link
        // the row anyway (any refusal after this rolls back), so it never leaves a bare timestamp
        // bump behind.
        if (!await backReferenceIsMissing(tx, params)) {
          const exists = await table.findFirst({ where: { id: params.referenceId }, select: { id: true } })
          throw new ExternalDocumentIdReleaseAbort({ outcome: 'destination-refused', reason: exists ? 'ALREADY_LINKED' : 'MISSING' })
        }
        const fenced = await table.updateMany({
          where: { id: params.referenceId, [holder.column]: null },
          data: { [holder.column]: null },
        })
        if (fenced.count !== 1) throw new ExternalDocumentIdReleaseAbort({ outcome: 'destination-refused', reason: 'CHANGED_UNDER_READ' })
      }

      const released = await table.updateMany({
        where: { id: params.confirmedHolderId, [holder.column]: params.externalId },
        data: { [holder.column]: null },
      })
      if (released.count !== 1) throw new ExternalDocumentIdReleaseAbort({ outcome: 'contended', holderId: params.confirmedHolderId })

      // STRIPPED, so the re-link joins this transaction instead of nesting one inside it (Codex r9
      // finding 2). Everything else on this path keeps using `tx` directly.
      const applied = await applyBackReference(withoutNestedTransaction(tx), params)
      if (applied.outcome !== 'applied') {
        throw new ExternalDocumentIdReleaseAbort({ outcome: 'not-relinked', applyOutcome: applied.outcome })
      }

      // The QUARANTINE MARKER is resolved, so it must not outlive the conflict — cleared in the SAME
      // transaction, or a failure here would leave a resolved conflict still advertising itself as
      // unresolved. Two deliberate limits on that:
      //
      //   • ONLY ON A SYNCED ROW. `SYNCED` + `errorMessage` is the unreachable-by-any-other-route
      //     state QuickBooks writes to quarantine a refused back-reference (the success path nulls
      //     it), so clearing it says exactly "that quarantine is over". On a FAILED row the
      //     errorMessage is the ordinary record of what went wrong; erasing it would leave an
      //     inexplicable FAILED row, and the row's own status is not this command's to rewrite.
      //   • NEVER the STATUS. A row moved out of SYNCED stops suppressing its own re-enqueue and the
      //     document posts to the ledger a second time; a row moved INTO SYNCED is a claim about the
      //     sync that only the sync processor and the repair sweep are entitled to make.
      //
      // `backReferenceAmbiguousLoggedAt` is likewise NOT cleared: it is the sweep's once-per-interval
      // throttle, and a repaired row simply stops being a candidate.
      if (source?.status === 'SYNCED' && source.errorMessage) {
        await tx.accountingSyncLog.update({ where: { id: params.syncLogId }, data: { errorMessage: null } })
      }

      // LAST, and inside (Codex r9 finding 3). Last because it describes a completed release, so
      // every refusal above has already unwound without needing to unwind an audit row too; inside
      // because a record of a destructive act that can fail on its own is not a record. A throw here
      // takes the release down with it and the operator is told the command failed and wrote
      // nothing — which is true, and is recoverable by re-running.
      const release = {
        releasedFrom: params.confirmedHolderId,
        appliedTo: { referenceType: applied.referenceType, referenceId: applied.referenceId },
      }
      await recordRelease(tx, release)

      return { outcome: 'relinked' as const, ...release }
    })
  } catch (error) {
    if (error instanceof ExternalDocumentIdReleaseAbort) return error.result
    // The unique index refused the re-link from inside the transaction — the sibling-bill
    // interleaving applyBackReference classifies in its own outer catch for exactly this reason (a
    // failed statement aborts the Postgres transaction, so it cannot be caught and returned from
    // within). Same classification here, and the rollback has already undone the release.
    if (isExternalDocumentIdConflict(error)) {
      return {
        outcome: 'not-relinked',
        applyOutcome: 'ambiguous',
        conflictMessage: error instanceof Error ? error.message : String(error),
      }
    }
    // Anything else — a dropped connection, a lock timeout — propagates with the transaction rolled
    // back, so the pre-release state is intact and re-running the command is the whole recovery.
    throw error
  }
}
