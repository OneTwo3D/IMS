# Dashboard

The dashboard gives you a real-time snapshot of business performance. It combines financial KPIs, trend charts, and operational summaries on a single page. It opens on **This Month** compared with the **Previous Period**. Dates and times on it are shown in the organisation's time zone (Settings > Company), so everyone sees the same day boundaries.

Administrators who have not finished or dismissed the guided setup also see a **Welcome** banner at the top; see the [Onboarding Walkthrough](onboarding-walkthrough.md). Supplier users never see the dashboard: they land on the supplier portal.


## KPI Cards

Four headline figures appear at the top of the dashboard:

| KPI | What It Measures |
|---|---|
| **Gross Sales** | Total invoiced revenue before any deductions. |
| **Net Sales** | Gross sales minus discounts and returns, where the return is recorded excluding VAT. |
| **COGS** | Cost of goods sold, calculated from FIFO cost layers. |
| **Margin** | Net sales minus COGS, shown as both a value and a percentage. |

Each card shows the current period value, the comparison period value, and the percentage change between them.

### Figures marked with a symbol

Net sales is built from amounts that exclude VAT, so only a return that was also recorded excluding
VAT can be subtracted from it. Older returns were recorded including VAT, and some cannot be proved
either way. Those are **not** subtracted and are **not** converted -- converting needs the VAT rate
that produced the original figure, which a mixed-rate order does not preserve. Instead the amount is
reported separately, under "Not subtracted", and the figures derived from net sales are marked:

| Mark | Meaning |
|---|---|
| (no mark) | Every return in the period could be subtracted. The figure is exact. |
| `<=` | The true figure is **at most** this one. It is too high by at most the "Not subtracted" amount. |
| `?` | A bound exists, but **which side of this figure the true one falls is not established.** |

The `?` mark appears only on **Margin %**. Margin is a ratio, and an unsubtracted return reduces
both the top and the bottom of it, so -- unlike net sales, profit and average order value, which can
only fall -- the margin can move either way. Where the arithmetic cannot settle the direction, the
percentage is still shown and only the claim about its direction is withheld.

The percentage-change badges show a dash instead of a direction whenever either period carries an
unsubtracted return, because the two periods withhold different amounts and the sign of the change
is not established.


## Time Period Selector

Choose which period the dashboard reports on. The following options are available:

- Today
- This Week
- This Month
- This Quarter
- This Year
- Financial Year
- Last 7 Days
- Last 30 Days
- Last 90 Days
- Last 365 Days
- Custom Range (choose a start and end date and click **Apply**)


## Comparison Periods

Compare the selected period against a prior period to spot trends:

Pick the comparison from the second selector:

- **vs Previous Period** -- The equivalent duration immediately before the selected period.
- **vs Previous Year** -- The same dates one calendar year earlier.
- **vs Previous FY** -- The same dates one financial year earlier.


## Charts

### Net Sales, COGS, and Margin %

Three time-series charts track net sales, cost of goods sold, and margin percentage over the selected period. Hover any point to see its value; where that bucket carries an unsubtracted return the tooltip states the bound, using the same marks as the KPI cards above. The horizontal axis adapts its granularity automatically:

- **Hourly** -- When viewing a single day.
- **Daily** -- When viewing a week or month.
- **Monthly** -- When viewing a quarter, year, or longer.

### Cash Bridge

A bar chart that walks from sales to profit for the selected period: **Gross Sales**, less **Discounts**, less **Refunds**, giving **Net Sales**, less **COGS**, leaving **Margin** (the profit in money, not the percentage). It is a sales-to-margin bridge, not a bank balance: it does not show cash held. The Net Sales and Margin bars carry the same `<=` and `?` marks as the KPI cards when a return could not be subtracted.


## Best Sellers

A ranked list of your top five selling products for the selected period, showing quantity sold net of returns, the product's margin percentage and the revenue generated. **View all** opens the full sales statistics report.

Revenue here is net of returns on the same terms as the KPI cards: a credit recorded ex-VAT is subtracted, and a credit recorded VAT-inclusive or with no recorded basis is *not* -- subtracting it would remove VAT from a figure that never contained any. Where that happens the amount carries a `≤` and hovering it names the credit that was left out. Because the list is ranked by that same figure, the **order** carries the bound too: a product can sit above another purely on credit that could not be placed, and the tooltip says so.

Quantity is not affected by any of this -- a returned unit is a returned unit whatever unit the money was recorded in -- so "sold net" is exact and never marked.


## Incoming Purchase Orders

The next five open purchase orders that have stock on the way, soonest expected delivery first, each with its supplier, number of lines, total and expected delivery date. A date in the past is marked **(late)** in red, one within three days is shown in orange, and an order with no date shows **No ETA**. **View all** opens the purchase order list. Shipped orders stay on this card until they are received.


## Operational KPIs

A row of six small tiles under the charts:

| Tile | What it shows |
|---|---|
| **Open Orders** | Sales orders still being worked (draft, pending payment, processing, allocated, picking or packing) and their value. |
| **Open POs** | Purchase orders with stock still to arrive, and the value of what is outstanding on them. |
| **Inventory Value** | Value of stock on hand from FIFO cost layers, and the number of active products. |
| **Low Stock** | Products with 1 to 5 units available, and beneath it how many are out of stock. |
| **Shipping** | Shipping charged in the selected period. |
| **Comp. Orders** | The number of orders in the comparison period, with its net sales beneath (marked when a return could not be subtracted). |

## Recent Orders

A feed of the ten latest sales orders, showing order number, customer, total, status and date. Click any order to open its detail page; **View all** opens the sales order list.


## Checking integration and system health

The dashboard has no health card. Look in these places instead:

- **Integrations** (sidebar) shows the state of each connected service (the online store, accounting, the warehouse), with banners for failed syncs and a sync exceptions queue. This is where to check whether a connection test has passed or the last sync failed.
- **Activity** (sidebar) lists the errors and warnings raised by syncs and background work.
- **Settings > Accounting > FX Rates** shows the exchange-rate refresh status.

When something looks wrong, see [Troubleshooting](troubleshooting.md) for first-stop fixes.
