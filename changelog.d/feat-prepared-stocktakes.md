### Prepared stocktakes: choose the product list before counting (Stock Control)

- **New: a stock count can be prepared.** On **Stock Control > Stock Counts > New count**, pick the location, choose **Prepared (choose products)** and tick the products to count in a selection window with search by name or SKU and filters for product type, state (active or archived) and category. Ticks are kept while the search and filters change, and products already on the count are marked and cannot be added twice (refused by the server too).
- **New: the product list stays editable while the count is open.** Open counts get **Add products** and **Remove selected**. A line can be removed only while it is neither counted nor reconciled; otherwise nothing is removed and the message names the products.
- **Changed: the stock count list** now shows Date, Reference, Location, Type (Whole location or Prepared), Status and Lines, with a status filter. The whole-location count is unchanged.
- Schema (additive): `stock_counts.prepared` and a unique index on `stock_count_lines (countId, productId)`.
