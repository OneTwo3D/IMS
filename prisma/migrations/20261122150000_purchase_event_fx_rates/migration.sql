-- Per-event FX rates for purchasing, step 1 (behind the system switch `purchase_event_fx_rates_enabled`, default off).
-- Reserved columns for the rate that values a receipt's goods and the goods unit cost it gave each cost layer, so a later landed-cost
-- recalculation can revalue per layer. Nothing writes them yet; a NULL row is valued exactly as before.
-- Additive only: three nullable columns, no default, no backfill (production is reinstalled).
-- The new GR/IR source type BILL_FX_VARIANCE and transit source type PURCHASE_FX_VARIANCE are TEXT values (no enum, no CHECK).

ALTER TABLE "cost_layers" ADD COLUMN "goods_unit_cost_base" DECIMAL(18,6);
ALTER TABLE "cost_layers" ADD COLUMN "fx_rate_to_base" DECIMAL(18,8);
ALTER TABLE "purchase_receipts" ADD COLUMN "fx_rate_to_base" DECIMAL(18,8);
