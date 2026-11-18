### WooCommerce inbound import fixes (woocommerce)
- Webhook inbox: each event is claimed with its own clock, so an event claimed late in a long batch is no longer born stale and re-claimed by a concurrent drain while it is still running.
- Order import matches line SKUs trimmed and case-insensitively (never when two IMS SKUs differ only by case, which is left unbound and logged), falls back to the WooCommerce variation/product id, and logs every unmatched line instead of silently reserving no stock.
- Admission-refusal recheck queue: status-only refusals expire after 30 days, rows for deleted WooCommerce orders retire after three 404s, and retirements no longer use up the 50-order live-read budget.
- Refund sync: over-total and over-quantity refusals are quarantined (operator-resolvable) instead of FAILED, so they stop being retried on every delivery.
