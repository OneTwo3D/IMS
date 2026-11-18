### Accounting P2 batch AB (snapshot, FX, supplier quotes)
- Inventory snapshot: the nightly run is labelled with the London business day that just ended (a BST run was labelled a day early), and its `cutoffAt` is London midnight.
- Unrealised FX revaluation: draft orders and quotes are no longer revalued; credit notes reduce the receivable and posted supplier credit notes reduce the payable (prorated base).
- Supplier-quoted shipping can now become a landed, billable cost line, and the requote keeps the VAT on the buyer's vatable cost lines. Behind the new setting `supplier_quote_shipping_landed_enabled` (default OFF).
