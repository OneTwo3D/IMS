import type { Prisma } from '@/app/generated/prisma/client'
import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

/**
 * THE ARCHIVED WOOCOMMERCE ORDER DELIVERIES ARE ON A DESTRUCTION CLOCK, AND THE WORK THAT NEEDS THEM
 * HAS NOT BEEN DONE YET (o3d-j7y4, Codex r17 HIGH).
 *
 * Orders imported before the currency guard (r13) could be created on a currency nobody stated: the old
 * importer did `wcOrder.currency || 'GBP'` and `SalesOrder.currency` ALSO defaults to `'GBP'`, so an
 * invented sterling is byte-identical to a genuine one and NO query over `sales_orders` can separate
 * them. `o3d-j7y4` records the one source that can: the archived delivery in `shopping_webhook_events`,
 * whose `payloadJson` says whether WooCommerce stated a currency at all. It is the only POSITIVE
 * evidence of invention that exists.
 *
 * It is also, by default, deleted after three months. The shopping-inbox retention pass
 * (`retention_webhook_events_months`, default 3, `lib/data-retention.ts`) replaces the `payloadJson` of
 * every PROCESSED row past the cutoff with `{}`. That is right for the reason it was written — a
 * product-update payload is bulk, and the row survives as the idempotency tombstone — and it is
 * unrecoverable for the one question `o3d-j7y4` has to answer, because a compacted payload cannot be
 * reconstructed from anything else in the database and a creator-identity column added later cannot
 * prove, retroactively, what a delivery that has already been emptied once said.
 *
 * SO THE ORDER DELIVERIES ARE EXEMPT FROM COMPACTION UNTIL `o3d-j7y4` IS CLOSED. This is a hold on
 * DESTRUCTION only: it builds no audit, claims nothing about any order, and reads no payload. It only
 * declines to empty the rows the deferred work says it will need, for as long as that work is deferred.
 *
 * WHY `resource`, NOT `topic`. `resource` is NOT NULL and IMS writes it itself, from its own routing
 * (`ShoppingWebhookResource` = 'orders' | 'products' | 'refunds'). `topic` is a nullable header value
 * the store supplies, and a nullable column in a negated predicate is a trap: Postgres evaluates
 * `NOT (connector = 'woocommerce' AND topic IN (...))` to NULL for a row whose topic is NULL, so such a
 * row silently leaves the compaction set as well. On `resource` the predicate is two-valued and says
 * exactly what it means. It also does not have to be revised when WooCommerce adds an order topic.
 *
 * WHAT IT COSTS. Measured on the reference instance 2026-08-29: 451 of 74,124 inbox rows (0.6%) are
 * `orders`-resource — the other 73,673 are product updates, which are the bulk this compaction was
 * added for and which keep compacting exactly as before. The exemption's cost is that WooCommerce order
 * payloads — which carry billing and delivery names and addresses — are retained past the retention
 * window for as long as it is on. That is a real cost and it is the reason this is a CODE constant and
 * not a setting: turning the destruction back on should be a reviewed change with `o3d-j7y4` closed
 * behind it, not a toggle someone flips to reclaim disk.
 *
 * TO LIFT IT: close `o3d-j7y4` (or supersede it with a durable record of each order's creator identity
 * that does not depend on the archive), then set this to `false`. The next nightly run compacts the
 * accumulated order rows in one statement.
 */
export const PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE = true

/**
 * The rows the hold above covers: WooCommerce deliveries about ORDERS. Exported so the retention pass
 * and its tests name the same set, and so a reader can count them (`SELECT count(*) FROM
 * shopping_webhook_events WHERE connector = 'woocommerce' AND resource = 'orders'`).
 */
export const PRESERVED_WC_ORDER_EVIDENCE_WHERE = {
  connector: WOOCOMMERCE_CONNECTOR,
  resource: 'orders',
} as const satisfies Prisma.ShoppingWebhookEventWhereInput

/**
 * The extra conjuncts the shopping-inbox compaction carries while evidence is being preserved — empty
 * when it is not, so the predicate is literally unchanged once the hold is lifted.
 */
export function preservedWcOrderEvidenceExemption(): Prisma.ShoppingWebhookEventWhereInput[] {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return []
  return [{ NOT: PRESERVED_WC_ORDER_EVIDENCE_WHERE }]
}

/**
 * The rows the shopping-inbox retention pass may compact at `cutoff`.
 *
 * Only PROCESSED rows: DEAD_LETTER (failed, unresolved — the only record of the failed event) and
 * PENDING/FAILED (undelivered work) are left fully intact. `payloadJson != {}` PERMANENTLY excludes
 * already-compacted rows, so each daily run only touches the newly-eligible set rather than rewriting
 * the whole retained tombstone set. And, while the hold above is on, WooCommerce order deliveries are
 * excluded whatever their age.
 */
export function compactableShoppingWebhookEventWhere(cutoff: Date): Prisma.ShoppingWebhookEventWhereInput {
  return {
    status: WC_WEBHOOK_EVENT_STATUS.processed,
    updatedAt: { lt: cutoff },
    NOT: { payloadJson: { equals: {} } },
    AND: preservedWcOrderEvidenceExemption(),
  }
}
