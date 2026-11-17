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

**Barcode, EAN and UPC (flag, default OFF).** By default IMS writes a product's barcode to Mintsoft's **EAN** field and nothing to **UPC**, and reads whichever of the two fields comes first. The **Split product identifiers (GTIN / MPN)** switch (Sync > Products; setting `product_identifier_split_enabled`) is **off** until an administrator turns it on, and while it is off none of the following applies. When on, IMS writes the GTIN to EAN and the manufacturer part number to UPC, and reads both Mintsoft fields by shape. A code that cannot be placed (two part numbers, two GTINs, or a disagreement with IMS) raises a barcode conflict in Open Discrepancies and IMS writes neither field until you resolve it. See [Barcode versus MPN](inventory.md#barcode-versus-mpn).

**Product name, cost and size parity (flags, default OFF).** IMS can also match what the retired Python sync did, behind the setting `mintsoft_product_parity_enabled`, which is **off** until an administrator turns it on; while it is off none of the following applies and what IMS sends is unchanged. When on: a product name is shortened to the 99 characters Mintsoft accepts (the parent part is cut at a word boundary and ends `...`, the variation part is kept whole); IMS's unit cost is sent as Mintsoft's cost price; and a variation with no weight or size of its own takes its parent's. A second setting, `mintsoft_parent_sku_delete_enabled` (also **off**, and ignored unless the first is on), lets IMS delete a variable product's parent record in Mintsoft, but only once every variation is confirmed there; if it cannot confirm that it deletes nothing and records a refused action for you to look at. Two read-only scripts help before anyone turns this on: a catalogue dry run that compares what IMS would send with Mintsoft's stored record, and bulk HS code / country of origin CSV tools that only print a comparison unless an administrator runs them with `--apply`.

**Bundles.** A KIT product becomes a Mintsoft bundle, and bundles are create-only: Mintsoft has no way to change one, so a recipe change after the first push shows as a **bundle derivation conflict** in Open Discrepancies that you resolve by hand. If a bundle create may have reached Mintsoft but the answer was lost, IMS will not send it again. It appears under **Bundles** as waiting. Look in Mintsoft first, then either link the bundle by its Mintsoft id, or confirm that none exists. The "none exists" option is refused until the first attempt can no longer be in flight and a fresh lookup finds nothing.


## Sales orders

- **WMS Status** shows the warehouse's own state for the order (for example new, picking, dispatched, cancelled). It is refreshed on the order page and in the background (the `wms-order-status` job, off by default).
- **WMS Dispatch** (sales list) shows the state of IMS's push: Pushed, Queued, Cancelling, Held, Cancelled, Failed, Pre-cutover or Payload invalid.
- **Cancel the order** to withdraw it from the warehouse. Editing, holding or releasing an order is passed on too; an order the warehouse has already started cannot be pulled back and is raised under Exceptions, with a **Raise a warehouse query** task for you to pass to the warehouse (see below).
- **Refunds.** A refund of a pushed order adds a **Raise a warehouse query** task (IMS writes no note on the Mintsoft order), and on a part refund of an order still new in Mintsoft the lines are amended. When the parcel comes back, Mintsoft's return events are staged in the **Returns Inbox** for you to review. They do not restock anything on their own.
- **Partial shipments** reported by Mintsoft are recorded as shipments on the IMS order and passed on to the storefront.
- **Withdrawals.** An EU withdrawal request holds the order and pulls it back from the warehouse. See [WooCommerce](woocommerce.md).


## Purchase orders, transfers and booking in

- **Create Mintsoft ASN** on a purchase order, or on an in-transit transfer, tells the warehouse what to expect. The button is shown only when the connector is on, and the tooltip says why if it is disabled. The booked-in callback address cannot be sent with the ASN: it must be set up in Mintsoft.
- **Goods are booked in through the ASN, not by hand.** While a line has an ASN that is being created, open, part booked in or booked in but not reconciled, **Receive Goods** refuses that line and names the SKU and ASN. An order with an open ASN also cannot be closed or cancelled, and its lines cannot be reduced or removed, until the ASN is booked in or retired. Details are in [Purchasing](purchasing.md).
- **Receipt Reviews.** A booked-in callback that cannot be applied safely (for example for a cancelled or closed order) is paused here before any stock changes. Review it on the Mintsoft page. **Recheck booked-in** on the order or transfer re-reads the ASN.
- A stock count or alignment that brings units in counts as *landed*: the order will not accept a manual receipt for units already landed.
- **The "Available in Purchase Orders" setting does not apply to warehouse-driven receipts.** Goods the warehouse system books in through an ASN land where the warehouse reports them, even in a location marked **Restricted** under Settings > Inventory > Warehouses. The setting only stops people choosing such a location as a purchase order destination or a **Receive Goods** location in IMS.


## When something goes wrong

### Raise a warehouse query (a query in Mintsoft)

**IMS no longer writes notes (comments) on Mintsoft orders.** The warehouse staff do not read them: only a **query** raised inside Mintsoft reaches them, and Mintsoft's API cannot raise one. Wherever IMS used to leave a note, it now adds a task to **Integrations > Exceptions** under **Raise a warehouse query**, and the count is included in the Exceptions banner. Nothing is sent to Mintsoft for these tasks.

Each task shows the Mintsoft order number, a link to the IMS order, why it was raised and the **copy-ready query text** (order numbers, SKUs and quantities only, with a **Copy text** button). Raise a query in Mintsoft with that text, then press **Done**. Done needs the sync permission and a fresh sign-in, and records who pressed it and when. A task is raised once per fact: pressing Done does not bring it back, but a new hold or cancel of the same order is a new task. The reasons are:

- **Lines removed from a merged order** — IMS took a cancelled or fully refunded order's lines out of the combined Mintsoft order and wants the warehouse to confirm that those lines are gone and nothing else changed.
- **Partial removal: check the lines are gone** — IMS stopped part way, so some of the lines may still be on the combined order. The order's link stays open (so a despatch is still recorded). Ask the warehouse to take the rest out, then press **Done**: IMS reads the Mintsoft order once and **refuses** if any listed line is still there. When every line is gone, IMS closes the link as cancelled in the same step.
- **Courier fallback: verify the courier** — the shipping method did not map to a Mintsoft courier, so the default was used.
- **Hold not honoured** / **Cancel not honoured** — the order is already being picked, packed or despatched (or merged), so IMS could not hold or cancel it.
- **Refund on an order the warehouse already holds** — a full refund (cancel it if not despatched) or a part refund that reduced quantities.

An open task never turns the `wms-order-push` job red; the job's result reports how many are open. A task that IMS could not save is retried on the next run, and the job reports that as a failure. Tasks are removed with their order by the transaction reset, and hold no personal data.

**Integrations > Exceptions** is the inbox for items the warehouse link could not finish. Sections include a maintenance window, blocked order pushes, dead inbound events, despatches that could not be reconciled, unreadable records, order-level drift and order-total mismatches. The order-total check compares what IMS sent with the total WooCommerce charged; it is advisory (it never changes what is sent) and it skips the component check on orders whose lines were edited in IMS (address and notes edits do not count), and both checks on orders with a non-line-allocated discount, because their total cannot be judged exactly. Each row has **Replay** (try again safely) and **Dismiss**, or **Mark as handled** once you have fixed it by hand. A despatch for an order under a withdrawal hold is held back again when replayed. Unreadable records can be isolated so that one bad record does not stop the rest.

### When the warehouse connection fails for everything at once

One order that keeps failing is a problem with that order, so after five failed attempts IMS parks it under **Integrations > Exceptions** for you to look at. When the **connection** is the problem (a change at Mintsoft, an expired key, an outage), every order fails at once, and parking them one by one would take the whole shop out of sync and leave you replaying each of them afterwards.

So IMS looks at the pass as a whole. If at least three orders failed and at least half of the orders it tried failed, it treats it as a connection fault instead: it **parks nothing**, every order stays queued and is retried automatically, and you get **one** notification (and one **WMS connector-wide failure** row under Integrations > Exceptions) rather than one per order. Nothing needs replaying; the row clears by itself on the first pass that works, and the activity log records it.

- This covers the order push (creating and verifying orders in Mintsoft) and the despatch sync. The scheduled job shows as failed while it lasts: that is deliberate, because it did fail.
- It is bounded. If the fault is still there after five passes in a row, IMS goes back to parking the orders that have run out of retries one at a time, tells you so (a second notification, and the row reads "Isolating one by one again"), and those orders appear in the sections above for replay.
- On a very small shop, where three failures can never happen, an outage in which every attempt fails for three passes in a row still raises the same notification.
- Check Mintsoft (status page, API key, the connection test under Settings) and fix the cause. You do not need to do anything to the orders.

### Possible double postage on merged orders

When Mintsoft merges several orders into one parcel and more than one of them charged the customer postage, the customer may have paid postage twice. IMS cannot decide that for you and **never refunds it automatically**. The absorbed order appears under **Integrations > Exceptions** in **Merged orders - possible double postage**, with the orders in the merge and the amount each charged. The flag is only raised when at least two live (not cancelled) orders of the merge charged postage above zero. It is for you, not the warehouse: IMS writes nothing to Mintsoft and adds no warehouse query task for it.

Check the orders, refund the extra postage by hand if it is due, then press **Clear**. Clear needs the sync permission and a fresh sign-in, and the activity log records who cleared it and what the flag said. The flag is raised again only if Mintsoft merges the order into a further order and the rule applies again.

### Merge candidates: same-customer orders still New in Mintsoft (off by default)

When the same customer has two or more open orders for the same delivery address and Mintsoft still shows all of them as **New**, one parcel could ship instead of several. **IMS never merges orders**: Mintsoft has no merge function IMS can call, so merging stays a manual step in the Mintsoft screens. This feature only tells you which orders to look at.

It is **off by default** and nothing described here happens until you switch it on in **Integrations > Mintsoft > Merge candidates** (setting `wms_merge_candidate_mode`: **Off** or **Flag**; any other value, including the reserved `hold`, counts as Off). A hold mode, which would hold the orders in Mintsoft until they are merged, is not built.

With **Flag** on, IMS checks after it pushes orders and after every order-status refresh. Orders are grouped when they have the same billing email and the same delivery address (street lines, city, postcode and country; case, spacing and punctuation are ignored; the billing address is used when there is no shipping address), they are all still open in IMS, and the Mintsoft order of each is **New** according to the status IMS last read. IMS makes no extra call to Mintsoft to decide this. NI, JE, GG and IM count as the UK. Left out: orders with a backordered line, orders with a pending or approved withdrawal, held, shipped, cancelled or fully refunded orders, and orders Mintsoft already merged into one (they count once). Three or more orders form one group.

What you see for a group:

- a **Mergeable with ...** badge on each order, linking to the others;
- an entry in each order's activity log;
- the group in the list under **Integrations > Mintsoft > Merge candidates**;
- ONE task for the group under **Integrations > Exceptions > Raise a warehouse query**: check these orders in Mintsoft and merge them there if appropriate. IMS writes no note on the Mintsoft or WooCommerce order for this, because the warehouse does not read notes. If the group stops qualifying (an order leaves New, ships, is cancelled or its address changes) IMS resolves the task itself. If you press **Done** first it stays done.

Warnings are added to the task and the badge: an **EU destination** needs the customs declaration and IOSS number checked before merging, and a group that ships by **FedEx** needs its label created by hand. Switching the mode back to Off stops new flags but does not remove open tasks: mark them Done.

### Holds, cancels and merged orders

- **A hold or cancel Mintsoft cannot honour.** If the order is already picking, packing or despatched, or Mintsoft merged it into another order, IMS cannot cancel it there. It stays live, shows under Exceptions as **Hold not honoured** or **Cancel not honoured**, and a **Raise a warehouse query** task is added for the warehouse (IMS writes no note on the Mintsoft order). A despatch after a hold is recorded as normal. A despatch after a cancel, or after a full refund while the order was still undespatched, is not recorded automatically: it appears as a stuck despatch for you to decide what happens to the goods.
- **Merged orders.** IMS never cancels a combined (merged) Mintsoft order on behalf of one of the orders in it. When it finds the merge, the order link points to the combined order. If the order is then cancelled (or fully refunded) in IMS and the combined order is still New or On backorder in Mintsoft, IMS takes out exactly that order's lines for you: it deletes only the lines it recorded when it sent the order, checks the combined order again after each one, adds a **Raise a warehouse query** task naming the order and the lines, and marks the order's link cancelled (the task is recorded first, so a link is never closed without it). The other order's lines are never touched, and if the cancelled order's lines are the only ones left, the combined order is cancelled normally. A hold only raises the notice.
- **When IMS cannot take the lines out.** If the combined order is already picking or despatched, if the order was sent before IMS recorded its Mintsoft line ids, if a line is missing or its SKU or quantity is not what IMS sent, or if a delete or re-check fails, IMS stops and shows **Cancel not honoured** with the exact SKUs, quantities and Mintsoft line ids to take out by hand. If some lines were already removed, the notice and its query say which were removed and which are still on the combined order. With the Mintsoft write grant off, IMS sends nothing.
- **A change to an order Mintsoft has already started (past New).** If you change an order in IMS after the Mintsoft order has left **New**, Mintsoft cannot take the change and IMS sends nothing. IMS records this as a **Refused or stalled action** on **Integrations > Exceptions**, with the lines it wanted the Mintsoft order to hold, the Mintsoft status and how long it has stood. How serious it is depends on what changed: a change to the **lines** (a SKU or a quantity) is *Serious*, and IMS also adds a **Raise a warehouse query** task giving those exact lines; a change to anything else (a note, a VAT number, a price) is *Low impact*, is listed and never raises an alert or a task. A serious one that has stood for two hours raises one alert to the admins. Pressing **Done** on the query task only records that you raised the query: the row stays open until IMS reads the Mintsoft order back and its lines match what IMS wanted, or the order no longer needs the change (cancelled, despatched or completed). IMS writes nothing on the Mintsoft order.
- **A split order with a cancelled part.** If Mintsoft split an order into parts and cancelled one (usual when you ship that part yourself from elsewhere), Mintsoft will never report that part despatched, so IMS cannot see the order complete. It shows under **Refused or stalled actions** as *Split order cannot complete* and raises one alert after 24 hours. Complete the order by hand once the cancelled part has shipped. After several checks IMS stops polling the order and tells the admins; it never holds back the sync for other orders.
- **A change to an order Mintsoft has merged.** If you change an order in IMS after Mintsoft merged it into another order and before IMS had noticed, IMS does not amend the combined order (that would alter the other order's lines). The order shows under Exceptions as **Change not sent to the warehouse (merged order)**: apply the change in Mintsoft by hand, then press **Acknowledge** to clear the row. IMS does not retry it.
- **A change when the Mintsoft order number no longer matches.** If the Mintsoft order no longer carries the number IMS sent (it was merged without Mintsoft marking it, or renamed), IMS sends nothing and shows **Change not sent to the warehouse (order number mismatch)** once, naming the number Mintsoft now shows. Check what happened in Mintsoft and apply the change by hand, then **Acknowledge**. The order stays linked and the change stays due, so IMS sends it itself once the number matches again (or handles it as a merged order if Mintsoft marks it merged); a successful send clears the row. If you acknowledge while the number still differs, the row comes back on the next sweep.
- **A hold, cancel or change IMS cannot verify.** Before IMS holds, cancels, or changes an order (or takes lines out of a merged one) it checks that the Mintsoft order still carries exactly the number IMS sent. If the number is missing, or is different (even a combined number such as `A+B` that Mintsoft has not marked as merged), IMS sends nothing and leaves the order linked, with **Hold not honoured** / **Cancel not honoured** (or **Change not sent to the warehouse (order number mismatch)**) naming what Mintsoft shows. Check the order in Mintsoft, act there by hand if needed, and acknowledge a change notice. A hold or cancel notice shows once, and it now comes with a **Raise a warehouse query** task ("check the warehouse order and act"); the same task is raised when Mintsoft no longer returns the order and IMS cannot prove a merge, and the notice is not treated as settled until that task is recorded; a change stays due and is sent by IMS itself once the number matches.
- **A merge IMS cannot prove.** When Mintsoft no longer returns an order and a combined order (for example `A+B`) lists its number, IMS follows the merge only if the combined order really holds the lines IMS sent for that order. If it does not (another customer's merge can list the same number), or IMS has no record of the order's Mintsoft lines (an order sent before IMS recorded them), IMS leaves the order as it was and shows **Hold not honoured** / **Cancel not honoured** saying a possible merge could not be proven. Check it in Mintsoft.
- **An order Mintsoft cancelled while IMS still treats it as live.** If Mintsoft shows an order as cancelled, deleted, voided or rejected (and not despatched) while IMS has it as processing or allocated, it will never ship. IMS opens a **cancelled in wms** row in the order-level drift section of Integrations > Exceptions and alerts admins once. IMS changes nothing itself: it does not cancel the order, release its stock, refund it or touch the invoice, it leaves the link as it is, and it will not push the order again (there is no Re-push for this row). Ask the warehouse why, then cancel or refund the order in IMS, or have it reinstated in Mintsoft. The row closes when the order is despatched, or when you cancel, hold, refund or complete it in IMS.
- **A second courier fallback for the same method.** Each time an order newly falls back to the default courier it gets its own **Courier fallback: verify the courier** task, even if an earlier one for the same method was already marked done. Retrying the same fallback never adds a second task.
- **Not found.** If Mintsoft no longer returns the order after a hold or cancel, IMS checks whether it was merged. If the check cannot settle it, it retries for 5 sweeps and then raises a notice. It never records an order as cancelled or held because Mintsoft returned "not found".
- **Create outcome unknown.** IMS links the order to one Mintsoft already holds only when it matches this order's number and IMS's own reference exactly and is live; **Replay** does the same check. Otherwise the row says why: it is cancelled in Mintsoft (a cancelled order keeps its number), there are several matches, or it was merged into another order. For a merged one the row names the combined order and tells you not to cancel it.
- **Notices clear themselves** when the IMS order leaves the held or cancelled state (their query tasks stay until you press Done). A task that could not be saved is added again automatically on a later run.

Also see:

- Overdue ASNs and stale stock syncs raise a warning on their own (the `wms-watchdog` job, on by default).
- **Open Discrepancies** on the Mintsoft page for stock, code and bundle differences.
- Webhook signature errors and credentials: [Troubleshooting](troubleshooting.md).
- Erasing a customer whose orders are still open at the warehouse: [Personal-data Erasure](erasure.md).


## Not covered here

Reconciliation checks that compare Mintsoft with IMS on-hand stock are an administrator tool that runs outside the application and are not part of day-to-day use.
