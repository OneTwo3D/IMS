/**
 * The scheduled sweep that fetches customer invoice (and credit note) PDFs for WooCommerce-linked orders,
 * plus the lazy entry point a customer's first download uses for an order the sweep never covered.
 *
 * OFF UNLESS CONFIGURED. The sweep only looks at orders created at or after the date in the setting
 * `invoice_documents_sweep_floor`; with no date it does nothing for them. Older (historic) orders are NOT bulk
 * fetched: a customer's first click QUEUES the fetch (on-demand.ts, setting `invoice_documents_lazy_fetch_enabled`) and
 * THIS run does it, a few per run and ahead of the floor work, so the ledger calls are spread over time instead of
 * spending the shared daily budget on ~14k orders at once.
 *
 * BUDGET. Each order costs at most two ledger GETs (the number lookup and the PDF). A run handles at most
 * `limit` documents, and stops at once when the ledger says it is rate-limited or unreachable, and after
 * three lookups in a row fail. Every call also passes the connector's own minute and daily budget.
 */

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { loadInvoiceDocumentFile } from '@/lib/invoice-pdf'
import { getSettingValue } from '@/lib/settings-store'
import { logActivity } from '@/lib/activity-log'
import { DOCUMENT_MISSING_ESCALATION_MS } from './backoff'
import { ensureInvoiceDocument, type InvoiceDocumentDeps, type EnsureInvoiceDocumentOutcome } from './fetch-service'
import { INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING, INVOICE_DOCUMENTS_LAZY_FETCH_SETTING, LAZY_REQUESTS_PER_RUN } from './on-demand'

export { INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING, INVOICE_DOCUMENTS_LAZY_FETCH_SETTING }
export const INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING = 'invoice_documents_sweep_floor'
export const DEFAULT_SWEEP_LIMIT = 20
export const INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING = 'invoice_documents_integrity_cursor'
const INTEGRITY_SCAN_BATCH = 100
const MAX_CONSECUTIVE_FAILURES = 3

/** On-demand requests run only while at least this many of the ledger's 950 daily calls are left (the rest belongs to other work). */
export const LAZY_MIN_DAY_CALLS_REMAINING = 600

export type InvoiceDocumentSweepResult = {
  skipped?: 'no-floor' | 'bad-floor'
  considered: number
  stored: number
  waiting: number
  needsAttention: number
  failed: number
  stoppedEarly: string | null
  /** Customer-queued requests were left for a later run because the shared ledger budget is low, or because no worker has seen it recently (unknown counts as low). */
  lazyDeferred?: 'ledger-budget-low' | 'ledger-budget-unknown'
  /** Customer requests that waited DOCUMENT_MISSING_ESCALATION_MS without being fetched, handed to a person this run (they no longer count against the waiting cap). */
  lazyAgedOut?: number
}

/** At most this many waiting customer requests are aged out per run. */
export const LAZY_AGE_OUT_BATCH = 50

/**
 * o3d-hvzdx (finding 2): A CUSTOMER REQUEST THAT HAS WAITED TOO LONG IS HANDED TO A PERSON, whether or not a fetch was ever attempted. The fetch's own
 * 14-day escalation runs only after an attempt, and while the shared budget stays low no attempt is made, so without this the requests would stay
 * PENDING for ever, fill the waiting cap and keep every new customer on "preparing". A request queued DOCUMENT_MISSING_ESCALATION_MS ago that is
 * still PENDING and not leased by a running fetch is set NEEDS_ATTENTION (it leaves the waiting cap; a customer's click on it is answered "not
 * available"), with the same activity row the fetch writes. Nothing is fetched; the ledger is not asked.
 */
export async function ageOutWaitingCustomerRequests(now: Date, batch: number = LAZY_AGE_OUT_BATCH): Promise<number> {
  const cutoff = new Date(now.getTime() - DOCUMENT_MISSING_ESCALATION_MS)
  const waiting = await db.invoiceDocumentFetchState.findMany({
    where: { customerRequestedAt: { not: null, lte: cutoff }, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    orderBy: { customerRequestedAt: 'asc' },
    take: batch,
    select: { id: true, orderId: true, refundId: true, kind: true, customerRequestedAt: true },
  })
  let aged = 0
  for (const row of waiting) {
    const reason = `a customer asked for it on ${row.customerRequestedAt!.toISOString().slice(0, 10)} and it has not been fetched in ${Math.round(DOCUMENT_MISSING_ESCALATION_MS / 86_400_000)} days`
    // The same predicate again as a compare-and-set: a fetch that took the lease or finished meanwhile is left alone.
    const updated = await db.invoiceDocumentFetchState.updateMany({
      where: { id: row.id, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { status: 'NEEDS_ATTENTION', lastError: reason, nextAttemptAt: null },
    })
    if (updated.count === 0) continue
    aged++
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: row.orderId,
      action: 'invoice_document_needs_attention',
      tag: 'accounting',
      level: 'WARNING',
      description: `The ${row.kind === 'INVOICE' ? 'invoice' : 'credit note'} PDF for this order was not fetched and needs a person: ${reason}`,
      metadata: { kind: row.kind, refundId: row.refundId ?? null, reason, agedOut: true },
      resolveUser: false,
    }).catch(() => { /* logging must never change the outcome */ })
  }
  return aged
}

function parseFloor(raw: string | null): Date | 'bad' | null {
  if (!raw || !raw.trim()) return null
  const at = new Date(raw.trim())
  return Number.isNaN(at.getTime()) ? 'bad' : at
}

type Candidate = { orderId: string; kind: 'INVOICE' | 'CREDIT_NOTE'; refundId?: string }

/** At least this share of a run (a quarter, never fewer than one slot) is reserved for DUE RECHECKS of stored documents, so a long backlog of new orders cannot starve them. */
export function reservedRecheckSlots(limit: number): number {
  return Math.max(1, Math.floor(limit / 4))
}

async function selectNewFetchCandidates(floor: Date, now: Date, take: number, includeCreditNotes: boolean): Promise<Candidate[]> {
  if (take <= 0) return []
  const dueState = (kind: 'INVOICE' | 'CREDIT_NOTE') => ({
    OR: [
      { invoiceDocumentFetches: { none: { kind } } },
      { invoiceDocumentFetches: { some: { kind, status: 'PENDING' as const, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } } },
    ],
  })
  const orders = await db.salesOrder.findMany({
    where: {
      invoiceNumber: { not: null },
      createdAt: { gte: floor },
      shoppingLinks: { some: { connector: 'woocommerce' } },
      invoiceDocuments: { none: { kind: 'INVOICE', supersededAt: null } },
      ...dueState('INVOICE'),
    },
    orderBy: { createdAt: 'asc' },
    take,
    select: { id: true },
  })
  const candidates: Candidate[] = orders.map((order) => ({ orderId: order.id, kind: 'INVOICE' as const }))

  if (includeCreditNotes && candidates.length < take) {
    const refunds = await db.salesOrderRefund.findMany({
      where: {
        creditNoteNumber: { not: null },
        deletedAt: null,
        createdAt: { gte: floor },
        order: { shoppingLinks: { some: { connector: 'woocommerce' } } },
        invoiceDocuments: { none: { kind: 'CREDIT_NOTE', supersededAt: null } },
        OR: [
          { invoiceDocumentFetches: { none: { kind: 'CREDIT_NOTE' } } },
          { invoiceDocumentFetches: { some: { kind: 'CREDIT_NOTE', status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: take - candidates.length,
      select: { id: true, orderId: true },
    })
    for (const refund of refunds) candidates.push({ orderId: refund.orderId, kind: 'CREDIT_NOTE', refundId: refund.id })
  }
  return candidates
}

/**
 * DOCUMENTS A CUSTOMER ASKED FOR (on-demand.ts): historic orders, fetched whatever their date, oldest request first, a few per run so a flood
 * of clicks cannot spend the ledger budget. A request waiting out its backoff, escalated to a person, or already stored is not due.
 */
async function selectCustomerRequested(now: Date, take: number, includeCreditNotes: boolean): Promise<Candidate[]> {
  if (take <= 0) return []
  const states = await db.invoiceDocumentFetchState.findMany({
    where: {
      customerRequestedAt: { not: null },
      status: 'PENDING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      ...(includeCreditNotes ? {} : { kind: 'INVOICE' as const }),
    },
    orderBy: { customerRequestedAt: 'asc' },
    take,
    select: { orderId: true, refundId: true, kind: true },
  })
  return states.map((state) => ({ orderId: state.orderId, kind: state.kind, ...(state.refundId ? { refundId: state.refundId } : {}) }))
}

/**
 * RECHECKS of documents already stored: the ledger can amend or re-issue one, so a stored document's fetch state carries the time it is next
 * looked at (1 day, 7 days, then every 30 days after the last look). Not floor-limited: it was fetched already. Longest-overdue first.
 */
async function selectDueRechecks(now: Date, take: number, includeCreditNotes: boolean): Promise<Candidate[]> {
  if (take <= 0) return []
  const due = await db.invoiceDocumentFetchState.findMany({
    where: {
      status: { in: ['DONE', 'PENDING'] },
      nextAttemptAt: { lte: now },
      ...(includeCreditNotes ? {} : { kind: 'INVOICE' as const }),
      order: { invoiceDocuments: { some: { supersededAt: null } } },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: take * 3,
    select: { orderId: true, refundId: true, kind: true },
  })
  if (due.length === 0) return []
  const current = await db.salesOrderInvoiceDocument.findMany({
    where: { supersededAt: null, orderId: { in: [...new Set(due.map((state) => state.orderId))] } },
    select: { orderId: true, refundId: true, kind: true },
  })
  const hasCurrent = new Set(current.map((doc) => `${doc.orderId}:${doc.kind}:${doc.refundId ?? '-'}`))
  const candidates: Candidate[] = []
  for (const state of due) {
    if (candidates.length >= take) break
    if (!hasCurrent.has(`${state.orderId}:${state.kind}:${state.refundId ?? '-'}`)) continue
    candidates.push({ orderId: state.orderId, kind: state.kind, ...(state.refundId ? { refundId: state.refundId } : {}) })
  }
  return candidates
}

/**
 * One run's work: due rechecks get a RESERVED share (reservedRecheckSlots), new fetches take the rest, and any slot either kind does not use
 * rolls over to the other. A backlog of new orders therefore cannot starve the rechecks of documents already shown to customers.
 */
export async function selectInvoiceDocumentCandidates(floor: Date, now: Date, limit: number, includeCreditNotes: boolean): Promise<Candidate[]> {
  const rechecks = await selectDueRechecks(now, limit, includeCreditNotes)
  const reserved = Math.min(reservedRecheckSlots(limit), rechecks.length)
  const fresh = await selectNewFetchCandidates(floor, now, limit - reserved, includeCreditNotes)
  const spare = limit - reserved - fresh.length
  return [...rechecks.slice(0, reserved), ...fresh, ...rechecks.slice(reserved, reserved + Math.max(0, spare))]
}

/**
 * REPAIR: a current document whose immutable file is missing or no longer matches its hash (a lost disk, a restore without the files) is
 * made due for a re-fetch, and the recheck path rewrites the file. A rolling scan, INTEGRITY_SCAN_BATCH current documents per run, in id
 * order from a stored cursor and wrapping round, so every stored document is verified over time without reading them all each run. The
 * customer read path marks a document due the moment it finds its file bad (current-document.ts); this finds the ones nobody has asked for.
 * Returns how many were marked due.
 */
export async function markDocumentsWithBadFilesDue(now: Date, batch: number = INTEGRITY_SCAN_BATCH): Promise<number> {
  const cursor = (await getSettingValue(INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING)) ?? ''
  let docs = await db.salesOrderInvoiceDocument.findMany({
    where: { supersededAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: batch,
    select: { id: true, orderId: true, refundId: true, kind: true, sha256: true },
  })
  const wrapped = docs.length < batch
  if (wrapped && cursor) {
    docs = [...docs, ...(await db.salesOrderInvoiceDocument.findMany({ where: { supersededAt: null, id: { lte: cursor } }, orderBy: { id: 'asc' }, take: batch - docs.length, select: { id: true, orderId: true, refundId: true, kind: true, sha256: true } }))]
  }
  let marked = 0
  for (const doc of docs) {
    const bytes = await loadInvoiceDocumentFile(doc.orderId, doc.sha256)
    if (bytes && createHash('sha256').update(bytes).digest('hex') === doc.sha256) continue
    const updated = await db.invoiceDocumentFetchState.updateMany({
      where: { orderId: doc.orderId, kind: doc.kind, refundId: doc.refundId, status: { not: 'NEEDS_ATTENTION' } },
      data: { nextAttemptAt: new Date(now.getTime() - 1) },
    })
    if (updated.count > 0) marked++
  }
  const last = docs.length > 0 && !wrapped ? docs[docs.length - 1]!.id : ''
  await db.setting.upsert({ where: { key: INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING }, create: { key: INVOICE_DOCUMENTS_INTEGRITY_CURSOR_SETTING, value: last }, update: { value: last } })
  return marked
}

export async function runInvoiceDocumentSweep(
  deps: InvoiceDocumentDeps,
  options: { limit?: number } = {},
): Promise<InvoiceDocumentSweepResult> {
  const result: InvoiceDocumentSweepResult = { considered: 0, stored: 0, waiting: 0, needsAttention: 0, failed: 0, stoppedEarly: null }
  const floor = parseFloor(await getSettingValue(INVOICE_DOCUMENTS_SWEEP_FLOOR_SETTING))
  const lazyOn = (await getSettingValue(INVOICE_DOCUMENTS_LAZY_FETCH_SETTING)) === 'true'
  // With the on-demand switch off the run is exactly what it was: no floor, or a bad one, means nothing is done.
  if (floor === null && !lazyOn) return { ...result, skipped: 'no-floor' }
  if (floor === 'bad' && !lazyOn) return { ...result, skipped: 'bad-floor' }
  const includeCreditNotes = (await getSettingValue(INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING)) === 'true'
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SWEEP_LIMIT, 200))
  const now = deps.now()

  // A customer is waiting on these: they go first, capped per run.
  // A queued request spends up to three ledger reads from the SHARED rolling day: while less than LAZY_MIN_DAY_CALLS_REMAINING is left they wait (they stay queued; nothing is lost).
  // o3d-hvzdx: UNKNOWN COUNTS AS LOW. A fresh worker that has not called the ledger yet does not know what the others spent, so it waits rather than spend.
  if (lazyOn) {
    const aged = await ageOutWaitingCustomerRequests(now)
    if (aged > 0) result.lazyAgedOut = aged
  }
  const remaining = lazyOn ? ((await deps.dayCallsRemaining?.()) ?? null) : null
  const budgetLow = remaining === null || remaining < LAZY_MIN_DAY_CALLS_REMAINING
  if (lazyOn && budgetLow) result.lazyDeferred = remaining === null ? 'ledger-budget-unknown' : 'ledger-budget-low'
  const requested = lazyOn && !budgetLow ? await selectCustomerRequested(now, Math.min(limit, LAZY_REQUESTS_PER_RUN), includeCreditNotes) : []
  let candidates: Candidate[] = requested
  if (floor instanceof Date) {
    // Verify stored files first, so a bad one is due for a re-fetch in this very run.
    await markDocumentsWithBadFilesDue(now).catch(() => 0)
    const planned = await selectInvoiceDocumentCandidates(floor, now, limit - requested.length, includeCreditNotes)
    const seen = new Set(requested.map((candidate) => `${candidate.orderId}:${candidate.kind}:${candidate.refundId ?? '-'}`))
    candidates = [...requested, ...planned.filter((candidate) => !seen.has(`${candidate.orderId}:${candidate.kind}:${candidate.refundId ?? '-'}`))]
  } else if (lazyOn) {
    // NO FLOOR (or a bad one) with on-demand fetching on: the floor only limits NEW unsolicited fetches, so it is not asked for here. A document a customer already received (a queued invoice or credit
    // note, now stored and DONE) still has to be looked at again when its recheck falls due, or an amended or voided one would stay downloadable for ever (a credit note has no read-time refresh).
    await markDocumentsWithBadFilesDue(now).catch(() => 0)
    const rechecks = await selectDueRechecks(now, Math.max(0, limit - requested.length), includeCreditNotes)
    const seen = new Set(requested.map((candidate) => `${candidate.orderId}:${candidate.kind}:${candidate.refundId ?? '-'}`))
    candidates = [...requested, ...rechecks.filter((candidate) => !seen.has(`${candidate.orderId}:${candidate.kind}:${candidate.refundId ?? '-'}`))]
  }
  let consecutiveFailures = 0
  for (const candidate of candidates) {
    result.considered++
    let outcome: EnsureInvoiceDocumentOutcome
    try {
      outcome = await ensureInvoiceDocument(candidate, deps)
    } catch (error) {
      result.failed++
      result.stoppedEarly = `unexpected error: ${error instanceof Error ? error.message : String(error)}`
      break
    }
    if (outcome.status === 'stored') { result.stored++; consecutiveFailures = 0 }
    else if (outcome.status === 'waiting') { result.waiting++; consecutiveFailures = 0 }
    else if (outcome.status === 'needs-attention') { result.needsAttention++; consecutiveFailures = 0 }
    else if (outcome.status === 'busy' || outcome.status === 'backoff') { consecutiveFailures = 0 }
    else if (outcome.status === 'failed') {
      result.failed++
      consecutiveFailures++
      if (outcome.stop) { result.stoppedEarly = `the ledger refused or is rate-limited: ${outcome.reason}`; break }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { result.stoppedEarly = `${MAX_CONSECUTIVE_FAILURES} failures in a row: ${outcome.reason}`; break }
    }
  }
  return result
}

/**
 * The same look-again for an order that ALREADY has a stored PDF: called by the customer download route before it serves, so an
 * amended invoice is picked up on the first request after its recheck falls due. Never throws and never blocks the download on a
 * failure: whatever is stored is served.
 */
export async function refreshStaleInvoiceDocument(orderId: string, deps: InvoiceDocumentDeps): Promise<void> {
  try {
    if ((await getSettingValue(INVOICE_DOCUMENTS_LAZY_FETCH_SETTING)) !== 'true') return
    await ensureInvoiceDocument({ orderId, kind: 'INVOICE' }, deps)
  } catch {
    /* serve what is stored */
  }
}
