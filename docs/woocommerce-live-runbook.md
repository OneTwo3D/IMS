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

1. Pick an IMS-generated invoice for a WooCommerce-backed order.
2. From the WC storefront, sign in as the order's customer and open the order page.
3. Click **Download Invoice**.
4. Verify:
   - The download link is served via the `wc-invoice-handoff` WordPress helper plugin (not a direct IMS URL).
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
3. Populate the missing FX rate (manually upsert, or run `GET /api/cron/fx-rates`).
4. Trigger `GET /api/cron/wc-fx-retry` (or wait for the hourly cron).
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
   - force-pushes a current stock catch-up snapshot when the daily stock reconcile is due

Expected result:

- backup reconciliation behaves as a safety net, not the main sync mechanism
- if live order webhooks were skipped during the initial-import window, the first reconcile after initial import completion backfills them

## Evidence to capture

- IMS sync log screenshots or timestamps
- WooCommerce order/product screenshots or REST responses
- Exact SKUs, WC order IDs, and tracking numbers used in the run
- Whether webhook jobs auto-drained or had to be forced manually
