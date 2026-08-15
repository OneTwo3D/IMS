import type { AccountingSyncType } from '@/app/generated/prisma/client'

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
  | { outcome: 'applied' }
  /** Nothing to write: no external id, an unhandled type/reference pair, or every bill already linked. */
  | { outcome: 'nothing-to-apply' }
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
    findUnique(args: { where: { id: string }; select: { accountingInvoiceId: true } }): Promise<{ accountingInvoiceId: string | null } | null>
    findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; select: { id: true } }): Promise<{ id: string } | null>
  }
  supplierCreditNote: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    findUnique(args: { where: { id: string }; select: { accountingCreditNoteId: true } }): Promise<{ accountingCreditNoteId: string | null } | null>
  }
} & PurchaseOrderAttributionDeps

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
    findMany(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown>; select: { id: true }; take?: number }): Promise<Array<{ id: string }>>
  }
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
  /** Every bill on the PO already carries an external id (or the PO has none). */
  | { outcome: 'none' }
  | AmbiguousPurchaseOrderAttribution

/**
 * Rows that still compete for a PO's bill link. CANCELLED is excluded (audit-46ry:
 * deliberately abandoned, e.g. a cross-connector orphan); PENDING/PROCESSING are
 * INCLUDED, because such a row has not posted yet but will, and it will then need a
 * bill of its own — attributing the only unlinked bill away from it now would strand it.
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
  params: { connector: string; purchaseOrderId: string },
): Promise<PurchaseOrderAttribution> {
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
    const attribution = await resolvePurchaseOrderBackReference(deps, { connector, purchaseOrderId: referenceId })
    if (attribution.outcome === 'ambiguous') return { outcome: 'ambiguous', attribution }
    if (attribution.outcome === 'none') return { outcome: 'nothing-to-apply' }
    await deps.purchaseInvoice.update({
      where: { id: attribution.purchaseInvoiceId },
      data: { accountingInvoiceId: externalId },
    })
  } else if (type === 'PURCHASE_CREDIT_NOTE' && referenceType === 'SupplierCreditNote') {
    await deps.supplierCreditNote.update({
      where: { id: referenceId },
      data: { accountingCreditNoteId: externalId },
    })
  } else {
    return { outcome: 'nothing-to-apply' }
  }
  return { outcome: 'applied' }
}

/**
 * Whether the source document still lacks its back-reference — i.e. a repair is
 * needed. Returns false for types that don't write a back-reference.
 */
export async function backReferenceIsMissing(deps: BackReferenceDeps, params: BackReferenceParams): Promise<boolean> {
  const { type, referenceType, referenceId } = params
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
