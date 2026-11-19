### Mintsoft SKU-rename order hold: follow-ups (#1076 review)
- Returning to an ignored rename pair no longer closes another open rename row of the product (ignore A to B, rename B to C, rename back to B used to release the C orders). Only the Ignore action or a genuine SKU match closes a row.
- A new order still waiting to be sent under an older SKU snapshot is now sent with the SKU Mintsoft holds now, once product sync has confirmed Mintsoft has the product under its current IMS SKU (before: the stale snapshot went out). Amendments are not rewritten.
- SKU matching for the hold is case-sensitive (trim only), agreeing with product sync's link check; a case variant is held.
- Retiring an ignored rename keeps the operator's note and the time of the Ignore.
- A change to a mixed-warehouse order whose push warehouse has no Mintsoft mapping is held against the warehouse it is actually sent to.
- A SKU-rename hold on an order change is *Needs a look* only when it is the sole reason; a change that also alters the lines is *Serious*.
- A new order refused after its send was claimed is parked as a validation hold, not left to become an ambiguous create needing a presence check.
- The "ask the warehouse to cancel an ASN" row and alert use transfer wording and link to the transfer.
