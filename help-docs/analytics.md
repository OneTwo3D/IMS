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
- **An (i) icon beside the report title.** The report's description and its methodology notices (what the figures include, rounding, estimated lead times, products that could not be planned, and so on) are in that tooltip. Hover over it or tab to it with the keyboard to read them; there is no separate notices box on the page.

### CSV exports

The **CSV** button on a report downloads the filtered result as **data rows only**, so the file opens cleanly in a spreadsheet or parser. Report-level totals and disclosures (period totals, rounding and refund-basis notices) are normally not appended to the file. They are added as trailing `#` comment rows only when the export address carries `?metadata=1`. The CSV links on the report pages themselves (stock position, replenishment, inventory ledger, inventory costing, sales analytics, manufacturing and the Purchase Statistics tabs) add it for you, so a download from the page still carries them. A direct call to the export address, and the CSV links on Sales Statistics, Inventory Report and the finance and purchasing reports, give data rows only. Notices for the replenishment (reorder, backorder, component shortage) and manufacturing (production variance, WIP) exports follow the data as `# notice` rows under the same rule; they can also be requested with `?notices=1`.

### Who can open which report

| Report group | Roles |
|---|---|
| Sales Statistics, Product Profitability, Inventory Report | Admin, Manager, Finance, Read-only |
| Purchase Statistics (page, data and its CSV exports) and the Purchasing reports (Open POs, Supplier Performance, Purchase Price Variance, Spend, Lead Times) | Admin, Manager, Finance |
| Stock Position reports | Admin, Manager, Finance, Read-only, Warehouse |
| Stock Movement Ledger, Stock Adjustments, Stock Transfers, Stock Counts | Admin, Manager, Finance, Warehouse |
| Inventory Valuation, COGS Report, Landed Cost Analysis, Inventory Turnover | Admin, Manager, Finance |
| Replenishment (Reorder Planning, Backorders, Component Shortages), Sales reports, Manufacturing reports | Admin, Manager, Finance |
| Finance period-end reports | Admin, Finance |

A role that is not allowed a report does not see it in the Analytics menu and is sent back to the dashboard if it opens the address.

### Source-row limits

To keep large reports responsive, the underlying data fetch is capped per report, and the cap depends on the report family: **50,000 source rows** for Sales, Purchasing, Finance, Replenishment (reorder, backorder, component shortage) and Manufacturing reports, and **100,000 source rows** for Inventory Health (aging, dead stock) and Inventory Costing (COGS, inventory turnover). If your date range or filters select more than that, the report is **not computed**. A red banner at the top of the page says "This report hit its row limit (<the report's limit> rows); narrow the date range or filters", the summary tiles show a dash instead of a figure, and the table says "Report not computed". It never shows zeros or "No rows" for a report that was refused. The CSV button gives the same refusal as a file, not an error: a normal download (HTTP 200) with the report's usual column headings and one row whose first cell reads `REPORT NOT COMPUTED` and whose next cell carries the same message, with no data rows and no totals. It is never a file of zeros. Scripts can detect it from the `X-IMS-Report-Not-Computed: 1` response header (the row limit is in `X-IMS-Report-Row-Limit` and in the `X-IMS-Export-Metadata` header).

The cap applies before any aggregation, so a report that displays "120 supplier rows" might still hit it if those 120 rows roll up from millions of PO lines — narrow by date in that case.

## Stock Position Reports

| Report | What it shows |
|---|---|
| **Stock on Hand** | Current or as-of stock quantity, reserved quantity, available quantity, unit cost, total value, and reservation evidence. |
| **Inventory Aging** | FIFO cost-layer quantity and value by age bucket. BOM products age from their production layers. Virtual KIT products hold no cost layers of their own, so they are left out of the list; if you filter to Type KIT the report is empty and says so, and you age the component SKUs instead. |
| **Dead Stock** | Current positive-stock SKUs with no recent sales-dispatch demand inside the selected threshold. Recent never-sold SKUs can be treated separately from dead stock. |
| **Stock Allocations** | Reserved stock by source, including sales, manufacturing, and unattributed reservation drift. |
| **Negative Stock** | Current negative stock rows and products that went negative during the selected movement window. |

Warehouse users can access the stock-position report family. Broader analytics roles can access the full analytics menu.

## Inventory Ledger and Costing

| Report | What it shows |
|---|---|
| **Stock Movement Ledger** | Full movement history with opening and closing quantity/value reconciliation. |
| **Stock Adjustments** | Adjustment movements grouped by reason, product, user, and value impact. |
| **Stock Transfers** | Transfer dispatch, receipt, in-transit, overdue, and drift evidence (columns: status, from, to, dispatched, received, days, sent qty, received qty, drift, movement value; the summary shows in-transit and overdue counts). **Received** is what has come to rest by any route — a manual receipt, a WMS book-in, or a WMS stock-sync alignment (which raises stock without recording a receipt on the line) — so **Drift** is requested less that figure. A transfer the WMS accounted for entirely no longer reports as 100% drift. |
| **Stock Counts** | One row per SKU on each count: book qty, counted qty (an uncounted line reads **Open**), variance, and the value of the linked adjustment (**No evidence** where no adjustment movement is linked back to the count). The summary shows total variance, linked value, the number of rows missing adjustment evidence (also named in a notice) and repeat-offender SKUs. |
| **Inventory Valuation** | IMS stock value by product, category, warehouse, and as-of date. When accounting balance snapshots exist, the report shows GL variance. |
| **COGS Report** | COGS from `CogsEntry` rows, with revenue net of the period's net-basis credit and gross margin where sales-order-line links are available. |
| **Landed Cost Analysis** | Purchase-order landed cost uplift, allocation method, revaluation run evidence, and effective unit cost impact. |
| **Inventory Turnover** | Sales-dispatch COGS divided by observed average inventory value from daily snapshots. |

Inventory valuation and COGS only show accounting variance when matching account-balance snapshots have been ingested from the accounting connector. Missing snapshots are shown as explicit notices rather than inferred balances.

Revenue in the COGS Report is the ex-VAT sales-line revenue behind each dispatch **less the net-basis credit raised in the period against those same orders**, so a returned sale no longer shows its original revenue and margin there. Gross-basis and unproven-basis credit is shown beside the figures and is **not** deducted — no stored rate converts a VAT-inclusive credit into an ex-VAT one, and guessing is the defect this whole mechanism exists to avoid — so where any exists, revenue and gross margin are marked **≤** — the true figure is at most the one shown — and **Margin %** is marked **?** where the direction of its bound is not established, because a ratio moves its numerator and denominator together. Revenue and gross margin are marked **?** instead of **≤** where some of the unplaced credit is negative (a reversal), because the true figure may then be above the one shown as well as below it. Credit that reached no row is shown separately, on its own basis, in two cases: credit whose line named no sales line or product at all (a shipping or monetary-only credit), and credit naming one this window has no revenue row for. Either one bounds the period totals even when the credit is the same unit as the figure, because it is real credit that nothing subtracted. Every row's credit, both bound markers and all of those totals travel with the CSV as their own columns and `totals.<name>` metadata rows. Inventory Turnover is a COGS-over-inventory-value ratio and no refund moves either input.

Three details worth knowing before you reconcile against it. The credit is anchored to the date the refund was **raised**, which is the same rule the Gross Margin report uses: a credit raised this month against last month's dispatch belongs to this month, exactly as a credit note does to a month's accounts, and a credit raised next month is not in this month's figures at all.

**Every** credit raised in the period is counted, including credit against orders this window holds no dispatch for. Those cannot be *deducted* from a row — this report attributes credit to the sales line whose revenue it reverses, and that line's dispatch is in another period — so they appear in the off-report totals and mark the period figures **≤** instead. That is the honest reading: the credit is real and the published revenue does not reflect it. What is excluded is credit for a product your **product, category or supplier filter** left out, because that credit is not against anything the filtered view publishes. A credit line naming no product at all is never filtered away, since nothing proves it is about a product you excluded. A **warehouse** filter cannot narrow credit at all — a credit line records no warehouse — so a warehouse-filtered view may show off-report credit for a dispatch from another warehouse, which makes its bound wider than strictly necessary rather than narrower than honest.

Figures that carry a **≤** are rounded **upward** and figures that carry a **≥** are rounded **downward**, on the page and in the CSV alike, so a printed figure is never on the wrong side of the relation it states; figures with no mark or a **?** are rounded to nearest. Every figure is carried at full precision until it is shown, and then rounded once: on the page to the number of decimals your base currency is printed with — none for yen, three for Kuwaiti dinars — and in the CSV to six decimals for money, four for quantities and two for margin %. A figure is never rounded to one precision and then again to another, which could change the result: 1.004999598 is 1.00 rounded once, but 1.01 if it were first rounded to 1.005000. That rounding is done on the exact stored figure and never on a converted one, which matters at the top of the range: the gap between the numbers a computer can hold as fractions is wider than a hundredth once an amount passes about 90,000,000,000,000, so a figure converted before being rounded could land on the wrong side of its own bound. Because each row and each total is rounded on its own, a column of rows may not add up exactly to the total beneath it, and on a report with more than one page the total also covers the rows on the other pages. The three credit totals differ for one more reason: they also include the credit that reached no row, which is listed separately under the two off-report credit lines. The COGS Report says so in its notices.

A row reads **Unmatched** for revenue and margin when any of its dispatches cannot be matched to a sales order line for the same product. Credit against a line that row *did* match still appears in the row's credit columns — there is no revenue for it to come off — and still marks the period totals; only credit naming a line or product the report has no revenue for at all is shown under the off-report credit lines.

## Inventory Health and Demand Planning

| Report | What it shows |
|---|---|
| **Velocity Rankings** | Top and bottom movers by sales velocity over the selected window. |
| **ABC Analysis** | Pareto classification by COGS or revenue contribution. |
| **Reorder Planning** | Suggested reorder quantity using reorder point, reorder quantity, safety stock, lead time, sales velocity, available stock, and inbound open purchase orders. This page also carries the tools of the old Reorder Forecast (ABC, status and search filters, historical-sales import). See [Reorder Planning](#reorder-planning) below. |
| **Backorders** | Non-cancelled sales-order demand not covered by committed shipments or allocations, with expected inbound quantity and projected fill date. |
| **Component Shortages** | BOM component demand from draft and in-progress production orders compared with available plus inbound stock. |

Reorder suggestions are never negative. They are planning guidance and should be reviewed before creating supplier documents.

### Reorder Planning

The old **Reorder Forecast** page has been retired; its address now opens Reorder Planning, which took over its filters and the historical-sales import. Reorder Planning is under **Analytics > Replenishment**.

- **Filters.** Warehouse, category, supplier, product type, **Demand window** (days of sales history, default 90), **Status** (Critical, Reorder, Watch), **ABC class**, a **Search** box (SKU, name or supplier) and **Weeks of supply** (default 8, from 1 to 52). **Show all products (incl. zero reorder)** lists every candidate product, including those with nothing to order; the CSV export always includes all products.
- **Ignore stockouts** (off by default). Tick it and Apply to stop stockouts understating demand. A product that was out of stock for 60 of the 90 days has fewer chances to sell, so its flat average reads far too low, and those are the products that most need reordering. With the box ticked, each day the product had **no on-hand stock** is taken out of the demand window before averaging: daily demand = units sold / (window days - stockout days). Lost sales are not estimated, only the days are removed, so the result is never lower than without the box. The day-by-day record comes from the **daily inventory snapshots** (the 00:00 UTC stock snapshot), not from replaying stock movements. A day counts as a stockout when a snapshot was taken for that day and on-hand stock, summed across the warehouses in scope (or the chosen warehouse), was zero or below. A day on which **no snapshot was taken is unknown**: it is never treated as a stockout and never as in stock, and it stays in the average. If snapshots only started recently the page says how many of the window's days they cover and since when, so a short history is not read as "no stockouts". A product out of stock for **90% or more** of the window keeps its ordinary average (one sale in 90 days with 89 stockout days would otherwise read as a unit a day); the row and the notices say so. Rows that were adjusted show "n stockout day(s) excluded" under Daily demand. The box carries into the CSV export, the demand chart and the draft PO and production order buttons, so a draft is sized from the same demand you saw. Unticked, nothing changes: the same figures, CSV and drafts as before. Stockout is judged on stock physically in the warehouse (not stock after reservations) and on end-of-day snapshots, so stock that sold out at 10:00 and was restocked at 16:00 shows as in stock.
- **Growth %** (empty or 0 by default). One percentage for a promotion or a seasonal peak: the calculated daily demand is multiplied by 1 + growth/100 **before** anything else is worked out, so 20 means every derived figure runs about 20% higher and -20 plans for a decline. It scales daily demand, forecast quantity, the reorder point and suggested quantity (including the demand that flows down to components of a BOM product), the Required receipt, Latest PO date and First shortage dates, the Forecast sales and Forecast margin columns, the demand chart's projected weeks (history bars stay actual sales), and the draft PO and production order buttons and the CSV export, so everything agrees. It works with **Ignore stockouts**: the stockout-adjusted rate is scaled. It must be between -90 and +500: a value outside that range is limited to the nearest bound and the page says so, and a value that is not a number is ignored. It is a planning assumption for this view only; it is not saved and it is not a forecast of sales, so enter it each time. Empty or 0 leaves all figures, CSVs and drafts exactly as before. A per-product or per-category factor is not available.
- **Forecast sales and Forecast margin** (beside Suggested qty; Admin, Manager and Finance, who hold the price permission). **Forecast quantity** is the row's demand over the **Weeks of supply** (daily demand x weeks x 7, growth included). **Forecast sales** is that quantity at the product's default list price, ex-VAT, in the base currency (a list price stored VAT-inclusive has the sales VAT rate taken off, the same way as the purchase order margin preview; if it is VAT-inclusive and no sales VAT rate is configured the figures read unavailable). **Forecast margin** is forecast sales less forecast quantity x the product's current unit cost: the weighted average of its open cost layers, or its latest cost layer when it holds no stock. A product with **no cost layers** (or no list price) shows **unavailable** instead of a margin, never 0 and never 100%; hover for the reason. These are forward-looking estimates, not booked sales: they are not netted for refunds and are not a sales report. The CSV export has them as the last two columns (`forecastSales`, `forecastMargin`; the word `unavailable` where they cannot be stated), appended so existing columns keep their positions.
- **Sort order.** Highest suggested reorder quantity first, then by status and SKU.
- **Per-warehouse thresholds.** When the **Warehouse** filter is set, each product is planned against that warehouse's own reorder point, safety stock and reorder quantity where one has been set on the product page (Inventory > product > **Reorder thresholds by warehouse**), and against the product's values for any field left blank. A row that uses at least one override shows a blue **Override** tag beside its Reorder point; hover it to see which fields are overridden. Safety stock also drives **Required receipt** and **Latest PO date**, so an overridden safety stock moves those dates too. With **no** Warehouse filter the page is the consolidated, all-warehouses view: stock is summed across warehouses and the product's values are used; a notice counts the products whose overrides were not applied, so choose a warehouse to plan against them. Draft POs and MOs generated from a warehouse-filtered page use the same thresholds. The CSV export keeps its existing columns; for a warehouse-filtered export the Reorder point, Safety stock and Configured reorder qty columns hold the resolved values.
- **Whole numbers.** Available, inbound, reorder point and suggested quantities are shown and exported as whole units; the suggested quantity is rounded up.
- **Suggested quantity (order up to N weeks).** A product is suggested only once its available stock plus inbound open POs has dropped below its reorder point. The order then brings it back up to the reorder point plus **Weeks of supply** worth of forecast demand. A reorder quantity set on the product acts as a minimum lot size, and a reorder quantity of 0 opts the product out. Where a product has no demand the suggestion simply tops it up to the reorder point.
- **Latest PO date and Required receipt.** For each row with sales demand, the page projects available stock day by day: today's available quantity, less the daily demand, plus each open purchase order on its expected delivery date. **Required receipt** is the first day that projection reaches **safety stock** (the day it reaches zero when the product has no safety stock). **Latest PO date** is that day minus the lead time, the last day a purchase order can be placed. This is the reorder point restated in dates: a product whose available stock equals its reorder point shows today as its Latest PO date, so the date columns and the Reorder point column cannot disagree. Dates are whole days (UTC), so a product less than one day of demand under its reorder point still shows today.
  - **Overdue.** A Latest PO date in the past is shown in red with an **Overdue** badge. A product already at or below safety stock has Required receipt of today.
  - **No date.** A product with no sales demand shows a dash and "no demand". A product that does not run down to safety stock within 365 days shows a dash and "beyond horizon". Both stay on the list.
  - **Open POs with no expected delivery date** are included in **Inbound PO** but are left out of the dates, because an unknown arrival cannot rescue a run-out date; a notice counts the rows affected. Set the expected delivery on the PO to get a better date.
  - **Late POs.** Open PO quantity whose expected delivery date has already passed is not received yet, so it is **not** counted in Required receipt, Latest PO date or Overdue; a late PO cannot hide an overdue order. The row shows an amber **Late PO: N due <date>** badge (earliest past due date) and a notice counts the rows. Receive the PO or move its expected date forward and it counts again.
  - **Late PO and the suggested quantity.** The late PO stays counted in Inbound PO and in the suggested quantity, because the stock is on order and IMS does not re-order stock already on order. So a row covered only by a late PO can show a suggested quantity of 0. It is still listed by default when its Latest PO date is overdue, or when stock is short today and the late PO is the only cover. It shows the Late PO badge and a note ("Covered by a late PO: chase the supplier"), and an overdue row is at least **Reorder** status. **Generate** does not draft a 0 quantity: chase or cancel the late PO. If you cancel it, the row's quantity returns on the next run.
  - **Arrivals due today.** A PO due today counts in today's stock. A row is "already below" only when today's stock (available plus arrivals due today) is at or below safety stock; then Required receipt is today and the Latest PO date is the lead time before it (Overdue when lead time is above 0). Available 15, safety stock 20 and a large PO due today is therefore not overdue.
  - **What the dates ignore.** They follow the product's own sales demand. Extra demand from a parent BOM, or a reorder point typed on the product (or on a warehouse), changes the Reorder point and the suggested quantity but not these dates. Safety stock, including a warehouse override of it, does move them.
  - **No supplier.** A row with no supplier keeps its dates; the Supplier column shows **Unassigned** with an amber tint.
  - The CSV export adds Required receipt, Latest PO date, Overdue (yes/no), a timing basis (projected, no_demand, already_below, beyond_horizon), First shortage date (the day projected stock reaches zero), Late PO quantity and Late PO due date.
- **Order qty and Coverage weeks.** Beside the suggestion, each row has an editable **Order qty** and **Coverage weeks**. Coverage weeks is the quantity divided by seven days of that row's own **Daily demand**, shown to one decimal. Change the quantity and the weeks follow; type the weeks you want and the quantity follows, rounded up to a whole unit. A row with no daily demand shows a dash and its weeks cannot be edited. **Reset** puts both back to the system suggestion. These edits are for planning only: they are not saved, are lost when you change filters, page or reload, and do not change what **Generate** drafts, which still uses the system suggestion.
- **ABC class** is worked out from units sold in the demand window (a Pareto split: the products making up the first 80% of units are A, the next 15% B, the rest and anything with no movement C). It does not read the ABC field stored on the product.
- **Lead time** is taken in this order: the manual lead time on the product; otherwise the lead time worked out automatically from your purchase order receipts (the P95 of actual receipt times); otherwise, for a product with no purchase history, the median lead time of its supplier, then of its category; and only if none of those exist a flat 14 days. A notice names the SKUs that use a peer median or the 14-day default.
- **Needed for** shows why a row is there (direct sales, a parent BOM, or stock policy). Manufactured products show **Manufactured by** a named manufacturer or **Manufactured in-house** instead of Unassigned.
- **No claimed recipe.** If a manufactured product needs building but has no claimed recipe, a notice reads "No claimed recipe: component demand not planned for ..." and names the products. Import or claim a recipe for them; their components' demand is not included until you do.
- **Demand chart.** The **Chart** icon at the end of each row (named "Demand chart for <SKU>") opens a read-only chart page for that product, scoped to the warehouse, category, supplier, product type, demand window and weeks of supply you had on Reorder Planning. The address is shareable. Bars show weekly units sold (history, Monday to Sunday UTC) over the demand window, then the projected demand for the coming weeks, which is a **flat average** (the same daily figure the row uses, scaled by **Growth %** when one is set, with no other trend or seasonality), and the dated open purchase orders landing each week. The line is projected available stock at the end of each week; horizontal lines mark safety stock and the reorder point; vertical markers show **Required receipt**, **Latest PO date**, **First shortage** (projected stock at or below zero) and today. The required receipt bar is the row's suggested quantity, separate from the existing purchase orders. A product with no sales in the window shows a "No sales history" message instead of a chart. Every chart has a text summary and a data table below it. Past weeks also show a dashed **on-hand stock** line from the daily snapshots (end of the last covered day of the week; the solid line is projected *available* stock, after reservations) and are shaded by stock state: **red** weeks had at least one day with no on-hand stock, **dark grey** weeks are unknown (no snapshot was taken at all), **light grey** weeks have some unknown days, and unshaded weeks were in stock every day. Unknown is not "in stock". The data table lists the stockout, in-stock and unknown day counts per week. The first and current weeks are partial, and today stays unknown until tonight's snapshot. The chart follows the **Ignore stockouts** box. The page needs the same access as Reorder Planning (Admin, Manager, Finance). Optional address parameters `historyWeeks` and `forecastWeeks` change the two windows.
- **Supplier override.** On a purchased row, the Supplier cell becomes a dropdown when the product has more than one catalog supplier (the default is marked "(default)"). Pick another supplier and the draft PO line goes to that supplier's draft instead, priced from that supplier's catalog entry. Only a supplier that carries the product is accepted; anything else is skipped with "supplier override not in catalog" and is never silently swapped for the default. Manufactured rows have no supplier choice. An override applies only to the rows being generated, and is cleared with the selection. With a **Supplier** filter active only that supplier's catalog entry is loaded, so there is nothing else to pick.
- **Draft PO destination and dates.** The draft PO's destination warehouse is the **Warehouse** filter you generated from. With no warehouse filter the draft has **no destination**, and a hint above the table says "Select a warehouse to set the PO destination"; IMS never guesses a warehouse. Each draft line carries an estimated delivery date taken from the row's **Required receipt**, but never earlier than today plus the lead time (an overdue row cannot arrive sooner than the lead time). A row with no Required receipt gets today plus its lead time (the earliest it could arrive), so no line is left to borrow another line's date. The PO's own date is the earliest of its line dates. Lines keep the raw and adjusted dates in their reorder evidence.
- **Selecting rows and generating drafts.** Each row has a checkbox, with a select-all box in the header (the keyboard shortcut **a** toggles all rows, **Enter** generates). With rows ticked the button reads **Generate from selection**; with none ticked it reads **Generate POs + draft MOs for all visible rows** and asks you to confirm the row count first. Purchased products become one draft purchase order per supplier; manufactured products become draft production orders. The selection, and any supplier overrides, are cleared when you change filters or page. See [Purchasing](purchasing.md#supplier-scoped-reorder-drafts).
- **Import history.** Admin and Manager users see an **Import history** button on the page header. It opens the historical-sales import (see [Training Data for Forecasting](#training-data-for-forecasting)).

### Warehouse filtering

When you filter reorder planning to a warehouse, available stock, inbound open POs and sales demand are
all scoped to that warehouse.

Sales demand was previously company-wide even under a warehouse filter, which divided warehouse-scoped
stock by whole-company demand and so **overstated reorder points and suggested quantities**. Since that
was corrected, a warehouse-filtered report shows lower demand and therefore smaller (or fewer)
suggestions than before. The unfiltered, all-warehouse report is unchanged.

Dead stock reads demand the same way, so a SKU whose only recent sales are imported history is **not**
reported as dead. Before that was fixed, such a SKU could appear on the dead-stock list and the reorder
list at the same time.

**Demand imported as sales history is an exception.** The historical/initial sales import records past
sales without a warehouse, because the source data does not say which one shipped them. That demand
continues to count toward **every** warehouse rather than being dropped from warehouse-filtered reports —
excluding it would understate demand and risk stockouts. So a tenant whose recent history is mostly
imported will see warehouse-filtered demand that is closer to the company-wide figure. To get demand
attributed per warehouse, it has to come from dispatches recorded in IMS.

### Lifecycle filtering

Only **Draft** and **Active** products appear in reorder planning. **EOL** and **Archived** products are always excluded — you should be running them down, not reordering them.

### Preferred supplier scoping

When you generate draft POs from reorder planning, the system groups suggestions by each product's **preferred supplier**. One draft PO is created per supplier with all of that supplier's products on it, rather than one giant mixed PO.

Products without a preferred supplier are listed under "Unassigned" and require you to pick a supplier before the draft can be generated. The preferred supplier is auto-updated whenever a PO is sent to a different supplier for that product, so once you start ordering from a new vendor, planning follows you.

### Group by supplier

Tick **Group by supplier** in the filters and press Apply to lay Reorder Planning out supplier by supplier, the way purchase orders are placed. Each group has a header with the supplier, the number of rows and the **total recommended quantity** (the sum of the rows' Suggested qty), followed by that supplier's rows. The page then lists every matching row, not one page at a time, so a supplier's group and total are complete.

- Groups do not merge lead times. Every row keeps its own **Lead time** and **Latest PO date**; only the quantity is totalled.
- Rows with **no supplier** go in a separate amber **No supplier** group at the end, because a draft PO cannot be raised for them. Set a supplier on the product first.
- Manufactured (BOM) products are not bought, so they get their own groups after the suppliers ("Manufactured by ..." or "Manufactured in-house") and are never in the no-supplier group.
- Groups follow the filters. Change the **Warehouse** (or any other filter) and Apply, and the groups and totals are worked out again from the rows that remain.
- Groups use the supplier the report chose for each row. A different supplier picked in a row's own selector, or by the draft PO button, is not reflected until you reload.
- This is a view only. The CSV, the selection boxes and draft PO and production order generation work exactly as before.

## Sales and Fulfillment Analytics

| Report | What it shows |
|---|---|
| **Sales Analytics** | Invoiced sales totals by product, category, customer or channel, with net revenue after credit beside them. The basis is the same on the dashboard, Sales Statistics, Customer Mix, AR Aging and the CSV exports: invoiced revenue counts every order that has an invoice, paid or not, excluding cancelled and draft orders: an order has an invoice when IMS has posted a Xero invoice for it or, during the parallel phase while Xeroom raises the Xero invoices, when it is a WooCommerce order carrying the invoice number Xeroom generated (an invoice number IMS generated itself does not count until the invoice has been posted to Xero); after the switchover IMS posts the invoices itself and the same rule applies. |
| **Customer Mix** | Invoiced and net revenue, gross profit, AR exposure, and concentration by customer. |
| **Gross Margin** | Product margin using posted COGS entries rather than recalculating FIFO, with revenue net of the period's credit. |
| **Returns** | Refund and return activity by SKU, customer, and reason, with same-period shipment context. |
| **Fulfillment KPIs** | Shipment-based fulfillment timing, fill rate, partial shipment rate, and late shipment evidence. |
| **Throughput** | Shipment status activity by user and queue depth for picking, packing, and shipping work. |

Revenue figures honour each order's `taxInclusive` flag: tax-exclusive orders use the line subtotal before VAT; tax-inclusive orders back-calculate revenue by removing VAT from the gross. Mixed-mode batches (some WC orders inclusive, some exclusive) sum correctly without double-counting.

### Refunds in Sales Analytics, Customer Mix and Gross Margin

These three reports **do** deduct credits, but only the credit that is the *same unit* as the figure it is deducted from. A refund's stored total is either NET (ex-VAT), GROSS (VAT-inclusive) or of unproven basis, and the two bases differ by VAT; nothing is converted between them, because on a mixed-rate order the rate that produced a gross figure is not recoverable. Whatever could not be deducted is listed in the credit columns beside the figure, and the figure itself carries a marker: **≤** means the true figure is at most the one shown, and **?** means a bound exists but its direction is not established.

- **Sales Analytics** — Revenue, tax, shipping and discount stay **as invoiced**, so the grand totals still reconcile to sales-order totals. **Net revenue** beside them deducts the gross-basis credit. Rows rank on net revenue.
- **Customer Mix** — Revenue is as invoiced; **net revenue** deducts the gross-basis credit and **share of revenue** is measured on it, so a customer who returned everything no longer ranks on what they originally bought. **Gross profit** is measured on the ex-VAT revenue less the net-basis credit, because COGS is ex-tax — it is *not* revenue minus gross profit. Rows rank on net revenue.
- **Gross Margin** — Revenue is dispatched ex-VAT line revenue less the net-basis credit raised in the period, so a fully credited sale no longer shows its original revenue and margin. Margin and contribution are ratios whose numerator and denominator both move when a credit cannot be placed, so they are marked **?** rather than **≤**. The totals also state any credit that reached no product row, either because the credit line named no product or because that product posted no COGS in the period — **on its basis**, as three separate amounts per case rather than one combined figure, because a net and a gross amount added together are on neither basis. Any such credit, on any basis, makes the period totals bounded even when the credit is the same unit as the figure: it is real credit that no row subtracted. Two credits that cancel do not clear the marker either — opposite amounts on the *same* basis (or of unproven basis) can still be worth different amounts once VAT is taken off them, so what is left unsubtracted is a range rather than a single amount, and where that range straddles zero the figure is marked **?** rather than **≤**.

**Customer Mix withholds gross profit unless the posted cost covers the revenue it is measured against.** Gross profit is compared with the *whole* order's ex-VAT revenue, so the cost has to be complete for that revenue: a customer shows `Withheld` instead of a profit figure where an in-period order has no COGS posted in the period, **or** has not dispatched every ordered *stock* unit within it. The summary says how many customers the period total covers. A missing cost is not a zero cost — counting it as zero published an undispatched order's entire revenue as profit — and a partially dispatched order's cost is not the whole order's cost, which set one shipped unit's cost against ten units' revenue.

A third case reads differently, because it is repaired differently. Where a dispatch carries COGS entries for **more** units than the movement moved, the cell says `Inconsistent` rather than `Withheld` and the report adds a notice that **names the affected customers**, highest-ranked first — the rows are paginated and the count is not, so a notice that only counted could be talking about a customer pages away from the one on screen. Each one is named as `name="…" email="…" customerId="…" group=utf16hex:…`, because a name on its own is not an identifier: two guests can share one, and the stored name can be empty. The first three fields are the Customer cell, the Email cell and the `customerId` column of the CSV export; `group=` is the identity the report actually grouped that row under — **a machine token, not a name**, and the only field that is not there to be read — so two rows that match on the first three are still told apart. A registered customer with no stored email is named `name="Acme Ltd" email=<none> customerId="cust-1" group=utf16hex:0063007500730074002d0031`, and an emailless guest of the same name is `name="Acme Ltd" email=<none> customerId=<none> group=utf16hex:00670075006500730074002d006e0061006d0065003a00410063006d00650020004c00740064` — same first two fields, two different rows. Every present value in the three readable fields is quoted with any inner quote doubled, so a value containing the `; ` that separates entries cannot break the list, and an *absent* value is the unquoted token `<none>`, which no present value can wear because a present value is always quoted. Whitespace and invisible characters inside a value are written out as escapes — `\t`, `\n`, `\u00a0` for a non-breaking space, `\u0020` for a second consecutive space, and a literal backslash doubled — because the notice is rendered as HTML, where a tab, a newline and a run of spaces all collapse to a single space on screen and two customers whose names differ only there would otherwise reach you as one name. `group=` does none of that, because escaping is a losing game one range at a time: it prints **no characters of the name at all**. It is the literal `utf16hex:` followed by four lowercase hex digits for each UTF-16 code unit of the group key, so an emailless guest called 株式会社アクメ is named `name="株式会社アクメ" email=<none> customerId=<none> group=utf16hex:00670075006500730074002d006e0061006d0065003a682a5f0f4f1a793e30a230af30e1`. That is deliberate, and it is the reason the notice carries both a readable half and an identity half: two spellings of one accented name, a Greek and a Cyrillic capital A, and — the case that made the field hex rather than plain ASCII — a capital `O` against a digit `0`, an `l` against a `1`, or an `rn` against an `m`, are different rows that any screen draws identically, and an identity you cannot tell apart is not an identity. Hex has no letter `O`, no `I` and no `l`, and no `m`, `n` or `r`, so none of those pairs can appear in a token; what it does not fix is that `6` and `b`, and in some fonts `1` and `7` or `0` and `8`, are still shapes rather than proofs — so **do not compare two tokens by eye at all**. You do not have to: the row carries the same token. The Customer Mix table has a **Group token** column, where one click selects the whole value, and the CSV export carries it as the `groupToken` column. Copy a token out of the notice and match it against that cell, or join the export on it — that route is exact, and it is the answer to the residue above. The fixed four-digit width and the suppressed ligatures in the notice help anyone who does glance at a token; they are aids and nothing rests on them. For a guest row `customerId` is empty and the readable fields are exactly what can look identical, so `groupToken` is the only column two such rows are guaranteed to differ in. Find the row by reading `name=` and `email=`, which show exactly what the Customer and Email cells show; use `group=` to tell two otherwise identical rows apart, not to read a name off. Past ten names it says how many more there are and points at that export, which is not paginated and carries `costEvidence` on every row. Any excess at all counts, down to the smallest quantity the database can store: the costed-quantity match allows a rounding shortfall, because the FIFO engine leaves one, but nothing above the movement, because the engine cannot produce it. FIFO consumption can never cost more than it moved, so this is not a gap that a later shipment fills — it is contradictory evidence, and it will still be there next period unless somebody corrects the entries.

**Read what that notice claims carefully: it is a statement about quantities.** The check compares the costed quantity with the quantity that moved, and never looks at the money: it reads `CogsEntry.qty` and never `CogsEntry.totalCostBase`. What that leaves is *unmeasured*, and unmeasured in both directions — the report does not establish that any figure summing COGS entries is wrong, and it does not establish that any of them is right. Entries posted twice are the usual explanation for the excess quantity, and even that does not settle the money: a duplicated entry could carry duplicated cost, or none, and the same excess could equally sit on a malformed quantity beside an untouched total. Nor could the report quantify a monetary error for you if there were one — it cannot tell which entries are the spurious ones, so there is no proven figure it could publish. Open the dispatch's COGS entries and compare them with the movement before you change any posted cost.

Non-stock lines are the exception, and deliberately so. A service, a fee or a delivery charge is a `Non-inventory` product: it books no stock movement, so it can never show a dispatch and never posts a cost. Its cost is a known zero rather than an unknown one, so it is skipped, and an order made up only of such lines counts as fully costed at zero — otherwise every order carrying carriage would withhold that customer's profit permanently. A `Variable` parent line is *not* treated that way: goods really do leave for it and can never be traced back to it, so its cost is unknown and the order still withholds.

All of this is stated in each report's own notices and repeated in the CSV export's metadata rows; every bound marker also has its own column in the CSV, and every report-level total — including the bounds on the period figures and the Gross Margin credit that reached no product row — travels with the file as `totals.<name>` metadata rows, because a figure that exists only on the page is a disclosure the file reader never sees. The **COGS Report** carries the same treatment and the same markers (see above); **Inventory Turnover** is a COGS-over-inventory-value ratio that no refund can move.

**Sales Statistics and Product Profitability** use the same rule, so a refunded sale no longer overstates revenue there. In **Sales Statistics**, the **Net Revenue** column and cards deduct the credit that is on the same ex-VAT basis; revenue, tax, shipping and discount stay as invoiced. In **Product Profitability**, the current and previous financial-year revenue and profit are net of that credit. Credit that could not be deducted is shown in the optional **Refunds (gross)** (VAT-inclusive credit) and **Refunds (basis ?)** (basis not recorded) columns, and the affected figure carries **≤**, **≥** or **?** with a tooltip explaining which way it can be wrong. The Product Profitability unit-margin figures (list price against latest cost) are not affected by refunds.

Below the Returns report a **By return reason** table counts refunds and totals their credit per configured return reason (Settings > Inventory), for the same period. A refund counts once however many lines it has, and refunds with no reason are grouped as **Unspecified**. It follows the same basis rule: a reason whose credits mix bases shows the marker instead of one value, with the net, gross and unproven columns alongside.

**Exchanges in the Returns report.** A return recorded with an exchange (see *Exchanges inside a return* in Sales Orders) is shown as returned **and** replaced, not as a lost sale. The report adds **Exchanged** (the returned units whose refund came with an exchange), **Exchanged refund value** (their credit) and **Lost refund value** (the credit that was not exchanged, i.e. the refund that really left), plus **Return rate excl. exchanges**; the summary cards show **Replacement qty** (the units added to the same orders as replacements) next to **Returned qty** and **Exchanged qty**, and the warning-coloured card is the lost refund value. **Refund value (all credit)** is still the whole credit, so the report reconciles to the credit notes. The replacement items sit on the same order, so the order's invoiced total and the revenue reports already include them and the credit note is netted against them as before: nothing else changes in the sales reports. The CSV export carries the same four columns. The lost and exchanged values follow the same basis rule as the rest of the report (a row that mixes bases shows the marker).

The **Returns** report shows each credit on its own recorded basis. Where a row -- or the period -- mixes ex-VAT and VAT-inclusive credits, no single total is shown, because adding the two gives an amount on neither basis; the net-basis, gross-basis and unproven-basis columns carry the whole credit instead, and rows with no single stated value sort last rather than among the zeroes.

## Purchasing and Supplier Analytics

These reports, **Purchase Statistics** (page, data and the `po_*` CSV exports) and the purchasing CSV export are open to Admin, Manager and Finance users only; any other role is sent back to the dashboard.

| Report | What it shows |
|---|---|
| **Open POs** | Purchase orders not fully received, including expected dates, overdue flag, outstanding quantity/value, supplier, and days since sent. |
| **Supplier Performance** | On-time delivery, received-versus-ordered quantity variance, actual lead time, and supplier-level performance. |
| **Purchase Price Variance** | Actual received cost compared with the prior received PO line for the same supplier/SKU. |
| **Spend** | Received purchase-order spend by supplier, category, and month. |
| **Lead Times** | Actual receipt lead-time distribution and P50/P95 metrics that feed reorder planning when supplier lead time is missing. |

During the parallel phase an order with a WooCommerce (Xeroom) invoice number counts as invoiced; IMS does not check that Xeroom's post to Xero succeeded.

What is owed on an order is worked out once, the same way on AR Aging, Customer Aging and the Invoices tab: the invoice total less credit notes less receipts, all in the base currency (a payment is converted at its stored settlement rate, otherwise at the order's booked rate), as of the report date. An order marked as paid counts as settled from that date (any part not covered by a recorded payment is treated as received off-ledger), a stored payment rate is read as foreign units per one base unit, cash paid back out puts the money back on the receivable, and a paid order that was credited shows as a customer credit balance. Where a credit could not be placed exactly the balance is marked ≤ or ≈. The Currency Summary uses the same balance for its base receivable; its foreign receivable is that base balance scaled by the order's booked foreign-to-base ratio.

Reports that are bounded by invoice date (the Sales Statistics invoice list, the currency summary and AR Aging) date an order by its invoice date when IMS has one, otherwise by the date it was paid, and only then by the order date (shown as approximate, with a notice on the report and a column in the CSV). Orders invoiced by Xeroom carry an invoice number but no invoice date in IMS; Xeroom issues the invoice as the order is paid, so the paid date is the closest date IMS holds. The VAT report is not affected: it keeps its own invoice-date tax point.

The Gross Margin and COGS reports use the same invoiced orders for revenue and credit. A dispatch of an order that has no invoice yet keeps its cost, but no revenue or credit is counted against it, and its COGS row reads Unmatched.

## Finance Period-End Analytics

| Report | What it shows |
|---|---|
| **VAT** | Output and input VAT by side / reporting category / jurisdiction / tax rate, for invoiced non-cancelled sales orders and purchase-invoice lines in the selected period. |
| **AR Aging** | Outstanding balances on invoiced sales orders (the same invoiced basis and invoice date as the revenue reports, so drafts, cancelled orders and orders with no invoice are not receivables) by customer and aging bucket (Current / 1–30 / 31–60 / 61–90 / 90+). |
| **AP Aging** | Outstanding purchase-invoice balances by supplier and aging bucket. |
| **Currency Summary** | Sales, purchases, AR and AP grouped by document currency, with foreign and base-currency totals. |
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

The **Reorder Forecast** page has been retired; use [Reorder Planning](#reorder-planning).

New report families under `/analytics/*` are the preferred source for production-readiness reporting because they expose clearer provenance, RBAC, CSV exports, and reconciliation notices.

## Training Data for Forecasting

Historical demand can still be imported for forecasting, from the **Import history** button on Reorder Planning (Admin and Manager). The import creates demand records only and does not change stock levels; it runs in the background, so you can close the dialog and carry on.

- **WooCommerce import** — bulk import past WooCommerce orders by date range. A progress indicator shows real-time import status including pages processed and orders imported.
- **CSV import** — upload historical sales data (columns `sku, qty, date`, date as YYYY-MM-DD, one row per line item sold) for products not covered by WooCommerce.
- **Data retention** — demand records older than the retention period (months) set in the same dialog are purged automatically.


## Troubleshooting

| Problem | Where to look |
|---|---|
| Report CSV contains only a `REPORT NOT COMPUTED` row | The report hit its source-row cap. Narrow date range or apply more filters — see [Source-row cap](#source-row-limits) |
| CSV export returns 413 Payload Too Large | The report computed, but the file would exceed the export's separate output-row cap (50,000 rows for most exports, 100,000 for Inventory Costing and the inventory ledger). This is not the source-row limit above. Narrow date range or apply more filters |
| Revenue doesn't match invoice total | Check the order's `Tax Inclusive` flag |
| Reorder planning missing a product | Check lifecycle status (EOL/Archived are always excluded), and whether it is below its reorder point; tick **Show all products** to list the rest |
| Draft PO has wrong supplier | A preferred supplier was auto-updated by a recent PO; edit on the product page |
| Inventory valuation shows no GL variance | Account-balance snapshots haven't been ingested from the accounting connector yet |
| FX rate looks stale | FX rates auto-fetch via cron — see [Troubleshooting](troubleshooting.md) for cron status |
