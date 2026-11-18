### Cleared customs data now clears in Mintsoft

- A customs field (HS code, country of origin, customs description) that WooCommerce empties is now emptied in IMS and logged on the product, but only when the store's hs-code-woo plugin has also recorded it as cleared (`_customs_cleared_fields`). An empty value alone, a missing field, an invalid value, or a variation inheriting a filled parent changes nothing.
- When a customs field that had a value is emptied in IMS (any route: product editor, CSV edit, WooCommerce import), IMS records it and clears that field in Mintsoft on the next update, as a separate request so a Mintsoft refusal cannot fail the update. The record is dropped once a read-back shows the field empty in Mintsoft, or when the field is filled again; otherwise it is retried next run. A field that was merely never filled is never cleared. Barcodes are never cleared.
- A blank country of origin is still declared as China when a product is created in Mintsoft, but an update no longer re-declares it.
- The Mintsoft clear format has not been verified against the live API.
- Migration: adds the `product_customs_clears` table and a trigger on `products` that maintains it.
