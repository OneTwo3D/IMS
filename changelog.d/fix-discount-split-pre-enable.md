### Order discount VAT per rate: two fixes before the switch can be turned on (sales, accounting)

Both apply only with `sales_order_discount_tax_apportion_enabled` on, which stays OFF. With it off every write, payload, event and pack figure is unchanged.

- A discounted manual order with a line that has no tax rate (no configured rate for the line and no order default rate, such as a "No VAT" export order) is no longer refused on create, edit or CSV import. Such lines all take the same fallback rate, so they form one group of the per-rate split of their own (0% on a no-VAT order). Only no-rate lines at two different rates, which this writer cannot produce, are still refused.
- The mirrored accounting event of a sales invoice that posts the discount per tax code now records those parts (`discount.parts`) and no single header tax code. Header-rate documents keep exactly the shape they had.
- The reconciliation pack's VAT item (R12) now takes each rate's share of the discount VAT (the stored split's `taxBase`) off that rate on the IMS side, for orders booked under the split, so it matches the per-code discount lines in Xero. Orders without a split are read as before. A non-zero share on a rate R12 cannot place makes the item `VAT_MAPPING_UNVERIFIED`, as a line would.
