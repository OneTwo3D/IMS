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
  /** A PurchaseOrder-keyed row whose bill cannot be identified — refused rather than guessed. */
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
    findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; select: { id: true } }): Promise<{ id: string } | null>
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
   */
  reason: 'MULTIPLE_SYNC_ROWS' | 'MULTIPLE_UNLINKED_BILLS'
  syncRowCount: number
  /** Capped at 2 — the query only needs to know "one or more than one". */
  unlinkedBillCount: number
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
  // FIRST, before any uniqueness reasoning: is this row's own external id already on a bill
  // of this PO? Without this, an already-repaired legacy row plus one newer unlinked bill
  // satisfies "exactly one live row, exactly one unlinked bill" and the sweep copies the old
  // row's id onto a bill that is not its own — the exact defect this module exists to
  // prevent, reached through the uniqueness rule instead of the old newest-bill guess
  // (o3d-9kek finding 1). Nothing else constrains the duplicate: accountingInvoiceId has no
  // unique index, so the write would succeed.
  if (params.externalId) {
    const alreadyLinked = await deps.purchaseInvoice.findFirst({
      where: { poId: params.purchaseOrderId, accountingInvoiceId: params.externalId },
      select: { id: true },
    })
    if (alreadyLinked) return { outcome: 'already-linked', purchaseInvoiceId: alreadyLinked.id }
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
    await deps.purchaseInvoice.update({
      where: { id: referenceId },
      data: { accountingInvoiceId: externalId },
    })
  } else if (type === 'PURCHASE_INVOICE' && referenceType === 'PurchaseOrder') {
    // o3d-9kek: a PO-keyed row names the ORDER, not the bill. This used to write the id
    // onto "the newest bill with no id yet", which swaps ids whenever two bills are in
    // play. Attribute it only when the whole population for that PO leaves exactly one
    // possibility; otherwise refuse and let the caller log it for manual attribution.
    // (New rows are keyed on the bill since o3d-9oq — this path is for legacy rows.)
    const resolveAndApply = { connector, purchaseOrderId: referenceId, externalId }
    if (typeof deps.$transaction === 'function') {
      return deps.$transaction(async (tx) => {
        // Per-PurchaseOrder serialization, held to commit. hashtext() is Postgres's own
        // int4 hash, so the PO id stays visible in the statement's parameters rather than
        // being pre-hashed into an opaque number.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BACK_REFERENCE_PO_ATTRIBUTION_LOCK_NAMESPACE}::int4, hashtext(${referenceId})::int4)`
        return resolveAndApplyPurchaseOrderBackReference(tx, resolveAndApply)
      })
    }
    // Already inside somebody else's transaction (a tx client has no `$transaction`): the
    // compare-and-swap below still refuses to overwrite a bill that gained an id.
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
