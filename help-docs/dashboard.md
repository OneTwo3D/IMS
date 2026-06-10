# Dashboard

The dashboard gives you a real-time snapshot of business performance. It combines financial KPIs, trend charts, and operational summaries on a single page.


## KPI Cards

Four headline figures appear at the top of the dashboard:

| KPI | What It Measures |
|---|---|
| **Gross Sales** | Total invoiced revenue before any deductions. |
| **Net Sales** | Gross sales minus discounts, returns, and adjustments. |
| **COGS** | Cost of goods sold, calculated from FIFO cost layers. |
| **Margin** | Net sales minus COGS, shown as both a value and a percentage. |

Each card shows the current period value, the comparison period value, and the percentage change between them.


## Time Period Selector

Choose which period the dashboard reports on. The following options are available:

- Today
- This Week
- This Month
- This Quarter
- This Year
- This Financial Year
- Last 7 Days
- Last 30 Days
- Last 90 Days
- Last 365 Days
- Custom date range


## Comparison Periods

Compare the selected period against a prior period to spot trends:

- **Previous Period** -- The equivalent duration immediately before the selected period.
- **Previous Year** -- The same dates one calendar year earlier.
- **Previous Financial Year** -- The same dates one financial year earlier.


## Charts

### Net Sales, COGS, and Margin %

Three time-series charts track net sales, cost of goods sold, and margin percentage over the selected period. The horizontal axis adapts its granularity automatically:

- **Hourly** -- When viewing a single day.
- **Daily** -- When viewing a week or month.
- **Monthly** -- When viewing a quarter, year, or longer.

### Cash Bridge

A waterfall chart showing how cash flows from opening balance through inflows and outflows to the closing balance. This helps you understand where money is coming from and where it is going.


## Best Sellers

A ranked list of your top-selling products for the selected period, showing quantity sold and revenue generated.


## Incoming Purchase Orders

A summary of open purchase orders that have stock on the way, so you can see what is due to arrive.


## Operational KPIs

Quick-reference metrics covering:

- Total products in catalogue
- Low-stock alerts
- Orders awaiting fulfilment
- Purchase orders awaiting receipt


## Recent Orders

A feed of the latest sales orders, showing order number, customer, total, and status. Click any order to open its detail page.


## System Health Card

A live health indicator visible to administrators only. It surfaces:

- **Integration status** — green/amber/red for WooCommerce, Xero, Mintsoft, and SMTP. Amber means the connection-test gate has not been satisfied (credentials saved but never verified); red means the last sync failed.
- **Cron status** — last run timestamp and result for each scheduled job (FX rates, WC sync, Xero daily batch, backup, activity cleanup). A job that hasn't run within its expected interval is flagged red.
- **Backup status** — date and size of the most recent successful backup, plus a warning if the manifest sidecar is missing or stale.
- **Invariant check** — count of any open inventory invariant findings (negative stock, cost-layer integrity, allocation drift). Click through to the full report under **Settings > System**.
- **Pending FX queue** — number of WooCommerce orders waiting for a missing FX rate before they can be synced to Xero.

When the card is fully green, day-to-day operations are healthy. Any non-green status is a prompt to investigate before it cascades — see [Troubleshooting](troubleshooting.md) for first-stop fixes.
