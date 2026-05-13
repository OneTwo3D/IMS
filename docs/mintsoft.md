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
- Booked-in webhook processing is idempotent via `wms_inbound_receipt_events`.
- Line deltas are applied only for previously unaccounted received quantities.

## Booked-In Webhook Signing

Mintsoft ASN booked-in webhooks must include:

- `x-mintsoft-signature`: HMAC-SHA256 digest, hex or base64, optionally prefixed with `sha256=`.
- A fresh timestamp, either in `x-mintsoft-timestamp` / `x-webhook-timestamp` / `x-timestamp` or in the payload (`timestamp`, `eventTime`, `occurredAt`, or `createdAt`). Header timestamps take priority when both are present.

The signed payload is:

```text
${timestamp}.${rawBody}
```

The `timestamp` string must be the exact value IMS uses for freshness validation. Prefer ISO-8601 timestamp strings. Numeric JSON timestamps are accepted, but the signature prefix must match the exact JSON numeric token in the raw body; for example, `1776852000.0` and `1776852000` are different signature prefixes. Body-only signatures are rejected by default. `MINTSOFT_ALLOW_LEGACY_BODY_ONLY_SIGNATURE=true` temporarily accepts legacy `HMAC(secret, rawBody)` signatures for rollout compatibility, but webhooks still require a fresh timestamp.

### Migration Runbook

1. Discovery: before deploying this change, check recent sync activity for Mintsoft webhook signature failures and confirm which senders are still using body-only HMAC.
2. Rollout: set `MINTSOFT_ALLOW_LEGACY_BODY_ONLY_SIGNATURE=true` before deploying only if any sender still signs `HMAC(secret, rawBody)`.
3. Sender migration: update each sender to sign `${timestamp}.${rawBody}` using the same timestamp value it sends to IMS, preferably in `x-mintsoft-timestamp`.
4. Monitoring: watch activity-log entries with `action = 'mintsoft_webhook_legacy_signature_accepted'` and `metadata.signatureFormat = 'legacy-body-only'`.
5. Sunset: disable the compatibility flag after 14 consecutive days with zero legacy-signature acceptance entries. Remove the flag by 2026-09-30.

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
