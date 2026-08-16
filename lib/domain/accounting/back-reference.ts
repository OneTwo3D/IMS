import type { AccountingSyncType } from '@/app/generated/prisma/client'
import { BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

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
 * Optional on BackReferenceDeps because a caller may already BE inside a transaction (a tx
 * client has no `$transaction`). Present on the real PrismaClient, which is what both
 * connectors and the repair sweep pass, so the live paths are fenced. When it is absent the
 * conditional write still refuses to overwrite a linked bill — the lock removes the wasted
 * work and the log noise of two sweeps racing, the compare-and-swap is what removes the
 * DAMAGE.
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
 * A Prisma unique-constraint violation (P2002) raised by the bill's external-id index.
 *
 * Structural rather than `instanceof Prisma.PrismaClientKnownRequestError` — the same idiom as
 * shopping-webhook-inbox's isUniqueViolation — for two reasons: this module keeps its Prisma
 * import type-only, and a test double must be able to RAISE one. A double that cannot produce a
 * constraint violation would make the handling below untestable while looking tested.
 *
 * An unnamed target is treated as ours (fail closed): refusing a write we could have made is the
 * acceptable failure, making one we should not have is not.
 *
 * Prisma may report the column name or the index name; both contain `accounting_invoice_id`, which
 * is what this matches on.
 */
export function isExternalBillIdConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { code?: unknown }).code !== 'P2002') return false
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (target === undefined || target === null) return true
  const targets = Array.isArray(target) ? target.map((entry) => String(entry)) : [String(target)]
  return targets.some((name) => name.includes('accounting_invoice_id'))
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

/** Whether a sync type/reference pair writes a back-reference at all. */
export function syncTypeWritesBackReference(type: AccountingSyncType, referenceType: string): boolean {
  return (
    (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') ||
    (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') ||
    (type === 'PURCHASE_INVOICE' && (referenceType === 'PurchaseInvoice' || referenceType === 'PurchaseOrder')) ||
    (type === 'PURCHASE_CREDIT_NOTE' && referenceType === 'SupplierCreditNote')
  )
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

  if (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') {
    await deps.salesOrder.update({
      where: { id: referenceId },
      data: {
        accountingInvoiceId: externalId,
        invoiceNumber: invoiceNumber ?? undefined,
        invoicedAt: new Date(),
      },
    })
  } else if (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') {
    await deps.salesOrderRefund.update({
      where: { id: referenceId },
      data: { accountingCreditNoteId: externalId },
    })
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
    // Already inside somebody else's transaction (a tx client has no `$transaction`): the
    // compare-and-swap below still refuses to overwrite a bill that gained an id, and a P2002 is
    // deliberately PROPAGATED rather than classified — swallowing it would leave the caller's
    // transaction aborted while telling them everything is fine.
    return resolveAndApplyPurchaseOrderBackReference(deps, resolveAndApply)
  } else if (type === 'PURCHASE_CREDIT_NOTE' && referenceType === 'SupplierCreditNote') {
    await deps.supplierCreditNote.update({
      where: { id: referenceId },
      data: { accountingCreditNoteId: externalId },
    })
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
