# Xero Accounting Sync

One Two Inventory integrates with Xero to keep your accounting records in sync. The system acts as a **sub-ledger** — Xero handles invoicing, payments, and bank reconciliation, while the IMS creates daily correction journals to control when revenue is recognised and how inventory flows through your accounts.

## Connection Setup

1. Enable the Xero plugin under **Settings > System > Plugins** if it is not already enabled
2. Go to **Integrations → Xero** and enter your Xero app **Client ID** and **Client Secret**
3. Click **Connect to Xero** — you'll be redirected to Xero to authorise the connection
4. Once connected, click **Sync Chart of Accounts** to pull your Xero account list
5. Map each IMS transaction type to the correct Xero account (see Account Mapping below)
6. **Click "Test Connection"** — sync remains disabled until you successfully run the test. The system stores a fingerprint of the saved credentials at test time; if you later change them, you must re-test.
7. Enable **Xero Sync** and save settings

Before connection or sync can be enabled, the Xero organisation base currency must match the IMS base currency configured in **Settings > Company**.

### How to get your Xero Client ID and Secret

The Client ID and Client Secret come from a **Xero app** you create in the Xero Developer portal:

1. Sign in at <https://developer.xero.com/app/manage> with your Xero account.
2. Click **New app**.
3. Choose the **Web app** (OAuth 2.0 / Auth code) integration type.
4. Enter a **Company or application name** (e.g. "One Two Inventory") and your company URL.
5. Set the **OAuth 2.0 redirect URI** to your IMS callback — `https://<your-ims-domain>/api/accounting/callback` (it must match exactly, including https). On this install that is shown next to the field in the connection form.
6. Create the app, then open its **Configuration** page.
7. Copy the **Client id**.
8. Click **Generate a secret** and copy the **Client secret** — it is shown **only once**, so copy it before leaving the page.
9. Paste both into the IMS connection form, then click **Connect to Xero** to authorise.

Official guide: <https://developer.xero.com/documentation/getting-started-guide/>

Like other integrations, Xero sync is gated behind a successful connection test. The fingerprint includes the Client ID, expected tenant ID, and authenticated tenant ID/name. If you rotate the Client Secret or re-authorise to a different Xero tenant, re-test before activating sync.

### Permissions (scopes), and why a reconnect is sometimes required

When you authorise IMS, Xero grants a fixed set of **permissions** — invoices, contacts, payments,
manual journals, attachments, settings. **That grant is frozen at the moment you connect.** Refreshing
the access token does not widen it: a refreshed token carries exactly the permissions the original
consent screen granted.

So when a new IMS release needs a permission an older connection never granted, the syncs that need it
fail — and *only* those. Everything else keeps working, which is what makes it hard to spot. This is
not hypothetical: the `accounting.payments` permission was added for payment registration, and on
connections made before it, every invoice and bill was posted and marked paid in IMS while Xero never
recorded the payment at all.

IMS now records what Xero actually granted and checks it before running a sync that needs a particular
permission:

- The **Sync** tab shows a **"Reconnect required"** warning naming the missing permission(s).
- Affected rows fail with `REQUIRES RECONNECT: …`, naming the permission and stating that **nothing was
  sent** — instead of a bare `401 AuthorizationUnsuccessful` that could be any of a dozen causes.
- The fix is always the same: **Reconnect** on the Connection tab and approve the consent screen. Then
  retry the failed rows from the **Logs** tab.

A connection made before IMS started recording grants has no record of its permissions. Those are
treated as *unknown*, not as *missing* — nothing is blocked, and the record fills in on the next
reconnect. QuickBooks connections do not record grants and never show this warning.

### Disconnecting

Disconnecting removes the stored token **and forgets every Xero ID the IMS had cached** — the Xero
contact ID on each customer/supplier and the Xero item ID on each product. This is deliberate: those
IDs only mean anything to the organisation that issued them, so keeping them would hand stale IDs to
the next connection. After reconnecting (to the same org or a different one, or when switching to
QuickBooks) the IDs are simply resolved again on first use. Nothing needs to be re-entered.

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

> These cases are verified end-to-end (Woo stage → IMS → Xero Demo, read back from the Xero
> API) by the full-chain E2E tier, `e2e/full-chain/order-to-cash.spec.ts`: **Case 1** ≈ OC-01
> (paid order → ship → ACCREC invoice), **Case 2 / Case 4** ≈ OC-02 (under-stocked order ships
> the available units yet invoices the full order), and the shipping/fee line breakdown ≈ OC-11.
> See [`docs/ops/full-chain-e2e-runbook.md`](ops/full-chain-e2e-runbook.md).

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
- **Reversed payments** on either (payment removed or invoice voided — clears `paidAt`)

All four checks are answered by a **single** request that asks Xero only for invoices changed since
the last successful poll, using the `If-Modified-Since` header. The poll advances its cursor only
when it succeeds, and deliberately re-reads the last couple of minutes each time, so a payment can
be seen twice but never skipped — acting on one twice is a no-op.

**Very large windows drain in pieces.** If more than 2,000 invoices changed since the last poll —
usually a bulk operation in Xero, or a cursor left far in the past — the window is too big to read in
one go. Rather than give up, the poll splits it into bounded time slices, processes them oldest-first
and saves its position after each one, up to four slices per run. The activity log records
*"processed N bounded chunk(s) of an oversized delta"* and the remainder is picked up by the next
poll, so a backlog clears itself over the following runs with nothing skipped.

The one case it cannot split is more than 2,000 invoices carrying the **same second** of
`UpdatedDateUTC`, because Xero's date filters only go down to whole seconds. Everything before that
second is processed and saved; the poll then stops with an error naming the timestamp, so no invoice
is ever stepped over unread. That needs a look at what happened in Xero at that moment.

### Payment Reconciliation (backlog sweep)

Payment polling only ever looks at invoices Xero reports as **changed since the last poll**. That
leaves two things it structurally cannot catch: an invoice paid long ago and never touched since, and
an invoice Xero marked paid *before* the IMS had recorded its link. A separate **daily** job closes
both gaps by working from the other direction — it starts from every IMS document that carries a Xero
invoice id and asks Xero each one's current status directly.

By default it is **report-only**: it records what it found in the activity log without changing
anything. Two things surface:

- **Missed payments** — the invoice is PAID in Xero but the order/bill is still unpaid in the IMS.
- **Suspect advances** — the IMS treats a document as paid (or has moved an order on as if it were),
  but Xero says its invoice is not actually paid. These are flagged for a person to review and are
  **never** changed automatically, because a genuine later reversal looks the same and only a human
  can tell them apart.

To have the sweep also **collect** the missed payments (mark them paid, advance and allocate the
order exactly as the poll would), set **`xero_payment_reconcile_apply`** to `true`. Leave it off
until you have reviewed a report or two. You can also run it on demand:

```bash
npx tsx --env-file=.env scripts/reconcile-xero-payments.ts           # report only
npx tsx --env-file=.env scripts/reconcile-xero-payments.ts --apply   # collect missed payments too
```

### Purchase Bill Edits

Unpaid purchase bills can be edited from the purchase order detail page. IMS updates the local
`PurchaseInvoice` and `PurchaseInvoiceLine` rows transactionally, revalidates billed quantities
and cost-line amounts against the underlying PO, and recalculates bill totals on the original PO FX
rate. If the bill has already synced to Xero, saving a content change queues a
`PURCHASE_INVOICE_UPDATE` entry with a payload-derived idempotency key. Saving without changing the
bill is treated as a no-op and does not queue a duplicate update.

Xero can reject bill updates once an external bill is paid, locked, voided, or otherwise no longer
editable. Rejected bill-update sync rows are surfaced on the purchase order detail page with the
connector, timestamp, retry count, and safe error text; the raw sync payload is not displayed.

### Sales Invoice Edits

Editing a sales order that has already been pushed to Xero (i.e. `accountingInvoiceId` is set)
queues a `SALES_INVOICE_UPDATE` entry instead of silently skipping the change. The payload reuses
the same document builder as the create path, so the update reflects exactly what a fresh push
would have sent. An idempotency key derived from the payload prevents duplicate updates if the
order is re-saved without changes.

If the active accounting connector is QuickBooks (not Xero), IMS records a
`sales_invoice_update_skipped_unsupported_connector` WARNING and does not queue the update. The
behaviour is symmetric with the purchase bill path.

### Rejected Update Sync Alerts

When Xero rejects a `SALES_INVOICE_UPDATE` or `PURCHASE_INVOICE_UPDATE` (e.g. the external invoice
is locked, paid, voided, or a downstream validation failed), the sync row stays in the failed state
and IMS surfaces an amber alert at the top of the related sales order or purchase order detail
page. The alert lists the connector, when the failure happened, the retry count, and a safely
truncated error message. The full sync payload is never displayed on the UI because it may contain
sensitive document data.

Operators correct the underlying issue (in IMS or in the accounting system) and retry the failed
sync from the Sync Dashboard. Once the row transitions out of `FAILED`, the alert disappears
automatically.

### Tax Rate Sync (Multi-Component Profiles)

When an IMS VAT rate has one or more active components (e.g. Canada `GST 5% + PST 7%`), saving the
rate queues an `AccountingSyncType.TAX_RATE_SYNC` entry. The sync processor calls Xero's
`POST /TaxRates` endpoint with the matching `TaxComponents` payload so the VAT return picks up the
component-level breakdown on the Xero side. The push is idempotent: Xero matches the rate by
`Name`, and unchanged re-saves dedupe at the IMS queue layer via a payload-derived idempotency key.

A per-connector toggle (`xero_sync_tax_rate`, defaulting to `submitted`) gates the queueing. The
QuickBooks side has no equivalent API for component breakdowns — for QBO operators the trigger
logs a `tax_rate_sync_skipped_unsupported_connector` WARNING and the equivalent QBO tax codes must
be configured manually.

Until the sync settles (or for connectors that don't support it), every IMS invoice or bill that
uses a multi-component rate also emits a one-shot WARNING activity log
(`sales_invoice_tax_components_not_pushed` or `purchase_invoice_tax_components_not_pushed`) naming
the affected rate, so the operator knows the per-component breakdown depends on the accounting-side
configuration.

### Reverse Charge

Lines whose `TaxRate.reverseCharge` is true post to Xero / QuickBooks with the connector-side tax
type swapped to a configurable reverse-charge code:

- `accounting_reverse_charge_sales_tax_type` (typical Xero: `ECOUTPUTSERVICES`)
- `accounting_reverse_charge_purchase_tax_type` (typical Xero: `REVERSECHARGES`)

This ensures the VAT return classifies the line under reverse-charge (box 1 / box 8 in the UK)
instead of as a normal output / input VAT entry. The IMS-side tax math is unaffected — the rate
stays as configured (usually `0` for B2B services), and only the connector-side tag changes. When
the reverse-charge settings are empty, IMS falls back to the parent `TaxRate.accountingTaxType` so
the bill or invoice still posts, just without the reverse-charge classification.

The swap applies symmetrically to **credit notes**: refunding a reverse-charged sale posts each
product line's credit under the same reverse-charge code the original invoice used, so the VAT
return's debit and credit lines reconcile. Sales invoices and credit notes resolve product-line
tax types through one shared resolver, so the two can never drift. The swap is decided **per line**
from that line's own tax rate; shipping and discount lines follow the order-level tax rate without
the swap on both the invoice and the credit note (kept identical so the two sides match).

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

## Settlement: is the payment actually in the ledger?

Marking something paid in the IMS and the ledger agreeing are two different facts. Registering the payment is a separate sync (`INVOICE_PAYMENT` for a customer receipt, `BILL_PAYMENT` for a supplier payment) that can fail, be cancelled, or never be queued — so a green **Paid** badge on its own only means the IMS was told the money arrived.

Sales orders and supplier bills therefore show a **settlement verdict** derived from that payment sync row:

| Shown as | Meaning |
|---|---|
| *Paid* (green) | The ledger confirmed the payment in full. |
| *awaiting ledger* (amber) | The payment is queued or retrying. Normal, briefly. |
| **LEDGER REJECTED** (red) | The payment sync failed. The ledger still shows the amount outstanding. |
| **NOT SENT TO LEDGER** (red) | No payment was ever queued, or it was cancelled. The ledger will not learn about it on its own. |
| **PART PAID IN LEDGER** (red) | The ledger recorded less than the document total, so a balance remains there. |

Hover the badge for the detail; the red states also print it under the invoice. Nothing is expected to post while accounting sync is off, or before the invoice/bill itself has reached the ledger — a payment cannot attach to a document Xero has never seen, so in that case the **document** sync is what to chase.

### Receipts recorded by hand

A payment recorded on a sales order (**Add Payment**) is registered against the Xero invoice automatically, provided:

- accounting sync is on and the invoice has already posted to Xero;
- the payment method and currency resolve to a bank account in the mapping above;
- no payment for that order has already been sent to Xero, and the receipt is not larger than the invoice Xero holds.

If any of those does not hold, the receipt is still recorded in the IMS, nothing is sent, and a warning naming the order appears in the activity log — the order then shows **NOT SENT TO LEDGER** until it is registered.

The third condition matters most for imported orders: a paid WooCommerce order registers its payment automatically without creating a payment row in the IMS, so recording "the" payment by hand afterwards would pay the Xero invoice twice. The IMS refuses that rather than doing it silently. It also means only **one** registration per order is sent automatically — record a second part payment and you will be asked to register it in Xero yourself.

Deleting a payment removes its queued registration if it has not posted yet; if it already reached Xero, a warning asks you to reverse it there.

## FIFO Cost Layers

Group B of the daily batch consumes FIFO (First In, First Out) cost layers when booking COGS. Each shipment line decrements `remainingQty` on the oldest cost layers first. This ensures COGS reflects the actual purchase cost of the specific units shipped.

## Back-Reference Repair

After a document posts, its external id has to be written back onto the source document
(`accountingInvoiceId` on a sales order or bill, `accountingCreditNoteId` on a customer refund or a
supplier credit note). If that write fails, or the process dies between
marking the sync row SYNCED and running it, the document is orphaned: it exists in Xero but IMS
cannot link, update or pay it. All four document types are repaired. The back-reference repair sweep runs inside
`/api/cron/accounting-sync` (and on demand from **Integrations → Xero**), re-applies the id from
the sync row, and re-enqueues the follow-ups (PDF, payment, attachment) that never ran.

**The sweep runs for Xero only.** There is deliberately no QuickBooks equivalent, and that is not an
oversight to be reported. A QuickBooks document id is a per-company integer, and disconnecting clears
the company pin, so a sweep scoped to "the QuickBooks connector" could not tell an id issued by a
previously connected company from one issued by the current one — it would write a retired company's
integer onto a live order or bill, and payment polling would then act on it as if it were current.
Failing to repair is acceptable; repairing onto the wrong document is not. On QuickBooks, a
back-reference that fails to write is therefore **not retried by anything**: the warning in the
activity log (`quickbooks_backreference_failed` or `quickbooks_backreference_ambiguous`) says so, and
the link has to be made by hand. The external id is on the sync row, so nothing is lost — only
automatic. See *Connecting a different company* below for why the company boundary is the blocker.

**When the id itself is the blocker.** One case cannot be resolved by linking the document by hand:
the write was refused because *another local record already holds that id* — typically a bill from a
QuickBooks company you are no longer connected to, whose integer the new company has since reissued.
A manual link is refused for exactly the same reason, so the stale claim has to come off first. IMS
logs `quickbooks_backreference_id_conflict` at ERROR, writes the same text onto the sync row's error
message, and names both the blocking record and the command that resolves it. See *Releasing a stale
external id* below.

**It refuses to guess.** Sync rows created before the bill-keyed change name the *purchase order*,
not the bill. When such a row cannot be attributed to exactly one bill, the sweep writes a WARNING
to the activity log (`xero_backreference_repair_ambiguous`) asking you to link it manually, and
tries again once every 24 hours until it can. The warning repeats — deliberately — so a row nobody
ever links does not go quiet. Reasons you may see:

| Reason | What it means |
|---|---|
| `MULTIPLE_SYNC_ROWS` | Two or more posted bill sync rows reference this PO |
| `MULTIPLE_UNLINKED_BILLS` | The PO has several bills with no external id |
| `NO_LIVE_SYNC_ROW` | No live sync row for this PO carries this external id any more — it was cancelled, or its external id was cleared, mid-repair — so nothing evidences the attribution |
| `EXTERNAL_ID_LINKED_ELSEWHERE` | Another bill — on another PO — already carries this Xero bill id |
| `EXTERNAL_ID_CLAIMED_CONCURRENTLY` | Another bill claimed the id while this repair was being written |

**One ledger document, one local record — enforced by the database.** Two purchase invoices can
never carry the same bill id, two sales orders can never carry the same invoice id, and two credit
notes (customer or supplier) can never carry the same credit-note id: each of those columns has a
unique index. That matters because a stored external id is what every later action is aimed at —
invoice and bill updates post to `/Invoices/{id}`, and payment polling marks **every** local record
carrying a matching id as paid. A duplicate would mean one correction rewriting the wrong document,
or one customer payment silently settling two orders.

So a write that would duplicate an id is **refused**, with an error naming the document, the id and
the record that already holds it. Nothing is overwritten. IMS will not clear or move an existing link
on its own, because nothing in IMS records whether that link was posted authoritatively or deduced —
releasing it is an explicit, confirmed operator action (see *Releasing a stale external id* below).
The repair sweep reports a refusal it hits as `xero_backreference_id_conflict` and re-reports it once
a day until it is resolved, rather than retrying silently.

The likeliest causes are a connector reconnected to a different company that has reissued an id (see
below), and the ledger merging two of our documents because they were posted under the same document
number. Supplier credit notes are the live case of the second: if two credit notes are raised against
one purchase order and the **credit-note number is left blank on both**, they post under the purchase
order's own reference and Xero treats the second as an edit of the first. Give each supplier credit
note its own number.

### Releasing a stale external id

A refused write leaves the ledger document with no local record of it, and "resolve it by hand" is
not something you can actually do while the id is claimed — the unique index refuses a manual link
for the same reason it refused the automatic one. The claim has to be released first, and IMS will
not do that on its own: nothing in the database distinguishes a retired company's stale id from a
live, correct link, so the decision is yours.

1. Read the activity entry (`quickbooks_backreference_id_conflict`, or
   `xero_backreference_id_conflict` from the sweep). It names the **blocking record** and the
   command, with the ids already filled in.
2. Open that record in IMS and confirm it is stale — it belongs to a company this system is no longer
   connected to, or to a ledger document that no longer exists. **If it is a live, correctly linked
   document, stop.** Releasing it detaches a good link, which is worse than the refusal.
3. Dry-run (reads only, writes nothing):
   `tsx scripts/release-accounting-external-id-claim.ts --sync-log <id> --holder <id>`
   It reports the blocking record, the document the id belongs to, and whether that document is
   still unlinked — if it has acquired its own id since the warning was written, `--apply` will
   refuse and say so.
4. Re-run with `--apply`. The id is cleared from the blocking record and written onto the document
   that actually posted it, in **one transaction**. Both halves are written to the activity log.

The release and the re-link are one atomic operation on purpose: clearing the id and stopping would
leave the ledger document attached to nothing at all, and on QuickBooks nothing would pick it up
afterwards. Because they are one transaction, **any** failure — a refusal, an error, a lost
connection part-way through — leaves everything exactly as it was, and the recovery is simply to run
the command again.

Everything it acts on is re-checked at the moment it writes, not when you read the warning, and
anything unexpected is a refusal rather than a write:

- the sync row must still be the one you named — still carrying the record of the refusal, still
  carrying the same external id, and still in a state a repair applies to. A row that has re-posted
  under a new id is no longer about the id you are releasing, and a row with a sync **in flight**
  (`PENDING`/`PROCESSING`) may be about to post again under a different id;
- the blocking record must still be the one you confirmed, and must still hold exactly that id;
- the document being linked must still **have no external id of its own**. If it has been linked
  correctly in the meantime, the older id from your warning is refused, never written over the top.

**Which sync rows this applies to.** The two connectors record the same conflict differently, and the
command accepts both: QuickBooks keeps the row `SYNCED` and writes the conflict into its error text,
while Xero lets the refusal fail the row, so it retries and ends up `FAILED` — still carrying the
external id, because that is stored before the local write is ever attempted. A `FAILED` row is the
normal shape of a Xero conflict, not a broken one. Running the command a second time after it has
succeeded is safe: it reports that the id is already on the document and does nothing.

**Rows past their retention window.** Data retention clears the stored payload of an unresolved sync
row once it is older than the sync-log retention period, keeping only the identifying record. Such a
row is still repaired — the external id can still be written onto the order or bill — but its
outstanding follow-ups (PDF, payment, attachment) can no longer be rebuilt. When that happens the
sweep logs `xero_backreference_followups_discarded` naming the document, so you can check for a
missing PDF, payment or credit allocation and re-drive it manually.

## Connecting a different company

**IMS is built for one accounting company at a time.** Connecting a different one is possible, but
the external ids already stored against your orders, bills and credit notes stay behind, and they
belong to the company that issued them.

For **Xero** that is harmless in practice: organisation ids and document ids are GUIDs, so an id
from a previous organisation can never be mistaken for one of the new organisation's documents — it
simply resolves to nothing, and the failure is a loud "not found" rather than a wrong document.

For **QuickBooks** it is not harmless, because document ids are per-company integers: company B
routinely issues the same id company A did. IMS keeps the rule that one ledger document belongs to
exactly one local record, enforced by the database, so if the new company issues an id an old order,
bill or credit note still holds, **the new link is refused** with an error saying the id is already
held locally and naming a company reconnect as the likely cause. The document really is in
QuickBooks; only the local link is missing, and someone has to resolve it by hand.

That is deliberate. Letting both records hold the same integer would be worse: the many places that
read a stored external id — payment matching, reconciliation, document updates, attachments — cannot
tell two companies' ids apart, and orders, refunds and credit notes do not record an issuing company
at all. A refused link is visible and fixable; a payment settling the wrong document is neither.

It is also why there is no back-reference repair sweep on QuickBooks (see *Back-Reference Repair*
above). The refusal only fires when some local record still holds the id; after a company switch the
usual case is that **nothing** holds it, and an automatic repair would then link a retired company's
document with no constraint to stop it.

**Practically:** if you need to move a QuickBooks connection to a different company, treat it as a
migration, not a reconnect. Export the existing links first (they are financial records), then clear
them deliberately before connecting the new company.

### Disconnecting and reconnecting

Disconnecting clears the token, the company pin, and the cached contact/item ids — but **not** the
external ids on your orders, bills and credit notes. Those are the only local record of which ledger
document each one became, and every later correction or payment posts against them.

- **Reconnect to the same company** — everything resumes where it was.
- **Reconnect to a different company** — see above.

Re-authorising to a *different* company while still connected is refused; only an explicit
disconnect clears the pin.

**The sweep always makes forward progress.** It examines a bounded number of rows per run and
remembers where it stopped, so the next run resumes behind them and wraps round to the start when it
reaches the end. Rows it cannot settle — a permanent ambiguity, a connector outage — are retried
rather than retired, and because the sweep resumes rather than restarting, they cannot consume every
run's budget and hide newer breakages behind them.

**Retention interacts with this.** Sync logs are normally deleted once they pass the retention
period (Settings → Data Retention). A row the sweep has *not yet settled* — a posted row whose
document is still unlinked — is not deleted, because deleting it would erase the only evidence of
which document an unlinked bill belongs to, and deleting a *competing* row would silently turn an
ambiguity the sweep was refusing to guess at into a confident wrong answer.

It is **compacted** instead: at the retention cutoff the row keeps its connector, type, reference and
external id, and loses its payload and error message — the parts holding customer details, addresses
and financial lines. Nothing is retained past the retention period in full.

A compacted row is **still a repair candidate**, and the split is by what each piece of work needs
rather than by the row as a whole. Everything the id write reads — the reference and the external
id — survives compaction, so the sweep can still link the order or bill, including one whose
ambiguity only cleared *after* the retention cutoff. What cannot survive is the follow-up work built
from the payload (PDF, payment registration, bill attachment); when the sweep repairs one of these
rows it logs `*_backreference_followups_discarded` naming the document, so you can check for a
missing PDF or payment and re-drive it by hand. A compacted row also still counts as a claim when the
sweep decides whether a purchase order's bill is ambiguous.

**Do not cancel one of these rows to tidy it away.** Cancelling is irreversible in two ways the row
gives no warning about: a cancelled row is no longer a repair candidate, so the link that was still
perfectly possible is given up permanently; and it no longer counts as a competing claim, so an
ambiguity the sweep was refusing to guess at can silently become a confident wrong answer on some
other row. Cancel only when you have decided the document is genuinely abandoned. Rows the sweep
settles expire normally.

## Cron Endpoints

| Endpoint | Schedule | Purpose |
|---|---|---|
| `/api/cron/accounting-sync` | Every 5 min | Process pending accounting sync entries (invoices, journals) for whichever accounting connector is active, then — for Xero only — run the back-reference repair sweep |
| `/api/cron/accounting-daily-batch` | Daily (midnight) | Run sub-ledger Groups A1, A2, B |
| `/api/cron/accounting-payment-poll` | Every 15 min | Detect paid invoices and bills in the active accounting connector |
| `/api/cron/accounting-payment-reconcile` | Daily (03:00) | Backlog sweep: check every locally-linked invoice/bill against its current Xero status by id (report-only unless `xero_payment_reconcile_apply`) |
| `/api/cron/accounting-fx-revaluation` | Daily | Periodic unrealised FX revaluation of open AR/AP balances |
| `/api/cron/account-balance-snapshot` | Daily | Snapshot Xero account balances for period reporting |

All cron endpoints require the `CRON_SECRET` bearer header in production.


## Realised and Unrealised FX

The system tracks both kinds of foreign-currency P&L impact separately.

### Realised FX (at settlement)

When a multi-currency invoice or bill is paid, the actual settlement exchange rate may differ from the rate booked at invoice creation. The system computes the realised FX gain or loss at payment time:

- **AR (sales invoice paid)** — gain when the settlement base value exceeds the booked base value (the customer's currency strengthened in your favour).
- **AP (supplier bill paid)** — gain when the settlement base value is less than the booked base value (your home currency strengthened against the supplier's).

The realised FX entry is queued as a `REALISED_FX_JOURNAL` accounting sync row. Configure the Realised FX Gain/Loss account in **Integrations → Xero → Account Mapping**.

### Unrealised FX (period revaluation)

For open multi-currency AR and AP balances, the daily `accounting-fx-revaluation` cron job:

- Computes the current base-currency value of every open invoice/bill at today's rate
- Compares against the originally-booked base value
- Posts an unrealised FX gain/loss journal to balance the difference
- Reverses yesterday's revaluation journal on the next run so the entries don't accumulate

This ensures month-end financial reports correctly reflect what your foreign-currency exposure is worth today, without double-counting movements.

Configure the Unrealised FX Gain/Loss account separately from Realised in Xero account mapping.

### FX rate staleness

If the FX rate for a transaction's currency is older than 1 day, the system surfaces this in the activity log as a `fx_rate_fallback_used` WARNING entry. Period-movement queries for accounts strictly require a previous-day snapshot — if no snapshot exists, the report shows a notice rather than silently using a stale value.


## Daily Batch Caps

The Xero daily batch processes orders and shipments in batches to avoid creating multi-thousand-line journals that are slow to post and hard for finance to read. The default cap is 1,000 entities per group per run (configurable via `XERO_DAILY_BATCH_LIMIT`, max 5,000).

If a single day exceeds the cap, the batch creates multiple journals for that date:

- **A1 — Revenue Deferral**: e.g. `A1-2026-06-09-abc12345` and `A1-2026-06-09-def67890`
- **A2 — Inventory Reclassification**: same pattern
- **Group B — Shipment Recognition**: same pattern

The hash suffix is deterministic (computed from the entity IDs in the batch), so re-runs produce the same reference IDs and don't double-post. Finance reading the Xero ledger should sum all entries for a given date to reconcile against the IMS daily total.

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

### Which batch a row belongs to

Each staged row also records the exact journal reference it went into, alongside its marker date: `revenueDeferredBatchRef` (A1) and `inventoryAllocatedBatchRef` (A2) on the order, `shipmentJournalBatchRef` (Group B) on the shipment. That is what the order delete guard, the recreate sweep, the accounting invariants and reconciliation match on.

This matters because the batch date is fixed when the run starts, while the marker dates are written as each row is processed. A long or late-evening run that crosses UTC midnight therefore stamps rows with the *next* day while the journal is keyed on the previous one. Reading the batch back from the marker date alone finds nothing in that case — which previously let an order be deleted while its value sat in a posted journal.

Rows staged before this was introduced have no reference recorded, and are still matched on their marker date. Nothing needs to be backfilled; both paths are supported indefinitely.
