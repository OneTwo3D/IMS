# Mintsoft Connector

Mintsoft is the WMS connector for stock alignment, ASN creation, product verification, bundle sync, returns polling, and signed ASN booked-in webhooks.

## Authentication And Bindings

- Connection settings are managed in Sync settings and stored as connector settings.
- Warehouse-level behavior is controlled by `ExternalWmsBinding`.
- `WmsStockSyncMode` decides whether a warehouse is notification-only or allowed to align IMS quantities to Mintsoft.
- `WmsReturnsMode` controls returns polling/webhook behavior per warehouse.

## Stock Alignment

- Mintsoft stock is normalized and consolidated before comparison with IMS.
- Open discrepancies are stored in `wms_stock_discrepancies`; partial unique indexes prevent duplicate open discrepancy rows for the same connector, warehouse, category, and product/SKU.
- Alignment should only change IMS stock after the binding permits it and discrepancy thresholds are satisfied.

## ASN Flow

- IMS creates outbound ASN payloads for purchase orders and transfer lines.
- Mintsoft callback metadata preserves the source type, source line, product, and expected quantity.
- Booked-in webhook receipt is idempotent via `wms_inbound_receipt_events`.
- Accepted webhooks are persisted and acknowledged with `202 Accepted`; stock and purchase-order mutations run later through `/api/cron/mintsoft-webhook-sweeper`.
- Booked-in processing looks up the referenced ASN directly by id through the WMS connector. Bulk ASN listing remains available for reconciliation/backfill flows and as a temporary rollback path.
- Line deltas are applied only for previously unaccounted received quantities.

### Direct ASN Lookup Rollback

Direct booked-in reconciliation calls Mintsoft's `/api/ASN/:id` endpoint. If staging or production API discovery shows a different direct endpoint shape, set `MINTSOFT_USE_BULK_ASN_LOOKUP=true` to temporarily restore the legacy list-and-match path while the connector endpoint is corrected. Leave it unset or `false` for normal operation.

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

## Operational Notes

- Keep connector-setting-mutating e2e specs serialized. The Playwright `wc-isolated` project already does this for Mintsoft/WooCommerce/security flows.
- When adding new Mintsoft API shapes, add boundary normalization tests in `tests/*.test.ts` before wiring UI behavior.
