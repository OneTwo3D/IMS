/**
 * Fetch, validate, store and record ONE customer invoice (or credit note) PDF from the ledger.
 *
 * READ SIDE ONLY. This writes IMS's own tables and files and nothing else: no ledger write, no
 * storefront write, and never `SalesOrder.accountingInvoiceId` (the document may be one IMS did not post,
 * and that column drives payment polling and updates). The storefront publication is a separate step.
 *
 * Properties the rest of the design leans on:
 *  - THE DOCUMENT IS THIS ORDER'S, not merely the holder of a number. The storefront's invoice number is not unique in IMS
 *    and the ledger's filter answers for whatever holds the number, so a document is stored only when (a) no other IMS order
 *    carries the same number and (b) the ledger's own record of it agrees with the order on independent keys (total and
 *    currency, plus reference / customer / date): see order-evidence.ts. Anything else needs a person and stores nothing.
 *  - ONE FETCH PER DOCUMENT AT A TIME. A lease on the document's fetch state is taken BEFORE the ledger is read and held through
 *    lookup, download, version promotion and the `invoicePdfPath` pointer, so two overlapping fetches run one after the other and
 *    the later one reads the ledger as it then is: an older PDF cannot be promoted over a newer one.
 *  - IDEMPOTENT. A version is keyed by (connector, ledger document id, sha256); fetching an unchanged
 *    document again creates nothing. A changed or re-issued document becomes a NEW row and the previous
 *    current one is marked superseded. Nothing is overwritten or deleted.
 *  - RECHECKED. The ledger can amend or re-issue a document after IMS stored it, so a stored document is looked at again after
 *    1 day, 7 days and then every 30 days (the fetch state's next time), and a changed one is promoted by the rule above.
 *  - FAIL CLOSED. The document is selected only from an unambiguous ledger answer (see claim-selection.ts), and a voided
 *    document is the customer's only on a cancelled order.
 *  - BOUNDED. A document the ledger does not hold yet is retried on a widening schedule; a missing one is
 *    escalated after a long time and an ambiguous one at once. Neither is retried by the sweep again until
 *    a person acts.
 */

import { createHash, randomUUID } from 'node:crypto'

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { invoiceDocumentStoredPath, saveInvoiceDocumentFile, saveInvoicePdfFile } from '@/lib/invoice-pdf'
import { selectDocumentClaim, type DocumentClaim } from './claim-selection'
import { assessDocumentEvidence, type EvidenceSubject } from './order-evidence'
import { nextAttemptDelayMs, recheckDelayMs, shouldEscalateMissing } from './backoff'
import { validateFetchedPdf } from './pdf-validate'

export type InvoiceDocumentKindName = 'INVOICE' | 'CREDIT_NOTE'

export const INVOICE_DOCUMENT_CONNECTOR = 'xero'

/**
 * How long one fetch may hold a document before another may take it over (a crashed or stalled holder). The holder RENEWS it between
 * its steps (after the lookup, after the download, and as the first statement of the promotion), so this only has to cover the
 * longest single ledger step, retries included, with margin.
 */
export const INVOICE_DOCUMENT_LEASE_MS = 10 * 60_000

export type DocumentClaimsResult =
  | { ok: true; claims: DocumentClaim[] }
  | { ok: false; error: string; unaskable?: boolean; /** The ledger refused or is rate-limited: the sweep stops. */ stop?: boolean }

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
  /** Another fetch of this document is running right now. */
  | { status: 'busy' }
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

type StatePatch = {
  status: 'PENDING' | 'NEEDS_ATTENTION' | 'DONE'
  error?: string | null
  nextAttemptAt?: Date | null
  attempted: boolean
  /** Set only by a stored result: the number of completed rechecks. */
  rechecks?: number
}

/** A fetch that no longer holds its lease writes NOTHING. */
class LeaseLost extends Error {
  constructor() {
    super('the document lease was taken over by another fetch')
  }
}

/**
 * Write the fetch state, but only as the CURRENT lease holder: the compare-and-set is on the holder token, so a fetch whose lease was
 * taken over (it stalled past the expiry) cannot overwrite the new holder's state.
 */
async function recordState(input: EnsureInvoiceDocumentInput, subjectKey: string, token: string, patch: StatePatch, now: Date): Promise<void> {
  const updated = await db.invoiceDocumentFetchState.updateMany({
    where: { subjectKey, leaseHolder: token },
    data: {
      status: patch.status,
      ...(patch.attempted ? { attempts: { increment: 1 }, lastAttemptAt: now } : {}),
      nextAttemptAt: patch.nextAttemptAt ?? null,
      lastError: patch.error ?? null,
      ...(patch.rechecks !== undefined ? { rechecks: patch.rechecks } : {}),
    },
  })
  if (updated.count === 0) throw new LeaseLost()
}

/** Extend the lease, as its holder. False when it was taken over: the caller must stop and write nothing. */
async function renewLease(subjectKey: string, token: string, now: Date): Promise<boolean> {
  const renewed = await db.invoiceDocumentFetchState.updateMany({
    where: { subjectKey, leaseHolder: token },
    data: { leaseUntil: new Date(now.getTime() + INVOICE_DOCUMENT_LEASE_MS) },
  })
  return renewed.count > 0
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

  // THE LEASE, BEFORE THE LEDGER IS READ. The state row is the lock: created if missing, then taken by an atomic compare-and-set on its
  // expiry that also writes a holder token unique to this fetch. Everything below (lookup, download, promotion, pointer) happens under it,
  // renews it between steps, and requires the token for every write and for the release.
  await db.invoiceDocumentFetchState.upsert({
    where: { subjectKey },
    create: { subjectKey, orderId: input.orderId, refundId: input.refundId ?? null, kind: input.kind },
    update: {},
  }).catch(() => { /* a concurrent creator won: the row exists */ })
  const token = randomUUID()
  const leased = await db.invoiceDocumentFetchState.updateMany({
    where: { subjectKey, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + INVOICE_DOCUMENT_LEASE_MS), leaseHolder: token },
  })
  if (leased.count === 0) return { status: 'busy' }
  try {
    return await ensureUnderLease(input, deps, subjectKey, token, now)
  } catch (error) {
    // A fetch that lost its lease aborts without having written anything after the loss.
    if (error instanceof LeaseLost) return { status: 'busy' }
    throw error
  } finally {
    // Release only OUR lease: if it was taken over, the new holder's lease is not ours to clear.
    await db.invoiceDocumentFetchState.updateMany({ where: { subjectKey, leaseHolder: token }, data: { leaseUntil: null, leaseHolder: null } }).catch(() => { /* an expired lease is taken over */ })
  }
}

async function ensureUnderLease(
  input: EnsureInvoiceDocumentInput,
  deps: InvoiceDocumentDeps,
  subjectKey: string,
  token: string,
  now: Date,
): Promise<EnsureInvoiceDocumentOutcome> {
  const order = await db.salesOrder.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      orderNumber: true,
      externalOrderNumber: true,
      customerName: true,
      currency: true,
      totalForeign: true,
      createdAt: true,
    },
  })
  if (!order) return { status: 'not-applicable', reason: 'the order does not exist' }

  let number: string | null
  let sharedByOthers = 0
  let evidenceSubject: EvidenceSubject
  const orderNumbers = [order.externalOrderNumber, order.orderNumber].flatMap((value) => (value ? [value] : []))
  if (input.kind === 'INVOICE') {
    number = order.invoiceNumber?.trim() || null
    if (number) {
      sharedByOthers = await db.salesOrder.count({ where: { id: { not: order.id }, invoiceNumber: { equals: number, mode: 'insensitive' } } })
    }
    evidenceSubject = {
      orderNumbers,
      customerName: order.customerName ?? null,
      currency: order.currency,
      expectedTotal: Number(order.totalForeign),
      anchorDate: order.createdAt,
      dateToleranceDays: 14,
    }
  } else {
    const refund = await db.salesOrderRefund.findUnique({
      where: { id: input.refundId! },
      select: { orderId: true, creditNoteNumber: true, createdAt: true },
    })
    if (!refund || refund.orderId !== input.orderId) return { status: 'not-applicable', reason: 'the refund is not on this order' }
    number = refund.creditNoteNumber?.trim() || null
    if (number) {
      sharedByOthers = await db.salesOrderRefund.count({ where: { id: { not: input.refundId! }, creditNoteNumber: { equals: number, mode: 'insensitive' } } })
    }
    evidenceSubject = {
      orderNumbers,
      customerName: order.customerName ?? null,
      currency: order.currency,
      // A refund stores NET amounts, so there is no gross total to compare: currency plus customer or reference decide.
      expectedTotal: null,
      anchorDate: refund.createdAt,
      dateToleranceDays: 30,
    }
  }

  const state = await db.invoiceDocumentFetchState.findUnique({ where: { subjectKey } })
  if (state?.status === 'NEEDS_ATTENTION') {
    return { status: 'needs-attention', reason: state.lastError ?? 'needs attention' }
  }
  if (!input.ignoreBackoff && state?.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) {
    return { status: 'backoff', nextAttemptAt: state.nextAttemptAt }
  }
  const existingCurrent = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
    select: { id: true },
  })
  // A document already stored is being RECHECKED: a failure or a wait leaves it in place and never escalates a "missing" document.
  const isRecheck = existingCurrent !== null
  const firstSeenAt = state?.createdAt ?? now
  const attemptsSoFar = (state?.attempts ?? 0) + 1
  const rechecksDone = isRecheck && state?.status === 'DONE' ? state.rechecks + 1 : (state?.rechecks ?? 0)
  const label = input.kind === 'INVOICE' ? `invoice ${number ?? '(no number)'}` : `credit note ${number ?? '(no number)'}`

  const defer = async (reason: string, outcome: 'waiting' | 'failed', stop = false): Promise<EnsureInvoiceDocumentOutcome> => {
    await recordState(input, subjectKey, token, {
      status: isRecheck ? 'DONE' : 'PENDING',
      error: reason,
      nextAttemptAt: new Date(now.getTime() + (isRecheck ? recheckDelayMs(rechecksDone) : nextAttemptDelayMs(attemptsSoFar))),
      attempted: true,
    }, now)
    return outcome === 'waiting' ? { status: 'waiting', reason } : { status: 'failed', reason, stop }
  }
  const needsAttention = async (reason: string): Promise<EnsureInvoiceDocumentOutcome> => {
    await recordState(input, subjectKey, token, { status: 'NEEDS_ATTENTION', error: reason, attempted: true }, now)
    await escalate(input, reason)
    return { status: 'needs-attention', reason }
  }
  const missing = (reason: string) => (!isRecheck && shouldEscalateMissing(firstSeenAt, now) ? needsAttention(reason) : defer(reason, 'waiting'))

  if (!number) return missing(`${label}: the order carries no number for this document yet`)
  if (sharedByOthers > 0) {
    return needsAttention(`${label}: ${sharedByOthers} other IMS ${input.kind === 'INVOICE' ? 'order(s) carry' : 'refund(s) carry'} the same number, so the ledger document cannot be tied to this one`)
  }

  const lookup = input.kind === 'INVOICE' ? await deps.lookupInvoiceClaims(number) : await deps.lookupCreditNoteClaims(number)
  if (!(await renewLease(subjectKey, token, deps.now()))) throw new LeaseLost()
  if (!lookup.ok) {
    const reason = `${label}: ${lookup.error}`
    // A number the ledger's filter cannot express will never come right by waiting.
    if (lookup.unaskable) return needsAttention(reason)
    return defer(reason, 'failed', lookup.stop === true)
  }

  const selection = selectDocumentClaim(lookup.claims, label, { orderCancelled: order.status === 'CANCELLED' })
  if (selection.outcome === 'attention') return needsAttention(selection.reason)
  if (selection.outcome === 'wait') return missing(selection.reason)
  const claim = selection.claim

  const evidence = assessDocumentEvidence(evidenceSubject, claim)
  if (!evidence.ok) return needsAttention(`${label}: ${evidence.reason}`)

  const download = await deps.downloadPdf(input.kind, claim.documentId)
  if (!(await renewLease(subjectKey, token, deps.now()))) throw new LeaseLost()
  if (!download.ok) return defer(`${label}: ${download.error}`, 'failed', download.stop)

  const validation = validateFetchedPdf(download.buffer)
  if (!validation.ok) return defer(`${label}: ${validation.reason}`, 'failed')

  // The bytes go to disk BEFORE the row that points at them, content-addressed so a crash in between leaves
  // an unreferenced file that the next attempt reuses, never a row without its file.
  await saveInvoiceDocumentFile(input.orderId, validation.sha256, download.buffer)
  const storedPath = invoiceDocumentStoredPath(input.orderId, validation.sha256)

  const recorded = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int4, ${lockKeyOf(subjectKey)}::int4)`
    // THE PROMOTION REQUIRES THE LEASE: the first statement renews it as its holder, and a fetch that was taken over writes nothing.
    const stillHeld = await tx.invoiceDocumentFetchState.updateMany({
      where: { subjectKey, leaseHolder: token },
      data: { leaseUntil: new Date(deps.now().getTime() + INVOICE_DOCUMENT_LEASE_MS) },
    })
    if (stillHeld.count === 0) return { kind: 'lost' as const }
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
          data: { supersededAt: deps.now() },
        })
        await tx.salesOrderInvoiceDocument.update({ where: { id: existing.id }, data: { supersededAt: null } })
      }
    } else {
      await tx.salesOrderInvoiceDocument.updateMany({
        where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
        data: { supersededAt: deps.now() },
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
          fetchedAt: deps.now(),
        },
        select: { id: true },
      })
      documentId = row.id
      created = true
    }
    return { kind: 'stored' as const, documentId, created }
  })

  if (recorded.kind === 'lost') throw new LeaseLost()
  if (recorded.kind === 'conflict') return needsAttention(recorded.reason)

  if (input.kind === 'INVOICE') {
    // The pointer the existing customer and staff download routes and the invoice e-mail read. It is the
    // order's CURRENT invoice, overwritten in place; the versioned record above is the permanent one. The lease was
    // renewed by the promotion a moment ago; renew and check once more so a takeover in between writes nothing.
    if (!(await renewLease(subjectKey, token, deps.now()))) throw new LeaseLost()
    const flatPath = await saveInvoicePdfFile(input.orderId, download.buffer)
    await db.salesOrder.update({ where: { id: input.orderId }, data: { invoicePdfPath: flatPath } })
  }

  await recordState(input, subjectKey, token, {
    status: 'DONE',
    error: null,
    // When this stored document is looked at again.
    nextAttemptAt: new Date(now.getTime() + recheckDelayMs(rechecksDone)),
    attempted: true,
    rechecks: rechecksDone,
  }, now)
  if (recorded.created) {
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action: isRecheck ? 'invoice_document_amended' : 'invoice_document_fetched',
      tag: 'accounting',
      level: 'INFO',
      description: isRecheck
        ? `The ledger amended the ${input.kind === 'INVOICE' ? 'invoice' : 'credit note'} for ${label}: stored the new version and kept the previous one`
        : `Stored the ${input.kind === 'INVOICE' ? 'invoice' : 'credit note'} PDF for ${label} from the ledger`,
      metadata: { kind: input.kind, refundId: input.refundId ?? null, externalDocumentId: claim.documentId, sha256: validation.sha256, byteSize: validation.byteSize, evidence: evidence.matched },
      resolveUser: false,
    }).catch(() => { /* logging must never change the outcome */ })
  }
  return { status: 'stored', documentId: recorded.documentId, created: recorded.created }
}
