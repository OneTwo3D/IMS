# Mintsoft Connector

Mintsoft is the first WMS connector behind the connector-agnostic WMS boundary (see [`wms-connector-boundary.md`](./wms-connector-boundary.md)). It covers stock alignment, ASN creation, product verification, bundle sync, returns polling, signed ASN booked-in webhooks, outbound order-dispatch push (Phase 8), inbound dispatch ingestion (despatch → IMS shipment, with per-part partial shipments to the storefront for split orders and survivor reconciliation for merged orders), and order-status tracking on sales orders.

## Authentication And Bindings

- Connection settings are managed in Sync settings and stored as connector settings.
- Warehouse-level behavior is controlled by `ExternalWmsBinding`.
- `WmsStockSyncMode` decides whether a warehouse is notification-only or allowed to align IMS quantities to Mintsoft.
- `WmsReturnsMode` controls returns polling/webhook behavior per warehouse.

### Authentication mode

Mintsoft's `POST /api/Auth` does **not** hand out a session token. It **mints a
new tenant API key and invalidates the previous one** — the key belongs to the
Mintsoft tenant, not to the caller. Three systems share that tenant:

- this connector
- the `woocommerce-mintsoft-sync` order sweep + webhook
- the `woocommerce-mintsoft-shipping-label-sync` label service

So whenever one of them logs in, the other two are silently knocked offline
until their own refresh cycle runs. Issue **one fixed key** and point all three
at it.

Set the mode under Integrations → Mintsoft → Edit Mintsoft Connection:

| Mode | Behaviour |
|---|---|
| **Username & password** (default) | Logs in and auto-renews the 24-hour key. **Regenerates the tenant key on every renewal.** |
| **Fixed API key** | Uses the configured key verbatim and **never** calls `/api/Auth` — not on a cache miss, not on expiry, not on a 401. A blank key is a hard error, never a fall back to logging in. |

Storage notes:

- The fixed key lives in its own setting, `mintsoft_static_api_key`. It is
  deliberately **not** stored in `mintsoft_api_key` — that key is the cache for
  the rotating 24-hour token, so a credentials-mode refresh would overwrite it.
- Both are in `SENSITIVE_SETTING_KEYS`, so both are encrypted at rest.
- Saving the connection clears the cached rotating token, so no stale token
  survives a switch in either direction.
- In fixed-key mode the connection test does a read-only authenticated `GET`
  rather than logging in — the credentials test would otherwise invalidate the
  very key it is testing.

When switching the estate over, set the key and the mode on **all three**
systems close together: any system still in credentials mode will regenerate
the key and break the ones already switched.

### Connection Test Gate

Mintsoft connector settings cannot be marked active until a **Test Connection** succeeds against the current credential fingerprint. The save form runs the test inline before persisting, so saving with bad credentials is impossible from the UI. The fingerprint (a SHA256 of the credential payload) is written to the activity log on each test, so silent credential rotation is visible in the audit trail. Changing any byte of the credentials invalidates the gate and forces a fresh test before sync resumes.

## Stock Alignment

- Mintsoft stock is normalized and consolidated before comparison with IMS.
- Open discrepancies are stored in `wms_stock_discrepancies`; partial unique indexes prevent duplicate open discrepancy rows for the same connector, warehouse, category, and product/SKU.
- Alignment should only change IMS stock after the binding permits it and discrepancy thresholds are satisfied.

### Align up (Mintsoft holds more)

Upward deltas are absorbed into open ASN lines as provisional goods-in receipts (cost layers from the source PO/transfer line), tracked as alignment snapshot credits that the booked-in webhook later reconciles. A delta no open ASN line can explain stays a manual discrepancy.

### Align down (Mintsoft holds less — shrinkage / already-shipped)

Downward deltas are auto-corrected by posting a negative stock adjustment (FIFO consumption + inventory GL journal via `applyStockAdjustment`), but only when EVERY gate passes; otherwise the discrepancy stays open carrying the hold reason:

1. **Write-off reason configured** — the binding's *Align-Down Write-Off Reason* (an active `AdjustmentReason` **with a GL account code**) must be set; the write-off posts `DR reason-account / CR Inventory`. No reason → align-down never runs.
2. **Thresholds configured and not breached** — the binding's discrepancy thresholds double as the auto-fix ceiling; unconfigured thresholds or a breaching delta stay manual (a WMS API glitch must not write off a warehouse).
3. **No pending inbound** — open ASN lines with outstanding expected receipts or unreconciled alignment credits hold the correction (the lower Mintsoft balance may be receipt timing, not shrinkage).
4. **Persistence across two runs** — the same delta must have been recorded by a *previous* sync run, so in-flight dispatch webhooks/sweeps get a full cycle to land before stock is written off.
5. **Reservations** — on-hand is never driven below `reservedQty`; the oversell aftermath (orders reserving stock that doesn't exist) must be resolved by an operator.

Applied corrections log `mintsoft_align_down_applied` (WARNING) with before/after quantities and the movement id, and are idempotent per sync job. Dry-run mode (before alignment confirmation) previews align-down the same way it previews align-up.

## ASN Flow

- IMS creates outbound ASN payloads for purchase orders and transfer lines.
- Mintsoft callback metadata preserves the source type, source line, product, and expected quantity.
- Booked-in webhook receipt is idempotent via `wms_inbound_receipt_events`.
- Accepted webhooks are persisted and acknowledged with `202 Accepted`; stock and purchase-order mutations run later through `/api/cron/mintsoft-webhook-sweeper`.
- Retry state is stored in typed `wms_inbound_receipt_events` columns: `processingStatus`, `processingAttempts`, `nextRetryAt`, `deadLetteredAt`, and `lastError`. The sweeper selects pending/due rows from these fields directly.
- Booked-in processing looks up the referenced ASN directly by id through the WMS connector. Bulk ASN listing remains available for reconciliation/backfill flows and as a temporary rollback path.
- `/api/cron/mintsoft-webhook-sweeper` drains at most `MINTSOFT_WEBHOOK_SWEEPER_PAGE_SIZE` persisted events per run. Leave it unset for the default `250`.
- Line deltas are applied only for previously unaccounted received quantities.

### Receipt Review

Booked-in callbacks pause in `REQUIRES_REVIEW` before stock mutation when the dry-run finds reconciliation warnings. Events that instead exhaust their retries go `DEAD` and surface in the cross-connector [sync exception inbox](./sync-exceptions.md) (`/sync/exceptions`), which can safely re-queue them.

- Structural warnings block approval until the underlying IMS or Mintsoft data is fixed: remote quantity regression, missing IMS source line, unsupported source type, or missing transfer cost-layer snapshot.
- `received_over_expected` is a variance warning. It always requires admin review, but approval accepts the over-receipt and lets processing continue.
- Approval requires fresh admin auth and the admin mutation header. Successful approvals stamp `reviewedAt` and `reviewedBy`; failed approval attempts remain visible through `lastError` and activity logs without stamping those success fields.
- Activity logs include aggregate and line-level warning details so post-hoc audits can identify which ASN lines were approved.
- The Mintsoft dashboard shows the newest 20 events and the total review backlog. Use the JSON inspection endpoint for full line-level detail until a dedicated review queue UI exists.

### Direct ASN Lookup Rollback

Direct booked-in reconciliation calls Mintsoft's `/api/ASN/:id` endpoint. If staging or production API discovery shows a different direct endpoint shape, set `MINTSOFT_USE_BULK_ASN_LOOKUP=true` to temporarily restore the legacy list-and-match path while the connector endpoint is corrected. Leave it unset or `false` for normal operation.

### Typed Retry-State Migration Runbook

The typed retry-state migration replaces the old `processingError` column with `processingStatus`, `processingAttempts`, `nextRetryAt`, `deadLetteredAt`, and `lastError`. The system was not live when this stage landed, so no runtime compatibility path is retained for encoded retry strings.

## Booked-In Webhook Signing

Mintsoft ASN booked-in webhooks must include:

- `x-mintsoft-signature`: HMAC-SHA256 digest, hex or base64, optionally prefixed with `sha256=`.
- A fresh timestamp in `x-mintsoft-timestamp`, `x-webhook-timestamp`, or `x-timestamp`. New senders should use `x-mintsoft-timestamp`.

The signed payload is:

```text
${timestamp}.${rawBody}
```

### Maintenance-mode fence (o3d-hl8l)

The booked-in webhook route consults maintenance mode as its **first** statement — before the body is read and before the signature is verified — and returns `503 {"skipped":true,"reason":"maintenance_mode"}` while the flag is on. Nothing is persisted and no activity row is written.

The flag is set only by the database **restore** endpoint, and it stays on when a restore backend cannot be confirmed dead. A row written into that window is being replayed over, so persisting the event would return `202 accepted` for something the restore then destroys; a `503` promises nothing and is the standard retry signal.

**If the sender does not retry, the booked-in trigger is dropped** — so there is an explicit way to recreate it. Neither of the existing replay paths could: the sync exception inbox's replay and `replayMintsoftBookedInEventsForAsn` both re-drive receipt-event rows that already exist, and a refused callback leaves none.

**Re-check** (purchase order → the connector ASN table, needs `purchasing.receive`) asks the warehouse directly. It reconstructs the *trigger* only: the webhook carries an ASN id and nothing else that is used, and processing re-fetches the ASN from Mintsoft and applies just the delta over what each line has already accounted. So the warehouse stays the authority for the quantities, pressing it when nothing is outstanding books nothing in, and a real callback arriving afterwards finds the delta applied. If the ASN already has outstanding receipt events (dead-lettered, mid-retry, awaiting review) those are re-driven instead of a second row being created alongside them.

The loss is also detected rather than silent: the `wms-watchdog` cron alerts on an open ASN past its ETA with no booked-in callback (or, with no ETA, one that has been silent for a week). Recovery is operator-initiated, not automatic — nothing but this route and the re-check creates a receipt-event row. Every re-check writes a `mintsoft_asn_booked_in_recheck` activity entry recording whether it minted a trigger or re-drove existing work.

The `timestamp` string must be the exact header value IMS uses for freshness validation. Prefer ISO-8601 timestamp strings. Numeric timestamp headers are accepted, but the signature prefix must match the exact header value; for example, `1776852000.0` and `1776852000` are different signature prefixes. Body-only signatures and payload-only timestamps are rejected.

### Migration Runbook

1. Discovery: before deploying this change, check recent sync activity for Mintsoft webhook signature failures and confirm which senders are still using body-only HMAC.
2. Sender migration: update each sender to send `x-mintsoft-timestamp` and sign `${timestamp}.${rawBody}` using that exact header value.
3. Rollout: deploy only after every sender signs timestamp-bound payloads and sends the timestamp header. Body-only signatures and payload-only timestamps are intentionally unsupported.
4. Monitoring: watch sync activity for `mintsoft_webhook_rejected_missing_timestamp`, `mintsoft_webhook_rejected_stale_timestamp`, and unauthorized responses from the webhook route.

## Product And Bundle Sync

- Product sync normalizes Mintsoft payload variants before creating or updating IMS links.
- Barcode conflicts are surfaced as discrepancies; IMS should not overwrite a non-matching barcode silently.
- Bundle checksums are stable across component order and ignore tiny quantity drift.

## Returns

- Returns are first collected into `wms_returns_inbox`.
- Operators review unmatched returns and choose restock/refund handling.
- Restocking preserves the selected destination warehouse on subsequent polling updates.

## Stocktakes and Mirrored Warehouses

An IMS-side stock count against a WMS-bound warehouse is coordinated with the stock sync (6oyu.3): under **Align To WMS** posting is **blocked** — the WMS is the stock master, so perform the stocktake there and let the sync import the corrections; under **notification-only** posting **warns and requires acknowledgement**, since any remaining divergence against the WMS is re-flagged as a discrepancy on the next sync. Unbound (or sync-disabled) warehouses are unaffected.

## Silent-Failure Watchdog (scheduled)

The `wms-watchdog` cron (hourly, ships disabled — enable in System Settings → Scheduler) alerts once per breach (WARNING activity + admin bell, deduped until the condition heals): **open ASNs past their ETA** (persisted from the ASN dialog) **with no booked-in callback** — naming any unreconciled alignment credits, which silently suppress real PO receipts until the callback arrives — and **bindings without a successful stock sync** for 3× their own cadence (dead cron — or one whose every attempt fails; FAILED attempts don't count as freshness). A fresh callback / ASN close, or the next successful sync, re-arms the alert. If a breach alert cannot be delivered (notification insert fails, or no active admin exists) the breach stays unclaimed for retry and the run returns HTTP 500 so scheduler monitoring goes red.

## Mutation Audit Timeline (q66in.4.6)

Every connector mutation — outbound (order create/update/hold/cancel/release, warehouse comments, ASN create, product/bundle upsert) and inbound (booked-in receipts, align-up/align-down corrections, dispatch application, returns-inbox staging) — records a `WmsMutationEvent` row with operational **before/after images** (states, SKUs, quantities, totals; PII keys are masked at write time by `scrubWmsMutationPayload`). Browse it at **Integrations → Event Timeline** (`/sync/events`): filter by connector/direction/action/outcome or exact entity/external id, and expand a row for the before/after JSON. Recording is best-effort (an audit failure never fails the mutation); rows are purged by the activity-cleanup cron after 365 days.

## Order Reconciliation (scheduled)

The `wms-order-reconcile` cron (default daily, ships disabled — enable in System Settings → Scheduler) runs a connector-agnostic order-level reconcile of IMS intent vs WMS truth (`lib/domain/wms/order-reconcile-sweep.ts`). Because the WMS API cannot enumerate orders, it verifies IMS-known truth per order: eligible orders with no live push link (`NOT_PUSHED`), live links whose WMS order vanished (`MISSING_IN_WMS`), and cancelled/held orders still active in the WMS (`ACTIVE_AFTER_CANCEL` — admins are belled; the warehouse may ship them). Findings land on an `ORDER_RECONCILE` sync job and surface in the [sync exception inbox](./sync-exceptions.md).

## Order Dispatch Push (Phase 8)

IMS pushes sales orders outbound to the WMS so the 3PL can fulfil them. The work is done by a connector-agnostic sweep (`lib/domain/wms/order-push-sweep.ts`) driven by the `wms-order-push` cron (`/api/cron/wms-order-push`, default every 10 minutes). **The cron ships disabled** — enable it in System Settings → Scheduler once a warehouse is bound.

- **Eligibility.** An order is pushed when it is paid, in a ready status (`PROCESSING` or `ALLOCATED`), and its ship-from warehouse is bound to the active WMS. Orders in unbound warehouses are skipped.
- **Idempotency.** Each order tracks one `WmsOrderPushLink` (unique per order). Create uses the order's external reference so a re-run never double-creates. State machine: `PENDING_CREATE → SYNCED`, then `HELD` (order put on hold), `CANCELLED` (order cancelled), or `DEAD_LETTER` (repeated failures or an unresolvable conflict).
- **Claim before the remote call (o3d-5r8).** The create pass writes the `PENDING_CREATE` link **before** it calls the WMS, inside a transaction that takes the sales order's row lock. That link is the deleter's evidence: `deleteSalesOrder` takes the same lock and **refuses to hard-delete any order that has a push link at all** (`Cancel the order instead so the WMS order is withdrawn`). Without the pre-push claim, a hard delete landing while a create was on the wire left the WMS holding an order IMS had no record of. Deleting an order is therefore never the way to withdraw it from the WMS — cancel it, and the cancel pass propagates the cancellation.
- **Create / update / cancel.** New eligible orders are created in the WMS; subsequent edits while the WMS order is still `NEW` are amended; orders put on hold are cancelled in the WMS and parked `HELD` (and re-created if released); IMS-cancelled orders propagate a cancel.
- **Retries.** A failed push increments an attempt counter and retries on the next sweep; after 5 attempts it dead-letters for manual review rather than looping forever. A line with no SKU fails the whole order (never a silent partial push).
- **Couriers.** The order's shipping service is mapped to a Mintsoft `CourierServiceId` via the courier map; unmapped services fall back to the default courier id, or pass the name through for Mintsoft to resolve.

## Dispatch Ingestion & Reconciliation (Phase 8)

The reverse direction — WMS despatch → IMS shipment — is driven by the **connector-agnostic** dispatch sweep (`lib/domain/wms/dispatch-sweep.ts`, hoisted from the Mintsoft module in `q66in.1.3`), triggered by the `mintsoft-dispatch-sync` cron (`/api/cron/mintsoft-dispatch-sync`, every 15 min — the poll is Mintsoft's path; ShipHero ingests despatch via webhooks). It polls pushed-but-not-shipped links (`WmsOrderPushLink.state` in `SYNCED`/`MERGED`) and feeds despatches into `applyExternalFulfillmentUpdate`, which progresses the IMS shipment to `SHIPPED` and carries the tracking number/courier through (and, for storefront orders, onward to WooCommerce so the customer is emailed — see [`woo-mintsoft-plugin-parity-gap.md`](./todo/woo-mintsoft-plugin-parity-gap.md)). The per-order step `reconcileOneOrder` is exported so a webhook-primary WMS can reconcile a single order on a shipment event.

- **Despatch detection.** Each connector normalises a `dispatched` flag onto `WmsOrderStatus`/`WmsOrderPart` (Mintsoft: status `DESPATCHED`/`INVOICED` or a tracking despatch date; ShipHero: `fulfilled`), so the sweep stays connector-agnostic.
- **Split orders.** Mintsoft can split an order into N parts that despatch independently. Each despatched part is pushed to the storefront as a **partial shipment** (the onetwoInventory Helper plugin records it into the storefront's partial-shipment UI + customer email; idempotent per part). The IMS order is marked `SHIPPED` only once **every** part has despatched, using `NumberOfParts` as the authoritative total. Tracking from all parts is aggregated onto the single IMS shipment.
- **Merged orders.** When Mintsoft merges an order into a survivor (combined `a+b` OrderNumber), the original WMS order is destroyed. The link is **repointed** to the survivor and parked `MERGED` so the outbound push sweep's `SYNCED`-only update/cancel/hold passes skip it (no dual-sync amending the survivor). A merged **and** split survivor is reconciled **atomically** (no per-part partial shipments — its parts mix several original orders), completing the IMS order when the survivor is fully despatched.
- **Idempotency.** A dispatched order reconciles to `SHIPPED` and drops out of the poll set; partial-shipment pushes are de-duplicated per `(order, part)` on the storefront side.
- **Tool-agnostic.** The whole reconcile (`lib/domain/wms/dispatch-sweep.ts`) is behind the generic `WmsConnector` contract — the connector supplies `fetchOrderStatus` (with `dispatched`/`isMerged`/`isSplit`), `fetchOrderParts`, and `fetchOrderPartItems`; the storefront write goes via the shopping facade. A second WMS inherits dispatch/split/merge by implementing the contract.

## Order Status Chip

In-flight orders show a WMS status chip on the sales list and detail pages. The cached value is refreshed by the `wms-order-status` cron (`/api/cron/wms-order-status`, default every 15 minutes) and the detail page also fetches live on load. The chip deep-links to the order in the WMS admin using the admin order URL template.

The connector builds that deep link and stores it on the cached snapshot (core flows never reference a connector-specific URL format — see the connector boundary). So a change to the admin URL template reaches the **list** chips on the next status sweep, while the **detail** page — which queries the connector live — reflects it immediately.

## Connector Settings

Beyond credentials, these connector settings drive dispatch and status. All are editable under Integrations → Mintsoft (no DB access required).

| Setting | Purpose | Default |
|---|---|---|
| `mintsoft_admin_order_url_template` | Deep-link target for the order-status chip; `{id}` is replaced with the Mintsoft order id | `https://app.fulfillable.co.uk/Order/Details/{id}` |
| `mintsoft_default_courier_service_id` | Fallback `CourierServiceId` when a shipping service isn't in the map; blank means no fallback | _(blank)_ |
| `mintsoft_courier_service_map` | JSON map of IMS shipping-service name → Mintsoft `CourierServiceId`, e.g. `{ "Royal Mail Tracked 24": 12 }` | _(blank)_ |

The courier id map is strict: values must resolve to positive integers (numeric strings like `"12"` are accepted; decimals, negatives, and trailing junk are rejected).

### Configuration-change audit (q66in.7.2)

Connection, binding, courier-map and order-dispatch saves all write an activity entry carrying a **before/after diff**, not just the new values. Only fields that actually moved appear, so an unchanged save is silent.

| Action | Entry |
|---|---|
| Connection save | `mintsoft_connection_updated` — base URL, label, lookup connector, active, auth mode, and **which secret slots were rotated**. Secret values never appear; presence is recorded as booleans and `scrubWmsMutationPayload` masks credential-shaped keys as defence in depth |
| Binding save | `mintsoft_binding_updated` / `mintsoft_binding_created` — every operator-settable binding field, including the stock-sync mode, thresholds, recipients and align-down reason |
| Courier map save | `mintsoft_courier_map_updated` — added / changed / **removed** service names, plus both maps. A removal is logged at `WARNING`: a dropped entry silently falls back to the default courier id |
| Order dispatch save | `mintsoft_order_dispatch_settings_updated` — logged at `WARNING` when the ClientId/ChannelId/WarehouseId delta scope changes, because that also **discards the delta cursors** |

Both the connection save and the order-dispatch save read their **before** image inside the write transaction, behind a row lock on the rows being replaced. Reading it beforehand let two concurrent saves produce an entry describing a transition that never happened — and, for the dispatch save, decide the delta-cursor reset from the same stale value.

### Retention (q66in.7.4)

Two System Settings → Data Retention windows cover the WMS tables:

- **WMS Inbound Events** (default 3 months) — **compacts** resolved (`PROCESSED`) rows in `wms_inbound_receipt_events` and `wms_webhook_events`: the `payload` (and the receipt table's `reviewDetails` dry-run image) is cleared, the row itself is kept because `(connector, externalEventId)` is the idempotency key that stops a redelivered callback booking stock twice. `DEAD`, `REQUIRES_REVIEW`, `PENDING`, `PENDING_RETRY` and `FAILED_RETRY` rows are **never** touched — a dead letter is replayable evidence, not an old row.
- **WMS Sync Runs** (default 12 months) — deletes **finished** `wms_sync_jobs` rows, which cascades their per-SKU `wms_sync_logs` lines. Unfinished (`PENDING`/`RUNNING`) runs are kept: an old timestamp on a stuck run is a reason to keep it, not to remove it. So is **the one dry run** each unconfirmed `ALIGN_TO_WMS` binding is waiting on — the exact row `confirmMintsoftAlignmentMode` reads, resolved through the shared `alignmentDryRunEvidenceQuery` so retention and the confirm action cannot ask different questions. It is deliberately one row and not the whole warehouse: a stock sync writes one log line per checked SKU per run and runs on a schedule, so pinning every run for a warehouse would have exempted the highest-volume table here without bound, for as long as an operator left the decision open. A binding with no qualifying dry run pins nothing. The 12-month default matches the 365-day mutation-audit window the runs are correlated with.

## Operational Notes

- Keep connector-setting-mutating e2e specs serialized. The Playwright `wc-isolated` project already does this for Mintsoft/WooCommerce/security flows.
- When adding new Mintsoft API shapes, add boundary normalization tests in `tests/*.test.ts` before wiring UI behavior.
