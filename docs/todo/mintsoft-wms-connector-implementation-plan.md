# Detailed Implementation Plan — Mintsoft WMS Connector

## Context

The existing `docs/mintsoft-wms-connector-plan.md` is a good architectural design but is too abstract for direct implementation. This plan restates it as a concrete, file-by-file build plan keyed to the real OTI codebase so that Codex (or any other agent) can implement it with minimal guesswork.

**Goal:** add a Mintsoft WMS connector to One Two Inventory as a plugin-style module sitting behind a generic `warehouse`-category contract, mirroring the existing `shopping` (WooCommerce/Shopify) and `accounting` (Xero/QuickBooks) connector frameworks. The connector must support two stock-sync modes (notification-only / align-to-wms), product sync IMS→Mintsoft with **barcode safety rules**, bundle sync (directional), inbound ASN flow from POs/transfers with booked-in reconciliation that never double-books stock, and a returns inbox.

**Why now:** Mintsoft is already a pre-reserved source in `ExternalFulfillmentSource` (`lib/fulfillment/external-fulfillment.ts:5`), but nothing in the codebase implements it. The groundwork for parallel connectors (link tables, cron registry, encrypted settings, external-fulfillment entry point) has landed. This plan fills in the warehouse-side connector category that was deferred.

**Principles (locked in before coding):**
1. Warehouse-level ownership, never per-SKU.
2. Stock snapshot state and PO receipt state are separate ledgers; no double-booking.
3. All Mintsoft-specific logic lives behind a generic `WmsConnector` contract.
4. Bundle sync is feature-flagged and directional.
5. Returns create operator work items, not auto-restock.
6. Notification-only is the default stock-sync mode for any new warehouse binding.
7. **EAN/UPC barcodes are never silently overwritten**: fill gaps automatically, escalate conflicts.
8. **Per-ASN-line attribution**: the receipt-reconciliation ledger is keyed by `(connector, externalAsnLineId)`, never by `(connector, warehouseId, productId)`. A single SKU can have stock arriving via multiple open POs/ASNs; cumulative counters cannot attribute correctly.

---

## Revision History

### v3 — 2026-04-21 (Codex implementation review)

Codex reviewed v2 against the live repo structure and the proposed receipt flow. Corrections rolled into this file:

- **Receipt / reconciliation fixes:**
  - Phase 6 no longer assumes a single receipt-level `skipStockMutationQty` is enough. Coverage is **per ASN line**, so receipt APIs now carry both `qtyReceived` and `coveredBySnapshotQty` per line.
  - Webhook processing no longer calls session-gated server actions directly. The plan now requires **internal auth-free receipt helpers** (or explicit internal-bypass options) that route handlers can call safely.
- **Order identity fixes:**
  - Mintsoft order lookup no longer scans `ShoppingOrderLink` across "any shopping connector". That is ambiguous in multi-connector tenants. The connection now stores an explicit **`orderLookupConnector`** scope and uses that when resolving storefront order numbers.
- **Repo-shape fixes:**
  - Plugin toggles live under **`/settings/system?tab=plugins`**, not `settings/integrations/*`.
  - The existing integrations UI lives under **`/sync`**, so Phase 1 now extends the current sync dashboard surface instead of inventing a parallel settings route tree.
  - Existing settings / cron writes use **`settings.company`**, not a non-existent `settings.integrations` permission.
  - Sidebar and onboarding touch points are now called out explicitly because the current repo still passes only WooCommerce/Xero visibility booleans into layout chrome.

---

### v2 — 2026-04-20 (Codex factual review)

Codex audited v1 against the real codebase. Corrections rolled into this file:

- **Factual fixes:**
  - `PurchaseReceipt.reference` is `String?` and **not unique** (`prisma/schema.prisma:918`). Remove all "idempotent via row lock + receipt reference" claims. Idempotency for inbound callbacks must come from a dedicated external-event dedupe table + per-line processed-qty ledger.
  - `ShoppingOrderLink` uses field name **`connector`** (not `provider`) at `prisma/schema.prisma:1605`. All new WMS models must likewise use `connector` for consistency, and Mintsoft-to-WC-order resolution cannot rely on `connector: 'mintsoft'` matching pre-existing `connector: 'woocommerce'` rows — see new "Order identity" section below.
  - The insertion point for the WMS schema block is **after line 1619** (end of `ShoppingOrderLink`), not "after the `ShoppingProductLink` block". `ShoppingProductLink` actually ends at line 1583.
  - `receiveTransfer` at `app/actions/transfers.ts:459` takes only `id`, books the entire transfer, and has **no delta/partial-receipt support**. The plan's "same extension" line is insufficient; Phase 6 needs to introduce a new partial-receive variant for transfers.
- **Design fixes:**
  - Reconciliation ledger redesigned to be per-ASN-line, not per-warehouse-SKU (see "Reconciliation ledger (revised)" below).
  - Barcode section now includes `fetchProduct` on `WmsConnector`, `metadata` / `lastKnownBarcode` on `WmsProductLink`, and an explicit cross-product unique-constraint collision path.
  - Mode-transition semantics spelled out: what resets on leaving `ALIGN_TO_WMS`, and how the skip rule gates on current mode.
  - Plugin-toggle scope expanded beyond `lib/integration-plugins.ts` to list every other 4-plugin-shape touch point.
  - RBAC matrix added (see "Permissions matrix"). Uniform `'sync'` permission was too coarse.
  - Email delivery gap called out: `lib/notifications.ts` is in-app only. Phase 2 acceptance rewritten to use in-app notifications; email requires adding a new outbound path (out of v1 scope) or routing through the existing `lib/mailer.ts` + `EmailOutbox` pattern.
  - Phase 2 locked to `NOTIFICATION_ONLY`. `ALIGN_TO_WMS` moves into Phase 2b and now explicitly depends on Phase 6 (booked-in reconciliation) landing first, plus an agreed costing model for connector-originated adjustments (see "Costing model for alignment mode").

---

## Codebase Anchors (existing code to reuse)

These are the already-existing utilities the new code must plug into. Do not reinvent them.

| Concern | Path | Notes |
|---|---|---|
| External fulfillment entry point | `lib/fulfillment/external-fulfillment.ts:5,88` | `'mintsoft'` already in `ExternalFulfillmentSource`. Use `applyExternalFulfillmentUpdate()` for shipment progression. **Do not write shipment rows directly.** |
| Integration plugin toggles | `lib/integration-plugins.ts:3-9` | Add `'mintsoft'` to `IntegrationPluginId` + `PLUGIN_SETTING_KEYS` + `DEFAULT_PLUGIN_STATE` + `isIntegrationModuleVisible`. |
| Settings storage | `lib/settings-store.ts:9-21` | Add `mintsoft_api_key`, `mintsoft_webhook_secret`, `mintsoft_base_url` (if sensitive) to `SENSITIVE_SETTING_KEYS`. |
| Secrets crypto | `lib/secrets.ts` | AES-256-GCM via `ENCRYPTION_KEY`. Already auto-encrypts sensitive Setting keys. |
| Cron registry | `lib/cron-registry.ts:8-27` | Register new jobs via `registerCronJobs([...])` from a module init file imported in `lib/cron-jobs/index.ts`. |
| Cron auth | `lib/cron-auth.ts:10-40` | `verifyCron(request)` returns a `NextResponse` error or null. |
| Shopping link table pattern | `prisma/schema.prisma:1567-1583` (`ShoppingProductLink`), `1585-1600` (`ShoppingCustomerLink`), `1602-1619` (`ShoppingOrderLink`) | Field name is `connector` (not `provider`). **Do not reuse** — WMS gets its own `WmsProductLink`, `WmsBundleLink`, etc. |
| Product model | `prisma/schema.prisma:485-568` | Already has `barcode` (**`@unique`** — collision-sensitive), `hsCode`, `countryOfOrigin`, `weight`, `widthCm/heightCm/depthCm`, `imageUrl`, `description`. Product sync payload reuses these; barcode write path must handle unique-constraint collisions. |
| Warehouse model | `prisma/schema.prisma:443-479` | Key on `Warehouse.code`. Do not add connector columns — use new `ExternalWmsBinding` table instead. |
| Stock adjustment | `app/actions/stock.ts:132-242` (`applyStockAdjustment`) | Signed qty, writes `StockMovement` + updates `StockLevel`. Creates a generic cost layer at warehouse average cost (falling back to 0) on positive adjustments. **Not a drop-in replacement for PO receipt costing** — see "Costing model for alignment mode". |
| PO receipt | `app/actions/purchase-orders.ts:1585` (`receivePurchaseOrder`) | Row-locks the PO and increments `PurchaseOrderLine.qtyReceived`, but `PurchaseReceipt.reference` is **nullable and non-unique** at `schema.prisma:918`, so the function is not idempotent on its own. Must be extended with an external dedupe key plus **per-line `coveredBySnapshotQty` handling** for WMS-triggered receipts. |
| Transfer receipt | `app/actions/transfers.ts:459` (`receiveTransfer`) | **Receives the full transfer only** — takes only `id`, sets every line's `qtyReceived = qty`, marks transfer `RECEIVED`. Does not support partial receipts. A new `receiveTransferPartial(id, lineDeltas, options)` is required for Phase 6 ASN callback support. |
| Activity log | `lib/activity-log.ts:51` (`logActivity`) | Every mutation must call it. Tag `'sync'` or `'inventory'`. |
| Auth/permissions | `lib/auth/server.ts` (`requireAuth`, `requirePermission`), `lib/permissions.ts` | Use `requirePermission('settings.company')` for connector configuration and scheduler/plugin writes, `requirePermission('sync')` for operator-facing run/report actions, and **internal helpers / bypass** for webhook-triggered receipt processing. |
| CSV export | `lib/csv.ts` (`toCsv`, `csvResponse`) | Used by `app/api/export/*`. Mirror for `/api/export/mintsoft-sync`. |
| Sync dashboard | `app/(dashboard)/sync/page.tsx` + `sync-dashboard.tsx` | Add a new "Mintsoft" card, category `'warehouse'`. |
| Notifications | `lib/notifications.ts` | `notify({userId, type, title, message, actionUrl})`. |
| ProductLink component | `components/inventory/product-link.tsx` | Use in all SKU/name cells per CLAUDE.md. |

---

## New Module Layout

```
lib/connectors/wms/                        # generic warehouse-connector contracts
  types.ts                                 # WmsConnector, capabilities, neutral DTOs
  registry.ts                              # WmsConnectorId union + registry array + getWmsConnector()
  binding.ts                               # load/save ExternalWmsBinding helpers
  sync-report.ts                           # shared run-report writer (wms_sync_job + wms_sync_log)
  idempotency.ts                           # key builders
  reconciliation.ts                        # ledger helpers (stock_qty_accounted_via_snapshot etc.)
  capabilities.ts                          # capability contract
  product-mapper.ts                        # IMS Product → neutral WmsProductDto
  bundle-mapper.ts
  asn-mapper.ts
  return-mapper.ts

lib/connectors/mintsoft/                   # Mintsoft-specific implementation
  index.ts                                 # exports default MintsoftConnector (implements WmsConnector)
  api/
    client.ts                              # HTTP client, base URL, retry
    auth.ts                                # 24h dynamic API key refresh
    errors.ts
  mappings/
    product.ts                             # neutral ↔ Mintsoft product DTO
    bundle.ts
    asn.ts
    return.ts
    stock.ts
  sync/
    product-sync.ts                        # IMS → Mintsoft product upsert w/ barcode safety
    bundle-sync.ts                         # directional
    stock-sync.ts                          # dual-mode (notification-only / align-to-wms)
    inbound-asn.ts                         # create ASN from PO or transfer
    booked-in-handler.ts                   # receives ASN callback, delta receipt
    returns-sync.ts                        # poll returns → inbox rows
  webhooks/
    signature.ts                           # HMAC verify, constant-time compare
    dedupe.ts                              # uses wms_inbound_receipt_event.externalEventId
  settings/
    schema.ts                              # Zod schemas for Mintsoft settings + binding
    defaults.ts

lib/cron-jobs/
  wms-mintsoft.ts                          # registerCronJobs([...]) for all Mintsoft crons
  # (imported from lib/cron-jobs/index.ts)

app/actions/
  wms-mintsoft.ts                          # server actions: saveConnectionSettings, createBinding,
                                           #   setStockSyncMode, runStockSyncNow, createAsnFromPo,
                                           #   createAsnFromTransfer, resolveBarcodeConflict,
                                           #   resolveStockDiscrepancy, handleReturnAction

app/api/
  cron/
    mintsoft-stock-sync/route.ts           # polling stock sync (both modes)
    mintsoft-returns-sync/route.ts         # polling returns
    mintsoft-product-verify/route.ts       # nightly full-verify
  webhooks/
    mintsoft/
      asn-booked-in/route.ts               # ASN callback webhook

app/(dashboard)/
  settings/system/page.tsx                 # existing plugin-toggle and scheduler surfaces gain Mintsoft
  sync/
    mintsoft-client.tsx                    # Mintsoft connector UI embedded in the existing /sync dashboard
    page.tsx                               # page gating updated to include warehouse-category plugins

components/wms-mintsoft/
  connection-form.tsx                      # credential dialog
  warehouse-binding-dialog.tsx             # create/edit binding dialog (follows feedback_dialog_forms.md)
  stock-sync-mode-selector.tsx             # radio: DISABLED / NOTIFICATION_ONLY / ALIGN_TO_WMS
  discrepancy-table.tsx                    # uses components/ui/table.tsx with containerClassName
  barcode-conflict-resolver.tsx            # keep IMS / adopt WMS / investigate
  returns-inbox-table.tsx
  asn-dialog.tsx                           # packaging/parcels prompt from PO or transfer
  run-report-view.tsx                      # before/after per SKU
```

---

## Prisma Schema Additions

Add to `prisma/schema.prisma` **after the end of `ShoppingOrderLink` at line 1619** (the v1 text said "after `ShoppingProductLink`" which was wrong — that block ends at 1583). Use snake_case `@@map` per project convention. **All link / binding / mapping / log tables use field name `connector`** (matching `ShoppingProductLink`), never `provider`. The denormalised `connector` column on `ExternalWmsBinding` is retained for indexing convenience but must always equal `connection.connector`.

**Required back-relation additions in the same migration:**
- `Warehouse` (line 443): add `wmsBinding ExternalWmsBinding?`
- `Product` (line 485): add `wmsProductLinks WmsProductLink[]`, `wmsBundleLinks WmsBundleLink[]`
- Prisma will not compile the new relations without these.

```prisma
// ---------------------------------------------------------------------------
// WMS / WAREHOUSE CONNECTOR
// ---------------------------------------------------------------------------

enum WmsStockSyncMode {
  DISABLED
  NOTIFICATION_ONLY
  ALIGN_TO_WMS
}

enum WmsStockMasterSystem {
  IMS
  WMS
}

enum WmsBundleSyncDirection {
  DISABLED
  IMS_TO_WMS
  WMS_TO_IMS
}

enum WmsReturnsMode {
  DISABLED
  POLL
  WEBHOOK
}

enum WmsSyncJobType {
  STOCK_SYNC
  PRODUCT_SYNC
  BUNDLE_SYNC
  ASN_CREATE
  ASN_CALLBACK
  RETURNS_SYNC
  PRODUCT_VERIFY
}

enum WmsSyncJobStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  PARTIAL
}

enum WmsDiscrepancyCategory {
  MISSING_IN_IMS
  MISSING_IN_WMS
  QTY_MISMATCH
  UNMAPPED_SKU
  RECEIPT_TIMING_CONFLICT
  BUNDLE_DERIVATION_CONFLICT
  BARCODE_CONFLICT
  BARCODE_BACKFILLED_FROM_WMS
}

enum WmsDiscrepancyStatus {
  OPEN
  ACKNOWLEDGED
  RESOLVED
  IGNORED
}

enum WmsReturnsInboxStatus {
  NEW
  UNDER_REVIEW
  RESTOCKED
  QUARANTINED
  REFUNDED_ONLY
  REPLACED
  INSPECT
  DISMISSED
}

model WmsConnection {
  id               String   @id @default(cuid())
  connector        String   // 'mintsoft'
  label            String?
  active           Boolean  @default(true)
  baseUrl          String?
  orderLookupConnector String? // 'woocommerce' | 'shopify'; required once >1 shopping connector is enabled
  tokenExpiresAt   DateTime?
  lastAuthAt       DateTime?
  callbackSecretId String?  // references Setting.key holding the HMAC secret
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  bindings         ExternalWmsBinding[]

  @@unique([connector])          // v1: single instance per connector
  @@map("wms_connections")
}

model ExternalWmsBinding {
  id                    String   @id @default(cuid())
  connectionId          String
  warehouseId           String   @unique        // one binding per IMS warehouse
  connector             String                  // denormalised, matches connection.connector
  externalWarehouseId   String
  active                Boolean  @default(true)

  stockSyncMode         WmsStockSyncMode       @default(NOTIFICATION_ONLY)
  stockMasterSystem     WmsStockMasterSystem   @default(IMS)
  bundleSyncDirection   WmsBundleSyncDirection @default(DISABLED)
  returnsMode           WmsReturnsMode         @default(DISABLED)

  syncFrequencyMinutes  Int      @default(60)
  discrepancyThresholds Json?
  reportRecipients      String[] @default([])

  lastStockSyncAt       DateTime?
  lastStockSyncStatus   WmsSyncJobStatus?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  connection            WmsConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  warehouse             Warehouse     @relation(fields: [warehouseId], references: [id])

  @@unique([connector, externalWarehouseId])
  @@map("external_wms_bindings")
}

model WmsProductLink {
  id                String   @id @default(cuid())
  productId         String
  connector         String                  // matches ShoppingProductLink convention
  externalProductId String
  payloadHash       String?                 // last-sent payload hash; skip network call when unchanged
  lastKnownBarcode  String?                 // last barcode value observed on the WMS side, for three-way barcode reconciliation
  metadata          Json?                   // connector-specific cache (e.g. Mintsoft product sub-fields)
  lastSyncedAt      DateTime?
  lastError         String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  product           Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([connector, externalProductId])
  @@unique([connector, productId])
  @@index([productId])
  @@map("wms_product_links")
}

model WmsBundleLink {
  id              String   @id @default(cuid())
  productId       String   // IMS KIT / BOM product id
  connector       String
  externalBundleId String
  checksum        String?
  lastSyncedAt    DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  product         Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([connector, externalBundleId])
  @@unique([connector, productId])
  @@map("wms_bundle_links")
}

model WmsAsnMap {
  id               String   @id @default(cuid())
  connector        String
  externalAsnId    String
  sourceType       String   // 'PURCHASE_ORDER' | 'STOCK_TRANSFER'
  sourceId         String
  warehouseId      String   // destination IMS warehouse; pinned at ASN creation
  status           String   // provider-reported status
  lastCallbackAt   DateTime?
  closedAt         DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  lines            WmsAsnLineMap[]

  @@unique([connector, externalAsnId])
  @@index([sourceType, sourceId])
  @@map("wms_asn_maps")
}

/// Line-level mapping between a Mintsoft ASN line and an IMS PO/transfer line,
/// plus the per-line receipt ledger that makes the double-booking rule safe.
/// Keyed by (connector, externalAsnLineId) so replayed callbacks are idempotent
/// and so one SKU with stock arriving via multiple open ASNs is attributed
/// correctly.
model WmsAsnLineMap {
  id                     String   @id @default(cuid())
  asnMapId               String
  externalAsnLineId      String
  sourceType             String   // 'PURCHASE_ORDER_LINE' | 'STOCK_TRANSFER_LINE'
  sourceLineId           String
  productId              String
  sku                    String
  expectedQty            Decimal  @db.Decimal(12, 4)

  // Per-line reconciliation ledger. These counters are the single source of
  // truth for "have we already absorbed this goods-in via the alignment snapshot
  // vs via a PO receipt?" and are what the Phase 6 handler inspects.
  qtyAccountedViaSnapshot Decimal @db.Decimal(12, 4) @default(0)
  qtyAccountedViaReceipt  Decimal @db.Decimal(12, 4) @default(0)
  lastProcessedReceivedQty Decimal @db.Decimal(12, 4) @default(0)
  lastCallbackAt         DateTime?

  asn                    WmsAsnMap @relation(fields: [asnMapId], references: [id], onDelete: Cascade)

  @@unique([asnMapId, externalAsnLineId])
  @@index([sourceType, sourceLineId])
  @@index([productId])
  @@map("wms_asn_line_maps")
}

model WmsSyncJob {
  id             String             @id @default(cuid())
  connector      String
  type           WmsSyncJobType
  status         WmsSyncJobStatus
  warehouseId    String?
  startedAt      DateTime
  finishedAt     DateTime?
  totalChecked   Int                @default(0)
  matched        Int                @default(0)
  mismatched     Int                @default(0)
  corrected      Int                @default(0)
  skipped        Int                @default(0)
  errors         Int                @default(0)
  summary        Json?
  triggeredBy    String?            // userId or 'cron'
  createdAt      DateTime           @default(now())

  lines          WmsSyncLog[]

  @@index([connector, type, status, startedAt])
  @@map("wms_sync_jobs")
}

model WmsSyncLog {
  id          String   @id @default(cuid())
  jobId       String
  sku         String?
  productId   String?
  action      String   // 'noop' | 'corrected' | 'discrepancy' | 'skipped' | 'error' | 'barcode_filled' | 'barcode_conflict'
  imsQtyBefore Decimal? @db.Decimal(12, 4)
  imsQtyAfter  Decimal? @db.Decimal(12, 4)
  wmsQty       Decimal? @db.Decimal(12, 4)
  delta        Decimal? @db.Decimal(12, 4)
  reason       String?
  payload      Json?

  job         WmsSyncJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([jobId])
  @@map("wms_sync_logs")
}

/// Observational only: last external qty seen, for diff reporting and
/// trend analysis. It is NOT the authority for the double-booking rule —
/// that lives on WmsAsnLineMap (per-ASN-line counters).
model WmsStockSnapshot {
  id            String   @id @default(cuid())
  connector     String
  warehouseId   String
  productId     String
  externalQty   Decimal  @db.Decimal(12, 4)
  imsQtyAtSync  Decimal  @db.Decimal(12, 4)   // IMS qty at the moment of comparison
  lastSeenAt    DateTime
  updatedAt     DateTime @updatedAt

  @@unique([connector, warehouseId, productId])
  @@index([warehouseId, productId])
  @@map("wms_stock_snapshots")
}

model WmsStockDiscrepancy {
  id              String                 @id @default(cuid())
  connector       String
  warehouseId     String
  productId       String?
  sku             String?
  category        WmsDiscrepancyCategory
  status          WmsDiscrepancyStatus   @default(OPEN)
  imsValue        String?
  wmsValue        String?
  delta           Decimal?               @db.Decimal(12, 4)
  message         String?
  detectionCount  Int                    @default(1)   // incremented on every re-detection
  firstSeenAt     DateTime               @default(now())
  lastSeenAt      DateTime               @default(now())
  resolvedAt      DateTime?
  resolvedBy      String?
  resolvedNote    String?

  // Open discrepancies are deduplicated per (connector, warehouse, product/sku, category).
  // Once resolved/ignored, a new occurrence opens a fresh row. The partial
  // unique index via status is enforced in the migration SQL.
  @@index([connector, status, category])
  @@index([productId])
  @@map("wms_stock_discrepancies")
}

model WmsInboundReceiptEvent {
  id              String   @id @default(cuid())
  connector       String
  externalEventId String   // idempotency key from webhook
  externalAsnId   String?
  payload         Json
  processedAt     DateTime?
  processingError String?
  receivedAt      DateTime @default(now())

  @@unique([connector, externalEventId])
  @@index([externalAsnId])
  @@map("wms_inbound_receipt_events")
}

model WmsReturnsInbox {
  id                String                @id @default(cuid())
  connector         String
  externalReturnId  String
  orderId           String?
  productId         String?
  sku               String?
  qty               Decimal?              @db.Decimal(12, 4)
  reason            String?
  reference         String?
  warehouseId       String?
  receivedAt        DateTime?
  status            WmsReturnsInboxStatus @default(NEW)
  rawPayload        Json?
  resolvedAt        DateTime?
  resolvedBy        String?
  resolutionNote    String?
  createdAt         DateTime              @default(now())
  updatedAt         DateTime              @updatedAt

  @@unique([connector, externalReturnId])
  @@index([status, connector])
  @@map("wms_returns_inbox")
}
```

**Migration SQL additions (not expressible in Prisma DSL):**

```sql
-- One open discrepancy per (connector, warehouseId, productId, category).
-- Resolved / ignored rows are excluded so the next occurrence can open fresh.
CREATE UNIQUE INDEX wms_stock_discrepancies_open_unique
  ON wms_stock_discrepancies (connector, warehouse_id, product_id, category)
  WHERE status = 'OPEN';

-- Same guard for barcode conflicts that have no productId (unmapped SKU).
CREATE UNIQUE INDEX wms_stock_discrepancies_open_sku_unique
  ON wms_stock_discrepancies (connector, warehouse_id, sku, category)
  WHERE status = 'OPEN' AND product_id IS NULL;
```

**Other uniqueness notes:**
- `ExternalWmsBinding.warehouseId @unique` — one binding per IMS warehouse.
- `@@unique([connector, externalWarehouseId])` on `ExternalWmsBinding` — the same Mintsoft warehouse cannot be bound twice.
- `WmsAsnLineMap.@@unique([asnMapId, externalAsnLineId])` — the per-line ledger's idempotency key.
- `WmsInboundReceiptEvent.@@unique([connector, externalEventId])` — webhook dedupe.

Also add back-relations:
- `Warehouse`: `wmsBinding ExternalWmsBinding?`
- `Product`: `wmsProductLinks WmsProductLink[]`, `wmsBundleLinks WmsBundleLink[]`

Create a migration named `YYYYMMDDHHMMSS_add_wms_connector`.

---

## Generic Contract: `lib/connectors/wms/types.ts`

```ts
export type WmsConnectorId = 'mintsoft'  // extend union when a second WMS lands

export type WmsCapabilities = {
  supportsStockMasterWarehouse: boolean
  supportsInboundAsn: boolean
  supportsAsnCallbacks: boolean
  supportsBundleSync: 'imsToWms' | 'wmsToIms' | 'both' | false
  supportsReturnsPolling: boolean
  supportsReturnsWebhook: boolean
  supportsPartialReceiptHandling: boolean
}

export type WmsProductDto = {
  sku: string
  name: string
  subvariantName?: string
  barcode?: string | null
  imageUrl?: string | null
  customsDescription?: string | null
  commodityCode?: string | null
  countryOfManufacture?: string | null
  weightKg?: number | null
  heightCm?: number | null
  widthCm?: number | null
  depthCm?: number | null
  shortDescription?: string | null
}

export type WmsStockLine = { sku: string; qty: number; isBundle?: boolean }

export type WmsAsnInput = {
  externalWarehouseId: string
  sourceType: 'PURCHASE_ORDER' | 'STOCK_TRANSFER'
  sourceReference: string
  eta?: Date
  supplierReference?: string
  packaging?: { type: string; parcels?: number; pallets?: number; containers?: number }
  carrier?: { name: string; trackingNumber?: string }
  lines: Array<{ imsLineId: string; sku: string; qty: number }>
  callbackUrl?: string
}

export type WmsFetchedProduct = {
  externalId: string
  sku: string
  barcode?: string | null
  name?: string | null
  raw?: unknown
}

export interface WmsConnector {
  readonly id: WmsConnectorId
  readonly capabilities: WmsCapabilities

  fetchWarehouses(): Promise<Array<{ externalId: string; label: string }>>

  // Product sync
  fetchProductBySku(sku: string): Promise<WmsFetchedProduct | null>         // REQUIRED for barcode three-way reconciliation; cached into WmsProductLink.lastKnownBarcode
  fetchProduct(externalId: string): Promise<WmsFetchedProduct | null>
  upsertProduct(dto: WmsProductDto, options?: { omitBarcode?: boolean }): Promise<{ externalId: string; returnedBarcode?: string | null }>

  // Stock
  fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]>

  // Inbound
  createAsn(input: WmsAsnInput): Promise<{ externalAsnId: string; lines: Array<{ externalLineId: string; imsLineId: string }> }>
  fetchAsn(externalAsnId: string): Promise<{ status: string; lines: Array<{ externalLineId: string; sku: string; receivedQty: number }> }>

  // Returns
  pollReturns(since: Date): Promise<Array<{ externalReturnId: string; sku?: string; qty?: number; orderReference?: string; reason?: string; payload: unknown }>>

  // Bundles (optional capability)
  upsertBundle?(bundle: { sku: string; name: string; components: Array<{ sku: string; qty: number }> }): Promise<{ externalBundleId: string }>
  fetchBundles?(): Promise<Array<{ externalBundleId: string; sku: string; name: string; components: Array<{ sku: string; qty: number }> }>>

  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean
}
```

Key contract points added in v2:
- `fetchProductBySku` / `fetchProduct` so the barcode reconciliation path has a reliable way to read the current WMS-side barcode (not cached guesses).
- `upsertProduct` accepts `omitBarcode` so the caller can explicitly suppress the barcode field when the three-way check detects a conflict.
- `createAsn` must return the mapping from `externalLineId → imsLineId` so the caller can populate `WmsAsnLineMap` atomically.

`lib/connectors/wms/registry.ts` mirrors `shopping-registry.ts`: exports a const array of `{id, label, available}`.

---

## Reconciliation ledger (revised — v2)

v1 keyed the ledger on `(connector, warehouseId, productId)`. That cannot distinguish between multiple open POs/ASNs for the same SKU, so the skip rule would allow the first receipt to absorb snapshot credit that actually belonged to a different ASN. **v2 keys the ledger per ASN line** — `WmsAsnLineMap`.

**Fields on `WmsAsnLineMap`:**
- `qtyAccountedViaSnapshot` — qty already credited to IMS stock by alignment-mode stock sync, attributed to this ASN line.
- `qtyAccountedViaReceipt` — qty already processed as a receipt against the IMS PO/transfer line.
- `lastProcessedReceivedQty` — the last cumulative `receivedQty` seen on the WMS callback; delta arithmetic uses this.
- `expectedQty` — authoritative ordered qty from the IMS PO/transfer line at ASN creation.

**Assignment rule (alignment-mode stock sync):**

When alignment-mode sync sees a positive delta on a SKU in a warehouse, it must attribute that delta to the **oldest open ASN line** for that (warehouse, productId) where `qtyAccountedViaSnapshot + qtyAccountedViaReceipt < expectedQty`. Attribution allocates up to the remaining unattributed capacity of that line, then spills into the next oldest. Deltas with no open ASN line become free-floating `RECEIPT_TIMING_CONFLICT` or `UNMAPPED_SKU` discrepancies and are **not** silently absorbed into stock — operator must investigate.

**Skip rule (Phase 6 callback handler):**

For each reported ASN line:
1. `delta = currentReceivedQty - lastProcessedReceivedQty`. If `delta <= 0`, noop (dedupe/retry).
2. `unabsorbedFromSnapshot = max(qtyAccountedViaSnapshot - qtyAccountedViaReceipt, 0)`.
3. `stockQtyToAdd = max(delta - unabsorbedFromSnapshot, 0)`.
4. `receiptQtyAccountedBySnapshot = min(delta, unabsorbedFromSnapshot)`.
5. Within a transaction:
   - advance `PurchaseOrderLine.qtyReceived` (or transfer-line equivalent) by `delta` — **always**, regardless of mode.
   - call the partial-receive helper with **both** `qtyReceived: delta` and `coveredBySnapshotQty: receiptQtyAccountedBySnapshot`. The helper records the full receipt quantity on the PO / transfer line, writes `PURCHASE_RECEIPT` / `TRANSFER_IN` stock only for `qtyReceived - coveredBySnapshotQty`, and writes a zero-qty `WMS_RECEIPT_RECONCILIATION` audit movement when `coveredBySnapshotQty > 0`.
   - advance `qtyAccountedViaReceipt` by `delta` (not just the uncovered portion); otherwise the same snapshot credit could be re-used on the next callback.
   - update `lastProcessedReceivedQty = currentReceivedQty`.

**Rollback on cancellation:** when a PO line or transfer line is cancelled or its qty is reduced below `qtyReceived`, the rollback path must unwind `qtyAccountedViaSnapshot` (by the cancelled portion) and emit a compensating `ADJUSTMENT` movement through `applyStockAdjustment` so the warehouse stock level doesn't drift. Add this to the existing PO cancel/reduce server actions when the PO has any active `WmsAsnLineMap` rows.

---

## Costing model for alignment mode

`applyStockAdjustment` creates an `ADJUSTMENT` movement and, on a positive delta, a cost layer at the warehouse's **current average cost** (falling back to 0 if no stock exists). That is **not equivalent** to PO-driven FIFO costing: a PO receipt creates a cost layer at the landed cost of that specific receipt, and the `StockMovement` type is `PURCHASE_RECEIPT` (consumed differently by COGS logic).

Implications for `ALIGN_TO_WMS` mode (Phase 2b / Phase 6):

1. **Alignment delta with a known open ASN line:** treat the delta as a provisional goods-in against that line. Do not call `applyStockAdjustment` — instead, create a cost layer at the PO line's expected unit cost (from `PurchaseOrderLine.unitCostBase`) and write a `StockMovement` of type `PURCHASE_RECEIPT` with `referenceType: 'WmsAsnLineMap'`, `referenceId: asnLineMapId`, `note: "WMS alignment snapshot; PO receipt pending"`. This keeps FIFO coherent when the Phase 6 callback later closes the loop.
2. **Alignment delta with no open ASN line:** log a `RECEIPT_TIMING_CONFLICT` discrepancy and **do not mutate stock**. This is safer than silently creating an orphan cost layer.
3. **Negative alignment delta** (WMS lower than IMS): always log a discrepancy. Never auto-consume FIFO layers — that's a COGS-affecting decision that must stay with the operator in v1.

Accounting impact: `StockMovement`s with `type = PURCHASE_RECEIPT` are already consumed by `AccountingSyncLog` queue writers. The Phase 6 handler must not re-queue an accounting entry for the `WMS_RECEIPT_RECONCILIATION` portion (it's a zero-qty audit marker, not a goods-in event).

This design means Phase 2b **cannot ship** until Phase 6 is ready, because the alignment-mode write path depends on an open `WmsAsnLineMap` row existing before an alignment adjustment can create a PO-linked cost layer.

---

## Order identity — Mintsoft ↔ IMS sales order resolution

`applyExternalFulfillmentUpdate` at `lib/fulfillment/external-fulfillment.ts:88` resolves orders by querying `shoppingOrderLink` with `connector: source`. Because Mintsoft is not a shopping connector, no row exists with `connector: 'mintsoft'` — so a naive call with `source: 'mintsoft'` would always return null.

**v3 resolution plan:**

1. Add `WmsConnection.orderLookupConnector` and set it to the storefront connector Mintsoft order references belong to (`'woocommerce'` or `'shopify'`). If more than one shopping connector is enabled, this field is **required** before the Mintsoft connection can be activated.
2. Extend `resolveOrderForExternalFulfillment` (same file, lines 28-75) with a Mintsoft-specific branch that:
   - looks up `ShoppingOrderLink` by `connector: connection.orderLookupConnector` plus `externalOrderNumber`, and
   - only falls back to direct `SalesOrder.orderNumber` when the payload is explicitly carrying the IMS order number.
3. Do **not** scan `ShoppingOrderLink` across "any shopping connector". `externalOrderNumber` is indexed but not globally unique across connectors, so that approach can update the wrong order in multi-connector tenants.
4. Do **not** create Mintsoft-scoped rows in `ShoppingOrderLink` — that table is for shopping connectors only. Mintsoft is a fulfillment relay, not an order source.
5. The plan's webhook/callback code must pass `lookup: {externalOrderNumber: ...}` or `lookup: {orderNumber: ...}`, never `externalOrderId`.

This change is small but critical and must land in Phase 1 (connector shell) so that anything downstream can rely on it.

---

## Permissions matrix

Uniform `requirePermission('sync')` is too coarse. Use this matrix in server actions:

| Action | Permission |
|---|---|
| View connector status, bindings, logs, reports | `sync` |
| Save credentials / base URL / webhook secret | `settings.company` |
| Enable/disable Mintsoft plugin | `settings.company` |
| Create / edit / delete warehouse binding | `settings.company` |
| Change `stockSyncMode` (any transition) | `settings.company` |
| Trigger manual sync run | `sync` |
| Resolve stock discrepancy / barcode conflict | `inventory.edit` |
| Create ASN from PO/transfer | `purchasing.receive` (POs) or `stock_control.transfer` (transfers) |
| Process ASN callback (internal) | no session (webhook) — signature + internal receipt helpers or explicit internal-bypass options |
| Handle returns inbox action | `sales.process` |
| Enable/disable cron jobs | `settings.company` |

These names already exist in `lib/permissions.ts` today. Do not introduce a parallel `settings.integrations` permission unless the whole app adopts it consistently.

---

## Plugin integration scope (touch points beyond `integration-plugins.ts`)

The current 4-plugin shape (`woocommerce | shopify | xero | quickbooks`) is hard-coded in more places than v1 acknowledged. Every one of these must be updated:

1. `lib/integration-plugins.ts` — add `'mintsoft'` to the union, `PLUGIN_SETTING_KEYS`, `DEFAULT_PLUGIN_STATE`, `isIntegrationModuleVisible` switch.
2. `components/settings/integration-plugins-settings.tsx` plus `app/(dashboard)/settings/system/page.tsx` — System → Plugins is the **current** plugin-toggle surface; Mintsoft must be added there.
3. Onboarding flow (`app/(dashboard)/onboarding/onboarding-client.tsx`, `components/onboarding/integrations-step.tsx`) — the integration-picker step currently enumerates only four plugins and has shopping/accounting exclusivity logic baked in.
4. `/sync` page gating — `app/(dashboard)/sync/page.tsx` currently redirects when no shopping/accounting connector is enabled; update the condition to include WMS plugins.
5. `app/(dashboard)/sync/sync-dashboard.tsx` — category union (`'shopping' | 'accounting'`) must be extended to `'warehouse'`, and connector selection / rendering must handle Mintsoft.
6. Dashboard layout + sidebar (`app/(dashboard)/layout.tsx`, `components/layout/sidebar.tsx`) — current props only consider WooCommerce/Xero visibility, so Mintsoft would stay hidden from navigation without changes here.
7. Scheduler UI (`app/(dashboard)/settings/system/page.tsx`) — new Mintsoft cron jobs should appear automatically via the cron registry, but the plugin-based filtering must include the new module id.

Grep for each of `'woocommerce'`, `'shopify'`, `'xero'`, `'quickbooks'` as literal string tokens during Phase 1 and list every file that branches on them — every such branch is a candidate update site.

---

## Phase Plan

Phases 0–2 are the near-term target; Phases 3–7 are already sketched in `docs/mintsoft-wms-connector-plan.md` and should be implemented once Phase 2 runs stably in production for one warehouse.

### Phase 0 — Discovery spike (no merge-to-main code)

**Goal:** confirm API shape before committing to DTOs.

**Deliverables:** scratch Node scripts (not in repo) that exercise:
- Mintsoft auth token lifecycle (24h key expiry behaviour, 401 retry)
- `GET /api/Warehouse` → warehouse list
- `POST /api/Product` and `PUT /api/Product/{id}` → product upsert; **confirm whether Mintsoft accepts the full customs/dimensions/image payload in one call and confirm barcode field name (`EAN`, `Barcode`, or other)**.
- `GET /api/Product/StockLevels?warehouseId=...` → stock feed
- `POST /api/ASN` + callback registration
- `GET /api/Returns` polling
- outbound shipment / status payloads — **confirm which order identity Mintsoft emits back** (`externalOrderNumber`, storefront order number, IMS order number, or another stable field). This determines how `orderLookupConnector` is validated in Phase 1.
- Bundle API (or confirm there is no public bundle CRUD — gates Phase 4 scope)

**Output:** `docs/mintsoft-api-discovery.md` with the field mapping matrix and any gaps.

### Phase 1 — WMS abstraction + connector shell

**Goal:** make the framework replaceable with zero business sync wired.

**Concrete changes:**
1. Add `'mintsoft'` to `IntegrationPluginId` in `lib/integration-plugins.ts:3`; add `plugin_mintsoft_enabled` to `PLUGIN_SETTING_KEYS`; add `DEFAULT_PLUGIN_STATE.mintsoft = false`; handle `case 'mintsoft'` in `isIntegrationModuleVisible`.
2. Add sensitive keys to `lib/settings-store.ts:9`: `mintsoft_api_key`, `mintsoft_webhook_secret`.
3. Create `lib/connectors/wms/` contracts + registry as specified above.
4. Create `lib/connectors/mintsoft/` skeleton (`api/client.ts`, `api/auth.ts`, `index.ts` exporting a stub that throws `NotImplemented` for every method).
5. Apply Prisma migration `add_wms_connector` with all enums + tables above, including `WmsConnection.orderLookupConnector`.
6. Add `lib/cron-jobs/wms-mintsoft.ts` with `registerCronJobs([...])` for `mintsoft-stock-sync`, `mintsoft-returns-sync`, `mintsoft-product-verify` (all `defaultEnabled: false`). Import it from `lib/cron-jobs/index.ts`.
7. Extend `lib/fulfillment/external-fulfillment.ts` so Mintsoft resolution uses `orderLookupConnector` rather than scanning every shopping connector.
8. Create `app/actions/wms-mintsoft.ts` with `saveConnectionSettings`, `createBinding`, `updateBinding`, `deleteBinding` — configuration writes guarded by `requirePermission('settings.company')`, validated with Zod, logging activity with `tag: 'sync'`.
9. Extend the existing System → Plugins UI (`components/settings/integration-plugins-settings.tsx`, `app/(dashboard)/settings/system/page.tsx`) so Mintsoft can be enabled/disabled there.
10. Scaffold Mintsoft into the **existing** `/sync` dashboard surface (new Mintsoft client component plus dashboard card), not a parallel `/settings/integrations/*` tree.
11. Update onboarding and sidebar visibility so enabling Mintsoft actually exposes Integrations in the current app shell.

**Acceptance (Phase 1):** `npm run type-check`, `npm run lint`, `npx prisma migrate deploy` all pass. Mintsoft appears in `/settings/system?tab=plugins` and in `/sync` when enabled. Plugin toggle appears and does not break other integrations.

### Phase 2 — Warehouse stock sync, NOTIFICATION_ONLY mode (**the core new requirement, v1 scope**)

**Goal:** make Mintsoft usable for stock visibility on one warehouse with IMS still stock master.

**Scope note (v2 tightening):** Phase 2 ships **only** `DISABLED` and `NOTIFICATION_ONLY`. `ALIGN_TO_WMS` is deferred to Phase 2b because it depends on Phase 6's per-line ledger and on the costing model in "Costing model for alignment mode" above. The binding UI still exposes the `ALIGN_TO_WMS` option, but selecting it pops a "requires Phase 2b — not yet available" warning and prevents save.

**2a. Binding UI**
- Implement `components/wms-mintsoft/warehouse-binding-dialog.tsx` with:
  - warehouse dropdown (sourced from IMS `Warehouse.findMany({where: {active: true}})`)
  - external warehouse dropdown (from Mintsoft `fetchWarehouses()` cached in settings)
  - `stockSyncMode` radio group via `stock-sync-mode-selector.tsx`, defaulting to `NOTIFICATION_ONLY`
  - `stockMasterSystem` shown read-only, derived from the mode
  - `syncFrequencyMinutes` input (default 60)
  - `discrepancyThresholds` editor (qty delta %, absolute delta)
  - report recipients (multi-email input)
  - `active` toggle

**Server actions (app/actions/wms-mintsoft.ts):**
- `createBinding(input)`: Zod-validate, enforce invariant `NOTIFICATION_ONLY ⇒ IMS`, `ALIGN_TO_WMS ⇒ WMS`. Reject if a binding already exists for that warehouse.
- `setStockSyncMode(bindingId, mode)`: same invariant. When transitioning `ALIGN_TO_WMS → NOTIFICATION_ONLY` or `DISABLED`, write a handover row to `WmsSyncJob` with `type: 'STOCK_SYNC'` and a final snapshot summary.
- `runStockSyncNow(bindingId)`: kicks the stock sync job synchronously (guarded by `requirePermission('sync')`).

**2b. Stock sync engine (`lib/connectors/mintsoft/sync/stock-sync.ts`)**

Implement one shared function `runStockSyncForBinding(bindingId, triggeredBy)` that:

1. Loads `ExternalWmsBinding` + `WmsConnection`; bails if `stockSyncMode === 'DISABLED'` or binding inactive.
2. Creates a `WmsSyncJob` row with `type: 'STOCK_SYNC'`, `status: 'RUNNING'`.
3. Calls `connector.fetchStockLevels(externalWarehouseId)`.
4. For each returned `WmsStockLine`:
   - resolve IMS product via `Product.findUnique({where: {sku}})` → if missing, record `UNMAPPED_SKU` discrepancy, continue.
   - load current IMS `StockLevel` for `(productId, warehouseId)`.
   - load `WmsStockSnapshot` (per `(connector, warehouseId, productId)`) — observational only, used for the diff report, not for the double-booking skip rule.
   - detect `RECEIPT_TIMING_CONFLICT` if the snapshot delta matches an open ASN's expected qty and PO line is still unreceived (join against `WmsAsnMap` + `PurchaseOrderLine.qtyReceived`).
   - if `stockSyncMode === 'NOTIFICATION_ONLY'`:
     - **never mutate stock.** Upsert `WmsStockSnapshot.externalQty` and log a `WmsSyncLog` line with `action: 'discrepancy'` (or `'noop'` if matched).
     - open / update a `WmsStockDiscrepancy` row when categorised.
    - if `stockSyncMode === 'ALIGN_TO_WMS'` (**Phase 2b only** — in Phase 2 this branch is dead code, guarded by the "option blocked" UI check):
     - apply the attribution algorithm from "Reconciliation ledger (revised)": resolve the positive delta to the oldest open `WmsAsnLineMap` row(s) for `(warehouseId, productId)`. Do **not** force the receipt APIs through fake zero-qty calls. Instead write a `StockMovement` of type `PURCHASE_RECEIPT` with `referenceType: 'WmsAsnLineMap'`, create a cost layer at `PurchaseOrderLine.unitCostBase`, and increment `WmsAsnLineMap.qtyAccountedViaSnapshot`.
     - if no open `WmsAsnLineMap` row exists for the delta: log `RECEIPT_TIMING_CONFLICT`, no stock mutation.
     - negative delta: log discrepancy, no stock mutation.
     - log `WmsSyncLog` line with `action: 'corrected' | 'conflict'`, before/after qty, delta, reason.
5. Update the `WmsSyncJob` counters + `status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'`. Update `WmsStockSnapshot.externalQty` + `imsQtyAtSync` + `lastSeenAt` for each checked SKU.
6. When mismatches exceed `discrepancyThresholds`, raise an **in-app** notification via `notify(...)` in `lib/notifications.ts` for each `reportRecipients` user. Email delivery requires a follow-up that routes through `lib/mailer.ts` / `EmailOutbox` — out of v1 scope.
7. Call `logActivity({tag: 'sync', action: 'mintsoft_stock_sync', entityType: 'SYSTEM', description: ...})`.

**2c. Cron endpoint `app/api/cron/mintsoft-stock-sync/route.ts`**

Mirror `app/api/cron/wc-reconcile/route.ts:9-24`:
```ts
export async function GET(request: Request) {
  const cronErr = await verifyCron(request); if (cronErr) return cronErr
  const maintenance = await getMaintenanceModeResponse('cron'); if (maintenance) return maintenance
  if (!(await isIntegrationPluginEnabled('mintsoft'))) return NextResponse.json({skipped: true, reason: 'Plugin disabled'})

  const bindings = await db.externalWmsBinding.findMany({
    where: { active: true, stockSyncMode: { in: ['NOTIFICATION_ONLY', 'ALIGN_TO_WMS'] } },
    include: { connection: true },
  })
  const due = bindings.filter(b => isDue(b.lastStockSyncAt, b.syncFrequencyMinutes))
  const results = await Promise.allSettled(due.map(b => runStockSyncForBinding(b.id, 'cron')))
  return NextResponse.json({ ran: results.length, details: summarise(results) })
}
```

**2d. Run report UI + CSV**

- `/sync/mintsoft/page.tsx` tabs: **Runs**, **Discrepancies**, **Barcode conflicts**, **Returns inbox**, **ASN activity**.
- **Runs tab:** list `WmsSyncJob` rows; clicking opens a drawer with `WmsSyncLog` detail table. All tables use `components/ui/table.tsx` with `containerClassName="max-h-[60vh]"` per `feedback_table_template.md`. SKUs rendered with `<ProductLink>`.
- **CSV export** at `app/api/export/mintsoft-sync/[jobId]/route.ts`: reuse `toCsv` + `csvResponse` from `lib/csv.ts`. Columns: timestamp, sku, name, imsBefore, wmsQty, imsAfter, delta, action, reason.

**2e. Deactivation / handover**

`deleteBinding(bindingId)`:
1. pause sync (already gated by `active`).
2. pull final snapshot into a new `WmsSyncJob` with `summary: {handover: true}`.
3. set `stockSyncMode: DISABLED`, `stockMasterSystem: IMS`, `active: false`.
4. `logActivity({action: 'mintsoft_binding_deactivated'})`.

**Acceptance (Phase 2):**
- Seed one test warehouse, bind as `NOTIFICATION_ONLY` against a Mintsoft sandbox.
- Introduce a qty mismatch in Mintsoft; run cron; assert IMS stock unchanged, `WmsStockDiscrepancy` row appears (deduplicated via the partial unique index on subsequent runs), `WmsStockSnapshot.externalQty` updated, run CSV lists the mismatch.
- **In-app notification** is raised to each user in `reportRecipients` via `notify(...)` from `lib/notifications.ts`. Email is **out of v1 scope** — to enable email, route through `lib/mailer.ts` + `EmailOutbox` in a follow-up.
- Select `ALIGN_TO_WMS` in the UI → blocked with a clear "not yet available" message; no binding mutation occurs.
- Deactivate the binding → handover row written to `WmsSyncJob`, snapshots flagged inactive, no further cron runs touch it.

### Phase 2b — `ALIGN_TO_WMS` stock mode (depends on Phase 6)

**Blocked on Phase 6.** Do not ship Phase 2b until Phase 6 has landed and the canonical partial-ASN double-booking test passes. Scope:

- Unblock the `ALIGN_TO_WMS` option in the binding UI.
- Implement the alignment-mode write path per "Costing model for alignment mode":
  - positive delta with an open `WmsAsnLineMap`: create a PO-linked cost layer, write `StockMovement` type `PURCHASE_RECEIPT` with `referenceType: 'WmsAsnLineMap'`, advance `qtyAccountedViaSnapshot`.
  - positive delta with no open ASN line: log `RECEIPT_TIMING_CONFLICT`, no mutation.
  - negative delta: log discrepancy, no mutation.
- Mode-switch safety:
  - `ALIGN_TO_WMS → NOTIFICATION_ONLY` or `DISABLED`: write handover `WmsSyncJob`; **reset `WmsAsnLineMap.qtyAccountedViaSnapshot = 0`** for all open ASN lines on bindings leaving alignment mode (stale credits would otherwise suppress later PO receipts); mark affected `WmsAsnLineMap` rows with `note: 'alignment credit cleared on mode exit'`.
  - `NOTIFICATION_ONLY → ALIGN_TO_WMS`: first alignment run is **dry-run-only** — produces a report showing what would change, no mutations. Operator explicitly confirms to promote the mode to live alignment. This prevents a first run from creating many large corrections with no baseline.
- The skip rule in the Phase 6 handler must read `binding.stockSyncMode` at callback processing time — in `NOTIFICATION_ONLY`, `qtyAccountedViaSnapshot` is always zero (because we never wrote to it), so the handler will always add stock normally. No additional guard needed, but assert this in tests.

### Phase 3 — Product sync IMS → Mintsoft (with barcode safety)

**`lib/connectors/mintsoft/sync/product-sync.ts`:**

Triggered on product create/update (from `app/actions/products.ts`), on manual re-sync, and nightly via `mintsoft-product-verify` cron.

For each eligible product:

1. Build neutral `WmsProductDto` from `Product` fields (map `description → customsDescription`, `hsCode → commodityCode`, `countryOfOrigin → countryOfManufacture`, `weight → weightKg`, dimensions, `imageUrl`).
2. Compute `payloadHash = sha256(JSON.stringify(dto))` and compare with `WmsProductLink.payloadHash`. If equal → skip.
3. **Barcode safety resolution** (five cases + collision guard):
   - **Read current Mintsoft barcode authoritatively.** Call `connector.fetchProduct(externalProductId)` (or `fetchProductBySku(sku)` if no link exists yet). Cache the returned value in `WmsProductLink.lastKnownBarcode`. Never trust a stale cache as the sole source.
   - **Case A** — IMS empty, WMS empty → noop.
   - **Case B** — IMS set, WMS empty → include barcode in upsert (fill gap in WMS).
   - **Case C** — IMS empty, WMS set → **do not call `upsertProduct`** for the barcode change. Within a transaction, attempt `Product.update({where: {id}, data: {barcode: wmsBarcode}})`.
     - On `P2002` unique-constraint violation (another IMS product already owns that barcode): **do not update**. Create a `BARCODE_CONFLICT` discrepancy with `imsValue = null`, `wmsValue = wmsBarcode`, `message = "Cannot backfill from WMS — barcode already owned by IMS product {other-id}"`. Surface in UI with the owning IMS product linked.
     - On success: create a `BARCODE_BACKFILLED_FROM_WMS` log entry (status `RESOLVED`) for audit.
   - **Case D** — IMS set, WMS set, equal → call `upsertProduct(dto)`; barcode included (WMS no-op).
   - **Case E** — IMS set, WMS set, **different** → call `upsertProduct(dto, {omitBarcode: true})`. Create a `BARCODE_CONFLICT` discrepancy with `imsValue`, `wmsValue`; surface in UI.
4. Call `connector.upsertProduct(dto, {omitBarcode: <per-case>})` → store `externalId` + `payloadHash` + `lastKnownBarcode` + `lastSyncedAt` in `WmsProductLink`.
5. On failure: write `lastError`, enqueue retry via a failed-item table or re-run on next nightly verify.

**Barcode conflict resolution UI (`components/wms-mintsoft/barcode-conflict-resolver.tsx`):**
- Four actions: "Keep IMS (push to WMS)", "Adopt WMS (update IMS)", "Clear both & resolve manually", "Mark for investigation (defer)".
- Each action maps to a server action that validates **cross-product barcode uniqueness before writing**:
  - "Adopt WMS" checks whether the WMS barcode is already held by another IMS product; if yes, the action fails with a clear error naming the owning product and does not mutate anything.
  - "Keep IMS" re-sends the IMS barcode via `upsertProduct` and relies on Mintsoft's own duplicate handling; surface Mintsoft's error cleanly.
- All resolutions call `logActivity({tag: 'inventory', action: 'barcode_conflict_resolved'})` with before/after values.

**Acceptance (Phase 3):**
- Create an IMS product with a barcode → pushed to Mintsoft on next sync.
- Edit Mintsoft barcode to a different value → next sync creates `BARCODE_CONFLICT`, IMS and WMS both unchanged.
- Operator picks "Adopt WMS" → IMS barcode updates, discrepancy resolves.
- Product without IMS barcode but Mintsoft has one → IMS is backfilled; a `BARCODE_BACKFILLED_FROM_WMS` log entry is created.
- WMS barcode collides with another IMS product's barcode → no mutation, `BARCODE_CONFLICT` with the owning product linked in the UI; "Adopt WMS" fails cleanly with a named error.

### Phase 4 — Bundle sync

Gated on Phase 0 discovery outcome. Neutral bundle DTO, three modes set per binding. Log `BUNDLE_DERIVATION_CONFLICT` when bundle stock semantics diverge but **do not auto-correct stock** — sync structure only.

### Phase 5 — ASN generation from POs and transfers

**Server actions (`app/actions/wms-mintsoft.ts`):** `createAsnFromPo(poId, asnInput)`, `createAsnFromTransfer(transferId, asnInput)`.

UI: `components/wms-mintsoft/asn-dialog.tsx` opened from the PO view and transfer view, visible only when destination warehouse has an active binding. Collects packaging type, parcels/pallets/containers, ETA, supplier reference, carrier, auto-callback toggle.

On submit, in a single `$transaction`:

1. Map IMS lines via `WmsProductLink.externalProductId` (for each IMS line; fail loudly on unmapped SKUs — no silent skips).
2. Call `connector.createAsn(input)`. Its return value **must** include the `externalLineId → imsLineId` mapping (see revised `WmsConnector` contract).
3. Create one `WmsAsnMap` row for the ASN.
4. Create one `WmsAsnLineMap` row per line, populated with `expectedQty` from the source PO/transfer line, `sourceType`, `sourceLineId`, `productId`, `sku`, and zeroed counters.

Idempotency key: `asn:{sourceType}:{sourceId}`. If an `asn_create` job is retried, check for an existing `WmsAsnMap` for the source document and return it rather than calling Mintsoft again.

**Callback URL registration:** `WmsAsnInput.callbackUrl` is built from `getPublicAppUrl()` + `/api/webhooks/mintsoft/asn-booked-in`. The HMAC secret registered with Mintsoft is `mintsoft_webhook_secret` (stored via `lib/settings-store.ts`). If Mintsoft supports global webhook registration rather than per-ASN, switch to one-time global registration in the connection settings page instead — Phase 0 discovery must resolve this.

### Phase 6 — Booked-in callback reconciliation (the double-booking rule)

**Webhook route `app/api/webhooks/mintsoft/asn-booked-in/route.ts`:**

1. Read raw body.
2. Verify signature via `connector.verifyWebhookSignature(rawBody, request.headers.get('x-mintsoft-signature'))` using HMAC-SHA256 + `timingSafeEqual` (mirror `lib/connectors/woocommerce/sync/webhook-verify.ts`).
3. Dedupe: upsert `WmsInboundReceiptEvent {externalEventId}` — if row already `processedAt != null`, return 200 with `{dedupe: true}`.
4. Enqueue processing (inline `await` is fine for v1), but **do not call session-gated server actions directly from the route handler**. The route must call an internal receipt service / helper that is safe for webhook use.

**Handler (`lib/connectors/mintsoft/sync/booked-in-handler.ts`):**

Apply the per-line skip rule from "Reconciliation ledger (revised)". For each line in the fresh ASN detail:

1. Load the `WmsAsnLineMap` row by `(asnMapId, externalAsnLineId)`. If missing (unexpected line), log and skip.
2. `delta = currentReceivedQty - lastProcessedReceivedQty`. If `delta <= 0`, noop.
3. `unabsorbedFromSnapshot = max(qtyAccountedViaSnapshot - qtyAccountedViaReceipt, 0)`.
4. `stockQtyToAdd = max(delta - unabsorbedFromSnapshot, 0)`.
5. `receiptQtyAccountedBySnapshot = min(delta, unabsorbedFromSnapshot)`.
6. Within a `$transaction`:
   - if `sourceType === 'PURCHASE_ORDER_LINE'`: call the internal PO-receipt helper with `[{poLineId, qtyReceived: delta, coveredBySnapshotQty: receiptQtyAccountedBySnapshot, warehouseId}]` and `externalIdempotencyKey: "receipt:{externalAsnLineId}:{currentReceivedQty}"`. The helper records the full receipt qty on the line, creates stock/cost only for `delta - coveredBySnapshotQty`, and writes a zero-qty `WMS_RECEIPT_RECONCILIATION` movement when `coveredBySnapshotQty > 0`.
   - if `sourceType === 'STOCK_TRANSFER_LINE'`: call the new transfer helper with `[{transferLineId, qtyReceived: delta, coveredBySnapshotQty: receiptQtyAccountedBySnapshot}]` plus the same external idempotency key semantics.
   - advance `WmsAsnLineMap.qtyAccountedViaReceipt += delta`, `lastProcessedReceivedQty = currentReceivedQty`, `lastCallbackAt = now()`.
7. After processing all lines, close the ASN if every line has `lastProcessedReceivedQty >= expectedQty`; close the PO or transfer if every IMS line is fully received.
8. Mark `WmsInboundReceiptEvent.processedAt = now()`.

**Key modifications to existing receipt functions:**

- **`receivePurchaseOrder` in `app/actions/purchase-orders.ts:1585`:**
  - add `options.externalIdempotencyKey?: string`. Store it on the new `PurchaseReceipt.externalKey` column (migration adds this with a partial unique index on `(externalKey) WHERE externalKey IS NOT NULL`). On retries, return the existing receipt.
  - extend each receipt line to carry `coveredBySnapshotQty?: number` (default `0`). Migration adds `PurchaseReceiptLine.coveredBySnapshotQty Decimal @default(0)` so the receipt audit trail records both the true received qty and the portion already represented in stock.
  - create an internal helper (`receivePurchaseOrderInternal`, name flexible) that the server action and the webhook handler both use. The public server action keeps the permission check; the internal helper takes an optional `internalBypassToken` or lives outside `app/actions`.
  - **Never** skip `qtyReceived` increment. The PO line must always reflect the true received qty. `coveredBySnapshotQty` only changes whether stock/cost movements are written for that slice.
- **`receiveTransferPartial` (new function in `app/actions/transfers.ts`):**
  - signature: `receiveTransferPartial(id, lines: Array<{transferLineId, qtyReceived, coveredBySnapshotQty?}>, options?: {externalIdempotencyKey?, internalBypassToken?})`.
  - mirrors `receiveTransfer`'s FIFO/cost-layer logic but scoped to the provided line deltas and with the same snapshot-covered split.
  - preserves the existing `receiveTransfer` behaviour for manual receipts — that function becomes a thin wrapper that collects all lines at full qty and calls `receiveTransferPartial`.
- **Both** functions must include their idempotency handling at the top (row-lock + external-key lookup) so retried callbacks do not re-apply, and both must be callable from webhooks without requiring a browser session.

**Acceptance (Phase 6) — the canonical partial-ASN double-booking test (run under `ALIGN_TO_WMS`, which requires Phase 2b):**
1. Bind warehouse as `ALIGN_TO_WMS`. Create PO for 100 units, status `PO_SENT`. Create the Mintsoft ASN → one `WmsAsnLineMap` row with `expectedQty=100`.
2. Mintsoft books in 60 units.
3. Alignment-mode stock sync runs → IMS stock += 60, `WmsAsnLineMap.qtyAccountedViaSnapshot = 60`, a `PURCHASE_RECEIPT` `StockMovement` is written with `referenceType: 'WmsAsnLineMap'`.
4. Mintsoft fires booked-in callback for 60.
5. Assert: PO line `qtyReceived = 60`; PO status `PARTIALLY_RECEIVED`; IMS stock is still 60 (not 120); `qtyAccountedViaReceipt = 60`; a `WMS_RECEIPT_RECONCILIATION` movement exists with qty 0.
6. Remaining 40 booked in, callback fires → PO `RECEIVED`, stock stays aligned.
7. Replay the callback: `lastProcessedReceivedQty` check produces `delta = 0`, handler returns `{dedupe: true}`, no mutation.

Notification-only equivalent: stock sync reports discrepancy (IMS=0, WMS=60) but does not mutate; `qtyAccountedViaSnapshot` stays 0; PO callback handler sees `unabsorbedFromSnapshot = 0` and takes the full-receipt path, adding the 60 normally.

### Phase 7 — Returns inbox

Polling cron + webhook (if API allows). On each return:
1. Upsert `WmsReturnsInbox` keyed by `(connector, externalReturnId)`.
2. Match to IMS order via existing `ShoppingOrderLink` (`connector: 'woocommerce'` / `'shopify'`) or by `orderNumber`. Re-use the extended `resolveOrderForExternalFulfillment` logic from the "Order identity" section.
3. Surface in `/sync/mintsoft` "Returns inbox" tab. Operator picks an action that dispatches to existing returns/refund/restock server actions.

---

## Integration With Existing External Fulfillment

Outbound shipment progression is **not** a new surface — Mintsoft uses the existing `applyExternalFulfillmentUpdate` at `lib/fulfillment/external-fulfillment.ts:88`. When Mintsoft reports pick/pack/ship events, the connector calls:

```ts
await applyExternalFulfillmentUpdate({
  source: 'mintsoft',
  lookup: { externalOrderNumber: woOrderNumber }, // Mintsoft is linked via WC order number
  targetShipmentStatus: 'SHIPPED',
  tracking: [{ trackingNumber, shippingService }],
})
```

No core changes needed. The `'mintsoft'` source is already supported at line 5.

---

## Verification Checklist

### Static

- `cd /root/ims/onetwo3d-ims-isolated && npm run type-check` clean
- `npm run lint` clean
- `npx prisma validate` and `npx prisma migrate dev --name add_wms_connector` succeed
- `npx prisma generate` produces types for every new model

### Per-phase smoke tests (manual, dev server)

1. **Plugin toggle**: enable Mintsoft plugin in `/settings/system?tab=plugins`, confirm Mintsoft appears in `/sync`; disable and confirm Integrations visibility updates correctly.
2. **Binding CRUD**: create/edit/delete a binding; confirm the enforced invariant between `stockSyncMode` and `stockMasterSystem`; confirm activity log entries.
3. **Stock sync modes**: run the cron manually via `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/mintsoft-stock-sync`; inspect `wms_sync_jobs` / `wms_sync_logs` in `npx prisma studio`; download the CSV from the run detail page.
4. **Barcode safety**: drive all five cases (empty/empty, IMS-only, WMS-only, equal, different); confirm no overwrite path executes outside the rule.
5. **Double-booking test** (Phase 6): run the canonical scenario above; verify final IMS stock is not double-counted; verify audit trail in `StockMovement` + `ActivityLog` + `WmsSyncLog`.
6. **Returns inbox**: trigger a return in Mintsoft sandbox; confirm it appears in `/sync/mintsoft` Returns tab linked to the IMS sales order.
7. **Webhook dedupe**: replay the same booked-in callback; confirm second call returns `{dedupe: true}` and no double receipt.

### Deploy

Use `scripts/deploy.sh` per memory `project_production_server.md` — never ad-hoc kill/build; apply the migration during build. Defaults are safe (plugin disabled, no bindings, no crons running).

---

## Critical Files to Modify (Phase 1–2 MVP)

| File | Change |
|---|---|
| `prisma/schema.prisma` | Append the WMS enums/models block, add relations on `Warehouse` and `Product`. |
| `prisma/migrations/YYYYMMDDHHMMSS_add_wms_connector/migration.sql` | Generated migration. |
| `lib/integration-plugins.ts:3-19,42-55` | Add `'mintsoft'` entries. |
| `lib/settings-store.ts:9-21` | Add `mintsoft_api_key`, `mintsoft_webhook_secret`. |
| `lib/cron-jobs/index.ts` | Import `./wms-mintsoft`. |
| `lib/cron-jobs/wms-mintsoft.ts` | **New** — register three cron jobs. |
| `lib/connectors/wms/*.ts` | **New** — generic contracts. |
| `lib/connectors/mintsoft/**/*.ts` | **New** — Mintsoft implementation. |
| `app/actions/wms-mintsoft.ts` | **New** — server actions. |
| `app/actions/purchase-orders.ts:1585` | Extend `receivePurchaseOrder` with `options.externalIdempotencyKey` plus per-line `coveredBySnapshotQty`, backed by an internal helper callable from webhooks. Add `PurchaseReceipt.externalKey` and `PurchaseReceiptLine.coveredBySnapshotQty` in the same migration. |
| `app/actions/transfers.ts:459` | Refactor `receiveTransfer` to delegate to a new `receiveTransferPartial(id, lineDeltas, options)` with the same idempotency + per-line covered-qty parameters, and an internal webhook-safe entry path. Existing full-transfer receive becomes a thin wrapper. |
| `lib/fulfillment/external-fulfillment.ts:28-75` | Extend `resolveOrderForExternalFulfillment` so Mintsoft uses `WmsConnection.orderLookupConnector` to scope storefront lookups instead of scanning all shopping connectors. |
| `prisma/schema.prisma` (StockMovementType enum) | Add `WMS_RECEIPT_RECONCILIATION` enum value. |
| `app/api/cron/mintsoft-stock-sync/route.ts` | **New** — Phase 2. |
| `app/api/cron/mintsoft-returns-sync/route.ts` | **New** — Phase 7. |
| `app/api/cron/mintsoft-product-verify/route.ts` | **New** — Phase 3. |
| `app/api/webhooks/mintsoft/asn-booked-in/route.ts` | **New** — Phase 6. |
| `app/api/export/mintsoft-sync/[jobId]/route.ts` | **New** — run report CSV. |
| `components/settings/integration-plugins-settings.tsx` | Add Mintsoft plugin toggle. |
| `app/(dashboard)/settings/system/page.tsx` | Pass Mintsoft state into the existing plugin/scheduler UI. |
| `app/(dashboard)/sync/page.tsx` | Update gating so warehouse connectors count as Integrations. |
| `app/(dashboard)/sync/sync-dashboard.tsx` | Add Mintsoft card in `'warehouse'` category. |
| `app/(dashboard)/layout.tsx` | Pass aggregated integration visibility into the dashboard shell so Mintsoft can expose `/sync`. |
| `components/layout/sidebar.tsx` | Ensure Integrations navigation appears for warehouse-category plugins too. |
| `components/onboarding/integrations-step.tsx` | Add Mintsoft to the onboarding integration picker. |
| `app/(dashboard)/onboarding/onboarding-client.tsx` | Update onboarding readiness logic for the new plugin. |
| `components/wms-mintsoft/**/*.tsx` | **New** — dialogs + tables. |
| `CHANGELOG.md` | Entry per `feedback_versioning.md` (minor bump). |
| `docs/mintsoft-wms-connector-plan.md` | Update with final decisions from Phase 0 discovery. |

---

## Out Of Scope For v1

- Multiple Mintsoft connections (single-instance assumption in `WmsConnection.@@unique([connector])`).
- Second WMS provider (contracts allow it but nothing built).
- Auto-resolution of barcode conflicts.
- Automatic return restocking.
- Bundle stock quantity reconciliation (only structure is synced).

---

## Recommendation

Ship Phase 0 → Phase 2 first, with all bindings forced to `NOTIFICATION_ONLY` and `defaultEnabled: false` on all crons. That is the safest possible rollout — IMS stock is untouched, the team gets a mirror of Mintsoft reality and a discrepancy backlog to triage. Only after one real warehouse has run clean notification-only for an agreed window do we enable `ALIGN_TO_WMS` and start Phase 5/6.
