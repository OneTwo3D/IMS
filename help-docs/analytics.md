# Analytics & Reports

The analytics section provides operational and finance reporting across stock, purchasing, sales, replenishment, accounting, and manufacturing. Report access depends on role and report family; users only see reports they are allowed to open.

> **New to the terms used here?** See the [Glossary](glossary.md) for plain-English definitions of FIFO, COGS, VAT inclusive/exclusive, preferred supplier, AR/AP aging, and more.

## Common Report Features

Most current reports provide:

- **Date or as-of filters** where the report has a period or historical view
- **Warehouse, category, supplier, product type, or status filters** where relevant
- **Pagination** with selectable row counts
- **Summary tiles** for report-level totals
- **CSV export** for the filtered result set
- **Drill-through links** to source products, orders, shipments, purchase orders, or production orders where the source document is available

### Source-row cap (50,000 rows)

To keep large reports responsive, the underlying data fetch is capped at **50,000 source rows** per report. If your date range or filters select more than that, the report returns a `413 Payload Too Large` error and asks you to narrow the range or apply more filters.

The cap applies before any aggregation, so a report that displays "120 supplier rows" might still hit it if those 120 rows roll up from millions of PO lines — narrow by date in that case.

## Stock Position Reports

| Report | What it shows |
|---|---|
| **Stock on Hand** | Current or as-of stock quantity, reserved quantity, available quantity, unit cost, total value, and reservation evidence. |
| **Inventory Aging** | FIFO cost-layer quantity and value by age bucket. BOM products age from their production layers; KIT rows use component-based semantics when filtered to KIT. |
| **Dead Stock** | Current positive-stock SKUs with no recent sales-dispatch demand inside the selected threshold. Recent never-sold SKUs can be treated separately from dead stock. |
| **Stock Allocations** | Reserved stock by source, including sales, manufacturing, and unattributed reservation drift. |
| **Negative Stock** | Current negative stock rows and products that went negative during the selected movement window. |

Warehouse users can access the stock-position report family. Broader analytics roles can access the full analytics menu.

## Inventory Ledger and Costing

| Report | What it shows |
|---|---|
| **Stock Movement Ledger** | Full movement history with opening and closing quantity/value reconciliation. |
| **Stock Adjustments** | Adjustment movements grouped by reason, product, user, and value impact. |
| **Stock Transfers** | Transfer dispatch, receipt, in-transit, overdue, and drift evidence. |
| **Stock Counts** | Stocktake/count variance, book versus counted quantity/value, and resulting adjustment links. |
| **Inventory Valuation** | IMS stock value by product, category, warehouse, and as-of date. When accounting balance snapshots exist, the report shows GL variance. |
| **COGS Report** | COGS from `CogsEntry` rows, with revenue and gross margin where sales-order-line links are available. |
| **Landed Cost Analysis** | Purchase-order landed cost uplift, allocation method, revaluation run evidence, and effective unit cost impact. |
| **Inventory Turnover** | Sales-dispatch COGS divided by observed average inventory value from daily snapshots. |

Inventory valuation and COGS only show accounting variance when matching account-balance snapshots have been ingested from the accounting connector. Missing snapshots are shown as explicit notices rather than inferred balances.

## Inventory Health and Demand Planning

| Report | What it shows |
|---|---|
| **Velocity Rankings** | Top and bottom movers by sales velocity over the selected window. |
| **ABC Analysis** | Pareto classification by COGS or revenue contribution. |
| **Reorder Planning** | Suggested reorder quantity using reorder point, reorder quantity, safety stock, supplier lead time, sales velocity, available stock, and inbound open purchase orders. |
| **Backorders** | Non-cancelled sales-order demand not covered by committed shipments or allocations, with expected inbound quantity and projected fill date. |
| **Component Shortages** | BOM component demand from draft and in-progress production orders compared with available plus inbound stock. |

Reorder suggestions are never negative. They are planning guidance and should be reviewed before creating supplier documents.

### Lifecycle filtering

Only **Draft** and **Active** products appear in reorder planning by default. **EOL** and **Archived** products are excluded — you should be running them down, not reordering them. To see EOL products too, toggle the "Include EOL" filter.

### Preferred supplier scoping

When you generate draft POs from reorder planning, the system groups suggestions by each product's **preferred supplier**. One draft PO is created per supplier with all of that supplier's products on it, rather than one giant mixed PO.

Products without a preferred supplier are listed under "Unassigned" and require you to pick a supplier before the draft can be generated. The preferred supplier is auto-updated whenever a PO is sent to a different supplier for that product, so once you start ordering from a new vendor, planning follows you.

## Sales and Fulfillment Analytics

| Report | What it shows |
|---|---|
| **Sales Analytics** | Sales totals by product, category, customer, or channel. Cancelled orders are excluded. |
| **Customer Mix** | Revenue, gross profit, AR exposure, and concentration by customer. |
| **Gross Margin** | Product margin using posted COGS entries rather than recalculating FIFO. |
| **Returns** | Refund and return activity by SKU, customer, and reason, with same-period shipment context. |
| **Fulfillment KPIs** | Shipment-based fulfillment timing, fill rate, partial shipment rate, and late shipment evidence. |
| **Throughput** | Shipment status activity by user and queue depth for picking, packing, and shipping work. |

Revenue figures honour each order's `taxInclusive` flag: tax-exclusive orders use the line subtotal before VAT; tax-inclusive orders back-calculate revenue by removing VAT from the gross. Mixed-mode batches (some WC orders inclusive, some exclusive) sum correctly without double-counting.

## Purchasing and Supplier Analytics

| Report | What it shows |
|---|---|
| **Open POs** | Purchase orders not fully received, including expected dates, overdue flag, outstanding quantity/value, supplier, and days since sent. |
| **Supplier Performance** | On-time delivery, received-versus-ordered quantity variance, actual lead time, and supplier-level performance. |
| **Purchase Price Variance** | Actual received cost compared with the prior received PO line for the same supplier/SKU. |
| **Spend** | Received purchase-order spend by supplier, category, and month. |
| **Lead Times** | Actual receipt lead-time distribution and P50/P95 metrics that feed reorder planning when supplier lead time is missing. |

## Finance Period-End Analytics

| Report | What it shows |
|---|---|
| **VAT** | Output and input VAT by side / reporting category / jurisdiction / tax rate, for invoiced non-cancelled sales orders and purchase-invoice lines in the selected period. |
| **AR Aging** | Outstanding sales-order balances by customer and aging bucket (Current / 1–30 / 31–60 / 61–90 / 90+). |
| **AP Aging** | Outstanding purchase-invoice balances by supplier and aging bucket. |
| **FX Gain/Loss** | Booked versus settlement FX delta for multi-currency transactions using IMS FX-rate semantics (realised + unrealised). |

Finance period-end reports are limited to finance and admin roles.

### VAT report — reporting category dimension

The VAT report groups by **side**, **reporting category**, **jurisdiction**, and **tax rate**, so a 20% UK domestic sale and a 20% EU OSS sale appear as separate rows even though they share the rate. Categories come from the `TaxRate.reportingCategory` field configured in Settings > Accounting > VAT rates: `DOMESTIC`, `REVERSE_CHARGE`, `EC_SALES`, `OSS`, or `Uncategorised` for tax rates with no category set.

A **Reporting category** dropdown filter at the top of the report scopes the page to a single category — useful when preparing OSS filings or matching the reverse-charge box on the VAT return. The filter round-trips through the URL (`?vatReportingCategory=OSS`) so the value is preserved in CSV exports and pagination links.

Multi-component tax rates (e.g. Canada `GST + PST`) post to the accounting system with a single effective rate per line. The component breakdown is captured at the rate-profile level and synced to Xero's TaxComponents API (see Settings > Accounting > VAT rates); the report does not list components separately.

## Manufacturing Analytics

| Report | What it shows |
|---|---|
| **Production Variance** | Planned BOM component demand versus actual `PRODUCTION_OUT` consumption for assembly production orders. Positive variance is labelled **over-consumed**, not scrap, because the cause may be scrap, substitution, BOM drift, or intentional yield padding. Date filters apply to completion date. |
| **WIP** | Current in-progress production orders, posted consumed component value, manufacturing cost-line totals, combined WIP value, expected output value, and decimal days since start. WIP is a current-state report and does not apply date filters. |

WIP value combines components already consumed into production with labour/overhead cost lines. Production variance over-consumed value is averaged across the consumed movement value; use FIFO cost entries for layer-exact costing analysis.

## Legacy Analytics Pages

Some legacy analytics pages remain available for continuity:

- **Sales Statistics**
- **Purchase Statistics**
- **Product Profitability**
- **Inventory Report**
- **Reorder Forecast**

New report families under `/analytics/*` are the preferred source for production-readiness reporting because they expose clearer provenance, RBAC, CSV exports, and reconciliation notices.

## Training Data for Forecasting

Historical demand can still be imported for forecasting:

- **WooCommerce import** — bulk import past WooCommerce orders by date range. A progress indicator shows real-time import status including pages processed and orders imported.
- **CSV import** — upload historical sales data for products not covered by WooCommerce.


## Troubleshooting

| Problem | Where to look |
|---|---|
| Report returns 413 Payload Too Large | Narrow date range or apply more filters — see [Source-row cap](#source-row-cap-50000-rows) |
| Revenue doesn't match invoice total | Check the order's `Tax Inclusive` flag |
| Reorder planning missing a product | Check lifecycle status — EOL/Archived are excluded by default |
| Draft PO has wrong supplier | A preferred supplier was auto-updated by a recent PO; edit on the product page |
| Inventory valuation shows no GL variance | Account-balance snapshots haven't been ingested from the accounting connector yet |
| FX rate looks stale | FX rates auto-fetch via cron — see [Troubleshooting](troubleshooting.md) for cron status |
