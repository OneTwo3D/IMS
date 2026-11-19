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

The grant above is the transport's permission. A second, earlier check decides whether IMS should PRODUCE a WooCommerce write at all: when `PRODUCER_HOLD_ENFORCED_DESTINATIONS` names `woocommerce`, a write is produced only once `WC_WRITEBACK_ALLOWED_ORIGIN` and the live-from instant of the operation's switchover step are in force and the ownership map says IMS owns that operation. The live-from instant is per step, not per destination: the order status, tracking, partial-shipment, product-meta, withdrawal-outcome and TrackShip writes go live with step M (`MINTSOFT_WRITES_LIVE_FROM`, because the bridge that is retired there wrote them), stock, webhooks and customer e-mail with step W (`WC_WRITES_LIVE_FROM`), and the invoice note and document with step X (`XERO_WRITES_LIVE_FROM`). Turning on `wc_stock_sync_enabled` is refused until an administrator has recorded the owner's confirmation that the Qoblex stock push is stopped (`npm run writers:attest`, or the Owner confirmations page at `/sync/writer-confirmations`). Until then every WooCommerce write IMS would have made (stock, order completion, cancel and hold, tracking, partial shipments, the WMS-status note, product details, exchange rates, the FX helper check, webhook registration, the invoice note) is kept as a shadow record and nothing is queued or sent; the queue drains for stock, order completion, cancel and hold claim nothing and spend no attempts. Stock stays Qoblex's until step W and exchange rates stay with the Aelia plugin throughout. The forced stock push also stays behind the "Push stock levels to WooCommerce" setting. Check the posture of an installation before and after switching anything on: with the hold on and no live-from instant, a stock change, a shipment or a button press must leave `integration_outbox` unchanged and add or count a row in `outbound_shadow_writes` with destination `woocommerce`. See "Producer-side hold" in the installation guide for the variables and `help-docs/woocommerce.md` for what an operator sees.


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

---

# Single-writer switchover: steps M, W and X

This part is the operator runbook for moving every writer from the legacy stack (the Python bridge and its WordPress plugin `wc-mintsoft-sync`, Xeroom, Qoblex) to IMS. It is the written, reversible cutover the interlock needs. The design is `shared/design-zvec3-switchover.md`; the owner's answers of 2026-11-18 (section 9 of it) supersede its text and are built in below.

**Status when this was written (2026-11-19).** Nothing here has been run. IMS is in P1: wired to the live stores, reading, writing nothing. Do not follow this runbook before the dates and gates in "Global gates" are met.

## Who does what

| Marker | Who | Meaning |
|---|---|---|
| **[OWNER]** | the owner | A decision, a confirmation in a system IMS cannot see (Qoblex, Mintsoft's user list), or an approval. Nobody else may do it or sign it off. |
| **[OPS]** | operations | Every action on a production host, store or environment file. Production steps go through ops, never through an agent. |
| **[CLAUDE]** | Claude or another agent | Read-only checks, preparing records, drafting commands, stage work and reviews. An agent makes no live WooCommerce, Mintsoft or Xero write and runs nothing on production. |

Every command below is run by **[OPS]** unless it says otherwise. IMS commands run from the IMS install directory as the IMS service user, with the production environment loaded (`/etc/ims/ims.env`), so that `PGPORT` and other stray variables are not in the shell: export only what the command needs. Never print a credential, a signed URL or a response object that embeds a token: print status codes and counts only.

## Global gates (before any step)

- [ ] **[OWNER]** The go/no-go verdict (o3d-hcx4c.1) is YES: 14 consecutive clean daily reconciliation runs including a month-end. Dates fixed by the owner on 2026-11-18: the clean runs can start on 2026-12-12 at the earliest; the first month-end in reach is 2026-12-31, so the streak runs through it; the earliest verdict is 2027-01-01. Step M is then the first working days of January; step W is at least one soak after M, and step X at least one soak after W.
- [ ] `PRODUCER_HOLD_ENFORCED_DESTINATIONS=all` has been in force throughout P1 (see the producer hold above).
- [ ] `npm run writers:check` has exited 0 on every day of the qualifying window.
- [ ] The o3d-8f0p6 fix is verified and not enabled.
- [ ] The stage proof (below) has passed and its record is attached to o3d-zvec.3. Without it step M is not scheduled.
- [ ] The open enablement beads for each step (see "Beads to close first") are closed.
- [ ] Each step has a named person on call for its soak, and a roll-back decision-maker.

**Soak.** Each step soaks for **3 days** (owner answer 7) with `writers:check` exiting 0 throughout and none of the step's stop conditions hit. A rollback of a step restarts its count. The bead note of 2026-11-18 first said "3 business days" and the final answer says "3 days": take the longer reading unless the owner says otherwise. The next step does not start while the previous one is unstable.

**Fixed order: M, then W, then X, a few days apart. Each is reversible on its own** (X only with consequences, see its rollback).

## Beads to close first

`bd list` was checked on 2026-11-19; re-run `bd list --status open` before scheduling, since the list moves.

| Before | Bead | What it gates |
|---|---|---|
| M | o3d-9zh3c | Withdrawal outcome: the PR #1058 round-3 findings. Needed before `wc_withdrawal_outcome_enabled` is turned on (alias-on-matching-generation and the operator-task dedupe basis are MEDIUM; the capture-gate, unlocked option map, id-0 meta entry, HPOS echo and G_despatch lows ride along). |
| M | o3d-hsrsi | PR #1058 round-1 lows: a queued invoice note that fails after the switch is turned off (clean up those `WC_INVOICE_NOTE` rows by hand or fix), the held-until-step-M dependency on the enforcement variable, stock-drift explain/acknowledge (the last one is needed before W; see step W). |
| M | o3d-j8d7l | `wms_merge_hold_enabled` on stage then live. Verify first that the live Mintsoft status for an order awaiting confirmation is `AWAITINGCONFIRMATION` (`docs/mintsoft.md`, controlled run step 3). IMS owns merge-candidate flag and hold from step M, so the switch must already be proven. |
| M | o3d-s5ljn | `wms_mixed_warehouse_push_enabled` (owner decision 2026-11-18: stage first, single-warehouse payload comparison, review, then decide production). While off, the fail-closed refusal for mixed-warehouse orders stays in force. |
| M | o3d-k6quj | The live store's registered order statuses audited; every pre-despatch custom status has a mapping row. Otherwise the first real despatches dead-letter as unknown status. |
| M | o3d-zvec.22 | The legacy-state import and OrderNumber equality dry run (gate below). |
| M | o3d-dx3m3 | Held installations must use the fixed `api_key` Mintsoft mode (documented); the cancel-swallow bug is a P2 to triage before M. |
| W | o3d-hsrsi item 3 | Stock-drift explain/acknowledge: today one manual WooCommerce stock edit after go-live fails `writers:check` until a new attestation is recorded. Fix, or the owner accepts and the on-call knows the clearing procedure. |
| W | o3d-zvec.24 | Customer e-mail from IMS (P4 on the board). See the e-mail finding in step W: IMS has no despatch e-mail for storefront-linked orders yet. Either this is built before W, or e-mail stays with WooCommerce at W. |
| X | o3d-zjsb5.20 | The opening-balance journal, dated the Xero live-from day. |
| X | o3d-hcx4c.3 / .4 | Incumbent-plugin disable order, and Qoblex to read-only (the point of no return) are sequenced after X. |
| all | o3d-2ypv4 | Upload virus scanning ON at the IMS switchover (`FILE_SCAN_MODE`), part of the switchover checklist. |
| all | o3d-sxu1k | The readiness register; its go/no-go gate. |

Not yet built, and each blocks the step it is named under (they are the "remaining" list on o3d-zvec.3): the bridge status script and its `writers:check` source (M), the zvec.22 import (M), the Xeroom note mu-plugin (X), and the stage proof (M). **Today `BRIDGE_ATTESTATION` reads "not built", which fails `writers:check` from step M on.** M cannot go live until that source exists.

## Stage proof (required before step M is scheduled)

Per the owner (2026-11-18) there is no non-live Mintsoft client: the proof uses **live Mintsoft client 89** with clearly marked test orders that are **cancelled at once** (the o3d-zvec.1 method). Mintsoft is LIVE, so the marking and the speed matter: warehouse staff must never pick a test order.

Stage IMS is wired to the live Mintsoft with the same shared API user, and stage has its own WooCommerce. Its push cron is off. Run the proof as follows.

1. **[OWNER]** Approves the day and tells the warehouse that marked test orders will appear and be cancelled within minutes. **[CLAUDE]** prepares the marking convention: a reserved order-number prefix and an order comment "TEST - DO NOT PICK" on every order.
2. **[CLAUDE or OPS, stage only]** Create the bridge-created set as the bridge would have made it, each marked and each cancelled in Mintsoft straight after the check it is for: a plain order, a split order (`_mintsoft_split_*`), a merged order (`_mintsoft_merged`), a partially despatched order, a withdrawal-held order, a dead-lettered order and a verify-pending order. Only orders the bridge's metas describe count; do not create orders by hand in Mintsoft that the bridge never would.
3. Run the zvec.22 import dry run and then the import, then step M exactly as written below, on stage.
4. **Adoption.** IMS must link every open bridge order and create **zero** orders. Run the order-push sweep three times and confirm the result each time (links count, orders created = 0). Count orders for ClientId 89 before and after; the difference must be zero.
5. IMS amends one bridge order and cancels one. Cancel the remainder at once.
6. Despatch one full order and one split part (mark them; the warehouse does not pick). Each must produce exactly one completion, one tracking entry, one partial-shipment row and one TrackShip shipment.
7. `npm run switchover:gaps -- --step mintsoft --since <rehearsal S>` must list exactly the seeded gap orders, no more and no fewer.
8. Rehearse the rollback with hand-back, in the corrected order (see Step M rollback): the bridge resumes and creates no duplicate.
9. **Product delete (owner answer 11).** Prove Mintsoft product delete on stage before step M: with `mintsoft_parent_sku_delete_enabled` on, delete a marked test product, confirm the Mintsoft product is removed and no other product is touched, and confirm it is a no-op when the setting is off. Record the result.
10. **Mintsoft creation-field name.** Read a live `GET /api/Order/List` row of client 89 (read only) and record which creation-time field it carries. The foreign-order reader tries `CreatedDate`, `DateCreated`, `Created` and never `OrderDate`. If none is present, every pre-S order updated after S counts as foreign and turns `writers:check` red from M. Pin the real name in a test fixture before step M.
11. **Withdrawal request ownership field.** On stage, with the real withdrawal plugin (`wbte_ewb_*`), confirm that a request object exposes its order id as `order_id` or `get_order_id()`. The helper rejects only a request that belongs to the route's order, and answers `no_request` otherwise (which raises an operator task instead of rejecting). Record the field.
12. Attach the full record (counts, order references, no customer data) to o3d-zvec.3.

## Step M: Mintsoft, plus the bridge's WooCommerce writeback

M retires the bridge as a unit. The bridge sweep creates Mintsoft orders and also writes WooCommerce status, tracking, partial shipments, withdrawal outcomes and TrackShip reconciliation, and a webhook service syncs products. All of those move to IMS here, behind the single `MINTSOFT_WRITES_LIVE_FROM` instant (S). Customer e-mail does not move at M.

### M preconditions (checklist)

- [ ] Global gates met and the stage proof passed.
- [ ] **writers:check** exits 0 in P1 today, and has on every day of the window: `npm run writers:check -- --json > /var/tmp/m-pre-writers-check.json; echo $?`. Record the verdict. (Exit 6 means a step is not ready, 4 an evidence gap, 2 unreadable, 1 a double claim.)
- [ ] **zvec.22 dry-run gate:** the dry run over live WooCommerce meta imports every open order's state with **zero OrderNumber mismatches**, and the live `woocommerce_order_prefix` setting equals the prefix the bridge used. Check with **[CLAUDE]** read-only; **[OPS]** confirms the setting.
- [ ] **Zero open merge holds and merge candidates.** Resolve by hand in Mintsoft before S (there is no import of that state, owner answer 9). Re-check on the day.
- [ ] The bridge's dead-letter queue, `_mintsoft_verify_pending` and `_mintsoft_wdraw_pending` are empty, or each order on them is listed and owned by a named person.
- [ ] In IMS these are false before S: `wc_stock_sync_enabled`, `wc_invoice_note_enabled`, `wc_invoice_document_enabled`, `trackship_refire_enabled`, `wc_withdrawal_outcome_enabled`, `mintsoft_parent_sku_delete_enabled`. (Product delete goes live at M after being proven on stage: turn it on only after the first-day checks below.)
- [ ] **Product delete proven on stage** (stage proof item 9).
- [ ] **Helper plugin 1.5.0 deployed. [OWNER] must give the OK first**: it adds the signed `/wp-json/oti/v1/incumbents` probe and the withdrawal-outcome route to the live store. Then **[OPS]** installs it through the usual plugin deploy for the live store. Check: `curl -s -o /dev/null -w '%{http_code}\n' https://<store>/wp-json/oti/v1/incumbents` must answer 401 or 403 unsigned (it is signed-only; a 404 means the route is not there). The `writers:check` probe reads **not-probed** (a fail) from M until this is done; it is asked only after S is set, so P1 does not turn red meanwhile.
- [ ] **Mintsoft creation-field name verified against live data** (stage proof item 10) and pinned in a test.
- [ ] **Withdrawal plugin request ownership field verified on stage** (stage proof item 11).
- [ ] Open beads closed: o3d-9zh3c, o3d-hsrsi (items 1 and 2), o3d-j8d7l, o3d-s5ljn, o3d-k6quj, o3d-zvec.22 (see "Beads to close first").
- [ ] **The bridge status source exists** (`scripts/bridge_writers_status.py` in the bridge repo, printing `systemctl show` for the three units and the last sweep run) and `writers:check` can read it. Until it exists M cannot pass.
- [ ] The hand-back script has been rehearsed on stage (proof item 8).
- [ ] **Mintsoft API user credential:** one shared "API" user, used by the bridge today and by IMS after (owner answer 1). **[OWNER]** has the 'main' Mintsoft login to rotate it. IMS stage is wired to the live Mintsoft with the same user, so stage is updated in the same rotation. Confirm IMS uses the fixed `api_key` Mintsoft mode (o3d-dx3m3).
- [ ] The Vaultwarden inbox path works: `o3d-vault-put` on pve, read-back verified, with an item name agreed in advance.
- [ ] A rollback window and a person who can run the rollback within the hour.

### M action, in order (S is recorded at step 7)

1. **[OPS] Stop the timer.** On the bridge host: `systemctl stop wc-mintsoft-order-sweep.timer`. Wait for any running sweep to release `/run/wc_mintsoft_order_sweep.lock` (`flock -n /run/wc_mintsoft_order_sweep.lock true && echo free`).
2. **[OPS] Final sweep.** Run `run_mintsoft_order_sweep.py --once` by hand. It must exit 0 with empty withdrawal, outbound and verify queues. If it does not, stop here and restart the timer (`systemctl start wc-mintsoft-order-sweep.timer`); nothing has changed.
3. **[OPS] Disable and mask the units**:
   - `systemctl disable --now wc-mintsoft-order-sweep.timer wc-mintsoft-webhook.service`
   - `systemctl mask wc-mintsoft-order-sweep.timer wc-mintsoft-order-sweep.service wc-mintsoft-webhook.service`
   - Check: `systemctl is-enabled` reads `masked` and `systemctl is-active` reads `inactive` for each of the three.
4. **[OPS] Flip the plugin settings.** In WordPress (wp-cli, run through the store's cron user as for other live changes; never `--user=1`):
   - `wc_mintsoft_settings.order_sync_enabled` to false;
   - disable the WooCommerce webhook that delivers to `127.0.0.1:5001/webhook/woocommerce/product-update`;
   - cancel pending Action Scheduler jobs `wc_mintsoft_run_product_sync`;
   - deactivate the plugin `wc-mintsoft-sync` (slug exact). Deactivating is not the signal; the units and switches are. It is done so the plugin cannot be woken by a hook.
5. **[OPS] Downgrade the bridge's own WooCommerce REST key to Read** (not IMS's key). Do not delete it: rollback needs it.
6. **Mintsoft credential rotation (hard stop signal).** One shared API user, so there is no bridge-only login to disable. **[OWNER]** rotates that API user's password or API key in Mintsoft, immediately before S. **[OPS]** stores the new credential in Vaultwarden through `o3d-vault-put` on pve (inbox item, read-back verified; never in a ticket, chat or the shell history), then sets it in IMS **only**: production, and stage in the same change (fixed `api_key` mode in the Mintsoft settings). The bridge is not given it, so its stored credential then fails. Confirm IMS authenticates: a read-only connection test in Settings, and the activity log shows no Mintsoft 401. The bridge's failed logins after S are a signal the check reads.
7. **[OPS] Record S**, the moment steps 3 to 6 are complete, as an ISO UTC instant with a Z, for example `2027-01-05T08:42:00Z`. S must be in the past when IMS is restarted. Write it on the bead.
8. **[OPS] Bridge attestation.** Run the bridge-host status script and keep its output as the record, then record it with `writers:attest` once the bridge kind exists (today only the two Qoblex kinds can be recorded; the bridge attestation is a host input that is not built). List what is recorded: `npm run writers:attest -- --list`.
9. **[OPS] Set the IMS environment and switches** in `/etc/ims/ims.env`, then restart:
   - `MINTSOFT_WRITE_ALLOWED=<the one Mintsoft destination>` and `WC_WRITEBACK_ALLOWED_ORIGIN=<the live store origin>` (formats: see the outbound-write hold above and `npm run outbound:status`);
   - `MINTSOFT_WRITES_LIVE_FROM=<S>`;
   - leave `WC_WRITES_LIVE_FROM`, `XERO_WRITES_LIVE_FROM` and `XERO_WRITE_ALLOWED_TENANT` **unset**;
   - restart IMS and the host scheduler entries that call the Mintsoft, order-status and WooCommerce routes.
   Then in IMS settings: `trackship_refire_enabled=true`, `wc_withdrawal_outcome_enabled=true`, and `wms_merge_hold_enabled` and `wms_mixed_warehouse_push_enabled` as settled in their beads. Product delete: leave `mintsoft_parent_sku_delete_enabled` off until the first-day verification is clean, then turn it on (it is proven on stage).
10. **[OPS]** `npm run outbound:status` and then `npm run writers:check -- --json` and keep both outputs. Expected: phase P2-M, exit 0.

`MINTSOFT_WRITES_LIVE_FROM` governs every step-M row, including the WooCommerce fulfilment rows.

### M detection signals (what `writers:check` reads)

All are required. The check does not take "plugin active" as a signal.

- The bridge host attestation: all three units masked and inactive, the timer's last trigger before S.
- The helper probe: `wc-mintsoft/v1` routes not registered, `order_sync_enabled` false, the product webhook disabled, no pending product-sync jobs, and the newest `_mintsoft_*` write before S. Caveat: the probe's latest-write time covers four time-valued keys only, and the bridge deletes `_mintsoft_sync_queued_at` on success, so bridge writes that carry no stamp (tracking, order-id links from withdrawal recovery, withdrawal outcomes) are invisible to it. The units and credential are the real stop.
- No order paid at or after S carries bridge evidence (`MINTSOFT_ORDER_ID`, `MINTSOFT_OTHER_META`).
- No foreign Mintsoft order: no ClientId 89 order created at or after S that IMS has no link for.
- Bridge Mintsoft login failures logged after S (the rotated credential). **[OPS]** reads the bridge log; the check does not.

### M verification (first 24 hours, then daily for the soak)

- [ ] `npm run writers:check` exits 0 (phase P2-M).
- [ ] `npm run switchover:gaps -- --step mintsoft` (S is `MINTSOFT_WRITES_LIVE_FROM`):
  - **G_create**: orders paid before S that are unlinked and not cancelled;
  - **G_despatch**: Mintsoft despatches before S whose storefront order is not completed with tracking (14-day window before S; the list reads each storefront order, paced, and lists unreadable ones as such).

  Each must be empty or closed within 4 hours. Close one order at a time: `npm run switchover:gaps -- --step mintsoft --take-over <orderId>` (dry run; it reads Mintsoft or the storefront first), then add `--apply`. A G_create order that Mintsoft does not hold is refused: IMS never creates a pre-S order; create it in Mintsoft by hand after a search by number, then take it over. A repeated `--apply` on a G_despatch order only queues an extra job that reads first. Known limit: a SHIPPED order with no `shippedAt` created before the window is not listed (o3d-9zh3c); check the warehouse's last-day despatch list by hand once.
- [ ] **The first IMS-created order** is created once, and its Mintsoft OrderNumber equals the storefront order number (with the prefix).
- [ ] **One full despatch and one split (partial) despatch** each produce exactly one completion, one tracking entry, one partial-shipment row and one TrackShip shipment. Look at the storefront order itself, not only IMS.
- [ ] **One withdrawal** goes through: hold, outcome note, and for a request after the point of no return the rejection. Expect a `WITHDRAWAL_REJECT_NOT_WRITTEN` operator task when the request id is unknown (`no_request`): known limit, one task per order, resolve by hand. The very first request made before IMS's first outcome post may end that way (the capture is switched on by IMS's first post).
- [ ] A bridge-created order is amended or cancelled by IMS once, with no duplicate.
- [ ] **Drift observer**: not used at M (it starts at W). Do not run it before the Qoblex stock push is stopped.
- [ ] The daily reconciliation stays clean.
- [ ] No Mintsoft 401 in IMS; the foreign-order count is 0.

### M stop conditions (stop means roll back)

- `writers:check` exits non-zero.
- Any duplicate Mintsoft order.
- Any storefront order with a second partial-shipment row or tracking entry for one shipment.
- Any foreign Mintsoft order or fresh `_mintsoft_*` mark.
- A gap that cannot be closed within 4 hours.
- A failed reconciliation run.

### M rollback (the corrected order: hand back first, while the live-from is still set)

Do not unset the live-from first. The hand-back writes through the ordinary WooCommerce path, which the producer hold keeps unless the step-M live-from is set and reached, and the hold is deliberately not loosened for it. `--apply` is refused (exit 4) unless `MINTSOFT_WRITES_LIVE_FROM` is still set in the environment and reached (a `--since` does not count) and you confirm with `--writers-stopped`.

1. **[OPS] Stop IMS's other step-M writers while the live-from stays set**: stop the host scheduler entries for the order-push, order-status, dispatch-sync, withdrawal-sweep and webhook-inbox (TrackShip) routes, and set `wc_withdrawal_outcome_enabled=false` and `trackship_refire_enabled=false`. Check nothing is running (`pgrep` is fine for looking; never `pkill`).
2. **[OPS] Dry run**: `npm run switchover:hand-back`. It lists the open storefront orders IMS created in Mintsoft since S; read it. Exit 1 means something needs a person (a conflict, an unreadable or held order).
3. **[OPS] Apply**: `npm run switchover:hand-back -- --apply --writers-stopped`. It writes `_mintsoft_order_id` and `_mintsoft_order_number` onto each of those orders so the resumed bridge's second pass covers them (it only covers orders that carry `_mintsoft_order_id`; without this those orders have no writer). It reads each order first, never overwrites a different value, and leaves `switchover_hand_back_intent` and `switchover_hand_back_applied` audit entries. If the run reports `held`, the live-from was not set: set it again and rerun.
4. **[OPS]** `npm run switchover:gaps -- --step mintsoft` for the hand-back window.
5. **Only now** unset `MINTSOFT_WRITES_LIVE_FROM` and `MINTSOFT_WRITE_ALLOWED` (and `WC_WRITEBACK_ALLOWED_ORIGIN` if nothing else needs it), restart IMS, and confirm `npm run outbound:status` shows no writable destination.
6. **[OWNER] gives the bridge the new Mintsoft credential back** (the rotated one), **[OPS]** puts it in the bridge config through Vaultwarden. IMS keeps reading with the same credential; with writes held that is harmless.
7. **[OPS]** Restore the bridge's WooCommerce REST key permissions, reactivate `wc-mintsoft-sync`, set `order_sync_enabled` back on, re-enable the product webhook, unmask and enable the three units, start the timer. Run one sweep by hand and watch it adopt the handed-back orders.
8. Restart the soak count when you try again.

### M: what rollback does NOT undo

- Mintsoft orders IMS created and goods already despatched.
- Product changes made in Mintsoft (including a deleted product).
- E-mails already sent to customers, partial-shipment rows and tracking entries already written, and withdrawal notes.
- The rotation: the old credential does not come back (the owner gives the bridge the new one).
- Gaps in the window the bridge was off and IMS was held: list them with `switchover:gaps`.

## Step W: WooCommerce stock, webhooks and customer e-mail

### W preconditions (checklist)

- [ ] Step M has soaked 3 days with `writers:check` at 0 throughout, and none of its stop conditions hit.
- [ ] **writers:check verdict** exits 0 in P2-M today.
- [ ] **Zero open merge holds** still (carried from M).
- [ ] The beads for W are closed or accepted: o3d-hsrsi item 3 (stock-drift acknowledge) and the e-mail finding below.
- [ ] **Qoblex stock-stop confirmation. [OWNER]** stops the Qoblex stock push to WooCommerce in Qoblex, then confirms in IMS through writer confirmations: the Owner confirmations page at `/sync/writer-confirmations` (an administrator signs in), or **[OPS]** records it on the owner's word: `npm run writers:attest -- --kind qoblex-stock-push-stopped --by <owner name> --note "<what was stopped, when>" --yes` (without `--yes` it only prints what it would record). The record is append-only and audit-logged with time and user. IMS refuses `wc_stock_sync_enabled=true` without it. Check: `npm run writers:attest -- --list`.
- [ ] **24 hour quiet window.** From the confirmation, run the drift observer hourly from the host scheduler: `npm run switchover:stock-drift` (read only; exit 0 = a complete run, exit 5 = it could not read the whole catalogue). Run it outside peak trading hours: it reads every managed-stock product and one variations call per variable product, paced, on the PHP pool shared with customers. After 24 hours with **zero** unexplained changes the window is quiet. Any stock change not explained by an order or refund means Qoblex is still pushing: the step stops.
- [ ] The WooCommerce webhooks list for IMS is known (nothing registered yet; no incumbent registers them).
- [ ] If customer e-mail is in scope: the e-mail checks below.

### W action, in order

1. **[OPS]** Set `WC_WRITES_LIVE_FROM=<W>` (a past instant, after the attestation) and restart. `WC_WRITEBACK_ALLOWED_ORIGIN` is already set from M. Then set `wc_stock_sync_enabled=true` (refused without the attestation).
2. **[OPS]** Register the IMS webhooks (the WooCommerce connector's webhook registration, which is held until this step is live).
3. **[OPS] Customer e-mail (owner answer 4; only if the e-mail checks pass).** Order matters: **turn off the WooCommerce native e-mails first, then turn on IMS's.** A missed e-mail can be re-sent from a list; a duplicate cannot be unsent.
   1. **[OPS]** In WooCommerce, Settings > Emails: disable the native Completed order, Processing order and invoice e-mails (and the AST/TrackShip despatch e-mail if that is a separate sender; confirm on the live store). Send a test and confirm none arrives.
   2. Wait until the last in-flight native e-mail has gone, then turn on IMS's: `dispatch_email_enabled=true` and its siblings that exist at that time (the order-confirmation and invoice switches).
   3. Watch the first orders: each customer receives exactly one e-mail.
   - **Finding (2026-11-19): IMS's dispatch e-mail is for direct IMS orders only.** `lib/dispatch-email.ts` skips any order with a storefront link (`storefront_order`), on the premise that WooCommerce sends its own "completed" e-mail. So turning WooCommerce's off and IMS's on would send **nothing** for storefront orders today, and customers would not be told their order shipped. **[OWNER] decides** whether customer e-mail from IMS is built before W (o3d-zvec.24) or e-mail stays with WooCommerce at W. Do not execute this action until it is decided, and prove on stage first that a storefront order produces exactly one e-mail. Also record the o3d-zvec.1 result (whether AST Pro's own despatch e-mail fires when IMS writes tracking), since that is the e-mail that exists today.

### W detection signals

- The owner's attestation exists and is earlier than `WC_WRITES_LIVE_FROM`.
- The drift observer is clean (a recent complete run, no unexplained change since the attestation).
- After go-live, a WooCommerce stock value that differs from IMS's last absolute push and is not explained by an order is a fail.
- WooCommerce native e-mail and IMS e-mail are mutually exclusive.

### W verification

- [ ] `npm run writers:check` exits 0 (phase P2-W).
- [ ] Sample SKUs (a simple product, a variation, a bundle if any) match IMS in WooCommerce. The first push is an absolute state push, so it heals the short no-writer gap; WooCommerce's own decrements on orders cover that gap meanwhile.
- [ ] `npm run switchover:stock-drift` stays at 0 unexplained changes for the soak.
- [ ] Webhooks deliver; the first orders after W import normally.
- [ ] If e-mail moved: exactly one e-mail per customer for the first orders.
- [ ] `npm run switchover:gaps -- --step mintsoft` is still empty.

### W stop conditions

Drift; `writers:check` non-zero; a failed reconciliation run; a duplicate or missing customer e-mail.

### W rollback

1. **[OWNER]** First tell ops, then re-enable the Qoblex stock push in Qoblex only after IMS has stopped (never both).
2. **[OPS]** Set `wc_stock_sync_enabled=false`; unset `WC_WRITES_LIVE_FROM`; restart. The step-M rows stay live because their live-from is the Mintsoft one. Remove the IMS webhooks.
3. If e-mail moved: turn IMS's e-mail off first, then WooCommerce's native e-mails back on (the reverse order: a duplicate is the risk to avoid, a missed e-mail can be re-sent).
4. Restart the soak count.

W rollback does NOT undo: stock values already written (Qoblex's next push overwrites them), e-mails already sent, and the Qoblex attestation record (it is append-only; record a new one when you try again).

## Step X: Xero, and the invoice note

Xero live-from is the **start of a day**, not a VAT period: 00:00 Europe/London expressed in Z (owner answer 6). In winter that is `YYYY-MM-DDT00:00:00Z`; in British Summer Time it is the previous day at `23:00:00Z`. Choose the day, compute the instant once, and check it twice.

### X preconditions (checklist)

- [ ] Step W has soaked 3 days at 0 throughout.
- [ ] **writers:check verdict** exits 0 in P2-W today.
- [ ] **Zero open merge holds**.
- [ ] **[OWNER]** has stopped Qoblex's native Xero posting (bills, journals, daily batches) in Qoblex and records it: `npm run writers:attest -- --kind qoblex-xero-stopped --by <owner name> --note "<...>" --yes`, or the Owner confirmations page. The attestation must be earlier than the live-from; delivery waits for it.
- [ ] The opening-balance journal (o3d-zjsb5.20) is dated the live-from day.
- [ ] **The Xeroom note mu-plugin is deployed (not built yet).** A small mu-plugin on the store (per the patched-fork rule: Xeroom is never edited) with the option `o3d_xeroom_order_note_off` (default false) that suppresses only Xeroom's WooCommerce order note. Xeroom's "Add Order Notes" setting is the reverse direction (WooCommerce notes copied onto the Xero invoice) and is left as it is. The helper probe reads the option. **[OWNER]** OKs the mu-plugin deploy; **[OPS]** deploys it.
- [ ] IMS can find the invoice from the id/number Xeroom stores on the order, with a Xero lookup by order reference as fallback (proven on stage).
- [ ] The stage proof shows the first invoice note appears exactly once with Xeroom's note off.
- [ ] A person with Xero History access is on hand for the first day.

### X action, in order

1. **[OWNER]** Confirms the day and the instant X.
2. **[OPS]** Turn off Xeroom's WooCommerce order note: set the option `o3d_xeroom_order_note_off` to true (wp-cli option update, through the store's cron user). Xeroom keeps posting sales invoices and keeps its marker on every order for good.
3. **[OPS]** Set `XERO_WRITE_ALLOWED_TENANT=<the one tenant>` and `XERO_WRITES_LIVE_FROM=<X>`, restart, then set `wc_invoice_note_enabled=true` and `wc_invoice_document_enabled=true`. Both owners move at X, Xeroom's note off first (step 2), then IMS's on.
4. **[OPS]** `npm run writers:check -- --json` expecting P2-X exit 0, and `npm run outbound:status`.

### X detection signals

- The probe reads Xeroom's note option as off.
- No new note written by Xeroom on any order with an invoice at or after X (`XEROOM_NOTE`). `XEROOM_MARKER` alone is not a signal: Xeroom marks every order it invoices.
- Xero History shows no bill or journal created at or after X by the Qoblex app.
- The Qoblex Xero attestation is present and earlier than X.

### X verification

- [ ] `npm run writers:check` exits 0 (phase P2-X).
- [ ] The first daily batch, bill and journal each post once.
- [ ] Each order invoiced after X carries **exactly one** invoice note.
- [ ] Xero sales invoices and credit notes are still Xeroom's alone (IMS never writes them).

### X stop conditions

A duplicate note; a Qoblex-created document after X; `writers:check` non-zero; a failed reconciliation run.

### X rollback

1. **[OPS]** Unset `XERO_WRITES_LIVE_FROM` and `XERO_WRITE_ALLOWED_TENANT`; set `wc_invoice_note_enabled=false` and `wc_invoice_document_enabled=false`; restart.
2. **[OPS]** Set `o3d_xeroom_order_note_off` back to false (Xeroom's note on again).
3. **[OWNER]** Reconnects Qoblex's Xero posting.

X rollback does NOT undo: documents already posted to Xero (bills, journals, batches) stay and need credit notes or manual reversals; notes already written to orders; and the opening-balance journal. X is reversible only with these consequences.

## After the three steps

Record the dates of M, W and X and their soak results on o3d-hcx4c.2. Then o3d-hcx4c.3 (disable the incumbent plugins) and o3d-hcx4c.4 (Qoblex to read-only, the point of no return) follow. Switch virus scanning on (o3d-2ypv4). Remove the rollback keys only after the last step has soaked.
