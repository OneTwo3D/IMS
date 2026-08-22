import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '@/lib/domain/wms/booked-in-service'

/**
 * q66in.7.4: RETENTION FOR THE INBOUND WMS EVENT TABLES.
 *
 * Two tables stage inbound connector deliveries and, until this landed, NOTHING ever removed a row
 * from either of them:
 *
 *   wms_inbound_receipt_events — booked-in ASN callbacks (`payload`, plus a full dry-run object in
 *                                `reviewDetails` for anything that paused for review).
 *   wms_webhook_events         — generic push-connector order/inventory webhooks.
 *
 * They share one processingStatus vocabulary and one retry ladder (see
 * lib/domain/wms/exception-inbox.ts), so they share one retention rule, expressed here once.
 *
 * COMPACT, NEVER DELETE — the same shape as the o3d-ahk shopping-webhook-inbox rule, for the same
 * reason. `(connector, externalEventId)` is the table's UNIQUE idempotency key: it is what makes a
 * redelivered callback a duplicate instead of a second booking-in. Deleting the row would let a
 * redelivered or replayed old event be accepted as new and REAPPLY ITS STOCK MOVEMENT. So the row
 * survives forever as a tombstone; what expires is the bulky, PII-carrying `payload` (and
 * `reviewDetails`, which holds a whole dry-run image of the receipt).
 *
 * AND ONLY WHEN IT IS RESOLVED. A retention policy that discards UNRESOLVED work destroys evidence,
 * and an unresolved dead-letter row is not the same thing as an old one:
 *
 *   PROCESSED       — resolved. Its effect is applied and recorded elsewhere (stock movements, ASN
 *                     maps, mutation-audit rows). The payload is the only thing left to reclaim.
 *   DEAD            — dead-lettered. THE EFFECT WAS NEVER APPLIED, and this row's payload is the
 *                     only record of what the WMS said. It is replayable from the sync exception
 *                     inbox, and a replay re-attempts THIS payload — compacting it would silently
 *                     turn a recoverable failure into an unrecoverable one while leaving a row that
 *                     still looks replayable.
 *   REQUIRES_REVIEW — waiting on an operator decision; `reviewDetails` IS the thing being reviewed.
 *   PENDING /
 *   PENDING_RETRY /
 *   FAILED_RETRY    — undelivered work still on the ladder.
 *
 * None of the four unresolved states is bounded by age, so none of them is touched by age.
 */

/** The one terminal state: the event's effect has been applied. */
export const RESOLVED_INBOUND_EVENT_STATUS = MINTSOFT_WEBHOOK_PROCESSING_STATUS.processed

/**
 * Every state that is NOT resolved. Exported so a test can assert the compaction predicate against
 * the whole vocabulary rather than the two or three cases someone happened to think of.
 */
export const UNRESOLVED_INBOUND_EVENT_STATUSES = [
  MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS.pendingRetry,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS.failedRetry,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS.requiresReview,
  MINTSOFT_WEBHOOK_PROCESSING_STATUS.dead,
] as const

/**
 * Rows eligible for compaction: RESOLVED, processed before the cutoff, and not already compacted.
 *
 * `NOT: { payload: { equals: {} } }` permanently excludes rows this pass has already emptied, so a
 * daily run rewrites only the slice that newly crossed the cutoff instead of the whole tombstone
 * set — the same trick the shopping inbox uses.
 *
 * Bounded by `processedAt`, not `receivedAt`: an event that sat on the retry ladder for a fortnight
 * before succeeding should keep its payload for the full window measured from when it RESOLVED,
 * which is when it stopped being evidence of anything outstanding.
 */
export function compactableInboundEventWhere(cutoff: Date) {
  return {
    processingStatus: RESOLVED_INBOUND_EVENT_STATUS,
    processedAt: { lt: cutoff },
    NOT: { payload: { equals: {} } },
  }
}

/** Clears the payload and the last error; leaves the idempotency key, status and timestamps alone. */
export function inboundEventCompactionData() {
  return { payload: {}, lastError: null }
}

/**
 * Receipt events carry a second bulky column: `reviewDetails`, the full dry-run image captured when
 * an event entered REQUIRES_REVIEW. A row that reached PROCESSED has left that state (whether it was
 * approved or never paused at all), so the image has served its purpose. Nullable Json, hence
 * `JsonNull` rather than `undefined`.
 */
export function receiptEventCompactionData<T>(jsonNull: T) {
  return { ...inboundEventCompactionData(), reviewDetails: jsonNull }
}
