import type { Prisma } from '@/app/generated/prisma/client'
import { WC_WEBHOOK_EVENT_STATUS, WOOCOMMERCE_CONNECTOR } from '@/lib/connectors/shopping-webhook-inbox'

/**
 * THE ARCHIVED WOOCOMMERCE ORDER DELIVERIES ARE ON A DESTRUCTION CLOCK, AND THE WORK THAT NEEDS THEM
 * HAS NOT BEEN DONE YET (o3d-j7y4, Codex r17 HIGH — bounded in r18).
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
 * SO SOME ORDER DELIVERIES ARE EXEMPT FROM COMPACTION UNTIL `o3d-j7y4` IS CLOSED. This is a hold on
 * DESTRUCTION only: it builds no audit, claims nothing about any order, and reads no payload. It only
 * declines to empty the rows the deferred work says it will need, for as long as that work is deferred.
 *
 * WHICH ONES, AND WHY THE HOLD HAS AN END (Codex r18 MEDIUM). The first version of this exemption was
 * bounded by connector and resource ALONE, which meant it also held every order delivery received AFTER
 * the guard shipped — deliveries that cannot be evidence of anything, because by then no order could be
 * created on an invented currency. An indefinite, population-wide retention override on payloads
 * carrying billing and delivery names and addresses is not a thing to leave running on customer
 * installations while an issue waits, and "close the issue, then edit a constant" is not a bound.
 *
 * The exemption is therefore additionally bounded by `receivedAt < cutoff`, where the cutoff is a
 * PER-INSTALLATION instant recorded in the `settings` table
 * (`legacy_wc_order_evidence_cutoff_at`). What that instant marks is not when this code was written —
 * it is when THIS INSTALLATION stopped running the old importer, which is a run-time fact and differs
 * between an install that upgrades today and one that upgrades next month. See
 * `lib/connectors/shopping-webhook-evidence-hold.ts` for how it is established; the short version is
 * that the daily retention pass stamps it the first time it runs under a build carrying the guard, plus
 * a drain margin, insert-only, and never moves it afterwards.
 *
 * WHILE NO CUTOFF IS RECORDED the hold covers EVERY WooCommerce order delivery, at any age. That is the
 * safe direction — over-retain rather than destroy evidence we cannot yet date — and it is not a
 * standing state: the same nightly pass that finds the setting missing records it. It is reached by a
 * fresh installation before its first retention run, and by an installation whose stored value is
 * unreadable (which is never overwritten from here — an unparseable cutoff means "hold everything",
 * not "stamp a new one over it").
 *
 * WHY `resource`, NOT `topic`. `resource` is NOT NULL and IMS writes it itself, from its own routing
 * (`ShoppingWebhookResource` = 'orders' | 'products' | 'refunds'). `topic` is a nullable header value
 * the store supplies, and a nullable column in a negated predicate is a trap: Postgres evaluates
 * `NOT (connector = 'woocommerce' AND topic IN (...))` to NULL for a row whose topic is NULL, so such a
 * row silently leaves the compaction set as well. On `resource` the predicate is two-valued and says
 * exactly what it means. It also does not have to be revised when WooCommerce adds an order topic.
 * `receivedAt` is NOT NULL too (it defaults to `now()`), so adding it to the conjunction keeps the
 * negation two-valued.
 *
 * WHY `receivedAt`, NOT `updatedAt` or `processedAt`. The question the cutoff asks is "could the old
 * importer have been the thing that imported this delivery?", and the delivery's own arrival is the
 * only stamp that cannot move afterwards — `updatedAt` is rewritten by every retry and by the
 * compaction itself. Note the direction of the resulting imprecision: a delivery RECEIVED before the
 * cutoff but IMPORTED after it was already handled by the guarded code and is held anyway. The hold
 * over-retains slightly; it never lets go of a row that could still be evidence.
 *
 * WHAT IT COSTS. Measured on the reference instance 2026-08-29: 451 of 74,124 inbox rows (0.6%) are
 * `orders`-resource — the other 73,673 are product updates, which are the bulk this compaction was
 * added for and which keep compacting exactly as before. The exemption's cost is that WooCommerce order
 * payloads — which carry billing and delivery names and addresses — are retained past the retention
 * window for as long as it is on. With the cutoff in place that cost STOPS GROWING: the held set is
 * whatever had arrived by the cutoff, and every delivery after it compacts on the operator's schedule.
 * It is still a real cost, and it is the reason this is a CODE constant and not a setting: turning the
 * destruction back on should be a reviewed change with `o3d-j7y4` closed behind it, not a toggle
 * someone flips to reclaim disk. It is also surfaced to the operator, beside the retention setting it
 * overrides (Settings > System > Data Retention).
 *
 * TO LIFT IT: close `o3d-j7y4` (or supersede it with a durable record of each order's creator identity
 * that does not depend on the archive), then set this to `false`. The next nightly run compacts the
 * accumulated order rows in one statement.
 */
export const PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE = true

/**
 * The `settings` row holding this installation's cutoff, as an ISO-8601 instant. An ordinary key in the
 * existing key/value settings table on purpose: it needs no schema change, and it is deliberately NOT
 * exposed as an editable field — an operator moving it later would silently widen or narrow a
 * retention exemption from a screen that says nothing about evidence.
 */
export const LEGACY_WC_ORDER_EVIDENCE_CUTOFF_SETTING = 'legacy_wc_order_evidence_cutoff_at'

/**
 * The margin added to the moment the guarded build is first observed running, to reach the cutoff.
 *
 * The event the cutoff wants to mark is "all old importer processes stopped", and no process can
 * observe that directly: what it CAN observe is that code carrying the guard is running now. During a
 * rolling restart the two builds overlap, so a bare observation could in principle land while an old
 * worker is still draining an order. A day's margin puts the cutoff past any drain, at a cost of one
 * further day of order deliveries joining the held set (about 7 rows a day on the reference instance).
 * It errs toward retaining evidence, which is the only direction that is recoverable.
 */
export const LEGACY_IMPORTER_DRAIN_GRACE_MS = 24 * 60 * 60 * 1000

/** The cutoff implied by first observing the guarded build at `observedAt`. */
export function legacyWcOrderEvidenceCutoffFromObservation(observedAt: Date): Date {
  return new Date(observedAt.getTime() + LEGACY_IMPORTER_DRAIN_GRACE_MS)
}

/**
 * The stored cutoff, or `null` for "none recorded" — which the predicate below reads as "hold every
 * WooCommerce order delivery". An unparseable value returns `null` for the same reason: a cutoff we
 * cannot read must not be treated as a licence to destroy.
 */
export function parseLegacyWcOrderEvidenceCutoff(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The rows the hold covers: WooCommerce deliveries about ORDERS that arrived before this installation's
 * cutoff (every one of them, while no cutoff is recorded). Exported so the retention pass, the operator
 * notice and the tests all name the same set.
 */
export function preservedWcOrderEvidenceWhere(
  evidenceCutoff: Date | null,
): Prisma.ShoppingWebhookEventWhereInput {
  return {
    connector: WOOCOMMERCE_CONNECTOR,
    resource: 'orders',
    ...(evidenceCutoff ? { receivedAt: { lt: evidenceCutoff } } : {}),
  }
}

/**
 * The extra conjuncts the shopping-inbox compaction carries while evidence is being preserved — empty
 * when it is not, so the predicate is literally unchanged once the hold is lifted.
 */
export function preservedWcOrderEvidenceExemption(
  evidenceCutoff: Date | null,
): Prisma.ShoppingWebhookEventWhereInput[] {
  if (!PRESERVE_LEGACY_WC_ORDER_CURRENCY_EVIDENCE) return []
  return [{ NOT: preservedWcOrderEvidenceWhere(evidenceCutoff) }]
}

/**
 * The rows the shopping-inbox retention pass may compact at `cutoff`.
 *
 * Only PROCESSED rows: DEAD_LETTER (failed, unresolved — the only record of the failed event) and
 * PENDING/FAILED (undelivered work) are left fully intact. `payloadJson != {}` PERMANENTLY excludes
 * already-compacted rows, so each daily run only touches the newly-eligible set rather than rewriting
 * the whole retained tombstone set. And, while the hold above is on, WooCommerce order deliveries
 * received before `evidenceCutoff` are excluded whatever their age — the ones received after it
 * compact exactly like any other delivery.
 */
export function compactableShoppingWebhookEventWhere(
  cutoff: Date,
  evidenceCutoff: Date | null,
): Prisma.ShoppingWebhookEventWhereInput {
  return {
    status: WC_WEBHOOK_EVENT_STATUS.processed,
    updatedAt: { lt: cutoff },
    NOT: { payloadJson: { equals: {} } },
    AND: preservedWcOrderEvidenceExemption(evidenceCutoff),
  }
}
