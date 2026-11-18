### WooCommerce outbound stock and product push (fixes)

- **Fixed: a long stock push can no longer write an older, higher figure over a newer, lower one.** Each batch now re-reads current availability for its own products just before it is sent and only ever lowers the figure, and the read and the send run one batch at a time within the server.
- **Fixed: a change to a component now re-pushes every kit above it, at any depth.** A kit inside a kit (a gift box holding a kit holding the component) was left stale in WooCommerce until the daily reconcile.
- **Fixed: variations beyond the first 100 of a parent now receive stock.** Looking up a variation WooCommerce id after a cache reset read only page 1.
- **Fixed: a kit containing a service, gift wrap, fee or variable-parent component no longer shows 0 in WooCommerce.** Those components no longer limit how many kits can be built; stocked components still do.
- **Fixed: a failed IMS-to-WooCommerce product push (price, name, status) is recorded and retried.** The failure shows as a FAILED Product row in the WooCommerce sync log, and the reconcile cron pushes it again on every pass for up to 7 days, closing the row on success. Pushes that settings or the outbound hold skip are not recorded.
