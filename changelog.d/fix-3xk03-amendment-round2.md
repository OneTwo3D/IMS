### WooCommerce order amendments and refund-remainder tasks: round-2 review fixes (both features still off by default)
- A reduction that WooCommerce later undoes now raises its "a person decides" task: the write step also runs when the comparison finds no difference but the order carries an amendment refund (before, nothing differed, so it never ran).
- Latest edit wins compares with what WooCommerce showed at the first IMS edit (new `sales_orders.wc_seen_lines`, kept by the divergence comparison without touching `updated_at`), not with IMS's own lines at that time. Older baselines fall back to the previous behaviour.
- The refund-remainder task is deduplicated per order, SKU and returned-and-refunded quantity, and no longer counts finished tasks: a second genuine remainder on the same SKU raises a task.
- A warehouse state that could not be read just now no longer turns the refund into a manual task or says picking started: nothing is refunded, no claim is taken, the next delivery retries.
- Amendment refunds are marked by a structured flag (new `sales_order_refunds.wc_amendment`, additive migration), not by the reason text.
- Mintsoft parity refuses (sends nothing for) a variation whose attribute text cannot be split into values with certainty, instead of renaming a live product; the catalogue dry run lists such products.
- Two WooCommerce deliveries with the same modified time but different lines are not acted on until a later delivery settles the order.
- A step that throws after its refund was recorded keeps its claim. The idle-connection lock cost is documented in `order-amendment.ts` (not changed).
