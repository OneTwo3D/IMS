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
| Shopping link table pattern | `prisma/schema.prisma:1567-1619` | `ShoppingProductLink` / `ShoppingOrderLink`. **Do not reuse** — WMS gets its own `WmsProductLink`, `WmsBundleLink`, etc. so deletions and constraints are independent. |
| Product model | `prisma/schema.prisma:485-568` | Already has `barcode` (unique), `hsCode`, `countryOfOrigin`, `weight`, `widthCm/heightCm/depthCm`, `imageUrl`, `description`. No schema changes required for product sync payload. |
| Warehouse model | `prisma/schema.prisma:443-479` | Key on `Warehouse.code`. Do not add connector columns — use new `ExternalWmsBinding` table instead. |
| Stock adjustment | `app/actions/stock.ts:132-242` (`applyStockAdjustment`) | Signed qty, writes `StockMovement` + updates `StockLevel`. Called inside a transaction. Use for alignment-mode corrections. |
| PO receipt | `app/actions/purchase-orders.ts:1585` (`receivePurchaseOrder`) | Already idempotent via row lock + receipt reference. Must be extended to **skip stock mutation** when reconciliation ledger says the snapshot already absorbed it. |
| Transfer receipt | `app/actions/transfers.ts:459` (`receiveTransfer`) | Same pattern. Same extension. |
| Activity log | `lib/activity-log.ts:51` (`logActivity`) | Every mutation must call it. Tag `'sync'` or `'inventory'`. |
| Auth/permissions | `lib/auth/server.ts` (`requireAuth`, `requirePermission`), `lib/permissions.ts` | Use `requirePermission('sync')` on connector config and admin server actions. |
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
  settings/integrations/mintsoft/
    page.tsx                               # provider-level settings (credentials, token, callback secret)
    warehouses/
      page.tsx                             # list bindings
      [bindingId]/page.tsx                 # edit binding (stockSyncMode selector etc.)
  sync/
    mintsoft/
      page.tsx                             # run history, discrepancies, returns inbox

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

Add to `prisma/schema.prisma` after the existing `ShoppingProductLink` block (line 1619). Use snake_case `@@map` per project convention.

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
  provider         String   // 'mintsoft'
  label            String?
  active           Boolean  @default(true)
  baseUrl          String?
  tokenExpiresAt   DateTime?
  lastAuthAt       DateTime?
  callbackSecretId String?  // references Setting.key holding the HMAC secret
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  bindings         ExternalWmsBinding[]

  @@unique([provider])          // v1: single instance per provider
  @@map("wms_connections")
}

model ExternalWmsBinding {
  id                    String   @id @default(cuid())
  connectionId          String
  warehouseId           String   @unique        // one binding per IMS warehouse
  provider              String                  // denormalised, matches connection.provider
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

  @@unique([provider, externalWarehouseId])
  @@map("external_wms_bindings")
}

model WmsProductLink {
  id                String   @id @default(cuid())
  productId         String
  provider          String
  externalProductId String
  payloadHash       String?  // last-sent payload hash; skip network call when unchanged
  lastSyncedAt      DateTime?
  lastError         String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  product           Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([provider, externalProductId])
  @@unique([provider, productId])
  @@map("wms_product_links")
}

model WmsBundleLink {
  id              String   @id @default(cuid())
  productId       String   // IMS KIT / BOM product id
  provider        String
  externalBundleId String
  checksum        String?
  lastSyncedAt    DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  product         Product  @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@unique([provider, externalBundleId])
  @@unique([provider, productId])
  @@map("wms_bundle_links")
}

model WmsAsnMap {
  id               String   @id @default(cuid())
  provider         String
  externalAsnId    String
  sourceType       String   // 'PURCHASE_ORDER' | 'STOCK_TRANSFER'
  sourceId         String
  status           String   // provider-reported status
  lastCallbackAt   DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([provider, externalAsnId])
  @@index([sourceType, sourceId])
  @@map("wms_asn_maps")
}

model WmsSyncJob {
  id             String             @id @default(cuid())
  provider       String
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

  @@index([provider, type, status, startedAt])
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

model WmsStockSnapshot {
  id                          String   @id @default(cuid())
  provider                    String
  warehouseId                 String
  productId                   String
  externalQty                 Decimal  @db.Decimal(12, 4)
  stockQtyAccountedViaSnapshot Decimal @db.Decimal(12, 4) @default(0)
  stockQtyAccountedViaPo       Decimal @db.Decimal(12, 4) @default(0)
  netCorrectionApplied         Decimal @db.Decimal(12, 4) @default(0)
  lastSeenAt                  DateTime
  updatedAt                   DateTime @updatedAt

  @@unique([provider, warehouseId, productId])
  @@index([warehouseId, productId])
  @@map("wms_stock_snapshots")
}

model WmsStockDiscrepancy {
  id           String                 @id @default(cuid())
  provider     String
  warehouseId  String
  productId    String?
  sku          String?
  category     WmsDiscrepancyCategory
  status       WmsDiscrepancyStatus   @default(OPEN)
  imsValue     String?
  wmsValue     String?
  delta        Decimal?               @db.Decimal(12, 4)
  message      String?
  firstSeenAt  DateTime               @default(now())
  lastSeenAt   DateTime               @default(now())
  resolvedAt   DateTime?
  resolvedBy   String?
  resolvedNote String?

  @@index([provider, status, category])
  @@map("wms_stock_discrepancies")
}

model WmsInboundReceiptEvent {
  id              String   @id @default(cuid())
  provider        String
  externalEventId String   // idempotency key from webhook
  externalAsnId   String?
  payload         Json
  processedAt     DateTime?
  processingError String?
  receivedAt      DateTime @default(now())

  @@unique([provider, externalEventId])
  @@index([externalAsnId])
  @@map("wms_inbound_receipt_events")
}

model WmsReturnsInbox {
  id                String                @id @default(cuid())
  provider          String
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

  @@unique([provider, externalReturnId])
  @@index([status, provider])
  @@map("wms_returns_inbox")
}
```

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

export interface WmsConnector {
  readonly id: WmsConnectorId
  readonly capabilities: WmsCapabilities

  fetchWarehouses(): Promise<Array<{ externalId: string; label: string }>>
  upsertProduct(dto: WmsProductDto): Promise<{ externalId: string; returnedBarcode?: string | null }>
  fetchStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]>
  createAsn(input: WmsAsnInput): Promise<{ externalAsnId: string }>
  fetchAsn(externalAsnId: string): Promise<{ status: string; lines: Array<{ externalLineId: string; sku: string; receivedQty: number }> }>
  pollReturns(since: Date): Promise<Array<{ externalReturnId: string; sku?: string; qty?: number; orderReference?: string; reason?: string; payload: unknown }>>
  upsertBundle?(bundle: { sku: string; name: string; components: Array<{ sku: string; qty: number }> }): Promise<{ externalBundleId: string }>
  fetchBundles?(): Promise<Array<{ externalBundleId: string; sku: string; name: string; components: Array<{ sku: string; qty: number }> }>>
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean
}
```

`lib/connectors/wms/registry.ts` mirrors `shopping-registry.ts`: exports a const array of `{id, label, available}`.

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
- Bundle API (or confirm there is no public bundle CRUD — gates Phase 4 scope)

**Output:** `docs/mintsoft-api-discovery.md` with the field mapping matrix and any gaps.

### Phase 1 — WMS abstraction + connector shell

**Goal:** make the framework replaceable with zero business sync wired.

**Concrete changes:**
1. Add `'mintsoft'` to `IntegrationPluginId` in `lib/integration-plugins.ts:3`; add `plugin_mintsoft_enabled` to `PLUGIN_SETTING_KEYS`; add `DEFAULT_PLUGIN_STATE.mintsoft = false`; handle `case 'mintsoft'` in `isIntegrationModuleVisible`.
2. Add sensitive keys to `lib/settings-store.ts:9`: `mintsoft_api_key`, `mintsoft_webhook_secret`.
3. Create `lib/connectors/wms/` contracts + registry as specified above.
4. Create `lib/connectors/mintsoft/` skeleton (`api/client.ts`, `api/auth.ts`, `index.ts` exporting a stub that throws `NotImplemented` for every method).
5. Apply Prisma migration `add_wms_connector` with all enums + tables above.
6. Add `lib/cron-jobs/wms-mintsoft.ts` with `registerCronJobs([...])` for `mintsoft-stock-sync`, `mintsoft-returns-sync`, `mintsoft-product-verify` (all `defaultEnabled: false`). Import it from `lib/cron-jobs/index.ts`.
7. Create `app/actions/wms-mintsoft.ts` with `saveConnectionSettings`, `createBinding`, `updateBinding`, `deleteBinding` — all guarded by `requirePermission('sync')`, validated with Zod, logging activity with `tag: 'sync'`.
8. Scaffold `/settings/integrations/mintsoft/` page with empty tabs (Connection, Warehouses, Health). Use dialog forms per `feedback_dialog_forms.md`. Hide the whole route behind `isIntegrationPluginEnabled('mintsoft')`.
9. Add a "Mintsoft" card to `app/(dashboard)/sync/sync-dashboard.tsx` in a new `category: 'warehouse'` group.

**Acceptance (Phase 1):** `npm run type-check`, `npm run lint`, `npx prisma migrate deploy` all pass. `/settings/integrations/mintsoft` renders with empty tabs. Plugin toggle appears and does not break other integrations.

### Phase 2 — Warehouse stock sync modes (**the core new requirement**)

**Goal:** make Mintsoft usable for stock visibility OR stock authority on one warehouse.

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
   - load `WmsStockSnapshot` (per `(provider, warehouseId, productId)`).
   - detect `RECEIPT_TIMING_CONFLICT` if the snapshot delta matches an open ASN's expected qty and PO line is still unreceived (join against `WmsAsnMap` + `PurchaseOrderLine.qtyReceived`).
   - if `stockSyncMode === 'NOTIFICATION_ONLY'`:
     - **never mutate stock.** Upsert `WmsStockSnapshot.externalQty` and log a `WmsSyncLog` line with `action: 'discrepancy'` (or `'noop'` if matched).
     - open / update a `WmsStockDiscrepancy` row when categorised.
   - if `stockSyncMode === 'ALIGN_TO_WMS'`:
     - compute `delta = wmsQty - imsQty`.
     - if `delta === 0`: log noop, update snapshot timestamp.
     - else: within a Prisma `$transaction`, call `applyStockAdjustment(tx, {productId, warehouseId, qty: delta, note: 'Mintsoft alignment'})` using a dedicated `AdjustmentReason` (seeded as `WMS_ALIGNMENT`).
     - increment `WmsStockSnapshot.stockQtyAccountedViaSnapshot` by `delta` and update `netCorrectionApplied`. This is the field that the booked-in handler reads to decide whether to add stock twice.
     - log `WmsSyncLog` line with `action: 'corrected'`, before/after qty, delta, reason.
5. Update the `WmsSyncJob` counters + `status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'`.
6. When mismatches exceed `discrepancyThresholds`, send notification via `lib/notifications.ts` to `reportRecipients`.
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
- Seed two test warehouses. Bind one as `NOTIFICATION_ONLY`, the other as `ALIGN_TO_WMS` (against a Mintsoft sandbox).
- **Notification-only test:** introduce a qty mismatch in Mintsoft; run cron; assert IMS stock unchanged, `WmsStockDiscrepancy` row appears, report CSV lists the mismatch, email is sent.
- **Alignment test:** same mismatch; assert `StockLevel` moves to match Mintsoft, `StockMovement` row has type `ADJUSTMENT` and a note identifying the connector, `WmsStockSnapshot.stockQtyAccountedViaSnapshot` reflects the delta, run report shows before/after.
- Switch alignment binding back to notification-only: handover row written, no further mutations occur.

### Phase 3 — Product sync IMS → Mintsoft (with barcode safety)

**`lib/connectors/mintsoft/sync/product-sync.ts`:**

Triggered on product create/update (from `app/actions/products.ts`), on manual re-sync, and nightly via `mintsoft-product-verify` cron.

For each eligible product:

1. Build neutral `WmsProductDto` from `Product` fields (map `description → customsDescription`, `hsCode → commodityCode`, `countryOfOrigin → countryOfManufacture`, `weight → weightKg`, dimensions, `imageUrl`).
2. Compute `payloadHash = sha256(JSON.stringify(dto))` and compare with `WmsProductLink.payloadHash`. If equal → skip.
3. **Barcode safety resolution** (three-way):
   - fetch current Mintsoft barcode (from `WmsProductLink.metadata.lastKnownBarcode` or a `connector.fetchProduct(externalId)` call).
   - IMS empty, WMS empty → noop.
   - IMS set, WMS empty → include barcode in upsert (fill gap in WMS).
   - IMS empty, WMS set → **skip upsert for barcode**; instead, within a transaction, set `Product.barcode = wmsBarcode` (if not already taken by another product — handle unique constraint violation by creating a `BARCODE_CONFLICT` discrepancy), log `BARCODE_BACKFILLED_FROM_WMS` discrepancy (status `RESOLVED` automatically; operator can audit).
   - IMS set, WMS set, equal → include in upsert (Mintsoft will accept same value as no-op).
   - IMS set, WMS set, **different** → **omit `Barcode` from the outbound payload**; create a `BARCODE_CONFLICT` `WmsStockDiscrepancy` with `imsValue`, `wmsValue`; surface in UI.
4. Call `connector.upsertProduct(dto)` → store `externalId` + `payloadHash` + `lastSyncedAt` in `WmsProductLink`.
5. On failure: write `lastError`, enqueue retry via a failed-item table or re-run on next nightly verify.

**Barcode conflict resolution UI (`components/wms-mintsoft/barcode-conflict-resolver.tsx`):**
- three actions: "Keep IMS (push to WMS)", "Adopt WMS (update IMS)", "Mark for investigation".
- server action `resolveBarcodeConflict(discrepancyId, action)` applies the resolution and logs activity.

**Acceptance (Phase 3):**
- Create an IMS product with a barcode → pushed to Mintsoft on next sync.
- Edit Mintsoft barcode to a different value → next sync creates `BARCODE_CONFLICT`, IMS and WMS both unchanged.
- Operator picks "Adopt WMS" → IMS barcode updates, discrepancy resolves.
- Product without IMS barcode but Mintsoft has one → IMS is backfilled; a `BARCODE_BACKFILLED_FROM_WMS` audit row is created.

### Phase 4 — Bundle sync

Gated on Phase 0 discovery outcome. Neutral bundle DTO, three modes set per binding. Log `BUNDLE_DERIVATION_CONFLICT` when bundle stock semantics diverge but **do not auto-correct stock** — sync structure only.

### Phase 5 — ASN generation from POs and transfers

**Server actions (`app/actions/wms-mintsoft.ts`):** `createAsnFromPo(poId, asnInput)`, `createAsnFromTransfer(transferId, asnInput)`.

UI: `components/wms-mintsoft/asn-dialog.tsx` opened from the PO view and transfer view, visible only when destination warehouse has an active binding. Collects packaging type, parcels/pallets/containers, ETA, supplier reference, carrier, auto-callback toggle.

On submit: map lines via `WmsProductLink.externalProductId`, call `connector.createAsn(input)`, persist `WmsAsnMap`. Idempotency key `asn:{sourceType}:{sourceId}`.

### Phase 6 — Booked-in callback reconciliation (the double-booking rule)

**Webhook route `app/api/webhooks/mintsoft/asn-booked-in/route.ts`:**

1. Read raw body.
2. Verify signature via `connector.verifyWebhookSignature(rawBody, request.headers.get('x-mintsoft-signature'))` using HMAC-SHA256 + `timingSafeEqual` (mirror `lib/connectors/woocommerce/sync/webhook-verify.ts`).
3. Dedupe: upsert `WmsInboundReceiptEvent {externalEventId}` — if row already `processedAt != null`, return 200 with `{dedupe: true}`.
4. Enqueue processing (inline `await` is fine for v1).

**Handler (`lib/connectors/mintsoft/sync/booked-in-handler.ts`):**

1. Fetch fresh ASN detail via `connector.fetchAsn(externalAsnId)` to avoid trusting webhook payload alone.
2. Load `WmsAsnMap` → get `sourceType` + `sourceId`.
3. For each line:
   - `imsLine = findImsLine(sourceType, externalLineId)` using a line-level mapping stored at ASN creation time.
   - compute `delta = currentReceivedQty - previouslyProcessedQty` (stored per-line in ASN map JSON).
   - **reconciliation ledger check**: load `WmsStockSnapshot`; if `stockQtyAccountedViaSnapshot ≥ currentReceivedQty - stockQtyAccountedViaPo`, then stock is already on hand — **skip stock mutation**, just mark PO/transfer line received.
   - else: wrap in `$transaction` and call either `receivePurchaseOrder(poId, [{poLineId, qtyReceived: delta, warehouseId}])` or `receiveTransfer(transferId, ...)`. Increment `stockQtyAccountedViaPo`.
4. Update ASN map status; if all received, close PO/transfer.
5. Mark event `processedAt`.

**Key modification to existing `receivePurchaseOrder` in `app/actions/purchase-orders.ts:1585`:** add an optional `options.skipStockMutation: boolean` parameter (default `false`). When `true`, advance `qtyReceived` and write an audit `StockMovement` of type `PURCHASE_RECEIPT` with qty 0 and a note "accounted via WMS snapshot" (or no movement at all — pick the option that keeps FIFO cost layers consistent; because stock was introduced by `applyStockAdjustment` during alignment, the cost layer for that movement is the generic adjustment one, so `receivePurchaseOrder` should skip the layer creation too). Same change for `receiveTransfer`.

**Acceptance (Phase 6) — the canonical partial-ASN double-booking test:**
1. Bind warehouse as `ALIGN_TO_WMS`. Create PO for 100 units, status `PO_SENT`.
2. Create ASN in Mintsoft; Mintsoft books in 60 units.
3. Alignment-mode stock sync runs → IMS stock += 60, `stockQtyAccountedViaSnapshot = 60`.
4. Mintsoft fires booked-in callback for 60.
5. Assert: PO line `qtyReceived = 60`, PO status `PARTIALLY_RECEIVED`, IMS stock is still 60 (not 120), `stockQtyAccountedViaPo = 60`.
6. Remaining 40 booked in, callback fires → PO `RECEIVED`, stock stays aligned.

Notification-only equivalent: stock sync reports discrepancy (IMS=0, WMS=60) but does not mutate; PO receipt proceeds normally and adds the 60.

### Phase 7 — Returns inbox

Polling cron + webhook (if API allows). On each return:
1. Upsert `WmsReturnsInbox` keyed by `(provider, externalReturnId)`.
2. Match to IMS order via existing `ShoppingOrderLink` (provider `'woocommerce'` / `'shopify'`) or by `orderNumber`.
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

- `cd /root/ims/onetwo3d-ims && npm run type-check` clean
- `npm run lint` clean
- `npx prisma validate` and `npx prisma migrate dev --name add_wms_connector` succeed
- `npx prisma generate` produces types for every new model

### Per-phase smoke tests (manual, dev server)

1. **Plugin toggle**: enable Mintsoft plugin in `/settings/integrations`, confirm Mintsoft settings route becomes visible; disable and confirm it hides.
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
| `app/actions/purchase-orders.ts:1585` | Extend `receivePurchaseOrder` with `options.skipStockMutation`. |
| `app/actions/transfers.ts:459` | Same extension for `receiveTransfer`. |
| `app/api/cron/mintsoft-stock-sync/route.ts` | **New** — Phase 2. |
| `app/api/cron/mintsoft-returns-sync/route.ts` | **New** — Phase 7. |
| `app/api/cron/mintsoft-product-verify/route.ts` | **New** — Phase 3. |
| `app/api/webhooks/mintsoft/asn-booked-in/route.ts` | **New** — Phase 6. |
| `app/api/export/mintsoft-sync/[jobId]/route.ts` | **New** — run report CSV. |
| `app/(dashboard)/settings/integrations/mintsoft/**/*.tsx` | **New** — settings UI. |
| `app/(dashboard)/sync/mintsoft/page.tsx` | **New** — sync dashboard. |
| `app/(dashboard)/sync/sync-dashboard.tsx` | Add Mintsoft card in `'warehouse'` category. |
| `components/wms-mintsoft/**/*.tsx` | **New** — dialogs + tables. |
| `prisma/seed.ts` | Seed `AdjustmentReason` with `WMS_ALIGNMENT`. |
| `CHANGELOG.md` | Entry per `feedback_versioning.md` (minor bump). |
| `docs/mintsoft-wms-connector-plan.md` | Update with final decisions from Phase 0 discovery. |

---

## Out Of Scope For v1

- Multiple Mintsoft connections (single-instance assumption in `WmsConnection.@@unique([provider])`).
- Second WMS provider (contracts allow it but nothing built).
- Auto-resolution of barcode conflicts.
- Automatic return restocking.
- Bundle stock quantity reconciliation (only structure is synced).

---

## Recommendation

Ship Phase 0 → Phase 2 first, with all bindings forced to `NOTIFICATION_ONLY` and `defaultEnabled: false` on all crons. That is the safest possible rollout — IMS stock is untouched, the team gets a mirror of Mintsoft reality and a discrepancy backlog to triage. Only after one real warehouse has run clean notification-only for an agreed window do we enable `ALIGN_TO_WMS` and start Phase 5/6.
