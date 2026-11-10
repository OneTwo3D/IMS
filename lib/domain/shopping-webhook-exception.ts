import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

// Pure builders for the exception-inbox replay of a dead-lettered STORE webhook delivery
// (shopping_webhook_events), so the compare-and-set is unit-testable without a database.
// The WMS inbound tables have their own (lib/domain/wms/exception-inbox.ts).

/**
 * The connectors whose inbox is actually DRAINED. A dead letter of any other connector (archived
 * Shopify rows, say) would be offered for a replay that nothing would ever process.
 */
export const DRAINED_SHOPPING_WEBHOOK_CONNECTORS: string[] = [WOOCOMMERCE_CONNECTOR]

/** Where-clause for the dead-letter listing and its count. */
export const DEAD_SHOPPING_WEBHOOK_WHERE = {
  status: WC_WEBHOOK_EVENT_STATUS.deadLetter,
  connector: { in: DRAINED_SHOPPING_WEBHOOK_CONNECTORS },
} as const

/**
 * Only a row still DEAD_LETTER and never processed may be replayed: a concurrent inbox drain or a
 * second operator click makes updateMany match zero rows instead of re-queuing a delivery twice.
 */
export function buildDeadShoppingWebhookReplayWhere(id: string) {
  return {
    id,
    status: WC_WEBHOOK_EVENT_STATUS.deadLetter,
    connector: { in: DRAINED_SHOPPING_WEBHOOK_CONNECTORS },
    processedAt: null,
  }
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
