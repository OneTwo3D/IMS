# WooCommerce Live Verification Runbook

Use this runbook for scoped stage/live WooCommerce verification after connector changes. It is designed for webhook-first operation where WooCommerce should push changes to IMS immediately, with cron acting only as backup reconciliation.

## Preconditions

- WooCommerce connector is configured in IMS
- A successful **Test Connection** has been recorded against the current WooCommerce credentials in IMS (Sync → WooCommerce → Test Connection). Without this, sync is gated off and webhook deliveries are accepted but not processed against state — the connection test gate is a hard precondition, not a checkbox.
- Initial WooCommerce order import has already completed
- WooCommerce order/product webhooks are configured and signing correctly
- At least one IMS warehouse intended for WooCommerce fulfillment has **Sync to WooCommerce** enabled
- If testing live webhook delivery on stage, be aware of the current caveat:
  - the stage WooCommerce Action Scheduler may not auto-drain webhook jobs reliably
  - when that happens, force only the generated action IDs for the specific test event

## Writeback hold: before IMS may write to a store

<!-- outbound-write-hold:overview -->
IMS refuses every request that could change something in WooCommerce, Mintsoft or Xero unless the environment of this installation names the one destination it may write to. The refusal is made at the HTTP boundary that every connector request goes through, on every request and on every redirect hop, and the default is to refuse. The permission is read from environment variables only and never from the database, so a restored backup, a cloned installation or a new checkout does not inherit a permission that was granted to a different installation. A value that cannot be read is not a permission. Reading is never held: only requests that could change something are.
<!-- /outbound-write-hold:overview -->

<!-- outbound-write-hold:wc-grant -->
Before IMS may write to a WooCommerce store, set WC_WRITEBACK_ALLOWED_ORIGIN to the origin of that one store (exactly one store origin, for example https://shop.example.com) in the environment of the installation that owns writeback for it, and restart that installation. An installation that must not write to the live store - every development, stage, end-to-end and rehearsal installation, and the production installation during the period in which IMS only reads - leaves it unset. The origin is compared with the store URL of each request, including after a redirect, so pointing an installation at a different store does not carry the permission across.
<!-- /outbound-write-hold:wc-grant -->

<!-- outbound-write-hold:held-meaning -->
A held write is a hold on this installation and not a rejection by the destination. The request is refused before it leaves IMS, so nothing is sent to the destination, and the work that wanted to write is reported as failed with text that begins "Outbound write HELD". A held write is never recorded as sent, accepted or rejected by the destination. Every such message ends with a short reference in square brackets (`[hold-ref ...]`) that is derived from the settings encryption key of the installation, so every process agrees on it and it survives restarts; it is bound to the exact text it ends, so it cannot be copied onto another message, and IMS does not write hold or error text into anything it sends to a destination: a census test scans every source file for the common shapes of such a write (comment and note writers and free-text payload fields built from a caught error), so a destination should never be sent a text it could echo back. That census is syntactic; it does not follow text through helper functions, closures, object spreads or computed keys. The residual is stated plainly: a person who copies a complete hold text into a free-text field by hand, or a code path of a shape the census does not cover, could put one in front of a destination; the reference prevents only forgery and moving a reference onto other text. It is how IMS tells its own hold text from text a destination sent, within the limits just stated. Without that key no failure is recognised as a hold, and the log says so once. Queues that bound their retries (the WooCommerce and Xero outboxes, the Xero sync log, the Mintsoft order push and the WMS dispatch reconcile) do not spend an attempt on a held write and never dead-letter it, however long the hold lasts: the work stays queued and is offered again every 15 minutes. Pushes that have no queue (the WooCommerce product metadata and WMS status pushes, tracking pushes made outside order completion, and exchange-rate pushes) are not retried by the hold; they are reported in the log and run again at their next trigger. The exception to "nothing was sent" is a redirect: when the destination redirects a request that was granted and the next hop is refused, the first request had already been sent and may have taken effect. That refusal begins "Outbound write REFUSED AFTER A REDIRECT", is not a hold, and is treated like any other failure of unknown outcome: it spends an attempt and can be dead-lettered for an operator to check.

A refused login after an HTTP 401 is a pure hold only when that 401 came straight back from the original request with no redirect followed (Mintsoft rejects an unauthenticated request before it processes it); a 401 after a followed redirect, or whose redirect count is unknown, may follow a request that took effect, so it is handled as an uncertain outcome, not as a hold. A gateway or proxy in front of Mintsoft that answers 401 after Mintsoft processed the request cannot be excluded; that is an accepted inter-system limit. Mintsoft's key-minting login (`POST /api/Auth`, which issues a new tenant API key and invalidates the old one) is a write and is held. While the producer-side hold is enforced for Mintsoft and the installation is not in its live phase, IMS refuses it before sending it, whatever grant is present (reads continue on a stored or fixed key; an expired stored key is not renewed). Otherwise it is granted only by a third part of the Mintsoft variable, `|login=<username>`, and only for requests that carry exactly that username (and the granted ClientId). An installation that authenticates to Mintsoft with a username and password and has no such grant cannot renew its token while held, so its reads stop once the stored token expires; use the fixed API key mode on any installation that is held. Xero's token exchange (`POST https://identity.xero.com/connect/token`, https only, exactly that path, on every redirect hop) is allowed as a deliberate exception: it rotates IMS's own Xero credentials but changes no accounting data, and every Xero read depends on it. Every Xero write must reach `api.xero.com` on every hop; a redirect to any other origin is refused before the body is sent.
<!-- /outbound-write-hold:held-meaning -->

### Producer-side hold for WooCommerce (before the grant, and after it)

The grant above is the transport's permission. A second, earlier check decides whether IMS should PRODUCE a WooCommerce write at all: when `PRODUCER_HOLD_ENFORCED_DESTINATIONS` names `woocommerce`, a write is produced only once both `WC_WRITEBACK_ALLOWED_ORIGIN` and `WC_WRITES_LIVE_FROM` are in force and the ownership map says IMS owns that operation. Until then every WooCommerce write IMS would have made (stock, order completion, cancel and hold, tracking, partial shipments, the WMS-status note, product details, exchange rates, the FX helper check, webhook registration, the invoice note) is kept as a shadow record and nothing is queued or sent; the queue drains for stock, order completion, cancel and hold claim nothing and spend no attempts. Stock stays Qoblex's and exchange rates stay with the Aelia plugin until their live-from instant. The forced stock push also stays behind the "Push stock levels to WooCommerce" setting. Check the posture of an installation before and after switching anything on: with the hold on and no live-from instant, a stock change, a shipment or a button press must leave `integration_outbox` unchanged and add or count a row in `outbound_shadow_writes` with destination `woocommerce`. See "Producer-side hold" in the installation guide for the variables and `help-docs/woocommerce.md` for what an operator sees.


### Single-writer cutover: handing writeback from the legacy bridge to IMS

Exactly one writer may write partial shipments, tracking, order status and the WMS-status meta on a store at a time. While IMS and the legacy bridge (the woo-mintsoft plugin and its Python sync) both write, customers get duplicate partial-shipment records and duplicate despatch emails, which cannot be taken back. Nothing here is executed by an agent; the operator runs each step and stops at the first failing check. This section follows `lib/security/writer-ownership-map.ts` phase by phase; where that map does not decide something, it is listed under "Open questions" and nothing is invented.

The interlock is enforced in three places and read by one command, `npm run writers:check`:

1. IMS side, produce: the producer hold (`PRODUCER_HOLD_ENFORCED_DESTINATIONS` names the destination) with the ownership map. IMS produces a write only when it owns that operation in the destination's phase and both the destination's grant and live-from instant are set. Everything else is recorded as a shadow and nothing is sent.
2. IMS side, send: the transport hold refuses any write the grant does not name, on every redirect hop.
3. Storefront side: the helper plugin (1.5.0 or later) answers a signed read-only `GET /wp-json/oti/v1/incumbents` (the check makes this one call per run, hourly when the scheduled job is on) with whether the bridge, Xeroom and IOSS/Xero plugins are active, by exact plugin slug (folder `woo-mintsoft`, `xeroom`, `o3d-ioss-xero`; adjust with the `oti_incumbent_plugin_slugs` filter if the store's copies are named differently, which must be confirmed on the live store). `writers:check` fails (`incumbent-plugin-active-vs-ims-writer`) only when the map gives an operation to IMS in the current phase, the plugin writes it today (it owned it in P1) and IMS can write it. A plugin the map keeps for good (Xeroom owns sales invoicing in P1 and P2) is never asked to stand down. If the store cannot be asked, or the installation does not ask (the WooCommerce plugin is off, or the store URL or webhook secret is unset), the check reports unreadable: an error when IMS can write an operation an incumbent plugin writes, a warning otherwise.

**What the map says changes at each destination's live-from instant**

- Mintsoft (`MINTSOFT_WRITE_ALLOWED` plus `MINTSOFT_WRITES_LIVE_FROM`): the bridge is the P1 owner of Mintsoft order create, amend, cancel and hold and of product upsert, content, delete and bundle; IMS owns them in P2. The bridge is the only thing creating warehouse orders in P1, so it must not be stopped before IMS is creating them. Mintsoft is LIVE (real goods).
- WooCommerce (`WC_WRITEBACK_ALLOWED_ORIGIN` plus `WC_WRITES_LIVE_FROM`): this is one switch for the whole destination, not only the bridge's writeback. At live-from the owner of each of these rows becomes IMS: order status, tracking, partial shipment, trackship-refire and product meta (bridge in P1), stock (Qoblex in P1), invoice note and invoice document (Xeroom in P1), WMS-status meta and webhooks (nobody in P1), and tax rates (operator by hand in P1). Order withdrawal-outcome and trackship-reconcile stay with the plugin in P2. Exchange rates stay with Aelia in both phases. Stock follows the "Push stock levels to WooCommerce" setting as well.
- Status, tracking and partial shipment are written only for changes made after live-from (the map marks them as needing the business-event time).

**Order of the switch** (stop at the first failing check):

1. Baseline, nothing granted. Install helper plugin 1.5.0 or later. Run `npm run writers:check`. It must be ok, with the bridge reported ACTIVE and IMS able to write none of its operations. Run `npm run outbound:status`: every destination held.
2. Stop the other WooCommerce stock writer first. Before the WooCommerce live-from instant, stop Qoblex's stock push to the store, or leave `wc_stock_sync_enabled` and the "Push stock levels" setting off until it is stopped. `writers:check` cannot see Qoblex, so this is a manual check by the operator. The same applies to product meta (the bridge's pushes stop in step 5) and to the invoice note and document (Xeroom's, which the owner replaces at P2; see the open questions).
3. Mintsoft first. In one change, set the Mintsoft grant and live-from instant (a prepared instant) in the environment of the one installation that owns the store, and restart it. From that instant IMS creates the warehouse orders, as the bridge does today, so for a short overlap both can create the same order. Before this step prove existing warehouse orders are adopted, not duplicated (see o3d-zvec.22: the Mintsoft OrderNumber must equal what the bridge used). Run `npm run writers:check`: expect a failure (`incumbent-plugin-active-vs-ims-writer` on the Mintsoft order operations) while the bridge is still active. That failure is the overlap the check exists to show; keep the overlap as short as the verification allows, then continue at once.
4. Bridge's Mintsoft writers off. Stop the Python bridge's order push and merge/hold sweeps (the ones that create, amend, cancel and hold Mintsoft orders). Count orders paid since the live-from instant that have no Mintsoft order and fix each by hand before going on.
5. WooCommerce live-from, set at or before the moment the bridge's WooCommerce writers stop, so there is no window where nobody writes status, tracking or partial shipments. Set `WC_WRITEBACK_ALLOWED_ORIGIN` and `WC_WRITES_LIVE_FROM` together in the same change (exactly one of them leaves the destination held and `outbound:status` says so), restart, then stop the bridge's order status, tracking, partial-shipment and product meta writers. If a past instant is not accepted by the obligation logic, instead list the orders despatched between the two moments and push them deliberately; do not leave them.
6. Verify no double write. Run `npm run writers:check` (must be ok except for the open questions below) and `npm run outbound:status`. Ship one test order created after the live-from instant and check: exactly one partial-shipment row, one tracking entry, one despatch email in the mail log, one Mintsoft order, and no `_mintsoft_*` meta written after the instant.
7. Record the evidence (check output, order number, the counts above) with the date and the operator.

Stop condition: any non-zero exit from `writers:check` other than the expected overlap in step 3, a second partial-shipment row, a second despatch email or a duplicate Mintsoft order. Stop, then roll back.

Rollback, in the reverse order:

1. Unset the WooCommerce grant and live-from and restart. IMS shadows every WooCommerce write and sends nothing; queued stock, completion, cancel and hold rows stay queued and are not retried. Restart the bridge's WooCommerce writers immediately after, so there is again exactly one writer.
2. Unset the Mintsoft grant and live-from and restart, then restart the bridge's Mintsoft order push. Orders paid while IMS alone was live are in Mintsoft already; orders paid in any gap with no writer are not. Find them (paid after the live-from instant, no Mintsoft order) and create them by hand.
3. Run `npm run writers:check` and confirm ok.
Never restart a bridge writer while the matching IMS grant is set: the check reports a double claim.

What rollback does NOT undo: rows, emails, Mintsoft orders and meta IMS already wrote while it was live; shadow records in `outbound_shadow_writes` (evidence, not work to replay); a duplicate customer email that was already sent.

**Open questions for the owner (the map does not decide these; nothing here is assumed)**

1. The map keeps withdrawal-outcome and trackship-reconcile with the woo-mintsoft plugin in P2 ("the endpoint stays in the WooCommerce plugin"). That means the plugin cannot simply be deactivated at the end: either those two routes move into the helper plugin, or the plugin stays active with only its writers off. Until decided, the check would report the plugin as active; the check does not distinguish a bridge with its writers off from an active one.
2. Xeroom and the IOSS/Xero plugin stay active in P2 (Xeroom owns sales invoicing for good). The map nevertheless gives the WooCommerce invoice note and invoice document to IMS in P2 while Xeroom writes them today. Whether Xeroom's note and document output is switched off in the plugin's own settings, or IMS's are, is undecided. The check reads Xeroom's per-order markers as evidence for this, not whether the plugin is active.
3. The exact plugin folder names on the live store (the slugs above) are assumptions until confirmed.
4. Order of the stock switch relative to the Qoblex stop (step 2) is a manual control; there is no machine check for Qoblex.

## 1. WC → IMS product create/update

1. Create or edit a product in WooCommerce with a stable SKU.
2. Confirm the relevant `product.updated` webhook is queued or fired.
3. If stage webhook delivery stalls, force only the generated action for that product update.
4. In IMS:
   - open **Sync → WooCommerce → Sync Log**
   - confirm a recent `FROM_CONNECTOR` product sync entry exists
   - open the product in Inventory and verify the expected fields changed

Expected result:

- IMS product import/update completes without manual cron intervention
- WooCommerce product data appears in IMS

### 1a. Category mirror

Use this to confirm the WC product-category tree mirrors into IMS during product sync.

1. In WooCommerce, place the product under a nested category (e.g. `Apparel > T-Shirts > V-Neck`). If any of those segments do not exist yet on the WC side, create them with the right parents.
2. Trigger a product sync (edit + save the product so the `product.updated` webhook fires, or force the action ID).
3. In IMS:
   - open **Settings → Inventory → Product Categories** and confirm all three segments now exist, with the correct parent chain
   - open the synced product in Inventory and verify the **Category** field reads the full path (`Apparel > T-Shirts > V-Neck`)
4. Now move the product in WooCommerce to a different category at the same depth (e.g. `Promo > T-Shirts`) and re-sync.
5. Confirm the IMS product's Category updates to the new path and the original tree remains in IMS (we never delete mirrored categories — only add and link). Both `Apparel > T-Shirts` and `Promo > T-Shirts` should coexist as distinct rows.

Expected result:

- the WC category tree appears in **Settings → Inventory** with parents preserved
- the product is linked to the deepest WC category it carries
- repeated leaf names under different parents remain distinct
- a transient WC categories-endpoint failure does not wipe the existing IMS `categoryId` link

## 2. WC → IMS order create/update

1. Create a WooCommerce order in a status included by IMS order sync.
2. Confirm the `order.created` / `order.updated` webhook fires.
3. If stage webhook delivery stalls, force only the generated action for that order event.
4. In IMS:
   - open **Sales**
   - locate the imported order by WC number or customer
   - verify line items, prices, status mapping, and customer details

Expected result:

- the order appears in IMS once
- later WC edits update the existing IMS order rather than creating duplicates

## 3. IMS → WC product metadata push

1. Open an IMS product that is already linked to WooCommerce.
2. Edit one or more outbound product fields in IMS, such as:
   - name
   - description
   - regular price
   - sale price
3. Trigger the outbound product push path used by the UI/workflow under test.
4. In WooCommerce:
   - refresh the product edit screen or fetch the product via REST
   - verify the edited fields match IMS
5. In IMS **Sync Log**, confirm a recent `TO_CONNECTOR` product sync entry exists.

Expected result:

- WooCommerce reflects the IMS product metadata change
- a `TO_CONNECTOR` product sync record exists in IMS

## 4. IMS → WC tracking push

1. Import or create a WooCommerce-backed order in IMS.
2. Process it through shipment creation.
3. Ship the parcel in IMS with a carrier and tracking number.
4. Confirm the shipment shows as shipped in IMS and the tracking number is visible.
5. Optionally edit the tracking on the shipped shipment in IMS and save again.
6. In WooCommerce:
   - refresh the order admin screen or fetch the order via REST
   - inspect `_wc_shipment_tracking_items`
   - verify the tracking number and carrier match the latest IMS values
7. In IMS:
   - confirm a recent `TO_CONNECTOR` `SalesOrder` sync log entry exists for tracking push
   - confirm no duplicate IMS order/shipment mutation was caused by the reflected WC webhook

Expected result:

- WooCommerce order meta contains the latest IMS tracking
- repeated saves are safe
- reflected `order.updated` webhook events are suppressed rather than re-processing the order

## 5. Customer-facing invoice PDF download

This check follows the switch-on, overlap and rollback procedure in [ops/invoice-documents-switchover-runbook.md](ops/invoice-documents-switchover-runbook.md); do that first.

1. Pick an IMS-generated invoice for a WooCommerce-backed order.
2. From the WC storefront, sign in as the order's customer and open the order page.
3. Click **Download Invoice**.
4. Verify:
   - The download link is served via the **onetwoInventory Helper** WordPress plugin (`onetwoinventory-helper.php`; older notes called it `wc-invoice-handoff`) and is not a direct IMS URL.
   - The token used by the handoff is single-use and scoped to that customer + order.
   - The PDF streams back through the storefront, not via an IMS login redirect.
5. Repeat the download from a different network/incognito session as the same customer to confirm a fresh token is issued for each request.
6. Attempt to download as a different customer or while signed out — both must be rejected.
7. In IMS, confirm the activity log carries `invoice_pdf_customer_download` entries with the WC order id, not the customer's credentials.

Expected result:

- the customer can download their own invoice without an IMS account
- tokens cannot be replayed across customers, sessions, or networks
- redacted activity-log entries record each access for audit


## 6. Pending FX retry queue

1. Force a WooCommerce order in a foreign currency for which the FX rate is intentionally missing (e.g. a currency with no `FxRate` row for the order's `paidAt` date).
2. Observe the sync attempt:
   - The order is recorded in `wc_pending_fx_orders` with the missing rate's date and currency.
   - Sync is deferred (no half-finished journal posting).
   - An activity-log entry `wc_order_pending_fx` is written.
3. Populate the missing FX rate and drain the queue by running `GET /api/cron/fx-rates`: it fetches the rates, upserts them, and then automatically re-attempts any orders queued for a previously-missing rate (`retryPendingWcOrdersWaitingForFx`).
4. If you instead upserted the rate by hand, run `GET /api/cron/fx-rates` (or wait for the scheduled fx-rates cron) to re-attempt the queued orders — there is no separate retry route.
5. Confirm:
   - The pending row is drained and the order syncs to Xero with the now-available rate.
   - The activity log records `wc_order_fx_retry_succeeded`.
   - No duplicate journal entries appear in Xero.

Expected result:

- missing-rate orders are queued, not silently failed
- once the rate appears the order syncs idempotently on the next retry pass


## 7. Backup reconciliation check

Use this only to validate the backup path, not as the primary success criterion.

1. Trigger `GET /api/cron/wc-reconcile`.
2. Confirm it:
   - reconciles orders/products only when due or when webhook-primary mode is inactive
   - drains queued stock retry jobs
   - force-pushes a current stock catch-up snapshot when the daily stock reconcile is due, one window of the catalogue at a time: a run that stops with `reconciliation_continues_next_run` has saved its cursor (`wc_stock_daily_reconcile_cursor`) and the next run carries on from it; the daily stamp is written only after the last window

Limits of the windowed stock catch-up:

- A window counts as done only when every product in it completed without any error. If any SKU lookup, preflight page or push entry fails, a mapping cannot be saved or is cleared, two products share one WooCommerce id, or a kit's availability cannot be computed (a kit cycle), the cursor stays, no daily stamp is written, the next run retries the same window, and each such run writes a `stock_reconcile_window` WARNING to the activity log with the first errors. A product that keeps failing therefore holds the pass at its window until it is fixed (or the manual stock push is used); the log line is the signal.
- The saved cursor carries the WooCommerce settings version. After a credentials rebind or a product-id cache reset the next run drops it and starts the pass again from the beginning (still unstamped until the pass finishes).
- A run refused before its first window is handled (stock sync disabled, credentials missing, no sync warehouses) writes no daily stamp and reports `reconciliation_refused`, so the pass is due again on the next run once the configuration is restored.
- The candidate list is read fresh for every window, in id order. A product that becomes eligible (new SKU, status change, first stock) with an id before the cursor is not picked up until the next full pass.

Expected result:

- backup reconciliation behaves as a safety net, not the main sync mechanism
- if live order webhooks were skipped during the initial-import window, the first reconcile after initial import completion backfills them

## Evidence to capture

- IMS sync log screenshots or timestamps
- WooCommerce order/product screenshots or REST responses
- Exact SKUs, WC order IDs, and tracking numbers used in the run
- Whether webhook jobs auto-drained or had to be forced manually
- For the first load: the JSON report of `npm run rehearse:woo-import` run on the commit being deployed (see `docs/installation.md`, "WooCommerce initial-import rehearsal"), and the resolved order-status list the Sync page prints before **Import Active Orders** is pressed
