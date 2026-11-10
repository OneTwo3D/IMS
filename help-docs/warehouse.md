# Warehouse (Mintsoft)

This article is for the people who run day-to-day stock and orders when a warehouse is operated by **Mintsoft**, the warehouse management system (WMS) IMS connects to. It pulls together what is otherwise spread across the Sales, Purchasing, Stock Control and Settings articles. Mintsoft is the only warehouse connector, and only one warehouse connector can be switched on at a time.

If you are setting Mintsoft up for the first time, start with the [Setup Wizard Walkthrough](onboarding-walkthrough.md); the cron schedule is in [Settings](settings.md).


## What IMS and Mintsoft each do

- **IMS is the master of products, orders and (by default) stock.** Mintsoft physically picks, packs and despatches.
- **Orders** can be pushed from IMS to Mintsoft for fulfilment. This push is **off by default** (the `wms-order-push` job in Settings > System > Scheduler); until it is switched on, orders reach the warehouse by whatever route you use today.
- **Despatches** come back from Mintsoft: IMS checks Mintsoft every 15 minutes for orders it has pushed and progresses the IMS shipment and tracking. This poll is on by default, only reads from Mintsoft, and does nothing while the Mintsoft plugin is off.
- **Purchase orders and transfers** can be sent to the warehouse as an ASN (advance shipping notice) so the warehouse expects the goods.
- **Stock** is compared with Mintsoft's figures per warehouse (see Stock sync below).


## Where to find it

- **Integrations > Mintsoft** — connection, warehouse bindings, stock sync settings, bundles, returns inbox, receipt reviews, open discrepancies and the courier mapping.
- **Integrations > Exceptions** — anything the warehouse link could not complete by itself (see below).
- **Integrations > Event Timeline** — every change IMS sent to or received from the warehouse, with before and after values. Filter by connector, direction, action and outcome.
- **Sales Orders** — the **WMS Status** chip and **WMS Dispatch** column.
- **Purchase Orders** and **Warehouse Transfers** — the **Create Mintsoft ASN** button.
- **Settings > System > Plugins** to turn the connector on; **Settings > System > Scheduler** for the jobs.


## Connecting

On **Integrations > Mintsoft**, open **Connection** and enter the base URL and the credentials, then use **Save & Test Connection**. As with every integration, the test must pass and the settings must not change afterwards before anything is switched on.

Choose the **Authentication** mode carefully:

- **Mintsoft API key (recommended).** IMS uses the fixed key you paste and never logs in. Use this whenever anything else (the WooCommerce plugin, a label service) shares the same Mintsoft account, because every Mintsoft login replaces the account's key for everyone. The unattended despatch poll also relies on this: with a fixed key it always runs.
- **Username and password.** IMS logs in to renew the 24-hour key. Each renewal replaces the key for every other integration on the account, and the despatch poll skips (with a reason) once the stored key has expired.

Also set:

- **Webhook Secret** — must match the one in Mintsoft, otherwise callbacks are rejected (see [Troubleshooting](troubleshooting.md)).
- **Order Lookup Connector** — which storefront Mintsoft callbacks refer to. Required when more than one shopping connector is on.
- **Client ID** (in the order dispatch settings). Mintsoft is a shared tenant, so every order lookup is limited to your client. **Leave it blank and the despatch poll is disabled** and skips every run.
- **Courier service mapping** — a list matching each IMS shipping service name to a Mintsoft courier service id, plus a **Default courier service id** for services not in the list. Unmapped names are passed through for Mintsoft to resolve.
- **Admin order URL template** — where the WMS Status chip links to; leave blank for the default.


## Warehouse bindings and stock sync

A **binding** links an IMS warehouse to a Mintsoft warehouse. Each binding has a **Stock Sync Mode**:

- **Notification only** (default). IMS stays the stock master. IMS reads Mintsoft's stock and, when the difference passes the **Absolute Delta Threshold** or **Percent Delta Threshold**, warns the **Report Recipients** and lists the item under **Open Discrepancies**. Nothing is changed for you.
- **Align To WMS.** Mintsoft becomes the stock master for that warehouse. The first sync is a **dry run** that changes nothing until you confirm it. After that, IMS raises stock to match Mintsoft's higher figure. A persistent *lower* Mintsoft figure is written off only when an **Align-Down Write-Off Reason** is set, and only within the thresholds.

Effects you will notice in other screens:

- A stock count (Stock Control > Stock Counts) cannot be posted for an Align To WMS warehouse, and a notification-only warehouse asks you to confirm. See [Stock Control](stock-control.md).
- **Notification only (the default):** IMS is the stock master. Correct stock in IMS as usual (an adjustment, or a stock count after confirming the warning), then settle the physical figure in Mintsoft, because any remaining difference is flagged again on the next stock sync.
- **Align To WMS:** Mintsoft is the stock master. Make stock corrections and counts in Mintsoft; the sync brings them into IMS, and an IMS-side count is refused.
- The stock sync, returns and verification jobs are **off by default**; the Scheduler lists them.

**Products.** Products are pushed to Mintsoft with their customs data. A commodity code that is not a valid 8-digit 2026 CN8 code is left out of the push (the rest of the product still syncs) and an **Open Discrepancy** names the product; it clears itself once the code is corrected. A blank country of origin is sent as China; an unrecognised one is also sent as China and flagged until you correct it. See [Inventory](inventory.md) for the HS Code Review queue.

**Bundles.** A KIT product becomes a Mintsoft bundle, and bundles are create-only: Mintsoft has no way to change one, so a recipe change after the first push shows as a **bundle derivation conflict** in Open Discrepancies that you resolve by hand. If a bundle create may have reached Mintsoft but the answer was lost, IMS will not send it again. It appears under **Bundles** as waiting. Look in Mintsoft first, then either link the bundle by its Mintsoft id, or confirm that none exists. The "none exists" option is refused until the first attempt can no longer be in flight and a fresh lookup finds nothing.


## Sales orders

- **WMS Status** shows the warehouse's own state for the order (for example new, picking, dispatched, cancelled). It is refreshed on the order page and in the background (the `wms-order-status` job, off by default).
- **WMS Dispatch** (sales list) shows the state of IMS's push: Pushed, Queued, Cancelling, Held, Cancelled, Failed, Pre-cutover or Payload invalid.
- **Cancel the order** to withdraw it from the warehouse. Editing, holding or releasing an order is passed on too; an order the warehouse has already started cannot be pulled back and is raised under Exceptions with a comment for the warehouse.
- **Refunds.** A refund of a pushed order adds a warehouse-visible comment, and on a part refund of an order still new in Mintsoft the lines are amended. When the parcel comes back, Mintsoft's return events are staged in the **Returns Inbox** for you to review. They do not restock anything on their own.
- **Partial shipments** reported by Mintsoft are recorded as shipments on the IMS order and passed on to the storefront.
- **Withdrawals.** An EU withdrawal request holds the order and pulls it back from the warehouse. See [WooCommerce](woocommerce.md).


## Purchase orders, transfers and booking in

- **Create Mintsoft ASN** on a purchase order, or on an in-transit transfer, tells the warehouse what to expect. The button is shown only when the connector is on, and the tooltip says why if it is disabled. The booked-in callback address cannot be sent with the ASN: it must be set up in Mintsoft.
- **Goods are booked in through the ASN, not by hand.** While a line has an ASN that is being created, open, part booked in or booked in but not reconciled, **Receive Goods** refuses that line and names the SKU and ASN. An order with an open ASN also cannot be closed or cancelled, and its lines cannot be reduced or removed, until the ASN is booked in or retired. Details are in [Purchasing](purchasing.md).
- **Receipt Reviews.** A booked-in callback that cannot be applied safely (for example for a cancelled or closed order) is paused here before any stock changes. Review it on the Mintsoft page. **Recheck booked-in** on the order or transfer re-reads the ASN.
- A stock count or alignment that brings units in counts as *landed*: the order will not accept a manual receipt for units already landed.


## When something goes wrong

**Integrations > Exceptions** is the inbox for items the warehouse link could not finish. Sections include a maintenance window, blocked order pushes, dead inbound events, despatches that could not be reconciled, unreadable records, order-level drift and order-total mismatches. Each row has **Replay** (try again safely) and **Dismiss**, or **Mark as handled** once you have fixed it by hand. A despatch for an order under a withdrawal hold is held back again when replayed. Unreadable records can be isolated so that one bad record does not stop the rest.

Also see:

- Overdue ASNs and stale stock syncs raise a warning on their own (the `wms-watchdog` job, on by default).
- **Open Discrepancies** on the Mintsoft page for stock, code and bundle differences.
- Webhook signature errors and credentials: [Troubleshooting](troubleshooting.md).
- Erasing a customer whose orders are still open at the warehouse: [Personal-data Erasure](erasure.md).


## Not covered here

Reconciliation checks that compare Mintsoft with IMS on-hand stock are an administrator tool that runs outside the application and are not part of day-to-day use.
