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
 *  - NOTHING IS PUBLISHED THROUGH A MUTABLE FILE. A version's bytes live in an immutable, hash-named file and only the DATABASE decides which
 *    one is current: promotion (set the new row current, supersede the previous, point `invoicePdfPath` at it) is ONE transaction whose first
 *    statement is the lease check, so an expired holder cannot publish and its bytes are never served. Readers resolve the current row
 *    (current-document.ts) and stream that file.
 *  - ONE FETCH PER DOCUMENT AT A TIME. A lease on the document's fetch state is taken BEFORE the ledger is read and held through
 *    lookup, download and version promotion, so two overlapping fetches run one after the other and
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
import { invoiceDocumentStoredPath, saveInvoiceDocumentFile } from '@/lib/invoice-pdf'
import { ownershipFingerprintsMatch, selectDocumentClaim, type DocumentClaim } from './claim-selection'
import type { RequiredXeroConnection } from '@/lib/connectors/xero/api'
import { assessDocumentEvidence, expectedInvoiceGross, type EvidenceSubject } from './order-evidence'
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
  | { ok: true; claims: DocumentClaim[]; /** The organisation and connection that answered: the download must be built from the same. */ connection?: RequiredXeroConnection }
  | { ok: false; error: string; unaskable?: boolean; /** The ledger refused or is rate-limited: the sweep stops. */ stop?: boolean }

export type DocumentDownloadResult = { ok: true; buffer: Buffer } | { ok: false; error: string; stop: boolean }

export type InvoiceDocumentDeps = {
  lookupInvoiceClaims: (invoiceNumber: string) => Promise<DocumentClaimsResult>
  lookupCreditNoteClaims: (creditNoteNumber: string) => Promise<DocumentClaimsResult>
  downloadPdf: (kind: InvoiceDocumentKindName, documentId: string, connection?: RequiredXeroConnection) => Promise<DocumentDownloadResult>
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

type OrderEvidenceRow = {
  status: string
  invoiceNumber: string | null
  orderNumber: string | null
  externalOrderNumber: string | null
  customerName: string | null
  currency: string
  totalForeign: unknown
  storeCreditForeign: unknown
  storeCreditAssessment: unknown
}

/**
 * Everything the ownership check and the expected gross were computed from, as one comparable string. The importer can correct an
 * order's invoice number (while no ledger invoice is linked), its credit or its customer while a fetch is in flight, so promotion
 * re-reads these under the order row lock and refuses to publish a document judged against values that have since moved.
 */
function orderEvidenceKey(order: OrderEvidenceRow, creditNoteNumber: string | null): string {
  return JSON.stringify([
    order.status === 'CANCELLED',
    (order.invoiceNumber ?? '').trim().toLowerCase(),
    creditNoteNumber === null ? null : creditNoteNumber.trim().toLowerCase(),
    order.orderNumber,
    order.externalOrderNumber,
    order.customerName,
    order.currency,
    String(order.totalForeign),
    String(order.storeCreditForeign),
    order.storeCreditAssessment ?? null,
  ])
}

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

/**
 * A PERSON'S REVIEW of a document that needs attention (an ambiguous or conflicting ledger answer): puts it back to be looked at on the next
 * pass. Nothing is un-withdrawn here: a withdrawn document is served again only if the next fetch validates it, or a replacement is promoted.
 */
export async function releaseInvoiceDocumentForReview(subject: { orderId: string; kind: InvoiceDocumentKindName; refundId?: string }): Promise<boolean> {
  const released = await db.invoiceDocumentFetchState.updateMany({
    where: { subjectKey: invoiceDocumentSubjectKey(subject.orderId, subject.kind, subject.refundId), status: 'NEEDS_ATTENTION' },
    data: { status: 'PENDING', nextAttemptAt: null, lastError: null },
  })
  return released.count > 0
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
      storeCreditForeign: true,
      storeCreditAssessment: true,
      createdAt: true,
    },
  })
  if (!order) return { status: 'not-applicable', reason: 'the order does not exist' }

  let number: string | null
  let sharedByOthers = 0
  let evidenceSubject: EvidenceSubject
  let grossUnderivable: string | null = null
  let snapshotCreditNote: string | null = null
  const orderNumbers = [order.externalOrderNumber, order.orderNumber].flatMap((value) => (value ? [value] : []))
  if (input.kind === 'INVOICE') {
    number = order.invoiceNumber?.trim() || null
    if (number) {
      sharedByOthers = await db.salesOrder.count({ where: { id: { not: order.id }, invoiceNumber: { equals: number, mode: 'insensitive' } } })
    }
    const gross = expectedInvoiceGross(order)
    if (!gross.ok) grossUnderivable = gross.reason
    evidenceSubject = {
      orderNumbers,
      customerName: order.customerName ?? null,
      currency: order.currency,
      expectedTotal: gross.ok ? gross.total : null,
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
    snapshotCreditNote = refund.creditNoteNumber ?? ''
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

  const evidenceKeyAtStart = orderEvidenceKey(order, snapshotCreditNote)
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
  // Stop showing the stored document to the customer: bytes and history stay, the lease is checked in the same transaction, staff can still
  // open it (labelled). Used only for a POSITIVE finding about a stored document (voided on a live order, or an ownership conflict).
  const withdrawStored = async (action: string, description: string): Promise<void> => {
    const withdrawn = await db.$transaction(async (tx) => {
      const held = await tx.invoiceDocumentFetchState.updateMany({ where: { subjectKey, leaseHolder: token }, data: { leaseUntil: new Date(deps.now().getTime() + INVOICE_DOCUMENT_LEASE_MS) } })
      if (held.count === 0) return false
      await tx.salesOrderInvoiceDocument.updateMany({
        where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null, withdrawnAt: null },
        data: { withdrawnAt: deps.now() },
      })
      return true
    })
    if (!withdrawn) throw new LeaseLost()
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: input.orderId,
      action,
      tag: 'accounting',
      level: 'WARNING',
      description,
      metadata: { kind: input.kind, refundId: input.refundId ?? null },
      resolveUser: false,
    }).catch(() => { /* logging must never change the outcome */ })
  }
  /** A positive ownership finding on a stored document: withdraw it from the customer, then ask for a person. */
  const conflictNeedsAttention = async (reason: string): Promise<EnsureInvoiceDocumentOutcome> => {
    if (isRecheck) await withdrawStored('invoice_document_withdrawn', `The ${input.kind === 'INVOICE' ? 'invoice' : 'credit note'} stored for this order no longer matches it in the ledger and is no longer shown to the customer: ${reason}`)
    return needsAttention(reason)
  }
  const missing = (reason: string) => (!isRecheck && shouldEscalateMissing(firstSeenAt, now) ? needsAttention(reason) : defer(reason, 'waiting'))

  if (!number) return missing(`${label}: the order carries no number for this document yet`)
  if (sharedByOthers > 0) {
    return conflictNeedsAttention(`${label}: ${sharedByOthers} other IMS ${input.kind === 'INVOICE' ? 'order(s) carry' : 'refund(s) carry'} the same number, so the ledger document cannot be tied to this one`)
  }

  if (grossUnderivable) return needsAttention(`${label}: ${grossUnderivable}`)

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
  if (selection.outcome === 'wait') {
    if (selection.voidedOnActiveOrder && isRecheck) {
      await withdrawStored('invoice_document_withdrawn', `The ledger voided ${label} on an order that is not cancelled: the stored PDF is no longer shown to the customer until a replacement is issued`)
    }
    return missing(selection.reason)
  }
  const claim = selection.claim

  const evidence = assessDocumentEvidence(evidenceSubject, claim)
  if (!evidence.ok) return evidence.conflict ? conflictNeedsAttention(`${label}: ${evidence.reason}`) : needsAttention(`${label}: ${evidence.reason}`)

  // The download is built from the connection that answered the lookup (a change refuses it before it is sent)...
  const download = await deps.downloadPdf(input.kind, claim.documentId, lookup.connection)
  if (!(await renewLease(subjectKey, token, deps.now()))) throw new LeaseLost()
  if (!download.ok) return defer(`${label}: ${download.error}`, 'failed', download.stop)

  // ...and the document is read AGAIN: ownership was judged on the lookup, the bytes came from a separate request, and the ledger can
  // change a document (or the connection can move to another organisation) in between. The re-read must name the same connection and
  // the same document with the same status, total, currency, customer, reference, date and last-modified stamp, and must pass
  // selection and the order evidence again; otherwise the bytes are discarded and the next pass starts again.
  const recheck = input.kind === 'INVOICE' ? await deps.lookupInvoiceClaims(number) : await deps.lookupCreditNoteClaims(number)
  if (!(await renewLease(subjectKey, token, deps.now()))) throw new LeaseLost()
  if (!recheck.ok) return defer(`${label}: the document could not be re-read after the download, so its bytes are discarded: ${recheck.error}`, 'failed', recheck.stop === true)
  if (lookup.connection && (recheck.connection?.tenantId !== lookup.connection.tenantId || (recheck.connection?.connectionGeneration ?? null) !== lookup.connection.connectionGeneration)) {
    return defer(`${label}: the Xero connection changed between the lookup and the re-read, so the downloaded bytes are discarded`, 'failed')
  }
  const reselected = selectDocumentClaim(recheck.claims, label, { orderCancelled: order.status === 'CANCELLED' })
  if (reselected.outcome !== 'select' || !ownershipFingerprintsMatch(claim, reselected.claim) || !assessDocumentEvidence(evidenceSubject, reselected.claim).ok) {
    return defer(`${label}: the ledger document changed between the lookup and the download, so the downloaded bytes are discarded`, 'failed')
  }

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
    // THE ORDER IS PINNED WHILE IT IS RE-READ: a share lock on its row keeps the importer from correcting the invoice number (or the credit,
    // or the customer) between this read and the commit. If any of what the document was judged against has moved, nothing is published.
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${input.orderId} FOR SHARE`
    const nowOrder = await tx.salesOrder.findUnique({
      where: { id: input.orderId },
      select: { status: true, invoiceNumber: true, orderNumber: true, externalOrderNumber: true, customerName: true, currency: true, totalForeign: true, storeCreditForeign: true, storeCreditAssessment: true },
    })
    let nowCreditNote: string | null = null
    if (input.kind === 'CREDIT_NOTE') {
      nowCreditNote = (await tx.salesOrderRefund.findUnique({ where: { id: input.refundId! }, select: { creditNoteNumber: true } }))?.creditNoteNumber ?? ''
    }
    if (!nowOrder || orderEvidenceKey(nowOrder, nowCreditNote) !== evidenceKeyAtStart) return { kind: 'order-changed' as const }
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
      if (!existing.supersededAt) {
        // Already the current version (a recheck found it unchanged, or a withdrawn one is valid again): make sure it is served.
        await tx.salesOrderInvoiceDocument.update({ where: { id: existing.id }, data: { withdrawnAt: null } })
      }
      if (existing.supersededAt) {
        // The ledger reverted to bytes seen before: that version is current again.
        await tx.salesOrderInvoiceDocument.updateMany({
          where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
          data: { supersededAt: deps.now() },
        })
        await tx.salesOrderInvoiceDocument.update({ where: { id: existing.id }, data: { supersededAt: null, withdrawnAt: null } })
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
    if (input.kind === 'INVOICE') {
      // Compatibility pointer for readers that only ask whether an invoice PDF exists: set in the SAME fenced transaction as the
      // promotion, never by a separate write. It names the immutable file of the current version.
      await tx.salesOrder.update({ where: { id: input.orderId }, data: { invoicePdfPath: storedPath } })
    }
    return { kind: 'stored' as const, documentId, created }
  })

  if (recorded.kind === 'lost') throw new LeaseLost()
  if (recorded.kind === 'order-changed') return defer(`${label}: the order changed while the document was being fetched (invoice number, total, credit or customer), so the downloaded bytes are discarded`, 'failed')
  if (recorded.kind === 'conflict') return needsAttention(recorded.reason)

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
