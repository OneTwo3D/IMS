import { MINTSOFT_WEBHOOK_PROCESSING_STATUS } from '@/lib/domain/wms/booked-in-service'

// q66in.4.2: pure builders for the exception-inbox replay transitions, exported
// so the compare-and-set semantics are unit-testable without a database.

/**
 * Connector-agnostic alias for the dead-lettered receipt-event status so core
 * app flows can query it without referencing a connector-named constant
 * (wms-connector boundary). The status values themselves are generic.
 */
export const DEAD_RECEIPT_EVENT_STATUS = MINTSOFT_WEBHOOK_PROCESSING_STATUS.dead

/**
 * Where-clause for replaying a dead-lettered inbound event: only a row still
 * DEAD and never processed may be replayed — a concurrent sweep or a second
 * operator click makes updateMany match zero rows instead of clobbering.
 * Shared by BOTH inbound-event tables (wms_inbound_receipt_events booked-in
 * rows and wms_webhook_events order/inventory rows) — they use the same
 * processingStatus machinery and retry-ladder columns.
 */
export function buildDeadReceiptEventReplayWhere(id: string) {
  return {
    id,
    processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.dead,
    processedAt: null,
  }
}

/**
 * Reset a DEAD receipt event for the webhook sweeper: back to PENDING with the
 * retry ladder restarted. The payload and (connector, externalEventId)
 * idempotency key are untouched — the replay re-attempts the ORIGINAL event.
 */
export function buildDeadReceiptEventReplayData() {
  return {
    processingStatus: MINTSOFT_WEBHOOK_PROCESSING_STATUS.pending,
    processingAttempts: 0,
    nextRetryAt: null,
    deadLetteredAt: null,
    lastError: null,
  }
}

/**
 * o3d-bjc.9: the shape the stuck-dispatch section needs from a push link.
 * Structural, so the caller's Prisma select stays the source of truth.
 */
export type StuckDispatchLink = {
  orderId: string
  connector: string
  externalOrderNumber: string | null
  dispatchFailureCount: number
  dispatchLastError: string | null
  dispatchDeadLetteredAt: Date | null
  dispatchUnresolvedCount: number
  dispatchUnresolvedError: string | null
  dispatchUnresolvedAt: Date | null
  order: { orderNumber: string | null }
}

export type StuckDispatchEntry = {
  orderId: string
  orderNumber: string | null
  externalOrderNumber: string | null
  connector: string
  failureCount: number
  reason: string | null
  deadLetteredAt: string | null
  kind: 'dead-letter' | 'unresolved'
}

/**
 * Merge the two ways a link leaves the dispatch sweep into ONE capped, newest-first
 * list.
 *
 * The merge is not cosmetic. Ordering a single query by dispatchDeadLetteredAt
 * first puts every dead letter ahead of every unresolved-only row (its marker is
 * NULL, and nulls sort last), so once there are `limit` dead letters a newly
 * quarantined record never appears — on the very page its own notification links
 * to. Sorting on the EFFECTIVE held timestamp is what keeps the newest exception
 * visible whichever kind it is.
 */
export function mergeStuckDispatchRows(links: StuckDispatchLink[], limit: number): StuckDispatchEntry[] {
  const heldAt = (link: StuckDispatchLink) =>
    (link.dispatchDeadLetteredAt ?? link.dispatchUnresolvedAt)?.getTime() ?? 0
  return [...links]
    .sort((a, b) => heldAt(b) - heldAt(a))
    .slice(0, Math.max(0, limit))
    .map((link) => {
      // A link can carry both markers; the dead-letter is reported because it is
      // the stronger statement (the reconcile ERRORED, not merely "unreadable").
      const deadLettered = link.dispatchDeadLetteredAt !== null
      return {
        orderId: link.orderId,
        orderNumber: link.order.orderNumber,
        externalOrderNumber: link.externalOrderNumber,
        connector: link.connector,
        failureCount: deadLettered ? link.dispatchFailureCount : link.dispatchUnresolvedCount,
        reason: deadLettered ? link.dispatchLastError : link.dispatchUnresolvedError,
        deadLetteredAt: (deadLettered ? link.dispatchDeadLetteredAt : link.dispatchUnresolvedAt)?.toISOString() ?? null,
        kind: deadLettered ? ('dead-letter' as const) : ('unresolved' as const),
      }
    })
}
