### Stock adjustments: default cost sources and the Mintsoft inventory-account hold (inventory)
Only with `stock_adjustment_reason_cost_required` on; with it off nothing changes.
- A blank addition cost now counts a Mintsoft Align To WMS receipt layer as a purchase receipt (it carries both a PO line and an adjustment movement), so products received only through Mintsoft have a default again.
- When a product has no receipt or production layer at all, the default falls back to the latest opening-stock batch cost (this warehouse first, then any; zero-cost skipped; never an average), so a stock count with surplus lines can be posted after a first load.
- A production layer only counts when the product is the order's output product: a disassembly's component layers no longer set the default.
- The Mintsoft align-down inventory-account hold now fires only when the adjustment would really be refused (an accounting connector present, a posting or chart-retired verdict, a non-zero write-off value), and its message says so.
- Help docs (stock control) and docs/mintsoft.md updated.
