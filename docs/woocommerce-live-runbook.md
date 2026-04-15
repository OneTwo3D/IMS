# WooCommerce Live Verification Runbook

Use this runbook for scoped stage/live WooCommerce verification after connector changes. It is designed for webhook-first operation where WooCommerce should push changes to IMS immediately, with cron acting only as backup reconciliation.

## Preconditions

- WooCommerce connector is configured in IMS
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
   - confirm a recent `FROM_WC` product sync entry exists
   - open the product in Inventory and verify the expected fields changed

Expected result:

- IMS product import/update completes without manual cron intervention
- WooCommerce product data appears in IMS

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
5. In IMS **Sync Log**, confirm a recent `TO_WC` product sync entry exists.

Expected result:

- WooCommerce reflects the IMS product metadata change
- a `TO_WC` product sync record exists in IMS

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
   - confirm a recent `TO_WC` `SalesOrder` sync log entry exists for tracking push
   - confirm no duplicate IMS order/shipment mutation was caused by the reflected WC webhook

Expected result:

- WooCommerce order meta contains the latest IMS tracking
- repeated saves are safe
- reflected `order.updated` webhook events are suppressed rather than re-processing the order

## 5. Backup reconciliation check

Use this only to validate the backup path, not as the primary success criterion.

1. Trigger `GET /api/cron/wc-reconcile`.
2. Confirm it:
   - reconciles orders/products only when due or when webhook-primary mode is inactive
   - drains queued stock retry jobs
3. Confirm operators are not relying on `/api/cron/wc-sync` except for legacy compatibility.

Expected result:

- backup reconciliation behaves as a safety net, not the main sync mechanism

## Evidence to capture

- IMS sync log screenshots or timestamps
- WooCommerce order/product screenshots or REST responses
- Exact SKUs, WC order IDs, and tracking numbers used in the run
- Whether webhook jobs auto-drained or had to be forced manually
