# Xero Accounting Sync

One Two Inventory integrates with Xero to keep your accounting records in sync. The system acts as a **sub-ledger** — Xero handles invoicing, payments, and bank reconciliation, while the IMS creates daily correction journals to control when revenue is recognised and how inventory flows through your accounts.

## Connection Setup

1. Enable the Xero plugin under **Settings > System > Plugins** if it is not already enabled
2. Go to **Integrations → Xero** and enter your Xero app **Client ID** and **Client Secret**
3. Click **Connect to Xero** — you'll be redirected to Xero to authorise the connection
4. Once connected, click **Sync Chart of Accounts** to pull your Xero account list
5. Map each IMS transaction type to the correct Xero account (see Account Mapping below)
6. Enable **Xero Sync** and save settings

Before connection or sync can be enabled, the Xero organisation base currency must match the IMS base currency configured in **Settings > Company**.

## Account Mapping

| IMS Account | Xero Account Type | Purpose |
|---|---|---|
| Sales Revenue | Revenue | Income from sales invoices |
| Shipping Income | Revenue | Shipping charges on sales |
| Discounts Given | Revenue / Expense | Order-level discounts |
| Purchases | Direct Cost | Default account for purchase bills |
| Stock in Transit | Asset | Goods ordered but not yet received |
| Inventory Asset | Asset | Stock on hand (available) |
| Allocated Inventory | Asset | Stock reserved for paid orders awaiting dispatch |
| Cost of Goods Sold | Direct Cost | COGS booked when goods ship |
| Unearned Revenue | Liability | Revenue deferred until goods ship |

## How Sync Works — Flowchart

The flowchart below shows every path an order can take through the Xero sub-ledger, from payment through to shipment. The daily batch runs Groups A1 → A2 → B in sequence each night.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ORDER RECEIVED                              │
│                  (WooCommerce or Manual)                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
              ┌────────────────────────┐
              │  Invoice Created in    │
              │  Xero (AUTHORISED or   │
              │  DRAFT)                │
              └────────────┬───────────┘
                           │
              ┌────────────┴───────────┐
              │                        │
              ▼                        ▼
    ┌──────────────────┐     ┌──────────────────┐
    │  WooCommerce     │     │  Manual Order    │
    │  (pre-paid)      │     │  (DRAFT invoice) │
    │                  │     │                  │
    │  • AUTHORISED    │     │  • Payment       │
    │    invoice       │     │    polling every  │
    │  • Payment auto- │     │    15 min detects │
    │    registered    │     │    Xero bank feed │
    │  • paidAt set    │     │    match          │
    │    immediately   │     │  • paidAt set     │
    └────────┬─────────┘     └────────┬─────────┘
             │                        │
             └──────────┬─────────────┘
                        │
                        ▼
           ┌─────────────────────────┐
           │  ORDER IS PAID          │
           │  (paidAt is set)        │
           └────────────┬────────────┘
                        │
          ┌─────────────┴─────────────┐
          │                           │
          ▼                           ▼
┌───────────────────┐      ┌───────────────────┐
│  Stock Available  │      │  Backorder        │
│  (can allocate)   │      │  (no stock)       │
└────────┬──────────┘      └────────┬──────────┘
         │                          │
         ▼                          │
  ══════════════════                │
  ║ DAILY BATCH A1 ║◄──────────────┘
  ║ Revenue        ║   (applies to ALL paid orders)
  ║ Deferral       ║
  ══════════════════
  DR Sales Revenue
  CR Unearned Revenue
  (pull back auto-recognised revenue)
         │
         │                          │
         ▼                          │
  ┌──────────────┐                  │
  │  Stock        │                  │
  │  allocated?   │                  │
  └──────┬───────┘                  │
    Yes  │                          │ No (backorder waits)
         │                          │
         ▼                          │
  ══════════════════                │
  ║ DAILY BATCH A2 ║                │
  ║ Inventory      ║                │
  ║ Reclassify     ║                │
  ══════════════════                │
  DR Allocated Inventory            │
  CR Inventory Asset                │
  (reserve stock for this order)    │
         │                          │
         │        ┌─────────────────┘
         │        │
         │        ▼
         │  ┌───────────────────┐
         │  │  PO Received →    │
         │  │  Auto-allocate    │
         │  │  → Next batch     │
         │  │    picks up A2    │
         │  └───────────────────┘
         │
         ▼
  ┌──────────────┐
  │  Order ships │
  │  (one or     │
  │  more        │
  │  shipments)  │
  └──────┬───────┘
         │
         ▼
  ══════════════════
  ║ DAILY BATCH B  ║
  ║ Shipment       ║
  ║ Recognition    ║
  ══════════════════
  DR Unearned Revenue    (recognise revenue)
  CR Sales Revenue
  +
  DR COGS                (book cost of goods)
  CR Allocated Inventory
  (FIFO cost layers consumed)
         │
         ▼
  ┌──────────────────┐
  │  ORDER COMPLETE  │
  │                  │
  │  Revenue = Sales │
  │  COGS = Cost     │
  │  Inventory = 0   │
  │  Unearned = 0    │
  └──────────────────┘
```

## Sync Cases in Detail

### Case 1: WooCommerce Order (stock available, same-day ship)

This is the most common case. The customer pays via WooCommerce, stock is available and allocated, and the order ships quickly.

| Step | What Happens | Xero Journal |
|---|---|---|
| WC order syncs | AUTHORISED invoice created, payment registered | Invoice + Payment |
| Daily batch A1 | Revenue deferred (money received, goods not yet shipped) | DR Sales / CR Unearned Revenue |
| Daily batch A2 | Stock reclassified (reserved for this order) | DR Allocated / CR Inventory |
| Order ships | Stock dispatched, cost layers consumed | — |
| Daily batch B | Revenue recognised, COGS booked | DR Unearned / CR Sales + DR COGS / CR Allocated |

### Case 2: WooCommerce Order (backorder — no stock)

The customer pays but the item is out of stock. Revenue is deferred immediately, but inventory reclassification waits until stock arrives.

| Step | What Happens | Xero Journal |
|---|---|---|
| WC order syncs | AUTHORISED invoice, payment registered, no stock to allocate | Invoice + Payment |
| Daily batch A1 | Revenue deferred immediately | DR Sales / CR Unearned Revenue |
| *Time passes...* | Waiting for stock | — |
| PO received | Stock arrives, IMS auto-allocates the order | — |
| Daily batch A2 | Stock now allocated, reclassified | DR Allocated / CR Inventory |
| Order ships | Stock dispatched | — |
| Daily batch B | Revenue recognised, COGS booked | DR Unearned / CR Sales + DR COGS / CR Allocated |

### Case 3: Manual Order (invoice-first)

A manual order is created in the IMS. A DRAFT invoice is pushed to Xero. Payment is detected when the customer pays via bank transfer and the bank feed matches.

| Step | What Happens | Xero Journal |
|---|---|---|
| Order created | DRAFT invoice in Xero | Invoice (DRAFT) |
| Customer pays | Bank feed matches in Xero | — |
| Payment poll | IMS detects paid invoice, sets paidAt, advances status | — |
| Daily batch A1 | Revenue deferred | DR Sales / CR Unearned Revenue |
| Allocate + ship | Normal flow from here | A2 then B |

### Case 4: Partial Shipment (multi-warehouse)

An order is split across two warehouses. Each shipment is processed independently in Group B, with revenue proportioned by line value.

| Step | What Happens | Xero Journal |
|---|---|---|
| Order paid + allocated | Split across Warehouse A and Warehouse B | A1 + A2 |
| Shipment 1 ships | Warehouse A portion | — |
| Daily batch B | Revenue + COGS for Shipment 1's proportion | Partial DR Unearned / CR Sales + DR COGS / CR Allocated |
| Shipment 2 ships | Warehouse B portion | — |
| Daily batch B | Remaining revenue + COGS | Remaining DR Unearned / CR Sales + DR COGS / CR Allocated |

### Bundle / Kit note

For Kit / Bundle sales, the accounting flow still follows the shipment rows. COGS is derived from the underlying component cost layers consumed by the shipment lines, and refunds reverse those component-level COGS entries when stock is returned.

## Refund Handling

Refunds create a Xero credit note in all cases. Additional reversal journals depend on how far the order progressed through the sub-ledger:

| Order State | What Gets Reversed |
|---|---|
| Paid but not yet batched (A1 not run) | Credit note only — no journals to reverse |
| Revenue deferred, not allocated (backorder) | Credit note + DR Unearned Revenue / CR Sales |
| Allocated but not shipped | Credit note + DR Unearned / CR Sales + DR Inventory / CR Allocated |
| Partially or fully shipped | Credit note + DR Inventory / CR COGS (shipped portion) + unearned reversal (unshipped portion) |

## Transaction Types

Configure which documents are synced to Xero under **Integrations → Xero → Transaction Types**. Each type can be set to **Off**, **Draft**, or **Submitted** (AUTHORISED in Xero):

| Type | Description |
|---|---|
| Sales Invoices | Push invoices to Xero when an order is created |
| Credit Notes | Push credit notes on refund |
| Purchase Bills | Push supplier bills when a PO is invoiced |
| Stock Receipts | Journal: DR Inventory / CR Stock in Transit on goods received |
| COGS Reversals | Reverse COGS on stock returns |
| Inventory Adjustments | Journal for manual stock adjustments |
| Manufacturing Journal | Capitalise per-run overhead (labour, machine, etc.) on assembly/disassembly: DR Inventory / CR Manufacturing Overhead. Includes the retro-recalc reclass (`MANUFACTURING_RECLASS`) when cost lines are edited after completion. |

## Multi-Currency FX Rates

Every sales invoice, purchase bill and credit note pushed to Xero is stamped with a `CurrencyRate` derived from the `fxRateToBase` value already stored on the source IMS document (SalesOrder, PurchaseOrder, SalesOrderRefund). This stops Xero from substituting its own daily XE rate, which previously caused 1–3 % drift between IMS base totals and Xero base totals on the same multi-currency document.

**Rate flow:**

```
frankfurter.dev (ECB) → /api/cron/fx-rates → FxRate table
       ↓
fxRateToBase stamped on SalesOrder / PurchaseOrder / SalesOrderRefund at creation
       ↓
queueAccountingSync() includes currencyRateToBase in the payload
       ↓
Xero adapter inverts to Xero's convention (1 doc-ccy = X base) at 6dp
       ↓
CurrencyRate sent on Invoice / Bill / CreditNote API call
```

**Direction conventions:**

- **IMS** stores `fxRateToBase` as: 1 base = X doc-currency (e.g. base GBP, doc EUR ⇒ 1 GBP = 1.18 EUR).
- **Xero** `CurrencyRate` is: 1 doc-currency = X base. The connector inverts (`1 / fxRateToBase`) and rounds to 6dp to match Xero's `Decimal(18,6)` schema.

**What's covered:**

| Path | FX rate stamped? |
|---|---|
| WooCommerce order import | Yes — `currencyRateToBase` set from the FX rate looked up at import time |
| Manual sales invoice (DRAFT → finalised) | Yes — read from `SalesOrder.fxRateToBase` |
| Sales credit note (refund) | Yes — read from the txn-level FX rate computed for the refund |
| Purchase invoice (PO → bill) | Yes — read from the PO's `fxRateToBase` at invoice time |
| Same-currency invoices (rate = 1) | `CurrencyRate = 1` is sent (still explicit, so Xero never falls back to its own rate) |
| Missing/zero/invalid rate | Field is omitted; Xero's default applies (logged as a fallback case) |

**Connector-agnostic design:** the optional `currencyRateToBase` field is on the generic `InvoiceData` / `BillData` / `CreditNoteData` types (`lib/connectors/types.ts`). Each accounting connector decides how to translate it. Xero sends the inverse form (`1 / x`) as `CurrencyRate`; QuickBooks also inverts the IMS rate before setting `ExchangeRate`, rounded to the connector's supported precision.

**Downstream push to WooCommerce.** With the **onetwoInventory Helper** WordPress plugin installed and "Push FX rates daily" enabled in the IMS WC sync page, the same rates are also pushed to the WC store after each daily fetch. Aelia Currency Switcher (and any plugin reading the `wc_aelia_currencyswitcher_exchange_rate` filter) then converts cart prices using the IMS rate, so the storefront, IMS, and Xero all see the same exchange rate on the same order. See `docs/woocommerce.md` § onetwoInventory Helper WordPress plugin for installation steps.

**Manual overrides and push log.** Settings → Accounting → **FX Rates** shows the current rate per currency, with a source badge (`ECB (frankfurter)` or `Manual override`). Pin a manual rate via the pencil icon — the daily fetch will then skip that currency until the override is cleared (the undo icon re-fetches from frankfurter). The same panel includes a recent-pushes table (one row per fan-out attempt to a shopping connector) so you can see whether the latest push to WooCommerce succeeded.

The full unified-FX rollout plan is tracked in `docs/todo/unified-fx-rates-plan.md`.

## Sub-Ledger Settings

### Daily Batch Sync

When enabled, the nightly cron job runs three groups in sequence:

- **Group A1 — Revenue Deferral**: Any paid order that hasn't been deferred yet. Prevents Xero from showing inflated revenue before goods ship.
- **Group A2 — Inventory Reclassification**: Allocated orders only. Moves stock value from Available to Allocated on the balance sheet.
- **Group B — Shipment Recognition**: Per-shipment. Recognises revenue and books COGS using FIFO cost layer consumption.

### Payment Polling

When enabled, the IMS polls Xero every 15 minutes for:

- **Paid sales invoices** (manual orders only — WC orders arrive pre-paid)
- **Paid purchase bills** (all POs — detects when a bill is paid via bank feed)

## Invoice PDF & Email

When a sales invoice is synced to Xero and payment is registered:

1. The Xero invoice PDF is downloaded and saved locally
2. The PDF is emailed to the customer with a branded email template
3. A signed download link is pushed to the WooCommerce order as a customer-visible note
4. An admin-only note with a "View in Xero" link is added to the WC order

Invoice PDFs are accessible via a signed URL: `/api/invoices/[orderId]?token=<hmac>`. The token is generated using HMAC-SHA256 and verified with timing-safe comparison.

## Xero Deep Links

When an order or purchase invoice has been synced to Xero, a **View in Xero** link appears on the detail page:

- **Sales orders**: Links to `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=...`
- **Purchase orders**: Links to `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=...`

## Payment Method Mapping

The IMS maps payment methods to Xero bank accounts using a composite key of `{method}:{currency}`. This allows different bank accounts for different payment processors and currencies:

- `stripe:BASE` → Stripe clearing account in the IMS/Xero base currency
- `stripe:EUR` → Stripe EUR clearing account
- `paypal:BASE` → PayPal account in the IMS/Xero base currency
- `bank-transfer:BASE` → Primary bank account in the IMS/Xero base currency

Configure this mapping in **Integrations → Xero → Payment Account Mapping**.

## FIFO Cost Layers

Group B of the daily batch consumes FIFO (First In, First Out) cost layers when booking COGS. Each shipment line decrements `remainingQty` on the oldest cost layers first. This ensures COGS reflects the actual purchase cost of the specific units shipped.

## Cron Endpoints

| Endpoint | Schedule | Purpose |
|---|---|---|
| `/api/cron/accounting-sync` | Every 5 min | Process pending accounting sync entries (invoices, journals) |
| `/api/cron/accounting-daily-batch` | Daily (midnight) | Run sub-ledger Groups A1, A2, B |
| `/api/cron/accounting-payment-poll` | Every 15 min | Detect paid invoices and bills in the active accounting connector |

All cron endpoints require the `CRON_SECRET` bearer header in production.

## Sync Log

The sync log at **Integrations → Xero** shows all queued transactions with their status:

- **Pending** — Queued, waiting for next cron run
- **Synced** — Successfully pushed to Xero (shows Xero transaction ID)
- **Failed** — Failed after 5 retries (shows error message)

Failed entries can be investigated via the error message and retried by resetting their status in the database.
## Xero Daily Batch Retry Semantics

The daily batch intentionally processes A1 revenue deferral, A2 inventory allocation, and Group B shipment recognition in separate database transactions. A crash can therefore leave a partially advanced day, but each group is idempotent:

- A1 selects orders with `revenueDeferredDate = null` and writes `DAILY_BATCH_REVENUE_DEFERRAL` plus per-order deferral markers in one transaction.
- A2 selects orders with revenue deferred but `inventoryAllocatedDate = null`, snapshots allocation FIFO layers, writes `DAILY_BATCH_INVENTORY_ALLOC`, and marks allocation state in one transaction.
- Group B selects shipped shipments with `shipmentJournalDate = null` after A1/A2 are staged, writes `DAILY_BATCH_GROUP_B`, and marks shipment recognition in one transaction.

Retry behavior is marker-driven. If the process stops after A1, the next run skips A1-marked orders and continues with A2. If it stops after A2, the next run continues with Group B. If Group B partially fails, unmarked shipments remain eligible for the next run. Do not manually clear these dates unless finance has also reversed any exported journals.
