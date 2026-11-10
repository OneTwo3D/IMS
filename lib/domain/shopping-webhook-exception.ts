import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

// Pure builders for the exception-inbox replay of a dead-lettered STORE webhook delivery
// (shopping_webhook_events), so the compare-and-set is unit-testable without a database.
// The WMS inbound tables have their own (lib/domain/wms/exception-inbox.ts).

/** Where-clause for the dead-letter listing and its count. */
export const DEAD_SHOPPING_WEBHOOK_WHERE = { status: WC_WEBHOOK_EVENT_STATUS.deadLetter } as const

/**
 * Only a row still DEAD_LETTER and never processed may be replayed: a concurrent inbox drain or a
 * second operator click makes updateMany match zero rows instead of re-queuing a delivery twice.
 */
export function buildDeadShoppingWebhookReplayWhere(id: string) {
  return { id, status: WC_WEBHOOK_EVENT_STATUS.deadLetter, processedAt: null }
}

/**
 * Back to PENDING with the retry ladder restarted. The payload, its hash (the idempotency key)
 * and the origin recorded at receipt are untouched: the replay re-attempts the ORIGINAL delivery,
 * and is judged on the same evidence it arrived with.
 */
export function buildDeadShoppingWebhookReplayData() {
  return {
    status: WC_WEBHOOK_EVENT_STATUS.pending,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  }
}
