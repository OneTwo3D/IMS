import type { Prisma } from '@/app/generated/prisma/client'
import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

/**
 * THE ARCHIVED WOOCOMMERCE ORDER DELIVERIES ARE ON A DESTRUCTION CLOCK, AND THE WORK THAT NEEDS THEM
 * HAS NOT BEEN DONE YET (o3d-j7y4, Codex r17 HIGH; bounded in r18, UNBOUNDED AGAIN in r19).
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
 * SO EVERY WOOCOMMERCE ORDER DELIVERY IS EXEMPT FROM COMPACTION UNTIL `o3d-j7y4` IS CLOSED. This is a
 * hold on DESTRUCTION only: it builds no audit, claims nothing about any order, and reads no payload.
 * It only declines to empty the rows the deferred work says it will need, for as long as that work is
 * deferred.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THERE IS NO CUTOFF ANY MORE (r19). Round 18 answered "an indefinite hold has no enforced end" by
 * bounding the exemption to deliveries received before a per-installation instant, recorded by the
 * nightly pass the first time it ran under a guarded build. That instant was withdrawn in r19, on the
 * merits, and the reasoning is kept here because the same idea will look attractive again:
 *
 *   1. THE BOUND BUYS NOTHING FOR A WHOLE RETENTION WINDOW. A delivery received after the cutoff is not
 *      compacted on the cutoff — it is compacted once it is `retention_webhook_events_months` old.
 *      For the first three months after any installation upgrades, the bounded hold and the unbounded
 *      one retain byte-for-byte the same rows. The entire saving is deferred by the window, and it
 *      arrives at roughly seven rows a day on the reference instance.
 *   2. ITS FAILURE MODE IS THE UNRECOVERABLE ONE. Over-retention is reversible: flip the constant below
 *      and one nightly statement empties the accumulation. Destruction is not. A cutoff is a stored
 *      fact that can become false — a rollback to the old importer invalidates it (Codex r19 HIGH), a
 *      fresh installation never had an old importer to stop running (r19 MEDIUM), and until r19 any
 *      principal with `settings.company` could simply write it (r19 HIGH). Each of those NARROWS a
 *      safety net, and narrowing it wrongly destroys the evidence the net exists for. A mechanism whose
 *      only job is to prevent unrecoverable destruction should not acquire a state machine with three
 *      independent routes to unrecoverable destruction.
 *   3. THE ROLLBACK HOLE CANNOT BE CLOSED CHEAPLY, AND THE EXPENSIVE CLOSE IS `o3d-j7y4` ITSELF. The
 *      only rollback detector available to a guarded build is "I have not run for a while", which is
 *      indistinguishable from an outage or a paused cron: tuned to catch a real rollback it extends
 *      the cutoff on ordinary downtime (drifting back to the unbounded hold, but with a state machine
 *      attached); tuned not to, it misses the rollback. The sound version is a durable per-order record
 *      of which importer created the order — which is exactly what `o3d-j7y4` is for. The cutoff was
 *      trying to do that job approximately, inside the retention pass, before the issue that owns it
 *      had been done.
 *   4. ROLLBACK IS WORSE UNDER THE CUTOFF, NOT BETTER. A rolled-back build carries no hold at all, so
 *      its nightly pass compacts everything past the window under EITHER design. The one thing that
 *      differs is what happens on the way back: an order imported during the rollback window is held
 *      again by the unbounded hold, and is permanently outside a cutoff recorded before it.
 *
 * WHAT IS GIVEN UP, PLAINLY. There is no automatic expiry. The exemption grows for as long as
 * `o3d-j7y4` is open, at about seven WooCommerce order payloads a day on the reference instance, and
 * those payloads carry billing and delivery names and addresses retained past the window the operator
 * configured. That is a real data-minimisation cost and it is an ACCEPTED CONSTRAINT OWNED BY
 * `o3d-j7y4`: the issue records it, the operator notice on Settings > System > Data Retention states it
 * with the number of payloads it is actually keeping alive today, and closing the issue is what ends
 * it. An end enforced by a decision recorded on an issue is not the same thing as no end; what it is
 * not is automatic, and automatic is what produced four review findings in one round.
 * ------------------------------------------------------------------------------------------------
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
 * added for and which keep compacting exactly as before. It is the reason this is a CODE constant and
 * not a setting: turning the destruction back on should be a reviewed change with `o3d-j7y4` closed
 * behind it, not a toggle someone flips to reclaim disk.
 *
 * TO LIFT IT: close `o3d-j7y4` (or supersede it with a durable record of each order's creator identity
 * that does not depend on the archive), then set this to `false`. The next nightly run compacts the
 * accumulated order rows in one statement.
 */
export const PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE = true

/**
 * The rows the hold covers: every WooCommerce delivery about ORDERS, at any age. Exported so the
 * retention pass, the operator notice and the tests all name the same set.
 */
export function preservedWcOrderEvidenceWhere(): Prisma.ShoppingWebhookEventWhereInput {
  return {
    connector: WOOCOMMERCE_CONNECTOR,
    resource: 'orders',
  }
}

/**
 * The extra conjuncts the shopping-inbox compaction carries while evidence is being preserved — empty
 * when it is not, so the predicate is literally unchanged once the hold is lifted.
 */
export function preservedWcOrderEvidenceExemption(): Prisma.ShoppingWebhookEventWhereInput[] {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return []
  return [{ NOT: preservedWcOrderEvidenceWhere() }]
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
