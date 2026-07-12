# Sync Exception Inbox

`/sync/exceptions` aggregates every terminal sync failure state across connectors into one operator surface, with safe manual replay. A summary banner on the Integrations page (`/sync`) shows the live total. (bd `onetwo3d-ims-q66in.4.2`.)

Replays always re-attempt the **original** work: payloads and idempotency keys are preserved, and every transition is a compare-and-set (a concurrent sweep or second click matches zero rows instead of double-applying). All replay actions require the `sync` permission; the high-risk ones (outbox, receipt events, refunds) additionally require fresh (step-up) authentication.

## Sections

| Section | Source of truth | What it means | Replay |
|---|---|---|---|
| WMS order pushes — dead-lettered | `wms_order_push_links` `state=DEAD_LETTER` | The order never reached the warehouse (5 attempts exhausted, or a hold/cancel conflict) and will not fulfil | Reset to `PENDING_CREATE` for the next push sweep (`replayWmsOrderPush`; sweep eligibility still applies) |
| Integration outbox — failed rows | `integration_outbox` `RETRYABLE_FAILED` / `PERMANENT_FAILED` | An accounting post, WooCommerce stock push, booked-in event or landed-cost journal exhausted its retries | Reset to `PENDING` with the original payload + idempotency key; or acknowledge as permanently failed. Note: a PERMANENT_FAILED WC stock row's *stock value* still self-heals via the daily force-all reconcile — the row records that the queued push failed |
| WMS inbound events — dead-lettered | `wms_inbound_receipt_events` + `wms_webhook_events`, `processingStatus=DEAD` | A booked-in or order/inventory webhook exhausted its retries; its effect was **never applied** | Reset to `PENDING` (retry ladder restarted) for the relevant webhook sweeper. Distinct from `REQUIRES_REVIEW`, which is approved from the Mintsoft panel |
| WooCommerce refunds — parked | `shopping_sync_logs` `PENDING`/`FAILED`, `FROM_CONNECTOR`, `SalesOrder` | A WC refund could not be applied (usually a >1p amount mismatch); no restock/credit note was posted | Re-runs `syncRefundsForOrder` — a **fresh fetch** from WooCommerce (dedup by `externalRefundId`), so a since-corrected refund now lands. The row is marked SYNCED only when the specific refund verifiably applied |
| Dispatch reconciliation — dead-lettered | `wms_order_push_links.dispatchDeadLetteredAt` (6oyu.2) | The WMS despatched the order but IMS could not reconcile it (typically no IMS stock to consume); after 5 consecutive sweep failures the link is dead-lettered, leaves the sweep's candidate set, and admins are notified | Fix the order's stock position, then Replay — clears the dead-letter marker and failure streak so the next sweep retries |
| WMS pushes — order-total mismatches | `wms_order_push_links.totalMismatchPence` | Advisory: the order pushed, but IMS and WMS totals drifted by >1p | Review the order, then clear the flag |

## Relationship to other surfaces

- The **FailedSyncBanner** (accounting sync-log rows) and **ConnectorOrphanBanner** keep their own retry paths on `/sync`; the inbox does not duplicate them.
- The Mintsoft panel's **Receipt Reviews** section still owns `REQUIRES_REVIEW` approvals (fresh-admin + review dialog); the inbox owns the `DEAD` tail that panel never showed.
- The admin API routes (`/api/admin/outbox/[id]/replay`, `.../permanent-fail`) remain available for tooling; the inbox's server actions call the same domain transitions (`lib/domain/integrations/outbox-admin.ts`).
- The unified "Needs attention" notification surface (bd `onetwo3d-ims-6oyu.11`) will build on this inbox's summary counts.
