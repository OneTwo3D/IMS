### Mintsoft inbound, ASN, align and returns fixes (WMS)

- Cancelling a transfer's dispatch now closes the transfer's warehouse ASN in IMS in the same transaction (it used to stay open for ever, holding align-down). IMS writes nothing to Mintsoft; the result tells the operator to ask the warehouse to cancel the ASN. Refused while the ASN's creation is unconfirmed or it is booked in and unreconciled. Cancelling or closing a purchase order already refuses while an ASN is live (unchanged).
- New setting `mintsoft_align_up_requires_receipt_evidence` (default off): align-up only lands a stock rise against an ASN the warehouse has reported something on, so returns and stock-take finds are no longer booked as PO receipts.
- Renaming a product's SKU in IMS no longer creates a second Mintsoft product: the sync raises a *Product SKU renamed* discrepancy and writes nothing. Additive migration: new discrepancy category.
- Changing a returns-inbox status can no longer overwrite RESTOCKED when a restock commits in between (compare-and-set), which allowed a second restock.
- A confirmed Align To WMS binding now also loses its confirmation when its discrepancy thresholds change, and a dry run counts as evidence for 7 days. (Re-pointing the binding already cleared it.)
