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

### Which organisation this instance may connect to

**IMS will not guess which Xero organisation to invoice into.** If the person authorising the
connection has access to more than one organisation — very common for an accountant, a bookkeeper, or
anyone who also has the Xero Demo company — the consent hands IMS a *list*, and picking one silently is
how test data ends up in a real ledger. It has happened: a test instance connected to the live
organisation and posted 150 invoices, 111 contacts, 217 items and 14 payments into it before anyone
noticed.

So:

- **One organisation on the consent** — the ordinary case — connects exactly as before. Nothing changes.
- **More than one, and this instance has never been connected** — the connection is **refused**, nothing
  is stored, and the message names every organisation offered with its tenant id, e.g.

  > Refused: this instance has no pinned Xero organisation and the consent returned 2 organisations, so
  > IMS will not guess which ledger to invoice into. Offered: Demo Company (UK) [tenantId 5c949ed5-…],
  > OneTwo3D Ltd [tenantId e7fb4378-…]. Nothing was stored. Choose explicitly: set
  > `XERO_ALLOWED_TENANT_IDS` to exactly one of the tenantIds above in the server `.env`, restart IMS and
  > connect again — or remove IMS's access to the other organisations in Xero (My Xero → Connected apps)
  > so that a single organisation is offered.

  Either route works. The allow-list is the durable one; removing the app's access to the other
  organisations in Xero is the quicker one if you only ever want the single organisation.
- **Once connected**, IMS pins that organisation and every later reconnect must match it, exactly as
  before. Disconnecting clears the pin.
- **Two connections at once bind one organisation, not two.** The pin and the stored token are written
  in a single database transaction, and the pin's key is a primary key, so if two OAuth callbacks are in
  flight at the same time — two browser tabs, two operators, a replayed redirect — exactly one of them
  establishes the binding. The other is refused with nothing stored: no token, no pin, no Xero data read
  or written. Its message names the organisation that won and tells you to disconnect on `/sync` if the
  one you chose is the one this instance should use. (Two consents to the **same** organisation both
  report success; there is nothing wrong with a double-clicked *Connect*, and the duplicate is simply
  discarded.)

### The organisation allow-list (`XERO_ALLOWED_TENANT_IDS`)

The pin above lives in the **database**. A fresh database has none — a new instance, a reset, a restored
dump — which is precisely the state the incident happened in. Three environment variables give the same
protection at a level a database reset cannot erase:

```
XERO_ALLOWED_TENANT_IDS=5c949ed5-…,e7fb4378-…
XERO_BLOCKED_TENANT_IDS=e7fb4378-…
XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)
```

- **Blank or absent means no restriction.** The control is opt-in, so an empty line in `.env` cannot
  accidentally disable every Xero connection.
- Changing any of them needs an **IMS restart**.

#### A tenant id is an identity. An organisation name is not.

The three keys are deliberately **not** equivalent, and this is the most important thing on this page.

A Xero **tenantId** is issued by Xero, is unique, and nobody in your organisation can change it. A Xero
**organisation name** is a label: it is not unique — `Demo Company (UK)` is what Xero calls *every*
demo company there is — and anyone administering an organisation can rename it from Xero's own settings
screen at any time. A check that a rename can satisfy is not an identity check, and the whole point of
this page is that a test rig once wrote 150 invoices into a live ledger.

So the keys compose as a chain of **filters** over the organisations on the consent. Every key that is
set can *remove* candidates; none of them can *add* one:

| Key | What it is | What it does |
|-----|-----------|--------------|
| `XERO_BLOCKED_TENANT_IDS` | identity | Refused everywhere, checked first. |
| `XERO_ALLOWED_TENANT_IDS` (and the deprecated `XERO_TENANT_ID`) | identity | The only key that **allows** an organisation. |
| `XERO_ALLOWED_TENANT_NAMES` | **not** an identity | Only **narrows** what the ids already chose. |
| `XERO_REQUIRE_DEMO_ORG` | identity, but **not an id** | Narrows to Xero **demo** organisations, using Xero's own flag. |

Consequences worth knowing before you configure this:

- Ids and names are **not a union**. `XERO_ALLOWED_TENANT_IDS=5c949ed5-…` together with
  `XERO_ALLOWED_TENANT_NAMES=Demo Company (UK)` allows one organisation — the one that is *both*. An
  organisation renamed to `Demo Company (UK)` does not get in on the strength of its new name.
- A name that matches **two** organisations on one consent is **refused**, not used to choose between
  them. It has just demonstrated, on that very consent, that it identifies neither.
- Naming the same organisation two ways is **not** a contradiction. `XERO_TENANT_ID=5c949ed5-…` plus
  that organisation's own name is one instruction spelled twice, and connects. Only an *empty
  intersection* — each key selecting a different organisation out of the same consent — is refused as a
  contradiction, and the message names what each key selected.
- Names ignore extra spacing and case. An organisation whose name contains a comma cannot be expressed
  in `XERO_ALLOWED_TENANT_NAMES` at all — use its id.
- **Do not use a name as your only tenant control.** IMS records
  `xero_tenant_guard_name_only` in the activity log when you do, because that configuration has no
  anchor a rename cannot move. `XERO_REQUIRE_DEMO_ORG=true` counts as an anchor and clears the warning:
  Xero asserts it, and the organisation's own administrators cannot.

- `XERO_REQUIRE_DEMO_ORG` **narrows like a name and anchors like an id**. It can never admit an
  organisation the ids exclude; it can only remove non-demo organisations from what the other keys
  already allowed.

#### When the connected organisation's id keeps changing (`XERO_REQUIRE_DEMO_ORG`)

Xero re-creates its **Demo company with a new tenantId** at every ~28-day reset, and any test
organisation you rebuild behaves the same way. An id *allow*-list then has to be re-edited every cycle,
which is exactly how a safety control ends up switched off.

**Require a demo organisation instead.** Xero's own `GET /Organisation` reports `IsDemoCompany` for the
organisation behind a token, and that is a fact about how the organisation was *created*: unlike a name
it cannot be adopted by renaming, and unlike an id it does not change when the Demo company is rebuilt.

```
XERO_REQUIRE_DEMO_ORG=true              # a Xero demo organisation, whatever its id this cycle
XERO_BLOCKED_TENANT_IDS=e7fb4378-…      # belt and braces: the live organisation, forever
```

This costs no extra Xero call — the connection callback already reads `GET /Organisation` to check base
currencies — and it covers **both** paths: a consent that offers a non-demo organisation cannot bind it,
and a production database restored onto the rig is refused at every sync, because the demo status is
recorded on the stored connection and re-checked on every use of it.

> **A deny-list alone does not restrict you to a demo organisation.** `XERO_BLOCKED_TENANT_IDS` refuses
> the organisations you thought to list. A **third** organisation — a bookkeeper's sandbox, a second
> company, anything else the person authorising the connection can reach — is neither blocked nor
> allow-listed, so it connects. `XERO_ALLOWED_TENANT_NAMES` cannot close that gap either, because any
> organisation can be renamed to `Demo Company (UK)`. Only `XERO_REQUIRE_DEMO_ORG` constrains the
> *kind* of organisation rather than enumerating ids.

**Unverified is refused, not allowed.** A stored connection whose demo status was never read — a token
from a restored dump, or one established before you switched this key on — has no proof attached, and
under this key an unproven demo organisation is not treated as a demo organisation. The fix is to
disconnect on `/sync` and connect again, which re-reads the flag from Xero. Connections made *after*
this key existed record the flag whether or not the key is switched on, so turning it on later does not
by itself force a reconnect.

A value that is neither yes nor no (`XERO_REQUIRE_DEMO_ORG=Demo Company (UK)`, say) refuses **every**
Xero connection rather than quietly meaning "off" — a line that reads like a guard and is not one is the
mistake `XERO_TENANT_ID` made, and it is not repeated here.

After a reset the database pin still names the *retired* tenantId, so the first reconnect is refused
with `this instance is pinned to Xero tenantId …, which this consent did not include`. **Disconnect Xero
on `/sync` first** — that clears the pin — then connect again.

Listing the same id on both `XERO_ALLOWED_TENANT_IDS` and `XERO_BLOCKED_TENANT_IDS` is refused as a
contradiction rather than silently resolved: it is two deliberate instructions that cannot both be
obeyed, and IMS will not pick one for you.

What it does when set:

1. **At connection time** — a consent offering no allowed organisation is refused, nothing is stored,
   and no Xero data is read or written. If the allow-list names exactly one of the organisations
   offered, that one is used even without a pin, so a rig can be connected safely without anyone having
   to pick from a list.
2. **Every time the stored token is used** — a stored connection to a disallowed organisation stops
   every Xero sync with a notification naming the organisation. This is what catches a **production
   database restored onto a test instance**: the token comes with the dump, no consent screen is ever
   shown, and without this check the instance would carry on syncing into the live ledger.
3. **Over the database pin** — the environment wins. A pin restored from another environment cannot
   smuggle its organisation past the allow-list.

**Set a control that does not depend on a name on every non-production instance** (e2e, staging, any
restored copy): `XERO_REQUIRE_DEMO_ORG=true` when the instance uses a Xero demo organisation,
`XERO_ALLOWED_TENANT_IDS` when it uses a specific non-demo test organisation, and
`XERO_BLOCKED_TENANT_IDS` naming the live organisation alongside either. Production may set
`XERO_ALLOWED_TENANT_IDS` to the live organisation or leave it unset — and must **not** set
`XERO_REQUIRE_DEMO_ORG`, which would refuse its own ledger.

Refusals are recorded in the **Activity log** (`xero_connect_refused`, `xero_stored_tenant_refused`), so
a refusal that happened while nobody was watching the browser is still discoverable. A name-only
configuration is recorded there too, as `xero_tenant_guard_name_only` — once per connected organisation
rather than once per sync — because it is permitted but weaker than it looks.

#### Reconnecting to a different organisation

Only one organisation can be bound at a time, and IMS refuses a consent to a second one while the first
is still connected — so moving to a different organisation means **Disconnect on /sync, then Connect**.
That is also what the Demo company needs roughly every 28 days, because Xero re-creates it with a new
organisation id.

A reconnect is safe to do at any moment, including while a sync is running. IMS refreshes its Xero
access token about every half hour, and a refresh that was already in flight when you rebound the
connection is **discarded rather than stored**: the organisation is part of the database write, so a
token belonging to the organisation you just left cannot land on the connection you just made. It is
recorded as `xero_refresh_discarded` in the Activity log and deliberately does *not* raise a
notification — the connection is healthy, and one sync may simply have to be retried. If you see a
single Xero failure at the exact moment somebody reconnected, that is what it was.

#### If you already set `XERO_TENANT_ID`

`XERO_TENANT_ID` is **deprecated**. It appeared in `.env.example`, in the installer and in the
environment-variable reference for a long time, describing itself as the Xero organisation id and
saying the app would fill it in after connecting — and no part of IMS ever read it. If you set it to
your live organisation and assumed the tenant was pinned, it was not: you had no protection at all,
which is worse than having no setting, because the name alone was enough to stop people looking harder.

It is now read, as a single-organisation form of `XERO_ALLOWED_TENANT_IDS`, and enforced on exactly the
same paths — the callback, the stored token, and over the database pin. **An instance whose only tenant
setting is `XERO_TENANT_ID` is genuinely restricted to that organisation from this release on.** If
that is not what you wanted, remove the line before upgrading.

Rename it when convenient:

```
# before
XERO_TENANT_ID=5c949ed5-…
# after
XERO_ALLOWED_TENANT_IDS=5c949ed5-…
```

Do not leave both `XERO_TENANT_ID` and `XERO_ALLOWED_TENANT_IDS` in place with different values. Two
*identity* settings that disagree are refused outright — every Xero connection and every sync stops with
a message naming both values — rather than IMS silently preferring one of two instructions you gave on
purpose. Setting both to the *same* single organisation is fine, so you can migrate without a gap, and
`XERO_TENANT_ID` alongside `XERO_ALLOWED_TENANT_NAMES` is fine too: a name narrows what the id chose
rather than competing with it.

**QuickBooks** does not have this control. It does not share the same defect — Intuit sends the company
(`realmId`) in the callback itself, so there is no list to pick from and nothing is chosen silently —
but it also has no environment allow-list, so a restored database with a QuickBooks token in it is not
stopped the way a Xero one is.

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

**A row is only finished when its follow-ups have actually run.** Writing the id back and enqueueing
the follow-ups are two separate steps, and the second can fail on its own — a busy queue, a momentary
database error. When it does, the row is *not* marked as reconciled: it is left open, flagged as still
owing its follow-ups, and the next sweep retries them. That holds whether the row was `FAILED` or
`SYNCED`; the sweep will not close a row on the strength of the id being present, because a document
can be correctly linked and still be missing its PDF or its payment. Nothing is retried forever in
silence, either — each failed attempt writes `xero_backreference_followup_deferred` to the activity
log.

**The sync itself records what it still owes, not just the sweep.** A linked, `SYNCED` row says
nothing on its own about whether its PDF, payment or attachment ever ran — so the sync writes that
down at the moment it is true, in the very same database write that marks the row synced with its
external id. It is cleared only once the follow-ups have actually been queued. That is what makes a
process restart in the middle of a sync recoverable: whatever was interrupted, the row still says the
follow-ups are outstanding and the next sweep runs them. Rows that were synced *before* this was
introduced cannot be assessed retrospectively — a completed row and an interrupted one look identical
afterwards — so nothing was back-filled; the protection applies from that point on.

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
(QuickBooks *does* record outstanding follow-ups the same way Xero does — that costs nothing and
crosses no company boundary — so the work is recoverable the day a QuickBooks sweep becomes safe to
run. Until then it is a record, not a repair: a QuickBooks follow-up that fails still has to be
re-driven by hand, and `quickbooks_followup_error` in the activity log is the notice that it does.)

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
4. Re-run with `--apply`. The id is cleared from the blocking record, written onto the document that
   actually posted it, and recorded in the activity log as
   `accounting_external_id_claim_released` — all in **one transaction**. The audit entry is part of
   the transaction rather than something written afterwards, so a completed release can never end up
   with no record of who detached what: if the record cannot be written, the release does not happen
   either and you are told the command failed.

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
from the payload (PDF, payment registration, bill attachment); whenever the sweep settles one of
these rows with follow-ups still outstanding — whether it repaired the link on that pass or the link
was already there — it logs `*_backreference_followups_discarded` naming the document, so you can
check for a missing PDF or payment and re-drive it by hand. The row is only closed once that warning
has been written, so the loss is never absorbed silently. A compacted row also still counts as a claim when the
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

The sync log at **Integrations → Xero** shows queued transactions for the **currently active** accounting connector, with their status:

- **Pending** — Queued, waiting for next cron run
- **Synced** — Successfully pushed to Xero (shows Xero transaction ID)
- **Failed** — Failed after 5 retries (shows error message)

Failed entries can be investigated via the error message and retried by resetting their status in the database.

### Rows stranded on a connector you switched away from

Because the sync log is scoped to the active connector, unresolved rows left behind on a connector that has since been turned off appear in **no** sync log. They are listed instead in the amber banner at the top of **Integrations**, which shows each row's connector, type, reference, status, age in days, and last error — plus the external transaction ID if the row already posted something before it stalled.

These rows still block their sales order from being deleted. To clear one, either re-enable the connector it was queued for (Pending rows then resume on the next cron run), or look the document up in that accounting system using the reference and external ID shown. Pending and Processing rows queued for an inactive connector can also be bulk-cancelled from the same banner; cancelling discards the queued row and does not stop the document syncing to the active connector later.

**If a cancel reports an error, read which kind it is.** There are two, and they mean different things:

- A stated refusal — for example "The active accounting connector changed while this ran, so nothing was cancelled" — is a guarantee. Nothing was discarded, the reason is recorded in the activity log, and it is safe to reload and try again.
- "The cancel request failed before it could report its outcome, so it is NOT known whether any rows were cancelled" means exactly that. The request may have been refused, or it may have completed and lost its reply on the way back. The banner reloads the stranded rows from the server when this happens: check that list, and the activity log, before pressing the button again — do not assume the attempt did nothing.

Cancelling cannot be caught out by a connector switch happening at the same moment. The plugin selection is locked for the duration of the cancel, so a switch either lands entirely before it or entirely after it; if one somehow does land in between, the whole cancel is rolled back and reported rather than half-applied.

**The list shows the oldest 50 rows only.** When there are more, it says so explicitly — "Showing the oldest 50 of 137 stranded row(s) — 87 more are not listed here." The hidden rows stay hidden until the listed ones are resolved: there is no per-row control here, and Failed rows in particular are not cleared by anything on this page, so a long-standing backlog at the front of the list will keep newer rows out of view. Resolve the oldest ones (re-enable their connector, or cancel the Pending/Processing ones) and the next set appears on reload. When the list is complete it says "Showing all N stranded row(s)" instead, so a count on this banner is never ambiguous about what it excludes.

If the list itself cannot be loaded, the banner says so in red — "The list of stranded sync rows could not be loaded" — rather than showing nothing. An empty banner section always means there is nothing stranded; it never means the lookup failed.

The banner does not depend on the rest of the page loading. If the integration settings and sync history below it cannot be read, they are replaced by a notice saying so and the banners above still render. This matters because the usual reason the stranded list fails — the database being unreachable — is the same reason those panels fail, and that is precisely when you need the banner. As with the banner, an unavailable panel says so: it is never rendered as "nothing is configured" or "nothing has synced".

The list requires the **sync** permission (Admin and Manager). Roles without it do not see this section — the whole **Integrations** page requires it. Opening `/sync` directly (a bookmark, a pasted link) as a role without **sync** shows a short "You don't have access to Integrations" page naming the missing permission, with a link back to the dashboard: it is not an error, and signing in again or retrying will not change it. Nothing on the page is read for such a role, so no integration setting, log or stranded row is fetched at all.

**Turning every integration off does not hide these rows.** Integrations normally redirects to the plugin settings when no connector is enabled, but if you hold **sync** and unresolved accounting rows exist, the page still opens and shows this banner — switching the last accounting connector off is precisely what strands every unresolved row, so that is the state where the list matters most.
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
