-- Per-event FX rates for purchasing, step 1-2 (behind the system switch `purchase_event_fx_rates_enabled`, default off).
-- A goods receipt is valued at the exchange rate of its own business date (fx_rates), not the PO rate, and the layer it lays
-- remembers its goods unit cost and that rate so the landed-cost recalculation revalues it per layer.
-- Additive only: three nullable columns, no default, no backfill (production is reinstalled; a NULL row is valued as before).
-- The new GR/IR source type BILL_FX_VARIANCE and transit source type PURCHASE_FX_VARIANCE are TEXT values (no enum, no CHECK).

ALTER TABLE "cost_layers" ADD COLUMN "goods_unit_cost_base" DECIMAL(18,6);
ALTER TABLE "cost_layers" ADD COLUMN "fx_rate_to_base" DECIMAL(18,8);
ALTER TABLE "purchase_receipts" ADD COLUMN "fx_rate_to_base" DECIMAL(18,8);
