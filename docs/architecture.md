# Architecture

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) with Server Components and Server Actions |
| Database | PostgreSQL via Prisma 7 ORM |
| Authentication | NextAuth v5 (Auth.js) with JWT sessions, credentials + passkey (WebAuthn) providers |
| PDF Generation | PDFKit with sharp for SVG-to-PNG conversion |
| Email | nodemailer (SMTP) |
| Charts | Recharts |
| Styling | TailwindCSS 4 |
| Process Manager | systemd service (`one-two-inventory.service`) |
| Reverse Proxy | nginx |


## System Overview

```
+-----------------------------------------------------------------+
|  Application Server                                             |
|                                                                 |
|  +----------+    +------------------------------------------+   |
|  |  nginx   |--->|  Next.js 16 (App Router)                 |   |
|  | :80/:443 |    |  - Server Components (UI)                |   |
|  +----------+    |  - Server Actions (mutations)            |   |
|                  |  - Route Handlers (API + PDF)            |   |
|                  |  - Auth.js v5 (session management)       |   |
|                  +-------------------+----------------------+   |
|                                      |                          |
+--------------------------------------|---(cron: 02:00/03:00/06:00)--+
                                       |       |
                      +----------------+-------+--------+
                      |                                 |
                      v                                 v
               +------------+                  +------------------+
               | PostgreSQL |                  | External APIs    |
               | (database) |                  | - WooCommerce    |
               +------+-----+                  | - Xero (UK)     |
                      |                        | - frankfurter.dev|
               +------+-----+                  | - SMTP           |
               |   Redis    |                  +------------------+
               |  (cache)   |
               +------------+
```


## Key Directories

| Directory | Purpose |
|---|---|
| `app/actions/` | Server Actions — all data mutations (products, sales, purchases, stock, settings, etc.) |
| `app/api/` | API Route Handlers — PDF generation, CSV export, cron endpoints, file uploads, webhooks |
| `components/` | React components organised by module (auth, inventory, layout, profile, settings, ui) |
| `lib/` | Shared utilities — database client, PDF generation, email templates, CSV handling, activity logging |
| `lib/connectors/` | External system connectors (WooCommerce, with interfaces for Shopify, Xero, QuickBooks) |
| `lib/connectors/woocommerce/` | WooCommerce connector module — order import, status sync, refund sync, product sync, stock sync |
| `prisma/` | Database schema, migrations, and seed data |
| `help-docs/` | User-facing help articles rendered in the app |
| `docs/` | Internal/admin/reference documentation kept in git only, plus repo copies of the user help docs |
| `scripts/` | Installation and maintenance scripts |
| `UPLOAD_STORAGE_DIR` / `PUBLIC_UPLOAD_STORAGE_DIR` | Env-configured persistent upload roots for private invoice PDFs, public branding assets, and avatar assets |


## Request Flow

### Web Request (Server Action)

```
Browser --> nginx --> Next.js Server Component
                    +-- Auth.js: validate JWT session
                    +-- Server Action: validate + mutate via Prisma
                    +-- revalidatePath / redirect
```

### API Route (PDF / Export / Cron)

```
Client --> nginx --> Next.js Route Handler (/api/...)
                   +-- Auth check (where applicable)
                   +-- Prisma query
                   +-- Response (JSON / PDF stream / CSV)
```


## Database Design

### Core Principles

**FIFO COGS** — Each goods receipt (purchase receive or opening stock) creates a `CostLayer` with a unit cost and remaining quantity. When stock is consumed (sale dispatch, adjustment, etc.), cost layers are consumed oldest-first per product per warehouse, creating `CogsEntry` records.

**Multi-currency** — Every monetary record stores both foreign-currency and base-currency amounts:
- `*Foreign` fields: amount in the transaction currency
- `*Base` fields: value in the organisation base currency at the time of transaction
- `fxRateToBase`: the exchange rate used. Convention: 1 base = X document-currency (matches frankfurter/ECB output direction).
- The same rate is pushed downstream to Xero on every invoice/bill/credit note (as `CurrencyRate`, inverted) so the accounting platform never substitutes its own daily rate. See `docs/xero-sync.md` § Multi-Currency FX Rates.

**Landed costs** — A freight PO (`type = FREIGHT`) is linked to a goods PO via `LandedCostLink`. When the goods PO is received, landed costs are distributed across cost layers. Distribution methods: by value, by weight, by quantity, or equal split.

**Stock reservation** — `StockLevel.reservedQty` tracks stock that is allocated but not yet dispatched. Sales allocations reserve the remaining allocated quantity after non-pending shipment lines are subtracted. In-progress manufacturing reserves component stock for assemblies and the input SKU for disassemblies. Stock transfers do not currently reserve `reservedQty`; dispatch removes source on-hand quantity and receipt creates destination stock. `lib/domain/inventory/reservation-breakdown.ts` exposes the per-source breakdown and the inventory invariant report flags any delta between known reservation sources and `StockLevel.reservedQty`.

**Product reporting categories** — `ProductCategory` is a normalized hierarchy used to slice inventory, turnover, aging, stock-on-hand, and reorder reports. `Product.categoryId` is optional so existing products can remain uncategorized during rollout; CSV import/export and product create/edit use the category display name and create the category on first use. Names are capped at 100 characters, normalize case/diacritics/invisible characters for matching, and preserve the first display spelling for each normalized key.

**Stock movement reporting value** — New `StockMovement` rows carry `unitCostBase` and `totalValueBase` so inventory movement reports and CSV exports can read value directly from the movement table instead of joining COGS entries or cost layers. Outbound movements derive value from FIFO/CogsEntry consumption, inbound movements derive it from the created cost layer or transfer snapshot, and historical demand imports or positive adjustments with no prior cost source use zero cost as known-unknown provenance. Backfilled rows that cannot be derived remain `NULL`; aggregate queries must either `COALESCE(totalValueBase, 0)` or filter `IS NOT NULL` explicitly. Migration `20260528162500_stock_movement_values` records unresolved per-type counts in `stock_movement_backfill_audit`, preserving the first run timestamp and updating the latest run/count on retry. The database enforces that value fields are both null or both populated and that populated `totalValueBase` equals `ROUND(qty * unitCostBase, 6)`. Deferred movement-evidence triggers require positive `PURCHASE_RECEIPT`/`PRODUCTION_IN`/inbound `ADJUSTMENT` rows to have matching cost-layer evidence and positive `SALE_DISPATCH`/`PRODUCTION_OUT`/outbound `ADJUSTMENT` rows to have `CogsEntry` evidence by commit time. The inventory invariant report mirrors those guarantees and uses a hybrid absolute/relative tolerance so small movements do not hide large percentage drift and very large movements do not fail on immaterial cent-level rounding. See `docs/stock-movement-reporting-guarantees.md` for the deployment and repair runbook.

**Inventory snapshots** — `InventorySnapshot` stores one daily product/warehouse position for historical analytics. The daily `/api/cron/inventory-snapshot` job runs at `00:00 UTC` and writes rows idempotently on `(snapshotDate, productId, warehouseId)` for the just-ended UTC day: `qty` comes from `StockLevel.quantity`, `valueBase` comes from `SUM(CostLayer.remainingQty * unitCostBase)`, and `unitCostBase` is the weighted average `valueBase / qty` when quantity is positive. Rows are sparse: a missing row means zero position, so report queries must use `LEFT JOIN`/`COALESCE` when they need explicit zero days. `InventoryReservationSnapshot` stores matching daily reserved/available evidence, also idempotent by `(snapshotDate, productId, warehouseId)`, but writes only positive reserved/source-evidence rows; `InventoryReservationSnapshotRun` marks a date as captured so reports can distinguish zero-reserved sparse rows from missing reservation evidence. Product and warehouse foreign keys intentionally use the same restrict-on-delete behavior as `InventorySnapshot`, preserving historical reporting rows unless the operator explicitly purges the dependent snapshots first. The job reports, but does not block on, quantity drift between stock levels and remaining FIFO layers using the standard `0.0001` quantity tolerance. `npm run inventory:snapshots:backfill -- --from YYYY-MM-DD [--to YYYY-MM-DD]` seeds older daily rows from current state plus reverse `StockMovement` replay; historical value replay depends on `StockMovement.totalValueBase`, so nullable legacy movement values are reported as missing-value movements and make the value replay advisory. Adding `--include-reservations` runs a conservative reservation pass that writes sparse reservation rows plus the daily run marker only for days that pass the current-source timestamp gate; unsupported days and negative available quantities are reported in `reservationBackfill.warnings` and unsupported days remain explicit missing-evidence days in reports. The gate cannot detect hard deletes or raw SQL changes that bypass `updatedAt`, and it rejects current graphs with committed shipment lines or in-progress assembly orders because their dependent histories are not timestamped. See `docs/inventory-snapshots.md` for the operator runbook.

**As-of on-hand reporting** — `getOnHandAsOf` in `lib/domain/inventory/get-on-hand-as-of.ts` is the shared historical on-hand helper for future stock-on-hand and turnover reports. Date-only inputs are interpreted as end-of-day UTC; operators in other timezones must convert before calling it. The helper uses four source modes: `current` (live `StockLevel` plus open `CostLayer` values), `snapshot_forward_replay` (nearest prior `InventorySnapshot` plus forward inclusive `StockMovement` replay), `future_snapshot_reverse_replay` (first later snapshot reversed back when no prior snapshot exists), and `current_reverse_replay` (current state reversed back inside a serializable transaction when supported). `asOf` is inclusive; the snapshot anchor is exclusive because snapshots represent the just-ended UTC day. Consumers must check `valueReplayReliable`, `missingValueMovementCount`, `orphanWarehouseMovementCount`, and `missingValueMovementSample`; when reliability is false, quantities are useful but value/unit-cost fields are advisory. Movement replay pages at 10,000 rows per query, so large no-snapshot fallbacks should be filtered by product, warehouse, or category where possible.

**Stock position reports** — `/analytics/stock-on-hand`, `/analytics/inventory-aging`, `/analytics/dead-stock`, `/analytics/stock-allocations`, and `/analytics/negative-stock` share the stock-position report shell and are visible to users with analytics permission plus `WAREHOUSE`. The sidebar uses the same stock-position access policy: analytics roles see the full analytics group, while `WAREHOUSE` sees only these stock-position links. Stock on hand uses `getOnHandAsOf` for quantity/value. Current reports and `current_reverse_replay` fallbacks use live `StockLevel.reservedQty`; snapshot-backed as-of reports use `InventoryReservationSnapshot` when the date has a reservation snapshot run, treating sparse missing rows as zero reserved. If reservation evidence is missing, rows are explicitly marked `current_missing_snapshot` and fall back to current reservations. Stock-on-hand CSV exports append `reservationQtySource`, `reservationSnapshotDate`, and `reservationSourceCount`; fallback rows use `unknown` for the source-count sentinel. Inventory aging uses `lib/domain/inventory/inventory-health-reports.ts` to bucket FIFO `CostLayer` quantity/value by receipt age; historical as-of dates add back later `CogsEntry` consumption per layer before bucketing. Aging value uses the current `CostLayer.unitCostBase`, so retrospective landed-cost revaluations are not replayed for historical as-of dates. BOM products age from their own production cost layers. Virtual KIT SKUs are excluded from the default aging list so totals do not double-count component stock; filtering Type to KIT switches to `inventoryReports.kitAgingMode = "component"` semantics and shows component-layer quantity and value for components used by matching KIT SKUs. Dead stock reports current positive-stock rows with no `SALE_DISPATCH` movement inside the selected no-sales threshold, excludes never-sold products first stocked less than the threshold ago using historical receipt evidence rather than only open cost layers, and values rows from remaining cost layers. Returns are not netted off for demand evidence: a SKU sold and returned still counts as having demand in the selected window. Stock allocations uses `reservation-breakdown.ts` and adds an `other` row whenever known source rows do not reconcile to `StockLevel.reservedQty`; positive drift is labelled unattributed reserved balance and negative drift is labelled over-attributed reserved balance. Negative stock reconstructs the selected UTC movement window from an opening as-of balance and also includes currently negative `StockLevel` rows even when no movement happened inside the window. CSV exports use `/api/export/stock-position` and are capped at 50,000 filtered rows; inventory-aging and dead-stock CSV rows omit repeated report-level metadata such as `asOf`, `generatedAt`, `kitAgingMode`, and `thresholdDays`, while provenance-heavy stock-on-hand exports keep row-level source fields. Operators must narrow filters before exporting larger result sets.

**Inventory velocity and health reports** — `lib/domain/inventory/velocity.ts` is the shared Decimal-safe calculation layer for inventory aging, turnover, dead-stock, velocity rankings, ABC analysis, and future reorder planning. Date-only velocity windows are inclusive UTC calendar days, with `dateTo` expanded to the end of the UTC day. Callers pass normalized sale/position/layer rows; connector/report collectors must exclude returns, adjustments, and other non-demand movements before calling `calculateDailyVelocity`, which rejects negative qty/COGS/revenue rather than masking bad collector input. Dead-stock requires a velocity window at least as wide as the threshold, treats recent never-sold SKUs as new stock by default, and classifies a SKU as dead when `daysSinceLastSale >= thresholdDays`. Aging buckets are validated before use and preserve total on-hand quantity/value per SKU. ABC uses configurable cumulative cutoffs and keeps the threshold-breaking row in the higher class; turnover returns null ratios when average inventory value is zero.

**Replenishment and demand planning reports** — `/analytics/reorder`, `/analytics/backorder`, and `/analytics/component-shortage` are read-only demand-planning reports backed by `lib/domain/inventory/replenishment-reports.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/replenishment` and do not reuse warehouse-only stock-position export access. Reorder planning uses `Product.reorderPoint`, `Product.reorderQty`, `Product.safetyStockQty`, optional `Product.abcClass`, `SupplierProduct.leadTimeDays`, current available stock, inbound open purchase-order quantity, and the shared SALE_DISPATCH velocity helper. Suggested reorder qty is never negative and is calculated as `max(configured reorder qty, demand during lead time + safety stock - available - inbound open PO)`. Backorder demand aggregates non-cancelled sales-order lines where ordered quantity exceeds committed shipment quantity plus allocated quantity, then surfaces expected inbound open PO quantity and earliest projected fill date. Component shortage rolls up BOM component requirements from draft and in-progress production orders and subtracts current available stock plus inbound open PO quantity per component/warehouse.

**Sales and fulfillment analytics** — `/analytics/sales`, `/analytics/customers`, `/analytics/margin`, `/analytics/returns`, `/analytics/fulfillment`, and `/analytics/throughput` are read-only sales/operations reports backed by `lib/domain/sales/sales-fulfillment-analytics.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/sales-analytics`. Sales and customer totals use `SalesOrder.totalBase`/`totalForeign` and exclude cancelled orders; product/category sales views allocate order-level totals across lines by line value so grand totals reconcile to the order totals. Gross margin uses `CogsEntry.totalCostBase` linked to `SALE_DISPATCH` stock movements and never recalculates FIFO. Returns use `SalesOrderRefundLine` plus same-period `SALE_DISPATCH` quantities for return-rate context. Fulfillment KPIs use `Shipment.shippedAt` and `ShipmentLine.qty`; throughput uses `shipment_status_changed` `ActivityLog` rows linked by shipment metadata plus current pending/picking/packed queue depth.

**Purchasing and supplier analytics** — `/analytics/open-pos`, `/analytics/supplier-performance`, `/analytics/ppv`, `/analytics/spend`, and `/analytics/lead-times` are read-only procurement reports backed by `lib/domain/purchasing/purchasing-analytics.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/purchasing-analytics`. Open POs use `PurchaseOrder.status in (PO_SENT, PARTIALLY_RECEIVED, SHIPPED)`. Supplier on-time metrics compare `PurchaseReceipt.receivedAt` with `PurchaseOrder.expectedDelivery`. PPV uses the previous received PO line for the same supplier/SKU as its base-currency reference source because `SupplierProduct.lastUnitCost` is stored in supplier currency. Spend rows allocate received PO totals across supplier/category/month and reconcile to `SUM(PurchaseOrder.totalBase)`. Lead-time P95 feeds replenishment when `SupplierProduct.leadTimeDays` is unset.

**Inventory costing reports** — `/analytics/inventory-valuation`, `/analytics/cogs`, `/analytics/landed-cost`, and `/analytics/inventory-turnover` share `lib/domain/inventory/inventory-costing-reports.ts` and are visible only to `ADMIN`, `MANAGER`, and `FINANCE` via `analytics.inventory_costing`. Inventory valuation reuses `getOnHandAsOf` so quantity/value provenance matches stock-on-hand reporting; current values come from open FIFO `CostLayer` rows and historical values come from `InventorySnapshot` plus movement replay. COGS totals come directly from `CogsEntry.totalCostBase` and are not recalculated from FIFO layers; revenue and gross margin are shown only where `SALE_DISPATCH` movement references can be matched to a sales order line for the same product. Landed-cost analysis compares `PurchaseOrderLine.unitCostBase` with `landedUnitCostBase`, groups uplift by the PO's `landedCostMethod`, and surfaces `LandedCostRevaluationRun` counts by primary PO. Inventory turnover uses only sales-dispatch COGS and divides it by average daily inventory value from observed `InventorySnapshot` days; snapshot coverage is shown per row so missing cron/data days are visible, and rows with zero observed average value show blank turnover ratios. Supplier grouping splits multi-supplier SKU value evenly across linked suppliers and excludes supplierless SKUs with a report notice. GL stock/COGS variance comes from `AccountingAccountBalanceSnapshot`, populated from the Integrations account-mapping tab by Xero Trial Balance ingestion for the configured inventory asset and COGS account mappings. Inventory valuation compares total IMS stock value with the latest matching stock asset snapshot on or before the as-of date. COGS compares the report period with the movement between opening and closing COGS snapshots; when either snapshot is missing, reports show an explicit no-snapshot notice and keep GL variance blank.

| Stock Movement Type | Reporting Value Source |
|---|---|
| `ADJUSTMENT` | Positive adjustments use average/historical cost; negative adjustments use FIFO consumption. |
| `KIT_ASSEMBLY_IN` | Reserved legacy type; active manufacturing assembly writes `PRODUCTION_IN`. |
| `KIT_ASSEMBLY_OUT` | Reserved legacy type; active manufacturing assembly writes `PRODUCTION_OUT`. |
| `OPENING_STOCK` | Opening stock uses the explicit opening unit cost. |
| `PRODUCTION_IN` | Manufacturing output/recovery uses consumed component and overhead cost. |
| `PRODUCTION_OUT` | Manufacturing consumption/disassembly uses FIFO consumption. |
| `PURCHASE_RECEIPT` | Purchase receipts use landed or gross purchase unit cost. |
| `RETURN_INBOUND` | Customer returns use shipped cost snapshots where available. |
| `SALE_DISPATCH` | Sales dispatch uses FIFO consumption; historical imports use the zero-cost provenance sentinel. |
| `TRANSFER_IN` | Transfer receipts use the dispatch FIFO snapshot slice. |
| `TRANSFER_OUT` | Transfer dispatch uses FIFO consumption. |
| `WMS_RECEIPT_RECONCILIATION` | WMS reconciliation uses source PO/transfer cost or zero-value audit markers. |

The value writer surface is broad by design. New movement writers must route through `lib/domain/inventory/stock-movement-value.ts` and either populate both value fields, intentionally leave both `NULL` for non-derivable historical data, or document an explicit zero-cost provenance sentinel. Consumption-based writers currently use a two-phase transaction pattern: create the movement, consume FIFO using the movement id, then update the movement value fields inside the same transaction. The intermediate `NULL` state is not externally observable under normal transaction isolation, but repeated writer implementations should be consolidated if another movement writer is added. Scheduled invariant checks restrict stock-movement value scans to a 90-day window by default (`INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS`) to avoid daily full-table scans; admin/on-demand invariant reports leave the window unset for historical audits. CSV exports emit fixed dot-decimal numeric literals for these value fields regardless of server locale.

### Quantity Constraint Monitoring

The database and the invariant report intentionally overlap on core quantity integrity checks:

| Database CHECK Constraint | Inventory Invariant Code |
|---|---|
| `stock_levels_quantity_nonnegative` | `stock_negative_quantity` |
| `stock_levels_reserved_nonnegative` | `stock_negative_reserved_quantity` |
| `cost_layers_received_nonnegative` | `cost_layer_negative_received_quantity` |
| `cost_layers_remaining_qty_non_negative` | `cost_layer_negative_remaining_quantity` |
| `cost_layers_remaining_qty_lte_received_qty` | `cost_layer_remaining_exceeds_received` |
| `stock_movements_qty_nonnegative` | `stock_movement_negative_quantity` |

The CHECK constraints prevent new bad writes. The invariant report remains the read-only backstop for historical drift, manual SQL damage, and rollout verification.

**Discount storage** — Discounts are stored separately as `discountStr` (the original input) and `discountAmount` (the computed value). Prices are never baked with discounts applied.

**Tax rate snapshotting** — Sales orders store `taxRateName` and `taxRatePercent` at creation time, ensuring historical accuracy if tax rates change later.

**Key-value settings store** — The `Setting` model provides a generic key-value store with JSON-encoded values for all application configuration that does not warrant its own table.

### Product Types

| Type | Description | Stockable | Has Components |
|---|---|---|---|
| `SIMPLE` | Standalone product | Yes | No |
| `VARIABLE` | Parent grouping for variants | No | No |
| `VARIANT` | Child of a VARIABLE parent, own SKU | Yes | No |
| `KIT` | Virtual bundle — components deducted on sale; can also sit under a VARIABLE parent as a bundle variant | Calculated | Yes |
| `BOM` | Manufactured product — stock exists after production; can also sit under a VARIABLE parent as a BOM variant | Yes | Yes |
| `NON_INVENTORY` | Service or fee — not stock-tracked | No | No |

Transform rules:

- `VARIABLE` remains a pure parent and cannot be transformed through the standard editor.
- `NON_INVENTORY` cannot be transformed through the standard editor.
- `SIMPLE`, `VARIANT`, `KIT`, and `BOM` can be transformed only when the product has no attached stock or open operational records.
- Blockers include stock on hand, reserved stock, open sales order lines, open purchase order lines, open production orders, and open transfer lines.
- This prevents converting bundles or BOMs back to simple products while operational state is still attached.

### Key Models

**Core Inventory:**
- `Product` — all product types, with SKU, pricing, dimensions, weight, stock unit, images, HS code, country of origin
- `ProductCategory` — optional product reporting hierarchy for inventory and sales/purchase report slices
- `ProductOption` — variant options (e.g. Colour, Size) with comma-separated values
- `ProductComponent` — component list for KIT and BOM products
- `Warehouse` — locations (STANDARD, QUARANTINE, RESTOCK types)
- `StockLevel` — quantity and reserved quantity per product per warehouse
- `CostLayer` — FIFO cost layers with received/remaining quantities and unit cost
- `CogsEntry` — consumption records linking cost layers to stock movements
- `StockMovement` — audit trail of all stock changes

**Purchasing:**
- `Supplier`, `SupplierProduct` — supplier catalogue with per-supplier pricing
- `PurchaseOrder` — GOODS or FREIGHT type, multi-status workflow
- `PurchaseOrderLine` — line items with purchase unit conversion, tax, landed cost
- `PurchaseUnit` — packaging-to-stock unit conversion
- `PurchaseReceipt`, `PurchaseReceiptLine` — goods received records
- `PurchaseInvoice`, `PurchaseInvoiceLine` — supplier invoice records with PDF upload
- `PurchaseReturn`, `PurchaseReturnLine` — goods returned to supplier
- `LandedCostLink`, `FreightCostLine` — landed cost tracking

**Sales:**
- `Customer` — with billing/shipping addresses, tax number
- `SalesOrder`, `SalesOrderLine` — orders with multi-currency totals, shipping, tax, discounts
- `OrderAllocation` — per-line, per-warehouse stock allocation records
- `Shipment`, `ShipmentLine` — multi-warehouse shipments with independent tracking and carrier
- `SalesOrderRefund`, `SalesOrderRefundLine` — refunds with credit note numbers
- `Payment` — payment records against orders or credit notes

**Stock Control:**
- `StockTransfer`, `StockTransferLine` — inter-warehouse transfers
- `StockCount`, `StockCountLine` — stock count/cycle count workflow

**Manufacturing:**
- `Bom`, `BomItem` — bill of materials definitions
- `Kit`, `KitItem` — virtual kit definitions
- `ProductionOrder` — manufacturing order workflow

**Configuration:**
- `Organisation` — company details, base currency, financial year
- `Setting` — generic key/value store (JSON-encoded values)
- `Currency`, `FxRate` — active currencies and historical exchange rates
- `TaxRate` — VAT/GST rates with Xero tax type codes
- `AdjustmentReason` — configurable stock adjustment reasons

**Auth and Audit:**
- `User` — with roles (ADMIN, MANAGER, WAREHOUSE, FINANCE, READONLY, SUPPLIER), optional TOTP 2FA, passkey support
- `Notification` — per-user or broadcast notifications with type (info/success/warning/error), read tracking, and optional action URLs
- `ActivityLog` — full audit trail with entity type, action, level, tag, and metadata

**Integration:**
- `AccountingAccount`, `AccountingAccountBalanceSnapshot`, `AccountingSyncLog` — accounting connector account cache, GL balance snapshots, and sync status
- `WcSyncLog` — WooCommerce sync log
- `WcStatusMapping` — bidirectional WC-to-IMS status mapping (with seeded defaults)
- `WcTaxClassMapping` — WC tax class to IMS TaxRate mapping
- `ShippingCarrier` — configurable shipping carriers with tracking URLs


## Module Boundaries

| Module | Server Actions | API Routes |
|---|---|---|
| Inventory | `products.ts` | `/api/export/products`, `/api/export/stock-levels` |
| Purchases | `purchase-orders.ts`, `suppliers.ts` | `/api/rfq/[id]`, `/api/upload/invoice`, `/api/export/purchase-orders`, `/api/export/suppliers` |
| Sales | `sales.ts`, `customers.ts`, `allocation.ts` | `/api/sales-order/[id]`, `/api/invoice/[id]`, `/api/export/sales`, `/api/export/contacts` |
| Stock Control | `stock.ts`, `transfers.ts` | `/api/export/adjustments`, `/api/export/transfers` |
| Manufacturing | `manufacturing.ts` | `/api/manufacturing-order/[id]` |
| Settings | `settings.ts`, `company.ts`, `currencies.ts` | `/api/cron/fx-rates` |
| Import | `import.ts`, `wc-import.ts` | `/api/import/` |
| Integrations | `wc-sync.ts` | `/api/webhooks/shopping/orders`, `/api/webhooks/shopping/refunds`, `/api/webhooks/shopping/products`, `/api/cron/wc-reconcile`, `/api/cron/delivery-status` |
| Auth | `profile.ts`, `passkey.ts`, `users.ts` | `/api/auth/[...nextauth]`, `/api/auth/totp`, `/api/auth/totp-setup` |
| Dashboard | `dashboard.ts` | — |
| Analytics | `sales-stats.ts`, `purchase-stats.ts`, `inventory-stats.ts`, `forecasting.ts` | — |
| Backup | `backup.ts` | `/api/backup/`, `/api/cron/backup` |
| Activity Log | `activity-log.ts` | `/api/cron/activity-cleanup` |


## Authentication

Auth.js v5 with two providers:

### Credentials Provider
1. User submits email + password on the login page
2. Server verifies the bcrypt hash stored in `User.passwordHash`
3. If `User.totpEnabled = true`, a TOTP challenge screen is shown
4. On success, Auth.js creates a signed JWT session cookie (30-day expiry)

### Passkey Provider (WebAuthn)
1. User clicks "Sign in with Passkey" on the login page
2. Browser performs WebAuthn authentication with a registered credential
3. Server verifies the assertion against stored public keys
4. Session is created without requiring TOTP (passkey is already strong authentication)

User roles: `ADMIN`, `MANAGER`, `WAREHOUSE`, `FINANCE`, `READONLY`, `SUPPLIER`.

A permission system (`lib/permissions.ts`) controls sidebar visibility and server action authorisation per role. Supplier users are linked to a supplier company and access a dedicated portal.


## Background Tasks

There is no separate worker process. Background tasks are handled via HTTP endpoints triggered by system cron jobs.

| Task | Endpoint | Schedule | Description |
|---|---|---|---|
| FX rate refresh | `GET /api/cron/fx-rates` | Daily 06:00 | Fetch rates from frankfurter.dev and upsert FxRate rows |
| Activity cleanup | `GET /api/cron/activity-cleanup` | Daily 03:00 | Purge activity log entries past retention |
| Scheduled backup | `GET /api/cron/backup` | Daily 02:00 | Create backup, apply retention, upload to remote storage |
| WooCommerce reconcile | `GET /api/cron/wc-reconcile` | Daily | Backup reconciliation for WooCommerce orders/products plus stock catch-up and queued retry draining |
| Mintsoft webhook sweeper | `GET /api/cron/mintsoft-webhook-sweeper` | Every 5 minutes | Drain persisted Mintsoft ASN booked-in webhook events and apply stock/PO effects asynchronously |
| Delivery status | `GET /api/cron/delivery-status` | Every 15 min | Poll delivery tracking providers for shipment status updates |

All cron endpoints require the `CRON_SECRET` bearer header in production. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; in production it is disabled unless `CRON_SECRET` is unset and `ALLOW_LOCALHOST_CRON_BYPASS=true` is set explicitly.


## PDF Generation

PDFs are generated server-side using PDFKit (configured as `serverExternalPackages` in `next.config.ts`). The PDF system lives in `lib/pdf.ts` and provides:

- `getBranding()` — reads company info, logos, and brand colours from the Organisation and Settings tables
- `createPdfDocument()` — creates an A4 PDFDocument with standard margins and helpers
- `drawHeader()` — async function for rendering the document header with logo and addresses (all routes now correctly `await` this call)
- Table drawing utilities for consistent formatting across document types
- SVG logo conversion via sharp, with path traversal guard on logo file loading
- Auto-contrast text colour calculation
- All template fields loaded: headerNote, footerNote, termsText, paymentTermsText, customFooter
- TO address renders on separate lines (not comma-separated)

### Email Sending

Outbound email is handled by `lib/mailer.ts` using nodemailer:

- SMTP configuration from Settings (host, port, security, credentials)
- `sendSalesOrderEmail()` — sends sales order PDF as attachment
- `sendInvoiceEmail()` — sends invoice PDF as attachment
- Email buttons in the UI send via SMTP server-side (not mailto links)

PDF types: Sales Order, Purchase Order, Invoice, Packing Slip, Credit Note, RFQ, Manufacturing Order.

PDFs are streamed directly as responses from route handlers.


## CSV Import/Export

**Export routes** (under `/api/export/`): products, stock-levels, adjustments, contacts, suppliers, sales, transfers, purchase-orders.

**Import features:**
- Product CSV import with two-pass processing (parents first, then variants/components)
- Stock adjustment CSV import
- Customer and supplier CSV import

CSV utilities are in `lib/csv.ts`.


## External Integrations

### Xero

Xero integration is implemented as a modular connector in `lib/connectors/xero/`, fully independent of any shopping channel module.

- **Sub-ledger model** — IMS acts as accounting guard; Xero handles invoicing, payments, and bank reconciliation; IMS creates daily correction journals
- **Sales invoices** — AUTHORISED (WC pre-paid) or DRAFT (manual) invoice created at order time, with automatic Xero payment registration
- **Purchase bills** — pushed when a PO is invoiced, with optional supplier invoice PDF attachment
- **Credit notes** — pushed on refund with sub-ledger state-aware reversal journals
- **Daily batch sync** — nightly cron runs Group A1 (revenue deferral), A2 (inventory reclassification), B (shipment COGS + revenue recognition via FIFO cost layer consumption)
- **Payment polling** — 15-min cron detects paid invoices (manual orders) and paid bills (POs) via Xero API
- **Invoice PDF** — downloaded from Xero, saved locally, emailed to customer, download link pushed to WC order
- **Payment method mapping** — composite `{method}:{currency}` key maps to Xero bank account codes
- **OAuth 2.0** — tokens stored at `XERO_TOKEN_PATH`, refreshed before each API call
- **Deep links** — "View in Xero" links on sales order and PO detail pages

### WooCommerce

WooCommerce integration is implemented as a modular connector in `lib/connectors/woocommerce/`, following the shared `ShoppingConnector` and `AccountingConnector` interfaces.

- **Order import** — webhook-first via `/api/webhooks/shopping/orders`, with `/api/cron/wc-reconcile` as backup reconciliation
- **Status sync** — bidirectional mapping between WC and IMS statuses (configurable via `WcStatusMapping` with seeded defaults matching WC flowchart)
- **Refund sync** — creates refund records with credit notes and COGS reversal, via webhook (`/api/webhooks/shopping/refunds`)
- **Product sync** — bidirectional product data sync via webhook (`/api/webhooks/shopping/products`), including prices, dimensions, weight, GTIN/EAN (`global_unique_id`), HS code, and country of origin from WC product attributes
- **Stock sync** — IMS to WC, pushed immediately from IMS changes with daily forced stock catch-up and queued retry draining in the reconcile cron; optional COGS sync toggle
- **Tax class mapping** — maps WC tax classes to IMS TaxRate records
- **Completion flow** — WC completed status triggers auto-allocation, shipment creation with tracking
- **Webhook security** — HMAC verification using timing-safe comparison (`timingSafeEqual`)

### Integrations Dashboard

The `/sync` page provides a unified view of all connectors:

- **WooCommerce** — connection settings, order/product/stock sync config, tax mapping, status mapping, sync log
- **Xero** — OAuth connection, account mapping, transaction type toggles, sub-ledger settings, payment method mapping, sync log
- **Shopify** — tile shown (coming soon)
- **QuickBooks** — tile shown (coming soon)
- **REST API** — tile with endpoint documentation
