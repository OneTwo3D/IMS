### Mintsoft SKU-rename order hold: follow-ups (#1076 review)
- Returning to an ignored rename pair no longer closes another open rename row of the product (ignore A to B, rename B to C, rename back to B used to release the C orders). Only the Ignore action or a genuine SKU match closes a row.
- New setting `wms_sku_rename_remap_enabled` (default OFF, system-managed, `npm run settings:set`): when on, an order line whose snapshot SKU is a known earlier SKU of its product is sent with the SKU Mintsoft holds now (confirmed by product sync). One shared rule decides the SKU for create, amendment (including mixed-scope lines), the amendment comparisons and the warehouse query text, so an order is always amended with the SKU it was created with. Case variants, `wc-<id>` lines and unknown storefront SKUs are never remapped. A re-rename keeps the earlier SKU as a RESOLVED history row. Documented limit while on: the partial-shipment push forwards Mintsoft's SKU and the refund-remainder task names the snapshot SKU.
- An ignore of a rename that lands during a product-sync pass no longer leaves a freshly created OPEN row holding orders.
- SKU matching for the hold is case-sensitive (trim only), agreeing with product sync's link check; a case variant is held.
- Retiring an ignored rename keeps the operator's note and the time of the Ignore.
- A change to a mixed-warehouse order whose push warehouse has no Mintsoft mapping is held against the warehouse it is actually sent to.
- A SKU-rename hold on an order change is *Needs a look* only when it is the sole reason; a change that also alters the lines is *Serious*.
- A new order refused after its send was claimed is parked as a validation hold, not left to become an ambiguous create needing a presence check.
- The "ask the warehouse to cancel an ASN" row and alert use transfer wording and link to the transfer.
