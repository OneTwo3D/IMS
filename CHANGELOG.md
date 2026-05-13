# Changelog

This repository uses an `x.y.z` release scheme.

- Increment `x` for breaking changes.
- Increment `y` for user-facing non-breaking changes.
- Increment `z` for backend-only non-breaking changes that do not affect users directly.

## Unreleased - target 2.0.0

### User-facing (sales allocation and backorders)

- **Sales allocation now distinguishes physical reservations from backorder demand.** Auto-allocation reserves only stock that physically exists; oversell-eligible shortfalls remain unallocated and appear as backorder demand instead of inflating `reservedQty`. Operators may see existing phantom over-reservations corrected on the next re-allocation, with affected lines shown as `Backorder` or `Unallocated` in the sales-order allocation panel.
- **Allocation activity logs include backorder details.** Allocation entries can now include unallocated quantities and per-line backorder metadata. The activity-log UI has no action allowlist, but downstream log parsers should expect the new `backorder_recorded` action and the longer allocation descriptions.

### Breaking operator change (cron authentication)

- **Production cron endpoints now require bearer authentication by default.** Localhost-only cron calls without `Authorization: Bearer $CRON_SECRET` will receive `401` in production. This is an operator-facing breaking change and should ship in the next major release (`2.0.0` under the release scheme above).
- **Before deploying this change, update existing production crontabs.** Replace bare localhost cron calls with commands that read `CRON_SECRET` from the protected app environment file and send the cron bearer token, for example:

  ```bash
  CRON_SECRET=$(grep -m 1 '^CRON_SECRET=' /opt/one-two-inventory/.env | cut -d= -f2-) && curl -fsS -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/fx-rates
  ```

- **Fresh installs are handled by `scripts/install.sh`.** Installer-generated cron entries now read only the `CRON_SECRET=` line from `${APP_DIR}/.env` at runtime, keeping the cron secret in the existing `imsapp:imsapp` mode-`600` environment file instead of duplicating it into the crontab or sourcing the full environment file.
- **Emergency bypass is explicit and narrow.** Production localhost bypass is only available when `CRON_SECRET` is not configured and `ALLOW_LOCALHOST_CRON_BYPASS=true` is set. Do not use this on shared or externally reachable deployments.

## 1.10.0 - 2026-04-25

### Features (FX integration cutover tooling)

- **Helper-plugin reachability probe.** Settings → Accounting → FX Rates now has a "Probe helper plugin" button. It POSTs a deliberately invalid HMAC signature to the WordPress endpoint and inspects the response: an HTTP 401 with `oti_fx_bad_sig` proves the plugin is installed *and* signature verification is active; `oti_fx_no_secret` flags that the operator hasn't pasted the shared secret on the WP side; 404/405 means the plugin isn't activated. Lets operators verify the integration in seconds before flipping push on.
- **Integration health card.** Same panel surfaces the ECB last-fetch time, the WooCommerce last-push time, and the count of currencies under manual override — each turning amber once stale (>36 h since last fetch / push). Pulls a single `getFxHealth()` snapshot, no extra round-trips on render.
- **Cutover runbook.** New `docs/todo/unified-fx-rates-cutover.md` with step-by-step operator instructions for switching a live tenant to the unified FX flow: pre-flight checks, plugin install, Aelia handover, smoke test, first-week monitoring, and rollback. Phase 5 of the unified-FX plan.

## 1.9.1 - 2026-04-25

### Fixes (Codex review of Phase 1–4 FX work)

- **QuickBooks now stamps ExchangeRate from `currencyRateToBase`.** Phase 1 added `currencyRateToBase` to every accounting payload but the QuickBooks adapter was dropping it before the API call, so QBO continued applying its own daily rate on multi-currency invoices/bills/credit memos and drifted from IMS by 1–3%. New helper `imsRateToQboExchangeRate()` (sibling of the Xero one) inverts to QBO's `1 doc-currency = X base` convention at 6dp; threaded through `pushSalesInvoice`, `pushPurchaseBill`, and `pushCreditMemo` and wired into `lib/connectors/quickbooks/sync-processor.ts` for all three call sites.
- **Manual *Mark Received* on a partially-booked transfer no longer double-counts inventory.** When a Mintsoft (or other WMS) callback booked in part of a stock transfer and stamped `qtyReceived` + a `TRANSFER_IN` movement + cost-layer slice, the manual close-out path in `app/actions/transfers.ts` was still receiving the *full* line quantity, recreating the entire snapshot, and over-stating destination stock + cost layers by the already-booked amount. The path now reads each line's `qtyReceived`, posts a movement only for the remaining portion, and slices the snapshot via `sliceTransferSnapshotForReceipt` (the same algorithm the WMS handler uses) so each unit is accounted for exactly once across both paths. Lines already fully received via WMS are skipped.

## 1.9.0 - 2026-04-25

### Features (FX rates admin UI)

- **New Settings → Accounting → FX Rates tab.** Shows the current rate per non-base currency with a source badge (ECB/frankfurter or Manual override) and the last-fetched timestamp. Admins can pin a manual rate per currency via a pencil icon — while pinned, the daily ECB fetch skips that currency so the override sticks. Click the undo icon to clear an override and re-fetch from frankfurter.
- **Push log.** Same panel includes a recent-pushes table (one row per fan-out attempt to a shopping connector — currently WooCommerce). Backed by a new `FxRatePushLog` table; both the FX cron and the manual *Push Now* button record success/failure here. Replaces the activity-log-only history.
- **Schema additions.** `FxRate` now carries `source` (`'frankfurter'` or `'manual'`) and `manualOverride` flags so the fetch loop can honour overrides without hard-coding rules. Migration `20260425100000_fx_rate_overrides_and_push_log` adds these plus the new `fx_rate_push_log` table.

## 1.8.0 - 2026-04-25

### Features (FX rate alignment with WooCommerce)

- **onetwoInventory Helper WordPress plugin.** New unified companion plugin that consolidates the existing invoice-buttons module and adds a signed REST endpoint for receiving FX rates from IMS. Old `wc-invoice-buttons.php` removed in favour of `lib/connectors/woocommerce/wp-plugin/onetwoinventory-helper.php`. Installable directly from the IMS WC sync page via a "Download plugin (.zip)" button — no manual file copying. The plugin exposes a settings screen at WP admin → Settings → onetwoInventory where the shop owner pastes the same shared secret used for WC webhooks.
- **FX rate push to WooCommerce.** With the helper plugin installed and "Push FX rates daily" enabled in the IMS WC sync page, the daily FX cron now fans out to WC after the inbound fetch (HMAC-SHA256 signed). The plugin makes those rates available to Aelia Currency Switcher via the `wc_aelia_currencyswitcher_exchange_rate` filter, so cart conversions, displayed prices and order currency stamps all use the same rate as IMS and Xero. Direct, inverted, and cross-rate conversions are all resolved through IMS's stored rates.
- **Connector-agnostic plumbing.** `ShoppingConnector` interface now carries an optional `pushFxRates(rates)` capability — implemented by the WC adapter today, available for future Shopify/other adapters without IMS changes. `FxRatePush` and `FxRatePushResult` types live in `lib/connectors/types.ts`.

## 1.7.2 - 2026-04-25

### Fixes (Xero FX rate alignment)

- **Xero now uses IMS's stored FX rate.** Sales invoices, purchase bills and credit notes posted to Xero are now stamped with `CurrencyRate` derived from the IMS `fxRateToBase` on the source document. Previously Xero substituted its own daily XE rate, causing 1–3 % drift between IMS and Xero base-currency totals on the same multi-currency document. New helper `imsRateToXeroCurrencyRate()` inverts IMS's "1 base = X foreign" convention into Xero's "1 foreign = X base" at 6dp (matching Xero's `Decimal(18,6)` schema). Connector contract updated: `InvoiceData` / `BillData` / `CreditNoteData` accept an optional `currencyRateToBase` field, kept connector-agnostic so QuickBooks (and future accounting connectors) can adopt the same field. WooCommerce order import, the manual sales invoice queue, the credit-note queue and the purchase-invoice queue all stamp the rate on their payloads. First step toward the unified-FX plan in `docs/todo/unified-fx-rates-plan.md` that aligns rates across IMS, WooCommerce/Aelia and Xero.

## 1.7.1 - 2026-04-25

### Fixes (manufacturing-cost component, post-review)

- **Sync processors now handle the new types.** `MANUFACTURING_JOURNAL` and `MANUFACTURING_RECLASS` were missing from the Xero and QuickBooks sync-processor switches, causing queued rows to fail with `Unknown sync type` and never post. Both processors now route them through `pushManualJournal` / `pushJournalEntry` like other journal types.
- **Reclass journal now captures the inventory leg.** Retro edits previously posted only the COGS delta on consumed units, leaving the remaining-inventory delta unposted (and skipping the journal entirely when no units had shipped). The reclass is now a balanced 3-leg journal: `DR/CR Inventory` for the remaining-inventory delta + `DR/CR COGS` for the consumed-units delta + `DR/CR Manufacturing Overhead` for the total delta.
- **Idempotency keys on both journals.** `MANUFACTURING_JOURNAL` keys on `MFG_JOURNAL:<orderId>` so completion retries dedupe; `MANUFACTURING_RECLASS` keys on `MFG_RECLASS:<orderId>:<oldTotal>:<newTotal>` so identical re-saves dedupe but distinct edits each post.
- **Manufacturing journal queued in-tx.** Moved from post-tx `queueAccountingSync` to in-tx `queueAccountingSyncTx` so the cost-layer changes and the GL post are durable atomically — no more crash-window where inventory moves without a journal.
- **Disassembly zero-recovered fallback now capitalises overhead.** When `totalRecoveredCostBase === 0` the overhead is now distributed equally across recovered component layers rather than silently dropped, so the Inventory debit posted by the journal matches the layer-derived stock value. Aligns with the recalc helper's existing equal-share fallback.
- **Unbalanced-journal guard.** Builder now refuses to post if a credit line is dropped due to a missing account (no DR-only journal) and validates the debit/credit sums match within £0.01.
- **Negative amounts rejected at the action level.** Cost-line amounts must be non-negative; the journal model assumes overhead is a non-negative debit to inventory. UI input adds `min="0"`.
- **Reclass warnings surfaced in the action return** as `{ success: true, warning }` rather than only logged silently.
- **`cost_layers.production_order_id` is now a real FK** with `ON DELETE SET NULL` and a Prisma relation on both sides.

### Tests

- Three additional unit tests in `tests/manufacturing-cost-recalc.test.ts`: proportional rounding across multiple layers, equal-share fallback for zero-base layers, and value-share split with mixed receivedQty.

## 1.7.0 - 2026-04-25

### User-facing

- **Manufacturing-cost lines** on production orders. Each manufacturing order can now carry a list of per-run overhead lines (labour, machine time, utilities, etc.) with an optional per-line GL account override. Cost lines are managed from the order detail page in a new **Manufacturing costs** card, and appear on the manufacturing-order PDF with a total.
- **Capitalised overhead** — on completion the total of all cost lines is folded into the produced cost layer's unit cost (assembly: spread across `qtyPlanned`; disassembly: distributed proportionally across recovered components by their value share). Margin reporting and FIFO consumption use the fully-loaded unit cost.
- **Manufacturing Journal** accounting type — `DR Inventory / CR Manufacturing Overhead` is queued automatically on assembly/disassembly completion. Lines without a per-line override credit a configurable default account (Settings → Accounting → Manufacturing Overhead account).
- **Retro recalc** — cost lines can be edited after completion. Cost layers are re-priced and a `MANUFACTURING_RECLASS` journal is queued for any units already shipped (delta posts to COGS vs Inventory).

### Technical

- New Prisma model `ManufacturingCostLine` (id, productionOrderId, description, amountForeign, amountBase, accountCode override, sortOrder).
- Added `ProductionOrder.currency` + `fxRateToBase` columns so cost lines can be entered in a non-base currency.
- New `AccountingSyncType` enum values: `MANUFACTURING_JOURNAL` and `MANUFACTURING_RECLASS`. Both connectors (Xero, QuickBooks) gained `*_sync_manufacturing_journal` and `*_manufacturing_overhead_account` setting keys.
- New `CostLayer.production_order_id` foreign key so retro-recalc can find cost layers produced by a given production order. Index added.
- Server actions: `getManufacturingCostLines`, `updateManufacturingCostLines` (transactional replacement, triggers retro-recalc when status === 'COMPLETED').
- Internal helper `recalculateManufacturingCostLayers` mirrors `recalculateDirectLandedCosts`: updates `costLayer.unitCostBase`, posts COGS reclass for consumed qty, and refreshes downstream snapshots via `updateSnapshotsForCostLayerChange` / `refreshShipmentCogsForCostLayerChange` / `refreshSalesOrderLineCogsForCostLayerChange`.

## 1.6.0 - 2026-04-22

### User-facing

- Added Mintsoft bundle sync (Phase 4) with a per-binding direction control (`DISABLED`, `IMS → Mintsoft`, `Mintsoft → IMS` verify only). IMS KIT product create/edit now queues a best-effort Mintsoft bundle push, and operators can run a manual **Run Bundle Verify** from the Mintsoft dashboard.
- Added a Bundles card on the Mintsoft dashboard listing linked Mintsoft bundles with checksum and last-synced timestamp. Composition drift surfaces as an open `BUNDLE_DERIVATION_CONFLICT` discrepancy because the Mintsoft API does not support bundle updates — diverging bundles must be resolved manually.

### Technical

- Added `WmsBundleDto` / `WmsBundleComponent` / `WmsBundleRef` to the WMS connector contract with optional `createBundle` / `fetchBundle` methods, implemented in the Mintsoft connector against `PUT /api/Product/Bundle` and `GET /api/Product/{id}/Bundle`.
- Landed `lib/connectors/mintsoft/sync/bundle-sync.ts` with deterministic composition hashing (sorted by component SKU, quantity rounded to 4 dp), `WmsBundleLink` persistence, `BUNDLE_DERIVATION_CONFLICT` upsert per active binding warehouse, and auto-resolution on match. Bundle sync never mutates IMS stock — it only reconciles composition structure.
- Registered the `mintsoft-bundle-verify` cron (nightly, disabled by default) and added the `runMintsoftBundleVerifyNow` server action under write-scope permission.
- Hooked best-effort bundle sync into the existing `after()` path on product create/update so KIT composition changes propagate to Mintsoft without blocking the interactive submit.
- Serialized Mintsoft bundle creation via a `WmsBundleLink` sentinel claim so concurrent product saves or cron+manual runs can no longer double-PUT to `/api/Product/Bundle`; stale sentinels older than 10 minutes are reclaimable.
- Reordered the Mintsoft bundle normalizer id precedence to prefer the bundle `ID` over any `ProductId` alias so a root `ProductId` can never be mis-selected as the external bundle id.
- Raise a `BUNDLE_DERIVATION_CONFLICT` when an active-binding KIT has no components, instead of silently skipping and leaving the Mintsoft bundle unchanged.
- Made Mintsoft bundle-sync decisions per-binding-scope so a single `IMS_TO_WMS` binding no longer suppresses `WMS_TO_IMS` conflicts on other warehouses: push scopes and pull scopes now each get their own conflict rows with direction-specific wording.
- Extended the Mintsoft bundle verify scan to include KITs with an existing `WmsBundleLink`, not only those with an active `WmsProductLink`, so orphaned bundle mappings stay monitored.
- Escalated Mintsoft bundle finalize-after-create failures with three retry attempts plus an `ERROR`-level `mintsoft_bundle_finalize_failed` activity log carrying the remote bundle id, checksum, and sentinel link id for manual recovery.
- Also schedule Mintsoft bundle sync for parent KITs when a component product is saved, so component SKU or Mintsoft-link changes no longer leave parent bundles stale until the next cron.
- Filtered pending Mintsoft bundle sentinels (`pending:*` external ids) out of the dashboard Bundles table so operators only see real Mintsoft bundle ids.
- Moved the Mintsoft bundle parent-product-link requirement from an early return to the push branch only, so a KIT with a persisted `WmsBundleLink` but no `WmsProductLink` is now fully verified against Mintsoft instead of being skipped the moment verify picks it up.

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
