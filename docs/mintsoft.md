# Mintsoft Connector

Mintsoft is the first WMS connector behind the connector-agnostic WMS boundary (see [`wms-connector-boundary.md`](./wms-connector-boundary.md)). It covers stock alignment, ASN creation, product verification, bundle sync, returns polling, signed ASN booked-in webhooks, outbound order-dispatch push (Phase 8), inbound dispatch ingestion (despatch → IMS shipment, with per-part partial shipments to the storefront for split orders and survivor reconciliation for merged orders), and order-status tracking on sales orders.

## Authentication And Bindings

- Connection settings are managed in Sync settings and stored as connector settings.
- Warehouse-level behavior is controlled by `ExternalWmsBinding`.
- `WmsStockSyncMode` decides whether a warehouse is notification-only or allowed to align IMS quantities to Mintsoft.
- `WmsReturnsMode` controls returns polling/webhook behavior per warehouse.

### Connection Test Gate

Mintsoft connector settings cannot be marked active until a **Test Connection** succeeds against the current credential fingerprint. The save form runs the test inline before persisting, so saving with bad credentials is impossible from the UI. The fingerprint (a SHA256 of the credential payload) is written to the activity log on each test, so silent credential rotation is visible in the audit trail. Changing any byte of the credentials invalidates the gate and forces a fresh test before sync resumes.

## Stock Alignment

- Mintsoft stock is normalized and consolidated before comparison with IMS.
- Open discrepancies are stored in `wms_stock_discrepancies`; partial unique indexes prevent duplicate open discrepancy rows for the same connector, warehouse, category, and product/SKU.
- Alignment should only change IMS stock after the binding permits it and discrepancy thresholds are satisfied.

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

Booked-in callbacks pause in `REQUIRES_REVIEW` before stock mutation when the dry-run finds reconciliation warnings.

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

## Order Dispatch Push (Phase 8)

IMS pushes sales orders outbound to the WMS so the 3PL can fulfil them. The work is done by a connector-agnostic sweep (`lib/domain/wms/order-push-sweep.ts`) driven by the `wms-order-push` cron (`/api/cron/wms-order-push`, default every 10 minutes). **The cron ships disabled** — enable it in System Settings → Scheduler once a warehouse is bound.

- **Eligibility.** An order is pushed when it is paid, in a ready status (`PROCESSING` or `ALLOCATED`), and its ship-from warehouse is bound to the active WMS. Orders in unbound warehouses are skipped.
- **Idempotency.** Each order tracks one `WmsOrderPushLink` (unique per order). Create uses the order's external reference so a re-run never double-creates. State machine: `PENDING_CREATE → SYNCED`, then `HELD` (order put on hold), `CANCELLED` (order cancelled), or `DEAD_LETTER` (repeated failures or an unresolvable conflict).
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

## Operational Notes

- Keep connector-setting-mutating e2e specs serialized. The Playwright `wc-isolated` project already does this for Mintsoft/WooCommerce/security flows.
- When adding new Mintsoft API shapes, add boundary normalization tests in `tests/*.test.ts` before wiring UI behavior.
