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
 * Where-clause for replaying a dead-lettered inbound receipt event: only a row
 * still DEAD and never processed may be replayed — a concurrent sweep or a
 * second operator click makes updateMany match zero rows instead of clobbering.
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

export type DispatchErrorPayloadRef = {
  orderId: string | null
  externalOrderNumber: string | null
}

/**
 * Dispatch-sweep error logs carry `{ orderId, externalOrderNumber }` in their
 * JSON payload (dispatch-sweep.ts writes them per errored order). Parse
 * defensively — the payload column is untyped JSON.
 */
export function parseDispatchErrorPayload(payload: unknown): DispatchErrorPayloadRef {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { orderId: null, externalOrderNumber: null }
  }
  const record = payload as Record<string, unknown>
  return {
    orderId: typeof record.orderId === 'string' ? record.orderId : null,
    externalOrderNumber: typeof record.externalOrderNumber === 'string' ? record.externalOrderNumber : null,
  }
}
