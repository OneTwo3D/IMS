# Changelog

This repository uses an `x.y.z` release scheme.

- Increment `x` for breaking changes.
- Increment `y` for user-facing non-breaking changes.
- Increment `z` for backend-only non-breaking changes that do not affect users directly.

## 1.5.0 - 2026-04-21

### User-facing

- Added the first Mintsoft WMS integration surface in `/sync`, including connection settings, warehouse bindings, plugin gating, and the signed ASN booked-in webhook endpoint.
- Added Mintsoft notification-only stock sync operations: warehouse discovery in the binding dialog, manual sync runs, recent run exports, open discrepancy visibility, and threshold-based in-app recipient notifications.
- Added Mintsoft Phase 3 product verification: IMS product changes now perform a best-effort Mintsoft product sync, and operators can run a manual product verify from the Mintsoft dashboard.
- Greyed out the future `ALIGN_TO_WMS` Mintsoft stock mode in the binding editor so it remains visible without presenting a dead-end selectable path.

### Technical

- Landed the Mintsoft connector foundation, WMS registry wiring, cron registration scaffolding, encrypted Mintsoft secret storage, and Mintsoft-specific order-lookup support.
- Hardened Mintsoft webhook intake with request-size guards, timing-safe HMAC verification, retry-safe event persistence, and targeted regression coverage for signature handling and concurrent idempotency.
- Implemented the Phase 2 Mintsoft stock polling engine, cron execution path, discrepancy/snapshot/job persistence, soft deactivation handover rows, and pure helper coverage for response normalization and threshold handling.
- Implemented Mintsoft's current authentication flow: store username/password, renew the 24-hour API key through `/api/Auth`, persist auth timing metadata, and retry once after a 401 before surfacing the failure.
- Fixed Mintsoft notification-only stock sync so SKUs missing from the Mintsoft feed now raise `MISSING_IN_WMS` discrepancies instead of silently disappearing from review.
- Fixed the Mintsoft discrepancy persistence race so concurrent sync runs now collapse onto a single `OPEN` discrepancy per warehouse/category/product-or-sku.
- Implemented the Mintsoft product sync engine with payload hashing, authoritative product reads, barcode backfill/conflict handling, `WmsProductLink` persistence, the real `mintsoft-product-verify` cron path, and realistic E2E Mintsoft product endpoints for future workflow coverage.
- Corrected Mintsoft product writes to match the documented API shape: create via `PUT /api/Product`, update via `POST /api/Product` with `ID` in the request body, and tightened the E2E simulator so it now rejects the previously incorrect update path.
- Moved best-effort Mintsoft product sync for IMS product edits out of the interactive submit path using Next.js `after()`, so inventory create/update no longer blocks on Mintsoft round-trips.
- Reworked Mintsoft product verify to process eligible products in paged batches with bounded concurrency, improved JSON payload normalization for sync logs, and counted conflict rows that still pushed non-barcode Mintsoft updates as both mismatches and corrected changes.
- Made Mintsoft booked-in webhook processing durable by adding a `mintsoft-webhook-sweeper` cron that drains any `wmsInboundReceiptEvent` rows whose in-process replay failed or raced with ASN finalization, so accepted callbacks can no longer be stranded unprocessed.
- Revalidated outstanding purchase order quantities under the PO row lock immediately before Mintsoft ASN recover/create, aborting and resetting the pending reservation if a manual receipt consumed the outstanding quantity in the interim, so the remote ASN can never publish stock that is already received.
- Fenced the Mintsoft stock-sync stale-job reclaim with a compare-and-swap on the observed lease token and heartbeat timestamp, so a live worker heartbeat can no longer be overwritten by a reclaim that read its state moments earlier.
- Ordered the Mintsoft alignment and booked-in handler `FOR UPDATE` locks on `wms_asn_line_maps` by `id` so concurrent alignment runs and ASN webhook processing always acquire overlapping row locks in the same order, eliminating a deadlock window.
- Escalated the Mintsoft alignment activity log to WARNING with a `reservedExceedsAvailable` flag when post-align reservations still exceed available stock, surfacing stale allocations instead of silently logging the correction.

## 1.4.1 - 2026-04-19

### Technical

- Fixed `scripts/update.sh` so git-based deploys no longer abort under `set -o pipefail` when printing the recent commit list.

## 1.4.0 - 2026-04-19

### User-facing

- Added a guided onboarding setup flow for fresh instances, including fixes for integration gating and hydration issues in the onboarding path.
- Added opening stock CSV import by SKU and warehouse, with quantity and base unit cost validation.
- Improved the Product Profitability report with pagination, column visibility controls, and better table scrolling for larger result sets.

### Technical

- Hardened FIFO, allocation, shipment, refund, and landed-cost accounting behavior across the commerce and Xero workflows.
- Fixed multiple CSV import regressions and added onboarding E2E coverage for the new setup flow.

## 1.3.0 - 2026-04-16

### User-facing

- Added a Shopify connector screen in Integrations for credential setup, webhook-secret management, manual stock sync, and Shopify sync log visibility.
- Added Shopify product and order admin links in the IMS where Shopify matches can be resolved safely.

### Technical

- Implemented the first real Shopify connector layer and connected it to the shared shopping facade and integrations UI.
- Added duplicate-SKU safety checks, retry-safe webhook rejection for unimplemented Shopify webhooks, and persisted Shopify sync attempts into the shared sync log.

## 1.2.0 - 2026-04-16

### User-facing

- Added QuickBooks Online as a fully available accounting connector (OAuth, chart of accounts sync, invoices, bills, credit memos, journal entries, payment polling, daily batch sub-ledger sync).
- QuickBooks is now selectable in the Integrations dashboard alongside Xero.

### Technical

- Full QuickBooks connector module (16 files): OAuth 2.0 with Intuit, HTTP client with rate limiting, split Customer/Vendor contacts, NonInventory items, idempotent sync processor, payment poller with checkpoint-on-success-only.
- Accounting facade, server actions, OAuth callback, and all cron routes now dispatch to the active accounting connector (Xero or QuickBooks).
- Fixed sync processor idempotency: external writes are no longer replayed after partial follow-up failures.
- Fixed stale contact IDs cleared on disconnect to prevent cross-tenant reuse.

## 1.1.0 - 2026-04-16

### User-facing

- Added the current app version as a visible badge in System Settings.

### Technical

- Bumped the tracked release metadata and package version for the 1.1.0 non-breaking release.

## 1.0.0 - 2026-04-16

### User-facing

- Added the Product Profitability analytics page.
- Added Turnstile protection to password login.
- Added release tracking in the UI, including a release history view and release notifications.

### Technical

- Added groundwork for Shopify and QuickBooks connectors, including multi-connector shopping support.
- Hardened install and update scripts for git-based deployments, Prisma client generation, and deployment metadata preservation.
- Removed the legacy shopping webhook route conflict and added a real `/api/health` endpoint for deployment checks.
