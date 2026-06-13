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
  type: AccountingSyncType
  referenceType: string
  referenceId: string
  externalId: string
  invoiceNumber?: string
}

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
}

/** Whether a sync type/reference pair writes a back-reference at all. */
export function syncTypeWritesBackReference(type: AccountingSyncType, referenceType: string): boolean {
  return (
    (type === 'SALES_INVOICE' && referenceType === 'SalesOrder') ||
    (type === 'CREDIT_NOTE' && referenceType === 'SalesOrderRefund') ||
    (type === 'PURCHASE_INVOICE' && (referenceType === 'PurchaseInvoice' || referenceType === 'PurchaseOrder'))
  )
}

/**
 * Write the external id back onto the source document. THROWS on failure so the
 * caller can mark the sync row for retry — unlike the old inline version, which
 * swallowed the error and left the document silently orphaned.
 */
export async function applyBackReference(deps: BackReferenceDeps, params: BackReferenceParams): Promise<void> {
  const { type, referenceType, referenceId, externalId, invoiceNumber } = params
  if (!externalId) return

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
    const invoice = await deps.purchaseInvoice.findFirst({
      where: { poId: referenceId, accountingInvoiceId: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (invoice) {
      await deps.purchaseInvoice.update({
        where: { id: invoice.id },
        data: { accountingInvoiceId: externalId },
      })
    }
  }
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
  return false
}
