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
| `lib/connectors/` | External system connectors behind connector-agnostic boundaries — shopping (WooCommerce), accounting (Xero), and WMS/3PL (Mintsoft). The WMS boundary is contract-enforced; see [`wms-connector-boundary.md`](./wms-connector-boundary.md). Archived connectors live under `archive/connectors/` and are excluded from the build, the type check and the linter; see [`archive/connectors/README.md`](../archive/connectors/README.md) |
| `lib/connectors/woocommerce/` | WooCommerce connector module — order import, status sync, refund sync, product sync, stock sync |
| `lib/connectors/wms/` | Connector-agnostic WMS contract + registry; `lib/connectors/mintsoft/` is the first implementation (stock sync, ASN, returns, order dispatch push) |
| `prisma/` | Database schema, migrations, and seed data |
| `help-docs/` | User-facing help articles rendered in the app |
| `docs/` | Internal/admin/reference documentation kept in git only, plus repo copies of the user help docs |
| `scripts/` | Installation and maintenance scripts |
| `UPLOAD_STORAGE_DIR` / `PUBLIC_UPLOAD_STORAGE_DIR` | Env-configured persistent upload roots for private invoice PDFs, public branding assets, and avatar assets |

Migration rollout rules for schema changes are documented in
`docs/migration-conventions.md`. New migrations should follow those patterns
before changing required columns, constraints, indexes, renames, or drops.

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

**FIFO COGS** — Every stock-in creates a `CostLayer` (product, warehouse, received quantity, remaining quantity, `unitCostBase`, `receivedAt`): purchase receipts (manual, WMS book-in and the Mintsoft align-up, which carry `poLineId`), production output (`productionOrderId`), opening stock (`isOpeningStock`), the component units a disassembly releases (`productionOrderId`, not the output product), plain positive adjustments, transfer receipts and cancel-dispatch restores (recreated from the dispatch snapshot by `lib/domain/inventory/transfer-cost-layer-recreation.ts`) and refund restocks (`returnMovementId`). When stock is consumed (sale dispatch, negative adjustment, transfer dispatch, production components), `consumeFifoLayers` (`lib/cost-layers.ts`) takes layers oldest-first per product per warehouse (`ORDER BY receivedAt, id`, under `FOR UPDATE`), creating `CogsEntry` records; the strict variant throws on a shortfall. The one non-FIFO order is a supplier return, which consumes only the layers attributable to the returned PO line (`onlyPoLineId`). A landed-cost unit cost is floored at 0.00 per PO line, so a layer never goes negative through a supplier credit.

**Multi-currency** — Every monetary record stores both foreign-currency and base-currency amounts:
- `*Foreign` fields: amount in the transaction currency
- `*Base` fields: value in the organisation base currency at the time of transaction
- `fxRateToBase`: the exchange rate used. Convention: 1 base = X document-currency (units of foreign currency per one unit of base, the direction Xero's `CurrencyRate` and the ECB/frankfurter and Aelia sources all use).
- Every rate is read through one helper, `lib/currencies/fx-lookup.ts` (`getFxRateToBase`): latest `fx_rates` row on or before an explicit `asOf`, a business date meaning the end of that day UTC, ties with different rates and missing/non-positive rates refuse. See `docs/xero-sync.md` § Multi-Currency FX Rates.
- The same rate is pushed downstream to Xero on every invoice/bill/credit note (as `CurrencyRate`, the same number to 6 dp: Xero's convention is IMS's) so the accounting platform never substitutes its own daily rate. See `docs/xero-sync.md` § Multi-Currency FX Rates.

**Landed costs** — A freight PO (`type = FREIGHT`) is linked to a goods PO via `LandedCostLink`. When the goods PO is received, landed costs are distributed across cost layers. Distribution methods: by value, by weight, by quantity, or equal split. A unit is never valued below zero: a credit (negative cost line) larger than the goods cost is floored at 0.00 and the unabsorbed part is reported (`landed_cost_credit_floored`); with the ADMIN switch `landed_cost_floor_cogs_enabled` (off by default, `lib/domain/purchasing/landed-floor-cogs.ts`) it is posted DR Stock in Transit / CR COGS. A later freight change revalues the layers and queues COGS revaluation for consumed units (`LandedCostRevaluationRun`); closing a part-received order short re-spreads its freight over the units that landed (`lib/domain/purchasing/po-close-short.ts`).

**Stock reservation** — `StockLevel.reservedQty` tracks stock that is allocated but not yet dispatched. Sales allocations reserve the RESIDUAL of their `OrderAllocation` rows: a row records the order's whole claim on a (line, warehouse, product) — outstanding demand plus every committed (non-PENDING) shipment line, retained through pick, pack and dispatch — and the live reservation is that quantity minus what has already SHIPPED, which is the only status at which `reservedQty` is decremented. The quantity still to ship is the same row minus every non-PENDING shipment line. `lib/domain/inventory/reservation-residual.ts` owns the first reading and `allocateSalesOrder` is what keeps the rows covering their commitments. In-progress manufacturing reserves component stock for assemblies and the input SKU for disassemblies. Stock transfers do not currently reserve `reservedQty`; dispatch removes source on-hand quantity and receipt creates destination stock. `lib/domain/inventory/reservation-breakdown.ts` exposes the per-source breakdown and the inventory invariant report flags any delta between known reservation sources and `StockLevel.reservedQty`.

**Quarantine warehouses and the return condition check** — ADMIN system switch `return_condition_check_enabled` (off by default, set with `npm run settings:set ... --confirm-admin`; `lib/domain/inventory/quarantine-warehouse.ts`). The existing `Warehouse.type = QUARANTINE` value (no new column) marks a warehouse whose stock is not sellable; quarantine is IMS-only (goods in the company's own premises). With the switch on: automatic allocation (`allocateSalesOrder`, via `sellableWarehouseWhere`), manual `addAllocation`, `updateAllocation` moving into or growing in quarantine, production orders, reorder POs (destination) and reorder MOs (warehouse), the WooCommerce stock push (`loadStorefrontStockWarehouses`) and the storefront order import's default warehouse leave quarantine out; product list/detail, dashboard and sales-statistics "available" subtract quarantine on-hand (`loadQuarantineQtyByProduct`); the reorder-planning stock loader and `generateForecasts` (and through it `getReorderInventory`) exclude it; warehouse settings refuse a quarantine warehouse marked available for sale, synced to store or default, and refuse changing a warehouse to QUARANTINE (whatever the switch) while it has a WMS binding, open allocations, unshipped shipments, open production orders, in-transit inbound transfers or open purchase orders (`loadQuarantineBlockers`), and (switch on) changing a QUARANTINE warehouse to another type while it holds stock (`quarantineLeaveRefusal`), both checked inside the write transaction under a `FOR NO KEY UPDATE` lock on the warehouse row that only a save crossing the QUARANTINE boundary takes (an ordinary warehouse save takes no new lock; NO KEY UPDATE does not conflict with the `FOR KEY SHARE` of stock, allocation and shipment inserts); allocations are counted by residual (`countOpenAllocations`, reservation-residual.ts) so shipped allocation rows do not block; in-transit inbound transfers block a type change but not the switch-on interlock; `addAllocation`/`updateAllocation` re-check the type inside their transactions under a `FOR SHARE` lock on the same row. Quarantine warehouses may also not be the default return warehouse or available for purchase orders. Production orders there cannot be started or completed. Turning the switch on is refused by the CLI interlock `quarantineSwitchOnRefusal` (`listQuarantineWarehouseIssues`, which reuses `loadQuarantineBlockers`) in the dry run and inside the write transaction. With `refund_returns_in_transit_enabled` on the refund dialog asks no condition and refuses a quarantine expected warehouse. The inventory-stats stock tables and the Stock on Hand report show 0 available for quarantine rows; a WMS binding to one is refused. Settings > Sales shows the switch's state and `listQuarantineWarehouseIssues`. Every operator restock of a return in the refund dialog (`createRefund` with a return warehouse) must state `SELLABLE`/`UNSELLABLE`, checked by `returnConditionRestockRefusal` against the warehouse type; an UNSELLABLE one is also refused (`wmsUnsellableRefundRefusal`) when `refundReturnsToWmsWarehouse` finds the order SYNCED to a WMS or a non-PENDING shipment of the refunded lines from a WMS-bound warehouse. Both 3PL refusals and the inbox restock dialog's hint give the write-off route from `loadWmsWriteOffRoute` (`lib/domain/inventory/wms-write-off-route.ts`, over the pure `wms-unsellable-advice.ts`): ALIGNED only when the binding is ALIGN_TO_WMS and align-down can run (the connector's `<id>-stock-sync` cron enabled via `resolveCronEnablement`, binding and connection active and the connector's plugin enabled, alignment confirmed, an active align-down reason with an account, thresholds set, the inventory account mapped where the reason-cost rule needs it), ALIGNED_MANUAL (naming what blocks it) otherwise, IMS_MASTER for NOTIFICATION_ONLY/DISABLED/inactive, UNKNOWN for no binding or disagreeing bindings; the dashboard hands the dialog the same route per warehouse code (`writeOffRoutesByWarehouseCode`, only with the switch on, over the bindings it already read and a context read once; a failing read degrades to UNKNOWN). The inbox route is read after the restock transaction rolls back, not under its row lock. The Mintsoft returns-inbox restock (`wmsReturnRestockRefusal`) refuses UNSELLABLE outright: the unit is at the 3PL, where Mintsoft still counts it, so an IMS-only quarantine copy would double-count once ALIGN_TO_WMS alignment books Mintsoft's count. Storefront refunds (the automatic sync and `recordRefundParkManually`, both internal callers) state no condition and restock to the default return warehouse, by owner ruling. The restock itself is unchanged: `applyReturnInboundStockTx` books the same RETURN_INBOUND movement, return cost layers and journals into the chosen warehouse, so quarantining moves no value. Write-off is an ordinary negative stock adjustment (FIFO, Dr reason account / Cr Inventory); return to stock is an ordinary transfer (FIFO layers recreated at source cost). With the switch off every reader and writer issues the queries and writes of before (each filter is an empty spread), apart from one settings read.

**Stock adjustments, counts and the Mintsoft stock sync** — `applyStockAdjustment` (`lib/domain/inventory/stock-adjustment-apply.ts`) is the one writer of an adjustment movement: single, bulk line, CSV row, stock-count variance (`app/actions/stock-counts.ts`) and the Mintsoft align-down. It takes the stock-level lock, refuses a removal that would cut into reserved units (unless `stock_adjustment_release_reserved` is `true`, which the single-adjustment and one-line bulk actions in `app/actions/stock.ts` pass as `releaseReservedForRemoval`: `releaseReservationsForRemovalInTx` then releases the newest orders' unshipped allocations first, pegged orders last, and logs `allocation_released` on each; CSV import, count variances and the Mintsoft align-down never pass it), writes the movement and layer (or consumes FIFO), and queues the `INVENTORY_ADJUSTMENT` journal only when the value is not zero to the penny; a valued adjustment with no reason account or no inventory account is recorded as an owed posting (`stock_adjustment_journal`) instead, but only when an accounting connector is present and its posting verdict is `post` or `chart-retired`. The setting `stock_adjustment_reason_cost_required` (off by default, read as on only for `true`; an ADMIN system switch with no settings screen, set with `npm run settings:set -- ... --yes --confirm-admin`) is read inside the transaction (`stock-adjustment-policy.ts`): with it on every adjustment needs an active reason, and a valued one is refused (same connector and verdict condition) when its reason has no account or no inventory account is mapped, and an addition without an entered cost is valued by `getLatestLayerUnitCost` (receipt or production layer, else opening stock, never an average); `stock-adjustment-edit.ts` then edits only plain adjustments and refuses a value change. Opening stock (`opening-stock.ts`) is once per product and warehouse. A stock count snapshots `StockLevel.quantity` of non-archived products (or the prepared product list), reconcile stamps the on-hand each line was reconciled against, and post re-reads on-hand under the lock and refuses on drift; counts are refused for an `ALIGN_TO_WMS` warehouse and need acknowledgement for `NOTIFICATION_ONLY` (`lib/domain/inventory/stock-count.ts`); the triage tabs and bulk accept live in `stock-count-triage.ts`. The Mintsoft stock sync (`lib/connectors/mintsoft/sync/stock-sync.ts`, cron `mintsoft-stock-sync`, hourly, off by default) compares on-hand per bound warehouse: every non-zero delta is an open discrepancy (`upsertDiscrepancy`); one over the binding's thresholds also counts as a breach and is alerted, and the thresholds are the align-down ceiling. Under `ALIGN_TO_WMS` (after a dry run confirmed within `ALIGNMENT_DRY_RUN_MAX_AGE_MS`, 7 days) a positive delta is absorbed into open ASN lines as a receipt, all or nothing (a rise the lines explain only in part books nothing; `applyMintsoftAlignmentForProduct`, `mintsoft_align_up_requires_receipt_evidence` optionally requires warehouse evidence on the ASN; no open ASN line means the delta stays a discrepancy; a manual `Sync now` per binding, `runMintsoftStockSyncNow`, runs the same sweep while the cron is off, except for an inactive or DISABLED binding) and a negative delta goes through the gates in `planMintsoftAlignDown` (reason with account, thresholds set and not breached, no open ASN pending, no in-flight despatch, same delta on a previous run, not below reserved) before an adjustment is booked. `wms-write-off-route.ts` derives, per binding, which party books the write-off of an unsellable unit (see quarantine above).

**Stock value visibility** — `canViewStockValue` (`lib/security/stock-position-policy.ts`, permission `inventory.prices`: ADMIN, MANAGER, FINANCE) decides whether a caller receives cost or value at all. The server omits the fields rather than the client hiding them: the stock-position reports (Stock on Hand, Inventory Aging, Dead Stock, Slow Stock) and their `stock-position` exports, the ledger reports (movements, adjustments, transfers, counts) and the `inventory-ledger` export, the product list and page (COGS value, average cost, the FIFO layers card; cost layers are not queried), the stock-levels and adjustments CSV exports (`unitCostBase`, `inventoryValueBase`, `unitCost` blank), and stock counts (cost layers are not read; the Est. value column and the value sort are absent, and the triage threshold uses quantity and percentage only). Quantities, dates, ages and cover stay visible to WAREHOUSE and READONLY.

**Product reporting categories** — `ProductCategory` is a normalized self-referential hierarchy used to slice inventory, turnover, aging, stock-on-hand, and reorder reports. `Product.categoryId` is optional so existing products can remain uncategorized during rollout. Identity strategy: `nameNormalized` stores the **full normalized path** (`apparel>t-shirts`), not just the leaf, so a single global `@unique` constraint naturally distinguishes leaves that share a display name under different parents (`Apparel > T-Shirts` and `Promo > T-Shirts` resolve to different rows). The display delimiter is `>` (with spaces in UI strings); the storage delimiter is the same character without padding. CSV import/export and product create/edit accept a path string and `resolveProductCategoryIdByName` walks it top-down, upserting each missing segment with the correct `parentId`. WooCommerce product sync mirrors the WC product-category tree into this model on each sync run via `lib/connectors/woocommerce/sync/category-mirror.ts` (5-minute in-process cache), then links each synced product to the deepest WC category referenced. Names are capped at 100 characters per segment, normalize case/diacritics/invisible characters, and preserve the first display spelling for each normalized key. CRUD on the tree lives at `/settings/inventory` (Product Categories card); the actions in `app/actions/categories.ts` handle rename and move by recomputing `nameNormalized` for the subtree, and delete by promoting children one level up and reassigning the deleted node's products to its parent.

**Stock movement reporting value** — New `StockMovement` rows carry `unitCostBase` and `totalValueBase` so inventory movement reports and CSV exports can read value directly from the movement table instead of joining COGS entries or cost layers. Outbound movements derive value from FIFO/CogsEntry consumption, inbound movements derive it from the created cost layer or transfer snapshot, and historical demand imports or positive adjustments with no prior cost source use zero cost as known-unknown provenance. Backfilled rows that cannot be derived remain `NULL`; aggregate queries must either `COALESCE(totalValueBase, 0)` or filter `IS NOT NULL` explicitly. Migration `20260528162500_stock_movement_values` records unresolved per-type counts in `stock_movement_backfill_audit`, preserving the first run timestamp and updating the latest run/count on retry. The database enforces that value fields are both null or both populated and that populated `totalValueBase` equals `ROUND(qty * unitCostBase, 6)`. Deferred movement-evidence triggers require positive `PURCHASE_RECEIPT`/`PRODUCTION_IN`/inbound `ADJUSTMENT` rows to have matching cost-layer evidence and positive `SALE_DISPATCH`/`PURCHASE_REVERSAL`/`PRODUCTION_OUT`/outbound `ADJUSTMENT` rows to have `CogsEntry` evidence by commit time. The inventory invariant report mirrors those guarantees and uses a hybrid absolute/relative tolerance so small movements do not hide large percentage drift and very large movements do not fail on immaterial cent-level rounding. See `docs/stock-movement-reporting-guarantees.md` for the deployment and repair runbook.

**Inventory snapshots** — `InventorySnapshot` stores one daily product/warehouse position for historical analytics. The daily `/api/cron/inventory-snapshot` job (off by default; `0 0 * * *` host time, which is London) writes rows idempotently on `(snapshotDate, productId, warehouseId)` for the just-ended Europe/London business day (the label is that London day; its `cutoffAt` is London midnight, 23:00 UTC in BST): `qty` comes from `StockLevel.quantity`, `valueBase` comes from `SUM(CostLayer.remainingQty * unitCostBase)`, and `unitCostBase` is the weighted average `valueBase / qty` when quantity is positive. The run also writes one `InventoryTransitSnapshot` row per transfer in transit at the capture instant (`lib/domain/inventory/transfer-in-transit-value.ts`: cost dispatched plus landed-cost revaluations while in transit, less cost received by any route) and sets `inTransitCovered` on the run row; `inventory-gl-reconciliation.ts` compares the ledger with on-hand value plus that line. An older daily (cron) run without the marker is compared on on-hand alone; an older backfill run measures transit from the movement ledger at its cutoff. Rows are sparse: a missing row means zero position, so report queries must use `LEFT JOIN`/`COALESCE` when they need explicit zero days. `InventoryReservationSnapshot` stores matching daily reserved/available evidence, also idempotent by `(snapshotDate, productId, warehouseId)`, but writes only positive reserved/source-evidence rows; `InventoryReservationSnapshotRun` marks a date as captured so reports can distinguish zero-reserved sparse rows from missing reservation evidence. Product and warehouse foreign keys intentionally use the same restrict-on-delete behavior as `InventorySnapshot`, preserving historical reporting rows unless the operator explicitly purges the dependent snapshots first. The job reports, but does not block on, quantity drift between stock levels and remaining FIFO layers using the standard `0.0001` quantity tolerance. `npm run inventory:snapshots:backfill -- --from YYYY-MM-DD [--to YYYY-MM-DD]` seeds older daily rows from current state plus reverse `StockMovement` replay; historical value replay depends on `StockMovement.totalValueBase`, so nullable legacy movement values are reported as missing-value movements and make the value replay advisory. Adding `--include-reservations` runs a conservative reservation pass that writes sparse reservation rows plus the daily run marker only for days that pass the current-source timestamp gate; unsupported days and negative available quantities are reported in `reservationBackfill.warnings` and unsupported days remain explicit missing-evidence days in reports. The gate cannot detect hard deletes or raw SQL changes that bypass `updatedAt`, and it rejects current graphs with committed shipment lines or in-progress assembly orders because their dependent histories are not timestamped. See `docs/inventory-snapshots.md` for the operator runbook.

**As-of on-hand reporting** — `getOnHandAsOf` in `lib/domain/inventory/get-on-hand-as-of.ts` is the shared historical on-hand helper for future stock-on-hand and turnover reports. Date-only inputs name a Europe/London business day and the as-of ends at that day's London midnight (22:59:59.999Z is the returned `asOf` in BST); the same convention snapshots are labelled by. The helper uses four source modes: `current` (live `StockLevel` plus open `CostLayer` values), `snapshot_forward_replay` (nearest prior `InventorySnapshot` plus forward inclusive `StockMovement` replay), `future_snapshot_reverse_replay` (first later snapshot reversed back when no prior snapshot exists), and `current_reverse_replay` (current state reversed back inside a serializable transaction when supported). `asOf` is inclusive; the snapshot anchor is exclusive and ends at its own `cutoffAt` (the run row's stored value, else the end of its London label day). When the anchor's cutoff is after the as-of bound (a backfilled or legacy UTC-cutoff run) the movements between the bound and the cutoff are reversed out of the snapshot, so any anchor reads correctly; the backfill writer stamps London cutoffs. Consumers must check `valueReplayReliable`, `missingValueMovementCount`, `orphanWarehouseMovementCount`, and `missingValueMovementSample`; when reliability is false, quantities are useful but value/unit-cost fields are advisory. Movement replay pages at 10,000 rows per query, so large no-snapshot fallbacks should be filtered by product, warehouse, or category where possible.

**Stock position reports** — `/analytics/stock-on-hand`, `/analytics/inventory-aging`, `/analytics/dead-stock`, `/analytics/slow-stock`, `/analytics/stock-allocations`, and `/analytics/negative-stock` share the stock-position report shell and are visible to users with analytics permission plus `WAREHOUSE`. The sidebar uses the same stock-position access policy: analytics roles see the full analytics group, while `WAREHOUSE` sees only these stock-position links. Stock on hand uses `getOnHandAsOf` for quantity/value. Current reports and `current_reverse_replay` fallbacks use live `StockLevel.reservedQty`; snapshot-backed as-of reports use `InventoryReservationSnapshot` when the date has a reservation snapshot run, treating sparse missing rows as zero reserved. If reservation evidence is missing, rows are explicitly marked `current_missing_snapshot` and fall back to current reservations. Stock-on-hand CSV exports append `reservationQtySource`, `reservationSnapshotDate`, and `reservationSourceCount`; fallback rows use `unknown` for the source-count sentinel. Inventory aging uses `lib/domain/inventory/inventory-health-reports.ts` to bucket FIFO `CostLayer` quantity/value by receipt age; historical as-of dates add back later `CogsEntry` consumption per layer before bucketing. Aging value uses the current `CostLayer.unitCostBase`, so retrospective landed-cost revaluations are not replayed for historical as-of dates. BOM products age from their own production cost layers. Virtual KIT SKUs hold no cost layers and are excluded from the aging list so totals do not double-count component stock; filtering Type to KIT returns an empty report with a notice, and the component SKUs are aged from their own layers. Dead stock reports current positive-stock rows with no `SALE_DISPATCH` movement inside the selected no-sales threshold, excludes never-sold products first stocked less than the threshold ago using historical receipt evidence rather than only open cost layers, and values rows from remaining cost layers. Returns are not netted off for demand evidence: a SKU sold and returned still counts as having demand in the selected window. Slow stock (`/analytics/slow-stock`, `lib/domain/inventory/slow-stock-report.ts`, CSV `type=slow-stock`) is read only and supports the period-end lower-of-cost-and-NRV review: per product (or product and warehouse) it reads current `StockLevel` quantity, open `CostLayer` value (remaining qty x current unit cost, exact Decimal) and the oldest open layer's `receivedAt`, and takes last-sale date and the 90-day units sold from two bounded `stockMovement.groupBy` queries over `SALE_DISPATCH` (same demand rule as dead stock: warehouse-attributed rows plus the exact historical-import shape, which is attributed to every warehouse of the product). Rate is units per 30 days, months of cover is on hand over that rate (null when nothing sold). Source scans are capped at 100,000 rows each and refuse with `InventoryHealthSourceLimitError`. Cost and value (fields, value filter and ordering, the CSV `valueBase` column) are returned only when the caller holds `inventory.prices`; the pure calculations are exported for unit tests. Stock allocations uses `reservation-breakdown.ts` and adds an `other` row whenever known source rows do not reconcile to `StockLevel.reservedQty`; positive drift is labelled unattributed reserved balance and negative drift is labelled over-attributed reserved balance. Negative stock reconstructs the selected UTC movement window from an opening as-of balance and also includes currently negative `StockLevel` rows even when no movement happened inside the window. CSV exports use `/api/export/stock-position` and are capped at 50,000 filtered rows; inventory-aging and dead-stock CSV rows omit repeated report-level metadata such as `asOf`, `generatedAt`, and `thresholdDays`, while provenance-heavy stock-on-hand exports keep row-level source fields. Operators must narrow filters before exporting larger result sets.

**Inventory velocity and health reports** — `lib/domain/inventory/velocity.ts` is the shared Decimal-safe calculation layer for inventory aging, turnover, dead-stock, velocity rankings, ABC analysis, and future reorder planning. Date-only velocity windows are inclusive UTC calendar days, with `dateTo` expanded to the end of the UTC day. Callers pass normalized sale/position/layer rows; connector/report collectors must exclude returns, adjustments, and other non-demand movements before calling `calculateDailyVelocity`, which rejects negative qty/COGS/revenue rather than masking bad collector input. Dead-stock requires a velocity window at least as wide as the threshold, treats recent never-sold SKUs as new stock by default, and classifies a SKU as dead when `daysSinceLastSale >= thresholdDays`. Aging buckets are validated before use and preserve total on-hand quantity/value per SKU. ABC uses configurable cumulative cutoffs and keeps the threshold-breaking row in the higher class; turnover returns null ratios when average inventory value is zero.

**Replenishment and demand planning reports** — `/analytics/reorder`, `/analytics/backorder`, and `/analytics/component-shortage` are read-only demand-planning reports backed by `lib/domain/inventory/replenishment-reports.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/replenishment` and do not reuse warehouse-only stock-position export access. Reorder planning uses `Product.reorderPoint`, `Product.reorderQty`, `Product.safetyStockQty`, optional `Product.abcClass`, `SupplierProduct.leadTimeDays`, current available stock, inbound open purchase-order quantity, and the shared SALE_DISPATCH velocity helper. Suggested reorder qty is never negative and is calculated as `max(configured reorder qty, demand during lead time + safety stock - available - inbound open PO)`. Backorder demand aggregates non-cancelled sales-order lines where ordered quantity exceeds committed shipment quantity plus allocated quantity, then surfaces expected inbound open PO quantity and earliest projected fill date. Component shortage rolls up BOM component requirements from draft and in-progress production orders and subtracts current available stock plus inbound open PO quantity per component/warehouse.

**Sales and fulfillment analytics** — `/analytics/sales`, `/analytics/customers`, `/analytics/margin`, `/analytics/returns`, `/analytics/fulfillment`, and `/analytics/throughput` are read-only sales/operations reports backed by `lib/domain/sales/sales-fulfillment-analytics.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/sales-analytics`. Sales and customer totals use `SalesOrder.totalBase`/`totalForeign` and exclude cancelled orders; product/category sales views allocate order-level totals across lines by line value so grand totals reconcile to the order totals. Gross margin uses `CogsEntry.totalCostBase` linked to `SALE_DISPATCH` stock movements and never recalculates FIFO. Returns use `SalesOrderRefundLine` plus same-period `SALE_DISPATCH` quantities for return-rate context. Fulfillment KPIs use `Shipment.shippedAt` and `ShipmentLine.qty`; throughput uses `shipment_status_changed` `ActivityLog` rows linked by shipment metadata plus current pending/picking/packed queue depth.

**Purchasing and supplier analytics** — `/analytics/open-pos`, `/analytics/supplier-performance`, `/analytics/ppv`, `/analytics/spend`, and `/analytics/lead-times` are read-only procurement reports backed by `lib/domain/purchasing/purchasing-analytics.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/purchasing-analytics`. Open POs use `PurchaseOrder.status in (PO_SENT, PARTIALLY_RECEIVED, SHIPPED)`. Supplier on-time metrics compare `PurchaseReceipt.receivedAt` with `PurchaseOrder.expectedDelivery`. PPV uses the previous received PO line for the same supplier/SKU as its base-currency reference source because `SupplierProduct.lastUnitCost` is stored in supplier currency. Spend rows allocate received PO totals across supplier/category/month and reconcile to `SUM(PurchaseOrder.totalBase)`. Lead-time P95 feeds replenishment when `SupplierProduct.leadTimeDays` is unset.

**Finance period-end analytics** — `/analytics/vat`, `/analytics/ar-aging`, `/analytics/ap-aging`, and `/analytics/fx-gain-loss` are read-only finance reports backed by `lib/domain/finance/finance-period-analytics.ts`. Access is limited to `ADMIN` and `FINANCE`; CSV exports use `/api/export/finance-analytics`. VAT uses `SalesOrderLine.taxBase` for invoiced, non-cancelled sales orders and prorated `PurchaseOrderLine.taxBase` for purchase-invoice lines in the period, grouping by side (sales/purchases), `TaxRate.reportingCategory` (`DOMESTIC`, `REVERSE_CHARGE`, `EC_SALES`, `OSS`, or `Uncategorised`), jurisdiction, and rate. An optional `vatReportingCategory` filter scopes the report to a single category at the SQL predicate level (sales) and via an in-memory line filter (purchase-invoice lines, because Prisma's `lines: { some: ... }` matches the parent invoice but returns all children). AR aging subtracts non-refund `Payment.amount` rows from `SalesOrder.totalBase`; AP aging treats a bill's net payable (`billNetPayableBase`, `lib/domain/purchasing/bill-net-payable.ts`: `PurchaseInvoice.totalBase` less the VAT of its reverse-charge lines, prorated; the stored total when it has none) as fully outstanding until `PurchaseInvoice.paidAt` because partial supplier payments are not modeled. Aging bucket boundaries are query-configurable. FX gain/loss uses the central lookup's selection rule (`selectFxRateFromRows` in `lib/currencies/fx-lookup.ts`) where `FxRate.rate` means `1 base = foreign currency`, so base value is foreign amount divided by the booking or settlement rate and rows surface the configured realised FX account.

**Manufacturing analytics** — `/analytics/production-variance` and `/analytics/wip` are read-only production reports backed by `lib/domain/manufacturing/manufacturing-analytics.ts`. Access is limited to `ADMIN`, `MANAGER`, and `FINANCE`; CSV exports use `/api/export/manufacturing-analytics`. Production variance compares planned BOM component demand (`BomItem.qty * ProductionOrder.qtyPlanned`) with actual `PRODUCTION_OUT` component movements for assembly orders that can consume components. Date filters apply to `ProductionOrder.completedAt`; in-progress rows without a completion date appear only when no date window is selected. The report labels positive variance as over-consumed quantity/value rather than scrap because the cause may be scrap, substitution, BOM drift, or intentional yield padding; over-consumed value is averaged across the consumed movement value rather than layer-exact FIFO costing. WIP is a current-state report over all `IN_PROGRESS` production orders and does not apply date filters. WIP value combines posted consumed component value with `ManufacturingCostLine.amountBase` totals, and days-since-start is reported as decimal days for intraday work.

**Inventory costing reports** — `/analytics/inventory-valuation`, `/analytics/cogs`, `/analytics/landed-cost`, and `/analytics/inventory-turnover` share `lib/domain/inventory/inventory-costing-reports.ts` and are visible only to `ADMIN`, `MANAGER`, and `FINANCE` via `analytics.inventory_costing`. Inventory valuation reuses `getOnHandAsOf` so quantity/value provenance matches stock-on-hand reporting; current values come from open FIFO `CostLayer` rows and historical values come from `InventorySnapshot` plus movement replay. COGS totals come directly from `CogsEntry.totalCostBase` and are not recalculated from FIFO layers; revenue and gross margin are shown only where `SALE_DISPATCH` movement references can be matched to a sales order line for the same product. Landed-cost analysis compares `PurchaseOrderLine.unitCostBase` with `landedUnitCostBase`, groups uplift by the PO's `landedCostMethod`, and surfaces `LandedCostRevaluationRun` counts by primary PO. Inventory turnover uses only sales-dispatch COGS and divides it by average daily inventory value from observed `InventorySnapshot` days; snapshot coverage is shown per row so missing cron/data days are visible, and rows with zero observed average value show blank turnover ratios. Supplier grouping splits multi-supplier SKU value evenly across linked suppliers and excludes supplierless SKUs with a report notice. GL stock/COGS variance comes from `AccountingAccountBalanceSnapshot`, populated from the Integrations account-mapping tab by Xero Trial Balance ingestion for the configured inventory asset and COGS account mappings. Inventory valuation compares total IMS stock value with the latest matching stock asset snapshot on or before the as-of date. COGS compares the report period with the movement between opening and closing COGS snapshots; when either snapshot is missing, reports show an explicit no-snapshot notice and keep GL variance blank.

| Stock Movement Type | Reporting Value Source |
|---|---|
| `ADJUSTMENT` | Positive adjustments use the entered unit cost (0 only when entered); a blank cost uses the warehouse average, else the product's historical average, and is refused when neither exists. With `stock_adjustment_reason_cost_required` on, a blank cost is the latest non-zero receipt or production layer (warehouse, else any warehouse), else the latest non-zero opening-stock layer, never an average (`getLatestLayerUnitCost`, `stock-adjustment-policy.ts`). Negative adjustments use FIFO consumption. |
| `KIT_ASSEMBLY_IN` | Reserved legacy type; active manufacturing assembly writes `PRODUCTION_IN`. |
| `KIT_ASSEMBLY_OUT` | Reserved legacy type; active manufacturing assembly writes `PRODUCTION_OUT`. |
| `OPENING_STOCK` | Opening stock uses the explicit opening unit cost. |
| `PRODUCTION_IN` | Manufacturing output/recovery uses consumed component and overhead cost. |
| `PRODUCTION_OUT` | Manufacturing consumption/disassembly uses FIFO consumption. |
| `PURCHASE_RECEIPT` | Purchase receipts use landed or gross purchase unit cost. |
| `PURCHASE_REVERSAL` | Historic: purchase cancellation reversals used the remaining PO receipt cost-layer cost. Cancelling a part-received order now closes it short and writes none; rows already written still count here. |
| `RETURN_INBOUND` | Customer returns use shipped cost snapshots where available. |
| `SALE_DISPATCH` | Sales dispatch uses FIFO consumption; historical imports use the zero-cost provenance sentinel. |
| `TRANSFER_IN` | Transfer receipts use the dispatch FIFO snapshot slice. |
| `TRANSFER_OUT` | Transfer dispatch uses FIFO consumption. |
| `WMS_RECEIPT_RECONCILIATION` | WMS reconciliation uses source PO/transfer cost or zero-value audit markers. |

The value writer surface is broad by design. New movement writers must route through `lib/domain/inventory/stock-movement-value.ts` and either populate both value fields, intentionally leave both `NULL` for non-derivable historical data, or document an explicit zero-cost provenance sentinel. Consumption-based writers currently use a two-phase transaction pattern: create the movement, consume FIFO using the movement id, then update the movement value fields inside the same transaction. The intermediate `NULL` state is not externally observable under normal transaction isolation, but repeated writer implementations should be consolidated if another movement writer is added. Scheduled invariant checks restrict stock-movement value scans to a 90-day window by default (`INVARIANT_CHECK_STOCK_MOVEMENT_LOOKBACK_DAYS`) to avoid daily full-table scans; admin/on-demand invariant reports leave the window unset for historical audits. The same scheduled invariant run includes sales refund-status reconciliation, flagging orders where refund rows imply `PARTIALLY_REFUNDED` or `REFUNDED` but `SalesOrder.status` has drifted. CSV exports emit fixed dot-decimal numeric literals for these value fields regardless of server locale.

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

### The canonical quantity scale

`ProductComponent.qty`, `SalesOrderLine.qty`, `OrderAllocation.qty` and `ShipmentLine.qty` are all `Decimal(12,4)`. A KIT fulfilment requirement is a *product* of those columns, so it is routinely **not representable** at four decimals — 0.5 kits of a 0.3333 component is 0.16665, and a nested kit's 0.3332 x 0.3332 is 0.11102224.

The rule (o3d-i4qd): **quantise the computed side, never the stored side.** A requirement is rounded once, half-up (what Postgres `numeric(12,4)` does on write), *after* the whole multiplication — never per term — and only then compared against a persisted quantity. `canonicalFulfillmentQty` in `lib/products/fulfillment-coverage.ts` is that rounding, and `canonicalAllocationQty` is its allocation-side alias.

Two consequences readers must respect:

- **Proportionality of a kit's components is judged at the stored scale.** `findDisproportionateFulfillmentComponent` asks whether one coverage exists that rounds to every stored component quantity (each stored quantity stands for a half-ulp-wide band), instead of demanding `qty == coverage x factor` exactly. The exact form refused allocations the allocator had just written, and refused them at shipment confirmation — leaving the order allocated and unpickable.
- **A coverage figure inferred from stored quantities carries `halfUlp / smallestFactor` of slack, in kit units** (`fulfillmentCoverageQuantisationSlack`). Any comparison of such a coverage against a demand figure must allow for it. It also shows the cost of very small component factors: at a factor of 0.0001, one ulp of that component is a whole kit of inferred coverage.

`selectOrdersNeedingAllocation` therefore asks its question in **component units** — "is the stored component quantity below `round(netDemand x factor, 4)`" — with one half-ulp of slack per allocation row that fed the total, because each row was rounded on its own.

### Structural product changes: an accepted write-skew residual

Changing a product's `type` or its `parentId` is refused while the product has stock, reservations, or open sales/purchase/production/transfer documents. The refusal is a `SELECT`, plus (in the WooCommerce connector) the same predicate ANDed into the `UPDATE` and re-asserted immediately before commit.

**That is not race-free, and it is not going to be** (o3d-0fok, decided). Under READ COMMITTED a blocker transaction that is uncommitted when our `UPDATE` takes its snapshot and commits before we do is invisible to us, and we are invisible to it. Only two things would close it, and both are rejected:

- **A product-scoped lock every blocker writer takes.** The blocker writers are stock receipts, allocation, and the sales/purchase/production/transfer document writers — the hottest paths in the system. They would take a new lock, ordered against the sales-order lock and the component-graph write lock, to protect an occasional administrative edit. The deadlock surface that creates is a worse defect than the one it removes.
- **SERIALIZABLE isolation.** Postgres SSI guarantees hold only among transactions that are *all* serializable, so raising only the structural writer buys nothing. Raising all of them is the same list of hot paths, plus retry loops.

What holds instead: the window is narrowed to the width of the `UPDATE` statement (the predicate) and of the pre-commit re-assertion; the failure mode is a product whose type changed under a document that references it, which is visible and repairable rather than a silent quantity or money error; and the ordinary uncontended case — which is all of them in practice — is refused outright.

One arm is weaker than the rest and is documented in place: `PRODUCT_TRANSFORM_BLOCKER_FREE_WHERE` cannot express the open-stock-transfer arm, because `StockTransferLine` deliberately carries no foreign key to `Product` (orphaned lines must survive for audit). That arm is answered by a `SELECT` one statement earlier than the other four, at both boundaries.

**Discount storage** — Discounts are stored separately as `discountStr` (the original input) and `discountAmount` (the computed value). Prices are never baked with discounts applied.

**Tax rate snapshotting** — Sales and purchase order lines store `taxRateId` and rate snapshots at creation/edit time, ensuring historical accuracy if tax rates change later. `TaxRate` now represents a connector/reporting tax profile: it can carry ordered `TaxRateComponent` rows for compound rates, a reverse-charge flag, and a reporting category such as `DOMESTIC`, `REVERSE_CHARGE`, `EC_SALES`, or `OSS`. The effective rate is still written to the line snapshot so historical documents stay stable; component metadata remains available for connector mapping and VAT/reporting views.

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

### Lifecycle Status

Every `Product` row carries a `lifecycleStatus` enum: `DRAFT`, `ACTIVE`, `EOL`, `ARCHIVED`. The status gates sales, purchasing, and reporting:

| Status | Sellable | Purchasable | In reorder forecast | New manufacturing orders |
|---|---|---|---|---|
| `DRAFT` | No | Yes | Yes | Yes |
| `ACTIVE` | Yes | Yes | Yes | Yes |
| `EOL` | Yes (from existing stock) | No | No | No (disassembly allowed) |
| `ARCHIVED` | No | No | No | No |

Transition rules:

- A nightly job auto-archives `EOL` products once `stockLevel.onHand + incoming = 0` across all warehouses.
- A product cannot be archived while it has open SO/PO lines, production orders, or non-zero stock — the UI surfaces the blocker.
- Lifecycle changes are recorded in the activity log under the `inventory` tag with the old and new status in metadata.

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
- `ShoppingStatusMapping` — bidirectional WC-to-IMS status mapping (with seeded defaults)
- `WcTaxClassMapping` — WC tax class to IMS TaxRate mapping
- `WcPendingFxOrder` — WC orders queued when an FX rate is unavailable at sync time; re-attempted by the FX-rate refresh cron (`/api/cron/fx-rates`), which drains the queue after upserting the newly fetched rates
- `ConnectionTestRecord` — last successful test per connector with credential SHA256 fingerprint; required before any save is treated as "active"
- `BackupManifest` — sidecar manifest per backup file (schema version, size, SHA256, app version)
- `ShippingCarrier` — configurable shipping carriers with tracking URLs

### Multi-currency model

Every monetary row that can hold a foreign-currency amount also stores `fxRateToBase` at the time of the row's creation. The convention is **1 unit of base currency = `fxRateToBase` units of foreign currency**. Xero's `CurrencyRate` uses the SAME convention (units of foreign per one unit of base), so the connector sends the rate as is, rounded to 6 dp, and never inverts it (`lib/connectors/xero/fx.ts`; verified against the live organisation's own documents, pinned by `tests/connectors/xero-currency-rate-direction.test.ts`).

`fxRateToBase` is stamped on:
- `PurchaseOrder` and `PurchaseOrderLine` (locked at PO issue)
- `SalesOrder` and `SalesOrderLine` (locked at order creation)
- `Payment` and `SalesOrderRefund` (rate at payment/refund time)

Realised FX gain/loss is computed at payment/refund settlement against the stamped rate, for the FX Gain/Loss report only; Xero books it itself from the settlement rate IMS sends on each payment. Unrealised FX is not posted by IMS: Xero revalues open foreign invoices, bills and bank balances in its own reports, and the IMS period-revaluation cron is retired.


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
| Integrations | `wc-sync.ts`, `shopping.ts`, `shopping-sync.ts`, `xero-sync.ts`, `xero-daily-batch.ts`, `accounting*.ts`, `mintsoft-sync.ts`, `mintsoft-suppliers.ts`, `wms-*.ts` | `/api/webhooks/shopping/[connector]/[resource]` (`orders`, `products`, `refunds`), `/api/webhooks/mintsoft/asn-booked-in`, `/api/accounting/callback`, `/api/shopping/manual-sync`, `/api/cron/wc-reconcile`, `/api/cron/accounting-sync` and the other integration crons (see Background Tasks), `/api/cron/delivery-status` |
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

#### Password policy

All password mutations — login form, profile change-password, CLI `create-user`, admin user creation/edit — go through the shared `validatePasswordPolicy()` helper in `lib/auth/password-policy.ts`. The policy requires:

- Minimum 12 characters
- At least one uppercase letter, one lowercase letter, one digit, one symbol
- Not present in the bundled deny-list of common weak passwords

Bcrypt cost is set to 12. Each rule emits a distinct error code so the UI can show a specific message.

#### Rate limiting

Login, TOTP verification, password change, and supplier-quote endpoints share a token bucket backed by `RATE_LIMIT_BACKEND` (`memory` or `redis`). The Redis backend uses a single atomic sorted-set Lua script for check-and-record so multi-replica deployments stay coherent. On backend failure the limiter fails open and writes a warning to the activity log.

### Passkey Provider (WebAuthn)
1. User clicks "Sign in with Passkey" on the login page
2. Browser performs WebAuthn authentication with a registered credential
3. Server verifies the assertion against stored public keys
4. Session is created without requiring TOTP (passkey is already strong authentication)

User roles: `ADMIN`, `MANAGER`, `WAREHOUSE`, `FINANCE`, `READONLY`, `SUPPLIER`.

A permission system (`lib/permissions.ts`) controls sidebar visibility and server action authorisation per role. Supplier users are linked to a supplier company and access a dedicated portal.


## Background Tasks

There is no separate worker process. Background tasks are handled via HTTP endpoints triggered by system cron jobs.

This table lists the main jobs, not every registered one: the full list with each job's schedule and on/off default is **Settings > System > Scheduler** (registered in `lib/cron-jobs/`) and the cron table in the installation guide.

| Task | Endpoint | Schedule | Description |
|---|---|---|---|
| Xero chart of accounts refresh | `GET /api/cron/xero-chart-sync` | Daily 00:30 | Read-only refresh of the Xero chart of accounts into the local account list, ahead of the balance-snapshot pull; stamps the read-sync last-success time with the stored chart |
| Account balance snapshot | `GET /api/cron/account-balance-snapshot` | Daily 01:00 | Fetch previous-day Xero Trial Balance account balances for inventory and COGS GL variance reporting |
| Product lifecycle archive | `GET /api/cron/product-lifecycle-archive` | Daily 00:30 | Archive EOL products after all warehouse stock and incoming supply are depleted |
| FX rate refresh | `GET /api/cron/fx-rates` | Daily 07:00 | Fill `fx_rates` from the source the `fx_rate_source` setting selects (default `ecb`: frankfurter.dev; `aelia`: read the store's Aelia currency-switcher rates through the helper plugin, the exchange-rate master by owner ruling 2026-10-26), and re-attempt any WooCommerce orders queued for a previously-missing rate |
| Activity cleanup | `GET /api/cron/activity-cleanup` | Daily 03:00 | Purge activity log entries past retention |
| Scheduled backup | `GET /api/cron/backup` | Daily 01:00 (scheduler default; **off** by default in the scheduler, the installer bootstraps its own crontab line) | Create backup, write manifest sidecar, apply retention, upload to remote storage |
| Accounting daily batch | `GET /api/cron/accounting-daily-batch` | Daily 02:00 | Post Group A1/A2/B sub-ledger journals to Xero with deterministic split-batch refs when daily cap exceeded |
| Accounting payment poll | `GET /api/cron/accounting-payment-poll` | Every 15 min | Detect paid invoices/bills in Xero and reconcile in IMS |
| WooCommerce reconcile | `GET /api/cron/wc-reconcile` | Hourly | Backup reconciliation for WooCommerce orders/products plus stock catch-up and queued retry draining. The forceAll stock catch-up works through the catalogue in id-ordered windows of 150 candidates with a saved cursor (setting `wc_stock_daily_reconcile_cursor`), and stops taking windows after about 20 s so the request stays inside the proxy's 60 s cut-off; an unfinished pass continues on the next run whether or not 24 hours have passed, and `last_wc_stock_daily_reconcile_at` is stamped only when the last window is done and every window completed without error (a window with any failed candidate is retried and logged as `stock_reconcile_window`). The cursor is stored with the WooCommerce settings version and restarts the pass if the version changes; a run refused before its first window writes no stamp. The job is registered hourly so a full pass finishes within a day |
| Mintsoft webhook sweeper | `GET /api/cron/mintsoft-webhook-sweeper` | Every 5 minutes | Drain persisted Mintsoft ASN booked-in webhook events and apply stock/PO effects asynchronously |
| Mintsoft despatch poll | `GET /api/cron/mintsoft-dispatch-sync` | Every 15 minutes | Poll pushed-but-not-shipped orders for a despatched status and progress the IMS shipment, tracking and stock; reads from Mintsoft only. A registered job, on by default |
| Delivery status | `GET /api/cron/delivery-status` | Every 15 min | Poll delivery tracking providers for shipment status updates |
| WC withdrawal sweep | `GET /api/cron/wc-withdrawal-sweep` | Every 15 min | Two passes. (1) Re-check orders refused as EU withdrawals against the live storefront status, by order ID — the only route that does not depend on another event arriving. (2) Screen a bounded, rotating slice of the DISPATCH-ELIGIBLE links (100/run, the dispatch sweep's own eligibility) against the storefront and apply any withdrawal found, so an order withdrawn AFTER it was pushed becomes locally known before the dispatch sweep reconciles it. The storefront read lives here, not on the dispatch tick, so a WooCommerce outage cannot interfere with dispatch reconciliation; the residual bound is one rotation (ceil(eligible at rotation start/100) runs). A rotation's END is fixed when it STARTS (the highest eligible link id at that moment) and the slice is `cursor < id <= bound`, so links created while it runs belong to the NEXT rotation and cannot extend this one — without that upper bound a shop that keeps taking orders never empties the slice ahead of the cursor, the wrap never fires, and long-lived links behind it are screened once and never again. The position AND the rotation it belongs to are HELD together when a slice cannot be read. |
| Accounting sync queue | `GET /api/cron/accounting-sync` | Every 5 min | Settle held posting refusals, then process pending accounting sync rows through the active connector (Xero: also the back-reference repair sweep) |
| Accounting payment reconcile | `GET /api/cron/accounting-payment-reconcile` | Daily 03:00 | Backlog sweep of every locally linked invoice/bill against its current Xero status; report-only until `xero_payment_reconcile_apply` is set to `true` |
| Xero tax-rate drift | `GET /api/cron/xero-tax-rate-drift` | Hourly | Read the Xero tax-rate list into the master store and log a warning when a rate was edited directly in Xero (alert-only) |
| WooCommerce webhook inbox | `GET /api/cron/shopping-webhook-inbox` | Every 5 min | Process persisted WooCommerce order, product and refund webhook events and retry queued order completions |
| WMS order push | `GET /api/cron/wms-order-push` | Every 10 min, **off** by default | Push ready orders for WMS-bound warehouses and propagate cancellations |
| WMS order status | `GET /api/cron/wms-order-status` | Every 15 min, **off** by default | Refresh cached WMS order statuses |
| WMS order reconcile | `GET /api/cron/wms-order-reconcile` | Daily 05:30, **off** by default | Order-level check of IMS against the WMS |
| WMS watchdog | `GET /api/cron/wms-watchdog` | Hourly at :15 | Overdue-ASN and quiet-stock-sync checks; alerts administrators once per breach |
| Mintsoft stock sync | `GET /api/cron/mintsoft-stock-sync` | Hourly, **off** by default | Poll Mintsoft stock for bound warehouses (discrepancies, or align when the binding is Align To WMS) |
| Mintsoft returns sync | `GET /api/cron/mintsoft-returns-sync` | Hourly at :15, **off** by default | Poll the returns feed into the Returns Inbox |
| Mintsoft product / bundle verify | `GET /api/cron/mintsoft-product-verify`, `GET /api/cron/mintsoft-bundle-verify` | Daily 03:00 / 03:30, **off** by default | Check product, barcode and KIT-bundle mappings |

All cron endpoints require the `CRON_SECRET` bearer header in production. Production startup fails fast if `CRON_SECRET` is unset, blank, or shorter than 32 characters. Localhost bypass is available outside production only when no `CRON_SECRET` is configured; production never accepts localhost cron requests without the bearer header. After successful cron authentication each endpoint is rate-limited per job and source IP when a client IP is available; jobs that run hourly or less often get 3 accepted runs per cadence window (so a daily job gets 3 per 24 hours, an hourly job 3 per hour), while 5-minute and 15-minute jobs use schedule-compatible hourly quotas with jitter headroom. Rate-limited calls return `429` with `Retry-After`. The default in-memory rate-limit backend is only process-local; multi-replica deployments must use `RATE_LIMIT_BACKEND=redis` with `REDIS_URL` so cron limits are cluster-wide. Rotating `CRON_SECRET` requires updating both `.env` and any external cron scheduler invocations in the same maintenance window because the application reads the environment value on restart. If a leaked or stale secret exhausts a cron quota during rotation, restart the memory backend or clear the Redis rate-limit keys.

### Cron rate limits

Each cron route has its own per-route quota, derived from its effective schedule (`lib/cron-rate-limit.ts`): a job that runs hourly or less often gets three runs per cadence window (the scheduled run plus two spare, so a daily backup gets 3 per 24 hours), a sub-hourly job its runs per hour plus a quarter (at least two) spare (the 15-minute payment poll gets 6 per hour). Requests beyond the quota return `429 Too Many Requests` with a `Retry-After` header; no activity-log entry is written. The jobs that call Xero (`accounting-sync`, `accounting-daily-batch`, `accounting-payment-poll`, `accounting-payment-reconcile`, `xero-tax-rate-drift`, `account-balance-snapshot`, `xero-chart-sync`) are also held to an IP-independent rolling daily RUN budget (scheduled runs per day plus a quarter and two spare, ceiling 500), so a leaked secret used from many addresses cannot multiply runs. That is a run budget, not the Xero call budget described under Xero below. This prevents a misconfigured external scheduler from hammering a single endpoint.

### Connection test gate

Settings for WooCommerce, Xero, Mintsoft, and SMTP cannot be saved as "active" until a successful **Test Connection** has been recorded against the current credential fingerprint. The fingerprint is a SHA256 of the credential payload; changing any byte invalidates the gate and requires a fresh test. The fingerprint (not the credentials) is written to the activity log on each test, so silent credential rotation is visible in the audit trail.


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

Report CSV exports keep the first CSV row as the data header and avoid repeating report-level metadata on every data row. When an export has report-scoped context such as `generatedAt`, date windows, valuation source, or ledger opening/closing totals, the route exposes it once in the `X-IMS-Export-Metadata` response header for API clients. The CSV body is data rows only by default, because CSV has no comment syntax and standard parsers would read trailing `#` rows as records; a request that adds `?metadata=1` (the dashboard's CSV download links all do) additionally gets the same metadata as `#` comment rows at the end of the file (`# IMS export metadata`, then one `# key,value` row per key), which `parseCsv` skips. The header value is base64url-encoded JSON, capped defensively before it reaches proxy-sized headers, and listed in `Access-Control-Expose-Headers` for browser fetch clients that use CORS. The replenishment (reorder, backorder, component shortage) and manufacturing analytics (production variance, WIP) exports carry the report's notices (products left unplanned, started orders with no usable frozen recipe, estimated lead times) the same way, but in their own `X-IMS-Export-Notices` response header (base64url JSON array of strings; cut from the end and flagged by `X-IMS-Export-Notices-Truncated` when over the 4096-byte cap), and the CSV body stays data rows only by default; the notices are appended after the data as `# notice` rows (complete, not capped) only when the request carries `?metadata=1` (the dashboard links do) or `?notices=1`. Row-level provenance remains in the CSV body when it can vary by row, for example stock-on-hand reservation snapshot fields and allocation source values.


## External Integrations

### Supported connectors, and the retired ones

The registries (`lib/connectors/shopping-registry.ts`, `lib/connectors/accounting-registry.ts`) hold one shopping connector, WooCommerce, and one accounting connector, Xero; the WMS boundary (`lib/connectors/wms/`) has one implementation, Mintsoft. The QuickBooks, Shopify and ShipHero connectors have been removed from the build: the QuickBooks and Shopify code is archived under `archive/connectors/` (see its README) and ShipHero is kept by git tag only (`archive/shiphero-connector`). Forward migrations (`20261122140000_purge_retired_accounting_settings`, `20261126120000_purge_retired_storefront_wms_settings`) delete the settings rows they left behind. Historical rows in other tables whose `connector` names a retired connector are left in place and read through the generic unregistered-connector paths.

### Xero

Xero integration is implemented as a modular connector in `lib/connectors/xero/`, fully independent of any shopping channel module.

- **Sub-ledger model** — IMS acts as accounting guard; Xero handles invoicing, payments, and bank reconciliation; IMS creates daily correction journals
- **Sales invoices** — invoice created at order time, AUTHORISED by default and DRAFT only while the *Sales invoices* posting mode (`xero_sync_sales_invoice`) is `draft` (the same for WooCommerce and manual orders), with automatic Xero payment registration. Edits to sales orders that already carry an `accountingInvoiceId` enqueue a Xero `SALES_INVOICE_UPDATE` with a payload-derived idempotency key (same shape as the purchase bill update path). A connector that does not support invoice updates logs a `sales_invoice_update_skipped_unsupported_connector` WARNING instead.
- **Purchase bills** — pushed when a PO is invoiced, with optional supplier invoice PDF attachment; unpaid IMS bills can be edited and, once externally synced, enqueue a Xero `PURCHASE_INVOICE_UPDATE` with a payload-derived idempotency key. Per-event FX rates for purchasing (ADMIN switch `purchase_event_fx_rates_enabled`, off, and refused while the interlock `PURCHASE_EVENT_FX_STEPS_COMPLETE` is `false`): receipts at the Xero prepayment lock rate or the fx_rates rate (`lib/domain/purchasing/purchase-receipt-fx.ts`), bills at that rate with a separate PPV line and a `PURCHASE_FX_VARIANCE` journal (Realised FX vs Stock in Transit) computed target-state by `reconcilePurchaseBillFx` (`lib/domain/purchasing/purchase-bill-fx.ts`), bills posted outside IMS only after an owner confirmation (`npm run purchase-fx:non-ims-bills`); the full contract is the `purchase_event_fx_rates_enabled` entry in `docs/installation.md`
- **Credit notes** — pushed on refund with sub-ledger state-aware reversal journals
- **Tax rate sync** — multi-component IMS `TaxRate` rows enqueue a Xero `TAX_RATE_SYNC` on save. The processor calls Xero's `POST /TaxRates` with the matching `TaxComponents` payload so the VAT return picks up the component breakdown. Xero matches by `Name` so re-syncs are idempotent. A connector with no equivalent API makes the trigger log a `tax_rate_sync_skipped_unsupported_connector` WARNING instead.
- **Rejected update alerts** — failed `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` rows surface on the related sales-order and purchase-order detail pages with connector, timestamp, retry count, and a safely truncated error message; the raw sync payload is not exposed to the UI.
- **Reverse charge** — lines whose `TaxRate.reverseCharge` is true swap the connector-side tax type to a configured `accounting_reverse_charge_{sales,purchase}_tax_type` so the Xero VAT return classifies the line on box 1 / box 8. Empty settings fall back to the parent `accountingTaxType` so existing posting behavior is preserved.
- **Daily batch sync** — nightly cron runs Group A1 (revenue deferral of a paid order's unshipped revenue; with the ADMIN switch `xero_defer_unpaid_invoiced_revenue_enabled`, off by default, also of an unpaid order whose AUTHORISED invoice provably reached Xero after the switch went on, dated on the invoice's document day, `lib/domain/accounting/invoice-basis-deferral.ts`), A2 (inventory reclassification), B (shipment COGS + revenue recognition via FIFO cost layer consumption). Each Xero group processes at most `XERO_DAILY_BATCH_LIMIT` candidate rows per run, default `1000`, and leaves unprocessed rows eligible for the next run while reporting `hasMore` in the cron summary. Split batches use deterministic batch reference suffixes so Xero-facing journal references stay unique for the same business date. Finance reconciliation should treat split journals as one logical daily batch by grouping on the payload metadata (`batchDate`, `batchGroup`, `batchReferenceId`) or the shared date/group reference prefix, then summing all entries for that group and date.
- **Payment polling** — 15-min cron detects paid invoices (manual orders) and paid bills (POs) via Xero API; a daily `accounting-payment-reconcile` sweep checks every locally linked document by id
- **Producer seam and holds** — every write toward Xero (and WooCommerce, Mintsoft) is subject to two independent controls. The outbound-write hold at the HTTP boundary refuses a write unless the destination's grant variable is set (`npm run outbound:status` reports it). The producer-side hold applies **only to the destinations named in `PRODUCER_HOLD_ENFORCED_DESTINATIONS`, which is unset by default** (so by default every operation is LIVE as far as that hold is concerned); for a named destination it decides per operation whether work is LIVE or recorded as a shadow instead of being queued; a shadow is never delivered later. For Xero a shadow is a CANCELLED sync row with the reason "Not sent by IMS: writes to Xero are held on this installation". Full contract: installation.md, "Outbound-write hold" and "Producer-side hold".
- **Call budget** — Xero allows 1,000 calls per organisation per rolling 24 hours (not midnight-reset) and 60 per minute. The transport keeps a bucket per tenant and per IMS process (it restarts from zero with the application and does not see calls Xeroom or another integration makes on the same organisation, so Xero can 429 earlier) and refuses a call at 950 per rolling day or 55 per minute (`XERO_DAY_LIMIT`, `XERO_MINUTE_LIMIT`, `lib/connectors/xero/api.ts`). A refused call consumes no budget. What the row does then differs: a manual journal is handed back with no retry spent (`xero_sync_transport_refused_before_post`), but invoices, updates, credit notes and bills fail with "Xero day budget exhausted ...", which is not recognised as a rate limit (`isRateLimitError`, `lib/connectors/xero/deferral.ts`), so each spends a retry and goes Failed after 5 and needs **Retry** once the window clears (a known gap, being fixed). The minute cap is waited out for up to 60 s, except for a bounded call made under database locks, which is refused and retried from the queue. A 429 with a Retry-After longer than 90 s is not waited out.
- **Sync-log retention** — `retention_sync_logs_months` (default 6) deletes settled `accounting_sync_logs` rows and compacts expired unresolved ones to a tombstone (payload and error cleared). The confirmed Xero `SALES_INVOICE` / `SALES_INVOICE_UPDATE` rows of an order are never deleted: past the window their payload is reduced to a projection of the posted tax codes (`postedInvoicePayloadProjection`, `lib/domain/sales/posted-invoice-tax-codes.ts`) so refunds and invoice updates still know which codes the invoice was posted with; names, emails, line text and the reference are removed. Any other Xero invoice or update row of an order that names its document keeps only that id and the origin stamp when compacted; every other row compacts to an empty payload as before.
- **Invoice PDF** — downloaded from Xero, saved locally, emailed to customer, download link pushed to WC order
- **Payment method mapping** — composite `{method}:{currency}` key maps to Xero bank account codes
- **OAuth 2.0** — access/refresh tokens stored encrypted in Postgres (`AccountingToken`), refreshed before each API call. There is no token file and no `XERO_TOKEN_PATH`
- **Deep links** — "View in Xero" links on sales order and PO detail pages

### WooCommerce

WooCommerce integration is implemented as a modular connector in `lib/connectors/woocommerce/`, reached through the shopping registry and `lib/shopping.ts`. The `ShoppingConnector` interface in `lib/connectors/types.ts` is declared but not implemented by it; the accounting side is the separate `AccountingConnector` interface, implemented by Xero.

- **Order import** — webhook-first via `/api/webhooks/shopping/woocommerce/orders` (`order.created` and `order.updated`; deliveries are stored first and processed by the `shopping-webhook-inbox` job as the backstop), with `/api/cron/wc-reconcile` as backup reconciliation
- **Status sync** — bidirectional mapping between WC and IMS statuses (configurable via `ShoppingStatusMapping` with seeded defaults matching WC flowchart)
- **Refund sync** — creates refund records with credit notes and COGS reversal. Refunds are read from the order on an `order.updated` delivery and by the refund sweep; the `refunds` resource route also accepts a `refund.created` delivery, but "Setup Webhooks" registers only `order.created`, `order.updated` and `product.updated`. A refund that cannot be applied safely is parked on Sync > Exceptions
- **Product sync** — bidirectional product data sync via webhook (`/api/webhooks/shopping/woocommerce/products`, `product.updated`), including prices, dimensions, weight, GTIN/EAN (`global_unique_id`), HS code, and country of origin from WC product attributes
- **Stock sync** — IMS to WC, pushed immediately from IMS changes with daily forced stock catch-up and queued retry draining in the reconcile cron; optional COGS sync toggle
- **Tax class mapping** — maps WC tax classes to IMS TaxRate records
- **Completion flow** — WC completed status triggers auto-allocation, shipment creation with tracking
- **Webhook security** — HMAC verification using timing-safe comparison (`timingSafeEqual`)
- **Customer invoice PDFs** — WooCommerce My Account buttons are rendered by the helper plugin after Woo verifies order ownership. The plugin signs a short-lived server-to-server request to IMS with `WC_INVOICE_PDF_SECRET`, which is intentionally separate from `WC_WEBHOOK_SECRET`. The plugin uses an admin-pinned IMS base URL and never follows per-order meta as a fetch URL; IMS order meta only signals `_ims_invoice_pdf_available=yes`.

### Trade & customs classification

HS/CN codes, customs descriptions, and country of origin flow through the product record and are declared to the WMS (`commodityCode`/`customsDescription`/`countryOfManufacture`) and forwarded to WooCommerce attributes. IMS already enforces the customs-critical invariants natively: fail-closed 2026 EU CN8 validation before a WMS push (`lib/trade/cn-validate.ts` — omit non-declarable codes + raise an `INVALID_HS_CODE` discrepancy), WC-authoritative trade-field propagation on import, and a China default for empty origin (`bhdm.1/.2/.3/.5`).

**Decision (2026-07-03, bhdm.6): the AI HS-code classifier + human approval gate will be ported into IMS** rather than delegated to the hs-code-woo WordPress plugin. Rationale: IMS should own trade classification independent of WooCommerce so non-WC sales channels can obtain HS codes, and so the classifier/approval workflow lives beside the authoritative product record. This is a deliberate reversal of the earlier "hs-code-woo is the upstream brain" framing. **Interim state:** hs-code-woo remains the authoritative classifier and IMS consumes its approved codes via WC import until the IMS-native classifier ships; the fail-closed CN validation core (bhdm.3) is already reusable by it. The build is tracked as its own epic (AI classification, confidence bands/flags, human approval queue UI, background sweep).

### Integrations Dashboard

The `/sync` page provides a unified view of all connectors:

- **WooCommerce** — connection settings, order/product/stock sync config, tax mapping, status mapping, sync log
- **Xero** — OAuth connection, account mapping, transaction type toggles, sub-ledger settings, payment method mapping, sync log (with per-row Retry, Retry All Failed and Process Pending Now)
- **Mintsoft** — connection, warehouse bindings and stock sync mode, bundles, returns inbox, receipt reviews, open discrepancies, courier mapping
- **Exceptions**, **Event Timeline** and **Owner confirmations** — what the connectors could not complete by themselves, every change sent to or received from a warehouse, and the switchover confirmations
