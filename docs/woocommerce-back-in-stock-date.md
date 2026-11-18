# WooCommerce back-in-stock date (o3d-taro)

IMS publishes an estimated back-in-stock date for out-of-stock SKUs as WooCommerce product meta. IMS only WRITES the meta. Displaying it
is a storefront (WordPress) job, listed under "Follow-up" below; this file is the contract between the two sides.

## IMS side

- Setting: `wc_back_in_stock_date_enabled` (Sync settings, "Include estimated back-in-stock date"). Default OFF. While it is off the stock push
  and the product payloads are byte-identical to before: no extra key is sent, no supply is read, and no eta state is stored
  (`tests/connectors/woocommerce-back-in-stock-date.test.ts`).
- Transport: the meta rides the existing stock push (`pushStockToWc`, `/products/batch` and `/products/{parent}/variations/batch`) as
  `meta_data: [{ "key": "_oti_eta_date", "value": "YYYY-MM-DD" }]`. With the setting on, the push also asks the producer seam for the
  ownership-map operation `product.meta` (a shadow drops only the meta; the stock write is unaffected), and the usual outbound write hold
  and last-barrier transport check still apply.
- Meta key: `_oti_eta_date`. Value: a plain calendar date `YYYY-MM-DD` (UTC day of the supplier date), or the empty string when there is
  no date. There is no quantity meta.
- When a date is written: the pushed stock quantity for the product is 0 or less, the product is a simple stockable product or a variation (never a
  KIT/BOM, whose ETA would be the latest component), and committed supply with a date that is today or later exists.
- Where the date comes from (`lib/domain/inventory/back-in-stock-date.ts`): GOODS purchase-order lines on `INCOMING_PO_STATUSES` with
  `qty - qtyReceived - qtyReturned > 0`. Per line, an open WMS ASN (`OPEN`, `PARTIALLY_BOOKED_IN`) that covers it and has an `eta` wins over
  the PO date for the units it covers; an ASN without an eta falls through; uncovered units use `effectiveLineEta` (line date, else the
  order's). The earliest remaining date is published.
- Never published: a date before today (UTC), an undated source, a draft/RFQ/quote order, a closed ASN. Late supply is dropped, never rolled forward.
- Cleared (value `''`) when stock returns, the supply is received or cancelled, the date goes late or undated. IMS writes the clear only when it had pushed a
  date before (`stock_sync_states.lastPushedEtaDate`), so it never spams empty meta. A forced or hourly reconcile re-evaluates every product, so a date that
  lapses is cleared on the next push. Turning the setting off does not clear existing meta.

## Storefront display contract (for the WordPress side; NOT implemented here)

- Read `_oti_eta_date` from the product (or variation) post meta. Never call IMS at render time.
- Show "Expected back in stock: 14 October" only when the product is out of stock AND the meta is a valid `YYYY-MM-DD` AND it is today or later in
  the STORE timezone at render time. An empty, missing, malformed or past value shows nothing (and never "delayed": IMS does not publish late dates).
- Format with the site locale (translatable, filterable string). Per variation: render the variation's own meta, never roll up to the parent.
- Optional and cheap: the same line in the cart/checkout for a backordered line.

## Follow-up (WordPress side)

A new module in `onetwoinventory-helper.php` (alongside the WMS-status and FX modules) implementing the contract above. Not written or deployed
as part of this change.
