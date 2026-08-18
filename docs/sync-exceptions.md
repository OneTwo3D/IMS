# Sync Exception Inbox

`/sync/exceptions` aggregates every terminal sync failure state across connectors into one operator surface, with safe manual replay. A summary banner on the Integrations page (`/sync`) shows the live total. (bd `onetwo3d-ims-q66in.4.2`.)

Replays always re-attempt the **original** work: payloads and idempotency keys are preserved, and every transition is a compare-and-set (a concurrent sweep or second click matches zero rows instead of double-applying). All replay actions require the `sync` permission; the high-risk ones (outbox, receipt events, refunds) additionally require fresh (step-up) authentication.

**Preserving the key is not the same as being protected by it.** The compare-and-set stops *IMS* double-applying; whether the *remote system* deduplicates the re-post is the remote system's rule, and for Xero the key survives only 6 minutes — far less than any row spends in this inbox. Before replaying an accounting outbox row, check the ledger for the document: see [Retrying is not protected by idempotency](xero-sync.md#retrying-is-not-protected-by-idempotency--check-xero-first).

## Sections

| Section | Source of truth | What it means | Replay |
|---|---|---|---|
| WMS order pushes — dead-lettered | `wms_order_push_links` `state=DEAD_LETTER` | The order never reached the warehouse (5 attempts exhausted, or a hold/cancel conflict) and will not fulfil | Reset to `PENDING_CREATE` for the next push sweep (`replayWmsOrderPush`; sweep eligibility still applies) |
| Integration outbox — failed rows | `integration_outbox` `RETRYABLE_FAILED` / `PERMANENT_FAILED` | An accounting post, WooCommerce stock push, booked-in event or landed-cost journal exhausted its retries | Reset to `PENDING` with the original payload + idempotency key; or acknowledge as permanently failed. Note: a PERMANENT_FAILED WC stock row's *stock value* still self-heals via the daily force-all reconcile — the row records that the queued push failed |
| WMS inbound events — dead-lettered | `wms_inbound_receipt_events` + `wms_webhook_events`, `processingStatus=DEAD` | A booked-in or order/inventory webhook exhausted its retries; its effect was **never applied** | Reset to `PENDING` (retry ladder restarted) for the relevant webhook sweeper. Distinct from `REQUIRES_REVIEW`, which is approved from the Mintsoft panel. **Retention never touches these rows** (q66in.7.4): only `PROCESSED` rows are compacted, so a dead letter keeps the payload a replay re-attempts, however old it gets |
| WooCommerce refunds — parked | `shopping_sync_logs` `PENDING`/`FAILED`, `FROM_CONNECTOR`, `SalesOrder` | A WC refund could not be applied (usually a >1p amount mismatch); no restock/credit note was posted | Re-runs `syncRefundsForOrder` — a **fresh fetch** from WooCommerce (dedup by `externalRefundId`), so a since-corrected refund now lands. The row is marked SYNCED only when the specific refund verifiably applied |
| Dispatch reconciliation — dead-lettered | `wms_order_push_links.dispatchDeadLetteredAt` (6oyu.2) | The WMS despatched the order but IMS could not reconcile it (typically no IMS stock to consume); after 5 consecutive sweep failures the link is dead-lettered, leaves the sweep's candidate set, and admins are notified | Fix the order's stock position, then Replay — clears the dead-letter marker and failure streak so the next sweep retries |
| WMS pushes — order-total mismatches | `wms_order_push_links.totalMismatchPence` | Advisory: the order pushed, but IMS and WMS totals drifted by >1p | Review the order, then clear the flag |
| WooCommerce products — structure conflicts | `shopping_sync_logs` `QUARANTINED`, `FROM_CONNECTOR`, `Product` (o3d-y89x) | The product import refused to overwrite IMS-owned structure, so WooCommerce data went unapplied. One rule, four shapes: (a) a **variable** WC product paired with an IMS row that cannot be a parent — a KIT/BOM/VARIANT/NON_INVENTORY row, a row already somebody else's variation, a row that already has child rows its type does not allow, or a row carrying stock or open documents — so none of its variations were imported; (b) a **simple** WC product paired with an IMS **VARIABLE** row — its type and price went unwritten and its IMS variants remain; (c) a **simple** WC product paired with an IMS row that has child rows while its type says it cannot (a legacy half-flattened parent) — its type and price went unwritten too; (d) a variation SKU that resolved to a row belonging to a different IMS parent / that is itself a parent / whose type cannot be a variation / that carries stock or open documents. Orders for unimported SKUs import with no product and no allocation. An IMS KIT paired with a **simple** WC product is the ordinary bundle pairing and does **not** appear here. See [What the connector will NOT change](woocommerce.md#what-the-connector-will-not-change) | **None — and deliberately so.** The product is not marked SYNCED and the reconcile cursor does not advance past it, so the retry is automatic every run. Exactly one open row per pairing, and the next clean sync deletes it. Fix the mismatch in IMS or in WooCommerce; there is nothing to acknowledge (an acknowledge button could only hide a live conflict) |
| Order reconciliation — drift | `wms_order_discrepancies` OPEN rows (q66in.4.4, cron `wms-order-reconcile`; runs also ledger onto `ORDER_RECONCILE` sync jobs) | Scheduled IMS-intent-vs-WMS-truth check: `NOT_PUSHED` (eligible order never reached the WMS), `MISSING_IN_WMS` (WMS lost a live order), `ACTIVE_AFTER_CANCEL` (cancelled order still live in the WMS — admins are belled on first detection; it may ship). Findings are durable: the capped sweep rotates least-recently-verified links and resolves a row only when that specific order re-verifies clean | `MISSING_IN_WMS`: Re-push (link reset to `PENDING_CREATE`; resolves the finding). Others: fix at the linked order / in the WMS |

## Recording a quarantined WooCommerce refund by hand (o3d-w00)

A parked refund row is `PENDING`/`FAILED` (retryable) or `QUARANTINED`. A QUARANTINED row was refused
deliberately — an undeterminable gross→net basis, or an order that is not uniformly taxed — so Retry
only re-runs the same refusal. Those rows get a **Record manually** dialog: the operator says which
parts of the order the money came off and how much of each, in **GROSS (tax-inclusive)** amounts.

- Every order line **and the shipping charge** is an allocation target, each offered at what it has left
  to refund after earlier credits.
- The allocation must add up to the WooCommerce refund the park carries, to the penny. A park written
  before the payload was retained cannot be recorded — use Retry first, which re-reads the refund from
  WooCommerce and re-parks it with the payload.
- The credit note is raised **line-linked**, stamped with the WooCommerce refund id (so a redelivery
  dedups), and the park is resolved.

### Why a target can be refused, and what fixes it

Each gross amount is divided by the rate the credit note will actually be re-grossed at — the rate of
the **accounting tax code** the refund line will carry, which is not always the rate the order line
appears to show. The rate the part of the order was **charged** at is read from the order's own money
(`SalesOrderLine.totalForeign` / `taxForeign`, and `SalesOrder.taxRatePercent` for shipping), never from
the current tax table, because a `TaxRate` row is mutable and editing one would otherwise rewrite what
past orders appear to have been billed. Where the two cannot be shown to agree, the target is refused
rather than converted at a rate that will not be used:

| Refusal | Fix |
|---|---|
| The line's tax rate has no accounting tax code (so it falls back to the order default) | Map it in Settings → Tax Rates |
| The code no IMS tax rate is mapped to, or that two rates price differently | Map one — and only one — sales rate to that code |
| The code prices at a different rate from the one the line was charged at | Map the line's tax rate to a code that matches the rate it was sold at |
| The order's default rate (`taxRateName`) is missing, renamed or deactivated — shipping has no identity | Restore/map that tax rate |
| The line is reverse-charged but no reverse-charge sales tax code is set | Set it in Settings → Accounting |
| The reverse-charge code has no IMS tax rate mapped to it | Map a 0% rate to it — an unmapped code is not a 0% one |
| The line records no usable money (no stored net, or figures too small to fix a rate) | Allocate the refund to the parts of the order that carry the money |
| "The VAT identity … changed while this refund was being recorded" | The tax configuration moved between the conversion and the posting. Nothing was credited — record the row again |

## Relationship to other surfaces

- The **FailedSyncBanner** (accounting sync-log rows) and **ConnectorOrphanBanner** keep their own retry paths on `/sync`; the inbox does not duplicate them.
- The Mintsoft panel's **Receipt Reviews** section still owns `REQUIRES_REVIEW` approvals (fresh-admin + review dialog); the inbox owns the `DEAD` tail that panel never showed.
- The admin API routes (`/api/admin/outbox/[id]/replay`, `.../permanent-fail`) remain available for tooling; the inbox's server actions call the same domain transitions (`lib/domain/integrations/outbox-admin.ts`).
- The unified "Needs attention" notification surface (bd `onetwo3d-ims-6oyu.11`) will build on this inbox's summary counts.
