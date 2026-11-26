/**
 * DELETE A SYNCED INVOICE OR BILL IN IMS AND XERO TOGETHER (o3d-ngmt.21): read the facts, queue the Xero side, and unwind the IMS side when
 * the ledger confirms.
 *
 * THE SHAPE. Nothing in IMS is changed by the request. The request writes ONE durable record (`AccountingDocumentDeletion`, state PENDING)
 * and queues ONE accounting sync row through the ordinary enqueue, in the same transaction; the sync row travels the outbox and the Xero
 * processor renumbers the document (freeing its number) and then DELETES or VOIDS it. Only when the ledger has confirmed does
 * `completeAccountingDocumentDeletion` unwind IMS, in one transaction. So there is no state in which IMS says "deleted" while Xero still
 * holds a live document, and a held outbound write (the producer or writer hold) leaves IMS exactly as it was.
 *
 * WHAT IS UNWOUND, and it is exactly what the push recorded:
 *   sales invoice  the order's invoice link and number (invoiceNumber, invoicedAt, paymentDueAt, accountingInvoiceId and its connector), so the
 *                  order reads as not invoiced and the number is no longer held by it; the mirrored accounting events of the document are
 *                  voided; the stored copies of its PDF are withdrawn (kept, as statutory records are, but no longer the current invoice).
 *   supplier bill  the bill and its lines, the purchase order's invoiced marker when no other bill remains, a transit sub-ledger movement
 *                  that reverses the bill's net debit to Stock in Transit (the same signed-delta mechanism a bill edit uses), and the
 *                  document's mirrored accounting events are voided. A snapshot of the bill is kept on the deletion record.
 * An activity-log entry is written in the same transaction.
 */

import { markInvoiceBasisDeferralUnwindOwed } from '@/lib/domain/accounting/invoice-basis-deferral'
import { MAY_HAVE_REACHED_LEDGER_WHERE } from '@/lib/domain/accounting/ledger-standing'
import { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { queueAccountingSyncTxWithOutcome } from '@/lib/accounting'
import { getXeroSettings } from '@/lib/connectors/xero/settings'
import { newDeleteSuffixToken, releasedDocumentNumber } from '@/lib/connectors/xero/document-delete'
import { asRoutableAccountingConnector } from '@/lib/accounting/connector-provenance'
import { lockSalesOrder } from '@/lib/domain/sales/allocation-service'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { DOCUMENT_DELETED_VOID_BASIS } from '@/lib/domain/accounting/accounting-event-void-basis'
import { businessDay } from '@/lib/domain/accounting/daily-batch-event-date'
import {
  decideDocumentDelete,
  ledgerOwnershipVerdict,
  type DeletableDocumentKind,
  type DocumentDeleteFacts,
  type DocumentDeleteVerdict,
} from '@/lib/domain/accounting/document-delete-eligibility'
import type { InvoiceNumberLookup } from '@/lib/domain/accounting/invoice-number-ownership'

type Client = Prisma.TransactionClient

const SALES_OPEN_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE', 'INVOICE_PAYMENT', 'SALES_INVOICE_DELETE'] as const
const BILL_OPEN_TYPES = ['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE', 'BILL_PAYMENT', 'PURCHASE_INVOICE_DELETE'] as const
const OPEN_STATUSES = ['PENDING', 'PROCESSING'] as const

const SALES_EVENT_TYPES = ['SALES_INVOICE', 'SALES_INVOICE_UPDATE']
const BILL_EVENT_TYPES = ['PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE']

export const DOCUMENT_DELETE_SETTING_KEY = 'xero_document_delete_enabled'

export type DocumentDeleteCandidate = {
  kind: DeletableDocumentKind
  /** SalesOrder id, or PurchaseInvoice id. */
  documentId: string
  facts: DocumentDeleteFacts
  /** What the Xero payload and the deletion record need; null when the document has no ledger id or no readable identity. */
  document: {
    referenceType: 'SalesOrder' | 'PurchaseInvoice'
    referenceId: string
    purchaseOrderId: string | null
    number: string
    reference: string
    date: string
    orderLabel: string
    documentConnector: string | null
  } | null
}

function dayOf(value: Date | string | null | undefined): string | null {
  return businessDay(value)
}

/** Read every fact the decision needs. Reads only; no network. */
export async function loadDocumentDeleteCandidate(
  client: Pick<Client, 'salesOrder' | 'purchaseInvoice' | 'payment' | 'salesOrderRefund' | 'accountingSyncLog' | 'accountingDocumentDeletion'>,
  kind: DeletableDocumentKind,
  documentId: string,
  settings: { featureEnabled: boolean; lockDate: string | null },
): Promise<DocumentDeleteCandidate | null> {
  if (kind === 'SALES_INVOICE') {
    const order = await client.salesOrder.findUnique({
      where: { id: documentId },
      select: {
        id: true, orderNumber: true, externalOrderNumber: true, invoiceNumber: true, invoicedAt: true,
        accountingInvoiceId: true, accountingInvoiceConnector: true, paidAt: true,
      },
    })
    if (!order) return null
    const externalId = order.accountingInvoiceId
    const [payments, refunds, openRows, createRow, pending] = await Promise.all([
      client.payment.count({ where: { orderId: order.id } }),
      // soft-delete exception: a deleted refund still has a credit note in the ledger, so it keeps blocking an order delete.
      // soft-delete exception (ledger cascade): includes soft-deleted refunds on purpose, their credit-note and reversal rows are still in the ledger and must be netted.
      client.salesOrderRefund.count({ where: { orderId: order.id } }),
      client.accountingSyncLog.findMany({
        where: { referenceType: 'SalesOrder', referenceId: order.id, type: { in: [...SALES_OPEN_TYPES] }, status: { in: [...OPEN_STATUSES] } },
        select: { type: true },
      }),
      externalId
        ? client.accountingSyncLog.findFirst({
            where: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: order.id, status: 'SYNCED', externalTransactionId: externalId, settlementBasis: null },
            select: { id: true, payload: true },
          })
        : Promise.resolve(null),
      externalId ? client.accountingDocumentDeletion.findFirst({ where: { externalDocumentId: externalId, state: { in: ['PENDING', 'NEEDS_REVIEW'] } }, select: { id: true } }) : Promise.resolve(null),
    ])
    const payload = (createRow?.payload ?? {}) as Record<string, unknown>
    const date = dayOf(typeof payload.date === 'string' ? payload.date : order.invoicedAt)
    const number = order.invoiceNumber ?? ''
    const label = number ? `invoice ${number}` : `the invoice for order ${order.orderNumber}`
    return {
      kind,
      documentId: order.id,
      facts: {
        kind,
        featureEnabled: settings.featureEnabled,
        label,
        externalDocumentId: externalId,
        documentConnector: order.accountingInvoiceConnector,
        createdByIms: createRow !== null,
        deleteInProgress: pending !== null,
        // A recorded receipt, or an order held as paid (the paid flag is stamped from the ledger's PAID status as well as from receipts).
        paymentCount: payments + (order.paidAt && payments === 0 ? 1 : 0),
        creditNoteCount: refunds,
        documentDate: date,
        lockDate: settings.lockDate,
        openPostingTypes: openRows.map((row) => row.type),
      },
      document: externalId
        ? {
            referenceType: 'SalesOrder', referenceId: order.id, purchaseOrderId: null, number,
            reference: typeof payload.reference === 'string' ? payload.reference : '',
            date: date ?? '', orderLabel: `order ${order.orderNumber}`, documentConnector: order.accountingInvoiceConnector,
          }
        : null,
    }
  }

  const bill = await client.purchaseInvoice.findUnique({
    where: { id: documentId },
    select: {
      id: true, poId: true, invoiceNumber: true, invoiceDate: true, accountingInvoiceId: true, accountingInvoiceConnector: true,
      accountingInvoiceIdSource: true, paidAt: true, po: { select: { reference: true } },
      _count: { select: { supplierCreditNotes: true } },
    },
  })
  if (!bill) return null
  const externalId = bill.accountingInvoiceId
  const [openRows, paymentRows, createRow, pending] = await Promise.all([
    client.accountingSyncLog.findMany({
      where: {
        type: { in: [...BILL_OPEN_TYPES] }, status: { in: [...OPEN_STATUSES] },
        OR: [{ referenceType: 'PurchaseInvoice', referenceId: bill.id }, { referenceType: 'PurchaseOrder', referenceId: bill.poId, payload: { path: ['accountingInvoiceId'], equals: externalId ?? '' } }],
      },
      select: { type: true },
    }),
    externalId
      ? client.accountingSyncLog.count({ where: { type: 'BILL_PAYMENT', status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] }, referenceId: { in: [bill.id, bill.poId] } } })
      : Promise.resolve(0),
    externalId
      ? client.accountingSyncLog.findFirst({
          where: {
            type: 'PURCHASE_INVOICE', status: 'SYNCED', externalTransactionId: externalId, settlementBasis: null,
            OR: [{ referenceType: 'PurchaseInvoice', referenceId: bill.id }, { referenceType: 'PurchaseOrder', referenceId: bill.poId }],
          },
          select: { id: true, payload: true },
        })
      : Promise.resolve(null),
    externalId ? client.accountingDocumentDeletion.findFirst({ where: { externalDocumentId: externalId, state: { in: ['PENDING', 'NEEDS_REVIEW'] } }, select: { id: true } }) : Promise.resolve(null),
  ])
  const payload = (createRow?.payload ?? {}) as Record<string, unknown>
  const number = bill.invoiceNumber ?? ''
  const label = number ? `bill ${number}` : `the bill on purchase order ${bill.po.reference}`
  // The bill's link counts as IMS's own only when IMS's sync wrote it; a hand link or a repair guess does not prove IMS created the document.
  const linkedBySync = bill.accountingInvoiceIdSource === 'BILL_KEYED_SYNC' || bill.accountingInvoiceIdSource === 'PO_KEYED_REPAIR'
  return {
    kind,
    documentId: bill.id,
    facts: {
      kind,
      featureEnabled: settings.featureEnabled,
      label,
      externalDocumentId: externalId,
      documentConnector: bill.accountingInvoiceConnector,
      createdByIms: createRow !== null && linkedBySync,
      deleteInProgress: pending !== null,
      paymentCount: (bill.paidAt ? 1 : 0) + paymentRows,
      creditNoteCount: bill._count.supplierCreditNotes,
      documentDate: dayOf(bill.invoiceDate),
      lockDate: settings.lockDate,
      openPostingTypes: openRows.map((row) => row.type),
    },
    document: externalId
      ? {
          referenceType: 'PurchaseInvoice', referenceId: bill.id, purchaseOrderId: bill.poId, number,
          reference: typeof payload.reference === 'string' ? payload.reference : '',
          date: dayOf(bill.invoiceDate) ?? '', orderLabel: `PO ${bill.po.reference}`, documentConnector: bill.accountingInvoiceConnector,
        }
      : null,
  }
}

async function readDeleteSettings(): Promise<{ featureEnabled: boolean; lockDate: string | null }> {
  const settings = await getXeroSettings()
  return { featureEnabled: settings.xero_document_delete_enabled === 'true', lockDate: settings.xero_books_lock_date || null }
}

/** The verdict a page or an action asks for. Local facts only: it never calls the ledger. */
export async function documentDeleteEligibility(kind: DeletableDocumentKind, documentId: string): Promise<DocumentDeleteVerdict & { found: boolean }> {
  const candidate = await loadDocumentDeleteCandidate(db, kind, documentId, await readDeleteSettings())
  if (!candidate) return { found: false, eligible: false, code: 'NOT_PUSHED', reason: 'That document was not found.' }
  return { found: true, ...decideDocumentDelete(candidate.facts) }
}

/**
 * What a document page shows: nothing when the switch is off, the user may not edit the document, or the document never reached the ledger;
 * otherwise a Delete button (eligible) or the reason it is not offered. Local facts only.
 */
export type DocumentDeleteUiState =
  | { show: false }
  | { show: true; eligible: true; label: string }
  | { show: true; eligible: false; label: string; reason: string; /** Xero removed it but IMS stopped before unwinding: an operator can resume once the late activity is cleared. */ review?: true }

export async function documentDeleteUiStates(
  kind: DeletableDocumentKind,
  documentIds: readonly string[],
  mayEdit: boolean,
): Promise<Record<string, DocumentDeleteUiState>> {
  const out: Record<string, DocumentDeleteUiState> = {}
  if (!mayEdit || documentIds.length === 0) {
    for (const id of documentIds) out[id] = { show: false }
    return out
  }
  const settings = await readDeleteSettings()
  for (const id of documentIds) {
    if (!settings.featureEnabled) { out[id] = { show: false }; continue }
    const candidate = await loadDocumentDeleteCandidate(db, kind, id, settings)
    if (!candidate || !candidate.facts.externalDocumentId) { out[id] = { show: false }; continue }
    const review = await db.accountingDocumentDeletion.findFirst({ where: { documentId: id, state: 'NEEDS_REVIEW' }, select: { snapshot: true } })
    if (review) {
      const late = ((review.snapshot as { lateActivity?: string[] })?.lateActivity ?? []).join(', ')
      out[id] = { show: true, eligible: false, label: candidate.facts.label, review: true, reason: `Xero has already removed it, but IMS did not unwind it because ${late || 'activity'} was recorded against it after the delete was requested. Remove or move that activity, then resume.` }
      continue
    }
    const verdict = decideDocumentDelete(candidate.facts)
    out[id] = verdict.eligible
      ? { show: true, eligible: true, label: candidate.facts.label }
      : { show: true, eligible: false, label: candidate.facts.label, reason: verdict.reason }
  }
  return out
}

export type DocumentDeleteRequestResult =
  | { ok: true; deletionId: string; releasedNumber: string }
  | { ok: false; code: string; error: string; held?: boolean }

export type DocumentDeleteRequestDeps = {
  /** The ledger's answer to who holds an invoice number (sales invoices only). Injected so tests never touch the network. */
  lookupInvoiceNumber: (invoiceNumber: string) => Promise<InvoiceNumberLookup>
  /** The connector whose chart is active; the delete is a Xero write and refuses otherwise. */
  activeConnector: () => Promise<string | null>
  newToken?: () => string
}

function wording(kind: DeletableDocumentKind): string {
  return kind === 'SALES_INVOICE' ? 'invoice' : 'bill'
}

/**
 * Queue the delete. Refuses, with the operator's wording, anything the decision refuses; refuses a sales invoice the ledger does not show
 * IMS owns (invoice-number-ownership); and, when an outbound write hold records the enqueue as a shadow, reports that nothing was queued
 * and changes nothing.
 */
export async function requestAccountingDocumentDelete(
  params: { kind: DeletableDocumentKind; documentId: string; requestedById: string | null },
  deps: DocumentDeleteRequestDeps,
): Promise<DocumentDeleteRequestResult> {
  const settings = await readDeleteSettings()
  const candidate = await loadDocumentDeleteCandidate(db, params.kind, params.documentId, settings)
  if (!candidate) return { ok: false, code: 'NOT_FOUND', error: 'That document was not found.' }
  const verdict = decideDocumentDelete(candidate.facts)
  if (!verdict.eligible) return { ok: false, code: verdict.code, error: verdict.reason }
  const document = candidate.document
  if (!document || !candidate.facts.externalDocumentId) return { ok: false, code: 'NOT_PUSHED', error: 'The document has not been pushed to the accounting system.' }
  if ((await deps.activeConnector()) !== 'xero') {
    return { ok: false, code: 'NOT_XERO', error: 'Xero is not the active accounting connector, so IMS will not delete a document in it. Nothing was changed.' }
  }
  const externalId = candidate.facts.externalDocumentId

  // The ledger's half of ownership, for a sales invoice: the number must be held by exactly this document.
  if (params.kind === 'SALES_INVOICE') {
    if (document.number === '') return { ok: false, code: 'LEDGER_OWNERSHIP', error: 'The invoice has no number in IMS, so IMS cannot confirm it owns the document in Xero. Nothing was changed.' }
    const owned = ledgerOwnershipVerdict({
      invoiceNumber: document.number, ownedInvoiceId: externalId, orderLabel: document.orderLabel, lookup: await deps.lookupInvoiceNumber(document.number),
    })
    if (!owned.ok) return { ok: false, code: 'LEDGER_OWNERSHIP', error: owned.reason }
  }

  const token = (deps.newToken ?? newDeleteSuffixToken)()
  const releasedNumber = document.number ? releasedDocumentNumber(document.number, token) : ''
  const releasedReference = document.reference ? releasedDocumentNumber(document.reference, token) : ''
  const syncType = params.kind === 'SALES_INVOICE' ? 'SALES_INVOICE_DELETE' : 'PURCHASE_INVOICE_DELETE'
  const payload: Record<string, unknown> = {
    accountingInvoiceId: externalId,
    deletionDocumentKind: params.kind,
    invoiceNumber: document.number,
    releasedNumber,
    reference: document.reference,
    releasedReference,
    date: document.date,
  }

  return db.$transaction(async (tx): Promise<DocumentDeleteRequestResult> => {
    if (params.kind === 'SALES_INVOICE') await lockSalesOrder(tx, document.referenceId)
    else {
      // The purchase order FIRST, then the bill (o3d-668a2): the supplier return and the supplier credit note take the order and then reach the
      // bill, and they read the pending-delete fence under the order's lock; taking it here too serialises the request against them.
      if (document.purchaseOrderId) await tx.$queryRaw(Prisma.sql`SELECT id FROM purchase_orders WHERE id = ${document.purchaseOrderId} FOR UPDATE`)
      await tx.$queryRaw(Prisma.sql`SELECT id FROM purchase_invoices WHERE id = ${document.referenceId} FOR UPDATE`)
    }
    // Re-decided under the lock: a payment, a refund or another delete that committed since the read refuses this one.
    const locked = await loadDocumentDeleteCandidate(tx, params.kind, params.documentId, settings)
    if (!locked) return { ok: false, code: 'NOT_FOUND', error: 'That document was not found.' }
    const again = decideDocumentDelete(locked.facts)
    if (!again.eligible) return { ok: false, code: again.code, error: again.reason }
    if (locked.facts.externalDocumentId !== externalId) {
      return { ok: false, code: 'CHANGED', error: `The ${wording(params.kind)} was relinked while the request was being made. Nothing was changed; try again.` }
    }
    let outcome: Awaited<ReturnType<typeof queueAccountingSyncTxWithOutcome>>
    // One enqueue per operation the ownership map names (the producer census declares each site).
    if (params.kind === 'SALES_INVOICE') {
      outcome = await queueAccountingSyncTxWithOutcome(tx, {
        type: 'SALES_INVOICE_DELETE',
        referenceType: document.referenceType,
        referenceId: document.referenceId,
        payload,
        idempotencyKey: `document-delete:${externalId}`,
        chartConnector: 'xero',
        documentConnector: asRoutableAccountingConnector(document.documentConnector),
      })
    } else {
      outcome = await queueAccountingSyncTxWithOutcome(tx, {
        type: 'PURCHASE_INVOICE_DELETE',
        referenceType: document.referenceType,
        referenceId: document.referenceId,
        payload,
        idempotencyKey: `document-delete:${externalId}`,
        chartConnector: 'xero',
        documentConnector: asRoutableAccountingConnector(document.documentConnector),
      })
    }
    if (!outcome.queued) {
      if (outcome.reason === 'shadowed') {
        return {
          ok: false, code: 'HELD', held: true,
          error: `Writes to Xero are held for this document, so IMS did not queue the delete. Nothing was changed in IMS or in Xero.`,
        }
      }
      if (outcome.reason === 'not-configured') {
        return { ok: false, code: 'NOT_CONFIGURED', error: `Posting ${wording(params.kind)}s to Xero is switched off in Settings, so IMS did not queue the delete. Nothing was changed.` }
      }
      return { ok: false, code: 'REFUSED', error: `The accounting queue declined the delete (${outcome.reason ?? 'no reason given'}). Nothing was changed. Check the accounting activity log.` }
    }
    const deletion = await tx.accountingDocumentDeletion.create({
      data: {
        kind: params.kind,
        referenceType: document.referenceType,
        referenceId: document.referenceId,
        documentId: params.documentId,
        externalDocumentId: externalId,
        originalNumber: document.number,
        releasedNumber,
        requestedById: params.requestedById,
        snapshot: { requestedFor: document.orderLabel, number: document.number, date: document.date, token, purchaseOrderId: document.purchaseOrderId },
      },
      select: { id: true },
    })
    await logActivityInTransaction(tx, {
      userId: params.requestedById,
      entityType: params.kind === 'SALES_INVOICE' ? 'SALES_ORDER' : 'PURCHASE_ORDER',
      entityId: params.kind === 'SALES_INVOICE' ? document.referenceId : document.purchaseOrderId,
      action: 'accounting_document_delete_requested',
      tag: 'accounting',
      level: 'INFO',
      description: `Requested deletion of ${locked.facts.label} (${document.orderLabel}) in IMS and Xero. The number is freed first (${releasedNumber || 'no number'}), then the document is deleted or voided in Xero; IMS is updated when Xero confirms.`,
      metadata: { deletionId: deletion.id, accountingInvoiceId: externalId, originalNumber: document.number, releasedNumber },
    })
    return { ok: true, deletionId: deletion.id, releasedNumber }
  })
}

/**
 * A posting aimed at a document whose delete is queued or running is refused: the document is being renumbered and removed, so an edit sent to it
 * would land on a document that is going away. Returns the operator's sentence, or null when no delete is pending for it.
 */
export async function pendingDocumentDeletionRefusal(externalDocumentId: string, what: 'update'): Promise<string | null> {
  const pending = await db.accountingDocumentDeletion.findFirst({ where: { externalDocumentId, state: 'PENDING' }, select: { originalNumber: true } })
  if (!pending) return null
  return `This ${what} was not sent: ${pending.originalNumber ? `document ${pending.originalNumber}` : `document ${externalDocumentId}`} is being deleted in IMS and the ledger, so it will not be edited. Nothing was changed.`
}

/** The ledger-side status the processor reached, recorded on the deletion row. Idempotent. */
export async function recordDeletionTargetStatus(externalDocumentId: string, status: string): Promise<void> {
  await db.accountingDocumentDeletion.updateMany({ where: { externalDocumentId, targetStatus: null }, data: { targetStatus: status } })
}

export type DocumentDeleteCompletion = 'completed' | 'already-complete' | 'no-record' | 'needs-review'

/**
 * The ledger has deleted or voided the document: unwind IMS. Idempotent and keyed on the ledger's document id, so the follow-up retry that
 * re-runs it after a failure finds the work done and does nothing.
 */
export async function completeAccountingDocumentDeletion(externalDocumentId: string): Promise<DocumentDeleteCompletion> {
  return db.$transaction(async (tx): Promise<DocumentDeleteCompletion> => {
    // LOCK ORDER IS THE ORDER-FIRST CONVENTION every refund, payment, credit-note and bill-edit path follows: the sales order (or the purchase
    // order, then its bill) FIRST, the deletion row second. o3d-668a2: the purchase order BEFORE the bill, as the supplier return takes them (it
    // locks the order, then inserts a credit note whose foreign key share-locks the bill); bill-then-order here deadlocked against it. The late-activity count below is taken only once that lock is held, so an action that holds the
    // lock when completion arrives commits before the count (and is seen), and one that arrives later waits behind the unwind.
    const found = await tx.accountingDocumentDeletion.findUnique({ where: { externalDocumentId }, select: { id: true, kind: true, documentId: true, snapshot: true } })
    if (!found) return 'no-record'
    if (found.kind === 'SALES_INVOICE') {
      await lockSalesOrder(tx, found.documentId)
    } else {
      const poId = (found.snapshot as { purchaseOrderId?: string } | null)?.purchaseOrderId
        ?? (await tx.purchaseInvoice.findUnique({ where: { id: found.documentId }, select: { poId: true } }))?.poId
      if (poId) await tx.$queryRaw(Prisma.sql`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`)
      await tx.$queryRaw(Prisma.sql`SELECT id FROM purchase_invoices WHERE id = ${found.documentId} FOR UPDATE`)
    }
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM accounting_document_deletions WHERE id = ${found.id} FOR UPDATE`)
    if (rows.length === 0) return 'no-record'
    const deletion = await tx.accountingDocumentDeletion.findUniqueOrThrow({ where: { id: rows[0].id } })
    if (deletion.state === 'COMPLETED') return 'already-complete'
    // BLOCK FIRST, THEN RE-CHECK: the actions refuse new activity while the delete is pending (pendingDeletionError); this is the second half,
    // under the document's lock, for anything recorded between the request and now. Xero has already deleted or voided the document, so IMS
    // must not unwind over a payment, credit note or refund that now names it: it stops, says so, and waits for an operator.
    const late = await lateActivityOn(tx, deletion)
    if (late.length > 0) {
      await tx.accountingDocumentDeletion.update({
        where: { id: deletion.id },
        data: { state: 'NEEDS_REVIEW', snapshot: { ...(deletion.snapshot as Record<string, unknown>), lateActivity: late } as Prisma.InputJsonValue },
      })
      await logActivityInTransaction(tx, {
        userId: deletion.requestedById,
        entityType: deletion.kind === 'SALES_INVOICE' ? 'SALES_ORDER' : 'PURCHASE_ORDER',
        entityId: deletion.kind === 'SALES_INVOICE' ? deletion.referenceId : ((deletion.snapshot as { purchaseOrderId?: string })?.purchaseOrderId ?? null),
        action: 'accounting_document_delete_needs_review',
        tag: 'accounting',
        level: 'ERROR',
        description: `Xero has already ${deletion.targetStatus === 'VOIDED' ? 'voided' : 'deleted'} ${deletion.originalNumber || externalDocumentId}, but IMS recorded ${late.join(', ')} against it after the delete was requested, so IMS did NOT unwind it. The document is gone from Xero while IMS still holds it. Remove or move that activity in IMS, then use Resume on the document page; nothing else is changed until then.`,
        metadata: { deletionId: deletion.id, accountingInvoiceId: externalDocumentId, lateActivity: late },
      })
      return 'needs-review'
    }
    const unwound: Record<string, unknown> = {}
    if (deletion.kind === 'SALES_INVOICE') {
      await lockSalesOrder(tx, deletion.documentId)
      const order = await tx.salesOrder.findUnique({ where: { id: deletion.documentId }, select: { id: true, orderNumber: true, invoiceNumber: true, invoicedAt: true, paymentDueAt: true } })
      if (order) {
        // The CAS names the document: an order relinked to a replacement since is left alone.
        const cleared = await tx.salesOrder.updateMany({
          where: { id: order.id, accountingInvoiceId: externalDocumentId },
          data: { accountingInvoiceId: null, accountingInvoiceConnector: null, invoiceNumber: null, invoicedAt: null, paymentDueAt: null },
        })
        unwound.orderLinkCleared = cleared.count === 1
        unwound.invoiceNumberReleased = cleared.count === 1 ? order.invoiceNumber : null
        // Unpaid-invoice deferral: an order Group A1 deferred FROM this invoice (unpaid, switch on) has that deferral in
        // Unearned Revenue with nothing left to release it once the invoice is gone. The obligation to unwind it is
        // recorded HERE, in the transaction that unwinds the document, and the daily batch posts DR Unearned / CR Sales for
        // what is still open. A PAID-basis deferral is not touched (the refund and chargeback paths own it).
        unwound.deferralUnwindOwed = cleared.count === 1
          ? (await markInvoiceBasisDeferralUnwindOwed(tx, { orderIds: [order.id] }, 'INVOICE_DELETED')) === 1
          : false
        const withdrawn = await tx.salesOrderInvoiceDocument.updateMany({
          where: { orderId: order.id, externalDocumentId, withdrawnAt: null },
          data: { withdrawnAt: new Date() },
        })
        unwound.invoicePdfsWithdrawn = withdrawn.count
      }
      unwound.events = await voidDocumentEvents(tx, SALES_EVENT_TYPES, externalDocumentId, deletion.id)
    } else {
      const bill = await tx.purchaseInvoice.findUnique({
        where: { id: deletion.documentId },
        include: { lines: true },
      })
      if (bill && bill.accountingInvoiceId === externalDocumentId) {
        unwound.bill = {
          invoiceNumber: bill.invoiceNumber, invoiceDate: bill.invoiceDate, subtotalBase: bill.subtotalBase.toString(), totalForeign: bill.totalForeign.toString(),
          lines: bill.lines.map((line) => ({ poLineId: line.poLineId, costLineId: line.costLineId, qtyBilled: line.qtyBilled.toString(), totalForeign: line.totalForeign.toString() })),
        }
        // The bill DEBITED Stock in Transit by its net subtotal when it was pushed (and by each edit's delta since); the void takes that back.
        await recordTransitSubledgerMovement(tx, {
          sourceType: 'PURCHASE_BILL_UPDATE',
          sourceRef: bill.poId,
          idempotencyKey: `document-delete:${deletion.id}`,
          baseDelta: bill.subtotalBase.negated(),
          journalDate: bill.invoiceDate,
        })
        unwound.transitMovementBase = bill.subtotalBase.negated().toString()
        await tx.purchaseInvoiceLine.deleteMany({ where: { invoiceId: bill.id } })
        await tx.purchaseInvoice.delete({ where: { id: bill.id } })
        const remaining = await tx.purchaseInvoice.count({ where: { poId: bill.poId } })
        if (remaining === 0) await tx.purchaseOrder.update({ where: { id: bill.poId }, data: { invoicedAt: null } })
        unwound.billDeleted = true
        unwound.poInvoicedMarkerCleared = remaining === 0
      } else {
        unwound.billDeleted = false
      }
      unwound.events = await voidDocumentEvents(tx, BILL_EVENT_TYPES, externalDocumentId, deletion.id)
    }
    await tx.accountingDocumentDeletion.update({
      where: { id: deletion.id },
      data: { state: 'COMPLETED', completedAt: new Date(), snapshot: { ...(deletion.snapshot as Record<string, unknown>), unwound } as Prisma.InputJsonValue },
    })
    await logActivityInTransaction(tx, {
      userId: deletion.requestedById,
      entityType: deletion.kind === 'SALES_INVOICE' ? 'SALES_ORDER' : 'PURCHASE_ORDER',
      entityId: deletion.kind === 'SALES_INVOICE' ? deletion.referenceId : ((deletion.snapshot as { purchaseOrderId?: string })?.purchaseOrderId ?? null),
      action: 'accounting_document_deleted',
      tag: 'accounting',
      level: 'INFO',
      description: `Xero ${deletion.targetStatus === 'VOIDED' ? 'voided' : 'deleted'} ${deletion.originalNumber ? `document ${deletion.originalNumber}` : `document ${externalDocumentId}`}; IMS has released its number and unwound its own records for it.`,
      metadata: { deletionId: deletion.id, accountingInvoiceId: externalDocumentId, originalNumber: deletion.originalNumber, releasedNumber: deletion.releasedNumber, targetStatus: deletion.targetStatus, unwound },
    })
    return 'completed'
  })
}

/** What was recorded against the document after the delete was requested; empty when nothing was. Read under the document's lock. */
async function lateActivityOn(tx: Client, deletion: { kind: string; documentId: string; externalDocumentId: string; requestedAt: Date; snapshot?: unknown }): Promise<string[]> {
  const late: string[] = []
  // #1132 MED-4: an invoice or bill UPDATE queued after the request (the request itself refuses while one is open) is activity on the document
  // too: it was built for a document Xero has now removed. Every row that may have reached the ledger counts (MAY_HAVE_REACHED_LEDGER_WHERE:
  // all but a cancellation proven never sent).
  if (deletion.kind === 'SALES_INVOICE') {
    const [payments, refunds, order, updates] = await Promise.all([
      tx.payment.count({ where: { orderId: deletion.documentId } }),
      // soft-delete exception: as above, a deleted refund keeps blocking an order delete.
      // soft-delete exception (ledger cascade): includes soft-deleted refunds on purpose, their credit-note and reversal rows are still in the ledger and must be netted.
      tx.salesOrderRefund.count({ where: { orderId: deletion.documentId } }),
      tx.salesOrder.findUnique({ where: { id: deletion.documentId }, select: { paidAt: true } }),
      tx.accountingSyncLog.count({ where: { type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: deletion.documentId, createdAt: { gte: deletion.requestedAt }, ...MAY_HAVE_REACHED_LEDGER_WHERE } }),
    ])
    if (payments > 0) late.push(`${payments} payment(s)`)
    if (order?.paidAt && payments === 0) late.push('a paid flag')
    if (refunds > 0) late.push(`${refunds} refund(s) or credit note(s)`)
    if (updates > 0) late.push(`${updates} invoice update(s)`)
  } else {
    const poId = (deletion.snapshot as { purchaseOrderId?: string } | null | undefined)?.purchaseOrderId ?? null
    const [bill, credits, payments, updates] = await Promise.all([
      tx.purchaseInvoice.findUnique({ where: { id: deletion.documentId }, select: { paidAt: true, poId: true } }),
      tx.supplierCreditNote.count({ where: { purchaseInvoiceId: deletion.documentId } }),
      tx.accountingSyncLog.count({ where: { type: 'BILL_PAYMENT', status: { in: ['PENDING', 'PROCESSING', 'SYNCED'] }, referenceId: { in: [deletion.documentId] } } }),
      tx.accountingSyncLog.count({
        where: {
          type: 'PURCHASE_INVOICE_UPDATE', createdAt: { gte: deletion.requestedAt },
          AND: [MAY_HAVE_REACHED_LEDGER_WHERE, { OR: [{ referenceType: 'PurchaseInvoice', referenceId: deletion.documentId }, ...(poId ? [{ referenceType: 'PurchaseOrder', referenceId: poId, payload: { path: ['accountingInvoiceId'], equals: deletion.externalDocumentId } }] : [])] }],
        },
      }),
    ])
    if (bill?.paidAt) late.push('a payment')
    if (credits > 0) late.push(`${credits} supplier credit note(s)`)
    if (payments > 0) late.push(`${payments} bill payment posting(s)`)
    if (updates > 0) late.push(`${updates} bill update(s)`)
  }
  return late
}

/** An operator has cleared the late activity: re-run the unwind, which re-checks under the lock. */
export async function resumeAccountingDocumentDeletion(kind: DeletableDocumentKind, documentId: string): Promise<DocumentDeleteCompletion> {
  const row = await db.accountingDocumentDeletion.findFirst({ where: { kind, documentId, state: 'NEEDS_REVIEW' }, select: { externalDocumentId: true } })
  if (!row) return 'no-record'
  return completeAccountingDocumentDeletion(row.externalDocumentId)
}

/** VOID the mirrored events of the deleted document so reconciliation stops expecting it. Matched on the ledger id, which is never reused. */
async function voidDocumentEvents(tx: Client, types: string[], externalDocumentId: string, deletionId: string): Promise<number> {
  const events = await tx.accountingEvent.findMany({
    where: { type: { in: types }, externalId: externalDocumentId, status: 'POSTED' },
    select: { id: true, type: true },
  })
  if (events.length === 0) return 0
  await tx.accountingEvent.updateMany({
    where: { id: { in: events.map((event) => event.id) } },
    data: { status: 'VOID', externalId: null, voidBasis: DOCUMENT_DELETED_VOID_BASIS, postBasis: null },
  })
  await tx.accountingEventLog.createMany({
    data: events.map((event) => ({
      accountingEventId: event.id,
      action: 'voided_document_deleted',
      message: 'The document was deleted in IMS and the ledger together.',
      metadata: { syncType: event.type, deletionId, accountingInvoiceId: externalDocumentId } as Prisma.InputJsonValue,
    })),
  })
  return events.length
}
