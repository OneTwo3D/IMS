/**
 * Fetch, validate, store and record ONE customer invoice (or credit note) PDF from the ledger.
 *
 * READ SIDE ONLY. This writes IMS's own tables and files and nothing else: no ledger write, no
 * storefront write, and never `SalesOrder.accountingInvoiceId` (the document may be one IMS did not post,
 * and that column drives payment polling and updates). The storefront publication is a separate step.
 *
 * Properties the rest of the design leans on:
 *  - IDEMPOTENT. A version is keyed by (connector, ledger document id, sha256); fetching an unchanged
 *    document again creates nothing. A changed or re-issued document becomes a NEW row and the previous
 *    current one is marked superseded. Nothing is overwritten or deleted.
 *  - FAIL CLOSED. The document is selected only from an unambiguous ledger answer (see claim-selection.ts).
 *  - BOUNDED. A document the ledger does not hold yet is retried on a widening schedule; a missing one is
 *    escalated after a long time and an ambiguous one at once. Neither is retried by the sweep again until
 *    a person acts.
 *  - ONE FETCH PER DOCUMENT AT A TIME, by a transaction-scoped advisory lock on the document's subject.
 */

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { invoiceDocumentStoredPath, saveInvoiceDocumentFile, saveInvoicePdfFile } from '@/lib/invoice-pdf'
import { selectDocumentClaim, type DocumentClaim } from './claim-selection'
import { nextAttemptDelayMs, shouldEscalateMissing } from './backoff'
import { validateFetchedPdf } from './pdf-validate'

export type InvoiceDocumentKindName = 'INVOICE' | 'CREDIT_NOTE'

export const INVOICE_DOCUMENT_CONNECTOR = 'xero'

export type DocumentClaimsResult =
  | { ok: true; claims: DocumentClaim[] }
  | { ok: false; error: string; unaskable?: boolean }

export type DocumentDownloadResult = { ok: true; buffer: Buffer } | { ok: false; error: string; stop: boolean }

export type InvoiceDocumentDeps = {
  lookupInvoiceClaims: (invoiceNumber: string) => Promise<DocumentClaimsResult>
  lookupCreditNoteClaims: (creditNoteNumber: string) => Promise<DocumentClaimsResult>
  downloadPdf: (kind: InvoiceDocumentKindName, documentId: string) => Promise<DocumentDownloadResult>
  now: () => Date
}

export type EnsureInvoiceDocumentInput = {
  orderId: string
  kind: InvoiceDocumentKindName
  /** Required for a credit note: the refund it documents. */
  refundId?: string
  /** Ignore the per-document backoff (an operator asked). The ledger is still only asked once. */
  ignoreBackoff?: boolean
}

export type EnsureInvoiceDocumentOutcome =
  | { status: 'stored'; documentId: string; created: boolean }
  | { status: 'backoff'; nextAttemptAt: Date | null }
  | { status: 'waiting'; reason: string }
  | { status: 'needs-attention'; reason: string }
  | { status: 'not-applicable'; reason: string }
  | { status: 'failed'; reason: string; stop: boolean }

export function invoiceDocumentSubjectKey(orderId: string, kind: InvoiceDocumentKindName, refundId?: string | null): string {
  return `${orderId}:${kind}:${refundId ?? '-'}`
}

function lockKeyOf(subjectKey: string): number {
  // A stable 32-bit key from the subject, for pg_advisory_xact_lock(int4, int4).
  return createHash('sha256').update(subjectKey).digest().readInt32BE(0)
}
const LOCK_NAMESPACE = 0x1d0c // distinguishes these locks from other advisory-lock users

async function recordState(
  input: EnsureInvoiceDocumentInput,
  subjectKey: string,
  patch: { status: 'PENDING' | 'NEEDS_ATTENTION' | 'DONE'; error?: string | null; nextAttemptAt?: Date | null; attempted: boolean },
  now: Date,
): Promise<void> {
  await db.invoiceDocumentFetchState.upsert({
    where: { subjectKey },
    create: {
      subjectKey,
      orderId: input.orderId,
      refundId: input.refundId ?? null,
      kind: input.kind,
      status: patch.status,
      attempts: patch.attempted ? 1 : 0,
      lastAttemptAt: patch.attempted ? now : null,
      nextAttemptAt: patch.nextAttemptAt ?? null,
      lastError: patch.error ?? null,
    },
    update: {
      status: patch.status,
      ...(patch.attempted ? { attempts: { increment: 1 }, lastAttemptAt: now } : {}),
      nextAttemptAt: patch.nextAttemptAt ?? null,
      lastError: patch.error ?? null,
    },
  })
}

async function escalate(input: EnsureInvoiceDocumentInput, reason: string): Promise<void> {
  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: input.orderId,
    action: 'invoice_document_needs_attention',
    tag: 'accounting',
    level: 'WARNING',
    description: `The ${input.kind === 'INVOICE' ? 'invoice' : 'credit note'} PDF for this order was not fetched and needs a person: ${reason}`,
    metadata: { kind: input.kind, refundId: input.refundId ?? null, reason },
    resolveUser: false,
  }).catch(() => { /* logging must never change the outcome */ })
}

export async function ensureInvoiceDocument(
  input: EnsureInvoiceDocumentInput,
  deps: InvoiceDocumentDeps,
): Promise<EnsureInvoiceDocumentOutcome> {
  const now = deps.now()
  if (input.kind === 'CREDIT_NOTE' && !input.refundId) {
    return { status: 'not-applicable', reason: 'a credit note document needs the refund it documents' }
  }
  const subjectKey = invoiceDocumentSubjectKey(input.orderId, input.kind, input.refundId)

  const order = await db.salesOrder.findUnique({
    where: { id: input.orderId },
    select: { id: true, invoiceNumber: true },
  })
  if (!order) return { status: 'not-applicable', reason: 'the order does not exist' }

  let number: string | null
  if (input.kind === 'INVOICE') {
    number = order.invoiceNumber?.trim() || null
  } else {
    const refund = await db.salesOrderRefund.findUnique({
      where: { id: input.refundId! },
      select: { orderId: true, creditNoteNumber: true },
    })
    if (!refund || refund.orderId !== input.orderId) return { status: 'not-applicable', reason: 'the refund is not on this order' }
    number = refund.creditNoteNumber?.trim() || null
  }

  const state = await db.invoiceDocumentFetchState.findUnique({ where: { subjectKey } })
  if (state?.status === 'NEEDS_ATTENTION') {
    return { status: 'needs-attention', reason: state.lastError ?? 'needs attention' }
  }
  if (!input.ignoreBackoff && state?.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) {
    return { status: 'backoff', nextAttemptAt: state.nextAttemptAt }
  }
  const firstSeenAt = state?.createdAt ?? now
  const attemptsSoFar = (state?.attempts ?? 0) + 1
  const label = input.kind === 'INVOICE' ? `invoice ${number ?? '(no number)'}` : `credit note ${number ?? '(no number)'}`

  const retryLater = async (reason: string): Promise<EnsureInvoiceDocumentOutcome> => {
    await recordState(input, subjectKey, {
      status: 'PENDING',
      error: reason,
      nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attemptsSoFar)),
      attempted: true,
    }, now)
    return { status: 'waiting', reason }
  }
  const needsAttention = async (reason: string): Promise<EnsureInvoiceDocumentOutcome> => {
    await recordState(input, subjectKey, { status: 'NEEDS_ATTENTION', error: reason, attempted: true }, now)
    await escalate(input, reason)
    return { status: 'needs-attention', reason }
  }

  if (!number) {
    const reason = `${label}: the order carries no number for this document yet`
    return shouldEscalateMissing(firstSeenAt, now) ? needsAttention(reason) : retryLater(reason)
  }

  const lookup = input.kind === 'INVOICE' ? await deps.lookupInvoiceClaims(number) : await deps.lookupCreditNoteClaims(number)
  if (!lookup.ok) {
    const reason = `${label}: ${lookup.error}`
    // A number the ledger's filter cannot express will never come right by waiting.
    if (lookup.unaskable) return needsAttention(reason)
    await recordState(input, subjectKey, {
      status: 'PENDING',
      error: reason,
      nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attemptsSoFar)),
      attempted: true,
    }, now)
    return { status: 'failed', reason, stop: false }
  }

  const selection = selectDocumentClaim(lookup.claims, label)
  if (selection.outcome === 'attention') return needsAttention(selection.reason)
  if (selection.outcome === 'wait') {
    return shouldEscalateMissing(firstSeenAt, now) ? needsAttention(selection.reason) : retryLater(selection.reason)
  }
  const claim = selection.claim

  const download = await deps.downloadPdf(input.kind, claim.documentId)
  if (!download.ok) {
    const reason = `${label}: ${download.error}`
    await recordState(input, subjectKey, {
      status: 'PENDING',
      error: reason,
      nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attemptsSoFar)),
      attempted: true,
    }, now)
    return { status: 'failed', reason, stop: download.stop }
  }

  const validation = validateFetchedPdf(download.buffer)
  if (!validation.ok) {
    const reason = `${label}: ${validation.reason}`
    await recordState(input, subjectKey, {
      status: 'PENDING',
      error: reason,
      nextAttemptAt: new Date(now.getTime() + nextAttemptDelayMs(attemptsSoFar)),
      attempted: true,
    }, now)
    return { status: 'failed', reason, stop: false }
  }

  // The bytes go to disk BEFORE the row that points at them, content-addressed so a crash in between leaves
  // an unreferenced file that the next attempt reuses, never a row without its file.
  await saveInvoiceDocumentFile(input.orderId, validation.sha256, download.buffer)
  const storedPath = invoiceDocumentStoredPath(input.orderId, validation.sha256)

  const recorded = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, ${lockKeyOf(subjectKey)}::int4)`
    const existing = await tx.salesOrderInvoiceDocument.findUnique({
      where: {
        connector_externalDocumentId_sha256: {
          connector: INVOICE_DOCUMENT_CONNECTOR,
          externalDocumentId: claim.documentId,
          sha256: validation.sha256,
        },
      },
      select: { id: true, supersededAt: true, orderId: true },
    })
    if (existing && existing.orderId !== input.orderId) {
      // The same ledger document and bytes already belong to ANOTHER order: one document, one order.
      return { kind: 'conflict' as const, reason: `${label}: this ledger document is already recorded against a different order` }
    }
    let documentId: string
    let created = false
    if (existing) {
      documentId = existing.id
      if (existing.supersededAt) {
        // The ledger reverted to bytes seen before: that version is current again.
        await tx.salesOrderInvoiceDocument.updateMany({
          where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
          data: { supersededAt: now },
        })
        await tx.salesOrderInvoiceDocument.update({ where: { id: existing.id }, data: { supersededAt: null } })
      }
    } else {
      await tx.salesOrderInvoiceDocument.updateMany({
        where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
        data: { supersededAt: now },
      })
      const row = await tx.salesOrderInvoiceDocument.create({
        data: {
          orderId: input.orderId,
          refundId: input.refundId ?? null,
          kind: input.kind,
          connector: INVOICE_DOCUMENT_CONNECTOR,
          externalDocumentId: claim.documentId,
          documentNumber: claim.documentNumber,
          externalStatus: claim.status.toUpperCase(),
          sha256: validation.sha256,
          byteSize: validation.byteSize,
          storedPath,
          fetchedAt: now,
        },
        select: { id: true },
      })
      documentId = row.id
      created = true
    }
    return { kind: 'stored' as const, documentId, created }
  })

  if (recorded.kind === 'conflict') return needsAttention(recorded.reason)

  if (input.kind === 'INVOICE') {
    // The pointer the existing customer and staff download routes and the invoice e-mail read. It is the
    // order's CURRENT invoice, overwritten in place; the versioned record above is the permanent one.
    const flatPath = await saveInvoicePdfFile(input.orderId, download.buffer)
    await db.salesOrder.update({ where: { id: input.orderId }, data: { invoicePdfPath: flatPath } })
  }

  await recordState(input, subjectKey, { status: 'DONE', error: null, nextAttemptAt: null, attempted: true }, now)
  if (recorded.created) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: 'invoice_document_fetched',
      tag: 'accounting',
      level: 'INFO',
      description: `Stored the ${input.kind === 'INVOICE' ? 'invoice' : 'credit note'} PDF for ${label} from the ledger`,
      metadata: { kind: input.kind, refundId: input.refundId ?? null, externalDocumentId: claim.documentId, sha256: validation.sha256, byteSize: validation.byteSize },
      resolveUser: false,
    }).catch(() => { /* logging must never change the outcome */ })
  }
  return { status: 'stored', documentId: recorded.documentId, created: recorded.created }
}
