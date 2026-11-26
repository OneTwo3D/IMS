-- expand-only
-- Per-event FX rates for purchasing, step 2 follow-ups (behind the system switch `purchase_event_fx_rates_enabled`, default off).
-- purchase_orders.fx_no_prepayment_checked_at: when IMS last asked Xero for this order's supplier prepayment and was told there is none. A receipt
-- inside the cache window (setting purchase_fx_no_prepayment_ttl_hours, default 6) does not ask again, which protects the Xero request budget shared
-- with the other integrations. NULL = never asked, or a prepayment was found since. Nothing writes it while the switch is off.
-- Additive only: one nullable column, no backfill.

ALTER TABLE "purchase_orders" ADD COLUMN "fx_no_prepayment_checked_at" TIMESTAMP(3);
