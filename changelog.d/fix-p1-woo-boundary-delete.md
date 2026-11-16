### WooCommerce stock sync: order delete and transaction reset safety (Stock sync)

- **Fixed: deleting an order, or releasing or reducing its allocation (cancel, deallocate, refund trim, manual reduce or move, re-allocation, over-allocation rebalance), now invalidates the completed-history boundary** in the same transaction, and a stale in-flight boundary write is refused. Previously a still-completed old order could be omitted by later stock guards and a positive push could restore units WooCommerce had already sold. Normal shipping does not invalidate.
- **Fixed: a transaction reset now also clears the WooCommerce cancellation backstop cursor and backfill state**, so the next backstop run backfills from the start instead of resuming from the old cursor.
