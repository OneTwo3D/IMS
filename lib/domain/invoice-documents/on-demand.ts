/**
 * THE ON-DEMAND QUEUE for historic orders: a customer's first click on an order whose invoice (or credit note) IMS does not hold yet.
 *
 * NO BULK BACKFILL. The ~14k historic orders are not fetched in advance; each is fetched when its customer asks, which spreads the ledger
 * calls over time instead of spending the shared daily ledger budget at once.
 *
 * THE CLICK NEVER REACHES THE LEDGER. This module only QUEUES: it marks the document's fetch state (`customerRequestedAt`) and answers
 * "preparing". The `invoice-documents` cron later picks the marked rows up (sweep.ts) and runs the ordinary fetch, which is read-only
 * toward the ledger and finds the invoice by its number. A later click is served the stored PDF. So a customer, or a script holding a
 * customer's signed requests, cannot drive ledger traffic faster than the sweep's own per-run limit allows.
 *
 *  - DE-DUPLICATED. One fetch state row per document (unique subject key) and a compare-and-set on `customerRequestedAt`: however many
 *    clicks arrive, one request is queued, and only the click that queued it writes an activity row.
 *  - RATE LIMITED. A daily cap on NEW requests (default 60 a day, setting `invoice_documents_lazy_daily_cap`) and a cap on requests still
 *    waiting (default 60, `invoice_documents_lazy_outstanding_cap`). Past either, the answer is "throttled" and nothing is queued. Each
 *    queued document costs at most three ledger GETs, so the default daily cap is at most 180 of the Xero client's real 950-call rolling day (under 20%).
 *    The two counts and the claim run under one advisory lock, so a burst of first clicks on different documents cannot exceed either cap.
 *  - BOUNDED. A request that the ledger never answers follows the fetch's own backoff and is escalated to a person after 14 days, after
 *    which it is not retried (and a customer's click on it is answered "not available", not queued again).
 *
 * OFF UNLESS CONFIGURED: only while `invoice_documents_lazy_fetch_enabled` is exactly `true` (a credit note also needs
 * `invoice_documents_credit_notes_enabled`). With the setting off nothing is queued and the customer is answered as before.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getSettingValue } from '@/lib/settings-store'
import { invoiceDocumentSubjectKey, type InvoiceDocumentKindName } from './fetch-service'

export const INVOICE_DOCUMENTS_LAZY_FETCH_SETTING = 'invoice_documents_lazy_fetch_enabled'
export const INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING = 'invoice_documents_credit_notes_enabled'
export const INVOICE_DOCUMENTS_LAZY_DAILY_CAP_SETTING = 'invoice_documents_lazy_daily_cap'
export const INVOICE_DOCUMENTS_LAZY_OUTSTANDING_CAP_SETTING = 'invoice_documents_lazy_outstanding_cap'
/**
 * CALIBRATED AGAINST THE REAL LIMIT. The Xero client enforces 950 calls per rolling 24 hours per organisation (`XERO_DAY_LIMIT` in lib/connectors/xero/api.ts; Xero's own cap is 1,000 since 2026-03-02, NOT 5,000),
 * shared with every other Xero job. A queued document costs at most three reads, so the daily cap is derived to keep the worst case at or under a fifth of that limit: floor(950 x 20% / 3) = 63, rounded down to 60
 * (worst case 180 calls). Rechecks of stored documents are not counted by this cap and draw on the rest, which is why the sweep also defers queued requests while the shared budget is low (sweep.ts).
 */
export const XERO_DAY_CALL_LIMIT = 950
export const LAZY_READS_PER_DOCUMENT = 3
export const LAZY_BUDGET_SHARE = 0.2
export const DEFAULT_LAZY_DAILY_CAP = 60
export const DEFAULT_LAZY_OUTSTANDING_CAP = 60
/** How many queued customer requests one sweep run takes first (each costs at most three ledger GETs). */
export const LAZY_REQUESTS_PER_RUN = 5
/** What the customer is told to wait: the sweep runs every 15 minutes by default. */
export const PREPARING_RETRY_AFTER_SECONDS = 900
const MAX_THROTTLE_RETRY_AFTER_SECONDS = 3600

export type OnDemandRequestInput = {
  orderId: string
  kind: InvoiceDocumentKindName
  /** Required for a credit note: the refund it documents. */
  refundId?: string
  /** Test seam. */
  now?: Date
}

export type OnDemandRequestOutcome =
  /** Queued by this call (`queued: true`) or already queued by an earlier click (`false`): the fetch will run, ask again later. */
  | { status: 'preparing'; queued: boolean; retryAfterSeconds: number }
  /** The daily or the waiting cap is reached: nothing was queued. Ask again later. */
  | { status: 'throttled'; retryAfterSeconds: number }
  /** Nothing is, or will be, fetched for this document: the setting is off, the document has no number, or it needs a person. */
  | { status: 'unavailable'; reason: string }

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

async function capSetting(key: string, fallback: number): Promise<number> {
  const text = (await getSettingValue(key))?.trim()
  if (!text) return fallback
  const value = Number(text)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

export async function requestInvoiceDocumentOnDemand(input: OnDemandRequestInput): Promise<OnDemandRequestOutcome> {
  const now = input.now ?? new Date()
  if ((await getSettingValue(INVOICE_DOCUMENTS_LAZY_FETCH_SETTING)) !== 'true') return { status: 'unavailable', reason: 'on-demand fetch is switched off' }
  if (input.kind === 'CREDIT_NOTE') {
    if (!input.refundId) return { status: 'unavailable', reason: 'a credit note needs the refund it documents' }
    if ((await getSettingValue(INVOICE_DOCUMENTS_CREDIT_NOTES_SETTING)) !== 'true') return { status: 'unavailable', reason: 'credit note documents are switched off' }
  }

  // Only a document that can be found: the order must carry the number the ledger is asked for.
  if (input.kind === 'INVOICE') {
    const order = await db.salesOrder.findUnique({ where: { id: input.orderId }, select: { invoiceNumber: true } })
    if (!order?.invoiceNumber?.trim()) return { status: 'unavailable', reason: 'the order has no invoice number' }
  } else {
    const refund = await db.salesOrderRefund.findUnique({ where: { id: input.refundId! }, select: { orderId: true, creditNoteNumber: true } })
    if (!refund || refund.orderId !== input.orderId) return { status: 'unavailable', reason: 'the refund is not on this order' }
    if (!refund.creditNoteNumber?.trim()) return { status: 'unavailable', reason: 'the refund has no credit note number' }
  }

  // Already held: whether it can be served is the reader's decision, and a re-fetch is the recheck's job, not a customer's click.
  const held = await db.salesOrderInvoiceDocument.findFirst({
    where: { orderId: input.orderId, kind: input.kind, refundId: input.refundId ?? null, supersededAt: null },
    select: { id: true },
  })
  if (held) return { status: 'unavailable', reason: 'a document is already stored' }

  const subjectKey = invoiceDocumentSubjectKey(input.orderId, input.kind, input.refundId)
  const state = await db.invoiceDocumentFetchState.findUnique({ where: { subjectKey }, select: { status: true, customerRequestedAt: true, nextAttemptAt: true } })
  if (state?.status === 'NEEDS_ATTENTION') return { status: 'unavailable', reason: 'the document needs a person' }
  if (state?.customerRequestedAt) {
    // DE-DUPLICATED: already queued. Tell the customer when to look again, no new row, no new cap spend.
    return { status: 'preparing', queued: false, retryAfterSeconds: retryAfterFor(state.nextAttemptAt, now) }
  }

  const [dailyCap, outstandingCap] = await Promise.all([
    capSetting(INVOICE_DOCUMENTS_LAZY_DAILY_CAP_SETTING, DEFAULT_LAZY_DAILY_CAP),
    capSetting(INVOICE_DOCUMENTS_LAZY_OUTSTANDING_CAP_SETTING, DEFAULT_LAZY_OUTSTANDING_CAP),
  ])
  const dayStart = startOfUtcDay(now)

  // ADMISSION IS ATOMIC: the two cap counts and the claim run under one transaction-scoped advisory lock, so requests for DIFFERENT documents cannot all see room and all queue. The lock is held only for
  // two counts and one update. The compare-and-set on `customerRequestedAt` still de-duplicates clicks on the same document.
  const admitted = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('invoice-documents-lazy-queue'))`
    const [today, outstanding] = await Promise.all([
      tx.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { gte: dayStart } } }),
      tx.invoiceDocumentFetchState.count({ where: { customerRequestedAt: { not: null }, status: 'PENDING' } }),
    ])
    if (today >= dailyCap) {
      const untilMidnight = Math.ceil((dayStart.getTime() + 24 * 3_600_000 - now.getTime()) / 1000)
      return { kind: 'throttled' as const, retryAfterSeconds: Math.min(Math.max(untilMidnight, 60), MAX_THROTTLE_RETRY_AFTER_SECONDS) }
    }
    if (outstanding >= outstandingCap) return { kind: 'throttled' as const, retryAfterSeconds: PREPARING_RETRY_AFTER_SECONDS }
    // The row exists (created here or by the sweep) before the claim; created only once admitted, so a throttled click leaves nothing behind. ON CONFLICT DO NOTHING: a concurrent creator is no error.
    await tx.invoiceDocumentFetchState.createMany({ data: [{ subjectKey, orderId: input.orderId, refundId: input.refundId ?? null, kind: input.kind }], skipDuplicates: true })
    const claimed = await tx.invoiceDocumentFetchState.updateMany({
      where: { subjectKey, customerRequestedAt: null, status: { not: 'NEEDS_ATTENTION' } },
      data: { customerRequestedAt: now },
    })
    return { kind: claimed.count === 0 ? ('lost' as const) : ('queued' as const) }
  })
  if (admitted.kind === 'throttled') return { status: 'throttled', retryAfterSeconds: admitted.retryAfterSeconds }
  if (admitted.kind === 'lost') return { status: 'preparing', queued: false, retryAfterSeconds: PREPARING_RETRY_AFTER_SECONDS }

  await logActivity({
    entityType: 'SALES_ORDER', entityId: input.orderId, action: 'invoice_document_requested', tag: 'sync', level: 'INFO',
    description: input.kind === 'INVOICE'
      ? 'A customer asked for an invoice IMS does not hold yet: its fetch from the ledger is queued.'
      : 'A customer asked for a credit note IMS does not hold yet: its fetch from the ledger is queued.',
    resolveUser: false,
  }).catch(() => { /* the queue row is the record */ })
  return { status: 'preparing', queued: true, retryAfterSeconds: PREPARING_RETRY_AFTER_SECONDS }
}

function retryAfterFor(nextAttemptAt: Date | null, now: Date): number {
  if (!nextAttemptAt) return PREPARING_RETRY_AFTER_SECONDS
  const seconds = Math.ceil((nextAttemptAt.getTime() - now.getTime()) / 1000)
  return Math.min(Math.max(seconds, 60), 24 * 3600)
}
