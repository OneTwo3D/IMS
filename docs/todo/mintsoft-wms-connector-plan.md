# Mintsoft WMS Connector Plan

## Goal

Add a Mintsoft warehouse management system (WMS) integration to One Two Inventory as a **replaceable, plugin-style connector**. The design must:

- let a chosen IMS warehouse either stay IMS-mastered or become WMS-mastered, reversibly
- flow products from IMS to Mintsoft, including customs/dimension/image data
- synchronise stock between Mintsoft and IMS in two explicit modes (notification-only or full alignment)
- support bundle sync in a configurable direction
- drive inbound ASNs from POs and stock transfers, reconcile booked-in callbacks against IMS PO lines
- surface returns as operator tasks, not automatic stock mutations
- avoid double-booking stock when partial ASN booking and PO receipt both touch the same goods
- keep Mintsoft-specific code isolated behind a generic `wms-*` contract so a future WMS (e.g. Peoplevox, Scurri, Linnworks-Warehouse) can replace it with no core rewrites

This plan sits alongside the existing shopping (WooCommerce/Shopify) and accounting (Xero/QuickBooks) connector frameworks. It does **not** replace the shared external-fulfillment entry point described in `connector-groundwork-plan.md` — Mintsoft will keep using `applyExternalFulfillmentUpdate(...)` for outbound shipment progression. This plan adds the inbound, stock, bundle, product, and returns surfaces.

## Principles (locked in before coding)

1. **Warehouse-level ownership, never mixed per-SKU ownership** within the same warehouse.
2. **Stock snapshot state and PO receipt state are separate ledgers.** External snapshots never directly drive purchasing status; PO receipts never silently double-count stock that snapshots already absorbed.
3. **Mintsoft-master warehouses must not receive stock twice** through both stock sync and PO receipt booking.
4. **All Mintsoft-specific logic sits behind a generic WMS provider interface.** IMS core talks to `WmsConnector`, never to Mintsoft DTOs.
5. **Bundle sync is feature-flagged and directional.**
6. **Returns create operator work items, not auto-restock.**
7. **Notification-only is the default mode** for any newly linked warehouse; alignment mode is opt-in after mappings and receipts are stable.
8. **EAN/UPC barcodes are never silently overwritten in either system.** Product sync treats barcodes as protected identifiers: fill gaps automatically, but escalate conflicts to an operator for resolution.

## Target Architecture

### Layer A — WMS abstraction in IMS core

Introduce a generic contract under `lib/connectors/wms/` with no Mintsoft knowledge:

```
lib/connectors/wms/
  types.ts             // WmsConnector, capability model, DTOs
  registry.ts          // provider registry (parallel to shopping/accounting)
  capabilities.ts      // supportsXxx feature flags per provider
  contracts/
    product-sync.ts    // WmsProductSyncService
    stock-sync.ts      // WmsStockSyncService
    inbound.ts         // WmsInboundService (ASN)
    bundle-sync.ts     // WmsBundleSyncService
    returns.ts         // WmsReturnsService
  runtime/
    job-runner.ts      // sync job queue + retry
    idempotency.ts     // shared idempotency key helpers
    audit.ts           // sync_job, sync_log writers
    reconciliation.ts  // stock / PO receipt reconciliation primitives
```

Capability model each provider declares:

```ts
type WmsCapabilities = {
  supportsStockMasterWarehouse: boolean
  supportsInboundAsn: boolean
  supportsAsnCallbacks: boolean
  supportsBundleSync: 'imsToWms' | 'wmsToIms' | 'both' | false
  supportsReturnsPolling: boolean
  supportsReturnsWebhook: boolean
  supportsPartialReceiptHandling: boolean
}
```

IMS core asks "what can this WMS do?" rather than hard-coding Mintsoft terminology.

### Layer B — Mintsoft connector module

```
lib/connectors/wms-mintsoft/
  api/           // HTTP client, base URL, retries, rate limiting
  auth/          // dynamic API key lifecycle (24h expiry, refresh)
  mappings/      // DTO ↔ neutral model converters
  product-sync/
  stock-sync/
  bundle-sync/
  inbound-asn/
  returns/
  webhooks/      // ASN callback signature check, dedupe
  settings/      // provider-specific settings schema
  tests/
```

Mintsoft owns: API client, token refresh, DTO mapping, polling/webhook handlers, reconciliation rules, connector-specific settings UI schema. Nothing Mintsoft-specific leaks into `lib/connectors/wms/` or into core server actions.

### Layer C — Event-driven orchestration

Rather than inline mutations during normal server actions, emit integration events the WMS runtime subscribes to:

- `ProductChanged`
- `BundleChanged`
- `WarehouseStockSyncRequested` (scheduled or manual)
- `PurchaseOrderApproved` — candidate for ASN creation if warehouse is WMS-linked
- `StockTransferCreated` — candidate for ASN creation if destination is WMS-linked
- `AsnBookedInNotificationReceived`
- `ReturnDetected`

In practice for OTI this will be implemented with job records in the DB (see `wms_sync_job` below) plus cron-driven runners under `lib/cron-jobs/` so the pattern matches existing Woo/Xero wiring.

## Warehouse Binding and Ownership Model

Extend `Warehouse` (or add a sibling table) with a binding row per connector:

```
ExternalWmsBinding {
  id
  warehouseId           // FK Warehouse
  provider              // 'mintsoft' | ...
  externalWarehouseId   // Mintsoft warehouse id
  active                Boolean

  // New two-mode stock sync requirement
  stockSyncMode         'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS'
  stockMasterSystem     'IMS' | 'WMS'   // derived/enforced from stockSyncMode

  bundleSyncDirection   'IMS_TO_WMS' | 'WMS_TO_IMS' | 'DISABLED'
  returnsMode           'POLL' | 'WEBHOOK' | 'DISABLED'

  syncFrequencyMinutes  Int
  discrepancyThresholds Json   // per-category thresholds for alerting
  reportRecipients      String[]
  callbackSecret        String // hashed

  createdAt, updatedAt, lastStockSyncAt, lastStockSyncStatus
}
```

Invariants enforced in server actions:

- `NOTIFICATION_ONLY` ⇒ `stockMasterSystem = IMS`
- `ALIGN_TO_WMS` ⇒ `stockMasterSystem = WMS`
- Only one active binding per `warehouseId` at a time.
- Switching `stockSyncMode` is always a deliberate user action, never implicit.

### Activation flow

1. Validate Mintsoft credentials and fetch warehouses.
2. Bind IMS warehouse ↔ Mintsoft warehouse.
3. Run initial stock snapshot (read-only).
4. Optionally run product seed sync.
5. Default new binding to `stockSyncMode = NOTIFICATION_ONLY`.
6. After user verification, allow switching to `ALIGN_TO_WMS`.

### Deactivation / handover flow

1. Pause inbound/outbound sync jobs.
2. Pull final Mintsoft stock snapshot.
3. Write handover reconciliation report.
4. Set `stockSyncMode = DISABLED`, `stockMasterSystem = IMS`.
5. Disable connector jobs and webhooks.
6. Unbind if operator confirms.

This makes switching explicit and reversible.

## Stock Sync — Two Modes (REQUIRED)

Every WMS provider must implement both modes. The mode lives on the warehouse binding, not on the connector.

### Mode 1 — `NOTIFICATION_ONLY`

- IMS remains stock master.
- Scheduled job fetches Mintsoft stock.
- Compares Mintsoft qty vs IMS qty for the linked warehouse.
- **No stock quantities are changed in IMS.**
- Discrepancies recorded in `wms_stock_discrepancy`.
- A run report is generated and user is notified (email + in-app) when thresholds are exceeded.

Use cases: early rollout, audit mode, low trust in external data, temporary fallback.

### Mode 2 — `ALIGN_TO_WMS`

- WMS is stock master for the linked warehouse.
- Scheduled job fetches Mintsoft stock, calculates delta vs IMS warehouse stock, and applies corrections in IMS.
- Corrections are logged as connector-originated adjustments (**not** normal manual stock edits), so they are recognisable in the adjustment ledger and excluded from FIFO input where appropriate.
- A full before/after run report is generated for user review.

Use cases: production mode for WMS-mastered warehouses.

### Discrepancy categories (shared by both modes)

- `MISSING_IN_IMS`
- `MISSING_IN_WMS`
- `QTY_MISMATCH`
- `UNMAPPED_SKU`
- `RECEIPT_TIMING_CONFLICT` — WMS delta looks like an ASN booked in that IMS has not received yet
- `BUNDLE_DERIVATION_CONFLICT` — WMS bundle stock differs from what IMS would derive from components

### Stock sync run report (both modes, with different emphasis)

Run header:

- warehouse, provider, run time, total SKUs checked, matched, mismatches, corrected, skipped, errors, unresolved

Per line:

- SKU, product name, IMS qty before, WMS qty, IMS qty after, delta, action taken, reason/warning

Stored in `wms_sync_job` + `wms_sync_log`, downloadable as CSV and viewable in the operator UI.

## Data Model Additions

All integration-owned, kept out of the core domain tables:

**Connector config**

- `wms_connection` (provider-level credentials and base config)
- `wms_connection_warehouse` — this is the `ExternalWmsBinding` above
- `wms_connection_settings` (per-provider extended settings JSON)
- `wms_feature_flags`

**External id mappings**

- `wms_product_map` — IMS product/variant id ↔ provider external id, payload hash, last synced at, last error
- `wms_bundle_map`
- `wms_asn_map` — IMS inbound doc ↔ Mintsoft ASN id
- `wms_po_map` / `wms_transfer_map` — optional convenience indices
- `wms_return_map`
- `wms_order_map` — only if needed alongside the existing shopping link tables

**Sync / audit / reconciliation**

- `wms_sync_job` — one row per run, with type, status, started/ended, counts, report blob reference
- `wms_sync_log` — per-line detail for the run
- `wms_stock_snapshot` — last seen external qty per warehouse+SKU
- `wms_stock_discrepancy` — open discrepancies requiring follow-up
- `wms_inbound_receipt_event` — every webhook/callback event received, for idempotency + audit
- `wms_returns_inbox` — operator-facing return tasks

**Reconciliation ledger (for the double-booking rule)**

Per (warehouseId, sku):

- `external_snapshot_qty`
- `stock_qty_accounted_via_snapshot`
- `stock_qty_accounted_via_po`
- `receipt_qty_applied_to_po`
- `net_correction_applied`

This is the source of truth for "has this stock already been counted?" when both ASN booked-in callbacks and alignment-mode stock sync touch the same warehouse.

## Mintsoft Feature Mapping

### Product sync (IMS → Mintsoft)

Fields sent per product/variant:

- SKU, name, subvariant name (normalised into Mintsoft product name or custom field as API testing confirms)
- picture URL (published from IMS as fetchable URL; no binary upload assumed until API-verified)
- customs description, commodity code, country of manufacture
- weight, height, width, depth
- short description

Triggers: initial seed, product create/update event in IMS, manual re-sync, nightly full verification.

The exporter selects products assigned to the Mintsoft-linked warehouse, flattens variants, and upserts. External id and payload hash are stored in `wms_product_map`; unchanged payloads skip the network call.

#### EAN/UPC barcode safety rule

Barcodes are protected identifiers and are **never silently overwritten** in either direction. Product sync applies a three-way resolution per SKU on every run:

| IMS barcode | Mintsoft barcode | Action |
|-------------|------------------|--------|
| empty | empty | no-op |
| set | empty | send IMS barcode to Mintsoft (fill gap in WMS) |
| empty | set | copy Mintsoft barcode into IMS (fill gap in IMS); log as `BARCODE_BACKFILLED_FROM_WMS` for audit |
| set | set, equal | no-op |
| set | set, **different** | **do not write either side.** Create a `BARCODE_CONFLICT` entry in `wms_stock_discrepancy` (or a dedicated `wms_barcode_conflict` table) with both values + both source ids, and surface as an operator task for manual resolution |

Implementation notes:

- The IMS → Mintsoft product export must **omit** the barcode field on upsert when the IMS barcode differs from the currently stored Mintsoft barcode. It must never send a new barcode value over the top of an existing different one.
- The Mintsoft → IMS backfill only runs when IMS barcode is empty. It is the only automatic write path for barcodes.
- Conflict resolution UI lets the operator choose: keep IMS value (push to WMS), adopt WMS value (update IMS), mark "investigate" (no write). The chosen action is logged via `logActivity()`.
- Until a conflict is resolved, that SKU is flagged on stock sync reports so operators know the identifier mismatch is still open.
- Barcode conflicts do **not** block stock sync or ASN flows; they are an independent data-quality signal.

### Bundle sync

Neutral bundle DTO: bundle SKU, bundle name, components `[{sku, qty}]`, active flag, source system, checksum.

Three modes on the warehouse binding:

- `IMS_TO_WMS` — IMS is source of truth, overwrite in Mintsoft, prevent Mintsoft-originated edits from flowing back
- `WMS_TO_IMS` — Mintsoft is source of truth, import bundles into IMS, protect imported bundles from manual restructuring unless explicitly detached
- `DISABLED` — bundle structure is not synced; stock sync still runs on non-bundle SKUs

Bundle stock semantics **differ** between systems, so we sync structure only. Bundle stock discrepancies log separately under `BUNDLE_DERIVATION_CONFLICT` and are not auto-corrected.

Phase 0 spike must confirm Mintsoft's bundle create/update mechanics before Phase 4 commits to an implementation direction.

### Inbound ASN generation (POs and stock transfers)

Unify both sources under a neutral concept:

```
InboundReceiptDocument {
  sourceType: 'PURCHASE_ORDER' | 'STOCK_TRANSFER'
  sourceId
  destinationWarehouseId
  lines: [{ imsLineId, sku, qty }]
}
```

UI dialogue on the PO or transfer prompts for:

- delivery type / packaging type
- number of parcels / pallets / containers
- expected delivery date / ETA
- supplier reference, notes, carrier + tracking (optional)
- whether to auto-register webhook callback

Action:

1. Operator confirms PO or stock transfer.
2. Connector generates Mintsoft ASN, mapping lines via `wms_product_map`.
3. Callback is registered on the ASN.
4. IMS stores ASN external id and status in `wms_asn_map`.

### Booked-in callback → IMS PO line receipt

When Mintsoft reports booked or partially booked:

1. Receive webhook, validate HMAC against `callbackSecret`.
2. Fetch latest ASN details from Mintsoft.
3. Map ASN lines to IMS source lines.
4. Compute **delta** received per line: `currentReceived - lastProcessedReceived`.
5. Apply receipt in IMS against the PO / transfer line.
6. If all lines complete, close the PO.

Idempotency key: `receipt:{externalAsnItemId}:{receivedQty}`. Webhook retries are safe.

### The partial-ASN double-booking rule

The worst-case failure we must prevent:

1. Mintsoft stock rises because goods were partly booked in.
2. Alignment-mode stock sync sees higher stock and raises IMS.
3. Later the ASN callback books PO receipt and IMS also adds stock.
4. IMS is now double-counted.

Rule set for Mintsoft-master warehouses:

- Mintsoft stock snapshot is authoritative for **on-hand stock visibility**.
- IMS PO receipt is authoritative for **purchasing state / PO status**.
- When PO receipt processing fires, the reconciliation ledger determines whether stock must still be added, or whether the external snapshot already absorbed it.
- If `stock_qty_accounted_via_snapshot` already covers the booked qty: mark PO line received, post a reconciliation marker, **do not add stock again**.
- If not yet covered: receive normally and increment `stock_qty_accounted_via_po`.

For `NOTIFICATION_ONLY` warehouses this rule is not needed — IMS never mutated stock from the snapshot, so PO receipt behaves normally. For `ALIGN_TO_WMS` warehouses it is essential.

### Returns inbox

Returns are operator tasks, not automatic restocks.

Polling job (or webhook when Mintsoft supports it):

1. Fetch returns by date / since cursor.
2. Match return to IMS sales order + product via existing order links.
3. Create a row in `wms_returns_inbox` with: linked order, linked SKU, reason, qty, reference, warehouse, received date, raw payload.
4. Surface as an inbox/task in the sales/returns UI.
5. Operator decides: restock, quarantine, refund only, replacement, inspection required. Their choice triggers the existing IMS return/refund/restock flows.

Duplicate suppression via external return id + idempotency key.

## Operating Model

### Inbound mechanisms

- **Polling** — stock sync (both modes), returns sync, recovery/reconciliation sweeps.
- **Webhook/callback** — ASN booked-in / partially booked. Registered per ASN as Mintsoft's connect-actions allow.

### Outbound mechanisms

Job queue with retry and backoff for: product export, bundle export, ASN creation, settings validation. Backed by `wms_sync_job`.

### Idempotency

Every write path gets an idempotency key:

- `product:{imsVariantId}:{payloadHash}`
- `asn:{imsInboundDocId}`
- `receipt:{externalAsnItemId}:{receivedQty}`
- `return:{externalReturnId}`

Without these, retries and manual replays will corrupt state.

### Auth and token lifecycle

Mintsoft dynamic API keys expire after 24 hours. The connector runtime owns refresh: request a fresh key before expiry, store encrypted, retry once on 401 with a forced refresh.

## UI and Settings Surface

**Connector settings page** (`/settings/integrations/mintsoft`):

- base URL, auth credentials, token refresh cadence
- default polling intervals, retry policy
- callback auth secret (rotate + copy)
- dry-run mode toggle (log-only, no external writes)

**Per-warehouse binding editor**:

- link to Mintsoft warehouse (dropdown of fetched warehouses)
- `stockSyncMode` selector with clear wording for the two-mode requirement
- `stockMasterSystem` (read-only, derived)
- bundle sync direction
- returns mode
- sync frequency
- discrepancy thresholds
- report recipients
- activate / deactivate with the handover flow

**Operator UI**:

- stock discrepancy log (open, triaged, resolved)
- stock sync run reports (both modes), downloadable CSV
- failed sync queue with reprocess/retry actions
- ASN status list with last callback event per ASN
- returns inbox
- connector health page (last sync, token status, error counts)

All mutations call `logActivity()` per project convention.

## Risks and Mitigations

1. **Bundle semantics differ.** Mitigation: Phase 0 spike, sync structure only, feature-flag until proven, separate discrepancy category.
2. **Partial goods-in causes stock/PO mismatch.** Mitigation: reconciliation ledger, delta-based receipts, alignment-mode-only rule; never book stock twice.
3. **Missing external IDs / SKU mismatches.** Mitigation: required mapping table, unmapped-SKU queue, fail loudly. Never invent matches.
4. **Mintsoft token expiry.** Mitigation: proactive refresh + single-retry on 401.
5. **Callback duplication / missed callbacks.** Mitigation: idempotent processing, stored event log, scheduled backfill reconciliation.
6. **Wrong stockSyncMode chosen too early.** Mitigation: default all new bindings to `NOTIFICATION_ONLY`; require operator to explicitly promote to `ALIGN_TO_WMS` after a clean notification-only window.

## Phased Rollout

### Phase 0 — discovery spike

Prove API fit and final field mappings. Deliverables:

- Mintsoft auth tested (24h key lifecycle)
- list-warehouses works
- product create/update spike
- stock level fetch spike (with warehouse filter)
- ASN create + callback spike
- returns polling spike
- field mapping matrix signed off
- webhook auth approach decided
- bundle API gaps documented

### Phase 1 — WMS abstraction and connector shell

Make the framework replaceable. Deliverables:

- `lib/connectors/wms/` contracts + registry
- provider capability model
- `ExternalWmsBinding` schema + server actions
- sync job runner + audit log
- provider settings screen shell
- no business sync wired yet

### Phase 2 — warehouse stock sync modes (the new requirement)

Make Mintsoft usable for stock visibility or stock authority. Deliverables:

- warehouse binding UI with `stockSyncMode` selector
- initial stock import
- periodic stock sync job
- **notification-only mode**: discrepancy log, user notifications, run report
- **alignment mode**: delta correction engine, adjustment audit trail, run report
- discrepancy categories + operator UI
- deactivation / handover flow
- default new bindings to notification-only

### Phase 3 — product sync IMS → Mintsoft

Product readiness. Deliverables:

- product/variant exporter with payload hash
- mapping storage
- picture / customs / dimensions / weight sync
- re-sync tools (single, bulk, nightly verify)
- failed-item retry queue

### Phase 4 — bundle sync

Optional, feature-flagged. Deliverables:

- neutral bundle model + converters
- directional sync (IMS_TO_WMS, WMS_TO_IMS, DISABLED)
- conflict logging under `BUNDLE_DERIVATION_CONFLICT`

### Phase 5 — ASN generation and inbound linking

Inbound flows to Mintsoft. Deliverables:

- "Send PO/transfer to Mintsoft" server action
- packaging / parcels dialogue
- ASN mapping + callback registration
- ASN status tracking UI

### Phase 6 — booked-in reconciliation to IMS PO

Close the PO loop safely. Deliverables:

- webhook handler with signature check and dedupe
- ASN detail fetch + line mapping
- delta receipt engine
- PO line receipt + auto-close
- reconciliation ledger + double-booking suppression for alignment-mode warehouses

### Phase 7 — returns inbox

Operator-driven returns. Deliverables:

- returns polling (and webhook if available)
- order + SKU matching
- operator task/message generation
- duplicate suppression
- audit history, linked to existing returns/refund actions

## Acceptance Criteria for v1

All must pass for v1 to be considered done:

1. An IMS warehouse can be linked to a Mintsoft warehouse and its `stockSyncMode` set.
2. In `NOTIFICATION_ONLY` mode, discrepancies are logged and reported **without** changing IMS stock; IMS remains stock master.
3. In `ALIGN_TO_WMS` mode, IMS stock for the linked warehouse is periodically aligned to Mintsoft; every run produces a user-facing before/after report.
4. Mode switching is reversible and goes through the documented activation / handover flow.
5. IMS can export products with SKU, names, image URL, customs description, commodity code, weight and dimensions.
6. IMS can create Mintsoft ASNs from POs and stock transfers and register callbacks.
7. When Mintsoft books in ASN items, IMS marks PO lines received without double-booking stock — verified end-to-end in alignment mode with a partial-ASN scenario.
8. Bundle sync works in the configured direction, or is cleanly disabled.
9. Returns from Mintsoft appear in an IMS operator inbox linked to the order and product, not as automatic stock mutations.
10. The Mintsoft implementation can be disabled and a second WMS provider could be added against the same `lib/connectors/wms/` contracts without rewriting core IMS logic.

## Open Questions (to resolve in Phase 0)

- Does Mintsoft's product create/update API accept the full customs/dimensions/image set in one call, or do some fields need a secondary endpoint?
- Does Mintsoft expose bundle structure via API, or only via stock-level `Bundle` markers? This gates Phase 4 scope.
- Does Mintsoft support returns webhooks, or polling only? Affects `returnsMode` defaults.
- What is the real authentication shape (dynamic API key vs OAuth) and the exact 401 behaviour on expiry?
- Can we register callback URLs globally, or only per-ASN? Affects webhook routing design.

## Recommendation

Ship Phase 0 → Phase 2 first with `NOTIFICATION_ONLY` as the only supported mode. That delivers immediate value (audit-only stock mirror) with zero risk to IMS stock integrity, and forces the mapping, credentials, and discovery work to be clean before alignment mode, ASNs, or returns land. Alignment mode, ASN flows, and returns should only go live after notification-only has run stably for at least one real warehouse.
