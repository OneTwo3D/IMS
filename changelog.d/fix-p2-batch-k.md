### Inventory and costing fixes (purchasing, returns)
- A purchase receipt worth less than half a penny no longer queues a zero-amount stock receipt journal, from either the manual receipt or the WMS book-in.
- A purchase receipt now takes the stock row before writing the cost layer, the same order a supplier return uses, removing a possible cross-order deadlock.
- Restocking a Mintsoft return that no refund expectation covers now books the units at the warehouse's average cost (else the product's historical average) with a cost layer. If the product has no cost basis at all, the restock is refused with a clear message instead of adding stock at zero cost.
